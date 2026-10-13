"""Interpretability experiments 7 and 8: concept probes and a neuron atlas (2026-10).

    interp_neurons.py <net.bin> <chunk-dir> <human-lines.json> <out.json> [--per-chunk 60]

Hidden activations of the shipped net (h1: 128 units, h2: 32, h3: 32, each an
integer in 0..64, exactly nn_eval.qforward / src/nn.rs) on real positions,
side to move's POV.

7. Concept probes. For each concept a player uses (interp_net_overrules.concepts:
   material, sigil occupancy and castable spells by role, one-short-of-charging,
   mobility, liberties, map control, mana, void stones, counters, locks), a ridge
   read-out from each layer, fitted on 80% of games and scored (R^2) on the rest.
   Controls: the same probe on a net whose every weight matrix has its entries
   shuffled (same weight distribution, no learned structure), and on the raw
   inputs (78 occupancy bits plus the side), which says whether the concept is
   already linear in the board. A concept the trained layer reads clearly better
   than both is one the net builds for itself.

8. Neuron atlas. Per unit: how often it is off (0) or saturated (64), its
   ablation effect (mean |change of the output| when it is forced to 0), the
   concepts it correlates with most, and the positions that drive it hardest
   (SFNs, for rendering on the real board).
"""
import argparse, json, os, random, sys
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se
import nn_eval as nn
from interp_net_overrules import concepts, rows_selfplay, rows_human

Q = 64


def forward(q, mine, theirs, spells, is_red, ablate=None):
    """Integer forward pass returning (h1, h2, h3, out_cs); `ablate` = (layer, unit) forced to 0."""
    x = nn.occupancy(mine, theirs).astype(np.int32)
    e = nn.e_index(spells)
    E = q['E'].astype(np.int32)
    acc = x @ q['base'].astype(np.int32)
    for f in range(78):
        on = x[:, f] != 0
        if on.any():
            acc[on] += E[e[on, f]]
    acc += q['G'].astype(np.int32)[nn.g_index(spells)].sum(axis=1)
    acc += q['pov'].astype(np.int32)[1 - is_red.astype(np.int64)]
    h1 = np.clip(acc, 0, Q).astype(np.int64)
    if ablate and ablate[0] == 1: h1[:, ablate[1]] = 0
    h2 = np.clip((h1 @ q['w2'].astype(np.int64).T + q['b2']) >> 6, 0, Q)
    if ablate and ablate[0] == 2: h2[:, ablate[1]] = 0
    h3 = np.clip((h2 @ q['w3'].astype(np.int64).T + q['b3']) >> 6, 0, Q)
    if ablate and ablate[0] == 3: h3[:, ablate[1]] = 0
    o = h3 @ q['w4'].astype(np.int64) + np.int64(q['b4'])
    return h1, h2, h3, np.clip((o * 100) >> 12, -q['cap'], q['cap'])


def shuffled(q, rng):
    s = {}
    for k, v in q.items():
        if isinstance(v, np.ndarray) and v.ndim >= 1 and v.size > 1:
            flat = v.ravel().copy(); rng.shuffle(flat); s[k] = flat.reshape(v.shape)
        else:
            s[k] = v
    s['E'][0] = 0
    return s


def collect(rows):
    sp, mine, theirs, is_red, C, sfns, games = [], [], [], [], [], [], []
    for src, game, sfn, y in rows:
        try:
            b = se.Board.from_sfn(sfn)
        except ValueError:
            continue
        if b.gameover:
            continue
        c = 'red' if sfn.split()[1] == 'r' else 'blue'
        red, blue = b.stones
        mine.append(red if c == 'red' else blue); theirs.append(blue if c == 'red' else red)
        is_red.append(int(c == 'red')); sp.append(list(b.spell_ids()))
        C.append(concepts(b, c)); sfns.append(sfn); games.append(game)
    return (np.array(sp, np.uint8), np.array(mine, np.uint64), np.array(theirs, np.uint64),
            np.array(is_red, np.uint8), C, sfns, np.array(games))


