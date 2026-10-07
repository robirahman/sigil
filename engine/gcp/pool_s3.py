"""Pool the Step 3 fleet's selfplay_v2 chunks into one bucket prefix + a manifest.

    pool_s3.py [--manifest-only] <dest gs:// prefix> <run-id> [<run-id> ...]

Server-side copies every `runs/<id>/data/v2d*_*.npz` to `<dest>/d<depth>/`, and
writes `<dest>/manifest.json`: per run, per shard, the chunk files present and
the position count from the shard's last progress line (`WROTE` when the shard
finished, else the last checkpoint line -- a Spot preemption leaves no WROTE).
Counts come from logs, not from opening 20M positions' worth of npz.
"""
import json, re, subprocess, sys, tempfile, os, time
B = 'gs://focus-surfer-494820-g0-sigil'


def sh(*a, check=True):
    r = subprocess.run(list(a), capture_output=True, text=True)
    if check and r.returncode:
        raise SystemExit(f"{' '.join(a)}: {r.stderr[-500:]}")
    return r.stdout


def main():
    args = sys.argv[1:]
    copy = '--manifest-only' not in args
    args = [a for a in args if a != '--manifest-only']
    dest = args[0].rstrip('/'); runs = args[1:]
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
                # keyed by depth too: two arms of one VM share shard offsets
                # candidates/exploration from the last progress (or WROTE) line;
                # the fresh/competitive/human game split only from WROTE.
                cx = re.findall(r'(\d+) (?:cands|candidates) \((\d+) exploration\)', txt)
                gk = re.findall(r'games fresh/comp/human \[(\d+), (\d+), (\d+)\]', txt)
                shards[f"d{dep.group(1)}_{off.group(1)}"] = dict(depth=int(dep.group(1)), finished=bool(w),
                                            positions=int(w[-1]) if w else (int(p[-1]) if p else 0),
                                            candidates=int(cx[-1][0]) if cx else 0,
                                            exploration=int(cx[-1][1]) if cx else 0,
                                            games=[int(x) for x in gk[-1]] if gk else None)
        nchunk = {}
        for c in chunks:
            m = re.search(r'/v2d(\d+)_(\d+)_\d{4}\.npz$', c)
            k = f"d{m.group(1)}_{m.group(2)}"
            nchunk.setdefault(k, 0); nchunk[k] += 1
            man['chunks'].setdefault(m.group(1), 0); man['chunks'][m.group(1)] += 1
        for off, s in shards.items():
            s['chunks'] = nchunk.get(off, 0)
            man['positions'].setdefault(str(s['depth']), 0)
            man['positions'][str(s['depth'])] += s['positions']
            t = man.setdefault('totals', {}).setdefault(str(s['depth']), dict(
                candidates=0, exploration=0, games_fresh_comp_human=[0, 0, 0],
                shards=0, shards_finished=0))
            t['candidates'] += s['candidates']; t['exploration'] += s['exploration']
            t['shards'] += 1; t['shards_finished'] += s['finished']
            if s['games']:
                t['games_fresh_comp_human'] = [a + b for a, b in zip(t['games_fresh_comp_human'], s['games'])]
        man['runs'][run] = dict(shards=shards, n_chunks=len(chunks),
                                complete=bool(sh('gcloud', 'storage', 'ls', f'{B}/runs/{run}/COMPLETE', check=False).strip()))
        by_depth = {}
        for c in chunks:
            by_depth.setdefault(re.search(r'/v2d(\d+)_', c).group(1), []).append(c)
        for dep, cs in (by_depth.items() if copy else ()):
            for i in range(0, len(cs), 500):
                # --no-clobber makes a re-run resume; retries ride out transient
                # network errors (one pooling pass died on a DNS failure).
                for attempt in range(4):
                    r = subprocess.run(['gcloud', 'storage', 'cp', '--no-clobber', *cs[i:i + 500],
                                        f'{dest}/d{dep}/'], capture_output=True, text=True)
                    if r.returncode == 0:
                        break
                    time.sleep(30)
                else:
                    raise SystemExit(f"copy failed for {run}: {r.stderr[-300:]}")
        print(f"{run}: {len(chunks)} chunks, {len(shards)} shard logs, "
              f"{sum(s['positions'] for s in shards.values())} positions", flush=True)
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump(man, f, indent=1); tmp = f.name
    sh('gcloud', 'storage', 'cp', tmp, f'{dest}/manifest.json')
    print(f"TOTAL positions by depth {man['positions']}, chunks {man['chunks']}")
    print(f"TOTALS {json.dumps(man.get('totals', {}))}")


if __name__ == '__main__':
    main()
