# Rated games from a position (2026-10-21)

**What shipped.** A game that starts from a position is priced by the engine's eval of that
position:
* "Rematch from here" in a review, against the AI or online;
* Import Position against an AI tier, or as an online room.

The player sees the eval, the win chance and each side's rating payoffs, then picks a side.
The rating update treats the position as an Elo handicap:

```
E_red = σ( logit(p_red) + (ln10/400)·(R_red − R_blue) )      K = 32, no 1-point floor
```

If `p_red` is right, either side's expected rating change is zero at any rating gap, so
picking a side is worth no more than picking at random. Some further rules:
* A proven forced win is certain (`p_red` is exactly 0 or 1): +0 if converted, −32 if not.
* A game from a position whose start was not priced is unrated. Until now "Rematch from
  here" against the AI was rated with plain Elo, so a won position could be farmed.
* Standard games are unchanged.

Code: `docs/static/scripts/engine/position-rating.js` and `elo.js` (`positionExpectedScore`,
`computeEloChange`). `functions/index.js` is kept in step.

**What `p_red` means.** It is P(red wins) when the Very Hard AI plays both sides from the
position: 60 s a move, the shipped `nnue_mt256` search, the tier's 21-bit table, no
pondering. That AI now beats every human on the site, so its results are the target, not
human-vs-human ones (Robi, 2026-10-21). Positions the engine misjudges can be farmed; that
is accepted, since those games are training data for exactly those positions.

## Data

`engine/harness/position_starts.py` sampled 6,000 starts. 70% are a uniformly random ply of
one of 1,635 recorded human games (`data/interp/human_lines_2026-10-13.json`, standard and
competitive only, old-rule games dropped), with the earlier positions kept as repetition
history. The other 30% are a random ply of v31 depth-5 self-play.

`engine/harness/position_selfplay.py` scored each start with `se.analyze` at depths 4, 5 and 6
(fresh table, shipped config). It then played the start out Very Hard against Very Hard.

* Runs: one pilot VM (90 games) and five Spot c3d-highcpu-90 VMs (11 games a shard).
  The run list is `gs://focus-surfer-494820-g0-sigil/data/posrating/runs_v1.txt`.
* 5,028 games finished: 3,509 from human starts and 1,519 from self-play starts. None hit the
  ply cap.
* Median length was 20 plies. Each game took about 23 minutes of one vCPU, evals included.
* About 12 of the 4,950 shards were still on their 11th game when the 6-hour watchdog
  stopped the VMs, so those games are missing.
* This run gave each human start the game's earlier positions as history, but a rated game
  from the position starts with none. Only a history that repeats a position can change a
  game, so the fit drops the 59 starts (50 played) whose history did
  (`--exclude-hist-repeats`): 4,978 games are fitted. Dropping them moves no parameter by
  more than 0.02. `position_selfplay.py` now passes no history.

## Fit

`engine/harness/fit_position_winprob.py` fits one curve per eval depth:

```
logit p_red = a + b·s + c·[red to move] + (aPhase + bPhase·s)·phase
```

* `s` is the eval in stones from red's side, with the even-game offset applied (0 is even).
* `phase` is min(turn counter, 60) / 60 of the start, read from the side to move's SFN.
* Proven mates are left out of the fit: they are certain.
* "Likely" (unproven) mates get the observed win rate of the side they favour: 0.99 at
  depth 4 and 0.98 at depths 5 and 6.

| depth | a | b (per stone) | c (red to move) | aPhase | bPhase | n | held-out log-loss (constant) |
|---|---|---|---|---|---|---|---|
| 4 | −0.08 | 1.42 | +0.21 | −0.65 | −0.86 | 4,457 | 0.542 (0.680) |
| 5 | +0.24 | 1.46 | −0.47 | −0.58 | −0.96 | 4,352 | 0.526 (0.680) |
| 6 | −0.08 | 1.48 | +0.16 | −0.55 | −1.06 | 4,268 | 0.519 (0.678) |

