# Fissure: the engine could not see dead spells (engine v33, 2026-10-21)

**Question (Robi, 2026-10-21):** after Fissure walls a node, does the AI keep filling the
other nodes of the now-useless spell, as if it still meant to cast it? Should it be
fine-tuned on Fissure self-play?

**Answer:** yes, it did, and fine-tuning could not have fixed it. Engine v33 tells the
evaluation and the search heuristics which spells are dead: **+21.9 Elo [+10.0, +33.9]**
on Fissure draws at 10 s, and no change in games without a wall.

## Cause

A sigil holding a Fissure wall can never charge again (`Board::update` already refused to
mark it charged, so the engine never tried to cast it). But nothing else knew:

* **The net has no wall input.** `nnue_mt256` reads mine / theirs occupancy and side to
  move; training prep reads only `r` / `b` from the SFN. A wall looks exactly like an empty
  node, so more self-play cannot teach the net that a spell is dead.
* **The spell conditioning ignored walls.** `fold_masked` kept the dead spell's per-node E
  rows and its draw term G, so stones in a dead sigil still earned charge-progress credit,
  and the opponent's partial fill there still counted as a threat.
* **The heuristics counted the wall as a missing stone.** `uncontrolled_count` is
  `SIGIL & !mine`, so a dead sigil looked one or two short to move ordering
  (`order.rs`), key-dash fill targets (`key_dash.rs`, whose target could even be the wall),
  `turn_iter.rs`'s lead and fill scans, the ranker's "charges" feature and the prior.

## Fix

* `Board::dead_slots()`: the sigil slots holding a wall. `nn::eval` clears them from both
  sides' access mask, so a dead slot gets exactly the fold an access-blocked slot gets
  (spell-blind rows, no G term). No retraining.
* `Board::fill_gap()`: `uncontrolled_count`, or `DEAD_GAP` (64) for a walled sigil, at every
  heuristic site. The rules (Azimuth, Eclipse) keep `uncontrolled_count`.
* Tests: a walled sigil never charges and never looks short; ordering gives no fill credit
  in it; the net's value on a walled board equals the both-sides-blocked board's.

## Evidence

**Recorded games** (348 games since the 2026-10-07 Fissure rule change; turns starting with
an empty node in a dead sigil). Share of the mover's new stones landing in dead sigils,
against the dead share of the empty nodes:

| mover | turns | dead share | baseline |
|---|---|---|---|
| Rust AI (Easy) | 320 | 13.2% | 10.2% |
| Rust AI (Hard) | 106 | 12.0% | 9.1% |
| humans | 404 | 4.1% | 9.9% |

**Paired probe** (`harness/fissure_dead_fill.py`): the same 837 recorded-game positions,
each searched at 2 s by v32 and by v33, shipped config.

| engine | turns filling a dead sigil | dead share of new stones |
|---|---|---|
| v32 | 12.1% | 9.9% |
| v33 | 8.2% | 7.0% |

41 positions where only v32 fills a dead sigil, 9 where only v33 does. Baseline 9.9%.

**No change without walls:** on the 101 positions of `positions_midgame.txt` and
`positions_expansion.txt` at fixed depth 3, v32 and v33 play the same move every time.
A control arena on wall-free draws would only measure noise, so none was run.

**Arena:** `ab_version.py`, v33 against v32, 10 s per move, shipped config, colours swapped,
`SIGIL_REQUIRE_SPELL=39` (every draw holds Fissure), 4 Spot c3d-highcpu-90 VMs.

| VM | games | v33 W-L | Elo |
|---|---|---|---|
| fdf-1 | 1,080 | 577-503 | +23.8 [+3.1, +44.7] |
| fdf-2 | 1,080 | 584-496 | +28.4 [+7.7, +49.3] |
| fdf-3 | 1,080 | 559-521 | +12.2 [−8.5, +33.0] |
| fdf-0 (preempted) | 45 | 26-19 | |
| **all** | **3,285** | **1,746-1,539** | **+21.9 [+10.0, +33.9]** |

Only games in which a wall actually appears can differ (about a third of Fissure draws in a
local sample), so the effect within those games is larger.

## What is left

v33 still fills dead sigils more often than humans do (7.0% against 4.1%). The net still sees
the wall itself as an empty node, which affects its reading of adjacency around it. A wall
input plane needs a retrain (prep, model, `.bin` format, `nn.rs`), so it belongs in round 5,
with Fissure oversampled through `SIGIL_SPELL_SCHEDULE`.

## Data

* Runs: `20261021T042035Z-sigil-fdf-0`, `20261021T041949Z-sigil-fdf-1`,
  `20261021T042051Z-sigil-fdf-2`, `20261021T042013Z-sigil-fdf-3`.
* Arm file: `engine/gcp/arms/fissure_dead_10s.txt`.
