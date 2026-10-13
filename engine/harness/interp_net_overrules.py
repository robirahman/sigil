"""Interpretability experiment 5: where the net overrules the hand evaluation (2026-10).

    interp_net_overrules.py <chunk-dir> <human-lines.json> <out.json> [--per-chunk 1000]

The shipped eval is the hand evaluation plus the net's correction r = nnue_spell4 -
tfit_spell_v2 (engine/reports/2026-10-interpretability-plan.md). Two readings of r on
real positions (round-4 self-play and recorded human games), side to move's POV:

1. A surrogate. Ridge regression of r on a dictionary of concepts players use
   (`CONCEPTS` below: material, stones one short of charging a sigil, castable
   spells by role, mobility, liberties, map control, mana, void stones, spell
   counters, locks, game phase), fitted on 80% of games and scored on the rest.
   Its coefficients (centistones per unit) say which concepts the net prices that
   the hand evaluation does not; its held-out R^2 says how much of r they explain.

2. The overrules. Positions in the top 5% of |r| are kept when the shipped eval
   predicted the game's result better than the hand evaluation alone (each eval
   with its own fitted logistic scale), clustered (k-means on the standardised
   concepts), and each cluster is described by its most distinctive concepts with
   example positions (SFNs, for rendering on the real board). Each cluster is a
   candidate principle for experiment 6, not a finding.
"""
import argparse, glob, json, os, random, sys
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se
from interp_hand_eval import SIGIL, logloss_of

MANA = 0x4002001
VOID = 0x7003801c00
SIZES = [5, 5, 5, 3, 3, 3, 1, 1, 1]
ROLE = ['ritual'] * 3 + ['sorcery'] * 3 + ['charm'] * 3


def popc(x):
    return bin(x).count('1')


def concepts(b, c):
    mine_l, theirs_l = (b.red, b.blue) if c == 'red' else (b.blue, b.red)
    mine = sum(1 << n for n in mine_l); theirs = sum(1 << n for n in theirs_l)
    o = 'blue' if c == 'red' else 'red'
    ci, oi = (0, 1) if c == 'red' else (1, 0)
    f = {}
    f['my_stones'] = popc(mine); f['their_stones'] = popc(theirs)
    f['score_lead'] = popc(mine) - popc(theirs) + (1 if c == 'blue' else -1)   # blue's +1 token
    f['empty_nodes'] = 39 - popc(mine) - popc(theirs)
    my_c = set(b.castable(c, True, True, False)); th_c = set(b.castable(o, True, True, False))
    ids = list(b.spell_ids())
    for role in ('ritual', 'sorcery', 'charm'):
        sl = [p for p in range(9) if ROLE[p] == role]
        f[f'my_castable_{role}'] = sum(ids[p] in my_c for p in sl)
        f[f'their_castable_{role}'] = sum(ids[p] in th_c for p in sl)
        if role != 'charm':
            f[f'my_one_short_{role}'] = sum(popc(SIGIL[p] & mine) == SIZES[p] - 1 and popc(SIGIL[p] & theirs) == 0 for p in sl)
            f[f'their_one_short_{role}'] = sum(popc(SIGIL[p] & theirs) == SIZES[p] - 1 and popc(SIGIL[p] & mine) == 0 for p in sl)
            f[f'contested_{role}'] = sum(popc(SIGIL[p] & mine) > 0 and popc(SIGIL[p] & theirs) > 0 for p in sl)
        f[f'my_sigil_nodes_{role}'] = sum(popc(SIGIL[p] & mine) for p in sl)
        f[f'their_sigil_nodes_{role}'] = sum(popc(SIGIL[p] & theirs) for p in sl)
    f['my_mana'] = popc(mine & MANA); f['their_mana'] = popc(theirs & MANA)
    f['my_void'] = popc(mine & VOID); f['their_void'] = popc(theirs & VOID)
    f['my_mobility'] = len(b.soft_moveable(c)); f['their_mobility'] = len(b.soft_moveable(o))
    h = b.hand_features(c)
    f['my_zero_liberty'], f['my_one_liberty'], f['their_zero_liberty'], f['their_one_liberty'] = h[2], h[3], h[4], h[5]
    f['control'] = h[10]
    sc = b.spell_counter
    f['my_casts'] = sc[ci]; f['their_casts'] = sc[oi]
    lk = b.lock
    f['my_locked'] = int(lk[ci] != 255); f['their_locked'] = int(lk[oi] != 255)
    f['turn'] = b.turn_counter
    f['is_red'] = int(c == 'red')
    return f


def rows_selfplay(chunk_dir, per_chunk, rng):
    for path in sorted(glob.glob(os.path.join(chunk_dir, '*.npz'))):
        z = np.load(path)
        rows = [i for i in range(len(z['sfn'])) if int(z['ply'][i]) >= 2]
        for r in rng.sample(rows, min(per_chunk, len(rows))):
            yield 'selfplay', f"sp{int(z['game'][r])}", str(z['sfn'][r]), int(z['y'][r])


def rows_human(path, rng):
    lines = json.load(open(path))
    for code in sorted(lines):
        g = lines[code]
        if g.get('variant', 'standard') not in ('standard', 'competitive') or g.get('winner') not in ('red', 'blue'):
            continue
        pos = g['positions']
        if isinstance(pos, str):
            pos = json.loads(pos.replace("'", '"'))
        for i in range(2, len(pos)):
            mover = 'red' if pos[i].split()[1] == 'r' else 'blue'
            yield 'human', code, pos[i], int(g['winner'] == mover)


