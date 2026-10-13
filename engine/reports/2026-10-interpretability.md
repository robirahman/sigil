# What the engine knows: interpretability results (2026-10)

**Question (Robi, 2026-10-13):** what human-understandable strategy can we read out of the
engine, which now beats the strongest human players? The analogue is "Assessing Game Balance
with AlphaZero" (piece values read out of AlphaZero).

**Plan:** `engine/reports/2026-10-interpretability-plan.md`. Robi asked for every experiment
to run on the shipped engine, v31.

**Engine:** v31 throughout: eval `nnue_spell4` = `tfit_spell_v2` + a net correction capped at
±256 centistones, the shipped search, policy and exploration tail. Values are from the side to
move. 1 stone = 100 centistones (cs).

**Positions:**
* *Self-play:* round-4 games. They were played by v29 with `nnue_spell3`, but every value here
  is v31's.
* *Human:* the 1,635 recorded human games in the standard and competitive variants. Almost all
  were played against our AI.
* Self-play and human positions are always reported separately.

**Intervals:** 95%, bootstrapped over games.

**Data:** `gs://focus-surfer-494820-g0-sigil/data/interp/`. **Harnesses:** `engine/harness/interp_*.py`.

## Headline

1. **The hand evaluation is material; the positional knowledge is in the net.**
   * Material explains 47% of the variance of the shipped evaluation and the net's correction
     52%. All named positional terms together explain under 1.5%: they are scaled by 96/7548,
     so a mana node is worth about 1 cs to the hand evaluation.
   * The net predicts game results better than material does.
2. **What a stone is worth.** At depth 4, one more stone of your own is worth about 1.5 stones
   and having the move about 1.7 stones. Where it stands matters:

   | Node | Value at depth 4 | Relative to an outer void stone |
   |---|---|---|
   | Mana node | ≈1.7 stones | about +30% |
   | 3-node or 1-node sigil | ≈1.6 | about +20% |
   | 5-node sigil | ≈1.4 | — |
   | Outer void node | ≈1.3 | (baseline) |

   Charging a sigil adds a premium of about 0.13 stones.
3. **The net's spell values agree with the spell-values report.** Spearman 0.72 over 41
   spells. Holding a charged Tsunami, Seal of Lightning, Carnage or Rock Slide is worth about
   +0.9 to +1.1 stones. A charged Comet, Bulwark, Erupt, Seal of Summer or Seal of Spring reads
   slightly negative.
4. **Predicting the result is not the same as improving play.**
   * Seven candidate principles beat the hand evaluation at predicting game results and
     replicated on a second sample and on human games.
   * None of them won Elo when added to the hand evaluation, and five lost 24-74 Elo.
   * The plan's arena test was the one that mattered.
5. **The net builds few concepts beyond its inputs.** Contested sigils and mobility are the
   two it encodes better than a linear read of the board. Its most influential units track
   game phase, enemy stones on 3-node sigils, mobility and which colour is to move.

## 1. The hand evaluation in plain units (`interp_hand_eval.py`)

Each part of the shipped evaluation, using the shipped weights read with `se.weights_json`.
The rebuilt hand evaluation matches `Board.evaluate` exactly on every position. The figures
below are self-play (4,296 positions, 2,378 games); human positions (9,760, 1,631 games) give
the same picture.

| Part | cs per unit | Mean \|contribution\| (cs) | Share of the eval's variance | Log-loss alone |
|---|---|---|---|---|
| material lead | 100 | 77 | 0.468 | 0.625 |
| net correction | — | 78 | 0.523 | 0.617 |
| per-spell sigil table | — | 2.6 | 0.006 | 0.685 |
| sigil stones | 0.46 | 0.6 | 0.002 | 0.687 |
| mana | 1.04 | 0.6 | 0.001 | 0.690 |
| near threshold | 0.71 | 0.1 | 0.001 | 0.655 |
| liberties, control, void, charged, sixth spell | ≤0.3 | ≤0.5 | ≈0 | ≥0.68 |
| tempo | 50 | 50 | 0 | — |

* The whole shipped evaluation predicts the result at log-loss 0.563; a constant gives 0.692.
* The net's correction is at its cap on 2.7% of self-play positions and 7.0% of human ones.
* The net's correction correlates most with three things: mobility (0.42), map control (0.32)
  and the cast-pace term (0.24). The hand evaluation gives mobility and cast pace zero weight
  and control a negligible one.

## 2. Exchange rates by counterfactual probe (`interp_exchange.py`, `fit_exchange.py`)

