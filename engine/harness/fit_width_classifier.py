"""Branch C: a better predictor of "the best move lies outside width k".

    fit_width_classifier.py <data_dir> [max_rows] [folds]

The incumbent is `Board::hard_logit`: 31 cheap features (18 sigil fractions + 13
scalars, all popcounts and field reads), fitted on the OLD off-policy dataset and
shipped inside adaptive widening as `(p=0.10, easy=2, hard=6)`, worth +21 Elo.

Two reasons to expect a free win, both about provenance rather than modelling:

  * `HARD_W` was fitted on data generated at `width_scale` 1 and now runs inside a
    `width_scale` 4 search, so it predicts the rank behaviour of a search we do not
    ship. Refitting on 317k on-policy games costs nothing at runtime.
  * we now have ~1.4M on-policy rows with `best_rank`, against whatever the original
    fit used.

COST DISCIPLINE. Today's measurement: `evaluate` (12 features) is 149 ns and 1.0-1.3%
of a node; `full_features` (132) is 1351 ns and 9-12%, which fails the 5% node-rate
gate. `scale_for` runs this classifier per node, so the same discipline applies. The
31 incumbent features are all cheap. Of the rest:

    occupancy  (idx 0..77)    near-free bit shifts
    castable   (idx 96..113)  two `castable()` calls + position_of -- moderate
    liberty    (idx 125..128) two liberty_census calls -- moderate
    control    (idx 129)      12-LAYER BFS -- never add this

so candidates are ranked by gain per nanosecond, and `control` is excluded by
construction.

LABEL CAVEAT: `best_rank` was recorded via `best_turn_rank(..., cap=400,
width_scale=1)`, so the move called "best" was chosen by a width-1 search. The
ordering position itself is width-independent, but the target inherits a weaker
teacher than the shipped engine.
"""
import glob, os, sys
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold

# full_features layout, read off features.rs
OCC = list(range(0, 78))
SIG = list(range(78, 96))          # 9 mine + 9 theirs sigil fractions
CASTABLE = list(range(96, 114))
SCAL_HARD = [114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 130, 131]
LIBERTY = [125, 126, 127, 128]
CONTROL = [129]
HARD_IDX = SIG + SCAL_HARD          # exactly the 31 hard_logit inputs, in order

HARD_BIAS = -0.00081
HARD_W = np.array([
    0.40639, -0.33818, -0.62829, 0.30003, 0.15960, 0.30633, 0.18265, 0.27887, 0.12354,
    0.70531, -0.19231, -0.43788, 0.17759, -0.15970, -0.00014, -0.05098, -0.10145, -0.12445,
    0.17338, -0.08686, 0.14656, -0.04456, -0.05578, -0.19427, -0.03855, -0.07404,
    0.01490, -0.25468, -0.11808, 0.00331, 0.34646,
])
assert len(HARD_IDX) == len(HARD_W) == 31


def ll(p, y):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))


