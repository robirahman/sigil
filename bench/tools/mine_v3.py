#!/usr/bin/env python3
"""SigilBench v3 mining from fresh self-play (V3_PLAN item 4, stage 1).

    # on a VM (bench/gcp/jobs/mine_v3.sh), one shard of the corpus:
    python3 bench/tools/mine_v3.py corpus --npz-dir <dir of v2d4_*.npz> --out games.json
    python3 bench/tools/mine_v3.py candidates --games games.json --exclude <public set files...> \
        --out-mates mate_cands.json --out-win win_cands.json
    python3 bench/tools/mine_v3.py solve --candidates mate_cands.json --bin <solve_mates> \
        --work work.jsonl --workers 88 --time-ms 120000
    # locally, all shards:
    python3 bench/tools/mine_v3.py assemble --candidates 'mate_cands*.json' --work 'work*.jsonl' --out pool.json

Corpus: the round-6 self-play shards (engine/harness self-play, `v2d4_*.npz`:
per position the SFN, game id, ply, side to move, start ply and `y` = 1 when
the side to move went on to win). Only games started from the empty board
(start_ply 0) are used: games started from human positions could share a
history with published puzzles. Games that hit the ply cap are skipped.

Candidates:
  * mates: the winner to move 1, 3 or 5 plies before the end, with the turn
    actually played as the nomination hint (none for the last turn: the
    position after the winning move is not recorded, and mate-in-1 is
    enumerated in full anyway);
  * winning turns: the winner to move at least 9 plies before the end, with the
    self-play search scoring it between --win-lo and --win-hi centistones (a
    clear but not crushing edge), at most --win-per-game per game.
Any candidate whose position (stones, counters, locks, springlocks, banks)
occurs in an --exclude file (the published puzzle set, dev sets) is dropped,
and so is any game holding such a position.

solve: engine/examples/solve_mates with max_mate 3 under the full browser rules
(mate-in-1 complete; 2 and 3 nominate-then-prove). Longer mates are chained
from the mate-in-3 pool by bench/tools/mine_mate_k.py; certificates and
shortest-mate proofs follow (bench/tools/certs.py, cert_tool within).

Everything this writes is test-set material: private bucket only, canary in
every file.
"""
import argparse
import glob
import hashlib
import json
import os
import random
import subprocess
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import CANARY  # noqa: E402


def skey(s):
    t = s.split()
    pm = [x for x in t[6:] if x.startswith('pm:')]
    return ' '.join([t[0].split('/')[0]] + t[3:6] + pm)


def browser_parity(sfn):
    """Red moves on odd turns in the browser; some self-play runners counted
    from 0. Only the counter moves (tools/selfplay_corpus.py)."""
    t = sfn.split(' ')
    if (t[1] == 'r') != (int(t[2]) % 2 == 1):
        t[2] = str(int(t[2]) + 1)
    return ' '.join(t)


def cmd_corpus(a):
    import numpy as np
    files = sorted(glob.glob(os.path.join(a.npz_dir, '**', '*.npz'), recursive=True))
    rows = defaultdict(list)          # (file group, game) -> [(ply, sfn, is_red, y, score, start_ply)]
    for f in files:
        try:
            z = np.load(f, allow_pickle=True)
        except Exception as e:  # noqa: BLE001
            print('skip', f, e, file=sys.stderr)
            continue
        grp = os.path.dirname(f)       # one run's worker sequence: game ids are unique within it
        for i in range(len(z['game'])):
            rows[(grp, int(z['game'][i]))].append((int(z['ply'][i]), str(z['sfn'][i]), int(z['is_red'][i]),
                                                   int(z['y'][i]), int(z['score'][i]), int(z['start_ply'][i])))
    games, skipped = {}, Counter()
    for (grp, g), rs in rows.items():
        rs.sort()
        if any(r[5] != 0 for r in rs):
            skipped['human start'] += 1
            continue
        if any(r[3] == 255 for r in rs):
            skipped['undecided'] += 1
            continue
        plies = [r[0] for r in rs]
        if plies != list(range(plies[0], plies[0] + len(plies))) or plies[0] != 0:
            skipped['gap'] += 1
            continue
        winner = ('red' if rs[-1][2] else 'blue') if rs[-1][3] == 1 else ('blue' if rs[-1][2] else 'red')
        gid = 'sp6-' + hashlib.sha1(f'{grp}:{g}'.encode()).hexdigest()[:12]
        games[gid] = {'winner': winner, 'positions': [{'sfn': browser_parity(r[1]), 'mover': 'red' if r[2] else 'blue',
                                                       'score': r[4]} for r in rs]}
    json.dump({'canary': CANARY, 'source': a.npz_dir, 'games': games}, open(a.out, 'w'))
    print(f'{len(games)} games from {len(files)} files; skipped {dict(skipped)}')


def public_keys(paths):
    keys = set()

    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k in ('sfn', 'after') and isinstance(v, str) and '/' in v and len(v.split()) >= 6:
                    keys.add(skey(v))
                else:
                    walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    for p in paths:
        walk(json.load(open(p)))
    return keys


