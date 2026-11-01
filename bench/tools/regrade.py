#!/usr/bin/env python3
"""Re-grade a finished run with the current grader, without calling any model.

    python3 bench/tools/regrade.py bench/runs/<run> [--status unproven,grader_error] [--ids ...] [--apply]

Every answered puzzle (or only those whose latest status is in --status, plus
any listed in --ids) is
graded again from its stored action list. Without --apply the new grades are
written to <run>/regrade.jsonl and a before/after table is printed. With
--apply they are also appended to results.jsonl (the last record per puzzle
wins, so the report and the leaderboard pick them up) and summary.json is
rewritten. Each re-graded record keeps the model's answer and usage and adds
`regraded: {from, grader, git_commit, date}`.
"""
import argparse
import collections
import datetime as dt
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import CANARY, DEV_SET, REPO, bench_version, load_json  # noqa: E402
from sigilbench.grader import Grader  # noqa: E402
from sigilbench.report import load, summarize  # noqa: E402


def git_commit():
    return subprocess.run(['git', '-C', REPO, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('run_dir')
    ap.add_argument('--status', default=None, help='only re-grade puzzles whose latest status is one of these')
    ap.add_argument('--ids', default=None, help='comma-separated puzzle ids (in addition to --status)')
    ap.add_argument('--puzzles', default=DEV_SET)
    ap.add_argument('--apply', action='store_true')
    a = ap.parse_args()

    puzzles = {p['id']: p for p in load_json(a.puzzles)['puzzles']}
    rows = sorted(load(a.run_dir), key=lambda r: r['puzzle_id'])
    want = set(a.status.split(',')) if a.status else None
    ids = set(a.ids.split(',')) if a.ids else None
    todo = [r for r in rows if r.get('answer') is not None
            and ((want is None and ids is None) or (want is not None and r['status'] in want)
                 or (ids is not None and r['puzzle_id'] in ids))]
    stamp = {'grader': bench_version()['version'], 'git_commit': git_commit()[:9],
             'date': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
    g = Grader()
    out = []
    try:
        for i, r in enumerate(todo, 1):
            t0 = time.time()
            gr = g.grade(puzzles[r['puzzle_id']], r['answer'])
            new = dict(r)
            new['status'], new['correct'] = gr.pop('status'), gr.pop('correct')
            new['grade'] = gr
            new['regraded'] = dict(stamp, **{'from': r['status']})
            out.append(new)
            mark = '' if new['status'] == r['status'] else '  <-- changed'
            print(f"[{i}/{len(todo)}] {r['puzzle_id']} n={r['n']} {r['status']} -> {new['status']} "
                  f"({time.time() - t0:.0f}s){mark}", flush=True)
    finally:
        g.close()

    with open(os.path.join(a.run_dir, 'regrade.jsonl'), 'w') as f:
        f.write(json.dumps({'canary': CANARY}) + '\n')
        for r in out:
            f.write(json.dumps(r) + '\n')
    moves = collections.Counter((r['regraded']['from'], r['status']) for r in out)
    print('\nfrom -> to: count')
    for (x, y), k in sorted(moves.items()):
        print(f'  {x} -> {y}: {k}')
    before = sum(r['correct'] for r in rows)
    after = before + sum(int(r['correct']) - int(r['regraded']['from'] == 'correct') for r in out)
    print(f'correct: {before} -> {after} of {len(rows)}')
    if a.apply and out:
        with open(os.path.join(a.run_dir, 'results.jsonl'), 'a') as f:
            for r in out:
                f.write(json.dumps(r) + '\n')
        s = summarize(a.run_dir)
        with open(os.path.join(a.run_dir, 'summary.json'), 'w') as f:
            json.dump(s, f, indent=1)
        print('applied: results.jsonl appended, summary.json rewritten')


if __name__ == '__main__':
    main()
