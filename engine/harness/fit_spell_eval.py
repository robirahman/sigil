"""Step 2 of the 2026-10 plan: per-spell sigil terms on top of `tfit`.

    fit_spell_eval.py <npz-dir> [out.json] [--max-rows N]

`tfit` prices a stone on a sigil (`sigil_stone`, mine^2/n per slot) and a fully
occupied sigil (`sigil_charged`) the same whatever spell sits there. This fits a
per-SPELL delta for both terms, in centistones after the positional scale, on top
of the shipped `tfit` evaluation (recomputed exactly from the stored hand features):

    eval'(pos) = tfit(pos) + sum_p  ds[spell_p] * stone_p + dc[spell_p] * charged_p
    stone_p    = mine_p^2 // n_p - theirs_p^2 // n_p          (eval.rs's own term)
    charged_p  = [mine_p == n_p] - [theirs_p == n_p]

These are the eval's existing per-slot quantities, so the shipped version is a
per-game [i32; 9] lookup with no new per-node work. The plan's literal feature set
(fill fraction x spell, castable flag x spell) is fitted too, as a reference
ceiling: `castable` is not computable at a leaf for free, so it is not shippable
as-is, but if it beats the shippable set by a lot that is worth knowing.

Two targets, both reported, both scored on the eventual OUTCOME and on the search
score:
  * outcome:  y (side to move went on to win)
  * score:    soft target sigmoid(k * depth-4 search score), mates excluded, k the
              texel scale fitted on the baseline.
The deltas are L2-regularised towards 0, i.e. towards the shared tfit weights.

Splits: by GAME (80/20), and the C3-style SPELL split (train on games whose draw
avoids a held-out set, test on games that use it; held-out spells fall back to the
shared weight, so this measures whether the other eight slots' weights generalise
into new company), over three disjoint held-out folds.
"""
import glob, json, os, sys
import numpy as np
from scipy.optimize import minimize
from scipy import sparse

SIZES = np.array([5, 5, 5, 3, 3, 3, 1, 1, 1])
NSP = 39
# FIT_SHAPE positional weights in hand-feature order (eval.rs), pos 96/1887.
HAND_ORDER = ['lead', 'near_threshold', 'own_zero_liberty', 'own_one_liberty',
              'enemy_zero_liberty', 'enemy_one_liberty', 'sigil_stone', 'sigil_charged',
              'mana', 'sixth_spell_danger', 'control', 'void_penalty', 'tempo']
FIT_POS = {'near_threshold': 56, 'own_zero_liberty': 1, 'own_one_liberty': 15,
           'enemy_zero_liberty': 3, 'enemy_one_liberty': -17, 'sigil_stone': 36,
           'sigil_charged': 2, 'mana': 82, 'sixth_spell_danger': 64, 'control': 3,
           'void_penalty': -22}
POS_NUM, POS_DEN = 96, 1887
MATE = 5000


def tfit_eval(hand):
    pos = np.zeros(len(hand), dtype=np.int64)
    for k, w in FIT_POS.items():
        pos += w * hand[:, HAND_ORDER.index(k)].astype(np.int64)
    # Rust: pos * num / den with truncation toward zero.
    scaled = np.trunc(pos * POS_NUM / POS_DEN).astype(np.int64)
    return 100 * hand[:, 0] + scaled + 50 * hand[:, HAND_ORDER.index('tempo')]


