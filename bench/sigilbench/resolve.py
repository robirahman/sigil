"""Resolve answers the first-pass grader left `unproven`.

    cd bench && python3 -m sigilbench.resolve runs/<run> [runs/<run2> ...] [--jobs 1] [--time-ms 3600000]

The first pass (`grader.py`) proves mate-in-3 answers with nominated
mate-in-2 continuations, so a miss there is "unproven", not "wrong". This
re-grades each such answer with `bench_grade` in exhaustive mode
(BENCH_EXHAUSTIVE=1, `mate::judge_turn_exhaustive`): after every reply that
leaves no mate-in-1, EVERY mover turn is tested for a forced mate-in-1, so the
result is a proof either way:

  correct   every reply leaves a mate within 2 more turns
  wrong     some reply leaves no mate-in-2 at all (exhaustive)

A resolved answer gets a NEW record appended to results.jsonl (the report
takes the last record per puzzle) with `grade.resolved_from` set; answers that
still run out of budget/time stay unproven, and every attempt is logged in
resolve_log.jsonl. `--include-grader-errors` also retries first-pass budget
exhaustion. run.py calls this automatically at the end of a run.

Cost: a correct answer usually resolves in seconds; a refutation needs, for
every mover turn after the refuting reply, a refuting reply of its own plus a
full no-mate-in-1 enumeration (~1e9-1e10 turn applications), so give it a
many-core machine and a long --time-ms.
"""
import argparse
import concurrent.futures as cf
import json
import os
import subprocess
import sys
import threading
import time

from .common import CANARY, DEV_SET, load_json
from .grader import DEFAULT_GRADE_BIN
from .report import load, summarize


def _one(grade_bin, n, sfn, after, budget, time_ms, threads):
    env = dict(os.environ, BENCH_EXHAUSTIVE='1', BENCH_BUDGET=str(budget), BENCH_TIME_MS=str(time_ms),
               BENCH_THREADS=str(threads))
    t0 = time.time()
    p = subprocess.run([grade_bin], input=f'{n}\t{sfn}\t{after}\n', capture_output=True, text=True, env=env)
    try:
        out = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        out = {'verdict': 'error', 'error': (p.stderr or 'no output')[-300:]}
    out['wall_seconds'] = round(time.time() - t0, 1)
    return out


def pending(run_dir, include_errors=False):
    rows = load(run_dir)
    want = {'unproven'} | ({'grader_error'} if include_errors else set())
    return [r for r in rows if r['status'] in want and (r.get('grade') or {}).get('after')]


def resolve_run(run_dir, puzzles=None, jobs=None, budget=20_000_000_000, time_ms=3_600_000,
                include_errors=False, grade_bin=DEFAULT_GRADE_BIN, log=print):
    puzzles = puzzles or {p['id']: p for p in load_json(DEV_SET)['puzzles']}
    todo = pending(run_dir, include_errors)
    tally = {'correct': 0, 'wrong': 0, 'still_unproven': 0}
    if not todo:
        log(f'{run_dir}: nothing to resolve')
        return tally
    # Each answer's exhaustive search is itself multi-threaded: by default one
    # answer at a time with every core.
    cpus = os.cpu_count() or 1
    jobs = jobs or 1
    threads = max(1, cpus // jobs)
    log(f'{run_dir}: resolving {len(todo)} answers, {jobs} at a time x {threads} threads, '
        f'{time_ms / 1000:.0f} s each max')
    res_path = os.path.join(run_dir, 'results.jsonl')
    log_path = os.path.join(run_dir, 'resolve_log.jsonl')
    lock = threading.Lock()

    def work(r):
        p = puzzles[r['puzzle_id']]
        g = _one(grade_bin, p['n'], p['sfn'], r['grade']['after'], budget, time_ms, threads)
        v = g.get('verdict')
        with lock:
            with open(log_path, 'a') as f:
                f.write(json.dumps({'canary': CANARY, 'puzzle_id': r['puzzle_id'], 'from': r['status'],
                                    'time_ms': time_ms, 'threads': threads, 'result': g}) + '\n')
            if v in ('mate', 'not_mate'):
                status = 'correct' if v == 'mate' else 'wrong'
                rec = dict(r, status=status, correct=(v == 'mate'),
                           grade=dict(r['grade'], resolved_from=r['status'], rust_exhaustive=g,
                                      proof='exhaustive resolver' if v == 'mate' else 'exhaustive refutation'))
                with open(res_path, 'a') as f:
                    f.write(json.dumps(rec) + '\n')
                tally[status] += 1
                log(f"  {r['puzzle_id']} {r['status']} -> {status} ({g.get('nodes')} nodes, {g['wall_seconds']} s)")
            else:
                tally['still_unproven'] += 1
                log(f"  {r['puzzle_id']} still {r['status']}: {g.get('error')} ({g['wall_seconds']} s)")

    with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
        list(ex.map(work, todo))
    return tally


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('runs', nargs='+')
    ap.add_argument('--puzzles', default=DEV_SET)
    ap.add_argument('--jobs', type=int, default=None,
                    help='answers resolved at once (default 1; each uses CPUs/jobs threads)')
    ap.add_argument('--budget', type=int, default=20_000_000_000, help='node budget per answer and thread')
    ap.add_argument('--time-ms', type=int, default=3_600_000, help='wall-clock cap per answer')
    ap.add_argument('--include-grader-errors', action='store_true')
    a = ap.parse_args()
    puzzles = {p['id']: p for p in load_json(a.puzzles)['puzzles']}
    for d in a.runs:
        t = resolve_run(d, puzzles, a.jobs, a.budget, a.time_ms, a.include_grader_errors,
                        log=lambda m: print(m, flush=True))
        print(json.dumps({'run': d, **t}), flush=True)
        if os.path.exists(os.path.join(d, 'run.json')):
            s = summarize(d)
            s['canary'] = CANARY
            json.dump(s, open(os.path.join(d, 'summary.json'), 'w'), indent=1)


if __name__ == '__main__':
    sys.exit(main())
