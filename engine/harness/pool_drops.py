#!/usr/bin/env python3
"""Pool CHECK A shard logs into one flag population.

    pool_drops.py <log-glob> [--out flags.json]

`pool_shards.py` pools SPRT GAME lines; this pools `FLAG {json}` lines, and
enforces the same three rules for the same reasons:

1. **Pool from FLAG lines, never per-shard summaries.** A watchdog-killed
   shard writes no summary, so summarising summaries drops the slow shards --
   and slow shards are the ones with the most positions, i.e. the long games.
2. **One experiment, one number.** 264 shards each printing their own
   "CHECK A eval-drop flags: N" is not 264 results.
3. **Refuse to pool across different arm strings.** Two configurations in one
   glob look exactly like more data. Each log's own filename carries the arm,
   and the header line carries depths and the per-ply limit.

It also reports what the mate guard did, because the mate-flip count is NOT
comparable across that fix: `mateFlip` tests `score1 <= -MATE` (1e6), and a
mate the search cannot prove is now reported as UNPROVEN_MATE (5,000), so the
same flag stops being labelled one. `dropPerPly` is unaffected -- the gradual
metric clamps at +-20 stones and both values saturate there -- so the drop
distribution is the thing to compare across runs, never the label.
"""
import argparse
import collections
import glob
import json
import re
import sys

UNPROVEN = 5_000
MATE = 1_000_000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('logs')
    ap.add_argument('--out', default=None)
    ap.add_argument('--per-ply-limit', type=float, default=0.5)
    args = ap.parse_args()

    paths = sorted(glob.glob(args.logs))
    if not paths:
        sys.exit(f"no logs matched {args.logs}")

    flags, headers, done, empty = [], set(), 0, 0
    for p in paths:
        got = 0
        with open(p, encoding='utf-8', errors='replace') as fh:
            for ln in fh:
                if ln.startswith('FLAG '):
                    try:
                        flags.append(json.loads(ln[5:]))
                        got += 1
                    except Exception:
                        pass
                elif ln.startswith('auditing '):
                    # Compare CONFIGURATION, not provenance. Self-play shards
                    # print their own seed range -- deliberately, so a log says
                    # which games it audited -- and that made this guard see 64
                    # distinct "arms" in one run and refuse to pool a perfectly
                    # homogeneous fleet. A seed range is not a configuration;
                    # depths, windows, the per-ply limit and the move time are.
                    h = re.sub(r'\(seeds [^)]*\)', '', ln).strip()
                    headers.add(h.split(' from ')[-1].strip()
                                if ' from ' in h else h)
                elif 'CHECK A eval-drop flags:' in ln:
                    done += 1
        if not got:
            empty += 1

    print(f"shard logs: {len(paths)}   finished: {done}   with no flags: {empty}")
    if done != len(paths):
        print(f"  !! {len(paths) - done} shards did not finish. Their positions "
              f"are MISSING, not zero;\n     the audit is over fewer games than "
              f"it looks. Do not read a rate off this.")
    if len(headers) > 1:
        print(f"  !! {len(headers)} distinct arm headers in one glob -- refusing "
              f"to pool:")
        for h in sorted(headers):
            print(f"     {h}")
        sys.exit(1)

    # A window is identified by (game, ply, depth, window); the same flag can
    # appear once per shard only, but dedupe anyway so a re-run overlapping an
    # old log cannot double-count.
    uniq, seen = [], set()
    for f in flags:
        k = (f.get('game'), f.get('ply'), f.get('depth'), f.get('window'))
        if k in seen:
            continue
        seen.add(k)
        uniq.append(f)
    print(f"\nFLAGS: {len(flags)} raw, {len(uniq)} distinct windows")

    proven = [f for f in uniq if f['score1'] <= -MATE]
    unproven = [f for f in uniq if abs(f['score1']) == UNPROVEN]
    gradual = [f for f in uniq if f not in proven and f not in unproven]
    print(f"  the mover is announced LOST, provably (score1 <= -1e6):  {len(proven)}")
    print(f"  the mover is announced lost, NOT provably (+-{UNPROVEN}):  "
          f"{len(unproven)}")
    print(f"    <- before the mate-guard fix these counted as MATE FLIPS. Same\n"
          f"       positions, same dropPerPly; the engine no longer claims proof.")
    print(f"  gradual drops only:                                      {len(gradual)}")

    by = collections.Counter((f['depth'], f['window']) for f in uniq)
    print("\nby (depth, window):")
    for k in sorted(by):
        print(f"  depth {k[0]} window {k[1]}: {by[k]}")

    print("\ndropPerPly distribution (the envelope is 0.5/half-move):")
    band = collections.Counter()
    for f in uniq:
        d = f.get('dropPerPly', 0)
        band['0.5-1.0' if d < 1 else '1.0-2.0' if d < 2 else
             '2.0-5.0' if d < 5 else '5.0+'] += 1
    for k in ('0.5-1.0', '1.0-2.0', '2.0-5.0', '5.0+'):
        print(f"  {k:>8s}: {band[k]}")
    print("\n  A drop of up to 0.5 stones/half-move is the HORIZON ENVELOPE and")
    print("  expected. Anything faster needs an explanation: run")
    print("  attribute_drops.py on the pooled flags to bucket them.")

    games = len({f.get('game') for f in uniq})
    print(f"\ndistinct games contributing a flag: {games}")
    worst = sorted(uniq, key=lambda f: -f.get('dropPerPly', 0))[:10]
    print("worst:")
    for f in worst:
        print(f"  d{f['depth']}w{f['window']} ply {f['ply']:3d} {f['mover']:>4s} "
              f"{f['clampedFrom']:+7.2f} -> {f['clampedTo']:+7.2f} "
              f"{f['dropPerPly']:+7.2f}/ply  {f.get('game')}")

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as fh:
            json.dump(uniq, fh)
        print(f"\nwrote {len(uniq)} flags -> {args.out}")


if __name__ == '__main__':
    main()
