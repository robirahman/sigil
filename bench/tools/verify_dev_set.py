#!/usr/bin/env python3
"""Re-prove every puzzle of a dev set with the current engine: the reference
solution must replay in the browser rules (apply.js) to a stored solution
position, and be proven a forced win within N under the full rules -- by
bench_grade for N <= 3, and for N = 4 by the miner's own path (solve_mates,
max_mate 4, the stored turn as the nomination hint), because bench_grade's cold
inner nominations often cannot re-find a mate-in-3 the miner found (a proof is
sound however its candidates were nominated). Run after any engine change that
touches the solver.

    python3 bench/tools/verify_dev_set.py bench/dev/dev_set_v2.json [--jobs 4] [--time-ms 900000]
"""
import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import BENCH  # noqa: E402
from sigilbench.grader import DEFAULT_GRADE_BIN  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dev_set')
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 1)
    ap.add_argument('--time-ms', type=int, default=900_000)
    a = ap.parse_args()
    ps = json.load(open(a.dev_set))['puzzles']
    inp = ''.join(json.dumps({'sfn': p['sfn'], 'actions': p['reference_solution']}) + '\n' for p in ps)
    rep = subprocess.run(['node', os.path.join(BENCH, 'grader', 'apply.js')], input=inp,
                         capture_output=True, text=True, check=True).stdout.splitlines()
    env = dict(os.environ, BENCH_TIME_MS=str(a.time_ms), BENCH_THREADS='1')

    def one(args):
        p, r = args
        r = json.loads(r)
        if not r.get('ok'):
            return p['id'], p['n'], {'verdict': 'replay failed', 'error': r.get('error')}
        if r['key'] not in p['solution_keys']:
            return p['id'], p['n'], {'verdict': 'replay reached a non-stored position'}
        if p['n'] == 4:
            solve = os.path.join(os.path.dirname(DEFAULT_GRADE_BIN), 'solve_mates')
            out = subprocess.run([solve], input=f"4\t4000000000\t{a.time_ms}\t{p['sfn']}\t{r['after']}\n",
                                 capture_output=True, text=True, env=env).stdout
            s = json.loads(out.strip().splitlines()[-1])
            if not s.get('ok'):
                return p['id'], 4, {'verdict': 'error', 'error': s.get('error')}
            if s.get('mate1') or s.get('mate2') or s.get('mate3'):
                return p['id'], 4, {'verdict': 'shorter mate found', 'seconds': s.get('seconds')}
            keys = {' '.join([l['after'].split()[0].split('/')[0]] + l['after'].split()[3:6]
                             + [x for x in l['after'].split()[6:] if x.startswith('pm:')]) for l in s.get('mate4', [])}
            return p['id'], 4, {'verdict': 'mate' if r['key'] in keys else 'not re-proven', 'seconds': s.get('seconds')}
        out = subprocess.run([DEFAULT_GRADE_BIN], input=f"{p['n']}\t{p['sfn']}\t{r['after']}\n",
                             capture_output=True, text=True, env=env).stdout
        return p['id'], p['n'], json.loads(out.strip().splitlines()[-1])

    bad = 0
    with ThreadPoolExecutor(max_workers=a.jobs) as ex:
        for pid, n, v in ex.map(one, zip(ps, rep)):
            ok = v.get('verdict') == 'mate'
            bad += not ok
            print(('OK  ' if ok else 'FAIL'), pid, f'N={n}', v.get('verdict'), v.get('seconds'), v.get('error') or '', flush=True)
    print(f'{len(ps) - bad}/{len(ps)} re-proven')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
