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

ARENA2_PLACEHOLDER
