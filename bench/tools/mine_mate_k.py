#!/usr/bin/env python3
"""Mine mate-in-k puzzles by chaining (SigilBench v3): a mate-in-k candidate is
the position two plies before a proven mate-in-(k-1) in the same game, with
the turn actually played as the candidate first turn.

    # 1. candidates (local)
    python3 bench/tools/mine_mate_k.py candidates --k 5 --pool m4_pool.json \
        --games hydrated_lines_v2.json [more game files] --out m5_candidates.json
    # 2. solve (one shard per VM; resumable; certificates included)
    python3 bench/tools/mine_mate_k.py solve --k 5 --candidates m5_candidates.json --shard 0/4 \
        --work work_0.jsonl --workers 88 --time-ms 3600000 --tool <target>/release/examples/cert_tool
    # 3. assemble (local)
    python3 bench/tools/mine_mate_k.py assemble --k 5 --candidates m5_candidates.json \
        --work 'work_*.jsonl' --out m5_pool.json

`solve` extracts a certificate that the played turn forces a win within k
(cert_tool make, leaves included), re-checks it with the independent Rust
checker (cert_tool check), and runs the shortest-mate proofs that are
affordable: no mate-in-1 (always) and no forced win within 2 (k >= 3, capped).
A candidate is a mate-in-k puzzle when the certificate checks, no mate-in-1
exists, and no win within 2 exists (k >= 3) -- the labels say which shorter
mates are excluded by proof and which are only not found.

Game files: {"<game id>": {"turns": [{"turnNumber", "sfnBefore",
"sfnAfter", "color"}], ...}}, a list of {"key": <game id>, "sfns": [...]}
(position before each turn, tools/hydrate output), or a mine_v3.py corpus
file ({"games": {gid: {"positions": [{"sfn"}...]}}}). Pools: a list or
{"puzzles": [...]} of puzzles with "id", "sfn", "game": {"id"}.
Everything this writes is private test-set material (canary included):
keep it in the private bucket.
"""
import argparse
import concurrent.futures as cf
import glob
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import CANARY  # noqa: E402


def skey(s):
    t = s.split()
    pm = [x for x in t[6:] if x.startswith('pm:')]
    return ' '.join([t[0].split('/')[0]] + t[3:6] + pm)


def load_games(files):
    """game id -> list of positions in order (before each turn, then the end)."""
    out = {}
    for f in files:
        d = json.load(open(f))
        if isinstance(d, dict) and isinstance(d.get('games'), dict):
            # bench/tools/mine_v3.py corpus: {"games": {gid: {"positions": [{"sfn", ...}]}}}
            for gid, g in d['games'].items():
                out[gid] = [p['sfn'] for p in g['positions']]
            continue
        if isinstance(d, list):
            for g in d:
                out[g['key']] = list(g['sfns'])
        else:
            for gid, g in d.items():
                ts = sorted((t for t in g.get('turns', []) if t.get('sfnBefore')), key=lambda t: t['turnNumber'])
                seq = [t['sfnBefore'] for t in ts]
                if ts and ts[-1].get('sfnAfter'):
                    seq.append(ts[-1]['sfnAfter'])
                out[gid] = seq
    return out


def cmd_candidates(a):
    games = load_games(a.games)
    pool = json.load(open(a.pool))
    pool = pool['puzzles'] if isinstance(pool, dict) else pool
    out, seen = [], set()
    for p in pool:
        seq = games.get((p.get('game') or {}).get('id'))
        if not seq:
            continue
        ks = [skey(s) for s in seq]
        pk = skey(p['sfn'])
        if pk not in ks:
            continue
        i = ks.index(pk)
        if i < 2 or seq[i - 2].split()[1] != p['sfn'].split()[1]:
            continue
        s, hint = seq[i - 2], seq[i - 1]
        if any(x.startswith(('ab:', 'sn:')) for x in s.split()):
            continue
        k = (skey(s), s.split()[1])
        if k in seen:
            continue
        seen.add(k)
        out.append({'id': f"{p['id']}-m{a.k}", 'sfn': s, 'hint': hint, 'from': p['id'],
                    'variant': p.get('variant') or 'standard', 'game': p.get('game')})
    json.dump({'canary': CANARY, 'k': a.k, 'candidates': out}, open(a.out, 'w'))
    print(f'{len(out)} candidates -> {a.out}')


def tool(a, mode, line):
    p = subprocess.run([a.tool, mode], input=line + '\n', capture_output=True, text=True)
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {'ok': False, 'error': (p.stderr or 'no output')[-300:]}