def cmd_candidates(a):
    games = json.load(open(a.games))['games']
    pub = public_keys(a.exclude) if a.exclude else set()
    rng = random.Random(a.seed)
    mates, wins, dropped = [], [], Counter()
    for gid, g in sorted(games.items()):
        pos = g['positions']
        if any(skey(p['sfn']) in pub for p in pos):
            dropped['game shares a published position'] += 1
            continue
        n = len(pos)
        for back in (1, 3, 5):
            i = n - back
            if i < 0 or pos[i]['mover'] != g['winner']:
                continue
            hint = pos[i + 1]['sfn'] if i + 1 < n else None
            mates.append({'id': f'{gid}-p{i}', 'sfn': pos[i]['sfn'], 'hints': [hint] if hint else [],
                          'game': gid, 'plies_to_end': back, 'mover': g['winner']})
        pool = [i for i in range(n - 9) if pos[i]['mover'] == g['winner']
                and a.win_lo <= pos[i]['score'] <= a.win_hi]
        rng.shuffle(pool)
        for i in sorted(pool[:a.win_per_game]):
            wins.append({'id': f'{gid}-p{i}', 'sfn': pos[i]['sfn'], 'game': gid, 'plies_to_end': n - i,
                         'mover': g['winner'], 'score': pos[i]['score']})
    json.dump({'canary': CANARY, 'candidates': mates}, open(a.out_mates, 'w'))
    json.dump({'canary': CANARY, 'candidates': wins}, open(a.out_win, 'w'))
    print(f'{len(mates)} mate candidates, {len(wins)} winning-turn candidates; dropped {dict(dropped)}')


def tag_of(r):
    return ('error' if not r.get('ok') else 'm1' if r.get('mate1') else 'm2' if r.get('mate2')
            else 'm3' if r.get('mate3') else 'm4' if r.get('mate4') else 'none')


def cmd_solve(a):
    cands = json.load(open(a.candidates))['candidates']
    done = set()
    if os.path.exists(a.work):
        for line in open(a.work):
            try:
                done.add(json.loads(line)['id'])
            except Exception:  # noqa: BLE001
                pass
    todo = [c for c in cands if c['id'] not in done]
    print(f'{len(cands)} candidates, {len(todo)} to solve', flush=True)

    def one(c):
        line = '\t'.join([str(a.max_mate), str(a.budget), str(a.time_ms), c['sfn']] + c['hints']) + '\n'
        p = subprocess.run([a.bin], input=line, capture_output=True, text=True)
        try:
            r = json.loads(p.stdout.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            r = {'ok': False, 'error': (p.stderr or 'no output')[-300:]}
        return {'id': c['id'], 'result': r}
    with ThreadPoolExecutor(a.workers) as ex, open(a.work, 'a') as f:
        if not done:
            f.write(json.dumps({'id': '_canary', 'canary': CANARY}) + '\n')
        for fu in as_completed([ex.submit(one, c) for c in todo]):
            rec = fu.result()
            f.write(json.dumps(rec) + '\n')
            f.flush()
            print(rec['id'], tag_of(rec['result']), rec['result'].get('seconds'), flush=True)


def cmd_assemble(a):
    cands = {}
    for p in sorted(glob.glob(a.candidates)):
        for c in json.load(open(p))['candidates']:
            cands[c['id']] = c
    recs = {}
    for p in sorted(glob.glob(a.work)):
        for line in open(p):
            try:
                rec = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if rec.get('id') in cands:
                recs[rec['id']] = rec['result']
    tally, puzzles = Counter(), []
    seen = set()
    for cid, r in sorted(recs.items()):
        t = tag_of(r)
        tally[t] += 1
        if t not in ('m1', 'm2', 'm3'):
            continue
        c = cands[cid]
        k = skey(c['sfn'])
        if k in seen:
            tally['duplicate position'] += 1
            continue
        seen.add(k)
        n = int(t[1])
        lines = r['mate' + str(n)]
        sols = [{'actions': l['actions'], 'after': l['after'], 'key': skey(l['after'])} for l in lines]
        puzzles.append({'id': cid, 'kind': 'mate', 'mate': n, 'mover': c['mover'], 'sfn': c['sfn'],
                        'variant': 'competitive' if 'competitive' in c['sfn'] else 'standard',
                        'game': {'id': c['game']}, 'plies_to_end': c['plies_to_end'],
                        'root_successors': r.get('root_successors'),
                        'mate1_complete': n == 1, 'solution_keys': sorted({s['key'] for s in sols}),
                        'solutions': sols, 'solve_seconds': r.get('seconds'), 'nodes': r.get('nodes')})
    doc = {'canary': CANARY, 'solved': len(recs), 'tally': dict(tally),
           'count': dict(Counter(p['mate'] for p in puzzles)), 'puzzles': puzzles}
    json.dump(doc, open(a.out, 'w'))
    print(json.dumps(doc['tally']), json.dumps(doc['count']), '->', a.out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('corpus')
    p.add_argument('--npz-dir', required=True)
    p.add_argument('--out', required=True)
    p = sub.add_parser('candidates')
    p.add_argument('--games', required=True)
    p.add_argument('--exclude', nargs='*', default=[])
    p.add_argument('--out-mates', required=True)
    p.add_argument('--out-win', required=True)
    p.add_argument('--win-lo', type=int, default=150)
    p.add_argument('--win-hi', type=int, default=600)
    p.add_argument('--win-per-game', type=int, default=2)
    p.add_argument('--seed', type=int, default=20261108)
    p = sub.add_parser('solve')
    p.add_argument('--candidates', required=True)
    p.add_argument('--bin', required=True)
    p.add_argument('--work', required=True)
    p.add_argument('--workers', type=int, default=os.cpu_count() or 1)
    p.add_argument('--max-mate', type=int, default=3)
    p.add_argument('--budget', type=int, default=4_000_000_000)
    p.add_argument('--time-ms', type=int, default=120_000)
    p = sub.add_parser('assemble')
    p.add_argument('--candidates', required=True)
    p.add_argument('--work', required=True)
    p.add_argument('--out', required=True)
    a = ap.parse_args()
    {'corpus': cmd_corpus, 'candidates': cmd_candidates, 'solve': cmd_solve, 'assemble': cmd_assemble}[a.cmd](a)


if __name__ == '__main__':
    main()
