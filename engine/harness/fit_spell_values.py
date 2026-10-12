"""Engine spell charts from spell_value_probe.py output.

    fit_spell_values.py <out.json> <log file or dir>... [--k 0.80] [--boot 200]

Every probe score s (mover POV, centistones) becomes a win probability
p = 1 / (1 + exp(-k s / 100)) (k: the outcome fit of the shipped eval, ~0.8 per
stone; mates saturate at 0 / 1). Per position and side:

  value of spell X to a side = its win probability as played minus its win
  probability with X unusable for it (the counterfactual probe).

  tier value        mean value of X to a side, over every (position, side) whose
                    draw holds X -- how much being able to use X is worth, on
                    average, at a random moment of a game that has it.
  matchup A vs B    over positions whose draw holds both, the value of A to one
                    side minus the value of B to the other (both pairings);
                    > 0: A's holder is favoured.
  synergy A + B     from the pair probes: value of both to one side minus the
                    two single values; > 0: worth more together.

Intervals: 95% bootstrap over GAMES (positions of a game are not independent).
Categories (percentage points of win probability): matchup favoured when the
interval excludes 0 and |m| >= MATCH_MIN, strongly when >= MATCH_STRONG;
synergy +/- when the interval excludes 0 and |s| >= SYN_MIN, ++/-- when
>= SYN_STRONG. Tiers cut the value order into the players' tier sizes scaled
to 45 spells. Output: the docs/static/data/spell-charts.json schema plus values.
"""
import argparse, glob, json, math, os, sys
from collections import defaultdict
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from count_spell_games import NAMES

NS = 45
TIERS = [('S', 'Top', 5), ('A', 'Strong', 12), ('B', 'Solid', 6), ('C', 'Middling', 6),
         ('D', 'Weak', 10), ('F', 'Bottom', None)]
MATCH_MIN, MATCH_STRONG = 1.0, 3.0     # percentage points
SYN_MIN, SYN_STRONG = 0.5, 1.5         # percentage points
NEW_SPELLS = {'Fissure': ('ritual', 'tectonic'), 'Rock_Slide': ('sorcery', 'tectonic'),
              'Bulwark': ('charm', 'tectonic'), 'Endowment': ('ritual', 'providence'),
              'Annuity': ('sorcery', 'providence'), 'Dividend': ('charm', 'providence')}


def read(srcs):
    rows, seen = [], set()
    for s in srcs:
        files = sorted(glob.glob(os.path.join(s, '**', '*.log'), recursive=True)) if os.path.isdir(s) else [s]
        for f in files:
            for line in open(f, errors='replace'):
                if line.startswith('PROBE '):
                    d = json.loads(line[6:])
                    key = (d['chunk'], d['row'])
                    if key not in seen:
                        seen.add(key); rows.append(d)
    return rows


def wp(s, k):
    return 1.0 / (1.0 + math.exp(-max(-60.0, min(60.0, k * s / 100.0))))


def per_game_sums(rows, k):
    """Accumulate, per game, the sums each statistic needs (for the game bootstrap)."""
    games = defaultdict(lambda: {'v': defaultdict(lambda: [0.0, 0]), 'm': defaultdict(lambda: [0.0, 0]),
                                 's': defaultdict(lambda: [0.0, 0])})
    for d in rows:
        g = games[d['game']]
        base = wp(d['score'], k)
        sp = d['spells']
        vs = [base - wp(x, k) for x in d['self']]          # value to the mover
        vo = [wp(x, k) - base for x in d['opp']]           # value to the opponent
        for p in range(9):
            for v in (vs[p], vo[p]):
                c = g['v'][sp[p]]; c[0] += v; c[1] += 1
        for p in range(9):
            for q in range(9):
                if p == q or sp[p] == sp[q]:
                    continue
                for va, vb in ((vs[p], vo[q]), (vo[p], vs[q])):
                    a, b = sp[p], sp[q]
                    c = g['m'][(a, b)]; c[0] += va - vb; c[1] += 1
        for side, p, q, x in d['pairs']:
            if sp[p] == sp[q]:
                continue
            both = (base - wp(x, k)) if side == 0 else (wp(x, k) - base)
            single = (vs if side == 0 else vo)
            a, b = sorted((sp[p], sp[q]))
            c = g['s'][(a, b)]; c[0] += both - single[p] - single[q]; c[1] += 1
    return games


