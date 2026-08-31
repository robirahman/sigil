"""Was E0a's 0.050 nats real signal, or leakage through the legal_draw collision?

    fit_gbm_check.py <data_dir> [max_positions] [folds]

E0a reported 0.050 nats of residual static gain over material + search score + ply,
using a gradient-boosted model and grouping its holdout **by game**. E0b then found
only 0.0053 nats with an MLP, grouping **by spell draw**. Two differences at once,
so E0a's headline is unattributed:

  * model    -- boosted trees vs a 64-32 MLP, and trees are strong on tabular data;
  * grouping -- `Board::legal_draw(seed)` returned the SAME 9-spell draw for seeds
                2n and 2n+1, so a game split left half of every held-out draw
                sitting in the training set. Trees can exploit that through the
                sigil-fraction and castable features.

This script varies exactly one thing at a time on the same rows, so the two effects
separate:

    model    in {linear, MLP, GBM}
    grouping in {by draw (honest), by game (what E0a did)}

The gap between the two groupings for a fixed model IS the leakage. If GBM-by-draw
is small, E0a's number was leakage and E0b's KILL stands. If GBM-by-draw is large
while MLP-by-draw is small, the signal is real and the MLP was the wrong model.
"""
import glob, os, sys
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import GroupKFold


def ll(p, y):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))


def main():
    data_dir = sys.argv[1]
    cap = int(sys.argv[2]) if len(sys.argv) > 2 else 700_000
    folds = int(sys.argv[3]) if len(sys.argv) > 3 else 4

    cols = {k: [] for k in ("hand", "full", "spells", "ply", "y", "game", "score")}
    files = sorted(glob.glob(os.path.join(data_dir, "*.npz")))
    for f in files:
        d = np.load(f, allow_pickle=True)
        if len(d["y"]) == 0:
            continue
        for k in cols:
            cols[k].append(d[k])
    D = {k: np.concatenate(v) for k, v in cols.items()}
    y = D["y"].astype(float)
    print(f"{len(files)} shards | {len(y)} positions | {len(np.unique(D['game']))} games")

    draw = np.array([hash(tuple(r)) for r in D["spells"]], dtype=np.int64)
    # subsample by draw so whole draws (and so whole games) stay intact
    if len(y) > cap:
        u = np.unique(draw)
        keep = np.random.default_rng(0).permutation(u)[:max(1, int(len(u) * cap / len(y)))]
        m = np.isin(draw, keep)
        D = {k: v[m] for k, v in D.items()}
        y, draw = D["y"].astype(float), draw[m]
    game = D["game"]
    print(f"using {len(y)} positions | {len(np.unique(game))} games | "
          f"{len(np.unique(draw))} draws ({len(np.unique(game))/len(np.unique(draw)):.2f} games/draw)")

    H, F = D["hand"].astype(float), D["full"].astype(float)
    live = F.std(0) > 1e-9
    z = lambda A: (A - A.mean(0)) / (A.std(0) + 1e-9)
    # E0a's base: exact material + the depth-4 search score + ply.
    sc = np.nan_to_num(D["score"], nan=0.0)
    mate = (np.abs(sc) > 1e6).astype(float) * np.sign(sc)
    scl = np.clip(sc, -1500, 1500)
    BASE_A = np.column_stack([H[:, :1], scl, mate, D["ply"].astype(float),
                              np.isnan(D["score"]).astype(float)])
    # E0b's base: material + the 12 hand features the engine evaluates today.
    BASE_B = np.column_stack([H[:, :1], H[:, 1:]])
    EXTRA = F[:, live]

    lin = lambda: LogisticRegression(C=0.1, max_iter=4000)
    mlp = lambda: MLPClassifier(hidden_layer_sizes=(64, 32), alpha=1e-2,
                                learning_rate_init=1e-3, batch_size=512,
                                max_iter=40, random_state=0)
    gbm = lambda: HistGradientBoostingClassifier(
        max_iter=300, learning_rate=0.06, max_leaf_nodes=31,
        l2_regularization=1.0, min_samples_leaf=100, random_state=0)

    def gain(base, model, groups):
        full = np.column_stack([base, EXTRA])
        g = np.zeros(folds)
        for i, (tr, te) in enumerate(GroupKFold(n_splits=folds).split(base, y, groups)):
            zb = z(base) if model is lin else base
            zf = z(full) if model is lin else full
            a = model().fit(zb[tr], y[tr]).predict_proba(zb[te])[:, 1]
            c = model().fit(zf[tr], y[tr]).predict_proba(zf[te])[:, 1]
            g[i] = ll(a, y[te]) - ll(c, y[te])
        return g

    print(f"\ngain from adding all {live.sum()} features, in nats\n")
    print(f"{'base':<28}{'model':<8}{'grouped by':<12}{'gain':>9}{'+-se':>8}")
    for bname, base in (("E0a: material+score+ply", BASE_A),
                        ("E0b: material+12 hand", BASE_B)):
        for mname, model in (("linear", lin), ("MLP", mlp), ("GBM", gbm)):
            for gname, groups in (("draw", draw), ("game", game)):
                g = gain(base, model, groups)
                print(f"{bname:<28}{mname:<8}{gname:<12}"
                      f"{g.mean():9.5f}{g.std(ddof=1)/np.sqrt(folds):8.5f}", flush=True)
    print("\nRead it this way: for a fixed base and model, (game - draw) is the")
    print("leakage the legal_draw collision buys. GBM-vs-MLP at fixed grouping is")
    print("the architecture effect. E0a reported GBM/game = ~0.050.")


if __name__ == "__main__":
    main()