**Method.** Start from a real position and change exactly one stone, adding or removing it for
either side. Value the result four ways: the static hand evaluation, the static shipped
evaluation, and searches at depth 2 and depth 4. Each position also gets one probe with the
other side to move, to measure the value of the move.

**Sample.** 20,240 self-play positions (18,985 games) and 9,477 human positions (1,631 games):
about 2 million probes. Every interval is within ±0.01 stones unless shown.

**Value of one stone, in stones, from the side to move:**

| Probe | hand | full (static) | depth 2 | depth 4 | human, depth 4 |
|---|---|---|---|---|---|
| own stone | 1.01 | 1.30 | 1.38 | **1.49** | 1.65 |
| enemy stone (cost to you) | 1.01 | 1.21 | 1.26 | **1.35** | 1.47 |
| the move (same stones, you to move) | 1.00 | 1.58 | 1.64 | **1.73** | 1.96 |
| own stone on a mana node | 1.01 | 1.47 | 1.58 | **1.71** | 1.82 |
| own stone on a 3-node sigil | 1.01 | 1.40 | 1.50 | **1.62** | 1.73 |
| own stone on a 1-node sigil | 1.01 | 1.40 | 1.49 | **1.62** | 1.75 |
| own stone on a 5-node sigil | 1.01 | 1.25 | 1.32 | **1.42** | 1.62 |
| own stone on a void node | 1.01 | 1.19 | 1.28 | **1.39** | 1.52 |
| removing it breaks your charged sigil | 1.02 | 1.32 | 1.41 | **1.54** | 1.85 |
| removing it breaks nothing | 1.01 | 1.26 | 1.31 | **1.41** | 1.67 |
| adding it completes your sigil | 1.01 | 1.41 | 1.50 | **1.63** | 1.76 |
| adding it completes nothing | 1.01 | 1.29 | 1.38 | **1.49** | 1.62 |

**Value of an own stone on each node, self-play, depth 4.** Each arm runs: node 1 = mana,
2-6 = 5-node sigil, 7 = 1-node sigil, 8-10 = 3-node sigil, 11-13 = void.

| arm | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| a | 1.69 | 1.42 | 1.37 | 1.42 | 1.33 | 1.38 | 1.61 | 1.64 | 1.57 | 1.65 | 1.48 | 1.31 | 1.26 |
| b | 1.62 | 1.41 | 1.36 | 1.44 | 1.37 | 1.40 | 1.62 | 1.65 | 1.61 | 1.70 | 1.52 | 1.34 | 1.29 |
| c | 1.79 | 1.53 | 1.45 | 1.46 | 1.41 | 1.48 | 1.62 | 1.62 | 1.56 | 1.63 | 1.66 | 1.37 | 1.31 |

**What the tables say:**
* **Exchange rate.** An outer void stone (nodes 12-13) is the cheapest, at about 1.3 stones.
  A mana stone is worth about 1.3 of those, a stone on a 3-node or 1-node sigil about 1.25, and
  a 5-node sigil stone about 1.08.
* **Inner void node.** Node 11, the void node next to the 3-node sigil, is worth as much as a
  5-node sigil stone (1.5-1.7).
* **Arm c is worth a little more everywhere.**
* **The hand evaluation sees none of this.** It prices every stone at 1.01. The net adds about
  0.3 stones statically, and the search about another 0.2.
* **Own stones count for more than enemy stones** (1.49 against 1.35): placing a stone gains
  more than removing an enemy stone.
* **Charging a sigil** is worth about 0.13 stones on top of the stone itself.
* **Stones gain value as the board fills** (1.46 early → 1.57 middle → 1.60 late). Human games
  show bigger swings everywhere, because their positions are sharper.

## 3. What the net knows about each spell (`interp_spell_weights.py`)

**Method.** On 82,032 real self-play positions, the net was run once as shipped and once with
one slot's spell rows zeroed, so it no longer knows which spell sits there. The difference is
the spell-specific part of the net's correction. Every comparison stays within a spell's role,
because rituals, sorceries and charms always sit in sigils of 5, 3 and 1 node.

**Value of holding the sigil fully charged.** "Own" is when the side to move holds it, "enemy"
when the opponent does; cs.

| Charged spell | Own | Enemy |
|---|---|---|
| Tsunami | +115 | −102 |
| Seal of Lightning | +103 | −90 |
| Carnage | +93 | −110 |
| Rock Slide | +87 | −83 |
| Blossom | +72 | −55 |
| Bewitch | +64 | −64 |
| Seal of Stone | +61 | −82 |
| Fissure | +57 | −84 |
| Dividend | +55 | −18 |
| Syzygy | +50 | −56 |
| Gather | +50 | −40 |
| Fury | +48 | −41 |
| … | | |
| Seal of Autumn | −11 | −3 |
| Seal of Spring | −13 | +5 |
| Seal of Summer | −15 | +6 |
| Erupt | −20 | +13 |
| Bulwark | −20 | +1 |
| Comet | −21 | +8 |

