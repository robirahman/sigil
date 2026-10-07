"""Fit a learned competitive-opening selector to opening_rollouts.py labels.

    fit_opening_selector.py <npz-glob> [--l2 1.0] [--folds 5] [--out weights.json]

Model, per side (red's first placement; blue's reply), scoring a candidate sigil
slot s of a draw:

    score(s) = w_own[spell at s] + sum_{z in zone-mates of s} w_mate[spell at z]
               (+ blue only: w_contest if s is red's sigil)

All spells are core (ids < 39; the shipped selector also only applies there).
Terms constant across a draw's candidates cancel in the argmax, so the model only
needs what differs between slots. Fit: binomial logistic regression of each cell's
wins/games on score + a per-(draw, side) intercept (the draw's base rate), with an
L2 penalty on w. Draws are split into folds; reported on held-out draws:

  * regret of a pick = (best cell's empirical win rate) - (picked cell's), mean over
    draws, for: the learned model, the shipped selector (`book_slot`), and a
    uniformly random slot;
  * how often each pick equals the empirically best slot.

Writes integer weights (x1000, rounded) as JSON for opening_learned.rs.
"""
import argparse
import glob
import json

import numpy as np

NS = 39


def load(pattern):
    cols = {k: [] for k in ('draw', 'side', 'slot', 'red_slot', 'book_slot', 'wins', 'games')}
    for f in sorted(glob.glob(pattern)):
        z = np.load(f)
        for k in cols:
            cols[k].append(z[k])
    return {k: np.concatenate(v) for k, v in cols.items()}


def zone_mates(s):
    # topology position: zone = pos % 3, role = pos // 3 (opening.rs zone/role)
    return [p for p in range(9) if p % 3 == s % 3 and p != s]


def features(draw, side, slot, red_slot):
    """Sparse feature indices: [0, 39) own, [39, 78) mates, 78 contest."""
    idx = [int(draw[slot])]
    for z in zone_mates(slot):
        idx.append(NS + int(draw[z]))
    if side == 1 and slot == red_slot:
        idx.append(2 * NS)
    return idx


NF = 2 * NS + 1


def design(D, mask):
    rows = np.nonzero(mask)[0]
    X = np.zeros((len(rows), NF))
    for i, r in enumerate(rows):
        for j in features(D['draw'][r], D['side'][r], D['slot'][r], D['red_slot'][r]):
            X[i, j] += 1.0
    return rows, X


def group_ids(D, rows):
    keys = {}
    g = np.empty(len(rows), np.int64)
    for i, r in enumerate(rows):
        k = (tuple(D['draw'][r]), int(D['side'][r]))
        g[i] = keys.setdefault(k, len(keys))
    return g, len(keys)


def fit(X, g, ng, wins, games, l2, iters=300, lr=0.5):
    w = np.zeros(X.shape[1]); b = np.zeros(ng)
    y = wins / np.maximum(games, 1)
    for _ in range(iters):
        z = X @ w + b[g]
        p = 1 / (1 + np.exp(-np.clip(z, -30, 30)))
        r = games * (p - y)                         # d(NLL)/dz per cell
        gw = X.T @ r / games.sum() + l2 * w / games.sum()
        gb = np.bincount(g, weights=r, minlength=ng) / np.maximum(np.bincount(g, weights=games, minlength=ng), 1)
        w -= lr * gw * 50; b -= lr * gb
    return w


def evaluate(D, rows, X, w, side):
    by = {}
    for i, r in enumerate(rows):
        by.setdefault(tuple(D['draw'][r]), []).append((i, r))
    out = dict(model=[], book=[], rand=[], model_hit=0, book_hit=0, n=0)
    for k, cells in by.items():
        rate = {int(D['slot'][r]): D['wins'][r] / D['games'][r] for _, r in cells}
        best = max(rate.values())
        score = {int(D['slot'][r]): X[i] @ w for i, r in cells}
        mp = max(score, key=score.get)
        bp = int(D['book_slot'][cells[0][1]])
        out['model'].append(best - rate[mp]); out['model_hit'] += rate[mp] == best
        if bp in rate:
            out['book'].append(best - rate[bp]); out['book_hit'] += rate[bp] == best
        out['rand'].append(best - np.mean(list(rate.values())))
        out['n'] += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pattern'); ap.add_argument('--l2', type=float, default=1.0)
    ap.add_argument('--folds', type=int, default=5); ap.add_argument('--out')
    ap.add_argument('--rust', help='write engine/src/opening_learned_weights.rs here')
    a = ap.parse_args()
    D = load(a.pattern)
    draws = sorted({tuple(d) for d in D['draw']})
    rng = np.random.default_rng(0); order = rng.permutation(len(draws))
    fold_of = {draws[i]: f % a.folds for f, i in enumerate(order)}
    dfold = np.array([fold_of[tuple(d)] for d in D['draw']])
    print(f"{len(D['slot'])} cells, {len(draws)} draws, {int(D['games'].sum())} games")
    final = {}
    for side, name in ((0, 'red'), (1, 'blue')):
        agg = dict(model=[], book=[], rand=[], model_hit=0, book_hit=0, n=0)
        for f in range(a.folds):
            tr = (D['side'] == side) & (dfold != f); te = (D['side'] == side) & (dfold == f)
            rows, X = design(D, tr); g, ng = group_ids(D, rows)
            w = fit(X, g, ng, D['wins'][rows].astype(float), D['games'][rows].astype(float), a.l2)
            rows2, X2 = design(D, te)
            e = evaluate(D, rows2, X2, w, side)
            for k in ('model', 'book', 'rand'):
                agg[k] += e[k]
            for k in ('model_hit', 'book_hit', 'n'):
                agg[k] += e[k]
        print(f"[{name}] held-out draws {agg['n']}: mean regret (win-rate pts) model {np.mean(agg['model']):.3f} "
              f"book {np.mean(agg['book']):.3f} random {np.mean(agg['rand']):.3f}; picks the best cell: "
              f"model {agg['model_hit']}/{agg['n']} book {agg['book_hit']}/{len(agg['book'])}")
        rows, X = design(D, D['side'] == side); g, ng = group_ids(D, rows)
        w = fit(X, g, ng, D['wins'][rows].astype(float), D['games'][rows].astype(float), a.l2)
        final[name] = [int(round(v * 1000)) for v in w]
    if a.out:
        with open(a.out, 'w') as fh:
            json.dump(dict(nf=NF, layout='own[39], mates[39], contest', scale=1000, **final), fh)
        print('wrote', a.out)
    if a.rust:
        with open(a.rust, 'w') as fh:
            fh.write('//! GENERATED by engine/harness/fit_opening_selector.py --rust; do not edit.\n')
            fh.write(f'//! Fit on {len(D["slot"])} rollout cells over {len(draws)} draws, l2 {a.l2}.\n')
            fh.write('//! Layout: own[39] (spell at the slot), mates[39] (zone-mates), contest (blue on red\'s sigil); x1000.\n')
            for name in ('red', 'blue'):
                fh.write(f'pub const LEARNED_{name.upper()}: [i32; {NF}] = {final[name]};\n')
        print('wrote', a.rust)


if __name__ == '__main__':
    main()
