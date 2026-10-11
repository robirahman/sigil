"""Build a selfplay_v2 spell schedule that equalizes official-spell game counts.

    spell_schedule.py <counts.json> <out.json> --shards <s0,s1,...|a-b,...>
                      [--drop 40] [--target T] [--comp 0.67] [--seed 1]

`counts.json` is count_spell_games.py output. Games holding any spell id in
--drop (default: 40, Rock Slide -- its pile-up rule changed in engine v29) are
removed from the base counts first. Every game draws 3 spells per role, so
each role's counts sum to 3 x games and one target T works for all three
roles: the round plays N = 5T - G games (G = base games), adding T - c_s
games to spell s. T defaults to the smallest value with every deficit <= N
(a spell can appear at most once per game). Draws are built so each game
holds 3 distinct spells per role (column filling of the per-role deficit
list), then games are shuffled and the slot order within a role is
randomized. A share --comp of games is competitive (exact count).

The N games are split over the listed shard numbers (off // 1000 in
selfplay_v2.py, i.e. SHARD_BASE + worker) at ceil(N / shards) games each.
"""
import argparse, json, math, random
from collections import Counter

ROLES = ([0, 1, 2, 3, 4, 15, 18, 21, 24, 27, 30, 33, 36, 39, 44],
         [5, 6, 7, 8, 9, 16, 19, 22, 25, 28, 31, 34, 37, 40, 43],
         [10, 11, 12, 13, 14, 17, 20, 23, 26, 29, 32, 35, 38, 41, 42])


def parse_shards(spec):
    out = []
    for part in spec.split(','):
        if '-' in part:
            a, b = part.split('-')
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out


def base_counts(counts, drop):
    c = Counter()
    games = 0
    for _g, _k, _n, spells in counts['per_game']:
        if drop & set(spells):
            continue
        games += 1
        for s in spells:
            c[s] += 1
    return c, games


def plan(c, games, target=None):
    """(T, N, deficits) with every role summing to 3N."""
    for r in ROLES:
        assert sum(c[s] for s in r) == 3 * games, 'role sums must be 3 x games'
    T = target or max(c[s] for r in ROLES for s in r)
    while True:
        N = 5 * T - games
        d = {s: T - c[s] for r in ROLES for s in r}
        if N > 0 and max(d.values()) <= N and min(d.values()) >= 0:
            return T, N, d
        T += 1


def build(d, N, comp_share, seed):
    rng = random.Random(seed)
    games = [[] for _ in range(N)]
    for r in ROLES:
        col = [s for s in r for _ in range(d[s])]
        assert len(col) == 3 * N
        for j in range(N):
            trio = [col[j], col[j + N], col[j + 2 * N]]
            assert len(set(trio)) == 3
            rng.shuffle(trio)
            games[j] += trio
    rng.shuffle(games)
    n_comp = round(comp_share * N)
    comp = [1] * n_comp + [0] * (N - n_comp)
    rng.shuffle(comp)
    return games, comp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('counts'); ap.add_argument('out')
    ap.add_argument('--shards', required=True)
    ap.add_argument('--drop', default='40')
    ap.add_argument('--target', type=int, default=None)
    ap.add_argument('--comp', type=float, default=0.67)
    ap.add_argument('--seed', type=int, default=1)
    a = ap.parse_args()
    counts = json.load(open(a.counts))
    drop = {int(x) for x in a.drop.split(',') if x}
    c, games = base_counts(counts, drop)
    T, N, d = plan(c, games, a.target)
    draws, comp = build(d, N, a.comp, a.seed)
    shards = parse_shards(a.shards)
    per = math.ceil(N / len(shards))
    final = Counter(c)
    for g in draws:
        final.update(g)
    assert len(set(final[s] for r in ROLES for s in r)) == 1
    json.dump({'games_per_shard': per, 'shards': shards, 'draws': draws, 'comp': comp,
               'target': T, 'base_games': games, 'dropped_spells': sorted(drop),
               'base_counts': {str(s): c[s] for r in ROLES for s in r},
               'added': {str(s): d[s] for r in ROLES for s in r}}, open(a.out, 'w'))
    print(f'base games {games}, target {T} games per spell, new games {N} '
          f'({sum(comp)} competitive) over {len(shards)} shards x {per}')


if __name__ == '__main__':
    main()
