#!/usr/bin/env python3
"""Summarize complete root tables (engine/examples/win_table output) for
winning-turn puzzles: SigilBench v3 phase 0.

    python3 bench/tools/win_table.py wintable.jsonl [--band 0.5] [--json out.json]

For each (puzzle, depth) line: distinct root children, seconds per child, and
for each evaluator the best child's score, the gap to the best child outside
the stored solution keys, how many children sit within `band` stones of the
best, and whether the stored solutions are the best. With the shipped net at a
calibrated depth (4-6, docs/static/data/position-winprob.json) the scores are
also converted to P(mover wins), as tools/winning_turns.py does.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'tools'))
import winning_turns as WT  # noqa: E402


def child_score(c, mover, ev):
    if c['over']:
        return 99.0 if c['winner'] == mover else -99.0
    e = (c.get('evals') or {}).get(ev)
    if not e:
        return None
    if e.get('mate'):
        return 99.0 if e['mate'] > 0 else -99.0
    return e['stones']


def mover_p(c, mover, depth):
    if c['over']:
        return 1.0 if c['winner'] == mover else 0.0
    e = (c.get('evals') or {}).get('nnue_mt256')
    if not e:
        return None
    sign = 1 if mover == 'red' else -1
    pr = WT.red_win_prob(c['after'], e['depth'], e['stones'] * sign,
                         None if not e.get('mate') else e['mate'] * sign, bool(e.get('proven')))
    if pr is None:
        return None
    return pr if mover == 'red' else 1 - pr


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('table')
    ap.add_argument('--band', type=float, default=0.5)
    ap.add_argument('--json')
    a = ap.parse_args()
    rows = []
    for line in open(a.table):
        r = json.loads(line)
        if not r.get('children'):
            continue
        mover = 'red' if r['sfn'].split()[1] == 'r' else 'blue'
        keys = set(r.get('solution_keys') or [])
        row = {'id': r['id'], 'depth': r['depth'], 'turns': r['turns'], 'children': len(r['children']),
               'sec_per_child': round(r['seconds'] / max(1, len(r['children'])), 4), 'evals': {}}
        evs = sorted({k for c in r['children'] for k in (c.get('evals') or {})})
        for ev in evs:
            sc = [(child_score(c, mover, ev), WT.key_of(c['after']) in keys) for c in r['children']]
            sc = [x for x in sc if x[0] is not None]
            if not sc:
                continue
            best = max(s for s, _ in sc)
            sol = [s for s, k in sc if k]
            other = [s for s, k in sc if not k]
            row['evals'][ev] = {
                'best': round(best, 3),
                'solution_best': round(max(sol), 3) if sol else None,
                'best_other': round(max(other), 3) if other else None,
                'gap': round(max(sol) - max(other), 3) if sol and other else None,
                'within_band': sum(1 for s, _ in sc if s >= best - a.band),
            }
        if r['depth'] >= 4:
            ps = [(mover_p(c, mover, r['depth']), WT.key_of(c['after']) in keys) for c in r['children']]
            ps = [x for x in ps if x[0] is not None]
            sol = [p for p, k in ps if k]
            other = [p for p, k in ps if not k]
            row['p'] = {'solution': round(max(sol), 3) if sol else None,
                        'best_other': round(max(other), 3) if other else None}
        rows.append(row)
        print(json.dumps(row))
    if a.json:
        json.dump(rows, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
