#!/usr/bin/env python3
"""Check the rules-complete enumeration (cast_enum::set_full_rules) against the
narrow one on published puzzle positions where Rock Slide, Corrupt, Comet or
Erupt is CHARGED for the side to move: every narrow successor must also be a
full-rules successor, and the report counts the positions only the full
enumeration reaches.

    python3 bench/tools/full_rules_superset.py [--limit 60]
"""
import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import REPO  # noqa: E402
from sigilbench.grader import DEFAULT_GRADE_BIN  # noqa: E402
from sigilbench.render import parse_sfn  # noqa: E402
from notation import POSITIONS  # noqa: E402

SPELLS = ('Rock_Slide', 'Corrupt', 'Comet', 'Erupt')
CHILDREN = os.path.join(os.path.dirname(DEFAULT_GRADE_BIN), 'children')


def kids(sfn, narrow):
    env = dict(os.environ)
    if narrow:
        env['SIGIL_NARROW_RULES'] = '1'
    else:
        env.pop('SIGIL_NARROW_RULES', None)
    out = subprocess.run([CHILDREN], input=sfn + '\n', capture_output=True, text=True, env=env, check=True)
    d = json.loads(out.stdout)
    return {' '.join(c['sfn'].split()[:1] + c['sfn'].split()[3:6]) for c in d['children']}, d['truncated']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=60)
    a = ap.parse_args()
    ps = json.load(open(os.path.join(REPO, 'docs', 'static', 'puzzles', 'mate_puzzles.json')))['puzzles']
    by = {s: [] for s in SPELLS}
    for p in ps:
        d = parse_sfn(p['sfn'])
        for i, s in enumerate(d['spells']):
            if s in SPELLS and all(d['stones'][n] == d['to_move'] for n in POSITIONS[i + 1]):
                by[s].append(p['sfn'])
    bad, report = 0, {}
    for s in SPELLS:
        extra_total, n = 0, 0
        for sfn in by[s][:a.limit // len(SPELLS)]:
            narrow, t1 = kids(sfn, True)
            full, t2 = kids(sfn, False)
            missing = narrow - full
            if missing:
                bad += 1
                print('NOT A SUPERSET', s, sfn, len(missing), file=sys.stderr)
            extra_total += len(full - narrow)
            n += 1
        report[s] = {'positions': n, 'available': len(by[s]), 'extra_successors': extra_total}
    print(json.dumps({'violations': bad, 'by_spell': report}, indent=1))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
