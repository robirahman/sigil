#!/usr/bin/env python3
"""Pool fleet shard logs into ONE verdict.

    pool_shards.py <log-glob> [--expect-config SUBSTR]

Three rules this enforces, each learned the hard way:

1. **Pool from `GAME` lines, never `SHARD` summaries.** A shard the watchdog
   killed writes no summary, so summarising the summaries silently drops the
   slow shards -- a selection effect biased toward fast games, which are the
   short decisive ones.

2. **Never read a per-shard SPRT verdict as the result.** 88 shards each
   running their own sequential test at alpha=0.05 produce false H1s at a rate
   nobody wants to defend; 264 such tests gave ~13. The fleet is one
   experiment, so it gets one interval.

3. **Refuse to pool across different `ENGINE CONFIG` lines.** Two arms in one
   glob look exactly like more data.

Reports a Wilson interval on the arm's win rate and the Elo it implies. Sigil
is draw-free, so the Bernoulli treatment is exact rather than an approximation.
"""
import argparse
import collections
import glob
import math
import re
import sys

GAME = re.compile(r'^GAME seed=(\d+) arm=(\w+) winner=(\S+) plies=(\d+)')
TIMES = re.compile(r'arm_s=([0-9.]+) base_s=([0-9.]+)')
CONFIG = re.compile(r'ENGINE CONFIG\s+(.*)$')


def wilson(k, n, z=1.96):
    """Wilson score interval: correct at the extremes, unlike normal-approx."""
    if n == 0:
        return 0.0, 0.0, 0.0
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, max(0.0, c - h), min(1.0, c + h)


def elo(p):
    if p <= 0:
        return float('-inf')
    if p >= 1:
        return float('inf')
    return -400.0 * math.log10(1.0 / p - 1.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('logs')
    ap.add_argument('--expect-config', default=None,
                    help='substring every ENGINE CONFIG line must contain')
    ap.add_argument('--max-time-ratio', type=float, default=None,
                    help='refuse a verdict if the arm used more than this multiple of the '
                         'base arm\'s mean seconds per move (elastic arms: gate at MATCHED '
                         'average time; GAME lines must carry arm_s=/base_s=)')
    args = ap.parse_args()

    files = sorted(glob.glob(args.logs))
    if not files:
        sys.exit(f'no logs matched {args.logs}')

    configs = collections.Counter()
    wins = losses = unfinished = 0
    per_shard = collections.Counter()
    plies = []
    arm_secs, base_secs = [], []
    seeds = collections.Counter()
    for path in files:
        with open(path, encoding='utf-8', errors='replace') as fh:
            for ln in fh:
                m = CONFIG.search(ln)
                if m:
                    configs[m.group(1).strip()] += 1
                    continue
                g = GAME.match(ln)
                if not g:
                    continue
                _seed, arm, winner, n = g.groups()
                seeds[int(_seed)] += 1
                plies.append(int(n))
                t = TIMES.search(ln)
                if t:
                    arm_secs.append(float(t.group(1))); base_secs.append(float(t.group(2)))
                per_shard[path] += 1
                if winner in ('None', 'none', ''):
                    unfinished += 1
                elif winner == arm:
                    wins += 1
                else:
                    losses += 1

    print(f'shard logs: {len(files)};  with games: {len(per_shard)}')
    if len(configs) != 1:
        print(f'\nREFUSING TO POOL: {len(configs)} distinct ENGINE CONFIG lines')
        for c, k in configs.most_common():
            print(f'  {k:4d}x  {c}')
        sys.exit(2)
    cfg = next(iter(configs))
    print(f'config: {cfg}')
    if args.expect_config and args.expect_config not in cfg:
        sys.exit(f'\nCONFIG MISMATCH: expected {args.expect_config!r}')

    n = wins + losses
    print(f'\ngames: {n + unfinished}  decided: {n}  unfinished: {unfinished}')
    # Replayed seeds are the tell for a shard-offset collision, which halves
    # the real sample while the count keeps rising.
    dup = sum(v - 2 for v in seeds.values() if v > 2)
    print(f'distinct seeds: {len(seeds)}  games beyond the 2 colour swaps: {dup}'
          + ('   <-- SHARD OFFSETS COLLIDED' if dup else ''))
    if plies:
        print(f'mean plies: {sum(plies) / len(plies):.1f}')
    if arm_secs and base_secs:
        ma = sum(arm_secs) / len(arm_secs); mb = sum(base_secs) / len(base_secs)
        ratio = ma / mb if mb > 0 else float('inf')
        print(f'mean s/move: arm {ma:.3f}  base {mb:.3f}  ratio {ratio:.3f}')
        if args.max_time_ratio is not None and ratio > args.max_time_ratio:
            sys.exit(f'\nREFUSING A VERDICT: the arm used {ratio:.3f}x the base arm\'s time '
                     f'(limit {args.max_time_ratio}); re-run with the arm\'s base budget '
                     f'scaled by 1/{ratio:.3f} so average time matches')
    elif args.max_time_ratio is not None:
        sys.exit('\n--max-time-ratio given but the GAME lines carry no arm_s=/base_s= times')
    if n == 0:
        sys.exit('no decided games')

    p, lo, hi = wilson(wins, n)
    print(f'\narm {wins}  base {losses}   win rate {100 * p:.2f}%  '
          f'[{100 * lo:.2f}, {100 * hi:.2f}]')
    print(f'Elo {elo(p):+.1f}  [{elo(lo):+.1f}, {elo(hi):+.1f}]')
    if lo > 0.5:
        print('=> the interval excludes parity: the arm is BETTER')
    elif hi < 0.5:
        print('=> the interval excludes parity: the arm is WORSE')
    else:
        print('=> the interval spans parity: NO measured difference')
        need = math.ceil(p * (1 - p) * (1.96 / 0.005) ** 2)
        print(f'   (~{need:,} decided games would give a +-0.5% band at this rate)')


if __name__ == '__main__':
    main()
