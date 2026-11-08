#!/usr/bin/env python3
"""Playouts for winning-turn puzzle candidates (SigilBench v3).

    python3 bench/tools/win_playouts.py verdicts.jsonl --out playouts.jsonl \
        [--games 6] [--ms 10000] [--max-plies 160] [--workers N] [--only-puzzles]

For each position in a bench/tools/win_puzzle.py verdict file, every child in
its "playout" list (the keys and the best alternatives) is played out from the
position after the mover's turn: the site's Very Hard engine on both sides
(engine/harness/position_selfplay.play: shipped eval, policy and exploration
tail, 21-bit table, no pondering) at --ms per move, --games times. Timing
makes the games differ. One JSON line per game: id, after, role, winner,
plies, seconds. Summaries (mover win rate per child) come from --summary.

Needs the Python binding (maturin develop in engine/).
"""
import argparse
import concurrent.futures as cf
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'engine', 'harness')


def _play(job):
    sys.path.insert(0, HARNESS)
    import sigil_engine as se
    import position_selfplay as ps
    if hasattr(se, 'SHIPPED_POLICY'):
        se.set_policy(*se.SHIPPED_POLICY)
    if hasattr(se, 'SHIPPED_EXPLORE'):
        se.set_policy_explore(*se.SHIPPED_EXPLORE)
    t0 = time.time()
    import io
    import contextlib
    with contextlib.redirect_stdout(io.StringIO()):     # play() prints every ply
        winner, plies = ps.play(job['after'], [], job['ms'], ps.TIERS['very_hard']['tt'], job['max_plies'])
    return dict(job, winner=winner, plies=plies, seconds=round(time.time() - t0, 1))


def summary(path):
    by = {}
    for line in open(path):
        r = json.loads(line)
        k = (r['id'], r['after'])
        s = by.setdefault(k, {'id': r['id'], 'role': r['role'], 'p': r.get('p'), 'mover': r['mover'], 'games': 0, 'mover_wins': 0, 'unfinished': 0})
        s['games'] += 1
        if r['winner'] is None:
            s['unfinished'] += 1
        elif r['winner'] == r['mover']:
            s['mover_wins'] += 1
    out = []
    for s in by.values():
        done = s['games'] - s['unfinished']
        s['win_rate'] = round(s['mover_wins'] / done, 3) if done else None
        out.append(s)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('verdicts')
    ap.add_argument('--out', required=True)
    ap.add_argument('--games', type=int, default=6)
    ap.add_argument('--ms', type=int, default=10000)
    ap.add_argument('--max-plies', type=int, default=160)
    ap.add_argument('--workers', type=int, default=os.cpu_count() or 1)
    ap.add_argument('--only-puzzles', action='store_true')
    ap.add_argument('--summary', action='store_true', help='summarize --out and exit')
    a = ap.parse_args()
    if a.summary:
        for s in summary(a.out):
            print(json.dumps(s))
        return
    jobs = []
    for line in open(a.verdicts):
        v = json.loads(line)
        if a.only_puzzles and v.get('verdict') != 'puzzle':
            continue
        mover = 'red' if v['sfn'].split()[1] == 'r' else 'blue'
        for c in v.get('playout') or []:
            for g in range(a.games):
                jobs.append({'id': v['id'], 'after': c['after'], 'role': c['role'], 'p': c.get('p'),
                             'mover': mover, 'game': g, 'ms': a.ms, 'max_plies': a.max_plies})
    print(f'{len(jobs)} games on {a.workers} workers', flush=True)
    import multiprocessing as mp
    with cf.ProcessPoolExecutor(a.workers, mp_context=mp.get_context('spawn')) as ex, open(a.out, 'a') as f:
        for fu in cf.as_completed([ex.submit(_play, j) for j in jobs]):
            r = fu.result()
            f.write(json.dumps(r) + '\n')
            f.flush()
            print(r['id'], r['role'], r['winner'], r['plies'], r['seconds'], flush=True)


if __name__ == '__main__':
    main()
