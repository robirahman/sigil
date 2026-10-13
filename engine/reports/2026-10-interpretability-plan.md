# Learning strategy from the engine: interpretability plan (2026-10)

**Question (Robi, 2026-10-13):** the engine now plays better than the strongest human players.
Can we read human-understandable strategy out of it, the way "Assessing Game Balance with
AlphaZero" read piece values out of AlphaZero (knight 3.05, bishop 3.33, rook 5.63, queen 9.50
pawns)?

**Status: plan only, nothing run.** The experiments wait for the strongest engine. The
label-depth arena and round 5 may produce a stronger net in the next few days, and every result
below belongs to one engine version. Running them twice would waste the compute.

## What there is to interpret

The engine's evaluation has two parts (`engine/harness/nn_eval.py`, `src/eval.rs`):

    eval(pos, c) = tfit_spell_v2(pos, c) + clamp(net(pos, c), -cap, cap)     (centistones, 100 = 1 stone)

* **`tfit_spell_v2`, the hand evaluation.** A weighted sum of named terms, so it is already
  interpretable:
  * board terms: `lead`, `near_threshold`, liberties (own and enemy, zero and one), `mana`,
    `control`, `void_penalty`, `tempo`, `cast_pace`, `mobility`, `sixth_spell_danger`;
  * a per-spell table: the value of a stone on each spell's sigil, and of a charged sigil.
* **The net, a learned correction on top.** It is small:
  * inputs: 78 occupancy bits (39 nodes × mine/theirs) and the side to move;
  * spell conditioning folded into the first layer: `E[spell, place in sigil, mine/theirs]`
    and `G[spell, slot]`;
  * layers: 128 → 32 → 32 → 1;
  * capped at ±256 cs in `nnue_spell4`.

So both parts are far smaller than AlphaZero's network, and every input is already a concept a
player uses. The cap matters for interpretation: any statement about "what the engine thinks"
must use the hand evaluation and the net together, not the net alone.

**Already done in this style:** the spell values report (`engine/reports/2026-10-spell-values.md`,
the Engine view on the Spells page). It measured each spell's worth by searching real positions
with the spell made unusable for one side. Most experiments below reuse that method.

## Ground rules (from earlier work)

1. **Real rules, real positions.** Measure on positions from actual games under the actual
   rules. Robi rejected altered-rule experiments for measurement (exclusive spell access made
   Bulwark moot). A counterfactual probe changes one thing in one position and leaves the game
   alone.
2. **Search, not just the static evaluation.** Report each value at static evaluation and at a
   shallow search (depth 2 and depth 4). Values that hold only statically are artefacts of what
   the evaluation misses, not facts about the game.
3. **Two position sources.**
   * Engine self-play: the round-5 corpus, every spell drawn equally often.
   * Human games: Firebase `completed_games`, hydrated with `ai.replay_bridge`.

   Report both, because a value can differ between the positions engines reach and the ones
   humans reach.
4. **Intervals by game bootstrap. Replicate anything that drives a decision.** A 0.050-nat result
   once replicated at 0.002 (fold SE is not population SE).
5. **One pinned engine.** Record the engine version, net and search configuration in every
   report. Use the shipped Hard configuration unless an experiment says otherwise.
6. **Results become claims only after a test.** A pattern read off weights or neurons is a
   hypothesis until experiment 5 confirms it in an arena.

## Experiments

Grouped by phase; cost and output for each.

### Phase A: cheap, publishable (about 2-3 days total)

**1. The hand evaluation in plain units.**
* Convert every `tfit_spell_v2` weight to stones and to win probability (texel scale k).
* Measure each term's typical contribution on real positions: mean |term × weight| and its
  share of the evaluation's variance. A large weight on a rare term matters less than a small
  one that is always present.
* Output: a table such as "one point of mana lead is worth X stones, and accounts for Y% of the
  evaluation's swings", and the per-spell stone and charge values.
* Cost: hours, CPU only.

**2. Exchange rates by counterfactual probe (the AlphaZero analogue).** Starting from real
positions, change exactly one thing and record how much the evaluation changes, at static, depth
2 and depth 4.
* **Stone value per node:** remove one of the mover's stones, or add one on an empty node, for
  each of the 39 nodes. Report by game phase (stones on the board) and by whether the node is
  on a sigil, a sigil of a drawn spell, or the edge.
* **Charge value:** the value of completing a spell's sigil, against the same stone count left
  incomplete.
* **Mana and tempo:** one point of mana, where the game state allows a legal change. The value
  of the move itself: the same position searched with each side to move, only where that
  position is legal.
* **Legality:** only legal perturbations are counted. A removal that changes a charge state is
  reported separately.
* Output:
  * a node-value map drawn on the real board;
  * an exchange table, e.g. "a stone on a 3-node sigil is worth N ordinary stones, a charged
    5-node sigil is worth M";
  * how both shift from opening to endgame.
* Cost: about 50k positions × ~100 probes. Static and depth 2 on one VM; depth 4 on a small
  Spot fleet for about half a day, the same scale as the spell-values run.

**3. Read the spell weights directly.**
* For each spell, the net's first layer holds `E[spell, place, mine/theirs]` (a 128-vector per
  sigil node and side) and `G[spell, slot]`.