def solve_one(a, c):
    r = {'id': c['id']}
    cert = tool(a, 'make', '\t'.join([str(a.k), c['hint'], str(a.budget), str(a.time_ms), '1']))
    r['make'] = {k: cert.get(k) for k in ('ok', 'error', 'nodes', 'seconds')}
    if not cert.get('ok'):
        return r
    fields = [str(a.k), cert['after']]
    for e in cert['internal'] + cert['leaves']:
        fields += [e['at'], e['to']]
    r['check'] = tool(a, 'check', '\t'.join(fields))
    r['within1'] = tool(a, 'within', '\t'.join(['1', c['sfn'], str(a.budget), str(a.time_ms)]))
    if a.k >= 3 and r['within1'].get('result') == 'none':
        r['within2'] = tool(a, 'within', '\t'.join(['2', c['sfn'], str(a.budget), str(a.within2_ms)]))
    r['cert'] = cert
    return r


def cmd_solve(a):
    d = json.load(open(a.candidates))
    cands = d['candidates']
    i, n = (int(x) for x in a.shard.split('/'))
    mine = [c for j, c in enumerate(cands) if j % n == i]
    done = set()
    if os.path.exists(a.work):
        for line in open(a.work):
            try:
                done.add(json.loads(line)['id'])
            except Exception:  # noqa: BLE001  (a torn last line after a kill)
                pass
    todo = [c for c in mine if c['id'] not in done]
    print(f'shard {a.shard}: {len(mine)} candidates, {len(todo)} to solve', flush=True)
    with open(a.work, 'a') as f, cf.ThreadPoolExecutor(a.workers) as ex:
        if not done:
            f.write(json.dumps({'id': '_canary', 'canary': CANARY}) + '\n')
        # as_completed, not map: an ordered map holds every finished result
        # behind the slowest earlier one (the 2026-11-08 chain run wrote 63 of
        # its results in 8 h).
        for fu in cf.as_completed([ex.submit(solve_one, a, c) for c in todo]):
            r = fu.result()
            f.write(json.dumps(r) + '\n')
            f.flush()
            print(r['id'], r['make'].get('ok'), (r.get('check') or {}).get('ok'),
                  (r.get('within1') or {}).get('result'), (r.get('within2') or {}).get('result'), flush=True)


def cmd_assemble(a):
    cands = {c['id']: c for c in json.load(open(a.candidates))['candidates']}
    work = {}
    for f in sorted(glob.glob(a.work)):
        for line in open(f):
            try:
                r = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if r.get('id') in cands:
                work[r['id']] = r
    out = []
    for cid, r in work.items():
        if not (r.get('make') or {}).get('ok') or not (r.get('check') or {}).get('ok'):
            continue
        if (r.get('within1') or {}).get('result') != 'none':
            continue
        w2 = (r.get('within2') or {}).get('result')
        if a.k >= 3 and w2 == 'mate':
            continue
        c = cands[cid]
        excluded = ['mate in 1 (exhaustive proof)']
        open_ = []
        if a.k >= 3:
            (excluded if w2 == 'none' else open_).append('a forced win within 2' + (' (exhaustive proof)' if w2 == 'none' else ''))
        if a.k >= 4:
            open_.append(f'a forced win within {a.k - 1} (not searched exhaustively)')
        out.append({'id': cid, 'kind': 'mate', 'mate': a.k, 'mover': 'red' if c['sfn'].split()[1] == 'r' else 'blue',
                    'sfn': c['sfn'], 'variant': c['variant'], 'game': c['game'], 'from': c['from'],
                    'solution_after': r['cert']['after'], 'solution_key': skey(r['cert']['after']),
                    'shortest': {'excluded': excluded, 'not_excluded': open_},
                    'proof': {'nodes': r['make'].get('nodes'), 'seconds': r['make'].get('seconds'),
                              'internal': len(r['cert']['internal']), 'leaves': len(r['cert']['leaves']),
                              'check_seconds': r['check'].get('seconds')}})
    json.dump({'canary': CANARY, 'k': a.k, 'puzzles': out}, open(a.out, 'w'))
    print(f'{len(out)} mate-in-{a.k} puzzles of {len(work)} solved candidates -> {a.out}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('candidates')
    p.add_argument('--k', type=int, required=True)
    p.add_argument('--pool', required=True)
    p.add_argument('--games', nargs='+', required=True)
    p.add_argument('--out', required=True)
    p = sub.add_parser('solve')
    p.add_argument('--k', type=int, required=True)
    p.add_argument('--candidates', required=True)
    p.add_argument('--shard', default='0/1')
    p.add_argument('--work', required=True)
    p.add_argument('--workers', type=int, default=os.cpu_count() or 1)
    p.add_argument('--time-ms', type=int, default=3_600_000)
    p.add_argument('--within2-ms', type=int, default=1_800_000)
    p.add_argument('--budget', type=int, default=2_000_000_000_000)
    p.add_argument('--tool', required=True)
    p = sub.add_parser('assemble')
    p.add_argument('--k', type=int, required=True)
    p.add_argument('--candidates', required=True)
    p.add_argument('--work', required=True)
    p.add_argument('--out', required=True)
    a = ap.parse_args()
    {'candidates': cmd_candidates, 'solve': cmd_solve, 'assemble': cmd_assemble}[a.cmd](a)


if __name__ == '__main__':
    main()
