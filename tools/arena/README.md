# Headless Caveman arena

Runs the **same** browser Caveman engine (`docs/static/scripts/engine/`) under
Node, parallelized across CPU threads — so a batch of AI-vs-AI games finishes
roughly N-cores faster than the one-tab-at-a-time browser arena, and each move
reaches the same depth (no rendering, no Web Worker postMessage round-trip).

The engine files are loaded by concatenating them in the same order the
in-browser AI Worker uses (`ai-worker.js` `importScripts`) and running once
under Node's `vm` — no DOM, no browser. It is the identical search code, so it
makes the identical move from a given position **at equal search depth**. (A
given *time* budget may reach a different depth than the browser, since that
depends on machine speed — this CPU reaches deeper in the same wall-clock.)

## Run

```bash
# Node lives at ~/.local/node/bin/node on this machine (no system install).
~/.local/node/bin/node tools/arena/arena.js --games 16 --time 10

# A few useful variants:
~/.local/node/bin/node tools/arena/arena.js --games 32 --time 5 --seed 42
~/.local/node/bin/node tools/arena/arena.js --red pruned_minimax --blue pure_minimax
~/.local/node/bin/node tools/arena/arena.js --games 8 --time 10 --json out.json
```

## Options

| flag | default | meaning |
|---|---|---|
| `--games N` | 10 | games to play |
| `--time S` | 10 | seconds per move, per side |
| `--red SPEC` | `pure_minimax` | red AI spec (see below) |
| `--blue SPEC` | `pruned_minimax` | blue AI spec |
| `--swap` / `--no-swap` | swap on | alternate which AI plays red (color fairness) |
| `--pack KEY` | `core` | spell pack used to generate each game's layout |
| `--seed N` | time-based | RNG seed → reproducible spell layouts |
| `--max-depth N` | 64 | ply cap per search |
| `--max-turns N` | 300 | ply cap per game |
| `--threads N` | CPU count | worker threads |
| `--json PATH` | — | also dump full per-game results |

## AI spec syntax

An AI spec is `<mode>[:key=val,key=val]`:

- **mode**: `pure_minimax` (alpha-beta cutoffs off) | `pruned_minimax` (cutoffs on)
- **`plies=N`**: use *exhaustive* enumeration (all dash/cast variants, capped) at
  every ply `< N`, instead of the engine's historical root+ply-1 only. `N>2`
  lets the search see alternative dash sacrifices / spell targets deeper in a
  line rather than the single greedy variant — at the cost of branching factor
  (so it reaches less depth). This is the knob for testing whether incomplete
  deep enumeration is what makes pruning drop optimal lines.
- **`caps=F`**: scale every `ENUM_CAPS` entry by `F` (e.g. `caps=2` doubles how
  many variants of each choice-point are expanded where exhaustive enumeration
  is active).
- **`capabs=N`**: pin *every* cap to `N` (overrides `caps`). `capabs=1` with a
  high `plies` is "smart greedy" — the engine's single top-*ranked* dash/cast
  variant at every ply, same branching as the default greedy enumerator but a
  ranked pick instead of an arbitrary `NODE_ORDER` one. Tests whether better
  variant *quality* (rather than more variant *width*) helps, without paying
  the depth cost that `plies` alone incurs.
- **`deepcap=N`**: the proposed production form — exhaustive at every ply, full
  `ENUM_CAPS` breadth at root + ply 1, ranked top-`N` deeper. `deepcap=1` keeps
  greedy's branching but a ranked deep pick. See `RANKED_ENUMERATION.md`.

```bash
# Does deeper exhaustive enumeration let pruned stop losing to pure?
~/.local/node/bin/node tools/arena/arena.js --games 16 --time 10 \
  --red pure_minimax --blue pruned_minimax:plies=3

# Head-to-head: deeper-enum pruned vs default pruned
~/.local/node/bin/node tools/arena/arena.js --games 16 --time 10 \
  --red pruned_minimax --blue pruned_minimax:plies=3,caps=2
```

Defaults preserve production behavior: with no `plies`/`caps` keys the engine
takes its original root+ply-1 exhaustive path, so the browser build is
unaffected (these opts are only ever set by this harness).

## Watch a game live (Firebase spectator)

```bash
# stream one live game to a Firebase room; watch at the printed URL
~/.local/node/bin/node tools/arena/arena.js --watch --time 5 \
  --red pure_minimax --blue pruned_minimax:plies=64,capabs=1
# (or the standalone: node tools/arena/watch-game.js --time 5 ...)
```

This publishes the game to the production `rooms/{code}` (world-writable path —
no auth/service-account; `ranked:false`, random code, never touches
leaderboard/completed_games) and prints `multiplayer.html?id=CODE`. The existing
spectator UI replays it unchanged. Extra flags: `--move-delay MS` (pacing on top
of think time), `--site URL` (default `http://localhost:8080`), `--keep`.

How the wire format is produced: each resolved engine `SimTurn` is converted to
the spectator's input action-string sequence by `actions-search.js`, which
drives the real `SpectatorController` headless and searches for the sequence
whose replay reproduces the engine's board (verified by SFN match — see
`consumer.js`, `verify-game.js`). 100% turn coverage; a turn that fails
verification aborts the stream rather than desyncing the viewer.

## Reading the output

- **Wins are tallied by AI identity, not color** — with `--swap`, each engine
  plays red in half the games, so the tally is color-fair.
- **`avgDepth` / `maxD`** are the headline: at an equal time budget,
  `pruned_minimax` reaches deeper because alpha-beta cutoffs let it skip
  subtrees. `pure_minimax` spends the budget on full-width search and burns
  through many more `nodes/ply`.
- **`ttCuts/mv`** counts transposition-table-hit cutoffs only (present in both
  variants) — it is *not* the alpha-beta beta-cutoff count, so don't read it as
  the pruning metric. Depth-at-equal-budget is the pruning evidence.

## Faithfulness to the live game

The loop mirrors `game-controller.js` `_runGameLoop`: standard opening (red a1,
blue b1), per-turn threefold-repetition tracking (5× a snapshot → blue wins),
Inferno self-destruct at a player's turn start, and move application via the
engine's own `_minimaxApplyTurn` (the same primitive the search uses, which
also advances the turn). It does not render or emit UI events.