* **Agreement with the spell-values report.** Its own-minus-enemy difference ranks the spells
  like the spell-values tier list: Spearman 0.72, 41 spells, p < 10⁻⁷.
* **Spells that read negative when charged.** For these the net prefers the sigil one short of
  charged. This report does not establish why; the casts are rare in self-play (section 4).
* **Which slot a spell sits in barely matters.** Within a role, the slot moves the net's spell
  term by only a few cs.
* **The raw weights show little family structure.** Within-role cosine similarity is at most
  0.46. The most similar pairs are mechanically related: Fireblast and Rock Slide (both destroy
  enemy stones touching the caster's), Slash and Surge, Charge and Splash.

## 4. How the engine plays (`interp_behaviour.py`)

PENDING_E4

## 5. Where the net overrules the hand evaluation (`interp_net_overrules.py`)

**Positions:** 86,068 self-play positions (3,844 games) and 44,210 human ones.

**How much the net adds.** It improves outcome log-loss by 0.064 (self-play) and 0.071
(human). On the 5% of positions where its correction is largest, the improvement is 0.25 and
0.17, and the net was right on 92% and 96% of them.

**A linear read-out of the correction** from the concepts players use (held-out R² 0.41
self-play, 0.45 human). Its largest weights, cs per standard deviation:
* **colour to move:** +29 / +38;
* **score lead:** +17 / +37;
* **3-node-sigil stones:** own +17, enemy −17 (self-play);
* **5-node-sigil stones:** own +23, enemy −17 (human);
* **mobility:** own +13, enemy −11;
* **void stones:** own −9, enemy +10;
* **mana:** own +8, enemy −9.

**Clusters among the positions the net overrules correctly** (k-means, 8 clusters per source).
The largest self-play clusters:
* **About to win on a 3-node spell.** You hold or have just cast a 3-node spell, have high
  mobility, and are one short of another 3-node sigil (net +240 cs, hand +75-100; won 99%).
* **The mirror image for the opponent** (net −200 to −230, hand −55; won 4-9%).
* **Crowded boards** with many stones that have no free neighbour on either side
  (net +160, hand +86; won 83%).

Human positions show the same patterns, plus a big-lead cluster where the hand evaluation was
already right.

The example positions for each cluster are in `e5_net_overrules.json`.

## 6. Testing the candidates (`interp_candidates.py`, arenas)

**Test 1: outcome prediction.** Each candidate was added as one term to the hand evaluation,
fitted on game results, and scored on held-out games. It had to improve the prediction on
self-play sample A, again on a disjoint sample B, and on human games, with the same sign
throughout.

**Test 2: overlap with the net.** The share of the net's correction the term explains (r² on
the correction).

**Test 3: Elo.** The hand evaluation with the term against the hand evaluation alone, no net,
3 s per move, about 1,056 games each, on Spot c3d-highcpu-90 VMs.

| Candidate | Fitted weight (A / B / human, cs) | Held-out gain | r² on net | Elo |
|---|---|---|---|---|
| colour (red to move) | +42 / +41 / +50 | +0.015 to +0.019 | 0.10-0.16 | +4.6 [−16, +26] |
| mobility (open neighbouring spots, diff) | +15 / +13 / +27 | +0.005 to +0.042 | 0.14-0.16 | **−66.6** [−88, −45] |
| 3-node-sigil stones (diff) | +14 / +12 / +17 | +0.003 to +0.006 | 0.03-0.10 | **−42.3** [−63, −21] |
| void stones (diff) | −18 / −15 / −15 | 0 to +0.004 | 0.04-0.05 | +19.8 [−1, +41] |
| mana stones (diff) | +21 / +25 / +26 | +0.002 to +0.005 | 0.03-0.07 | **−23.7** [−45, −3] |
| one short of a 3-node sigil (diff) | +19 / +12 / +48 | +0.0003 to +0.002 | 0.02 | **−43.2** [−64, −22] |
| map control (diff) | +3 / +3 / +10 | +0.003 to +0.035 | 0.07-0.09 | **−74.1** [−96, −53] |
| all seven, jointly fitted | (35, 5, 5, −13, −3, 3, 1) | — | — | +8.2 [−13, +29] |
| 5-node and 1-node sigil stones, castable charms or 3-node spells, stones with no free neighbour | — | fail test 1 | — | not run |

