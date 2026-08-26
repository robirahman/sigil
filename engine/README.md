# `engine/` — Rust bitboard engine for the official 39-spell game

A rules kernel, exhaustive turn enumerator, and alpha-beta search, built to replace
the per-branch copying of a 39-key string-keyed board with two `u64` bitboards over
a static graph.

**Scope: the 39 official spells (ids 0..38).** The four deferred playtest packs
(Tectonic, Providence, Aftershock, Ambush — ids 39..50) and the fan-made Panda pack
are out. Dropping them removes every mechanic that made the state awkward: no
destroyed nodes, no pending move/burn schedules, no snares. A position is ~48 bytes
and `topology::ADJ` is a compile-time constant.

## Result

| measurement | this engine | shipped JS engine |
|---|---|---|
| strength, 402 games colour-swapped @200 ms/move | **66.7%** (z = 7.1) | 33.3% |
| completed search depth @200 ms/move | 5.9 | 1.7 |
| completed search depth @2 s/move | 8.1 | — |
| primitive throughput, 1 core | ~3.0 M units/s | — |

`ai/config.py`'s own promotion gate is 0.55 over 400 games, so the strength result
clears it. Both engines used pure material eval, so this is a search result.

## Build

```sh
python3 -m venv .venv && .venv/bin/pip install maturin
VIRTUAL_ENV=.venv .venv/bin/maturin develop --release   # builds the `sigil_engine` module
cargo test --release                                    # 55 unit tests
```

## Verification

Nothing here rests on unit tests alone; each harness compares against a reference
implementation. Point `$SCRATCH` at a directory holding `ref/` (a checkout of
`notation.py`, `simboard.py`, `ai/config.py` and `docs/static/scripts/engine/`).

| harness | what it proves |
|---|---|
| `harness/parity_primitives.py` | 4,000 random positions: move generation, push resolution, escape distance, crushability, charges, totals all match `simboard.py` |
| `harness/parity_resolvers.py` | 1,931 casts across 36/36 spells with Python references, every spell in all 9 sigil slots |
| `harness/check_completeness.py` | the greedy resolution is always a member of the exhaustive enumeration, all 39 spells |
| `harness/corpus_gate.py` | replays the committed self-play corpus: **4,202/4,202** positions, SFN round-trip + derived state + no missing legal first move |
| `harness/vs_caveman.py` | head-to-head against the deployed engine via `bridge/caveman_server.js` |

Autumn (`Harvest` / `Gather` / `Seal_of_Autumn`) is built from the live JS, which is
its only implementation — `simboard.py` has never had it — so it is covered by unit
tests written from that spec rather than by differential parity.

## Enumeration hides nothing

The shipped generator collapses every intra-turn choice to one greedy pick. Measured
over random legal midgame positions, that is **37.5 turns where 210,263 exist — a
4,144x expansion.** Both turn-level choices (push destinations, dash sacrifice
subsets, dash target, spell selection) and resolver-internal ones (Hail Storm's
victim per sigil, Meteor's target, Corrupt/Storm Front's sets, Hurricane's tied
groups, every sacrifice) are enumerated.

Because a materialised 210k-successor list is not searchable, generation is lazy and
best-first (`turn_iter.rs`), ordered by the heuristic in `order.rs`: which enemy
stone to deport, and where to send it — with the destination goal switching on what
the mover threatens (voids by default, spread for Hail Storm, fragment for Decay,
coalesce for Hurricane). Gust's `C(empties, displaced)` placements are generated
best-first over sets via a heap rather than enumerated.

The search then applies progressive widening: it expands the best-ordered K
successors, K shrinking with remaining depth. That is a bound on what gets
*expanded*, not on what gets *generated* — it is reported in `SearchStats` and
`width_scale` recovers any of it. Expanding all ~10^4 successors at every node was
measured at depth ~1.25, worse than the shipped engine.

## Notes for review

`FINDINGS.md` records the verified rule details and, deliberately, the mistakes:
several benchmarking traps that produced misleading numbers, a BFS-ordering bug that
a bitmask implementation would have shipped silently, and the positional-eval
experiments that failed.

Two things worth a maintainer's attention:

* **`simboard.looping_snapshot()` is wrong** and is not fixed here. Per Robi,
  side-to-move and springlock both count toward repetition: a position recurring
  with the springlock advanced is not a repetition, because that player cannot keep
  repeating it. The Python key omits both, making it over-broad — and threefold
  repetition is a blue win, so it can end games that should continue. There is a
  `TODO(upstream)` in `src/zobrist.rs`; this engine implements the JS rule.
* **Positional eval weights must stay strictly sub-material.** `cavemanCapWeights`
  caps `3*mana + 9*voidPenalty + 39*mapControl <= 0.96` stones. Violating that is
  fatal: uncapped variants scored 17.5% and 22.5% against material-only. Capped
  variants were neutral-to-negative here too (map-control 36.0%, mana+void 53.5% at
  ~depth 4.6 falling to 48.0% at ~depth 5.8), so the 2026-08 campaign's verdict
  survives cheaper depth.

