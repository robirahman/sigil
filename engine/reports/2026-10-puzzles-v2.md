# Puzzles v2: the set regenerated with engine v33, plus winning-turn puzzles (2026-10-22)

**Request (Robi, 2026-10-22):** improve the Puzzles page now that the engine is far stronger than when the
first set was collected (engine v5, 2026-09-18).

**Result:**

- **1,577 puzzles**, up from 1,047:

  | Kind | Old set | New set |
  |---|---|---|
  | Mate in 1 | 595 | 714 |
  | Mate in 2 | 333 | 560 |
  | Mate in 3 | 119 | 213 |
  | Winning turn | — | 90 |

  "Winning turn" is a new kind: find the turn that keeps a winning game.
- **Every puzzle now carries:**
  - a 1–5 difficulty;
  - theme tags;
  - whether the player in the game found the turn.
- **The page gained:**
  - filters for kind, difficulty and theme;
  - a daily puzzle, the same for everyone, with a streak counter;
  - "My missed wins", which lists puzzles from the signed-in player's own ranked games where they missed the win.
- **A real bug turned up along the way:** the browser refused every engine turn that completes the Seal of Destruction. It is fixed (see below).

## The old set, re-proven

Each of the 1,047 old puzzles was solved again from scratch by the v33 solver, under today's rules and with
the cast-keep choices enumerated:

| Outcome | Puzzles |
|---|---|
| kept, same winning turns | 818 |
| kept, the set of winning turns changed | 133 |
| mate in 3 was really a mate in 2 | 45 |
| no forced mate any more (4 mate-in-3, 1 mate-in-1) | 5 |
| the solver now runs out of time or enumeration room | 46 |

The new set keeps everything that still proves; nothing is carried over unproven.

## Where the new puzzles come from

**Corpus**
- 2,992 games and 81,040 turns, downloaded 2026-10-22. The old set used 2,546 games.
- About 300 recent games used to be lost at hydration. The replay bridge compared the recorded `finalSfn` byte for byte, and in 284 of those games the only difference was the side-to-move token. The generator now compares positions instead.

**Newly in scope**
- Tectonic positions (walls) and Providence positions (banks), since the engine now handles both. 74 puzzles involve a Tectonic spell and 50 a Providence spell.
- Scramble is skipped explicitly, because the engine would read it as Standard.

**Mate pass** (exhaustive mate-in-1; mates in 2 and 3 are nominated by the engine, then proven against every reply), 55,287 positions:

| Outcome | Positions |
|---|---|
| no mate | 39,108 |
| mate in 1 judged too easy | 2,112 |
| enumeration too large | 5,431 |
| time budget exceeded | 2,106 |
| spell outside the engine's scope | 1,021 |

**Winning-turn pass** (`tools/winning_turns.py`)

This pass ran on every position that did not yield a mate puzzle. The rule:

- the best turn keeps P(win) ≥ 0.75, using the PR #28 curves (`position-winprob.json`);
- at most 3 turns lie within 0.05 of the best, and those are the solutions;
- every other candidate the root search expanded sits at least 0.25 below the best;
- the verdict holds when each child is searched to depth 4 and again to depth 5.

| Verdict | Positions |
|---|---|
| not winning | 31,308 |
| grey zone (another turn is 0.05–0.25 below the best) | 7,156 |
| too many winning turns | 6,441 |
| a mate (left to the solver) | 1,092 |
| errors (out-of-scope spells) | 1,022 |
| failed the depth-5 confirmation | 558 |
| **puzzle** | **90** |

Winning positions in Sigil usually have many good turns. That is why the yield is low and why the gap is what makes a position a puzzle. A random-position probe under a stricter absolute rule (best ≥ 0.80, all others ≤ 0.55) found none in 300 positions.

The depth-5 confirmation matters: one candidate's value moved from 0.006 to 0.815 between depths 4 and 5.

Across the 90 puzzles:

- the median best turn keeps 0.96, and the median runner-up 0.55;
- the player found the turn in 56 games and missed it in 34.

**Difficulty**

Each puzzle is ranked within its own kind, so each difficulty level holds about 20% of that kind. Two measures set the order:

1. the shallowest depth at which the shipped search plays a solution;
2. the solution's rank in the engine's ordered list of candidate turns.

**Tags**

Tags come from the first stored solution: Dash, Push, Quiet (no cast), Sacrifice, Cast: \<spell\>, Endgame (turn 40 or later), and Tectonic or Providence.

## The Seal of Destruction refusal (a live bug)

`rustActionsToTurn` (`rust-ai.js`) is the gate every engine turn passes through: it replays the engine's actions and refuses the turn if the position differs from the one the engine reported.

- **The defect:** the gate replayed the turn without the end-of-turn Seal of Destruction burn, which the game controller applies next. The engine's position includes the burn, so every engine turn that completes the Seal was refused.
- **Puzzle impact:** 23 of the 59 puzzles in the new set that involve the Seal had stored lines the gate rejected. In 4 of them, the scripted defence would have thrown on the page.
- **Live impact:** a Rust AI turn that completes the Seal in a real game hits the same refusal. The game loop rethrows the error.
- **Fix:** the burn is now one function, `sealOfDestructionBurn` in `constants.js`, used by both the controller and the gate.
- **Checks:**
  - `tools/puzzle-smoke.js --replay` replays every stored turn of every puzzle (casts included) through the gate. **1,577 of 1,577 reproduce.**
  - The input-driven smoke test (moves and dashes only) passes 238 puzzles with 0 failures; the other 1,339 need spell prompts and are skipped.

## The page

- **Winning-turn puzzles:**
  - A stored solution solves the puzzle at once.
  - Any other turn is searched for 5 s or more (to at least depth 4), converted to a win chance with the same curves, and accepted if it reaches the puzzle's `accept_p`, the midpoint between the best and second-best turns.
- **Daily puzzle and streak:**
  - Today's puzzle is picked by hashing the UTC date over difficulty 2–4.
  - The streak lives in `localStorage` (`sigil_puzzle_daily`), and only each day's first result counts.
- **My missed wins:**
  - Reads the public `user_games/<uid>` and matches its keys against `puzzle.game.id`, so no uid appears in the static JSON.
  - Ranked games only, since unranked games have no `user_games` rows.
- **Offline use:** `sw.js` precaches the puzzle set (5.9 MB).

## Cost

- Four Spot c3d-highcpu-90 VMs, `sigil-pz2-0` to `sigil-pz2-3`, one shard each, about one hour apiece: roughly $5.
- Runs:
  - `20261022T022551Z`
  - `20261022T022504Z`
  - `20261022T022520Z`
  - `20261022T022534Z`
- The work files are under `runs/<run>/live/` (`mates.jsonl`, `winning.jsonl`).

## Not done

- Puzzle ratings and syncing progress to an account.
- Cataclysm and Scramble puzzles: the engine has neither variant.
- A wall input for the net: some Fissure positions are judged by an evaluation that cannot see walls (see `2026-10-fissure-dead-spells.md`).
