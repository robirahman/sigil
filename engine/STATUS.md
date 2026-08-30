# Phase 0 status

## Done and verified
* Isolation: toolchain/venv/refs all on `/`; `/home` untouched, `~/.cargo` never created.
* `topology.rs` (generated, invariants asserted at generation AND in tests).
* `board.rs`: Copy position struct, `update`, `check_game_over`, three move
  generators, `push_options`/`push_enemy` (global FIFO), `escape_distance`,
  `is_crushable`.
* `zobrist.rs`: incremental hash, both JS and Python key flavours.
* `spells_meta.rs` (generated): all 39 official spells with resolve kind, count,
  static/charm flags.
* `cast.rs`: `holds_charged`, dash rules (Seal of Autumn + Seal of Lightning),
  `castable` (locks, Seal of Spring/Summer/Winter, Surge/Splash rules),
  `cast_clear_and_refill` (engine priority order), `finish_cast`
  (lock/springlock/counter), and the Autumn resolvers.
* 28 unit tests green. 4,000-position differential parity vs simboard.py green.

## Throughput (1 core, this Cloud Shell)
| workload | rate |
|---|---|
| `simboard.py`, matched primitive work | ~16,500 units/sec |
| Rust native loop, same primitives | ~2,860,000 units/sec (**~174x**) |

A "unit" is position setup + `update` + `hard_moveable` + `push_options` +
`escape_distance` + repetition key. NOT a full search node — no casting, no turn
enumeration — so 174x is the trustworthy figure and 2.86M/s is an upper bound on
node rate. The JS engine's 1,846 nodes/sec is a larger unit; no ratio claimed yet.

## ALL 39 official resolvers implemented and verified
`resolver_ready` is true for every id 0..38 and false for every deferred id
39..50, asserted by `every_official_resolver_is_implemented`.

Differential parity vs simboard.py: **1,931 casts, 36/36 spells, every spell in
all 9 sigil slots, minimum 52 casts per spell — all agree.** (Slot coverage is not
optional: Syzygy is defined only for ritual slots 1-3, Blossom and Erupt skip their
own slot, and the soft-move avoidance mask is the casting sigil.)

Harvest / Gather / Seal_of_Autumn are excluded from that sweep because they are
**absent from simboard.py's `CORE_SPELLS` entirely** — confirmed by KeyError, matching
`ai/RETRAINING_FISSURE.md`. They have no Python reference and are covered instead by
unit tests written from the live JS spec.

## Compound turns, openings and full enumeration: DONE
* `turn.rs`: `Action` / `Turn` / `apply_turn` / `enumerate_turns[_capped]`.
  Turn shape `move -> {pass | dash -> {pass|cast} | cast -> recurse}`, up to two
  casts (the second only under Seal of Summer). Competitive opening yields a free
  blink onto each of the 39 empty nodes at `turn_counter <= 2`, verified.
* Seal of Wind (blink privilege) and enemy Seal of Stone (first move must be soft)
  both applied to the first move's target set.
* `cast_enum.rs`: exhaustive per-resolver outcome enumeration, deduped by stone
  masks. A `Cast` action records the outcome INDEX, so `apply_turn` reproduces the
  enumerated state exactly rather than re-running the greedy resolver.
* Draw structure encoded: 13 rituals / 13 sorceries / 13 charms, `Role` metadata,
  `draw_is_legal()` and `legal_draw(seed)`. A non-charm in a 1-node slot is what
  makes `simboard._cast_spell` raise IndexError, so tests must use legal draws.
* Measured hiding factor: **4,144x mean** (37.5 collapsed vs 210,263 enumerated).
* 46 unit tests green; both parity harnesses green.

## Lazy ordered generation: DONE
* `order.rs`: deport/destination scoring from Robi's human-play framing, with the
  placement goal switching on what we threaten (Voids / SpreadSigils / Fragment /
  Coalesce). `configuration_value` scores the exact non-additive objectives.
