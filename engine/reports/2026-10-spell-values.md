# Engine spell values from real self-play positions (2026-10-12)

**Question (Robi, 2026-10-11/12):** how do the 45 official spells rate under strong engine play,
compared with the players' tier list, matchup chart and synergy chart
(`docs/static/data/spell-charts.json`)?

## Method

A first attempt played games where each drawn spell was usable by only one player
(`spell_access_arena.py`, `fit_spell_charts.py`). **Robi rejected it:** changing who may use
which spell changes the game (it made Bulwark nearly useless). It was stopped after 23,530
games and is not used here.

The measurement here keeps the rules intact (`engine/harness/spell_value_probe.py`):

* **Positions.** Sampled from the self-play training corpus of the shipped network:
  * the v27 set, minus its Rock Slide games, which used the old pile-up rule;
  * plus the round-4 games (engine v29).

  Together these games hold every official spell equally often. 294,626 positions from
  264,410 games: 183,434 from round 4 and 111,192 from v27.
* **Probes.** Each position is searched at depth 4 with the shipped engine-v30 configuration
  (eval `nnue_spell4`, policy 96, exploration tail):
  * once as played;
  * once with each of the 9 drawn spells made unusable for each side (18 probes);
  * once with 8 random same-side pairs removed (synergy).

  "Unusable" is `PyBoard.set_access`: the slot never counts as charged for that side,
  anywhere in the search tree. The game itself is never altered.
* **Values.** Scores become win probabilities, `1/(1+exp(-0.8 s/100))`. A spell's value to a
  side is the drop in that side's win probability when it cannot use the spell.
  * **Tier value:** the mean over every (position, side) whose draw holds the spell.
  * **Matchup A vs B:** A's value to one side minus B's value to the other.
  * **Synergy:** the value of the pair minus the two single values.
  * **Intervals:** 95% bootstrap over games (`fit_spell_values.py`).
* **Cost.** About 4 + 3 Spot c3d-highcpu-90 VMs for about 3 h each, plus the depth-6 check
  below. One VM of the v27 batch was preempted after 10,218 of its ~33,600 positions.

## Tier list (percentage points of win probability)

The intervals are about ±0.02-0.04, so neighbours are distinguishable only by more than that.
The ranking is stable: v27-only versus pooled has Spearman 0.96.

