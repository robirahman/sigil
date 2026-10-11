"""Multi-thread scaling on a VM: `examples/bench.rs` for several thread counts.

    smp_bench.py <depth> <threads.threads...> [mode=0] [ms=0]

For each thread count (dot-separated, e.g. 1.2.4.8) runs the bench over
harness/positions_midgame.txt with `--mode` (0 = Lazy SMP, 1 = parallel root) and,
when `ms` > 0, a per-position time budget. Clockless (`ms` 0): `ms` in the TOTAL line
is the time to depth, so the speedup is the 1-thread ms over the N-thread ms, and
the 1-thread HASH must equal the pre-SMP engine's (the tree-identity gate). Timed:
`mean_depth` is the completed depth within the budget. `knps` is all threads' nodes
per millisecond. Runs on the cloud runner, which has cargo on PATH; the shard offset
is ignored.
"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)

if __name__ == '__main__':
    depth = sys.argv[1]
    counts = [int(x) for x in sys.argv[2].split('.') if x]
    mode = sys.argv[3] if len(sys.argv) > 3 else '0'
    ms = sys.argv[4] if len(sys.argv) > 4 else '0'
    pos = os.path.join(HERE, 'positions_midgame.txt')
    subprocess.run(['cargo', 'build', '--release', '--no-default-features', '--example', 'bench'],
                   cwd=ENGINE, check=True, stdout=subprocess.DEVNULL)
    exe = os.path.join(ENGINE, 'target', 'release', 'examples', 'bench')
    print(f'cpus {os.cpu_count()} depth {depth} mode {mode} ms {ms}', flush=True)
    for n in counts:
        cmd = [exe, pos, depth, '--threads', str(n), '--mode', mode]
        if ms != '0':
            cmd += ['--ms', ms]
        out = subprocess.run(cmd, cwd=ENGINE, check=True, capture_output=True,
                             text=True).stdout.splitlines()
        for line in out[-2:]:
            print(f'mode={mode} threads={n} {line}', flush=True)
    print('SHARD smp_bench done', flush=True)
