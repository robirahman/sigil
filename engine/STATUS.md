# Engine status

**Current as of 2026-09-21.** Everything below the "Phase 0 status" heading is
the original bitboard-port log and is kept for provenance; where it disagrees
with this section, this section is right.

## Shipped on `main` (merge 90d96c35; search defaults flipped 8f2cbf88, 2026-09-16)

| | |
|---|---|
| strength vs the previously playtested engine | **+228 Elo @3s, +348 @60s** |
| shipped config | eval `tfit`, `width_scale` 4, adaptive (0.10, 2, 6), aspiration 60, **`elastic` FULL (2.0, 1.0, 2, 50, no predict) + `adopt_partial` (since v14, 2026-09-22; was DEFAULT 2.0/0.4/2/50/predict)**, **`lmr` band x2 R=1**, pondering on for >= 10 s tiers, `merge_min_width` OFF, `key_dash` OFF, `keep_window` 2 |
| tests | **101/101** `cargo test --release`, plus 4,000-position differential parity and the emit gate |
| browser build | `RUST_ENGINE_VERSION` 5, cache `v29`, wasm 479,949 bytes (unoptimised; `wasm-opt` still fails the smoke) |

**2026-09-18: `judge_move` (wasm) for the Puzzles page.** A move off the stored solution is judged
live: with only the finishing mate left, `mate::judge_forced_after` decides exhaustively (every
reply, then every mover turn); otherwise the shipped search from the opponent's side to the depth
the puzzle still needs (`2 x turns left`). Verdicts `mate` / `mate_slow` / `likely_mate` /
`escape`, and the reply to play (the refutation when refuted, else the search's best). The page
always plays on; a win within the count after an `escape` verdict is flagged as an engine
misjudgement with the position. `RUST_ENGINE_VERSION` 7, cache v32.

**2026-09-22 (in progress, engine v15 / cache v42 on the arena verdicts): exact clock, selective depth, and
the skipped no-placement turn.** (1) Site: a player with no legal stone placement had the turn ended at once
by both controllers and collapsed to `[pass]` by both JS enumerators; the ruling (move + optional dash +
optional cast; a missing move invalidates only the move) is now followed, `tools/no-placement-smoke.js`.
(2) `Search::exact_clock` (ON): the deadline is the budget -- no extension, no early stop (arena vs v14's
16 s/move policy: **-44.7 Elo [-63.0, -26.4]** over 1,408 games at a 10 s nominal budget, the price of the
extension; kept by the user's decision); a proven mate or
a read-out root spends the rest of the clock on the reply position (`spend_remaining`, kept in the persistent
table); think report shows `depth D/S` and "reply read to depth N". Knob `exact_clock`, arm
`engine/gcp/arms/exact_clock_10s.txt`. (3) Selective depth, four knobs measured one at a time at fixed 10 s:
`nmp` (pass as null move: **+20.8 Elo [+2.6, +38.9]** over 1,408 games, ships ON as (2, 1)), `lmr_quiet`
(in-window late-quiet reductions: **-18.8 [-36.9, -0.6]**, stays OFF), `tact_ext` (tactical extensions), `singular` (TT-move extension). (4) Game clocks for both sides (2026-09-23): local `GameClock` + `GameController` (loss on the flag, human
or AI; `?clock=M+S` in any mode; menu picker with the chess ladder and custom; saves keep the clock; records
carry `timeControl`/`endReason`), `search::move_budget_ms` allocates the AI's moves (18-move horizon, floor 6,
2% reserve); online, a flag now records the game and Elo (`_endByTimeout`, transaction-gated `writeTimeout`,
`listenForFinish`), spectators see the clocks, presets are the ladder plus custom. `tools/clock-smoke.js`. FINDINGS "The deadline is the budget", "Selective depth", "Game clocks".

**2026-09-22: engine v14 (cache v41) -- the Hard AI spent 71% of its clock; full-budget time policy, arena
+30.7 Elo at fixed 10 s.** Game X4TNAS: the Hard tier moved at depth 3 after 3 s of its 10 s, not because it was lost
(-2 stones, no mate) but because `Elastic::DEFAULT`'s predictor (next iteration = 6x the last, the clamp
Sigil's 7-10x depth ratios always hit) refused to start depth 4 and partial iterations were discarded. The
policy shipped from MATCHED-average-time arenas, where early stops fund extensions; a browser tier has no pool,
so the saved time was simply forfeited (18 turns: 127.9 of 180 s). New default `Elastic::FULL` (2.0, 1.0, 2,
50, no predict) + `adopt_partial` ON: every move runs to its deadline (7 of 18 extended to 20 s), turns
30/32/34 reach depth 4 instead of 3. Knob `full_budget` (0 = old policy), arm
`engine/gcp/arms/full_budget_10s.txt`, gated at FIXED per-move time: run 20260922T010321Z, 1,406 games, **+30.7 Elo
[+12.5, +48.9]**, 54.41% [51.80, 57.00], s/move 16.04 vs 9.67 (a Hard move now averages ~16 s, up to 20 s). FINDINGS "The Hard AI spent 71% of its
clock".

**2026-09-22: engine v13 (cache v40) -- the U4TL2D fixes; swing arena final +40.6 Elo.** A recorded
rust_hard game (room U4TL2D) lost two stones to a one-ply reply -- move, dash charging Tsunami, Tsunami,
then Meteor by Seal of Summer -- that the stream could not produce (the dash-cast stage had no Summer
second cast) and the swing scan could not reach (Meteor's swing bound was 2 where the effect is 3; the
budget went on 55 sacrifice pairs re-resolving one hopeless cast). Knob `dash_summer` (default on, arm
`engine/gcp/arms/dash_summer_3s.txt`): `push_summer_casts` in both cast stages, Meteor 3 in the swing scan
only, continuation-aware outcome order, `SWING_PAIRS_PER_CAST` 3, swing cap 6,000 (mean scan 0.19 -> 0.25
ms). Red's depth-1 read of the position +0.08 -> +1.03. Three regression tests. The swing pre-pass arena
(run 20260921T211851Z) closed at **+40.6 Elo [+30.2, +51.0]** over 4,343 games. The dash_summer arena (run
20260921T231344Z, 4,400 games at 3 s) closed at **+16.3 Elo [+6.0, +26.6]**, 52.34% [50.86, 53.81], s/move ratio
0.999: better, at no time cost. The "Red dashes!" /
"Blue dashes!" log message (d06ccc6) deploys with this cache bump. FINDINGS "A one-ply +2 reply behind a
Seal-of-Summer second cast".

**2026-09-22: swing pre-pass SHIPPED (engine v12, cache v39).** A recorded rust_hard game (room DSJZ2B) lost two
stones to a one-ply refutation -- move, dash whose move crushes, Slash whose hard move crushes -- that
the ordered stream never generates (dash branches capped per first move, casts only on survivors), so
the AI read its own losing Slash line at +1.0 twice. `Board::swing_turns` (the lead scanner with a
"+2 stones now" criterion) runs at plies 0-1 and puts what it finds at the front of the candidate list
(knob `swing_prepass`, arm `engine/gcp/arms/swing_prepass_3s.txt`). Pinned by two regression tests.
FINDINGS "A one-ply refutation the stream never generates".

**2026-09-22: engine v11 -- opening selector, pre-pass v2 bounds, placement-cast ordering; `tfit2` measured and NOT shipped.**
Four changes from the weakness audit, each behind a per-move knob for the arena (`opening_book`,
`lead_bounds_v2`, `outcome_order_v2`, eval `tfit2`; arm files `engine/gcp/arms/*_3s.txt`). Arena at
3 s, 4,400 games per arm (FINDINGS "Arena: the v11 changes"): placement ordering **+16.8 Elo
[+6.5, +27.0]**, pre-pass v2 −0.9 [−11.2, +9.3] (ships: Elo-neutral and closes recorded misses),
`tfit2` **−39.7 [−50.0, −29.3]** (stays a preset; the shipped eval is still `tfit`). The opening
selector SHIPPED for a human playtest (`742e3c4a`, cache v38) although its competitive self-play arena
reads **−15.6 Elo [−25.9, −5.4]** (4,400 games): its value is long-term positional against
humans in long games, which a 3 s self-play arena cannot measure; the base's mana/charm grab is what
it loses to in self-play (FINDINGS "Arena: the v11 changes"). Judge it on the recorded human games.

* **Opening selector** (`opening.rs`, table `opening_data.rs` generated by `tools/gen_opening_table.py`
  from the strategy survey in `engine/data/opening_survey.json`): on the competitive free-placement
  turns red picks the sigil whose worst case over blue's reply is best, blue the reply that minimises
  red's value; `++` matchups veto (Blossom vs Hail Storm, Seal of Destruction vs Gust, Hurricane vs the
  movement charms); zone-mates count for synergy and access; movement-charm leverage and a 0.5 tempo
  for red when a zone or sigil is contested. The search keeps choosing the node inside the sigil (only
  the root candidate list is restricted). Reported as `opening` in the move JSON and the think report.
