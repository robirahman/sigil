# Plan: simplify the hand-written evaluation (2026-10)

**Decision (Robi, 2026-10-14):** remove the hand evaluation's positional terms and its
per-spell sigil table, so the shipped evaluation becomes material + tempo + the network.
Also test raising the network's correction cap from ±256 to ±512 cs.

**Status:** plan only, not yet run.

**Prerequisite:** merge PR #23 first. Its review fixes touch `eval.rs`, `features.rs` and
`nn.rs`, and so does this plan.

## Why

The shipped eval `nnue_spell4` is `tfit_spell_v2` plus the net's correction, capped at ±256
cs. Interpretability experiment 1 (`engine/reports/2026-10-interpretability.md`) measured how
each part contributes:

| Part | Share of the shipped eval's variance |
|---|---|
| Material, 100 cs per stone of score lead | 47% |
| Net correction | 52% |
| Positional terms (near threshold, four liberty counts, sigil stones and charged, mana, sixth-spell danger, map control, void) together | under 1.5% |
| Per-spell sigil table | 0.6% |

The positional terms are scaled by 96/7548, so a mana node is worth about 1 cs. They still
cost search time: map control is a 12-step flood fill at every leaf, and the liberty census
also runs at every leaf.

Experiment 6 found that new positional terms fitted on outcomes do not help either. Adding
any of seven candidates to the hand eval lost Elo or was level.

## What must not change: the displayed numbers

The display divides by 100 and subtracts `search::even_offset = lead - tempo`, from red's
side. With `lead` = 100 and `tempo` = 50 kept:
- 0.0 is still an even game, including the start;
- +1.0 is still 100 cs, the material value of one stone.

Removing the positional sum changes a static reading by at most 0.96 (its worst-case budget)
and typically by a few hundredths.

**Keep:**
- `lead` = 100;
- `tempo` = 50;
- the even-game offset;
- the win and mate handling in the search.

The measured "an extra stone is worth 1.49 at depth 4" is an interpretability finding. It does
not change what +1.0 means.

## Steps

### 1. Does the shipped net need the terms at all? No retraining.

1. Add the preset `nnue_spell4_mt = Weights { nn: Some(&NNUE_SPELL4), ..MATERIAL_TEMPO }` in
   `eval.rs`, default off. `MATERIAL_TEMPO` is the existing `mtempo` preset: lead 100,
   tempo 50, everything else 0.
2. Run `cargo test`. Check that `even_offset` and `search::report` give the same display
   offset for both presets.
3. Measure speed: nodes per second of `nnue_spell4_mt` against `nnue_spell4` on 200 sampled
   midgame positions, at the same depth.
4. Arena: `nnue_spell4_mt:nnue_spell4` with the `preset` knob, 10 s, `SIGIL_AB_BASE=shipped`.
   - Use a wide fleet: 4 or more c3d-highcpu-90 VMs with distinct `SHARD_BASE`, about 1,000
     games.
   - Also run Rock Slide draws (`SIGIL_REQUIRE_SPELL`), as for v30.
5. Decision:
   - level or better: go to step 2;
   - clearly worse: the net leans on the hand terms; still go to step 2, since retraining on
     the new base lets it absorb them.

### 2. Retrain on the simpler base, at two caps

1. Prep the round-4/5 training data with an `mtempo` evaluation column. Use `nn_eval.py prep
   ... --evals mtempo,tfit_spell_v2,nnue_spell4`. The existing
   `gs://…/data/r4/prep_v27r4_d4_rs.npz` has no `ev_mtempo` column, so it needs a re-prep.
   Include the round-5 data plan's new sources: `gs://…/data/r5/data_plan.json`, which lists
   the human positions in `data/r5/human_e9/d4/` and the v31 self-play.
2. Train two nets with the `nnue_spell4` recipe; only `--cap` differs:
   - `--base mtempo --lam 0.5 --qat 2 --split game`, 8 epochs, `--cap 256`;
   - the same with `--cap 512`.
3. Compare on held-out games:
   - outcome log-loss (`net_quant.outcome_ll`), against `nnue_spell4` on its own base;
   - the share of positions at the cap (`at_cap`). The cap-256 net's share should stay near
     today's 2.7% self-play and 7.0% human.
4. Arenas:
   - each new net (`nnue_mt256`, `nnue_mt512`, presets on `MATERIAL_TEMPO`) against
     `nnue_spell4` at 10 s;
   - `nnue_mt512` against `nnue_mt256` at 10 s.

   Both on wide fleets, with a push notification when each finishes.
5. Ship rules:
   - ship the simplified base only on a non-negative Elo interval against the shipped
     evaluation;
   - ship cap 512 only if it is at least level with cap 256.

### 3. Why test 512 and not remove the cap

- **Where the cap binds.** The ±256 cap hits on 2.7% of self-play positions and 7.0% of human
  ones. These are mostly already-decided positions: experiment 5's clusters at +240 to +256
  went on to win 99%.
- **What it costs there.** A capped evaluation cannot rank one winning move above another,
  which can slow conversions. Human games are sharper and hit the cap 2.6x as often.
- **What it guards against.** An untrained corner of the net producing a huge number in an
  unfamiliar position, and the search margins that assume a modest eval range: the ±60
  aspiration window, the stone-lead pre-pass and the null-move margins.
- **Before shipping 512,** check those margins on positions where the 512 net reads above
  ±2.56.
- **No numeric limit.** The net output is computed in 1/4096 stone with 64-bit accumulation,
  so 512 has no overflow concern.

### 4. Clean up `eval.rs` once a simplified eval ships

**Remove:**
- the presets that exist only for old A/B tests;
- PR #23's experiment-6 `Weights` fields `colour` and `extra`, and the `tfit_x_*` presets
  (no candidate earned Elo);
- the per-spell sigil table and the positional fields, if no remaining preset uses them.

**Keep:**
- `material` and `mtempo`;
- whatever the Easy and Medium tiers play. Check `rust-ai.js` / the tier options before
  deleting anything a tier uses;
- the `evaluate == dot(hand_features)` test, updated to the remaining terms.

**Ship it the usual way:**
- bump `SHIPPED_EVAL`, the engine version and the `sw.js` cache version;
- rebuild the wasm (`build-wasm.sh` and `build-wasm-mt.sh`);
- update `EVAL_NAMES` and its error message, and `docs` if they name the eval.
