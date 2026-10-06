"""Lazy SMP scaling on a VM: `examples/bench.rs` at fixed depth for several thread counts.

    smp_bench.py <depth> <threads,threads,...> [positions=harness/positions_midgame.txt]

For each thread count, runs the clockless bench and prints its TOTAL and SMP lines:
`ms` is the main thread's time to depth (the Lazy SMP speedup is the 1-thread ms over
the N-thread ms), `knps` is all threads' nodes per millisecond (throughput), and
the 1-thread HASH must equal the pre-SMP engine's (the tree-identity gate).
Runs on the cloud runner, which has cargo on PATH; the shard offset is ignored.
"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)

if __name__ == '__main__':
    depth = sys.argv[1]
    counts = [int(x) for x in sys.argv[2].split('/') if x] if '/' in sys.argv[2] else \
             [int(x) for x in sys.argv[2].split('.') if x]
    pos = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].isdigit() else \
          os.path.join(HERE, 'positions_midgame.txt')
    subprocess.run(['cargo', 'build', '--release', '--no-default-features', '--example', 'bench'],
                   cwd=ENGINE, check=True, stdout=subprocess.DEVNULL)
    exe = os.path.join(ENGINE, 'target', 'release', 'examples', 'bench')
    print(f'cpus {os.cpu_count()} depth {depth} positions {pos}', flush=True)
    for n in counts:
        out = subprocess.run([exe, pos, depth, '--threads', str(n)], cwd=ENGINE, check=True,
                             capture_output=True, text=True).stdout.splitlines()
        for line in out[-2:]:
            print(f'threads={n} {line}', flush=True)
    print('SHARD smp_bench done', flush=True)