* **Pre-pass v2 bounds** (`turn_iter.rs`): the dash's crushing fill move counts +2, wipes are wins,
  Lightning/mana/Hail-Storm bounds, casts-first two-phase scan (2/5 of the budget to casts), only the
  largest-lead resolutions per keep, every generated board charged to the cap, cap 2,000 -> 2,500.
  On the 1,364 recorded game-ending wins the pre-pass now surfaces 96.0% (was 91.6%) and 26 of the 61
  the depth-2 search missed (was 0); midgame mean cost 74 -> 87 us per node-scan.
* **Placement casts** (`Board::placement_bonus`): a cast's resolutions are ordered by what the placed
  stones achieve, -40 per stone put back on the sigil just cleared, so Flourish/Grow/Sprout/Harvest
  windows hold extensions instead of the refill players flagged. +16.8 Elo on its own.
* **`tfit2`**: `tfit` + `cast_pace` (sign of the score lead x max casts so far, 15 cs) + `mobility`
  (net soft-placement targets, 4 cs) + `control` 40. Lost 40 Elo as a package; see FINDINGS for what
  to try next (one term at a time, magnitudes fitted before an arena).

**2026-09-21 (later): weakness audit of every recorded game.** Depth-6 evals of 63,193 positions
(`game_evals/` holds the 315 games since 2026-08-26; the rest live in the run artefacts), the mate-in-1
solver on 1,489 game-ending positions, and the players' good/bad flags, folded into
`engine/harness/reports/weakness_2026-09-21.md` by `engine/harness/weakness_report.py`. Headlines: the
Rust AI loses 87% of 40–49-turn games and 40% of sub-20-turn games; the depth-2 search misses 4.5% of
actual game-ending wins (7.9% in the Rust era, 14–16% with Torrent/Syzygy/Azimuth/Lurk) and the stone-lead
pre-pass is gated out of all 61 misses (29 recoverable at cap 50k, 32 need a shape change); Flourish casts
are flagged bad 30% of the time and the engine still plays them. FINDINGS "Weakness audit of the recorded
games". The review panel shows the stored evals when a game has them (cache v37: Firebase drops trailing
nulls from arrays, so the adapter pads).