Held out means positions whose index is a multiple of 5 (about 870 per depth), refitted
without them.

* **How steep the curve is.** Between Very Hard players, a one-stone lead early in the game
  is a 75–78% favourite. That is much steeper than the review graph's win% (about 0.41 logit
  per stone) and the outcome fit of depth-4 self-play labels (0.65 per stone).
* **The phase terms.** They cut held-out log-loss in all five folds at every depth (mean
  0.004–0.005 nats), and their bootstrap CIs exclude zero. For example, bPhase at depth 6 is
  [−1.42, −0.70] (fitted on all 5,028). A stone is worth less late in the game: +1 at turn 6 is 78%, at turn 40
  58% (depth 6, blue to move).
* **The red-to-move term.** It flips sign at depth 5 against depths 4 and 6, which is the
  odd/even horizon of the search (which side moves last). So each depth needs its own curve.
* **Calibration.** On held-out positions the mean of (result − expected) is −0.004 to −0.008
  for red and the mirror for blue. That is about 0.1–0.25 rating points per game. Reliability
  by bucket is within noise, except that the top bucket is slightly overconfident: predicted
  0.955, observed 0.91–0.92 (n ≈ 110).

Payoffs at equal ratings (depth 6, red to move, turn 13):

| eval | P(red wins) | Red: win / loss | Blue: win / loss |
|---|---|---|---|
| 0.0 | 0.49 | +16 / −16 | +16 / −16 |
| +1.0 | 0.77 | +7 / −25 | +25 / −7 |
| +2.0 | 0.92 | +3 / −29 | +29 / −3 |
| +3.0 | 0.98 | +1 / −31 | +31 / −1 |

**One engine bug.** A depth-6 search proved mate-in-1 for red and red still lost. This is
start 3137, a competitive draw holding Fissure:
`rrrrrrrrb...b....b......b..bbbb.b..r.../Starfall,Seal_of_Destruction,Fissure,Hail_Storm,Seal_of_Stone,Fury,Gust,Seal_of_Summer,Comet r 24 1:0 Fury:- -:- b1 competitive`.
No other proven mate was lost (634 proven-mate evals across the three depths). The Fissure work on `fissure-dead-spells` may
already cover it; it is not investigated here.

**Not done.** The planned cheap cross-check (the same slope on v31 depth-5 self-play chunks,
the `--v31` flag) was not run, because the local copy of those chunks was lost with the
Cloud Shell scratch space.

## How the site uses it

* **The eval.**
  * The review's own eval is used when the review recorded its depth: stored `game_evals`
    and live reviews, whose `depthPerPly` is new.
  * Otherwise a 5 s search with the review settings runs, retried longer if it completes
    fewer than 4 plies.
  * The deepest fitted curve at or below the completed depth prices the eval.
  * In headless Chrome on Cloud Shell the 5 s search reached depth 4.
* **The SFN that is priced.** It is the side to move's SFN: `positionTurnSfn`, which advances
  the turn counter and hands the move to that parity's side, as the game loop does. A game
  is rated only when its first turn's SFN equals the priced one.
* **Online.**
  * The creator sees payoffs at equal ratings, since the opponent is unknown, and picks a
    side (`creatorColor`).
  * The joiner sees their own payoffs before joining.
  * A rematch replays the position with sides swapped.
  * The room stores `startSfn` and `startPos`. `completed_games`, the AI rooms and saves
    store `startPos`, and `user_games` gets `fromPosition`.
* **Refit when the shipped eval changes.** `position-winprob.json` names the eval it was
  fitted on, and the page warns in the console when the engine plays a different one. To
  refit: `position_starts.py` → `position_selfplay.py` on a fleet → `fit_position_winprob.py`.

Tests:
* `tools/position-rating-smoke.js`: zero expected change for either side over a grid of
  odds and rating gaps; the standard formula unchanged; forced wins; the phase terms; the
  Elo write.
* `tools/browser/position-side-test.js`: the side picker against the AI.
* `tools/browser/position-room-test.js`: an online room from a position, with two guests on
  the live database.