def estimate(games, kind, keys, boot, rng):
    """Mean (percentage points) and 95% game-bootstrap interval per key."""
    gl = list(games.values())
    S = np.zeros((len(gl), len(keys))); N = np.zeros((len(gl), len(keys)))
    ix = {key: j for j, key in enumerate(keys)}
    for i, g in enumerate(gl):
        for key, (s, n) in g[kind].items():
            j = ix.get(key)
            if j is not None:
                S[i, j] += s; N[i, j] += n
    tot_n = N.sum(0)
    mean = np.where(tot_n > 0, S.sum(0) / np.maximum(tot_n, 1), np.nan) * 100
    bs = []
    for _ in range(boot):
        w = rng.integers(0, len(gl), len(gl))
        sn = N[w].sum(0)
        bs.append(np.where(sn > 0, S[w].sum(0) / np.maximum(sn, 1), np.nan) * 100)
    bs = np.array(bs)
    return mean, np.nanpercentile(bs, 2.5, axis=0), np.nanpercentile(bs, 97.5, axis=0), tot_n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out'); ap.add_argument('src', nargs='+')
    ap.add_argument('--k', type=float, default=0.80)
    ap.add_argument('--boot', type=int, default=200)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--base', default=os.path.join(_HERE, '..', '..', 'docs', 'static', 'data', 'spell-charts.json'))
    a = ap.parse_args()
    rows = read(a.src)
    games = per_game_sums(rows, a.k)
    rng = np.random.default_rng(a.seed)
    spells = list(range(NS))
    v, vlo, vhi, vn = estimate(games, 'v', spells, a.boot, rng)
    pairs = [(x, y) for x in range(NS) for y in range(x + 1, NS)]
    m, mlo, mhi, mn = estimate(games, 'm', pairs, a.boot, rng)
    s, slo, shi, sn = estimate(games, 's', pairs, a.boot, rng)
    base = json.load(open(a.base))['spells'] if os.path.exists(a.base) else {}
    order = sorted(spells, key=lambda x: -(v[x] if not np.isnan(v[x]) else -1e9))
    out_spells = {}
    for rank, x in enumerate(order, 1):
        n = NAMES[x]
        info = dict(base.get(n, {}))
        if n in NEW_SPELLS:
            info.setdefault('type', NEW_SPELLS[n][0]); info.setdefault('pack', NEW_SPELLS[n][1])
        info.update(rank=rank, value=round(float(v[x]), 2), value95=[round(float(vlo[x]), 2), round(float(vhi[x]), 2)],
                    samples=int(vn[x]))
        out_spells[n] = info
    tiers, i = [], 0
    for key, name, size in TIERS:
        part = order[i:] if size is None else order[i:i + size]
        tiers.append({'key': key, 'name': name, 'spells': [NAMES[x] for x in part]})
        i += len(part)
    matchups, synergies = [], []
    for j, (x, y) in enumerate(pairs):
        val, lo, hi = m[j], mlo[j], mhi[j]
        if not np.isnan(val) and (lo > 0 or hi < 0) and abs(val) >= MATCH_MIN:
            fav, oth = (x, y) if val > 0 else (y, x)
            matchups.append([NAMES[fav], NAMES[oth], 2 if abs(val) >= MATCH_STRONG else 1, round(float(abs(val)), 2)])
        else:
            matchups.append([NAMES[x], NAMES[y], 0, None if np.isnan(val) else round(float(val), 2)])
        val, lo, hi = s[j], slo[j], shi[j]
        lvl = 0
        if not np.isnan(val) and (lo > 0 or hi < 0) and abs(val) >= SYN_MIN:
            lvl = (2 if abs(val) >= SYN_STRONG else 1) * (1 if val > 0 else -1)
        synergies.append([NAMES[x], NAMES[y], lvl, None if np.isnan(val) else round(float(val), 2), int(sn[j])])
    out = dict(
        about='Generated by engine/harness/fit_spell_values.py from spell_value_probe.py; do not hand-edit.',
        source='engine', positions=len(rows), games=len(games), k=a.k,
        method=('Positions from real engine self-play (round 4: every official spell drawn equally often). '
                'Each position is searched as played and again with one spell (or pair) made unusable for one '
                'side; the drop in that side\'s win probability is the spell\'s value there. Tier value = mean '
                'value per position of a game holding the spell (percentage points); matchup = value of A to one '
                'side minus value of B to the other; synergy = value of both to one side minus the two single '
                f'values. Matchups favoured at >= {MATCH_MIN:g} pp (strong >= {MATCH_STRONG:g}), synergies at '
                f'>= {SYN_MIN:g} pp (strong >= {SYN_STRONG:g}), each only when the 95% game-bootstrap interval '
                'excludes 0.'),
        spells=out_spells, tiers=tiers, matchups=matchups, synergies=synergies)
    json.dump(out, open(a.out, 'w'), indent=1)
    print(f'{len(rows)} positions from {len(games)} games')
    for t in tiers:
        print(f"{t['key']}: " + ', '.join(f"{n} {out_spells[n]['value']:+.2f}" for n in t['spells']))
    print(f"matchups non-even {sum(1 for x in matchups if x[2])}/{len(pairs)}; "
          f"synergies non-zero {sum(1 for x in synergies if x[2])}/{len(pairs)} "
          f"(median {int(np.median(sn))} pair samples)")


if __name__ == '__main__':
    main()
