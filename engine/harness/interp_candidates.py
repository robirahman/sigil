"""Interpretability experiment 6, offline part: test candidate principles (2026-10).

    interp_candidates.py <out.json> <sample-A chunk-dir> <sample-B chunk-dir> <human-lines.json>
                         [--per-chunk 40] [--exclude-from-B <chunk-dir>]

Each candidate principle from experiments 2, 3 and 5 is written as one extra term
on top of the hand evaluation (tfit_spell_v2, side to move's POV):

    p(win) = sigmoid(k * (hand + w * feature) / 100 + b)

and must pass the plan's first two tests before it earns an arena:

  1. it improves held-out outcome log-loss over the hand evaluation alone (k, b
     refitted), on self-play sample A, REPLICATED on a disjoint sample B and on
     the human games (games split 80/20; the fitted w must keep its sign);
  2. it shrinks the net's correction: the share of the variance of
     r = nnue_spell4 - tfit_spell_v2 that the term explains (r regressed on it).

The third test, Elo in an arena with the term added to the hand evaluation
(no net) against the hand evaluation alone at fixed time, needs an engine preset
per surviving candidate and is run separately.
"""
import argparse, glob, json, os, random, sys
import numpy as np
from scipy.optimize import minimize
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se
from interp_net_overrules import concepts, rows_human, EVAL, BASE

CANDIDATES = {
    'colour (red to move or not)':      lambda f: 2 * f['is_red'] - 1,
    'mobility (soft placements, diff)': lambda f: f['my_mobility'] - f['their_mobility'],
    'sorcery-sigil stones (diff)':      lambda f: f['my_sigil_nodes_sorcery'] - f['their_sigil_nodes_sorcery'],
    'ritual-sigil stones (diff)':       lambda f: f['my_sigil_nodes_ritual'] - f['their_sigil_nodes_ritual'],
    'charm-sigil stones (diff)':        lambda f: f['my_sigil_nodes_charm'] - f['their_sigil_nodes_charm'],
    'void stones (diff)':               lambda f: f['my_void'] - f['their_void'],
    'mana stones (diff)':               lambda f: f['my_mana'] - f['their_mana'],
    'castable charms (diff)':           lambda f: f['my_castable_charm'] - f['their_castable_charm'],
    'castable sorceries (diff)':        lambda f: f['my_castable_sorcery'] - f['their_castable_sorcery'],
    'one short of a sorcery (diff)':    lambda f: f['my_one_short_sorcery'] - f['their_one_short_sorcery'],
    'map control (diff)':               lambda f: f['control'],
    'stones with no liberty (diff)':    lambda f: f['my_zero_liberty'] - f['their_zero_liberty'],
}


def load(rows):
    H, R, Y, G, F = [], [], [], [], []
    for src, game, sfn, y in rows:
        try:
            b = se.Board.from_sfn(sfn)
        except ValueError:
            continue
        if b.gameover:
            continue
        c = 'red' if sfn.split()[1] == 'r' else 'blue'
        h = b.evaluate(c, BASE)
        H.append(h); R.append(b.evaluate(c, EVAL) - h); Y.append(y); G.append(game)
        F.append(concepts(b, c))
    X = {k: np.array([fn(f) for f in F], float) for k, fn in CANDIDATES.items()}
    return np.array(H, float), np.array(R, float), np.array(Y, float), np.array(G), X


def selfplay_rows(d, per_chunk, rng, exclude=()):
    for path in sorted(glob.glob(os.path.join(d, '*.npz'))):
        if os.path.basename(path) in exclude:
            continue
        z = np.load(path)
        rows = [i for i in range(len(z['sfn'])) if int(z['ply'][i]) >= 2 and int(z['y'][i]) != 255]
        for r in rng.sample(rows, min(per_chunk, len(rows))):
            yield 'selfplay', f"{os.path.basename(path)}:{int(z['game'][r])}", str(z['sfn'][r]), int(z['y'][r])


def ll(params, h, x, y):
    k, b, w = params
    z = k * (h + w * x) / 100.0 + b
    return np.mean(np.logaddexp(0, z) - y * z)


def test(h, r, y, g, X, rng):
    ug = np.unique(g); te_g = set(rng.sample(list(ug), max(1, len(ug) // 5)))
    te = np.array([x in te_g for x in g]); tr = ~te
    base = minimize(lambda p: ll((p[0], p[1], 0.0), h[tr], 0 * h[tr], y[tr]), [0.8, 0.0], method='Nelder-Mead').x
    base_te = ll((base[0], base[1], 0.0), h[te], 0 * h[te], y[te])
    out = {'positions': int(len(y)), 'games': int(len(ug)), 'base_heldout_logloss': round(float(base_te), 5)}
    for name, x in X.items():
        p = minimize(lambda q: ll(q, h[tr], x[tr], y[tr]), [base[0], base[1], 0.0], method='Nelder-Mead',
                     options={'xatol': 1e-4, 'fatol': 1e-8, 'maxiter': 4000}).x
        gain = base_te - ll(p, h[te], x[te], y[te])
        # Net shrinkage: share of var(r) explained by the term (simple regression).
        c = np.corrcoef(x, r)[0, 1] if x.std() > 0 else 0.0
        out[name] = {'w_cs_per_unit': round(float(p[2]), 1), 'heldout_gain': round(float(gain), 5),
                     'net_r2': round(float(c * c), 4), 'net_slope_cs': round(float(np.polyfit(x, r, 1)[0]) if x.std() > 0 else 0.0, 1)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out'); ap.add_argument('a'); ap.add_argument('b'); ap.add_argument('human')
    ap.add_argument('--per-chunk', type=int, default=40)
    a = ap.parse_args()
    rng = random.Random(9)
    in_a = {os.path.basename(p) for p in glob.glob(os.path.join(a.a, '*.npz'))}
    res = {}
    for label, rows in (('selfplay A', selfplay_rows(a.a, a.per_chunk, rng)),
                        ('selfplay B', selfplay_rows(a.b, max(4, a.per_chunk // 10), rng, exclude=in_a)),
                        ('human', rows_human(a.human, rng))):
        h, r, y, g, X = load(rows)
        res[label] = test(h, r, y, g, X, rng)
        print(f"{label}: {res[label]['positions']} positions, {res[label]['games']} games, "
              f"hand-eval held-out log-loss {res[label]['base_heldout_logloss']}", flush=True)
    names = list(CANDIDATES)
    labels = list(res)
    json.dump(res, open(a.out, 'w'), indent=1)
    print(f"\n{'candidate':36s} " + ' '.join(f'{l:>28s}' for l in labels) + '   verdict')
    res['verdict'] = {}
    for n in names:
        cells = [f"w {res[l][n]['w_cs_per_unit']:+6.1f} g {res[l][n]['heldout_gain']:+.4f} r2 {res[l][n]['net_r2']:.3f}" for l in labels]
        signs = {np.sign(res[l][n]['w_cs_per_unit']) for l in labels}
        ok = all(res[l][n]['heldout_gain'] > 0 for l in labels) and len(signs) == 1
        res['verdict'][n] = 'passes tests 1-2' if ok and min(res[l][n]['net_r2'] for l in labels) > 0.005 else \
            ('replicates, but the net barely prices it' if ok else 'fails')
        print(f'{n:36s} ' + ' '.join(f'{c:>28s}' for c in cells) + '   ' + res['verdict'][n])
    json.dump(res, open(a.out, 'w'), indent=1)


if __name__ == '__main__':
    main()
