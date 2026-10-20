# Simplifying the hand-written evaluation: engine v32 (2026-10-20)

**What shipped.** `SHIPPED_EVAL` is now `nnue_mt256`: material plus tempo, plus a network
trained on that base and capped at ±256 cs. It replaces `nnue_spell4`, which was
`tfit_spell_v2` plus a net. The positional hand terms (near-threshold, liberties, sigil
stones and charges, mana, sixth-spell danger, map control, void) and the per-spell sigil
table no longer take part in the shipped evaluation. The plan was
`engine/eval_simplification_plan.md`.

**Why.**
* The interpretability work (`2026-10-interpretability.md`) found that material explains 47%
  of the shipped evaluation's variance and the net 52%. All the positional terms together
  explained under 1.5%: they are scaled by 96/7548, so a mana node was worth about 1 cs.
* They still cost a map-control flood fill and a liberty census at every leaf.
* Experiment 6 found that new outcome-fitted hand terms do not win Elo either.

**What did not change.** Evaluations display as before. The display offset is
`lead - tempo` (100 - 50), and both are kept:
* 0.0 is an even game;
* +1.0 is one stone of material.

## Results

All arenas: 10 s per move, the shipped search, colours swapped, Spot c3d-highcpu-90 VMs.

| Step | Test | Result |
|---|---|---|
| 1 | `nnue_spell4`'s net on material + tempo, no retraining, against `nnue_spell4` | core −10.0 [−24.6, +4.7] (2,160 games); Rock Slide draws −5.8 [−26.5, +14.9] (1,080). Level. About 2% faster per position. |
| 2 | Retrained on material + tempo: `nnue_spell4`'s recipe and data plus the round-5 human positions and v31 self-play, 21.1M training and 5.9M held-out positions | held-out outcome log-loss 0.58115 at cap 256 and at cap 512, against 0.58139 for `nnue_spell4`. Share at the cap: 3.5% (256), 0% (512; largest output 431). |
| 2 | `nnue_mt256` against `nnue_spell4` | core −3.0 [−18.9, +12.8] (1,841 games; one VM preempted); Rock Slide draws +3.2 [−17.5, +23.9] (1,080). **Shipped.** |
| 2 | `nnue_mt512` against `nnue_spell4` | core −13.2 [−27.9, +1.5]; Rock Slide draws +7.1 [−13.6, +27.8] |
| 2 | `nnue_mt512` against `nnue_mt256` | +9.3 [−5.3, +24.0] (2,160 games) |

**The decision.** Every result was level.
* `nnue_mt256` gives the simpler, faster evaluation at no measured cost.
* Cap 512 showed no gain in prediction or play, so the tighter cap stays as the guard against
  outlier outputs.
* Plain material + tempo cannot be computed from older prepared data, because Providence bank
  stones count as material. The training data therefore had to be re-prepped
  (`gs://…/data/es/prep_es_mt.npz`).

## Changes

* **Engine:** `nets/nnue_mt256.bin` with 264 golden vectors (Rust equals the Python forward
  pass), and `SHIPPED_EVAL = "nnue_mt256"`.
* **Browser:** the RustAI, worker and game-review defaults, engine v32, cache v77, and both
  wasm builds rebuilt.
* **Removed:** the experiment-only `Weights` fields `colour`/`extra`, the `tfit_x_*` presets,
  and the trial presets `nnue_spell4_mt` and `nnue_mt512`.
* **Kept on purpose:**
  * The hand-term machinery: older presets, the stored 15-column hand features and the fitting
    harnesses still use it. Only the shipped evaluation stopped using it.
  * `nnue_spell4`, as the rollback and comparison point.

## Data

`gs://focus-surfer-494820-g0-sigil/data/es/`:
* the prep file and run lists;
* `es1_result.txt`, `es2_result.txt`;
* the training runs `runs/20261020T010106Z-sigil-es-train256` and
  `runs/20261020T010128Z-sigil-es-train512`.

## Also from this working session (2026-10-12 to 10-20), for context

* **Browser multithreading:** PR #20.
* **Engine spell-values report and the Spells page toggle:** PR #21.
* **Label-depth test:** depth-5 labels at parity with depth 4, so round 5 keeps depth 4.
* **Native threads:** +58 Elo at 10 s.
* **Wide nets:** not better.
* **Interpretability plan and results:** PRs #22 and #23.
* **Round-5 data plan:** `gs://…/data/r5/data_plan.json`, adding the human positions and the
  v31 self-play.
