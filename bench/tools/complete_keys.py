#!/usr/bin/env python3
"""Complete answer keys for winning-turn puzzles (SigilBench v3).

    python3 bench/tools/complete_keys.py puzzles.json --bin $BIN --out keys.jsonl [--workers N]

puzzles.json: {"puzzles": [{"id", "sfn", "answer_keys", "key_idea": [[places], [spells]], "depth", "eval", "win_p"}]}
(the win_puzzle.py verdict's keys, idea, depth). The root table judged only the
children it searched deeply. Here EVERY distinct child of the position
(engine/examples/rules_children: full browser rules, one representative turn
per position) whose turn executes the key idea (win_puzzle.solution_signature)
is searched by bench_grade "w" at the table's depth and net and turned into
P(mover wins) with the table's calibration: P >= win_p is an answer key,
anything else a failed execution. One JSON line per puzzle:
{"id", "children", "idea_children", "answer_keys", "failed_keys", "evaluated", "errors"}.
With complete keys, grading and the Try panel need only a key lookup.
"""
import argparse
import concurrent.futures as cf
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
from win_puzzle import solution_signature  # noqa: E402
from sigilbench.grader import win_prob, sfn_key  # noqa: E402


def one(job):
    p, bin_ = job
    o = subprocess.run([bin_ + '/rules_children'], input=p['sfn'] + '\n', capture_output=True, text=True).stdout
    r = json.loads(o.strip().splitlines()[-1])
    idea = (tuple(p['key_idea'][0]), tuple(p['key_idea'][1]))
    kids = [c for c in r.get('children') or [] if solution_signature(c.get('actions') or []) == idea]
    keys, failed = set(p.get('answer_keys') or []), set()
    known = set(keys)
    errors = 0
    todo = [c for c in kids if sfn_key(c['sfn']) not in known]
    if todo:
        g = subprocess.Popen([bin_ + '/bench_grade'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        for c in todo:
            g.stdin.write(f"w\t{p['sfn']}\t{c['sfn']}\t{p.get('depth', 5)}\t{p.get('eval', 'nnue_mt256')}\n")
            g.stdin.flush()
            res = json.loads(g.stdout.readline())
            if res.get('verdict') != 'eval':
                errors += 1
                continue
            pr = win_prob(p['sfn'], c['sfn'], res)
            (keys if pr is not None and pr >= p.get('win_p', 0.80) else failed).add(sfn_key(c['sfn']))
        g.stdin.close()
        g.wait()
    return {'id': p['id'], 'children': len(r.get('children') or []), 'truncated': r.get('truncated'),
            'idea_children': len(kids), 'answer_keys': sorted(keys), 'failed_keys': sorted(failed),
            'evaluated': len(todo), 'errors': errors}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('puzzles')
    ap.add_argument('--bin', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--workers', type=int, default=os.cpu_count() or 1)
    a = ap.parse_args()
    ps = json.load(open(a.puzzles))['puzzles']
    done = {json.loads(l)['id'] for l in open(a.out)} if os.path.exists(a.out) else set()
    todo = [p for p in ps if p['id'] not in done]
    print(f'{len(ps)} puzzles, {len(todo)} to do', flush=True)
    with cf.ThreadPoolExecutor(a.workers) as ex, open(a.out, 'a') as f:
        for fu in cf.as_completed([ex.submit(one, (p, a.bin)) for p in todo]):
            r = fu.result()
            f.write(json.dumps(r) + '\n')
            f.flush()
            print(r['id'], r['idea_children'], len(r['answer_keys']), len(r['failed_keys']), r['errors'], flush=True)


if __name__ == '__main__':
    main()
