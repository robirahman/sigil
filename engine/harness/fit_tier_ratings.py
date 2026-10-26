#!/usr/bin/env python3
"""Maximum-likelihood Elo of the AI tiers from a tier round robin.

    fit_tier_ratings.py --pin hard=1600 arm*.log [...]
    fit_tier_ratings.py --keep-sum easy=1417,medium=1468,hard=1608,very_hard=1733 arm*.log
    fit_tier_ratings.py --fixed easy=1253,medium=1379 --only very_easy arm*.log

Reads the `GAME seed=.. red=<tier> blue=<tier> winner=<red|blue|None> ...` lines
tier_roundrobin.py prints (draws and unfinished games are skipped) and fits
Bradley-Terry on the Elo scale (P(a beats b) = 1 / (1 + 10^((Rb - Ra) / 400)))
with the pinned tier held fixed (--pin), or shifted as a whole so the tiers'
ratings sum to what they summed to before (--keep-sum: the round robin
redistributes points among the tiers without adding or removing any), or with
some tiers held at given ratings and only the --only tiers fitted (--fixed: a
new player rated by its games against established ones). Prints the ratings, a rough standard error per
tier (inverse Fisher information) and each tier's W-L, and writes them as JSON
with --out. Used for the 2026-09, 2026-10 and 2026-10-22 re-anchorings.
"""
import argparse, json, math, re, sys
from collections import defaultdict

GAME = re.compile(r'^GAME seed=(\d+) red=(\w+) blue=(\w+) winner=(\w+)')


def read_games(paths):
    games, seen = [], set()
    for path in paths:
        with open(path, encoding='utf-8', errors='replace') as fh:
            for line in fh:
                m = GAME.match(line)
                if not m:
                    continue
                seed, red, blue, winner = m.groups()
                if winner not in ('red', 'blue'):
                    continue
                key = (seed, red, blue)
                if key in seen:
                    continue
                seen.add(key)
                win, lose = (red, blue) if winner == 'red' else (blue, red)
                games.append((win, lose))
    return games


def fit(games, pin_tier, pin_rating, iters=20000, fixed=None):
    tiers = sorted({t for g in games for t in g})
    fixed = dict(fixed or {})
    if pin_tier:
        fixed[pin_tier] = pin_rating
    start = sum(fixed.values()) / len(fixed)
    r = {t: fixed.get(t, start) for t in tiers}
    q = math.log(10) / 400
    for _ in range(iters):
        grad = defaultdict(float)
        for w, l in games:
            p = 1 / (1 + 10 ** ((r[l] - r[w]) / 400))
            grad[w] += q * (1 - p)
            grad[l] -= q * (1 - p)
        step = 0.0
        for t in tiers:
            if t in fixed:
                continue
            d = 400 * grad[t]
            r[t] += d
            step = max(step, abs(d))
        if step < 1e-6:
            break
    se = {}
    for t in tiers:
        info = 0.0
        for w, l in games:
            if t in (w, l):
                p = 1 / (1 + 10 ** ((r[l] - r[w]) / 400))
                info += q * q * p * (1 - p)
        se[t] = None if t in fixed or info == 0 else 1 / math.sqrt(info)
    return r, se


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('logs', nargs='+')
    ap.add_argument('--pin', default=None, help='tier=rating held fixed, e.g. hard=1600')
    ap.add_argument('--keep-sum', default=None, help='tier=rating,... before the round robin: shift the fit to the same sum')
    ap.add_argument('--fixed', default=None, help='tier=rating,... held fixed; fit only the others (or --only)')
    ap.add_argument('--only', default=None, help='with --fixed: comma-separated tiers whose games are used and fitted')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    games = read_games(args.logs)
    parse = lambda spec: {k: float(v) for k, v in (x.split('=') for x in spec.split(','))}
    meta = {}
    if args.fixed:
        fixed = parse(args.fixed)
        if args.only:
            only = set(args.only.split(','))
            games = [g for g in games if only & set(g) and set(g) <= only | set(fixed)]
        r, se = fit(games, None, None, fixed=fixed)
        meta['fixed'] = fixed
    elif args.keep_sum:
        before = parse(args.keep_sum)
        games = [g for g in games if set(g) <= set(before)]
        t0 = sorted(before)[0]
        r, se = fit(games, t0, before[t0])
        shift = (sum(before.values()) - sum(r[t] for t in before)) / len(before)
        r = {t: v + shift for t, v in r.items()}
        meta['keep_sum'] = {'before': before, 'sum': sum(before.values()), 'shift': shift}
    else:
        pin_tier, pin_rating = args.pin.split('=')
        r, se = fit(games, pin_tier, float(pin_rating))
        meta['pin'] = {pin_tier: float(pin_rating)}
    if not games:
        sys.exit('no GAME lines')
    wl = defaultdict(lambda: [0, 0])
    for w, l in games:
        wl[w][0] += 1
        wl[l][1] += 1
    print(f'{len(games)} decisive games')
    for t in sorted(r, key=lambda t: -r[t]):
        s = '' if se[t] is None else f' (+-{se[t]:.0f})'
        print(f'  {t:10s} {r[t]:7.0f}{s}   {wl[t][0]}-{wl[t][1]}')
    # Integer ratings; with --keep-sum, rounded by largest remainder so the
    # integers keep the exact sum too.
    rounded = {t: round(v) for t, v in r.items()}
    if args.keep_sum:
        target = round(sum(before.values()))
        fl = {t: math.floor(r[t]) for t in before}
        for t in sorted(before, key=lambda t: -(r[t] - fl[t]))[:target - sum(fl.values())]:
            fl[t] += 1
        rounded.update(fl)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as fh:
            json.dump({'games': len(games), **meta,
                       'ratings': rounded,
                       'se': {t: (None if v is None else round(v)) for t, v in se.items()},
                       'wl': {t: v for t, v in wl.items()}}, fh, indent=1)


if __name__ == '__main__':
    main()