**Verdict: no candidate improves play.**
* **Colour** is a true fact about value: red wins about 54% at equal strength (section 4).
  But it is the same for every leaf of one search, so it cannot change a move.
* **The others predict who is winning more than they guide what to do.** Mobility and control
  are what a winning position looks like. Paying for them in the search buys nothing and costs
  speed: control is a flood fill.
* **Void stones** are the only term near a gain, at the edge of the interval.
* **So:** the AlphaZero-style reading ("the net values X") is a description, not advice, until
  an arena confirms it. These results argue against tuning the hand evaluation from
  outcome-fitted correlations.

## 7. Concept probes (`interp_neurons.py`)

**Method.** Ridge read-outs of each concept from each layer, scored as held-out R²: 23,791
self-play positions, 3,854 games. Each concept is compared with the raw inputs (78 occupancy
bits plus the side to move) and with a net whose weights are shuffled.

| Concept | raw | h1 | h3 | h1, shuffled net |
|---|---|---|---|---|
| contested 5-node sigils | 0.23 | **0.32** | 0.12 | 0.19 |
| contested 3-node sigils | 0.07 | **0.11** | 0.04 | 0.07 |
| own mobility | 0.33 | **0.37** | 0.29 | 0.24 |
| enemy mobility | 0.34 | **0.38** | 0.27 | 0.25 |
| stones, sigil stones, mana, void, colour | 1.00 | 0.3-0.88 | 0.1-0.65 | — |
| castable / one-short flags | 0.15-0.46 | 0.09-0.27 | ≤0.11 | — |

* **Contested sigils and mobility** are the only concepts the first layer encodes better than a
  linear read of the board. Those are the ones the net builds for itself.
* **Castability and "one short" flags** are not read linearly from any layer. The net reaches
  them some other way, or not at all.

## 8. Neuron atlas (`interp_neurons.py`)

**Dead units.** 10 of the 192 units are constant on more than 99% of positions.

**Most influential units**, by the mean change in output when the unit is forced to 0:

| Unit | Effect (cs) | Most correlated concepts | Note |
|---|---|---|---|
| L2 u2 | 56 | enemy stones −0.48, empty nodes +0.47, enemy 3-node-sigil stones −0.46 | |
| L2 u31 | 41 | own mana −0.30, own stones −0.29 | game phase |
| L2 u26 | 39 | enemy stones, enemy 3-node-sigil stones, enemy mana | |
| L3 u5 | 34 | own 3-node-sigil stones, own stones, own mobility (all negative) | |
| L2 u11 | 26 | colour +0.52 | a "red to move" unit |
| L2 u17 | 28 | colour +0.35 | a "red to move" unit |
| L2 u18 | 25 | colour −0.41 | a "red to move" unit |

* **Game phase and the 3-node sigils** dominate the influential units.
* **Colour** has several dedicated units, matching the colour term in section 6.
* **Rendering.** The 5 positions that drive each unit hardest are in `e78_probes_neurons.json`,
  ready to view on the real board UI.

## 9. Human mistakes (`interp_mistakes.py`)

PENDING_E9

## Caveats

* **Self-play positions.** They come from round-4 games played by an older engine (v29 with
  `nnue_spell3`), with 8% random plies. The values are v31's, but the positions are the ones
  that engine reached.
* **Human games.** They are almost all human against our AI, and one player has about 300 of
  them.
* **Interpretation.** Sections 3, 5, 7 and 8 describe what the net computes, not what is true
  about the game. Only the arena (section 6) tests claims, and so far none survived.

## Files

* **Harnesses:** `engine/harness/interp_hand_eval.py`, `interp_exchange.py` + `fit_exchange.py`,
  `interp_spell_weights.py`, `interp_behaviour.py`, `interp_net_overrules.py`,
  `interp_candidates.py`, `interp_neurons.py`, `interp_mistakes.py`.
* **Engine:** the default-off presets `tfit_x_*` and the default-zero `Weights` fields `colour`
  and `extra` (experiment 6), plus `se.weights_json`.
* **Results:** `gs://focus-surfer-494820-g0-sigil/data/interp/`: `e1_hand_eval.json`,
  `e2_exchange.json`, `e3_spell_weights.json`, `e5_net_overrules.json`,
  `e6_candidates_offline.json`, `e6_arena_result.txt`, `e78_probes_neurons.json`, and the
  experiment-9 files.
* **Run lists:** in the same folder (`*_runs.txt`).
