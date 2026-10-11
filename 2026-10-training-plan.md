# Engine strength plan, October 2026

What to do next to make the Rust engine stronger, in order, with the gate for each step. Read with
`engine/STATUS.md` (current shipped config) and `engine/FINDINGS.md` (the experiment log). Results go
into FINDINGS as they come in, and this file gets edited when a step is done or dropped.

The Python AlphaZero stack in `ai/` (SigilNet, MCTS, `selfplay_mcts.py`, `train_sigil*.py`) is
**not** part of this plan and is not what the site plays; see "History" at the end.

## 0. Where we are

* **Shipped:** engine v21, eval `tfit`, `width_scale` 4 with adaptive widening, exact clock,
  pondering, pass-as-null-move, LMR band, stone-lead and swing pre-passes. Every vs-AI tier on the site
  is this engine as single-threaded wasm.
* **Against humans:** the Rust Hard tier (10 s) scored 35% against the same strong humans the JS tiers
  scored 7.5% against, so it is roughly 100-150 Elo short of them (FINDINGS "§0.1"; one player is most
  of the sample). It loses 87% of games that last 40-49 turns.
* **Why it loses** (FINDINGS "Where the engine is surprised", 284 confirmed falls):
  * 152 are a **one-ply horizon**: the engine predicted the human's reply and misjudged what came next.
    Depth 5 instead of 4 sees most of them.
  * 102 are turns **the generator never produces**: a dash with a particular sacrifice pair (47), a
    particular cast resolution or keep (38, Storm Front first), a dash landing (8), plus 9 past the
    enumeration cap.
  * Only 26 are a progressive-widening (width) problem.
* **What we already know about costs:**
  * Generating turns is almost the whole cost of a search node (`search.rs`, `rank_oversample` doc).
    Raising generator budgets across the board (`dash4`, `outsel`) lost Elo, because every node paid
    for it.
  * Evaluation is about 5% of a node (FINDINGS "§1.0-1.1" profile), so a richer eval is cheap here.
  * The perfect-ranker oracle covers 98% of best moves at an average width of 10.5 candidates,
    against 96 today (FINDINGS "Adaptive widening").

So there are two levers: produce the right candidates instead of more of them (a learned policy inside
the generator), and price positions better per spell (a learned eval). Both want the same training
data. A third lever needs no data: more than one core.

## Ground rules (from STATUS.md, restated because each one has cost a campaign)

* Gate every change with a **fixed-time** colour-swapped arena on the fleet (`engine/gcp/launch.sh`,
  `harness/ab_search.py`), pooled with `pool_shards.py`. Split by spell draw where a change is
  spell-specific.
* Run `engine/gcp/smoke_knobbite.py`-style proof that a knob actually changes play through
  `play_best` before spending on an SPRT.
* Distinct `SHARD_BASE` per VM; the shard offset travels in `$SIGIL_SHARD_OFF`, never argv.
* **Size data runs from a measured rate**, not an extrapolation: run one shard for 30 minutes first.
  The 2026-09 prior-label run assumed 36 s/game and measured 170 s/game.
* Write data atomically (temp file plus `os.replace`) and checkpoint often.
* A new eval or prior ships only if it is computed identically in native and wasm. Pin that with a
  test, the same way `evaluate == dot(weights, hand_features)` is pinned.

## Step 1. Fixed benchmarks from the human games (do first; mostly exists)

The Firebase `completed_games` (low thousands, mostly strong humans beating the AI) are too few and
too selected to train a model on. They are the best **test set** we have, because they contain the
turns self-play never plays.

1. Refresh the dump:
   `python engine/harness/eval_games.py download --since 2026-08-26 --service-account <sa.json> --out work/raw.json`,
   then `hydrate --raw work/raw.json --out work/lines.json`. Apply the audit filters (fat records,
   no-op sacrifices, transcription glitches; FINDINGS "the enumeration campaign closes at ZERO") and
   the rule-change cutoffs in `ai/data_filters.py`.
2. Freeze three suites and commit them under `ai/data/benchmarks/`:
   * the 284 surprise cases (`ai/data/surprise_audit_2026-09-26.json`) plus any new ones from a
     re-run of `surprise_audit.py` on games since then;
   * the 120 confirmed human finds (`ai/data/human_turn_drops_2026-09-23.json`);
   * the 61 final-blow misses (`engine/harness/final_blow_probe.py` output).
3. Two metrics, both at a **fixed node budget**, so a change that only spends more nodes can't
   flatter itself:
   * **human-turn coverage**: the fraction of human turns the generator emits within the first N
     candidates (`sigil_engine.rank_of_result`, `reach_of_turn`, `human_move_dash_turn`);
   * **surprise sees-rate**: the fraction of surprise cases where the search of the position before
     the reply lands within 0.5 stones of the depth-6 target.

These measure exactly the class self-play arenas can't ("neither side plays those dashes"). Every
step below reports them alongside its arena.

## Step 2. Per-spell eval terms (days; no new Rust needed to fit)

`tfit` treats a stone on a sigil, or a charged sigil, the same whatever spell is there. Fireblast
charged and Grow charged are not the same threat.