**2026-09-21: eval display re-zeroed, "win in N" replaces ±50, stored game evals (engine v10, cache v36).**
Three reporting changes, no playing change (`cargo test` covers each; the search and move choice are
byte-identical):

* **0.0 in an even game.** The raw eval folds blue's +1 win-rule token into material and adds the
  mover's 50-centistone tempo, so an even game read −0.5 for red / +0.5 for blue at every depth
  (measured with the v9 wasm). `search::even_offset` (red `+(lead − tempo)`, blue the negative,
  computed from the weights the search ran with) is added for display only; `report().stones`.
* **Mate distance survives the guard.** `SearchStats::mate_plies` / `mate_proven` are recorded
  before the `UNPROVEN_MATE` clamp (`note_mate`), which stays as the internal sentinel that
  `mate.rs`, `ponder_step`, `judge_move` and the harnesses read. `report().mate_in` is the winner's
  own turns (`plies_to_turns`), and the line reads `win in 2` / `loss in 1`, or `likely win in 2`
  when the search was width- or window-limited. **Known limitation:** `widened` is set at the root of
  every real search (~300 legal turns), so nearly every mate deeper than one turn carries the
  "likely" tag; a mover's mate-in-1 is proven by construction. Making short mates plain "win in N"
  would need the exhaustive solver (`mate::judge_forced_after`, as the Puzzles judge does) after the
  search -- declined for now.