* Compare spells by cosine similarity of these weights and cluster them. Compare the clusters
  with the players' types, packs and tier list, and with the engine tier list.
* `G[spell, slot]` shows whether the engine values a spell differently by sigil size (5, 3 or
  1 node), which is a direct strategy question: is Splash better in a large sigil?
* Check each weight-level claim against experiment 2's measured values for the same spell. The
  layers after the first are nonlinear, so weights alone can mislead.
* Cost: an afternoon, CPU only.

**4. How the engine plays: statistics from self-play.** No interpretability needed; read
directly from game logs, and compare each with human games at each rating band.
* Opening placements for each spell draw.
* Turn of first cast for each spell, and how long a charged spell is held before casting.
* Casts declined: turns where a charged spell could have been cast and was not, found by
  replaying each turn's legal actions.
* Sacrifice and dash frequency, Syzygy use, seal timing.
* First-move advantage at equal strength: red vs blue win rate in self-play.

Output: a strategy-guide section of directly teachable findings ("the engine almost never opens
on X when Y is drawn"). Cost: a day of log processing.

### Phase B: the route to new strategy (about a week)

**5. Where the net overrules the hand evaluation, and why.**
* Collect positions where the net's correction is large (top 1% of |net|), split by whether the
  correction predicted the game result better or worse than the hand evaluation alone.
* Cluster the "net was right" set by occupancy pattern, spell draw and phase.
* Render each cluster's typical positions on the real board with the position-labeling harness
  (`gen_unmatched_review.py`) and label them by eye.
* Each cluster is a candidate principle the hand evaluation lacks, e.g. "a stone adjacent to an
  enemy sigil is worth less than it looks when the enemy holds a sacrifice spell".
* Output: a list of candidate principles with example positions. Cost: 1-2 days, then human
  review.

**6. Test each candidate principle.**
* Write each candidate from experiments 2, 3, 5, 7 and 8 as one extra hand-evaluation term.
* Refit the hand evaluation with it (`fit_spell_eval_v2.py` method).
* A principle is confirmed only if all three hold:
  1. it improves held-out outcome log-loss, replicated on a second sample;
  2. it shrinks the net's correction on the positions it targets;
  3. it wins Elo in an arena: the hand evaluation with the term against the one without, both
     with no net, at fixed time.

  The third condition is the step the AlphaZero paper did not take; it separates "the net
  seems to like X" from "X is true".
* Confirmed principles go into the strategy guide with their measured value. A side benefit is
  a stronger hand evaluation, which helps the Easy and Medium tiers and is a better base for
  the next net.
* Cost: about half a day per principle plus an arena each. Run several principles against the
  baseline in one fleet.

### Phase C: research-flavoured (after Phase B shows where to look)

**7. Concept probes.**
* Fit linear read-outs from each hidden layer (128, 32, 32) to concepts players use:
  * group connectivity and liberties;
  * stones exposed to Fireblast or a filled Seal of Destruction;
  * "can cast next turn";
  * mana lead;
  * threatened sacrifices;
  * sixth-spell danger;
  * control of each sigil.
* Compare with the same probe on an untrained net and on shuffled labels.
* Concepts the trained net encodes well but the hand evaluation lacks are candidates for
  experiment 6.
* Cost: 1-2 days.

**8. Neuron atlas.**
* For each of the 192 hidden units: find dead units; render the positions that activate it most
  and least; check whether it is tied to particular spells (through `E` and `G`); label the
  motif by eye.
* With 192 units this is feasible by hand in a few days. Units with a clean motif become
  candidate principles for experiment 6.

**9. Human mistake taxonomy.**
* Run the engine over recorded human games (the game-review pipeline, Deep = Hard settings).
* Classify the largest evaluation drops by phase, spell and action type: placement, move, dash,
  cast, keep choice.
* Before calling any of them a human mistake, re-search each at greater depth and width. The
  surprise audit found the engine never generates 57% of human dashes, so some "mistakes" will
  be the engine's blind spots.
* Output: a "common mistakes" section of the strategy guide, plus a list of engine blind spots
  for the next round of engine work.
* Cost: 2-3 days, mostly VM time on existing tooling.

**10. Balance questions (optional).** The AlphaZero paper's actual subject was game balance.
Real-rules versions:
* first-move advantage (also in experiment 4);
* whether any spell pair or draw composition decides games, from the spell values data;
* how decisive each sigil size is.

Altered-rule experiments, such as training under a proposed rule change, belong only to
evaluating a specific proposed change (as with the Rock Slide pile-up rule), and only with
Robi's approval.

## Order and timing

1. **Wait** until the label-depth arena and round 5 finish and the strongest engine ships. Pin
   that version in this plan.
2. **Phase A** (experiments 1-4). These produce Spells page and strategy guide material, and the
   node and spell values experiment 6 needs.
3. **Phase B** (experiments 5-6). The main payoff: principles that are both new and confirmed.
4. **Phase C** (experiments 7-9) where Phase B points. Experiment 9 can run any time on idle
   capacity.

Each experiment gets a report in `engine/reports/` and its harness in `engine/harness/`. The
spell-values probe harness and the `PyBoard.set_access` hook it uses are still only on branch
`spell-access-experiment`. They should be merged into main as part of Phase A, because
experiment 2 extends them.
