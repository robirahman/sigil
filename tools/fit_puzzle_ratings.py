#!/usr/bin/env python3
"""Puzzle ratings from the AI tiers' attempts (engine/harness/puzzle_attempts.py).

    fit_puzzle_ratings.py --tiers tiers.json --puzzles docs/static/puzzles/mate_puzzles.json \\
        [--out docs/static/puzzles/mate_puzzles.json] [--seed-firebase SA.json [--apply]] attempts*.log

Each attempt is a game between the tier and the puzzle: the puzzle wins when the
tier fails to solve it. A puzzle's rating is its maximum a posteriori Elo against
the tiers it met (P(tier solves) = 1 / (1 + 10^((R_puzzle - R_tier) / 400))) under
a normal prior centred on the tiers' mean rating with PRIOR_SD: four results
cannot place a puzzle every tier solves (or none does) on their own, and the
prior keeps those finite, below the weakest tier (or above the strongest).

Writes `rating` (integer) and `ai` (the tiers that solved it) into each puzzle.
With --seed-firebase, sets puzzle_ratings/<id> = {rating, plays: 0} for every
puzzle that has none yet (the rules let clients update a puzzle's rating but
never create one); dry run unless --apply.
"""
import argparse, json, math, re, sys

PRIOR_SD = 350.0
ATTEMPT = re.compile(r'^ATTEMPT (\{.*\})\s*$')
DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'


def read_attempts(paths):
    out = {}
    for path in paths:
        with open(path, encoding='utf-8', errors='replace') as fh:
            for line in fh:
                m = ATTEMPT.match(line)
                if not m:
                    continue
                rec = json.loads(m.group(1))
                if 'solved' not in rec:
                    continue          # an attempt that errored is no evidence either way
                out[(rec['id'], rec['tier'])] = bool(rec['solved'])
    return out


def map_rating(results, prior_mean):
    """results: [(tier_rating, solved)]. Maximises the log posterior on a 1-Elo grid."""
    best, best_lp = prior_mean, -1e18
    lo, hi = int(prior_mean - 2000), int(prior_mean + 2000)
    for r in range(lo, hi + 1):
        lp = -((r - prior_mean) ** 2) / (2 * PRIOR_SD ** 2)
        for rt, solved in results:
            p_solve = 1 / (1 + 10 ** ((r - rt) / 400))
            lp += math.log(p_solve if solved else 1 - p_solve)
        if lp > best_lp:
            best, best_lp = r, lp
    return best


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('logs', nargs='+')
    ap.add_argument('--tiers', required=True, help='fit_tier_ratings.py --out JSON (or {"ratings": {tier: elo}})')
    ap.add_argument('--puzzles', required=True)
    ap.add_argument('--out', default=None)
    ap.add_argument('--seed-firebase', default=None, help='service-account JSON')
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()
    with open(args.tiers, encoding='utf-8') as fh:
        tiers = json.load(fh)['ratings']
    with open(args.puzzles, encoding='utf-8') as fh:
        data = json.load(fh)
    att = read_attempts(args.logs)
    prior = sum(tiers.values()) / len(tiers)
    missing = 0
    for p in data['puzzles']:
        res = [(tiers[t], att[(p['id'], t)]) for t in tiers if (p['id'], t) in att]
        if len(res) < len(tiers):
            missing += 1
        p['rating'] = map_rating(res, prior)
        p['ai'] = sorted(t for t in tiers if att.get((p['id'], t)))
    data['rating'] = {'method': 'MAP Elo vs the AI tiers, normal prior mean %.0f sd %.0f' % (prior, PRIOR_SD),
                      'tiers': tiers}
    rs = sorted(p['rating'] for p in data['puzzles'])
    n = len(rs)
    print(f'{n} puzzles, {missing} with fewer than {len(tiers)} attempts; tiers {tiers}')
    print('rating quantiles:', [rs[int(q * (n - 1))] for q in (0, 0.1, 0.25, 0.5, 0.75, 0.9, 1)])
    for t in tiers:
        k = sum(1 for p in data['puzzles'] if t in p['ai'])
        print(f'  {t:10s} solved {k}/{n}')
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as fh:
            json.dump(data, fh, separators=(',', ':'))
        print('wrote', args.out)
    if args.seed_firebase:
        import requests
        sys.path.insert(0, __import__('os').path.join(__import__('os').path.dirname(__file__), '..', 'engine', 'harness'))
        from upload_arena_games import db_token
        tok = db_token(args.seed_firebase)
        have = requests.get(DB_URL + '/puzzle_ratings.json', params={'access_token': tok, 'shallow': 'true'},
                            timeout=120).json() or {}
        new = {p['id']: {'rating': p['rating'], 'plays': 0} for p in data['puzzles'] if p['id'] not in have}
        print(f'puzzle_ratings: {len(have)} present, {len(new)} to seed' + ('' if args.apply else ' (dry run)'))
        if args.apply and new:
            r = requests.patch(DB_URL + '/puzzle_ratings.json', params={'access_token': tok},
                               data=json.dumps(new), timeout=300)
            r.raise_for_status()
            print('seeded', len(new))


if __name__ == '__main__':
    main()