* **Wire:** `Engine::search` / `serve.py` add `stones`, `mate_in`, `mate_proven` (`score_ui` stays);
  `judge_move` adds `mate_in_turns` and `stones`; py `analyze(sfn, eval_name, ...)` returns the
  report as a dict (eval name REQUIRED, a fresh table per call, a finished root is not searched).
  `formatEngineEval` in `game-board-local.js` is the one formatter (JS tiers keep their Caveman
  units, converted to turns). Puzzle judge text counts turns.
* **Stored evaluations.** `engine/harness/eval_games.py` replays every recorded game since
  2026-08-26 (351 games / 10,859 turns; Rust tiers went live 2026-08-30) and writes
  `game_evals/<roomCode>` (red-POV stones, mate turns, proven flag, best turn, depth per position;
  the document carries `finalSfn` because room codes are reused). New rules: `game_evals` public
  read / no client write; `game_reviews` (the Caveman review cache) finally has a rule -- it had
  none, so every cache write since 2026-05 was silently denied (0 records). The review panel shows
  the stored Rust evals when they describe the game (`rustEvalsToReview`), else the Caveman review.

**2026-09-21: `rust_anchor` REMOVED (engine v9, cache v35).** The unlisted frozen reference tier
(`?ai=rust_anchor`: fresh table per move, no pondering, elastic/LMR/pre-pass off, its own
`__ai_rust_anchor__` rating record) existed so human ratings would keep one fixed comparison point
across engine releases. It was never played (0 games, Elo still at the starting 1300), and every
engine change needed an "anchor keeps the old behaviour" clause -- the `wasm.rs pick_move_actions`
entry point and the worker's `fresh` branch existed only for it. Gone with its Firebase records;
`tools/wasm-smoke.js` now drives the persistent `Engine` like the worker does. Version comparisons
belong to the arena against a pinned commit.

**2026-09-20: stone-lead pre-pass SHIPPED (engine v8, cache v34); exhaustive bookends DISCARDED.**
Fakey_McFaker's report (rust_hard announced -0.5, then was mated in one) traced to a WINDOW gap in
the ordered generator: dash branches per first move are capped at the cast-outcome window,
cheapest sacrifices first, and only survivors get a cast, so a mate needing a specific sacrifice
pair plus a Harvest/Erupt cast was invisible at every `width_scale`. Two fixes were built:

* **Exhaustive mate-in-1 bookends** (v6/v7): scan the root's full enumeration for an immediate win
  before searching, and the chosen move's full reply list for an immediate loss after, banning the
  move and re-searching. Fixed the recorded games; DISCARDED after the 3 s fleet arena. The scans
  (up to 250k turns, twice per move) ran outside the time control -- a 3 s budget averaged 4.8 s
  per move, the search itself got less time -- and pre-pass + bookends measured **38.4% (-82 Elo
  [-97, -67])** against the v5 search. Nothing of them remains but the note in `search.rs`.