* `turn_iter.rs`: staged best-first `Iterator`, bounded work per `next()`.
  First 64 ordered turns in **77 us** vs 24.4 ms to enumerate all ~142k (**266x**).
* Gust placements generated best-first over SETS via a heap, never materialising
  C(empties, displaced).
* 55 unit tests green, including one asserting the lazy generator offers exactly
  the same first moves as full enumeration.

## Alpha-beta search: DONE
Iterative deepening, negamax, Zobrist TT, killers, aspiration windows,
threefold-repetition aware, progressive widening. Completed depth 6.32 @200ms
and 8.10 @2s vs the shipped engine's 3.65 @10s.

## Positional evaluation: TESTED AND DEFERRED (Robi's call)
Capped caveman-faithful terms, colour-swapped vs material-only:
| arm | time/move | depth | games | score |
|---|---|---|---|---|
| capped map-control | 40 ms | 4.6 | 100 | 36.0% |
| capped mana+void | 40 ms | 4.6 | 200 | 53.5% |
| capped mana+void | 250 ms | 5.8 | 100 | 48.0% |
The mana+void edge SHRINKS as depth rises (53.5% -> 48.0%), so there is no
evidence the earlier campaign's verdict flips once depth is cheap. Both are within
noise of 50%. Deferred; `eval.rs` keeps the presets and the cap helper for a later
retest, ideally against a learned eval rather than hand weights.

## Remaining
1. ~~head-to-head vs the shipped JS Caveman~~ **DONE — PASSES.** 402 games
   colour-swapped at 200 ms/move: **66.7%** (z = 7.1, CI [62.1, 71.3]) against
   `ai/config.py`'s 0.55/400 gate. 75.0% at 1 s/move over 16 games. Harness:
   `bridge/caveman_server.js` + `harness/vs_caveman.py`.
   Still to do: the same gate at matched **10 s/move**, where the deployed engine
   reaches its measured 3.65 depth. ~36 core-hours — worth renting for.
2. ~~old item~~ (superseded)
   **THE GATE WE HAVE NOT RUN: head-to-head vs the actual shipped JS Caveman.**
   Every arena so far is this engine against ITSELF with different settings, which
   cannot tell us whether it is stronger than what ships. `tools/arena/arena.js`
   runs the production search headless under `vm`; the engine needs a matching
   adapter so the two can play. Gate: 400 games, colour-swapped, matched 10 s/move,
   >= 0.55 (`ai/config.py` GATE_THRESHOLD / GATE_GAMES). This is the next task.
## SFN I/O and the corpus replay gate: DONE — 4,202 / 4,202 clean
`sfn.rs` round-trips `notation.py`'s format and REFUSES an SFN carrying deferred
pack state (`pm:` / `ab:` / `sn:` / a Fissure-destroyed `x` node) rather than
silently dropping it.

`harness/corpus_gate.py` replays the whole committed corpus
(`ai/data/selfplay_v22b_2026-05-03.jsonl`) and checks per position: SFN
round-trip, derived state (totals / mana / charged sigils) against simboard.py,
and that no legal FIRST move is missing. Result: **4,202 of 4,202 positions in
scope, zero failures.**

Two useful facts from it:
* The corpus is **100% in scope** — no Panda, no deferred packs, no Fissure — so
  all of it is reusable as training/eval data.
* Coverage must be checked with `first_move_variants`, not `enumerate_turns`.
  The latter is capped, and with a spell charged one first move can spawn enough
  continuations to exhaust the cap, which makes a truncated list look like a
  generator that hides moves. That produced a 91-then-9 false-alarm sequence
  before the comparison was fixed (simboard also labels hard moves `hard_move`,
  marks a crush `'X'`, and offers a bare `pass` when nothing is moveable).
3. Compound turn: `move -> optional dash -> optional cast(s) -> pass`, plus the
   competitive-variant opening blink.
4. Full turn enumeration with greedy choice points un-collapsed (Phase 1).
5. SFN read/write, then the corpus replay gate over
   `ai/data/selfplay_v22b_2026-05-03.jsonl` filtered to in-scope spells.
