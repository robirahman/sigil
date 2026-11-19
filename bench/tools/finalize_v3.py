#!/usr/bin/env python3
"""Finish the selected v3 sets: reference turns and complete winning-turn keys.

    python3 bench/tools/finalize_v3.py SET.json [SET2.json ...] --bin $BIN [--keys keys.jsonl ...] [--in-place]

For every puzzle without an action-list reference_solution (mined mates in 4
and 5 store only the position after the first turn), the action list of a
turn reaching that position is taken from engine/examples/rules_children
(full browser rules) and replayed through bench/grader/apply.js to confirm
it. Winning-turn puzzles take their complete answer_keys / failed_keys from
complete_keys.py output (--keys), and a reference_solution (a winning
execution's action list, the key whose table P was highest when known).
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from sigilbench.common import BENCH  # noqa: E402
from sigilbench.grader import sfn_key  # noqa: E402


def children(bin_, sfn):
    o = subprocess.run([bin_ + '/rules_children'], input=sfn + '\n', capture_output=True, text=True).stdout
    return json.loads(o.strip().splitlines()[-1]).get('children') or []


def replay(items):
    inp = ''.join(json.dumps({'sfn': s, 'actions': a}) + '\n' for s, a in items)
    out = subprocess.run(['node', os.path.join(BENCH, 'grader', 'apply.js')], input=inp,
                         capture_output=True, text=True, check=True).stdout.splitlines()
    return [json.loads(l) for l in out]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('sets', nargs='+')
    ap.add_argument('--bin', required=True)
    ap.add_argument('--keys', nargs='*', default=[])
    ap.add_argument('--in-place', action='store_true')
    a = ap.parse_args()
    keys = {}
    for f in a.keys:
        for line in open(f):
            if line.strip():
                r = json.loads(line)
                keys[r['id']] = r
    for path in a.sets:
        d = json.load(open(path))
        problems = []
        for p in d['puzzles']:
            pid = p.get('pool_id', p['id'])
            if p.get('kind') == 'win' and pid in keys:
                k = keys[pid]
                p['answer_keys'] = k['answer_keys']
                p['failed_keys'] = k['failed_keys']
                p['execution_matters'] = bool(k['failed_keys'])
                p['keys_complete'] = not k.get('errors') and not k.get('truncated')
            want = None
            if not p.get('reference_solution'):
                if p.get('kind') == 'win':
                    want = set(p['answer_keys'])
                elif p.get('reference_after'):
                    want = {sfn_key(p['reference_after'])}
                else:
                    want = set(p.get('solution_keys') or [])
            if want:
                acts = next((c['actions'] for c in children(a.bin, p['sfn']) if sfn_key(c['sfn']) in want), None)
                if acts is None:
                    problems.append((p['id'], 'no turn reaches a key'))
                    continue
                r = replay([(p['sfn'], acts)])[0]
                if not r.get('ok') or r.get('key') not in want:
                    problems.append((p['id'], 'reference turn does not replay to a key in the browser rules'))
                    continue
                p['reference_solution'] = acts
        out = path if a.in_place else path.replace('.json', '.final.json')
        json.dump(d, open(out, 'w'), indent=1)
        print(path, '->', out, 'problems:', problems or 'none')


if __name__ == '__main__':
    main()