* **Stone-lead pre-pass** (`turn_iter.rs decisive_lead_turns`): a material-gated, `apply_turn`-
  verified, memoised scan (<= 2,000 boards per node) that puts every turn reaching the lead NOW at
  the front of the ordered stream, like the Seal of Destruction pre-pass. Corpus: depth-1 detection
  of recorded mates 83% -> 95%, "walked into a mate while scoring ~0" 333 -> 116. Arena, 3 s,
  matched time, 2,250 games (5-VM fleet): **49.1% [47.1, 51.2], -6 Elo [-21, +8]** -- the node-rate
  cost and the blunders removed cancel, so it ships on correctness. Coverage is not
  total: of the two recorded games behind the report, the dash + Erupt mate is found at the
  shipped cap, the hard-move + dash + Harvest mate (five resolver moves) needs ~50,000 boards
  (~40 ms) and is pinned as a known gap in `tests.rs` so any cap change is measured against it. A/B knob:
  `ab_search.py ... decisive_lead 1 0`. FINDINGS "Audit of every recorded game's final position"
  and "Arena: the mate-in-1 fixes cost Elo at 3 s".

**2026-09-17: puzzle solver (`mate.rs`, `solve_mates` in the Python binding).** Feeds
`docs/puzzles.html`. Mate-in-1 enumerates the root in full (complete winning set, and "no
mate-in-1" is a proof). Mate-in-2 cannot be three fully enumerated plies -- a midgame position
has ~2e5 legal turns -- so candidate first turns are NOMINATED (the strength engine's mate-scored
root moves at depth 3 via `Search::root_scores`, plus the turn actually played when the mover won
within two turns) and each candidate is PROVEN: every legal reply enumerated, the mover's
mate-in-1 after each reply established by the ordered generator's first 4,000 turns or else by a
full enumeration. Mate-in-3 repeats the pattern one level down: every reply must leave a PROVEN mate in <= 2
(mate-in-1 memo, else a 250 ms 3-ply nomination proven against every reply). Mate-in-3 is rare
(~1% of positions four plies before a recorded win). The corpus pass runs on a Spot c3d-90 via
`engine/gcp/launch_puzzles.sh` (0.09 s/position wall with 88 workers). Nothing is inferred from a truncated enumeration; positions past the 1<<20 turn
cap or `OUTCOME_CAP` are skipped (measured: ~10% of recorded midgame positions). Threefold
repetition is ignored (puzzles start with no history, as does the page). The generator is
`tools/gen_mate_puzzles.py`; `tools/puzzle-smoke.js` replays every stored solution through the
browser engine and fails on any disagreement. The wasm build is untouched (nothing in the browser
calls the solver), so `RUST_ENGINE_VERSION` stays at 5.

**2026-09-17: Seal of Destruction is implemented.** The engine had NEITHER half of the
Covenant ritual's rule ("filled at the end of your turn, destroy all enemy stones touching
you; filled at the start of your turn, you lose") and `sigil_charged` paid it for filling
the sigil, so it filled the seal, burned little, and lost when its next turn started.
`apply_turn` now runs burn -> +/-3 check -> start-of-turn loss in the live controller's
order; `emit_actions` stays pre-burn because `rust-ai.js` replays the actions without it.
The search scores a side that holds the seal but is not to move as lost next ply, the
ordering carries a +/-100k swing for anything that completes the seal (mate or suicide),
Gust places onto the enemy's empty seal nodes first, and decisive seal turns go to the
front of the turn stream. Six tests pin it, including Gust mates for 1..5 stones and
fills by move, dash and eight casts. Every other Seal already had its trigger code.

**2026-09-16: elastic time management and the LMR band ship ON.** Fleet arenas at
10 s, matched average time: elastic +58 Elo [+29, +88], `lmr` 21 +47 [+17, +76], the
pair +81 [+51, +111] (FINDINGS "Run 2 at 10 s"). Both live in `Search::new`, so every
binding inherits them. Elastic matches the AVERAGE budget, not each move: a single move may
run to 2x the tier time once when the answer is unstable and stop at 0.4x when stable.
Pondering (default-on for >= 10 s tiers) confirmed at +24 [+10, +39] (3 s) and +31
[+2, +60] (10 s).

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
`UNPROVEN_MATE` (5,000 centistones; until v10 the UI rendered it as +50 stones, now `report()` prints the surviving distance) is
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
