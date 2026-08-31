# Phase E2: what to build, depending on the E0b gate

Written 2026-08-31, after E0a passed and E1 finished. Kept in the repo because
Cloud Shell caps sessions at ~40 minutes and its scratch has been wiped three
times in one session; anything needed to resume work belongs under version control.

## Measured ground truth

| fact | value | how measured |
|---|---|---|
| residual static gain over material + search score | **0.050 nats** at a 10 s search | E0a, GBM on 131 features, ply-controlled, game-grouped |
| absorption of that signal by search | **~8%** across 10 ms -> 10 s | E0a paired folds, t = -3.9 |
| 12 hand features over exact material | **+0.013 to +0.016 nats** | E0b dry runs; matches the +0.0140 reference, so the loader is right |
| engine speed | **~18k turn-nodes/sec**, median branching 316 | on-VM benchmark |
| depth 4 @ ws 4 + adaptive | **2.50 s/ply** | on-VM benchmark |
| depth 5 @ ws 4 + adaptive | **7.88 s/ply** | on-VM benchmark, matched fleet rate exactly |
| adaptive widening cost | **+48%** runtime | on-VM benchmark |
| `best_turn_rank` cost | 0.173 s/call, **0.4%** at rank_every=6 | on-VM benchmark |

E1 dataset: `gs://focus-surfer-494820-g0-sigil/runs/20260831T0045Z/data/`,
**316,980 games / 8,197,867 positions**, on-policy at depth 4, `width_scale` 4,
`adaptive (0.10, 2, 6)`, `tfit`. 796 shards, each carrying its generation config in
a `cfg` array. Replaces a 175,500-game set generated at `width_scale` 1.

## The gate

`fit_eval_ladder.py` reports L0 material, L1 the 12 hand features, L2 linear on
131, L3 MLP, L4 MLP + spell conditioning. **Gate: L4 - L1 >= 0.020 nats.**
Everything is grouped by **spell draw**, not by game — see the `legal_draw` note
below.

### A. `L2 - L1` carries most of the gain -> re-price the linear eval

The cheapest outcome and the best precedent: `tfit` was a pure weights change worth
+50 Elo. No net, no node-rate cost, no parity risk.

1. Fit a 131-feature linear model on outcomes, grouped by draw.
2. Export as a new `Weights` variant beside `tfit`; `weights_by_name` must error on
   unknown names, as it already does.
3. Node-rate delta (expect ~0), then SPRT 300 ms -> 3 s -> 60 s.

### B. `L4 - L1 >= 0.020` -> build the eval model

1. **Architecture**: 132 -> 64 -> 32 -> 1 MLP, recomputed per leaf. *Not* an NNUE
   accumulator: the input is 132 dense dims, so ~13k MACs ~ 250 ns ~ 4% of a node,
   while an accumulator would buy desync bugs and a linear-in-deltas constraint
   that rules out mana, cast counters, ply and the liberty census — and a compound
   turn's deltas are not small anyway.
2. **Material stays exact and outside the net**: `eval = exact_material +
   clamped_net_positional`. Terminal conditions stay hand-coded, including the
   asymmetric thresholds (red needs +3, blue +2 — a ±3 lead check, symmetric in
   score).
3. **Loss**: outcome primary + `lambda * search_score` auxiliary head,
   lambda 0.3–1.0, tuned on held-out *outcome* loss. The search score's only
   legitimate role is variance reduction; it must never be the target, because a
   model that fits it has learned to imitate a bounded teacher.
4. **Spell conditioning is free**: the 9-of-39 draw is constant per game, so its
   layer-1 contribution is a constant vector folded into the bias at game start.
   Failure detector: the gain must exceed 0.005 nats **and** concentrate in
   high-sigil-fill positions. Spread evenly -> the mechanism is not what we think,
   drop it.
5. **Tail gates**, not just mean log-loss: `P(p > 0.9 | that side lost)` and the
   99.9th percentile absolute error must not degrade. Alpha-beta maximises over
   leaves, so it seeks the model's largest positive errors.
6. **Export** weights as Rust const arrays — the pattern exists (`HARD_W` in
   `features.rs`, `RANK_W` in `ranker.rs`).
7. **Parity** against the trainer on 10k positions, < 1e-4. The feature extractor
   must be shared bit-for-bit with `features.rs`.
