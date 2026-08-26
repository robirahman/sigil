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