def load(d, max_rows=None):
    fs = sorted(glob.glob(os.path.join(d, 'positions_*.npz')))
    cols = {k: [] for k in ('e0', 'mat', 'stone', 'charged', 'fillm', 'fillt', 'castm', 'castt',
                            'spells', 'y', 'score', 'game')}
    n = 0
    for f in fs:
        z = np.load(f)
        if len(z['y']) == 0:
            continue
        full = z['full']
        fm = np.rint(full[:, 78:87] * SIZES).astype(np.int16)
        ft = np.rint(full[:, 87:96] * SIZES).astype(np.int16)
        cols['stone'].append((fm * fm // SIZES - ft * ft // SIZES).astype(np.int8))
        cols['charged'].append(((fm == SIZES).astype(np.int8) - (ft == SIZES)))
        cols['fillm'].append(full[:, 78:87].astype(np.float16))
        cols['fillt'].append(full[:, 87:96].astype(np.float16))
        cols['castm'].append(full[:, 96:105].astype(np.int8))
        cols['castt'].append(full[:, 105:114].astype(np.int8))
        cols['e0'].append(tfit_eval(z['hand']).astype(np.int32))
        h = z['hand']
        cols['mat'].append((100 * h[:, 0] + 50 * h[:, HAND_ORDER.index('tempo')]).astype(np.int32))
        cols['spells'].append(z['spells'])
        cols['y'].append(z['y'])
        cols['score'].append(z['score'])
        cols['game'].append(z['game'])
        n += len(z['y'])
        if max_rows and n >= max_rows:
            break
    return {k: np.concatenate(v) for k, v in cols.items()}


def design(D, idx, kind):
    """Sparse (n x 2*NSP) per-spell design: column s = sum over slots holding s."""
    sp = D['spells'][idx].astype(np.int64)
    n = len(idx)
    rows = np.repeat(np.arange(n), 9)
    if kind == 'ship':
        a, b = D['stone'][idx], D['charged'][idx]
    else:  # plan's literal set: fill (mine - theirs) and castable (mine - theirs)
        a = D['fillm'][idx].astype(np.float32) - D['fillt'][idx].astype(np.float32)
        b = D['castm'][idx].astype(np.float32) - D['castt'][idx].astype(np.float32)
    data = np.concatenate([a.ravel(), b.ravel()]).astype(np.float64)
    r = np.concatenate([rows, rows])
    c = np.concatenate([sp.ravel(), sp.ravel() + NSP])
    return sparse.csr_matrix((data, (r, c)), shape=(n, 2 * NSP))


def xent(logit, t):
    # mean binary cross-entropy for soft or hard targets
    return float(np.mean(np.logaddexp(0, logit) - t * logit))


def fit_baseline(e0, y):
    def f(p):
        z = p[0] * e0 / 100.0 + p[1]
        s = 1 / (1 + np.exp(-z))
        g = s - y
        return xent(z, y), np.array([np.mean(g * e0 / 100.0), np.mean(g)])
    r = minimize(f, [0.5, 0.0], jac=True, method='L-BFGS-B')
    return r.x


def fit_deltas(X, e0, t, k, b, lam):
    """deltas in centistones: logit = k*(e0 + X d)/100 + b."""
    n = X.shape[0]
    base = k * e0 / 100.0 + b
    def f(d):
        z = base + k * (X @ d) / 100.0
        s = 1 / (1 + np.exp(-z))
        g = X.T @ (s - t) * (k / 100.0) / n
        return xent(z, t) + lam * float(d @ d), g + 2 * lam * d
    r = minimize(f, np.zeros(X.shape[1]), jac=True, method='L-BFGS-B',
                 options={'maxiter': 2000, 'gtol': 1e-12, 'ftol': 1e-15})
    return r.x


def evaluate(D, te, X, d, k, b):
    e0 = D['e0'][te].astype(np.float64)
    z0 = k * e0 / 100 + b
    z1 = z0 + (k * (X @ d) / 100 if d is not None else 0)
    y = D['y'][te].astype(np.float64)
    sc = D['score'][te]
    m = np.isfinite(sc) & (np.abs(sc) < MATE)
    ts = 1 / (1 + np.exp(-k * sc[m] / 100))
    return {'outcome_ll': xent(z1, y), 'score_xent': xent(z1[m], ts),
            'base_outcome_ll': xent(z0, y), 'base_score_xent': xent(z0[m], ts)}


def run_split(D, tr, te, kinds=('ship', 'plan'), lam=1e-6, tag=''):
    e0tr = D['e0'][tr].astype(np.float64)
    ytr = D['y'][tr].astype(np.float64)
    k, b = fit_baseline(e0tr, ytr)
    res = {'k': k, 'b': b, 'n_train': int(len(tr)), 'n_test': int(len(te))}
    for kind in kinds:
        Xtr = design(D, tr, kind)
        Xte = design(D, te, kind)
        sc = D['score'][tr]
        m = np.isfinite(sc) & (np.abs(sc) < MATE)
        ts = 1 / (1 + np.exp(-k * sc[m] / 100))
        d_out = fit_deltas(Xtr, e0tr, ytr, k, b, lam)
        d_sc = fit_deltas(Xtr[m], e0tr[m], ts, k, b, lam)
        res[kind] = {'outcome_fit': evaluate(D, te, Xte, d_out, k, b),
                     'score_fit': evaluate(D, te, Xte, d_sc, k, b),
                     'd_outcome': d_out.tolist(), 'd_score': d_sc.tolist()}
        print(f"{tag} {kind}: outcome-fit {res[kind]['outcome_fit']}\n"
              f"{tag} {kind}: score-fit   {res[kind]['score_fit']}", flush=True)
    return res


def main():
    d = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else 'fit_spell_eval.json'
    max_rows = int(sys.argv[sys.argv.index('--max-rows') + 1]) if '--max-rows' in sys.argv else None
    D = load(d, max_rows)
    n = len(D['y'])
    games = np.unique(D['game'])
    print(f"{n} positions, {len(games)} games, {np.isfinite(D['score']).sum()} scored")
    # sanity: the recomputed tfit eval should track the depth-4 score
    m = np.isfinite(D['score']) & (np.abs(D['score']) < MATE)
    print("corr(tfit eval, d4 score) =", np.corrcoef(D['e0'][m], D['score'][m])[0, 1])

    rng = np.random.default_rng(0)
    test_games = rng.choice(games, size=len(games) // 5, replace=False)
    is_te = np.isin(D['game'], test_games)
    result = {'game_split': run_split(D, np.where(~is_te)[0], np.where(is_te)[0], tag='game')}

    # C3 spell split: three disjoint folds of 2 spells per role (6 spells each).
    folds = [[0, 15, 5, 16, 10, 17], [1, 18, 6, 19, 11, 20], [2, 21, 7, 22, 12, 23]]
    result['spell_split'] = []
    for hold in folds:
        h = np.zeros(NSP + 10, bool); h[hold] = True
        uses = h[D['spells']].any(axis=1)
        r = run_split(D, np.where(~uses)[0], np.where(uses)[0], kinds=('ship',),
                      tag=f'hold{hold}')
        r['holdout'] = hold
        result['spell_split'].append(r)
    with open(out, 'w') as f:
        json.dump(result, f, indent=1, default=float)
    print('WROTE', out)


if __name__ == '__main__':
    main()
