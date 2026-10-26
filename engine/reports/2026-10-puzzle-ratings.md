# Puzzle ratings (2026-10-25)

**Request (Robi, 2026-10-22):**
- Every player gets a rating at solving puzzles, and every puzzle gets a difficulty rating.
- Calibrate the puzzles with a round robin of the Easy, Medium, Hard and Very Hard AI accounts (10 games per pair, 5 as each colour), saved to Firebase and the leaderboard.
- Then have each AI attempt every puzzle: the puzzle wins when the AI fails it.

**Later decisions:**
- Do not pin Hard. Shift all four ratings so they keep their total.
- Add a weaker calibration player, Very Easy (10 ms a move), rated by 10 games each against Easy and Medium.
- Add harder puzzles so that Very Hard solves no more than 90% of the set; positions from the engine's self-play may be used.
- Puzzle ratings also move when players attempt them (Lichess-style).

## AI ratings

**Round robin:** 60 games, no draws, 10 s and 60 s tiers pondering as in the browser.

| Tier | W–L | Before | After |
|---|---|---|---|
| Very Hard (60 s) | 25–5 | 1733 | **1800** |
| Hard (10 s) | 20–10 | 1608 | **1673** |
| Medium (1 s) | 10–20 | 1479 | **1445** |
| Easy (0.1 s) | 5–25 | 1417 | **1319** |

- **Method:** maximum-likelihood Elo, shifted so the four ratings keep their sum (6,237). The integers are rounded so the sum stays exact (`engine/harness/fit_tier_ratings.py --keep-sum`).
- **Very Easy (10 ms):** 3–7 against Easy and 2–8 against Medium. That rates it **1185 (±91)** against the new Easy and Medium (`--fixed`). It has no site account and is used only for calibration.
- **Where it's stored:**
  - Games: Firebase `ai_arena_games/rr20261022_*` (60) and `rr20261022ve_*` (20).
  - Ratings: `users/` and `leaderboard/` for the four site tiers.
  - Backup of the previous records: `gs://…/patches/ai_ratings_before_2026-10-22.json`.

## Harder puzzles

**Why:** the four site tiers solved almost the whole published set. Very Hard solved 93% of it, and all four solved 1,250 of 1,577 puzzles. The AI results alone could not tell those puzzles apart.

**Where the new ones come from:**
- 29,662 self-play games from engine v27 (3,000 training files at `gs://…/data/s3/v27_2026-10-07/d4`).
- Only the 70,713 positions where the side to move won within a few turns.
- The usual pass ran on those positions: mates in 1, 2 and 3 (`tools/selfplay_corpus.py`, then `gen_mate_puzzles.py` with `PROMISING_ONLY`) and the winning-turn analysis.

**Results:**
- 15,839 candidates.
- Very Hard attempted every one and failed 867.
- **400 were added:**
  - all 6 winning turns and all 81 mates in 3;
  - 150 mates in 2 and 163 mates in 1, sampled at random.
  - 2 duplicated a published position, so the set grew by 398.

**Turn-counter fix:** about two-thirds of the self-play positions numbered turns the other way round from the browser (red to move on an even turn). The browser assigns the side to move from the turn counter, so these were shifted by one turn. Nothing depends on the absolute number, and puzzle positions are matched without it.

**The set is now 1,966 puzzles:**
- 876 mate-in-1, 710 mate-in-2, 293 mate-in-3, 87 winning turns.
- Very Hard solves **75%** of it.

## Puzzle ratings

**Judging like the page (re-run 2026-10-26):** in the first calibration, an AI turn off the stored solution was answered by a generic 3-second defender, and a later win counted. The page instead has the engine judge such a turn at once (`judge_move`): a slow win or an escape fails the puzzle. The harness now calls the same judge (`sigil_engine.judge_move`, mirroring the wasm one) and plays its reply. All five tiers re-attempted the 1,003 mate-in-2 and mate-in-3 puzzles under it: about 8% of their results flipped (mostly solved to failed). The ratings below use those results, and the 302 Firebase ratings it changed were rewritten (no player had attempted them yet; only the rating field was written).

**Data:** each puzzle has attempts by all five tiers: Very Easy 1185, Easy 1319, Medium 1445, Hard 1673, Very Hard 1800.