| # | spell | value | 95% | positions | players' rank |
|---|---|---|---|---|---|
| 1 | Seal of Lightning | +1.66 | [+1.62, +1.70] | 84,752 | 6 |
| 2 | Seal of Stone | +1.36 | [+1.32, +1.40] | 125,886 | 22 |
| 3 | Slash | +1.26 | [+1.23, +1.29] | 86,342 | 11 |
| 4 | Splash | +1.17 | [+1.15, +1.19] | 128,334 | 24 |
| 5 | Hail Storm | +1.16 | [+1.11, +1.20] | 79,002 | 14 |
| 6 | Charge | +1.07 | [+1.06, +1.10] | 132,106 | 7 |
| 7 | Rock Slide | +0.94 | [+0.91, +0.96] | 149,518 | new |
| 8 | Fury | +0.93 | [+0.90, +0.95] | 126,934 | 13 |
| 9 | Meteor | +0.86 | [+0.82, +0.88] | 85,528 | 16 |
| 10 | Syzygy | +0.78 | [+0.76, +0.80] | 136,752 | 34 |
| 11 | Gather | +0.70 | [+0.68, +0.72] | 133,508 | 1 |
| 12 | Torrent | +0.68 | [+0.66, +0.71] | 128,332 | 39 |
| 13 | Carnage | +0.67 | [+0.64, +0.70] | 87,020 | 8 |
| 14 | Seal of Wind | +0.67 | [+0.65, +0.69] | 88,932 | 10 |
| 15 | Tsunami | +0.60 | [+0.58, +0.62] | 127,734 | 33 |
| 16 | Storm Front | +0.60 | [+0.58, +0.62] | 127,544 | 18 |
| 17 | Grow | +0.59 | [+0.57, +0.62] | 85,548 | 37 |
| 18 | Seal of Winter | +0.59 | [+0.57, +0.62] | 127,716 | 26 |
| 19 | Dividend | +0.55 | [+0.54, +0.56] | 144,182 | new |
| 20 | Flourish | +0.55 | [+0.53, +0.58] | 86,244 | 30 |
| 21 | Sprout | +0.52 | [+0.50, +0.54] | 85,920 | 25 |
| 22 | Scatter | +0.52 | [+0.50, +0.54] | 127,478 | 3 |
| 23 | Bewitch | +0.51 | [+0.49, +0.53] | 89,788 | 9 |
| 24 | Azimuth | +0.50 | [+0.49, +0.52] | 134,704 | 21 |
| 25 | Starfall | +0.49 | [+0.47, +0.51] | 82,214 | 15 |
| 26 | Fireblast | +0.48 | [+0.46, +0.50] | 93,792 | 2 |
| 27 | Eclipse | +0.47 | [+0.46, +0.49] | 135,714 | 36 |
| 28 | Lurk | +0.44 | [+0.43, +0.46] | 133,420 | 31 |
| 29 | Surge | +0.44 | [+0.42, +0.45] | 93,124 | 20 |
| 30 | Decay | +0.41 | [+0.40, +0.43] | 135,246 | 29 |
| 31 | Blossom | +0.40 | [+0.38, +0.42] | 124,182 | 4 |
| 32 | Fissure | +0.39 | [+0.38, +0.41] | 146,834 | new |
| 33 | Bulwark | +0.32 | [+0.31, +0.33] | 147,702 | new |
| 34 | Harvest | +0.30 | [+0.28, +0.31] | 135,844 | 12 |
| 35 | Seal of Autumn | +0.29 | [+0.27, +0.30] | 136,472 | 27 |
| 36 | Seal of Spring | +0.28 | [+0.27, +0.29] | 127,284 | 28 |
| 37 | Gust | +0.28 | [+0.26, +0.30] | 123,604 | 38 |
| 38 | Annuity | +0.27 | [+0.26, +0.28] | 144,794 | new |
| 39 | Hurricane | +0.26 | [+0.25, +0.28] | 124,346 | 19 |
| 40 | Endowment | +0.22 | [+0.21, +0.23] | 145,104 | new |
| 41 | Corrupt | +0.20 | [+0.19, +0.21] | 137,588 | 5 |
| 42 | Seal of Summer | +0.15 | [+0.13, +0.17] | 83,366 | 35 |
| 43 | Erupt | +0.13 | [+0.12, +0.14] | 131,328 | 17 |
| 44 | Comet | -0.04 | [-0.06, -0.02] | 83,480 | 23 |
| 45 | Seal of Destruction | -0.06 | [-0.09, -0.04] | 128,026 | 32 |