def main():
    data_dir = sys.argv[1]
    cap = int(sys.argv[2]) if len(sys.argv) > 2 else 900_000
    folds = int(sys.argv[3]) if len(sys.argv) > 3 else 5

    F, R, SP, G = [], [], [], []
    for f in sorted(glob.glob(os.path.join(data_dir, "*.npz"))):
        d = np.load(f, allow_pickle=True)
        k = d["best_rank"]
        m = k >= 0                      # rank_every left the rest at -1
        if not m.any():
            continue
        F.append(d["full"][m]); R.append(k[m]); SP.append(d["spells"][m]); G.append(d["game"][m])
    F = np.concatenate(F).astype(np.float64)
    R = np.concatenate(R).astype(np.int64)
    SP = np.concatenate(SP); G = np.concatenate(G)
    draw = np.array([hash(tuple(r)) for r in SP], dtype=np.int64)
    print(f"{len(R)} rows with a recorded best_rank | {len(np.unique(G))} games "
          f"| {len(np.unique(draw))} draws")
    print(f"rank: median {np.median(R):.0f}  p75 {np.percentile(R,75):.0f}  "
          f"p90 {np.percentile(R,90):.0f}  p99 {np.percentile(R,99):.0f}  max {R.max()}")

    if len(R) > cap:
        u = np.unique(draw)
        keep = np.random.default_rng(0).permutation(u)[:max(1, int(len(u) * cap / len(R)))]
        m = np.isin(draw, keep)
        F, R, draw, G = F[m], R[m], draw[m], G[m]
        print(f"subsampled by draw to {len(R)} rows")

    splits = list(GroupKFold(n_splits=folds).split(F, R > 24, draw))
    lin = lambda: LogisticRegression(C=1.0, max_iter=4000)
    gbm = lambda: HistGradientBoostingClassifier(
        max_iter=250, learning_rate=0.06, max_leaf_nodes=31,
        l2_regularization=1.0, min_samples_leaf=100, random_state=0)

    # ---- the incumbent, scored on on-policy data --------------------------------
    y24 = (R > 24).astype(float)
    inc = HARD_BIAS + F[:, HARD_IDX] @ HARD_W
    inc_p = 1.0 / (1.0 + np.exp(-inc))
    print(f"\nbase rate P(rank > 24) = {y24.mean():.4f}")
    print(f"INCUMBENT shipped HARD_W:  AUC {roc_auc_score(y24, inc):.4f}  "
          f"logloss {ll(inc_p, y24):.5f}")

    # ---- candidates, all evaluated on the same folds ----------------------------
    cands = [
        ("31 incumbent feats, refit", HARD_IDX, lin, "cheap (= today)"),
        ("31 + liberty census",       HARD_IDX + LIBERTY, lin, "moderate"),
        ("31 + castable flags",       HARD_IDX + CASTABLE, lin, "moderate"),
        ("31 + occupancy planes",     HARD_IDX + OCC, lin, "near-free"),
        ("all cheap (31+occ+lib+cast)", HARD_IDX + OCC + LIBERTY + CASTABLE, lin, "moderate"),
        ("31 incumbent feats, GBM",   HARD_IDX, gbm, "NOT PORTABLE - upper bound"),
    ]
    print(f"\n{'candidate':<30}{'dims':>6}{'AUC':>8}{'logloss':>10}{'vs inc':>9}  cost")
    inc_auc = roc_auc_score(y24, inc)
    results = {}
    for name, idx, model, cost in cands:
        X = F[:, idx]
        aucs, lls = [], []
        for tr, te in splits:
            m = model().fit(X[tr], y24[tr])
            p = m.predict_proba(X[te])[:, 1]
            aucs.append(roc_auc_score(y24[te], p)); lls.append(ll(p, y24[te]))
        results[name] = (np.mean(aucs), np.mean(lls))
        print(f"{name:<30}{len(idx):6d}{np.mean(aucs):8.4f}{np.mean(lls):10.5f}"
              f"{np.mean(aucs)-inc_auc:+9.4f}  {cost}")

    # ---- what the search actually experiences -----------------------------------
    # Elo comes from spending `hard` width where it pays. At a fixed fraction of
    # nodes widened, a better model catches more of the genuinely hard ones.
    print("\noperating points, refit on the 31 cheap features (draw-grouped OOF)")
    X = F[:, HARD_IDX]
    oof = np.zeros(len(y24))
    for tr, te in splits:
        oof[te] = lin().fit(X[tr], y24[tr]).predict_proba(X[te])[:, 1]
    print(f"{'widened share':>14}{'recall NEW':>12}{'recall INC':>12}{'delta':>8}")
    for share in (0.05, 0.10, 0.20, 0.30, 0.50):
        tn = np.quantile(oof, 1 - share); ti = np.quantile(inc, 1 - share)
        rn = (oof >= tn)[y24 == 1].mean(); ri = (inc >= ti)[y24 == 1].mean()
        print(f"{share:14.2f}{rn:12.4f}{ri:12.4f}{rn-ri:+8.4f}")

    # ---- graded budget: is one threshold leaving value on the table? ------------
    print("\nseparate targets, refit on the 31 cheap features")
    for k in (6, 24, 96):
        yk = (R > k).astype(float)
        aucs = []
        for tr, te in splits:
            m = lin().fit(X[tr], yk[tr])
            aucs.append(roc_auc_score(yk[te], m.predict_proba(X[te])[:, 1]))
        print(f"  P(rank > {k:3d}):  base rate {yk.mean():.4f}   AUC {np.mean(aucs):.4f}")

    # ---- calibrate v2 to the incumbent's OPERATING POINT ------------------------
    # The arena applies ONE threshold to whichever model is selected. If v2's score
    # distribution differs, the same threshold widens a different share of nodes and
    # the A/B confounds "targets better" with "widens more". Shift v2's bias so that
    # at the shipped p it widens exactly the share the incumbent does, making the
    # comparison purely about targeting quality at equal cost.
    t_ship = np.log(0.10 / 0.90)
    share_inc = float((inc >= t_ship).mean())
    oof_logit = np.log(np.clip(oof, 1e-9, 1 - 1e-9) / np.clip(1 - oof, 1e-9, 1 - 1e-9))
    # the v2 logit that widens `share_inc` of nodes
    t_new = float(np.quantile(oof_logit, 1 - share_inc))
    delta = t_ship - t_new          # add to the bias so t_ship lands on that point
    print(f"\nincumbent widens {share_inc*100:.2f}% of nodes at p=0.10 "
          f"(logit {t_ship:.5f})")
    print(f"v2 raw would widen {float((oof_logit >= t_ship).mean())*100:.2f}% -- "
          f"bias shift {delta:+.5f} makes it {share_inc*100:.2f}%")
    for share in (0.05, 0.10, 0.20, 0.30, 0.50):
        print(f"  share {share:.2f}: incumbent logit "
              f"{float(np.quantile(inc, 1-share)):+.4f}   "
              f"v2 logit {float(np.quantile(oof_logit, 1-share)):+.4f}")

    # ---- emit the port ----------------------------------------------------------
    final = lin().fit(X, y24)
    w = final.coef_[0]; b = float(final.intercept_[0]) + delta
    print(f"\n// refit on {len(y24)} on-policy rows, AUC {results['31 incumbent feats, refit'][0]:.4f}, "
      f"bias shifted {delta:+.5f} to match the incumbent's {share_inc*100:.2f}% widened share")
    print(f"const HARD_BIAS: f32 = {b:.5f};")
    print("const HARD_W: [f32; 31] = [")
    for i in range(0, 31, 9):
        print("    " + ", ".join(f"{x:.5f}" for x in w[i:i+9]) + ",")
    print("];")
    for p in (0.05, 0.10, 0.20, 0.30):
        print(f"// threshold for p={p}: logit {np.log(p/(1-p)):.5f}")


if __name__ == "__main__":
    main()