**Method:**
- A puzzle's rating is its maximum a posteriori Elo against those tiers, where P(tier solves) = 1 / (1 + 10^((R_puzzle − R_tier) / 400)).
- The prior is normal, centred on the tiers' mean (1484), with standard deviation 350 (`tools/fit_puzzle_ratings.py --prior global`).

| Tiers that solved it | Puzzles |
|---|---|
| all 5 | 980 (rated 1048) |
| 4 | 277 |
| 3 | 245 |
| 2 | 108 |
| 1 | 68 |
| none | 288 (rated 1924) |

| Tier | Solved |
|---|---|
| Very Easy | 1,077 |
| Easy | 1,354 |
| Medium | 1,544 |
| Hard | 1,569 |
| Very Hard | 1,483 |

**Notes:**
- **Very Hard solves fewer than Hard.** This is a selection effect: the 400 additions were chosen because Very Hard failed them once, and Hard then solved 152 of them.
- **Median rating by class:**

  | Class | Median rating |
  |---|---|
  | Mate in 1 | 1048 |
  | Mate in 2 | 1245 |
  | Mate in 3 | 1405 |
  | Winning turn | 1048 |
  | Self-play additions | 1723 |

- **A per-cell prior was tried and not used.** Fitting the prior's mean per class and difficulty level (`--prior cell`) runs to the edge of the search grid in cells where every tier solves everything: ratings around 565 with no evidence behind them.
- **What the global prior does instead:** puzzles every tier solved share 1048, below Very Easy, and players' attempts spread them from there.
- **Seeded:** `puzzle_ratings/<id> = {rating, plays: 0}` for all 1,966 puzzles.

## Players

`docs/static/scripts/puzzle-rating.js`:

- **The game:** a player's first attempt at a puzzle is an Elo game between player and puzzle. Solving it is a win; a miss or a revealed solution is a loss.
- **K:** 40 for the player's first 20 attempts, then 20. The puzzle's K is 24 for its first 20 plays, then 12.
- **Signed-in players:**
  - Firebase stores `users/<uid>/puzzle {rating, plays, last}` and a write-once `users/<uid>/puzzleAttempts/<id>`.
  - The same single write updates `puzzle_ratings/<id>` and `puzzle_leaderboard/<uid>`.
- **Guests and anonymous users** keep a rating on their device and never move puzzle ratings.
- **Live rules,** deployed 2026-10-22:
  - Each rating change must create exactly one new attempt (`puzzle.last`).
  - The player's rating may move at most 40 per attempt, the puzzle's at most 32.
  - Puzzle ratings can be updated but never created by clients.
  - Anonymous users cannot write any of it.
  - Probed as a throwaway user against the live database: a valid attempt was accepted; anonymous, repeat, rating-only and oversized writes were rejected.
- **Page features:**
  - The Puzzles page shows both ratings and serves an unattempted puzzle near the player's rating when none is picked; "Next rated" does the same.
  - `leaderboard.html?tab=puzzles` lists the top puzzle ratings.

## Tests

- `tools/puzzle-smoke.js --replay`: every stored turn of all 1,966 puzzles reproduces through the replay gate.
- Input-driven smoke: 274 ok, 0 FAIL.
  - Two self-play mates end with the opponent left holding a charged Seal of Destruction. The browser ends that game at the start of the opponent's turn.
  - The page and the smoke test now accept that as the finishing win; before, the page called it a miss.
- `tools/browser/puzzle-v2-test.js` and `tools/browser/puzzle-rating-test.js`: ALL OK.

## Data

| What | Where |
|---|---|
| Attempt logs and tier ratings | `gs://…/puzzles/ratings_2026-10-25/` |
| Self-play candidates | `gs://…/puzzles/sp_candidates_2026-10-23.json` |
| Hard picks | `gs://…/puzzles/hard_ids.txt` |

**Runs:**
- Round robin: `20261022T172348Z-sigil-prr-a`, `20261022T172404Z-sigil-prr-b`.
- Very Easy games: `20261022T185238Z-sigil-prr-ve`.
- Attempts on the published set: `20261022T172432Z-sigil-pza-vh`, `20261022T172521Z-sigil-pza-rest`.
- Mining: `20261023T013618Z`, `013721Z`, `013744Z`, `013802Z`.
- Very Hard on the candidates: `20261023T04*-sigil-spvh-0..2`.
- Round 2 (Very Easy everywhere, other tiers on the additions): `20261025T224741Z-sigil-att2`.
