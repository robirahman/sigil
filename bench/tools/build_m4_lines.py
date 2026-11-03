#!/usr/bin/env python3
"""Build bench/dev/dev_set_v2_lines.json: a full solution line for each
mate-in-4 puzzle of dev set v2, for "Show solution" in the Try panel's bench
mode (docs/puzzles.html?bench=<id>), which walks the line turn by turn.

Dev set v2's mate-in-4 puzzles were mined and never published, so unlike the
mate-in-1..3 puzzles (which the page takes from the Puzzles set) they had no
stored defences: only the first turn. For each one this runs
engine/examples/mate4_lines (mate::mate4_line_json) from its first solution
key: the hardest reply found as the defence, then the solver's mate-in-<=3
line against it, nested like a mate-in-3 line one level deeper.

    cargo build --release --no-default-features --example mate4_lines
    python3 bench/tools/build_m4_lines.py --bin <target>/release/examples/mate4_lines [--jobs 4]

Then check the lines against the browser rules and rebuild the Try payload:

    node tools/puzzle-smoke.js <the --smoke file this writes> --replay
    SIGILBENCH_TRY_PASSWORD=... python3 bench/tools/build_try_devset.py

The lines are display aids, not part of grading: the grader proves answers
itself and never reads this file.
"""
import argparse
import concurrent.futures as cf
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import BENCH, CANARY, load_json  # noqa: E402

DEV_SET = os.path.join(BENCH, 'dev', 'dev_set_v2.json')
OUT = os.path.join(BENCH, 'dev', 'dev_set_v2_lines.json')


def after_sfn(sfn, key):
    """The SFN after the mover's turn that reaches `key` (a puzzleSfnKey:
    stones, counters, locks, banks [, pm:r:b])."""
    t, k = sfn.split(), key.split()
    side = 'b' if t[1] == 'r' else 'r'
    rest = [x for x in t[6:] if not x.startswith('pm:')] + [x for x in k[4:] if x.startswith('pm:')]
    return ' '.join([k[0] + '/' + t[0].split('/')[1], side, str(int(t[2]) + 1)] + k[1:4] + rest)


def depth(line):
    """Mover turns in the line (following the first continuation)."""
    n, node = 0, line
    while node:
        n += 1
        if node.get('continuations'):
            node = node['continuations'][0]
        elif node.get('finish') and node.get('defence'):
            n += 1
            node = None
        else:
            node = None
    return n


def run_one(binary, p, budget, time_ms, probe):
    last = None
    for key in p['solution_keys']:
        req = '\t'.join([str(budget), str(time_ms), str(probe), p['sfn'], after_sfn(p['sfn'], key)]) + '\n'
        out = subprocess.run([binary], input=req, capture_output=True, text=True, check=True).stdout
        last = json.loads(out)
        if last.get('ok'):
            return p['id'], last
    return p['id'], last


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--bin', required=True, help='engine/examples/mate4_lines binary')
    ap.add_argument('--dev-set', default=DEV_SET)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--smoke', default=None, help='also write a puzzles file for tools/puzzle-smoke.js --replay')
    ap.add_argument('--jobs', type=int, default=4)
    ap.add_argument('--budget', type=int, default=8_000_000_000)
    ap.add_argument('--time-ms', type=int, default=180_000, help='per mate-in-3 solve after a candidate defence')
    ap.add_argument('--probe', type=int, default=48, help='replies classified when choosing the defence')
    a = ap.parse_args()
    dev = load_json(a.dev_set)
    todo = [p for p in dev['puzzles'] if p['n'] == 4]
    lines, failed = {}, {}
    with cf.ThreadPoolExecutor(a.jobs) as ex:
        futs = [ex.submit(run_one, a.bin, p, a.budget, a.time_ms, a.probe) for p in todo]
        for f in cf.as_completed(futs):
            pid, r = f.result()
            if r and r.get('ok'):
                r.pop('ok', None)
                r.pop('seconds', None)
                lines[pid] = r
                print(f"{pid}: line of {depth(r)} mover turns (defence needs {r.get('defence_needs')})", flush=True)
            else:
                failed[pid] = (r or {}).get('error')
                print(f'{pid}: FAILED {failed[pid]}', flush=True)
    doc = {
        'canary': CANARY,
        'description': 'Solution lines for dev set v2 mate-in-4 puzzles (display only; see bench/tools/build_m4_lines.py).',
        'dev_set': os.path.basename(a.dev_set),
        'lines': {k: lines[k] for k in sorted(lines)},
        'failed': failed,
    }
    with open(a.out, 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    print(f'wrote {a.out}: {len(lines)} lines, {len(failed)} failed')
    if a.smoke:
        by = {p['id']: p for p in todo}
        ps = [{'id': k, 'kind': 'mate', 'mate': 4, 'mover': by[k]['mover'], 'sfn': by[k]['sfn'],
               'variant': by[k].get('variant'), 'solution_keys': by[k]['solution_keys'], 'solutions': [v]}
              for k, v in sorted(lines.items())]
        with open(a.smoke, 'w') as f:
            json.dump({'puzzles': ps}, f)
        print(f'wrote {a.smoke}')


if __name__ == '__main__':
    main()
