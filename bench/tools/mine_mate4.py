#!/usr/bin/env python3
"""Mine mate-in-4 puzzles for the SigilBench dev set v2.

    # 1. candidates (local): the position two plies before every known mate-in-3
    #    (published set + self-play candidates), with the turn actually played as
    #    a nomination hint
    python3 bench/tools/mine_mate4.py candidates --games hydrated.json selfplay.json \
        --m3 docs/static/puzzles/mate_puzzles.json sp_candidates.json --out m4_candidates.json
    # 2. solve (one shard per VM; resumable)
    python3 bench/tools/mine_mate4.py solve --candidates m4_candidates.json --shard 0/4 \
        --work work_0.jsonl --workers 90 --time-ms 900000
    # 3. assemble (local)
    python3 bench/tools/mine_mate4.py assemble --candidates m4_candidates.json --work 'work_*.jsonl' --out m4.json

`solve` runs engine/examples/solve_mates (SOLVE_MATES_BIN) with max_mate 4 under
the full browser rules. A position counts as a mate-in-4 puzzle only if the
solver found no mate in 1 (exhaustive), 2 or 3 (nominated) and PROVED at least
one first turn: every legal reply leaves a proven win within 3 more turns.
"""
import argparse
import glob
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOLVE_BIN = os.environ.get('SOLVE_MATES_BIN') or os.path.join(
    os.environ.get('CARGO_TARGET_DIR', os.path.join(REPO, 'engine', 'target')), 'release', 'examples', 'solve_mates')
BAD_VARIANTS = ('scramble', 'duplicates', 'pentagon', 'deathmatch')


def skey(s):
    """puzzleSfnKey: stones, spell counters, locks, springlocks (+ Providence banks)."""
    t = s.split()
    pm = [x for x in t[6:] if x.startswith('pm:')]
    return ' '.join([t[0].split('/')[0]] + t[3:6] + pm)


def cmd_candidates(a):
    games = {}
    for f in a.games:
        games.update(json.load(open(f)))
    m3 = []
    for f in a.m3:
        d = json.load(open(f))
        m3 += [p for p in (d['puzzles'] if isinstance(d, dict) else d) if p.get('kind') == 'mate' and p.get('mate') == 3]
    out, seen = [], set()
    for p in m3:
        g = games.get(p['game']['id'])
        if not g or any(v in (g.get('variant') or '') for v in BAD_VARIANTS):
            continue
        pk = skey(p['sfn'])
        at = [t for t in g['turns'] if t.get('sfnBefore') and skey(t['sfnBefore']) == pk]
        if not at:
            continue
        by = {t['turnNumber']: t for t in g['turns']}
        prev = by.get(at[0]['turnNumber'] - 2)
        if not prev or not prev.get('sfnBefore') or prev.get('color') != at[0].get('color'):
            continue
        s = prev['sfnBefore']
        if any(x.startswith(('ab:', 'sn:')) for x in s.split()):
            continue
        k = (skey(s), s.split()[1])
        if k in seen:
            continue
        seen.add(k)
        out.append({'id': f"{p['game']['id']}-t{prev['turnNumber']}", 'sfn': s,
                    'hints': [prev['sfnAfter']] if prev.get('sfnAfter') else [], 'from_m3': p['id'],
                    'variant': g.get('variant') or 'standard',
                    'game': {'id': p['game']['id'], 'winner': g.get('winner'), 'date': p['game'].get('date')}})
    json.dump(out, open(a.out, 'w'))
    print(f'{len(out)} candidates -> {a.out}')


def cmd_solve(a):
    cands = json.load(open(a.candidates))
    i, n = (int(x) for x in a.shard.split('/'))
    mine = [c for k, c in enumerate(cands) if k % n == i]
    done = set()
    if os.path.exists(a.work):
        for line in open(a.work):
            try:
                done.add(json.loads(line)['id'])
            except Exception:  # noqa: BLE001  (a torn last line after a kill)
                pass
    todo = [c for c in mine if c['id'] not in done]
    print(f'shard {a.shard}: {len(mine)} candidates, {len(todo)} to solve', flush=True)
    env = dict(os.environ)

    def one(c):
        line = '\t'.join(['4', str(a.budget), str(a.time_ms), c['sfn']] + c['hints']) + '\n'
        p = subprocess.run([SOLVE_BIN], input=line, capture_output=True, text=True, env=env)
        try:
            r = json.loads(p.stdout.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            r = {'ok': False, 'error': (p.stderr or 'no output')[-300:]}
        return {'id': c['id'], 'result': r}

    with ThreadPoolExecutor(max_workers=a.workers) as ex, open(a.work, 'a') as f:
        for rec in ex.map(one, todo):
            f.write(json.dumps(rec) + '\n')
            f.flush()
            r = rec['result']
            tag = ('error' if not r.get('ok') else 'm1' if r.get('mate1') else 'm2' if r.get('mate2')
                   else 'm3' if r.get('mate3') else 'm4' if r.get('mate4') else 'none')
            print(rec['id'], tag, r.get('seconds'), flush=True)


def cmd_assemble(a):
    cands = {c['id']: c for c in json.load(open(a.candidates))}
    recs = {}
    for path in sorted(set(glob.glob(a.work))):
        for line in open(path):
            try:
                rec = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            recs[rec['id']] = rec['result']
    tally, puzzles = {}, []
    for cid, r in recs.items():
        tag = ('error' if not r.get('ok') else 'm1' if r.get('mate1') else 'm2' if r.get('mate2')
               else 'm3' if r.get('mate3') else 'm4' if r.get('mate4') else 'none')
        tally[tag] = tally.get(tag, 0) + 1
        if tag != 'm4':
            continue
        c = cands[cid]
        sols = [{'actions': l['actions'], 'after': l['after'], 'key': skey(l['after'])} for l in r['mate4']]
        puzzles.append({'id': cid, 'kind': 'mate', 'mate': 4, 'mover': r['mover'], 'sfn': c['sfn'],
                        'variant': c['variant'], 'game': c['game'], 'from_m3': c['from_m3'],
                        'source': 'mined-v2 (2026-11)', 'root_successors': r.get('root_successors'),
                        'solution_keys': sorted({s['key'] for s in sols}), 'solutions': sols,
                        'solve_seconds': r.get('seconds'), 'nodes': r.get('nodes')})
    doc = {'generated_from': a.work, 'solved': len(recs), 'tally': tally, 'count': len(puzzles), 'puzzles': puzzles}
    json.dump(doc, open(a.out, 'w'), indent=1)
    print(json.dumps(tally), f'{len(puzzles)} mate-in-4 puzzles -> {a.out}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('candidates')
    c.add_argument('--games', nargs='+', required=True)
    c.add_argument('--m3', nargs='+', required=True)
    c.add_argument('--out', required=True)
    s = sub.add_parser('solve')
    s.add_argument('--candidates', required=True)
    s.add_argument('--shard', default='0/1')
    s.add_argument('--work', required=True)
    s.add_argument('--workers', type=int, default=os.cpu_count() or 1)
    s.add_argument('--budget', type=int, default=4_000_000_000)
    s.add_argument('--time-ms', type=int, default=900_000)
    m = sub.add_parser('assemble')
    m.add_argument('--candidates', required=True)
    m.add_argument('--work', required=True)
    m.add_argument('--out', required=True)
    a = ap.parse_args()
    {'candidates': cmd_candidates, 'solve': cmd_solve, 'assemble': cmd_assemble}[a.cmd](a)


if __name__ == '__main__':
    main()
