# Headless Caveman / Prune arena

Runs the **same** browser engine (`docs/static/scripts/engine/`) under Node,
parallelized across CPU threads, so a batch of AI-vs-AI games finishes ~N-cores
faster than the one-tab browser arena and each move reaches the same depth (no
rendering, no Web Worker round-trip). `engine.js` concatenates the engine files
in the same order as `ai-worker.js` `importScripts` and runs them once under
`vm` — identical search code, so it makes the identical move from a position at
equal search depth.

## Run

```bash
# Default: caveman (complete) vs prune (heuristic), 10 games, 10s/move.
node tools/arena/arena.js

# Useful variants:
node tools/arena/arena.js --games 32 --time 5 --seed 42
node tools/arena/arena.js --red caveman --blue prune --pack core
node tools/arena/arena.js --games 16 --time 10 --json out.json
```

(If Node isn't on PATH, this repo's notes reference `~/.local/node/bin/node`.)

## Options

| flag | default | meaning |
|---|---|---|
| `--games N` | 10 | games to play |
| `--time S` | 10 | seconds per move, per side |
| `--red SPEC` | `caveman` | red AI spec |
| `--blue SPEC` | `prune` | blue AI spec |
| `--swap` / `--no-swap` | swap on | alternate which AI plays red (color fairness) |
| `--pack KEY` | `core` | spell pack used to generate each game's layout |
| `--seed N` | time-based | RNG seed → reproducible spell layouts |
| `--max-depth N` | 64 | ply cap per search |
| `--max-turns N` | 300 | ply cap per game |
| `--threads N` | CPU count | worker threads |
| `--require-spell S` | — | regenerate layouts until they contain spell `S` |
| `--json PATH` | — | also dump full per-game results |

## AI spec syntax

`<mode>[:key=val,key=val]` — mode is `caveman` or `prune`:

- **caveman** — complete enumeration: every legal turn at every ply, no caps
  (the default game engine). Sound optimizations only (alpha-beta, TT, killers,
  ordering). A per-cast sequence budget + per-node turn ceiling bound the rare
  spell-saturated positions (e.g. Carnage with many pushable enemies); see
  `enumerator.js` `_FULL_SEQ_BUDGET` / `_MAX_TURNS_PER_NODE`.
- **prune** — ranked top-1 ("narrow") enumeration of each choice point at every
  ply + the Carnage refill/push planner. Trades completeness for depth.

Optional keys (experiments):
- `pure` — disable alpha-beta cutoffs (full minimax; same value, slower).
- `capabs=N` — pin every `ENUM_CAPS` choice-point to N ranked variants
  (`caveman:capabs=1` ≈ prune's narrow enumeration).
- `caps=F` — scale every `ENUM_CAPS` entry by F.
- `lp=0|1` — Carnage push planner on/off (prune default on).
- `refill=exhaustive|closest_enemy|farthest_enemy|closest_mana|farthest_mana`.

```bash
# Is complete Caveman stronger than heuristic Prune at this budget?
node tools/arena/arena.js --games 50 --time 5 --red caveman --blue prune
```

## Reading the output

- **Wins are tallied by AI identity, not color** — with `--swap` each engine
  plays red half the games, so the tally is color-fair.
- **avgDepth / maxD**: at an equal time budget `prune` reaches deeper because it
  expands far fewer turns per node; `caveman` spends the budget on full-width
  completeness. Win-rate is the strength signal.
- **ttCuts/mv** counts transposition-table-hit cutoffs only — not the alpha-beta
  beta-cutoff count.

## Faithfulness to the live game

The loop mirrors `game-controller.js`: standard opening (red a1, blue b1),
per-turn repetition tracking (3rd occurrence of a snapshot → blue wins), Inferno
self-destruct at a player's turn start, and move application via the engine's
own `_minimaxApplyTurn` (the same primitive the search uses, which also advances
the turn). It does not render or emit UI events.
