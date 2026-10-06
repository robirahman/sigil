"""Pool the Step 3 fleet's selfplay_v2 chunks into one bucket prefix + a manifest.

    pool_s3.py <dest gs:// prefix> <run-id> [<run-id> ...]

Server-side copies every `runs/<id>/data/v2d*_*.npz` to `<dest>/d<depth>/`, and
writes `<dest>/manifest.json`: per run, per shard, the chunk files present and
the position count from the shard's last progress line (`WROTE` when the shard
finished, else the last checkpoint line -- a Spot preemption leaves no WROTE).
Counts come from logs, not from opening 20M positions' worth of npz.
"""
import json, re, subprocess, sys, tempfile, os
B = 'gs://focus-surfer-494820-g0-sigil'


def sh(*a, check=True):
    r = subprocess.run(list(a), capture_output=True, text=True)
    if check and r.returncode:
        raise SystemExit(f"{' '.join(a)}: {r.stderr[-500:]}")
    return r.stdout


def main():
    dest = sys.argv[1].rstrip('/'); runs = sys.argv[2:]
    man = {'runs': {}, 'positions': {}, 'chunks': {}}
    for run in runs:
        names = sh('gcloud', 'storage', 'ls', f'{B}/runs/{run}/data/', check=False).split()
        chunks = [n for n in names if re.search(r'/v2d\d+_\d+_\d{4}\.npz$', n)]
        logs = [n for n in sh('gcloud', 'storage', 'ls', f'{B}/runs/{run}/live/', check=False).split()
                if re.search(r'/arm\d+_.*_w\d+\.log$', n)]
        shards = {}
        with tempfile.TemporaryDirectory() as d:
            if logs:
                sh('gcloud', 'storage', 'cp', *logs, d + '/', check=False)
            for f in sorted(os.listdir(d)):
                txt = open(os.path.join(d, f)).read()
                off = re.search(r'"shard_off": (\d+)', txt)
                dep = re.search(r'"depth": (\d+)', txt)
                if not off or not dep:
                    continue
                w = re.findall(r'WROTE \S+: (\d+) positions', txt)
                p = re.findall(r'game \d+: (\d+) positions', txt)
                shards[off.group(1)] = dict(depth=int(dep.group(1)), finished=bool(w),
                                            positions=int(w[-1]) if w else (int(p[-1]) if p else 0))
        nchunk = {}
        for c in chunks:
            m = re.search(r'/v2d(\d+)_(\d+)_\d{4}\.npz$', c)
            nchunk.setdefault(m.group(2), 0); nchunk[m.group(2)] += 1
            man['chunks'].setdefault(m.group(1), 0); man['chunks'][m.group(1)] += 1
        for off, s in shards.items():
            s['chunks'] = nchunk.get(off, 0)
            man['positions'].setdefault(str(s['depth']), 0)
            man['positions'][str(s['depth'])] += s['positions']
        man['runs'][run] = dict(shards=shards, n_chunks=len(chunks),
                                complete=bool(sh('gcloud', 'storage', 'ls', f'{B}/runs/{run}/COMPLETE', check=False).strip()))
        by_depth = {}
        for c in chunks:
            by_depth.setdefault(re.search(r'/v2d(\d+)_', c).group(1), []).append(c)
        for dep, cs in by_depth.items():
            for i in range(0, len(cs), 500):
                sh('gcloud', 'storage', 'cp', *cs[i:i + 500], f'{dest}/d{dep}/')
        print(f"{run}: {len(chunks)} chunks, {len(shards)} shard logs, "
              f"{sum(s['positions'] for s in shards.values())} positions", flush=True)
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump(man, f, indent=1); tmp = f.name
    sh('gcloud', 'storage', 'cp', tmp, f'{dest}/manifest.json')
    print(f"TOTAL positions by depth {man['positions']}, chunks {man['chunks']}")


if __name__ == '__main__':
    main()
