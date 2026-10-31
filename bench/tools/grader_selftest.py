#!/usr/bin/env python3
"""Grader self-test on the dev set (checklist 3: "grader self-test").

    python3 bench/tools/grader_selftest.py [--random 3] [--limit N]

For every dev puzzle:
  * every stored first turn (up to 20) must grade `correct`;
  * a corrupted solution (first placement moved to a node that is not legal)
    must grade `illegal` or `invalid`, never `correct`;
  * a malformed answer must grade `invalid`;
  * `--random K` random legal turns: for N = 1 a turn that does not win must
    grade `wrong` (complete enumeration); any turn whose position is a stored
    solution key must grade `correct`; anything graded `correct` that is not a
    stored key is listed (an alternative mate -- a proof, worth a look).
Exit status 1 on any violation.
"""
import argparse
import json
import os
import random
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import DEV_SET, load_json  # noqa: E402
from sigilbench.grader import DEFAULT_GRADE_BIN, Grader  # noqa: E402

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                   'docs', 'static', 'puzzles', 'mate_puzzles.json')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--random', type=int, default=3)
    ap.add_argument('--limit', type=int, default=None)
    a = ap.parse_args()
    dev = load_json(DEV_SET)['puzzles'][:a.limit]
    src = {p['id']: p for p in load_json(SRC)['puzzles']}
    children = os.path.join(os.path.dirname(DEFAULT_GRADE_BIN), 'children')
    g = Grader()
    bad, alt, counts = [], [], {}
    rng = random.Random(7)

    def check(cond, what):
        counts[what] = counts.get(what, 0) + 1
        if not cond:
            bad.append(what)
            print('VIOLATION', what, file=sys.stderr)

    for p in dev:
        sp = src[p['source_puzzle_id']]
        for s in sp['solutions'][:20]:
            r = g.grade(p, s['actions'])
            check(r['status'] == 'correct', f"{p['id']} stored solution -> {r['status']}")
        bad_turn = json.loads(json.dumps(p['reference_solution']))
        first = next(x for x in bad_turn if x.get('type') in ('move', 'hard_move', 'blink'))
        first['node'] = 'c13' if first['node'] != 'c13' else 'a13'
        first.pop('pushed_to', None)
        r = g.grade(p, bad_turn)
        check(r['status'] in ('illegal', 'invalid', 'wrong'), f"{p['id']} corrupted -> {r['status']}")
        r = g.grade(p, [{'type': 'teleport', 'node': 'a1'}])
        check(r['status'] == 'invalid', f"{p['id']} malformed -> {r['status']}")
        if a.random:
            out = subprocess.run([children], input=p['sfn'] + '\n', capture_output=True, text=True, check=True)
            kids = json.loads(out.stdout)['children']
            for k in rng.sample(kids, min(a.random, len(kids))):
                r = g.grade(p, k['actions'])
                stored = r.get('key') in set(p['solution_keys'])
                if stored:
                    check(r['status'] == 'correct', f"{p['id']} random stored-key turn -> {r['status']}")
                elif p['n'] == 1:
                    check(r['status'] == 'wrong', f"{p['id']} random non-mate (N=1) -> {r['status']}")
                else:
                    check(r['status'] in ('wrong', 'correct', 'unproven'), f"{p['id']} random -> {r['status']}")
                    if r['status'] == 'correct':
                        alt.append((p['id'], r.get('key')))
        print(p['id'], 'done', file=sys.stderr)
    g.close()
    print(json.dumps({'puzzles': len(dev), 'checks': sum(counts.values()), 'violations': bad,
                      'alternative_mates_found': alt}, indent=1))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