* **Agreement with the players' chart is weak:** Spearman **0.23** over the 39 shared spells.
* **Engine rates much higher:** Seal of Stone, Splash, Syzygy, Torrent, Tsunami, Grow.
* **Engine rates much lower:** Fireblast (players #2), Scatter (#3), Blossom (#4), Corrupt (#5), Harvest (#12).
* **Seal of Destruction is slightly negative:** holding it risks losing at the start of your own turn. Comet is also slightly negative.

## Matchups

56 of the 990 pairs clear the threshold (≥ 1 pp with an interval excluding 0). Almost all of
them pit a top-tier spell against a bottom-tier one. The ten strongest:

| favoured | over | pp |
|---|---|---|
| Seal of Lightning | Seal of Summer | +1.78 |
| Seal of Lightning | Sprout | +1.60 |
| Seal of Lightning | Comet | +1.56 |
| Slash | Comet | +1.53 |
| Seal of Stone | Comet | +1.53 |
| Seal of Stone | Seal of Destruction | +1.53 |
| Seal of Lightning | Erupt | +1.52 |
| Seal of Lightning | Grow | +1.51 |
| Seal of Lightning | Blossom | +1.48 |
| Charge | Comet | +1.45 |

## Synergy: not measurable at this depth

No pair clears the threshold (≥ 0.5 pp with an interval excluding 0), even with a median of 924
samples per pair. The estimates have sd 0.04 pp; the largest is about 0.2 pp (Seal of
Destruction + Seal of Winter, −0.22). A depth-4 probe rarely sees two spells combine within its
window. **The engine cannot supply a synergy chart with this method.**

## Is the disagreement a horizon artifact? Depth 6 says no

`engine/harness/spell_depth_probe.py` re-probed the largest disagreements and two controls at
depth 6, on the same positions:
* **Sample:** 400 positions per spell, 280 where the spell mattered at depth 4 and 120 where it
  did not, reweighted to the population. 4,136 of 4,800 tasks finished: one VM was preempted
  and the slowest stragglers were stopped.

```
4136 tasks done
spell              group             n  d4 value  d6 value          d6-d4 [95%] d6 nonzero  s/task
Charge             control         355     +0.93     +1.56    +0.62 [+0.43,+0.81]        29%    67.9
Seal_of_Lightning  control         337     +0.84     +1.74    +0.90 [+0.67,+1.19]        18%   356.9
Seal_of_Stone      engine higher   337     +1.36     +2.16    +0.80 [+0.61,+0.97]        10%   288.9
Splash             engine higher   342     +1.19     +1.87    +0.68 [+0.47,+0.89]        22%   137.9
Syzygy             engine higher   349     +0.83     +1.49    +0.66 [+0.45,+0.91]        18%    83.1
Torrent            engine higher   338     +0.74     +1.52    +0.78 [+0.58,+1.02]        14%   215.8
Tsunami            engine higher   346     +0.58     +1.44    +0.86 [+0.53,+1.33]        14%   279.1
Blossom            engine lower    335     +0.42     +0.70    +0.28 [+0.20,+0.36]         6%   187.5
Corrupt            engine lower    342     +0.18     +0.38    +0.20 [+0.07,+0.43]         7%   230.5
Fireblast          engine lower    352     +0.30     +0.54    +0.24 [+0.14,+0.37]         7%   324.0
Harvest            engine lower    357     +0.26     +0.40    +0.14 [+0.03,+0.28]         5%   152.8
Scatter            engine lower    346     +0.51     +1.06    +0.55 [+0.39,+0.75]        19%   278.2
```

* **Every value rises with depth,** about 1.5-2.5x.
* **The order holds:**
  * the "engine higher" spells stay at or above the controls;
  * the "engine lower" spells gain least (Blossom, Fireblast, Harvest, Corrupt);
  * only Scatter moves noticeably toward the players' view, and it remains below the controls.
* **Conclusion:** the depth-4 ranking is not a short-horizon artifact for these spells. A
  horizon longer than 6 plies remains untested.

## Caveats

* **What the value measures:** how much a spell is worth on average at a random moment of a
  game that holds it. That combines how often it matters with how much it matters when it does.
  The per-spell split is in the data file, as `samples`/values.
* **Distribution:** the positions come from engine self-play, not human games.

## Files

* `engine/reports/data/spell_values_2026-10-12.json`: tier list, matchups and synergies, in
  the Spells page schema, plus values, intervals and sample counts.
* `engine/reports/data/spell_values_depth6_2026-10-12.txt`: the depth-6 table.
* Raw probe logs: `gs://focus-surfer-494820-g0-sigil/runs/*-sigil-sv-*`, `*-sigil-sv27-*`,
  `*-sigil-d6-*`. Plans: `gs://…/data/spell_values/`.
* Code: the probe harnesses (`spell_value_probe.py`, `fit_spell_values.py`,
  `spell_depth_probe.py`) and the `PyBoard.set_access` engine hook are on branch
  `spell-access-experiment`, not in main.
