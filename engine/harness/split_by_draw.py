"""Split an eval A/B's pooled games by spell draw.

    split_by_draw.py <log-glob> [--min-games 150]

Reads `GAME seed=.. arm=<colour> winner=<colour>` lines (pool_shards.py's rule:
games, never shard summaries), recomputes each game's draw with
`Board.legal_draw(seed)` (no SIGIL_REQUIRE_SPELL runs only), and reports the arm's
score with a Wilson interval
  * overall,
  * per spell, for spells in at least --min-games games (a per-spell eval can only
    act where its weights are large, so this is where a gain or loss should sit).
"""
import glob, math, re, sys
import sigil_engine as se

RE = re.compile(r'^GAME seed=(\d+) arm=(red|blue) winner=(red|blue|None)')


def wilson(w, n, z=1.96):
    if n == 0:
        return float('nan'), float('nan'), float('nan')
    p = w / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, c - h, c + h


def elo(p):
    p = min(max(p, 1e-4), 1 - 1e-4)
    return -400 * math.log10(1 / p - 1)


def line(tag, w, n):
    p, lo, hi = wilson(w, n)
    return f"{tag:28} n={n:5d} score={100*p:5.1f}% [{100*lo:5.1f},{100*hi:5.1f}]  elo={elo(p):+6.0f} [{elo(lo):+5.0f},{elo(hi):+5.0f}]"


if __name__ == '__main__':
    files = sorted(glob.glob(sys.argv[1]))
    mg = int(sys.argv[sys.argv.index('--min-games') + 1]) if '--min-games' in sys.argv else 150
    games = []
    for f in files:
        for l in open(f):
            m = RE.match(l)
            if m and m.group(3) != 'None':
                games.append((int(m.group(1)), m.group(2), m.group(3)))
    names = se.SPELL_NAMES
    draws = {s: se.Board.legal_draw(s) for s in {g[0] for g in games}}
    w = sum(a == b for _, a, b in games)
    print(line('ALL', w, len(games)))
    by = {}
    for s, a, b in games:
        for sp in draws[s]:
            by.setdefault(sp, [0, 0]); by[sp][0] += a == b; by[sp][1] += 1
    for sp in sorted(by, key=lambda k: -by[k][1]):
        if by[sp][1] >= mg:
            print(line(names[sp] if sp < len(names) else str(sp), *by[sp]))
