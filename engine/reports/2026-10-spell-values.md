# Engine spell values from real self-play positions (re-run 2026-10-14)

**Question (Robi, 2026-10-11/12):** how do the 45 official spells rate under strong engine play,
compared with the players' tier list, matchup chart and synergy chart
(`docs/static/data/spell-charts.json`)?

**This is the corrected re-run.** The first run (2026-10-12, PR #21) let the leaf evaluation keep
crediting a spell that had been made unusable (PR #23 review), which biased every value toward
zero. The engine now honours the mask everywhere, and the probes were repeated on the same
positions with the same settings. The first run's data stays in
`engine/reports/data/spell_values_2026-10-12.json` for comparison.

## Method

A first attempt played games where each drawn spell was usable by only one player
(`spell_access_arena.py`, `fit_spell_charts.py`). **Robi rejected it:** changing who may use
which spell changes the game (it made Bulwark nearly useless). It is not used here.

The measurement keeps the rules intact (`engine/harness/spell_value_probe.py`):

* **Positions.** Sampled from the self-play training corpus of the shipped network:
  * the v27 set, minus its Rock Slide games, which used the old pile-up rule;
  * plus the round-4 games (engine v29).

  Together these games hold every official spell equally often.
* **Probes.** Each position is searched at depth 4 with the shipped configuration (eval
  `nnue_spell4`, policy 96, exploration tail):
  * once as played;
  * once with each of the 9 drawn spells made unusable for each side (18 probes);
  * once with 8 random same-side pairs removed (synergy).

  "Unusable" is `PyBoard.set_access`. The slot never counts as charged for that side anywhere
  in the search tree, and the leaf evaluation ignores it: the hand evaluation's charged and
  per-spell terms, the net's spell rows and its draw term. The game itself is never altered.
* **Values.** Scores become win probabilities, `1/(1+exp(-0.8 s/100))`. A spell's value to a
  side is the drop in that side's win probability when it cannot use the spell.
  * **Tier value:** the mean over every (position, side) whose draw holds the spell.
  * **Matchup A vs B:** A's value to one side minus B's value to the other.
  * **Synergy:** the value of the pair minus the two single values.
  * **Intervals:** 95% bootstrap over games (`fit_spell_values.py`).
* **Strength scale** (Spells page and the tables below): matchups ++ / −− at ≥ 1.5 points of
  win probability, + / − at ≥ 0.6; synergy ++ / −− at ≥ 0.25, + / − at ≥ 0.1. Each counts only
  when its 95% interval excludes zero; everything else reads 0. The cuts were lowered on
  2026-10-21 (from 3 / 1 and 1.5 / 0.5) so the labels spread across the categories: matchups
  now split about evenly between 0, + and ++. Synergies cannot be balanced the same way: most
  pairs cannot be told apart from zero, and only 33 measure negative at all.
* **Sample and cost.** 8 Spot c3d-highcpu-90 VMs in us-central1, about 3 hours, roughly $20.
  Preemptions cut 7 of the 8 short, so the fit uses **217,315 positions from
  194,060 games**: 74% of the first run's 294,626. The positions lost are spread across
  both corpora and every spell, so they widen the intervals slightly without biasing the
  values.

## What the fix changed

* **Every value is 2-8× larger.** The bug understated the gap between "can use it" and "can't".
* **The correction grows with the time a spell takes to charge.** Mean value: rituals 2.04 against 0.47 (4.3×); sorceries 1.83 against 0.71 (2.6×); charms 0.90 against 0.52 (1.7×).
* **Order:** Spearman 0.83 against the first run.
  * *Biggest risers:* Fissure (#32 → #14), Hurricane (#39 → #22), Bewitch (#23 → #9), Blossom (#31 → #19), Carnage (#13 → #2), Tsunami (#15 → #5), Starfall (#25 → #15), Fireblast (#26 → #17).
  * *Biggest fallers:* Seal of Wind (#14 → #27), Charge (#6 → #18), Sprout (#21 → #31), Bulwark (#33 → #43), Gather (#11 → #20), Seal of Winter (#18 → #26).

## Tier list (percentage points of win probability)

| # | tier | spell | value | 95% | positions | before the fix | players' rank |
|---|---|---|---|---|---|---|---|
| 1 | S | Seal of Lightning | +5.62 | [+5.53, +5.74] | 49,704 | #1 (S) | 6 |
| 2 | S | Carnage | +5.03 | [+4.95, +5.11] | 52,366 | #13 (A) | 8 |
| 3 | S | Rock Slide | +4.49 | [+4.46, +4.54] | 129,992 | #7 (A) | new |
| 4 | S | Syzygy | +3.75 | [+3.70, +3.80] | 106,140 | #10 (A) | 34 |
| 5 | S | Tsunami | +3.41 | [+3.36, +3.45] | 99,066 | #15 (A) | 33 |
| 6 | A | Seal of Stone | +3.33 | [+3.28, +3.40] | 96,374 | #2 (S) | 22 |
| 7 | A | Hail Storm | +3.27 | [+3.19, +3.35] | 41,398 | #5 (S) | 14 |
| 8 | A | Fury | +2.73 | [+2.69, +2.77] | 97,406 | #8 (A) | 13 |
| 9 | A | Bewitch | +2.45 | [+2.42, +2.50] | 52,628 | #23 (B) | 9 |
| 10 | A | Slash | +2.23 | [+2.18, +2.27] | 49,792 | #3 (S) | 11 |
| 11 | A | Splash | +2.14 | [+2.11, +2.18] | 98,942 | #4 (S) | 24 |
| 12 | A | Flourish | +2.12 | [+2.07, +2.16] | 49,922 | #20 (B) | 30 |
| 13 | A | Meteor | +1.81 | [+1.76, +1.86] | 48,938 | #9 (A) | 16 |
| 14 | A | Fissure | +1.80 | [+1.77, +1.83] | 122,986 | #32 (D) | new |
| 15 | A | Starfall | +1.77 | [+1.71, +1.83] | 43,772 | #25 (C) | 15 |
| 16 | A | Torrent | +1.74 | [+1.71, +1.78] | 99,088 | #12 (A) | 39 |
| 17 | A | Fireblast | +1.61 | [+1.57, +1.65] | 56,910 | #26 (C) | 2 |
| 18 | B | Charge | +1.60 | [+1.58, +1.63] | 102,176 | #6 (A) | 7 |
| 19 | B | Blossom | +1.58 | [+1.55, +1.62] | 95,292 | #31 (D) | 4 |
| 20 | B | Gather | +1.45 | [+1.41, +1.49] | 103,520 | #11 (A) | 1 |
| 21 | B | Grow | +1.42 | [+1.38, +1.46] | 50,702 | #17 (A) | 37 |
| 22 | B | Hurricane | +1.23 | [+1.20, +1.26] | 94,340 | #39 (D) | 19 |
| 23 | B | Storm Front | +1.21 | [+1.18, +1.24] | 96,920 | #16 (A) | 18 |
| 24 | C | Scatter | +1.11 | [+1.08, +1.14] | 98,306 | #22 (B) | 3 |
| 25 | C | Dividend | +1.07 | [+1.05, +1.10] | 121,036 | #19 (B) | new |
| 26 | C | Seal of Winter | +1.03 | [+0.99, +1.06] | 98,610 | #18 (B) | 26 |
| 27 | C | Seal of Wind | +1.03 | [+0.98, +1.08] | 52,766 | #14 (A) | 10 |
| 28 | C | Azimuth | +1.00 | [+0.98, +1.02] | 104,350 | #24 (C) | 21 |
| 29 | C | Eclipse | +0.89 | [+0.87, +0.91] | 105,640 | #27 (C) | 36 |
| 30 | D | Gust | +0.88 | [+0.86, +0.91] | 93,646 | #37 (D) | 38 |
| 31 | D | Sprout | +0.84 | [+0.81, +0.86] | 50,034 | #21 (B) | 25 |
| 32 | D | Lurk | +0.82 | [+0.80, +0.84] | 103,500 | #28 (C) | 31 |
| 33 | D | Surge | +0.79 | [+0.77, +0.83] | 56,968 | #29 (C) | 20 |
| 34 | D | Corrupt | +0.73 | [+0.70, +0.75] | 108,172 | #41 (F) | 5 |
| 35 | D | Decay | +0.72 | [+0.70, +0.75] | 104,880 | #30 (D) | 29 |
| 36 | D | Annuity | +0.67 | [+0.66, +0.69] | 121,050 | #38 (D) | new |
| 37 | D | Harvest | +0.57 | [+0.54, +0.59] | 105,698 | #34 (D) | 12 |
| 38 | D | Seal of Autumn | +0.36 | [+0.34, +0.38] | 106,812 | #35 (D) | 27 |
| 39 | D | Seal of Destruction | +0.31 | [+0.27, +0.35] | 100,402 | #45 (F) | 32 |
| 40 | F | Seal of Spring | +0.29 | [+0.27, +0.31] | 97,804 | #36 (D) | 28 |
| 41 | F | Endowment | +0.27 | [+0.25, +0.29] | 121,890 | #40 (F) | new |
| 42 | F | Seal of Summer | +0.26 | [+0.23, +0.28] | 47,804 | #42 (F) | 35 |
| 43 | F | Bulwark | +0.21 | [+0.19, +0.23] | 123,900 | #33 (D) | new |
| 44 | F | Comet | -0.03 | [-0.06, -0.00] | 48,516 | #44 (F) | 23 |
| 45 | F | Erupt | -0.04 | [-0.06, -0.02] | 101,512 | #43 (F) | 17 |

* **Agreement with the players' chart is still weak:** Spearman **0.25** over the
  39 shared spells; the first run gave 0.23.
* **The engine rates much higher than players:** Syzygy (#4, players #34), Tsunami (#5, #33),
  Seal of Stone (#6, #22), Flourish (#12, #30), Torrent (#16, #39), Grow (#21, #37).
* **The engine rates much lower:** Gather (#20, players #1), Scatter (#24, #3), Corrupt (#34, #5),
  Harvest (#37, #12), Erupt (#45, #17) and Comet (#44, #23). Fireblast (#17, players #2) and
  Blossom (#19, #4) are closer than before but still well below the players' view.
* **Comet and Erupt are the only spells with no value**, both a hair below zero.

## Matchups

644 of the 990 pairs have a favourite: 313 strongly (++)
and 331 clearly (+); 346 read even. The favoured side is almost always the
higher-tier spell. The most-favoured spells, by number of pairs won, are Seal of Lightning (43), Carnage (42), Syzygy (39), Fury (39), Tsunami (38). The
least-favoured are Comet (37), Seal of Summer (35), Seal of Spring (34), Seal of Destruction (34), Bulwark (29).

The strongest edges:

| favoured | over | points | strength |
|---|---|---|---|
| Seal of Lightning | Azimuth | +5.70 | ++ |
| Seal of Lightning | Blossom | +5.59 | ++ |
| Seal of Lightning | Sprout | +5.48 | ++ |
| Seal of Lightning | Seal of Summer | +5.36 | ++ |
| Carnage | Bulwark | +5.35 | ++ |
| Seal of Lightning | Seal of Autumn | +5.33 | ++ |
| Carnage | Erupt | +5.32 | ++ |
| Carnage | Blossom | +5.29 | ++ |
| Carnage | Seal of Autumn | +5.28 | ++ |
| Seal of Lightning | Surge | +5.27 | ++ |
| Seal of Lightning | Comet | +5.16 | ++ |
| Seal of Lightning | Erupt | +5.12 | ++ |

## Synergies

296 pairs show a synergy (146 ++, 150 +) and 27 an anti-synergy (11 −−, 16 −); the other
667 read 0. The effects are small: the largest is 1.2 points and almost all are under 0.5.
Many of the strongest involve the Providence spells, whose banked stones count toward the score
lead. Several rest on fewer than 200 positions, so treat those as tentative.

The strongest synergies:

| pair | points | strength | samples |
|---|---|---|---|
| Rock Slide + Dividend | +1.16 | ++ | 40 |
| Meteor + Dividend | +0.95 | ++ | 127 |
| Seal of Lightning + Endowment | +0.91 | ++ | 113 |
| Fissure + Dividend | +0.83 | ++ | 166 |
| Tsunami + Dividend | +0.72 | ++ | 143 |
| Seal of Lightning + Annuity | +0.67 | ++ | 168 |
| Hail Storm + Scatter | +0.66 | ++ | 395 |
| Fury + Fissure | +0.65 | ++ | 207 |
| Carnage + Annuity | +0.64 | ++ | 169 |
| Starfall + Hail Storm | +0.64 | ++ | 2,080 |
| Syzygy + Dividend | +0.64 | ++ | 2,404 |
| Starfall + Annuity | +0.60 | ++ | 172 |

The strongest anti-synergies:

| pair | points | strength | samples |
|---|---|---|---|
| Comet + Bulwark | -0.43 | −− | 100 |
| Flourish + Gather | -0.39 | −− | 423 |
| Storm Front + Harvest | -0.37 | −− | 421 |
| Slash + Azimuth | -0.35 | −− | 344 |
| Seal of Lightning + Surge | -0.31 | −− | 1,512 |
| Seal of Lightning + Azimuth | -0.31 | −− | 544 |
| Hail Storm + Harvest | -0.29 | −− | 473 |
| Fireblast + Seal of Wind | -0.28 | −− | 1,182 |
| Seal of Wind + Slash | -0.26 | −− | 1,591 |
| Storm Front + Gather | -0.26 | −− | 329 |
| Seal of Stone + Seal of Winter | -0.26 | −− | 8,111 |

## Depth-6 check (from the first run, not repeated)

**Measured before the leaf-evaluation fix and not re-run** (Robi, 2026-10-20): its values
carry the same bias toward zero as the first run's tier list, so read it only as evidence that
the ranking holds from depth 4 to depth 6, not for its magnitudes. The "engine higher" and
"engine lower" groups refer to the first run's ranking.

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

* **Every value rises with depth,** about 1.5-2.5x on the completed tasks.
* **The two groups stay apart:**
  * the "engine higher" spells read +1.44 to +2.16 at depth 6. Seal of Stone and Splash are
    above both controls. Syzygy, Torrent and Tsunami are slightly below Charge (+1.56) and
    below Seal of Lightning (+1.74).
  * the "engine lower" spells read +0.38 to +1.06, below every "engine higher" spell and both
    controls. Blossom, Fireblast, Harvest and Corrupt gain least.
  * only Scatter moves noticeably toward the players' view (+0.51 to +1.06), and it remains
    below the controls.
* **Missing tasks (censoring).** The 664 unfinished tasks (11-16% per spell) are not a random
  subsample: some are one preempted VM's share, and the rest are the slowest searches, which
  were stopped. Reweighting the strata does not correct for that. As a rough sensitivity check,
  which ignores the stratum weights, fill each spell's missing tasks with a pessimistic value:
  * *Missing tasks did not change from depth 4.* Each rise shrinks by the completed share
    (n/400). The rises stay positive: +0.55 to +0.76 for the controls and "engine higher" spells,
    +0.12 to +0.48 for the "engine lower" ones.
  * *Missing tasks were worth nothing at depth 6.* The depth-6 values become: "engine higher"
    +1.25 to +1.82, controls +1.38 and +1.47, "engine lower" +0.33 to +0.92. Every value is still
    above its depth-4 value, and the groups still do not overlap.

  Neither bound is a proof: a missing task could also have gone the other way. Finishing the
  stopped tasks would settle it.
* **Conclusion:** on the tasks that finished, and under both pessimistic fills above, the
  depth-4 ranking of these spells is not a short-horizon artifact. A horizon longer than 6 plies
  remains untested.

## Caveats

* **What the value measures:** how much a spell is worth on average at a random moment of a
  game that holds it. That combines how often it matters with how much it matters when it does.
  The per-spell split is in the data file, as `samples`/values.
* **Distribution:** the positions come from engine self-play, not human games.
* **Depth:** all values are from depth-4 probes. The depth-6 check above predates the fix.

## Files

* `engine/reports/data/spell_values_2026-10-14.json`: this run's tier list, matchups and
  synergies in the Spells page schema, plus values, intervals, sample counts and the strength
  thresholds. A minified copy is the Spells page's Engine view
  (`docs/static/data/spell-charts-engine.json`).
* `engine/reports/data/spell_values_2026-10-12.json`: the first run, before the fix.
* `engine/reports/data/spell_values_depth6_2026-10-12.txt`: the depth-6 table (before the fix).
* Raw probe logs: runs listed in `gs://focus-surfer-494820-g0-sigil/data/spell_values/runs_rerun_2026-10-14.txt`
  (first run: `*-sigil-sv-*`, `*-sigil-sv27-*`, `*-sigil-d6-*`). Plans: `gs://…/data/spell_values/`.
* Code: `engine/harness/spell_value_probe.py` (the plan is now an argument),
  `fit_spell_values.py`, `spell_depth_probe.py`.
