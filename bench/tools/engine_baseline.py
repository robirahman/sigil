#!/usr/bin/env python3
"""Engine baseline: the shipped Sigil engine (SigilNet NNUE) answers every
puzzle with one turn at a browser tier's settings, then the answers are graded
by proof like any model's.

    python3 bench/tools/engine_baseline.py --puzzles bench/dev/dev_set_v2.json --tier very_hard \
        --workers 45 --out runs/engine_vh_v2 [--ids sbdev2-001,...] [--grade-jobs 8]

Searches run in separate processes (the Python binding holds the GIL during a
search), one per core so every search gets its full per-move time. The run
directory has the standard layout (run.json, results.jsonl, summary.json), so
sigilbench.report, the resolver and build_leaderboard.py read it unchanged.
The resolver runs at the end (N <= 3 unproven answers settled exactly).
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import json
import multiprocessing as mp
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import CANARY, bench_version, load_json  # noqa: E402
from sigilbench.report import summarize  # noqa: E402

_ENGINE = None


def _play(args):
    tier, p = args
    global _ENGINE
    if _ENGINE is None:
        from sigilbench.providers import Engine
        _ENGINE = Engine(model=tier)
    t0 = time.time()
    try:
        r = _ENGINE.solve(None, None, puzzle=p)
        return p['id'], r['after_sfn'], round(time.time() - t0, 1), None
    except Exception as e:  # noqa: BLE001
        return p['id'], None, round(time.time() - t0, 1), f'{type(e).__name__}: {e}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--puzzles', required=True)
    ap.add_argument('--tier', default='very_hard')
    ap.add_argument('--workers', type=int, default=os.cpu_count() or 1)
    ap.add_argument('--grade-jobs', type=int, default=8)
    ap.add_argument('--ids', default=None)
    ap.add_argument('--out', required=True)
    ap.add_argument('--no-resolve', action='store_true')
    ap.add_argument('--resolve-time-ms', type=int, default=1_800_000)
    a = ap.parse_args()
    puzzles = load_json(a.puzzles)['puzzles']
    if a.ids:
        want = set(a.ids.split(','))
        puzzles = [p for p in puzzles if p['id'] in want]
    os.makedirs(a.out, exist_ok=True)
    from sigilbench.providers import Engine
    settings = Engine(model=a.tier).settings          # validates the tier, records the settings
    try:
        import subprocess
        commit = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    except Exception:  # noqa: BLE001
        commit = None
    json.dump({'canary': CANARY, 'benchmark': bench_version(), 'split': 'dev', 'provider': 'engine',
               'model': a.tier, 'settings': settings, 'puzzles_file': os.path.basename(a.puzzles),
               'started': dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ'), 'git_commit': commit,
               'n_puzzles': len(puzzles), 'workers': a.workers},
              open(os.path.join(a.out, 'run.json'), 'w'), indent=1)

    # Phase 1: the engine's turns, one search per process.
    ans_path = os.path.join(a.out, 'answers.jsonl')
    done = {}
    if os.path.exists(ans_path):
        for line in open(ans_path):
            r = json.loads(line)
            done[r['puzzle_id']] = r
    todo = [p for p in puzzles if p['id'] not in done]
    print(f'{len(todo)} searches ({len(done)} already done), {a.workers} processes', flush=True)
    ctx = mp.get_context('spawn')
    with ctx.Pool(a.workers) as pool, open(ans_path, 'a') as f:
        for pid, after, secs, err in pool.imap_unordered(_play, [(a.tier, p) for p in todo]):
            rec = {'puzzle_id': pid, 'after_sfn': after, 'seconds': secs, 'error': err}
            done[pid] = rec
            f.write(json.dumps(rec) + '\n')
            f.flush()
            print(pid, 'played' if after else f'ERROR {err}', secs, flush=True)

    # Phase 2: grade by proof (one Grader per thread; each is two subprocesses).
    from sigilbench.grader import Grader
    import threading
    local = threading.local()
    res_path = os.path.join(a.out, 'results.jsonl')
    with open(res_path, 'w') as f:
        f.write(json.dumps({'canary': CANARY}) + '\n')
    lock = threading.Lock()

    def grade(p):
        if not hasattr(local, 'g'):
            local.g = Grader()
        r = done[p['id']]
        if not r.get('after_sfn'):
            g = {'status': 'api_error', 'correct': False, 'detail': r.get('error')}
        else:
            g = local.g.grade_after(p, r['after_sfn'])
        rec = {'puzzle_id': p['id'], 'n': p['n'], 'status': g['status'], 'correct': g['correct'],
               'answer': r.get('after_sfn'), 'stop': 'answered', 'usage': {}, 'seconds': r.get('seconds'),
               'grade': {k: v for k, v in g.items() if k not in ('status', 'correct')}}
        with lock:
            with open(res_path, 'a') as f:
                f.write(json.dumps(rec) + '\n')
            print(p['id'], f"N={p['n']}", g['status'], flush=True)

    with cf.ThreadPoolExecutor(a.grade_jobs) as ex:
        list(ex.map(grade, puzzles))
    if not a.no_resolve:
        from sigilbench.resolve import resolve_run
        resolve_run(a.out, {p['id']: p for p in puzzles}, time_ms=a.resolve_time_ms, include_errors=True,
                    log=lambda m: print(m, flush=True))
    s = summarize(a.out)
    s['canary'] = CANARY
    json.dump(s, open(os.path.join(a.out, 'summary.json'), 'w'), indent=1)
    print(json.dumps({k: s[k] for k in ('overall', 'by_n', 'status_counts')}, indent=1), flush=True)


if __name__ == '__main__':
    main()
