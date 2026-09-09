# Engine status

**Current as of 2026-09-09.** Everything below the "Phase 0 status" heading is
the original bitboard-port log and is kept for provenance; where it disagrees
with this section, this section is right.

## Shipped on `main` (merge 90d96c35)

| | |
|---|---|
| strength vs the previously playtested engine | **+228 Elo @3s, +348 @60s** |
| shipped config | eval `tfit`, `width_scale` 4, adaptive (0.10, 2, 6), aspiration 60, `merge_min_width` OFF, `key_dash` OFF, `keep_window` 2 |
| tests | **89/89** `cargo test --release`, plus 4,000-position differential parity and the emit gate |
| browser build | `RUST_ENGINE_VERSION` 2, cache `v26`, wasm 558,686 bytes |

Four things landed in that merge and each is worth knowing about:

**1. The cast keep choice is ENUMERATED.** Casting clears the spell's sigil and
the caster keeps `mana` of its stones **choosing which**. Both engines
hard-coded one priority order, so the search saw 1 of up to `C(5,2)=10` legal
positions after every cast — its own and the opponent's. Humans keep
non-priority in 69.4% of casts against ~0% for every engine. `keep_options` /
`keep_count` / `cast_clear_and_keep` in `cast.rs`, index 0 being the old
priority order; `Action::Cast` carries `keep`. Elo-neutral in self-play
(-7.7 [-15.8, +0.4] over 7,040 games) because both arms share the wrong
opponent model; it ships on correctness.

**2. A mate score is a proof only if the search that found it saw every move.**
`UNPROVEN_MATE` (5,000 centistones, +50 stones as the UI renders it) is
reported instead when `widened` or `windowed` is set, and iterative deepening
no longer breaks early on such a score. An EXHAUSTIVE mate is untouched.
**The guard must live in every root loop:** it was written only into
`pick_successor` (the local playtest server's entry point) while `play_best`
and `wasm.rs pick_move_actions` — every arena, every audit, and the site —
drive `go_with_progress`, which went unguarded for the guard's whole life.

**3. The enumeration audit closed at ZERO.** Of 2,016 originally unreachable
recorded turns: 237 fat records, 134 no-op sacrifices, 61 transcription
glitches adjudicated through the real UI, **0 genuine gaps**. `applyAITurn`
applies a stored action list without validating legality, so any future audit
against `completed_games` needs all three filters or it blames the enumerator
for the recorder.

**4. Two binding bugs.** `legal_draw` no longer seeds with `seed | 1` (seeds
2n and 2n+1 gave the SAME nine-spell draw, leaving half the draw space
unreachable), and seven pyo3 signatures no longer restate `width_scale`.

## Where the next Elo is not

Closed by measurement, do not re-open without new evidence: a learned leaf
eval (GBM extracts nothing beyond linear over 8.2M on-policy positions,
ceiling ~+15-25 Elo before cost), a wider linear eval (`full_features` is
9-12% of a node against a 5% gate), retuning adaptive widening (the shipped
p=0.10 sits at the knee), and six move-ordering campaigns. The open lever is a
policy prior that NARROWS width — measured oracle floor is 98% coverage at
average width 10.5 against 96 today — gated on `turn_features` cost.

## Rules the tooling now enforces

* **A knob is not wired until it is proven to bite in the function the
  deliverable calls.** `engine/gcp/smoke_knobbite.py` asserts this through
  `play_best`; run it before any SPRT. Two SPRTs of 7,040 and 6,997 games once
  compared identical engines because `play_best` accepted `keep_window` and
  dropped it.
* **A gate that passes on zero evidence is not a gate.** The mate-guard smoke
  saw 0 of 60 positions differ and exited 0 with a warning; it now CONSTRUCTS
  the condition and fails on zero clamps.
* Gate at fixed time, split by spell draw, never restate an engine default in
  a binding, and pool fleet shards before reading any verdict.

---

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
  `cast_clear_and_refill` (engine priority order — **superseded**: the caster
  CHOOSES which stones to keep, see `keep_options` / `cast_clear_and_keep`;
  `cast_clear_and_refill` now just calls the latter with index 0),
  `finish_cast` (lock/springlock/counter), and the Autumn resolvers.
* 28 unit tests green at the time of writing (**89** on `main` today).
  4,000-position differential parity vs simboard.py green.

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