1. **Data.** `engine/harness/selfplay_data.py` already writes, per position: `full_features`
   (per-sigil fill fractions and castable flags for both sides, in slot order), `spell_ids` (in slot
   order), the depth-D search score and the eventual winner. If the 2026-09 shards (FINDINGS "Policy-label data": 4.4M
   positions, 4.0M with a search score) are still in the fleet bucket under `…/data/`, check they
   carry these fields and use them. Otherwise
   regenerate 1M positions at depth 4-5.
2. **Fit offline.** Extend the texel fit with features `fill(sigil) x onehot(spell at sigil)` and
   `castable(sigil) x onehot(spell)`, mine minus theirs: 39 x 2 new columns, sparse. Fit against the
   **search score** (logistic of score) as well as against the outcome, and report both. FINDINGS
   showed fitted magnitudes help and fitted signs from outcomes can hurt (`tflip`), so regularise
   towards the shared `sigil_stone` / `sigil_charged` weights and check the signs by hand.
3. **Ship as a lookup.** Add a per-game `[i32; 9]` table to the eval (spell weight looked up per
   slot when the board is set up), keep the result under the 96-centistone positional budget
   (`at_budget`), extend `hand_features` so the `evaluate == dot` test still holds, and add a preset
   (`tfit_spell`). The per-node cost should be nil; confirm with `engine/examples/bench.rs`.
4. **Gate:** offline log-loss on a spell-held-out split must beat `tfit`; then a fixed 3 s arena,
   then 10 s, against `tfit`, split by draw.

## Step 3. Training-data pipeline v2 (the shared foundation for steps 4 and 5)

One self-play generator that writes both value and policy targets.

1. **New binding:** expose `Search::root_scores()` (`search.rs`; only `mate.rs` reads it today) as
   `PyBoard.root_scores_and_play(depth, ...)`, returning every searched root candidate's `turn_parts`
   (`prior.rs`) and score. One search then gives 70-300 graded policy targets instead of one chosen
   move. Root candidates outside the width get no score; record that they were not searched rather
   than treating them as bad.
2. **Exploration outside the generator.** Self-play alone reinforces the generator's blind spots. At
   a fraction of positions (start at 10%), draw extra turns from the **full** enumeration
   (`enumerate_turns_capped`) that the ordered stream did not emit (unusual sacrifice pairs, cast
   outcomes and keeps first), score each with a depth D-1 search of the resulting position, and add
   them to the policy targets.
3. **Start positions.** Half the games from fresh draws (standard and competitive, a few random
   opening plies as `selfplay_data.py` does now); half from positions in the hydrated human games,
   weighted towards turn 20 and later, since long games are where the AI loses and self-play games
   are shorter.
4. **Record per position:** SFN, spell ids, `full_features`, side to move, depth-D score, root
   candidates (parts, score, searched or exploration), and the eventual winner of the self-play
   continuation.
5. **Depth and size.** Use depth 4-5 labels: a median depth-4 search is about 30k nodes, so by
   estimate a 90-vCPU VM labels on the order of a million positions an hour (measure it; see the
   ground rules). Depth 7, as in the 2026-09 run, measured only 20 labels per shard-hour. Target 20M
   positions for the first round.
6. **Iterate.** Once steps 4/5 ship a model, regenerate with it (expert iteration). Keep each round's
   data tagged by engine version so a rule change can be filtered out later
   (`ai/data_filters.py` has the pattern).

## Step 4. A learned policy inside the generator (largest expected gain)

The linear re-ranker (`ranker.rs`, `rank_oversample`) scored finished turns, so it had to generate
more than it expanded, and that doubled node cost. The policy has to sit **at the generator's choice
points** so low-probability branches are never built:

* first move, then continuation stub (pass / dash / cast), then dash landing, then sacrifice pair,
  then cast outcome and keep, then the second cast under Seal of Summer.
* Each choice point expands its options best-first by learned score, and the fixed budgets (2 pairs
  per landing, cast window 16, keep window 2) become "options until X% of the probability is covered,
  with a floor and a cap".

Steps:

1. **Model.** Start linear or a tiny MLP per choice point over a position context (`prior.rs`
   `context_inputs`, 170 integers) and the option's parts (`turn_parts`, 284-word vocabulary), with
   spell identity in the context. It must be closed-form from the current board (no `apply_turn`),
   like the ranker, and cost no more than the heuristic scoring it replaces.
2. **Offline gate 0** (`harness/prior_gate0.py`): stream-rank coverage and stub-oracle coverage on
   held-out games. Target: the w24 coverage of today's ordering at w10-12. Then human-turn coverage
   on the Step 1 suite at equal generated-turn count.
3. **Engine gate:** node rate within 10% of today (`bench.rs`), then the surprise sees-rate at fixed
   nodes.
4. **Arena:** fixed 3 s, then 10 s, against the shipped engine. Expect the policy to let
   `width_scale` come down (spend the saved nodes on depth); re-tune width once it is in.

## Step 5. A small spell-conditioned network eval