8. **Node-rate delta before any games.** > 5% gets fixed first. Every losing
   campaign in this project paid an unmeasured time cost.
9. **Clamp sweep as parallel SPRT arms** (±192 centistones, then 1x/2x/4x/uncapped).
   Scale alone was once a 300-Elo swing; this sweep likely has a steeper slope than
   the architecture choice.
10. **A test that net-off reproduces the engine node-for-node**, in the shape of the
    existing `adaptive` / `rank_oversample` no-op tests.
11. **SPRT 300 ms -> 3 s -> 60 s**, and require the gain **not to shrink with
    depth**. A gain that fades with depth is being absorbed by search.

### C. `L4 - L1 < 0.020` -> the width classifier

**First, rule out the architecture.** E0a already found 0.050 nats with a GBM. If an
MLP cannot clear 0.020 on 317k games, the honest reading is *wrong model*, not *no
signal*. Add a GBM rung to the ladder before abandoning the direction — an MLP
misconfiguration already produced one false KILL during development.

If the signal really is absent:

1. Labels already exist: `best_rank` is recorded on 1/6 of rows, ~1.37M positions
   carrying where the best move sat in the ordering.
2. Train on all 132 features to predict `P(best move outside width k)`. Incumbent is
   `hard_logit`: 31 hand features, AUC 0.83, worth +21 Elo.
3. Ship as a drop-in, keeping the `(p, easy, hard)` interface.
4. Sweep the threshold and the pair; currently `(0.10, 2, 6)`.
5. SPRT at 3 s (where the +21 was measured), then 60 s.
6. Stretch: a continuous per-node budget rather than binary easy/hard.

## Do either way

- **E0c: Elo per time-doubling** on the shipped engine (3 s vs 6 s, ~2000 games).
  Not yet run, and it prices every eval-cost decision in branch B.
- **Free side experiment**: delete `control`, the 12-layer BFS term. It moves a
  related classifier's AUC by 0.0002. SPRT it alone.

## Offline numbers to refuse to trust

- **AUC** — rank-only, blind to calibration and tails, already saturated.
- **Any position-split holdout.** ~26 positions share one outcome label.
- **Any game-split holdout for spell conditioning.** Group by draw.
- **Any coverage / top-k / best-move-agreement metric against our own engine.** That
  metric predicted Elo backwards twice (learned re-ranker -21, inverted width ramp
  -27) because it scores agreement with a bounded teacher. Banned.
- **Mean log-loss alone** — see the tail gates above.
- **Any Elo from fixed-depth matches.** Eval changes cost time; gate at fixed time.

## Open engine bugs

- `Board::legal_draw(seed)` seeded its xorshift with `seed | 1`, so seeds 2n and
  2n+1 produced the **same** 9-spell draw: every draw appeared exactly twice, seed
  gap exactly 1, in 100% of 2,320 measured games. Spell diversity was half the seed
  count in every seeded dataset, including E0a's. Fix on branch
  `fix-binding-defaults-and-draw` (SplitMix64 finalizer). **It changes which draw
  each seed gives**, so earlier datasets cannot be regenerated bit-identically.
- Seven pyo3 signatures restated `width_scale`, four as `1` against the engine's
  default of `4`, so an omitting caller silently got the unwidened engine. That is
  why the original 4.37M-position set was off-policy. Same branch.

## Infrastructure notes

- Long jobs run on GCE with their own watchdog and a continuous GCS upload loop.
  Cloud Shell sessions die at ~40 minutes; a VM does not.
- Fleets need a per-VM `shard-base` (`runner.sh`), or every VM replays identical
  seeds. Games per shard must stay under the 1000-seed spacing.
- `analyze.sh` / `launch_analyze.sh` run one-shot analysis VMs; they skip the Rust
  build because the ladder needs only numpy and sklearn.
- Capacity, not quota, is usually the binding constraint. `c2d-highcpu-112` was
  unavailable in all four us-central1 zones while `n2d-highcpu-96` had room; probe
  several shapes.
- Never let `rustup` or `pip --user` run without `RUSTUP_HOME` / `CARGO_HOME` /
  `PIP_CACHE_DIR` pointed off `$HOME`: `/home` is a 4.8G filesystem that live data
  collection writes to.