def r2_probe(Xtr, ytr, Xte, yte):
    from sklearn.linear_model import Ridge
    if ytr.std() == 0 or yte.std() == 0:
        return None
    m = Ridge(alpha=1.0).fit(Xtr, ytr)
    return float(1 - np.mean((m.predict(Xte) - yte) ** 2) / np.var(yte))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('net'); ap.add_argument('chunks'); ap.add_argument('human'); ap.add_argument('out')
    ap.add_argument('--per-chunk', type=int, default=60)
    a = ap.parse_args()
    q = nn.read_bin(a.net)
    rng = random.Random(4)
    sp, mine, theirs, is_red, C, sfns, games = collect(rows_selfplay(a.chunks, a.per_chunk, rng))
    names = list(C[0]); Cm = np.array([[c[k] for k in names] for c in C], float)
    h1, h2, h3, out = forward(q, mine, theirs, sp, is_red)
    qs = shuffled(q, np.random.default_rng(0))
    s1, s2, s3, _ = forward(qs, mine, theirs, sp, is_red)
    raw = np.hstack([nn.occupancy(mine, theirs).astype(float), is_red[:, None].astype(float)])
    ug = np.unique(games); te_g = set(rng.sample(list(ug), len(ug) // 5))
    te = np.array([g in te_g for g in games]); tr = ~te
    def probe(X, y):
        Xs = (X - X[tr].mean(0)) / (X[tr].std(0) + 1e-9)
        return r2_probe(Xs[tr], y[tr], Xs[te], y[te])
    res = {'net': os.path.basename(a.net), 'positions': int(len(out)), 'games': int(len(ug)), 'probes': {}, 'units': []}
    print(f"{len(out)} positions, {len(ug)} games")
    print(f"{'concept':28s} {'raw':>6s} {'h1':>6s} {'h2':>6s} {'h3':>6s} {'shuf h1':>8s} {'shuf h3':>8s}")
    for j, k in enumerate(names):
        y = Cm[:, j]
        row = {'raw': probe(raw, y), 'h1': probe(h1.astype(float), y), 'h2': probe(h2.astype(float), y),
               'h3': probe(h3.astype(float), y), 'shuffled_h1': probe(s1.astype(float), y),
               'shuffled_h3': probe(s3.astype(float), y)}
        res['probes'][k] = row
        f = lambda v: '   -  ' if v is None else f'{v:6.3f}'
        print(f"{k:28s} {f(row['raw'])} {f(row['h1'])} {f(row['h2'])} {f(row['h3'])} {f(row['shuffled_h1']):>8s} {f(row['shuffled_h3']):>8s}")
    # ---- neuron atlas
    for layer, H in ((1, h1), (2, h2), (3, h3)):
        for u in range(H.shape[1]):
            act = H[:, u].astype(float)
            off, sat = float(np.mean(act == 0)), float(np.mean(act == Q))
            _, _, _, ab = forward(q, mine, theirs, sp, is_red, ablate=(layer, u))
            eff = float(np.mean(np.abs(ab.astype(float) - out.astype(float))))
            corr = []
            if act.std() > 0:
                for j, k in enumerate(names):
                    if Cm[:, j].std() > 0:
                        corr.append((float(np.corrcoef(act, Cm[:, j])[0, 1]), k))
            corr.sort(key=lambda t: -abs(t[0]))
            top = np.argsort(-act)[:5]
            res['units'].append({'layer': layer, 'unit': u, 'off_frac': round(off, 3), 'saturated_frac': round(sat, 3),
                                 'ablation_mean_abs_cs': round(eff, 2),
                                 'top_concepts': [(round(c, 2), k) for c, k in corr[:4]],
                                 'top_positions': [sfns[i] for i in top]})
    units = sorted(res['units'], key=lambda d: -d['ablation_mean_abs_cs'])
    dead = [d for d in res['units'] if d['off_frac'] > 0.99 or d['saturated_frac'] > 0.99]
    print(f"\nneuron atlas: {len(dead)} of {len(res['units'])} units are constant on >99% of positions")
    for d in units[:20]:
        print(f"L{d['layer']} u{d['unit']:3d} ablation {d['ablation_mean_abs_cs']:5.1f} cs  off {d['off_frac']:.2f} "
              f"sat {d['saturated_frac']:.2f}  {d['top_concepts'][:3]}")
    json.dump(res, open(a.out, 'w'), indent=1)


if __name__ == '__main__':
    main()