The verdict in STATUS.md that a learned eval is closed rests on `engine/harness/fit_learnability.py`:
a scikit-learn MLP with 64 and 32 hidden units, trained on single game outcomes, whose 132 input
features carry **no spell identities**. That is not evidence against a spell-aware network trained on
search scores.

1. **Architecture.** Inputs are the 78 occupancy bits (39 nodes x 2 colours). Because the 9-spell draw
   is fixed for a game, fold spell conditioning into the first layer **once per game**: the weight row
   for (node, colour) is a base row plus an embedding of the spell on that node's sigil and the node's
   place in it. Per-node cost is then a plain sparse accumulator, updatable incrementally as stones
   change. Accumulator around 128-256, two small hidden layers, int16/int8 quantised. Output in
   centistones, still under the material-dominance budget unless an arena says otherwise.
2. **Train** on Step 3 data: target a blend of the depth-D search score and the outcome (tune the
   blend on held-out log-loss). Validate on a **spell-held-out** split, as `fit_learnability.py`'s C3
   check does.
3. **Gates:** offline, beat `tfit_spell` (Step 2) on held-out log-loss; cost, node-rate loss under
   ~25% (eval is ~5% of a node today); then the fixed-time arenas. Before the browser build, compile
   wasm with `-C target-feature=+simd128` (not set today) and re-check `tools/wasm-smoke.js` and the
   size budget.

## Step 6. Use more than one core (independent of steps 2-5)

Nothing in the engine is multi-threaded, native or wasm. At the log's 34-66 Elo per doubling of
time, a player's spare cores are the cheapest strength there is.

1. **Native first:** Lazy SMP (threads sharing the transposition table, different start orders) in
   `search.rs`, measured with a fixed-time arena of N threads against 1 thread. Fleet arenas assume
   one core per shard, so these runs need `WORKERS` reduced to match.
2. **Browser, option A:** split the root moves across several Web Workers, each with its own
   `Engine`. No shared memory needed. Weaker than Lazy SMP, but works on GitHub Pages as-is.
3. **Browser, option B:** wasm threads need `SharedArrayBuffer`, which needs COOP/COEP headers that
   Pages can't set. `docs/sw.js` can add them to responses (the coi-serviceworker pattern). Check it
   doesn't break Firebase auth popups or third-party assets before shipping.
4. Cap threads at `navigator.hardwareConcurrency - 1` and keep pondering working.

## Order and rough cost

| step | effort | compute | gate |
|---|---|---|---|
| 1 benchmarks | 1-2 days | small (depth-6 re-search of new games, ~1 VM-hour) | suites committed |
| 2 per-spell eval | ~1 week | ~$50 labels + 2 arenas (~$20-40) | 3 s and 10 s arenas vs `tfit` |
| 6 multi-core | 1-2 weeks | arenas only | N-thread vs 1-thread arena; browser smoke |
| 3 data pipeline v2 | ~1 week | ~$100-300 for 20M positions (measure first) | data loads; exploration share as specified |
| 4 generator policy | 2-4 weeks | training on 1 GPU or CPU; arenas | gate 0, then coverage, node rate, arenas |
| 5 network eval | 2-4 weeks | as step 4 | log-loss, node rate, arenas, wasm size |

Fleet prices from FINDINGS: c3d-highcpu-90 about $3.2/hour, C3 quota 300 vCPUs per region.

## Do not redo (closed by measurement; see FINDINGS)

Blanket generator budget increases (`dash4`, `outsel`), class merging at narrow width, quiescence,
tactical extensions (`tact_ext`), `lmr_quiet`, history re-sorting, `force_hints`, `root_resort`,
retuning adaptive widening, the exhaustive mate-in-1 bookends, and hand-chosen positional weights.
Reopen one only with a changed premise, written down in FINDINGS first.

## History: what predates the Rust engine

Kept as notes; none of this is current instructions. The removed documents are in git history (last
present at commit `a294794`).

* **Python AlphaZero.** `TRAINING.md`, `PLAYTEST.md`, `train_hard_loop.sh` and
  `train_selfplay_loop.sh` described a SigilNet (about 2.2M parameters) plus MCTS loop on the
  pure-Python `simboard.py` (the old guide estimated about one self-play game a minute on CPU), gated at 55% over 400
  games. Self-play throughput on Python was the bottleneck, and the JS Caveman tiers it fed scored
  7.5-9.8% against strong humans. The Rust board is about 174x faster on the same primitives, which
  is why data generation now lives in `engine/harness/`.
* **Fissure retraining (`ai/RETRAINING_FISSURE.md`).** A procedure to grow SigilNet to 42 spells and a
  destroyed-node channel. Fissure and the other deferred packs are out of scope for the Rust engine.
* **Training-data cutoffs** (still enforced by `ai/data_filters.py`): positions with Fireblast from
  before 2026-05-07 (the sacrifice nerf), and Competitive-variant records from before 2026-05-08 (an
  opening-pass off-by-one that ended games after one move). Any reuse of old data should keep both.
* **JS Caveman positional weights** (`ai/ARENA_POSITIONAL_WEIGHTS.md`). No hand-chosen set beat
  material on the JS engine. The Rust engine's fitted `tfit` later did, by about +50 Elo.