def build(rows):
    X, meta = [], []
    for src, game, sfn, y in rows:
        try:
            b = se.Board.from_sfn(sfn)
        except ValueError:
            continue
        if b.gameover:
            continue
        c = 'red' if sfn.split()[1] == 'r' else 'blue'
        h = b.evaluate(c, 'tfit_spell_v2'); full = b.evaluate(c, se.SHIPPED_EVAL)
        X.append(concepts(b, c)); meta.append((src, game, sfn, y, h, full - h))
    return X, meta


def fit_ll(x, y, xt, yt):
    from scipy.optimize import minimize
    x = x / 100.0; xt = xt / 100.0
    nll = lambda p: np.mean(np.logaddexp(0, p[0] * x + p[1]) - y * (p[0] * x + p[1]))
    p = minimize(nll, [0.5, 0], method='Nelder-Mead').x
    z = p[0] * xt + p[1]
    return np.logaddexp(0, z) - yt * z                     # per-position loss


def analyse(X, meta, label, rng):
    names = list(X[0])
    F = np.array([[x[k] for k in names] for x in X], float)
    games = np.array([m[1] for m in meta]); y = np.array([m[3] for m in meta], float)
    h = np.array([m[4] for m in meta], float); r = np.array([m[5] for m in meta], float)
    ug = np.unique(games); test_g = set(rng.sample(list(ug), len(ug) // 5))
    te = np.array([g in test_g for g in games]); tr = ~te
    mu, sd = F[tr].mean(0), F[tr].std(0) + 1e-9
    Z = (F - mu) / sd
    from sklearn.linear_model import Ridge
    m = Ridge(alpha=10.0).fit(Z[tr], r[tr])
    pred = m.predict(Z[te])
    r2 = 1 - np.mean((r[te] - pred) ** 2) / np.var(r[te])
    coef = {k: round(float(c / s), 2) for k, c, s in zip(names, m.coef_, sd)}     # cs per unit
    std_coef = sorted(((round(float(c), 1), k) for k, c in zip(names, m.coef_)), key=lambda t: -abs(t[0]))
    # Overrules: top 5% |r|, the full eval beating the hand eval on the result.
    loss_h = fit_ll(h[tr], y[tr], h, y); loss_f = fit_ll(h[tr] + r[tr], y[tr], h + r, y)
    gain = loss_h - loss_f
    big = np.abs(r) >= np.percentile(np.abs(r), 95)
    over = big & (gain > 0)
    from sklearn.cluster import KMeans
    idx = np.flatnonzero(over)
    km = KMeans(n_clusters=8, n_init=10, random_state=0).fit(Z[idx])
    clusters = []
    for k in range(8):
        sel = idx[km.labels_ == k]
        zc = Z[sel].mean(0)
        top = sorted(zip(zc, names), key=lambda t: -abs(t[0]))[:6]
        d = np.linalg.norm(Z[sel] - km.cluster_centers_[k], axis=1)
        ex = [meta[i][2] for i in sel[np.argsort(d)[:4]]]
        clusters.append({'n': int(len(sel)), 'games': int(len(set(games[sel]))),
                         'net_mean_cs': round(float(r[sel].mean()), 1), 'win_rate': round(float(y[sel].mean()), 3),
                         'hand_mean_cs': round(float(h[sel].mean()), 1),
                         'logloss_gain': round(float(gain[sel].mean()), 4),
                         'distinctive': [(k2, round(float(z), 2), round(float(F[sel, names.index(k2)].mean()), 2),
                                          round(float(mu[names.index(k2)]), 2)) for z, k2 in top],
                         'examples': ex})
    clusters.sort(key=lambda c: -c['n'])
    # Overall: how much the net helps, and on how many positions.
    res = {'label': label, 'positions': int(len(r)), 'games': int(len(ug)),
           'surrogate_r2_heldout': round(float(r2), 3), 'surrogate_cs_per_unit': coef,
           'surrogate_standardised_top': std_coef[:20],
           'mean_logloss_gain_all': round(float(gain.mean()), 4),
           'mean_logloss_gain_top5pct': round(float(gain[big].mean()), 4),
           'top5pct_net_right_frac': round(float((gain[big] > 0).mean()), 3),
           'clusters': clusters}
    print(f"\n=== {label}: {len(r)} positions, {len(ug)} games; surrogate held-out R^2 {r2:.3f}; "
          f"log-loss gain from the net: all {gain.mean():.4f}, top-5% |r| {gain[big].mean():.4f} "
          f"(net right on {(gain[big] > 0).mean():.0%})")
    print('largest standardised surrogate weights (cs per sd):', std_coef[:14])
    for c in clusters:
        print(f"cluster n={c['n']} games={c['games']} net {c['net_mean_cs']:+.0f} hand {c['hand_mean_cs']:+.0f} "
              f"win {c['win_rate']:.2f} gain {c['logloss_gain']:.3f} :: " +
              ', '.join(f"{k}={v} (avg {a})" for k, z, v, a in c['distinctive'][:5]))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('chunks'); ap.add_argument('human'); ap.add_argument('out')
    ap.add_argument('--per-chunk', type=int, default=1000)
    a = ap.parse_args()
    rng = random.Random(5)
    out = {'eval': se.SHIPPED_EVAL}
    for label, rows in (('selfplay', rows_selfplay(a.chunks, a.per_chunk, rng)), ('human', rows_human(a.human, rng))):
        X, meta = build(rows)
        out[label] = analyse(X, meta, label, rng)
    json.dump(out, open(a.out, 'w'), indent=1)


if __name__ == '__main__':
    main()
