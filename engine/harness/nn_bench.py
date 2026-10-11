"""Step 5 node-cost gate: per-node time of eval presets through `examples/bench.rs`.

    nn_bench.py <depth> <rounds> <eval>[,<eval>...]

Runs the bench over `harness/positions_midgame.txt` for each eval in turn, `rounds`
times, INTERLEAVED (a, b, a, b, ...) so drift on the VM hits every eval alike, and
prints each TOTAL line plus a per-eval median us/node and its ratio to the first
eval. Meant for a dedicated VM with WORKERS=1 (one bench at a time, nothing else
competing for the cores). The shard offset ($SIGIL_SHARD_OFF) is ignored.
"""
import os
import re
import statistics
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)


def main():
    depth, rounds, evals = sys.argv[1], int(sys.argv[2]), sys.argv[3].split(',')
    subprocess.run(['cargo', 'build', '--release', '--no-default-features', '--example', 'bench'],
                   cwd=ENGINE, check=True)
    exe = os.path.join(ENGINE, 'target', 'release', 'examples', 'bench')
    pos = os.path.join(HERE, 'positions_midgame.txt')
    per = {e: [] for e in evals}
    for r in range(rounds):
        for e in evals:
            out = subprocess.run([exe, pos, depth, '--eval', e], capture_output=True, text=True,
                                 check=True).stdout
            tot = [l for l in out.splitlines() if l.startswith('TOTAL')][-1]
            us = float(re.search(r'us/node ([0-9.]+)', tot).group(1))
            per[e].append(us)
            print(f'BENCH round={r} eval={e} {tot}', flush=True)
    base = statistics.median(per[evals[0]])
    for e in evals:
        m = statistics.median(per[e])
        print(f'MEDIAN eval={e} depth={depth} us/node={m:.3f} ratio_vs_{evals[0]}={m / base:.3f} '
              f'runs={per[e]}', flush=True)


if __name__ == '__main__':
    main()
