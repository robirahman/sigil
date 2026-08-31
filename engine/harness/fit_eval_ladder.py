"""E0b: how much outcome signal is learnable from a static Sigil position?

    fit_eval_ladder.py <data_dir> [max_positions] [folds]

Five rungs, each predicting "did the side to move go on to win?" from the position
alone -- no search score anywhere. E0a already answered the adjacent question (how
much of this survives a search); this one asks how much there is to begin with.

    L0  exact material only            the floor
    L1  material + the 12 hand features    what the engine evaluates TODAY
    L2  linear on all 131 live features    what a better-priced linear eval could do
    L3  MLP on the same 131                what nonlinearity adds
    L4  L3 + the game's 9 spell ids        what conditioning on the draw adds

> KILL GATE: if L4 - L1 < 0.020 nats, stop. Calibration is 0.013 nats -> +50 Elo
> from the tfit campaign, n=1, so discount hard beyond the first 0.02.

Three rules this file exists to enforce, each of which we have already violated
once and paid for:

* **Split by GAME, never by position.** ~21 positions share one outcome label, so a
  position split leaks the label across the boundary and inflates every number
  until SPRT finds out months later. Effective N is the game count.
* **No colour-symmetry augmentation.** Red needs +3 and blue +2, blue holds the
  token and wins repetition. `is_red` is an input, not a symmetry to fold away.
* **Report tails, not just the mean.** Alpha-beta maximises over leaves, so it
  actively seeks the model's largest positive errors. A rung that improves mean
  log-loss while fattening its tail will lose Elo. Both tail metrics below are
  printed for every rung; treat a rung that wins the mean and loses the tail as
  unproven, not as a win.
"""
import glob, os, sys
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
from sklearn.model_selection import GroupKFold

KILL_GATE = 0.020


def load(data_dir):
    """Concatenate shards, keeping `game` ids globally unique.

    Shard files already encode their offset in `game` (off * 1_000_000 + i), but
    that is only unique if every shard really ran a distinct offset -- which is
    exactly what the fleet shard-base bug broke. Verify rather than assume.
    """
    files = sorted(glob.glob(os.path.join(data_dir, "*.npz")))
    if not files:
        sys.exit(f"no .npz under {data_dir}")
    cols = {k: [] for k in ("hand", "full", "spells", "ply", "is_red", "y", "game")}
    cfgs = set()
    for f in files:
        d = np.load(f, allow_pickle=True)
        if len(d["y"]) == 0:
            continue
        for k in cols:
            cols[k].append(d[k])
        if "cfg" in d.files:
            cfgs.add(tuple(str(x) for x in d["cfg"]))
    out = {k: np.concatenate(v) for k, v in cols.items()}
    if len(cfgs) > 1:
        sys.exit(f"shards disagree on generation config, refusing to pool: {cfgs}")
    out["cfg"] = next(iter(cfgs), ("<no cfg recorded>",))
    return out, len(files)


def ll(p, y):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))


def tails(p, y):
    """Confident-and-wrong rate, and the worst per-position error.

    The mean is what training optimises; these are what search exploits.
    """
    lost = y == 0
    overconfident = float(np.mean(p[lost] > 0.9)) if lost.any() else float("nan")
    return overconfident, float(np.percentile(np.abs(p - y), 99.9))


def main():
    data_dir = sys.argv[1]
    cap = int(sys.argv[2]) if len(sys.argv) > 2 else 600_000
    folds = int(sys.argv[3]) if len(sys.argv) > 3 else 5

    d, nfiles = load(data_dir)
    y, game = d["y"].astype(float), d["game"]
    print(f"{nfiles} shards | {len(y)} positions | {len(np.unique(game))} games "
          f"| {len(y)/max(len(np.unique(game)),1):.1f} positions/game")
    print(f"generation config: {' '.join(d['cfg'])}")

    # Subsample by GAME, so the holdout stays honest and games stay intact.
    games = np.unique(game)
    if len(y) > cap:
        rng = np.random.default_rng(0)
        keep = rng.permutation(games)[:max(1, int(len(games) * cap / len(y)))]
        m = np.isin(game, keep)
        d = {k: (v[m] if isinstance(v, np.ndarray) and len(v) == len(y) else v)
             for k, v in d.items()}
        y, game = d["y"].astype(float), d["game"]
        print(f"subsampled to {len(y)} positions / {len(np.unique(game))} games")

    H, F, SP, R = d["hand"].astype(float), d["full"].astype(float), d["spells"], d["is_red"]
    z = lambda A: (A - A.mean(0)) / (A.std(0) + 1e-9)
    live = F.std(0) > 1e-9
    MAT = z(H[:, :1])
    L1 = np.column_stack([MAT, z(H[:, 1:]), R[:, None]])
    L2 = np.column_stack([MAT, z(F)[:, live], R[:, None]])
    # One-hot the 9 spell ids: the draw is constant per game, so this is the
    # conditioning the deployed net folds into its layer-1 bias for free.
    nsp = int(SP.max()) + 1
    SPOH = np.zeros((len(y), nsp), dtype=np.float32)
    SPOH[np.repeat(np.arange(len(y)), SP.shape[1]), SP.ravel()] = 1.0
    L4 = np.column_stack([L2, SPOH])

    lin = lambda: LogisticRegression(C=0.1, max_iter=5000)
    mlp = lambda: MLPClassifier(hidden_layer_sizes=(64, 32), alpha=1e-3,
                                learning_rate_init=3e-3, max_iter=60,
                                early_stopping=True, n_iter_no_change=5,
                                random_state=0)
    rungs = [("L0 material",        MAT,  lin),
             ("L1 12 hand feats",   L1,   lin),
             ("L2 linear 131",      L2,   lin),
             ("L3 MLP 131",         L2,   mlp),
             ("L4 MLP + spells",    L4,   mlp)]

    splits = list(GroupKFold(n_splits=folds).split(MAT, y, game))
    print(f"\n{'rung':<20}{'logloss':>10}{'+-se':>8}{'vs L1':>9}"
          f"{'conf-wrong':>12}{'p99.9 err':>11}")
    res = {}
    for name, X, mk in rungs:
        per, ow, pe = np.zeros(folds), [], []
        for i, (tr, te) in enumerate(splits):
            p = mk().fit(X[tr], y[tr]).predict_proba(X[te])[:, 1]
            per[i] = ll(p, y[te])
            a, b = tails(p, y[te])
            ow.append(a); pe.append(b)
        res[name] = per
        vs = f"{(res['L1 12 hand feats'] - per).mean():+.4f}" if 'L1 12 hand feats' in res else ""
        print(f"{name:<20}{per.mean():10.5f}{per.std(ddof=1)/np.sqrt(folds):8.5f}"
              f"{vs:>9}{np.mean(ow):12.4f}{np.mean(pe):11.4f}")

    gain = (res["L1 12 hand feats"] - res["L4 MLP + spells"])
    se = gain.std(ddof=1) / np.sqrt(folds)
    print(f"\nL4 - L1 = {gain.mean():+.5f} +- {se:.5f} nats  (gate {KILL_GATE})")
    print("VERDICT:", "PASS" if gain.mean() >= KILL_GATE else
          "KILL -- learned eval is not worth the port")
    # The plan's own failure detector for conditioning.
    sc = (res["L3 MLP 131"] - res["L4 MLP + spells"]).mean()
    print(f"spell conditioning alone: {sc:+.5f} nats "
          f"({'keep' if sc > 0.005 else 'drop, keep the simpler net'})")


if __name__ == "__main__":
    main()
