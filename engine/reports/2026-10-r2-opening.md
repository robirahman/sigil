# Round 2: the competitive opening selector under v25 (2026-10-07)

Branch `r2-opening`, cut from `providence-bank` at a3771ed0 (v25). Question (Robi): now that the AI is
stronger, should the hand-built competitive opening selector (`opening.rs`, the strategy-survey
Bradley-Terry minimax) be replaced, possibly by a learned selector trained on game records and self-play?

## History

The selector was arena-tested once before shipping (FINDINGS, 2026-09-21, v11, `tfit`, 3 s): **-15.6 Elo
[-25.9, -5.4]** against the base engine's spell-blind opening. It shipped anyway for a human playtest, on
the designer's expectation that the sigil pick is worth more against people over a long game. Later
sub-rules were gated on top of it (Syzygy +43, Carnage +35 in their own draws; contest rules flat).

## 1. Book ON (shipped) vs book OFF, v25

Competitive variant, 10 s/move, colour-swapped, both arms `nnue_spell` with the shipped generator policy
(new `SIGIL_POLICY=shipped` mode in `ab_search.py`: the policy is thread-local and off by default in
Python, so without it a non-policy arena measures the pre-v25 search). Core draws only (the selector
does not apply to Tectonic/Providence spells, and `legal_draw` draws core spells). Runs
20261007T052139Z-sigil-r2o-book-a and 20261007T052151Z-sigil-r2o-book-b, 2 x c3d-highcpu-90 on demand,
pooled from GAME lines, no unfinished games.

| arm vs base | games | arm win rate | Elo (95% CI) |
|---|---|---|---|
| book OFF vs book ON | 2,160 | 62.73% [60.67, 64.75] | **+90.5 [+75.3, +105.6]** |

With v25 the search and the spell-conditioned network choose the first placement far better than the
table does. They also choose very differently: from the arena's saved positions, the book-off arm's
first placement fell in the book's sigil only **12.0%** of the time (red 13.1%, blue 10.8%). Where it
went instead: a ritual 42%, a charm 40%, a sorcery 7%, and **outside every sigil (mana/void nodes) 10.5%**
-- the option FINDINGS noted the selector never considers.

## 2. A learned selector

**Data.** Game records were too thin and too selected to label every sigil choice: in self-play the first
placement is the selector's pick except at the 8% random plies, and human competitive games are few. So
`harness/opening_rollouts.py` plays every choice out with the shipped v25 engine (new data hook
`opening::set_opening_force(mask)`, export `SIGIL_MASKS`): per draw, red's first stone forced into each of
the 9 sigils, then blue's reply forced into each open sigil after red's book pick, 16 games per cell at
1 s/move. 270 core draws, 4,815 cells, 77,040 games (3 x c3d-highcpu-90 Spot, europe-west4, runs
20261007T053827Z/053849Z/053911Z-sigil-r2o-roll-*).

Caveat found in the data: **70% of cells are all-or-nothing** (0 or 16 wins of 16). A timed search on the
same draw and the same forced sigil replays nearly the same game, so a cell is closer to one game than
to sixteen. Varying the clock or a random early ply per game would have bought real samples for the
same compute.

**Model** (`opening_learned.rs`, fitter `harness/fit_opening_selector.py`): per side, a linear score over
a candidate sigil -- the spell at the slot, its two zone-mates, and (blue) contesting red's sigil --
fitted as a binomial logistic regression with a per-draw intercept, L2 1.0. Integer weights (x1000), so
native and wasm agree by construction; tests pin that the pick is one whole sigil and restricts the root.
Switch `set_opening_learned` / knob `opening_learned` (1 learned, 0 book, 2 neither), default off.

**Offline** (5-fold, held-out draws, all 270): the learned pick lands on a winning cell more often than
the book's -- red 148/270 vs 125/270, blue 100/270 vs 72/270; mean regret red 0.31 vs 0.40, blue 0.48 vs
0.55 (random 0.46 / 0.54). The weights in the arena were fitted on the first 214 draws (same picture:
red 120 vs 109, blue 85 vs 61).

**Arena: learned selector vs no selector**, competitive, 10 s/move, colour-swapped, v25 both arms
(runs 20261007T084326Z/084337Z-sigil-r2o-lrn-*):

| arm vs base | games | arm win rate | Elo (95% CI) |
|---|---|---|---|
| learned selector vs book OFF | 1,724 (interim, see below) | 43.97% [41.64, 46.32] | **-42.1 [-58.6, -25.6]** |

Interim: the gcloud login expired at about 10:25 UTC with one of the two VMs still finishing its last
games, so this is pooled from the GAME lines uploaded by 09:45 (1,724 of 2,160). The early-finishing
games skew short and decisive; the interval is far enough from zero that the verdict will not change.

By transitivity the learned selector would sit about +48 above the book, but it loses clearly to letting
the v25 search choose, and it can only ever pick a sigil -- the search also opens on mana/void nodes
(10.5% of its first placements above).

## Recommendation

**Drop the opening book for v25: switch `opening_book` off by default** (search + `nnue_spell` choose the
first placement). +90.5 Elo [+75.3, +105.6] in competitive self-play at 10 s, and nothing to maintain.
**Do not ship the learned selector**: it loses -42 [-59, -26] to no selector. The hand-built selector was
needed only because the old eval could not tell placements apart; the spell-conditioned network can.

Before flipping the default on the site: the change only affects the competitive variant's first move per
side; the switch exists in wasm (`opening_book_enabled` is read by `Search::opening_root_turns`), so it is
a one-line default change plus the usual wasm rebuild, version bump and `tools/wasm-smoke.js` /
`tools/policy-wasm-parity.js`. Not done here (shipped defaults unchanged, as briefed). The designer's
original case for the book was human play over long games; the v25 human benchmark suites and the
weakness report on post-change competitive games are the check.

## Spend

About $34: book arena 2 x c3d-highcpu-90 on demand ~1.6 h (~$10); rollouts 3 x Spot ~3.5 h (~$13);
learned arena 2 x on demand ~1.7 h so far (~$11).

## Files

`engine/harness/ab_search.py` (`SIGIL_POLICY=shipped`, knob `opening_learned`), `engine/gcp/launch.sh` /
`runner.sh` (policy-mode metadata), `engine/src/opening.rs` (`set_opening_force`), `engine/src/search.rs`,
`engine/src/py.rs` (`set_opening_force`, `set_opening_learned`, `SIGIL_MASKS`), `engine/src/opening_learned.rs`,
`engine/src/opening_learned_weights.rs`, `engine/src/lib.rs`, `engine/src/tests.rs`,
`engine/harness/opening_rollouts.py`, `engine/harness/fit_opening_selector.py`,
`engine/data/opening_learned_fit.json`, `engine/gcp/arms/r2o_*.txt`.