## Playing it locally

`sigilbattle.com` is static GitHub Pages with every AI running client-side, so an
in-browser `?ai=rust` would need two things this branch does not have: a
WebAssembly build (groundwork is in place — see below) *and* a translation layer
emitting JS-compatible action lists for every spell resolution, since a `Cast`
action here carries an outcome index into our own enumeration that the JS side
cannot apply.

The terminal opponent needs neither:

```sh
python engine/harness/play.py --color red --time 60 --seed 7
```

Move entry mirrors the real UI in two stages — first move, then continuation
(pass / dash / cast) — because the full turn space is ~10⁴ wide and cannot be
listed. Every legal option stays reachable, and each cast variant is offered
separately with its net stone effect.

## WebAssembly

```sh
cargo build --release --target wasm32-unknown-unknown --no-default-features --features wasm
```

756 KB unoptimised; `wasm-opt` and gzip both cut that substantially. `pyo3` is
optional behind a default `python` feature (a CPython extension module cannot also
be a wasm module), and the search's clock is `cfg`'d because
`std::time::Instant` panics on `wasm32-unknown-unknown`. `src/wasm.rs` exposes
`pick_move(sfn, time_ms, ...)`.

Note for anyone finishing the browser path: expect the wasm build to be weaker
than the native measurements above — wasm is typically 1.5–3× slower on this kind
of integer search, so 60 s in a tab is worth roughly 20–40 s of native thinking.

## Playing it in the real web UI (localhost)

```sh
# 1. build the Python module once
python3 -m venv .venv && .venv/bin/pip install maturin
cd engine && VIRTUAL_ENV=../.venv ../.venv/bin/maturin develop --release && cd ..

# 2. serve the real game UI with the engine behind it
python engine/server/serve.py --docs docs --time 60      # eval defaults to `material`

# 3. open the printed URL
#    http://localhost:8000/game.html?ai=rust
```

The board, animations, move entry, spell prompts and game history are the real
ones — only the opponent changes.

**How it avoids a translation layer.** The engine's turn representation cannot be
applied by the JS (a `Cast` carries an outcome index into the engine's own
enumeration), so the flow is inverted: the browser enumerates its *own* legal
turns via `getLegalTurnsExhaustive`, applies each with its *own* rules, and POSTs
the resulting positions as SFN. The server searches from each candidate and returns
the best index; the browser plays that turn through the normal `applyAITurn` path.
Nothing engine-internal crosses the wire.

**How it avoids being capped.** The engine chooses from its **own** full
enumeration — every push destination, dash sacrifice subset, dash target and
spell-resolution variant — and returns a JS action list together with the position
that list must produce. `src/actions.rs` emits the action types `applyAITurn`
already understands; `cast_enum.rs` records the actions each resolution actually
took, because reconstructing them from a before/after delta is unsafe (the applier
recomputes push options, and calls `update()` between actions, which can trip the
zero-stones loss rule on an intermediate state).

**The assertion gate.** Before playing a move the browser replays the action list
on a throwaway copy and refuses the move unless it reproduces the engine's
position. A silent divergence would corrupt `turns[].actions`, which feeds game
review, `reconstructGameLog`, SGN export and `ai/import_human_games.py`.

Offline, the same property is checked in bulk against the **real** `applyAITurn`:

```sh
python engine/harness/run_emit_gate.py 150 9
```

Latest run: **5,839 (position, turn) pairs, 3,280 casts, 30/30 castable spells,
17 action types, 0 mismatches.** Coverage is reported alongside the pass rate,
because the first version of this gate passed 3,270/3,270 while exercising **zero
casts** — moves and dashes are the easy half.

**Remaining limitation.** Only the 39 official spells are supported, so `?ai=rust`
restricts the draw to those nine packs. A position containing Tectonic /
Providence / Aftershock / Ambush / Panda is rejected with a clear error rather
than mis-resolved.

This cannot work on the deployed site: GitHub Pages is static, so there is no
server to answer `/api/pick`. It only works when the page is served by
`serve.py`.

### Eval selection matters

`--eval` defaults to `material`, and that is the only leaf eval that beat the
shipped engine in the arenas. The alternatives are kept for A/B work only:
`classic` and `default` (my structural set) both **lost heavily** — 17.5% and 22.5%
against material-only over 80 games each — and the capped variants (`mc`,
`manavoid`, `mix`) were neutral-to-negative. Do not read a playtest against
anything but `material` as representative.

### Score units

The engine works in centistones (100 = 1 stone). `game-board-local.js` speaks
Caveman units, where one stone is `1/39` and `|score| >= 37` means a proven mate,
so scores are converted by `search::ui_score` before display. Feeding raw
centistones through inflated the readout 3900x and tripped the mate branch on
almost every position — a −0.18-stone position showed as `eval -702.0`, and a
+1.94-stone one as `win in -94`.
