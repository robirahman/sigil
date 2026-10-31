# Superhuman Desktop Engine (Hard & Very Hard Tiers)

*   **Author:** robirahman
*   **Status:** Proposed
*   **Date:** 2026-10-31

--------------------------------------------------------------------------------

## Overview

The Sigil Rust engine (`v34`, `nnue_mt256`) runs client-side in WebAssembly and wins the majority of games against human players at the Hard (10 seconds per move, 4 threads) and Very Hard (60 seconds per move, 4 threads) tiers. However, it still loses occasionally to fast human play (<5 seconds per move) on unscripted random competitive boards.

This design specifies the pre-training engine fixes, live search telemetry, human-game audit workflow, and post-fix Round 4 self-play and NNUE/policy training pipeline required to make the Desktop Hard and Very Hard tiers unbeaten against human intuition without breaking offline Service Worker caching or Firebase Cloud Functions game analysis.

## The Problem

A turn-by-turn inspection of two recent human wins against `__ai_rust_hard__`—game `GWSMF5` (2026-10-31, human Red vs. AI Blue on `Harvest, Flourish, Fissure, Decay, Fury, Annuity, Gust, Dividend, Charge`) and game `QJLGQR` (2026-10-31, AI Red vs. human Blue on `Seal_of_Lightning, Syzygy, Harvest, Annuity, Seal_of_Wind, Storm_Front, Dividend, Seal_of_Autumn, Seal_of_Winter`)—together with the engine source code revealed four compounding failure modes that must be fixed *before* running further NNUE or policy training:

1.  **Interior-node blindness to `move + dash + cast` combinations (`TurnIter` stage ordering and `SHIPPED_POLICY` threshold — `GWSMF5`):**
    *   From Turn 24 onward in `GWSMF5`, neither player held any banked stones (`pm:0:0`). On Turn 26, Blue evaluated the position as near-equal (`-0.42` from Blue's perspective at depth 3) and played `b11, Charge, hard_move b6->b12`, walking straight into Red's Turn 27 `b6, dash (sac c3, c5 -> b1, push to a9), Flourish`, which swung the evaluation by +2.53 stones (`+0.34` to `+2.87` Red POV).
    *   At interior search nodes where `pull < 96` (`w_depth <= 3` on the ~90% of nodes classified as easy by [`SHIPPED_ADAPTIVE`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L127), where `scale = 2`, `w = [12, 20, 32]`, and `pull = 2 * w = [24, 40, 64]`), [`Search::ordered_turns_action_hint`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L2132-L2155) bypasses [`PolicyIter`](file:///storage/emulated/10/Documents/sigil/engine/src/policy.rs#L841) (`SHIPPED_POLICY = (true, 96)`) and falls back to [`TurnIter`](file:///storage/emulated/10/Documents/sigil/engine/src/turn_iter.rs#L479-L610).
    *   In [`TurnIter::step`](file:///storage/emulated/10/Documents/sigil/engine/src/turn_iter.rs#L479-L610), `Stage::Dash` emits up to `28 * 16 = 448` bare `[move, dash, pass]` turns (sacrificing 2 stones for -1 net stone with no spell cast) *before* `Stage::DashCast` (`move + dash + cast`) is ever reached. Within a 24–64 candidate width cap, interior `TurnIter` nodes never reach `Stage::DashCast` beyond the ≤8 `key_dash_turns` prepass candidates.
    *   Even at wide nodes (`pull >= 96`) that use [`PolicyIter`](file:///storage/emulated/10/Documents/sigil/engine/src/policy.rs#L483-L502), [`dash_opts`](file:///storage/emulated/10/Documents/sigil/engine/src/policy.rs#L483-L502) only includes `dash_per = 2` default sacrifice pairs per landing in the main softmax. When a `dash + cast` requires a non-default sacrifice pair to keep the target spell's sigil stones alive (such as sacrificing `c3, c5` on Turn 27 of `GWSMF5` to preserve `a7, a8` for `Flourish`), it falls into `Node::DashTail` (2 nats below the floor) and is never expanded at ply 1–3.
2.  **Threefold-repetition blindness at `PolicyIter` nodes, missing repetition-mate prepass, and stale TT bounds (`QJLGQR`):**
    *   In `QJLGQR`, the start-of-turn position `rrrrrr....rr...............b..bbbbbb..b` occurred at Turn 23 (`r 23`, 1st occurrence) and Turn 25 (`r 25`, 2nd occurrence). On Turn 25, Red (`__ai_rust_hard__`) evaluated the position as `+2.56` stones in Red's favor at depth 5 and played `c10 (pushed_to c4), dash_lightning (sac a4), c9 (pushed_to c3)`. On Turn 26, Blue replied `c10 (pushed_to a4), dash (sac c4, c3 -> c9 [crush]), pass`—pushing Red's `c10` chain back into the vacated `a4` hole and crushing `c9` to recreate `rrrrrr....rr...............b..bbbbbb..b` for the **3rd time**, handing Blue an immediate threefold-repetition win.
    *   Reproducing Turn 25 across depths 1–5 revealed why Red saw Blue's repetition refutation at `depth = 4` (playing `c8` at `+2.19`) but became blind to it at `depth = 5` (blundering `c9` at `+2.56`):
        *   **`PolicyIter` drops `key_dash_turns`:** At `depth = 4`, ply 1 (`b 26`, `scale = 2`) has `remaining = 3`, `w = 32`, `pull = 64 < 96`, taking the `TurnIter` branch of [`Search::ordered_turns_action_hint`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L2142-L2160), which appends `b.key_dash_turns(c, self.key_dash_reasons, self.key_dash_extra)` and surfaces Blue's `c10->a4, dash(sac c3,c4)->c9` crush. At `depth = 5`, ply 1 has `remaining = 4`, `w = 48`, `pull = 96 >= 96`, switching to the `PolicyIter` branch ([`search.rs:2133-2141`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L2133-L2141)), which **omits `b.key_dash_turns(...)`**. Because `PolicyIter` assigns a large negative log-probability to bare `[move, dash, pass]` turns without a cast, Blue's 1-ply repetition mate ranked past `pull = 96` and vanished at depth 5.
        *   **No repetition-mate prepass for Blue wins or Red refutations:** [`front_prepass`](file:///storage/emulated/10/Documents/sigil/engine/src/turn_iter.rs#L255-L294) promotes +/-3 stone-lead mates and `Seal_of_Destruction` mates to the front of every stream, but has no prepass for turns that complete a 3rd repetition (`rep_count(ckey) >= 2`) when Blue is to move. As a result, when Blue can force a 3rd repetition via a non-default push chain or bare dash, the engine can miss the win when playing as Blue and miss the refutation when playing as Red.
        *   **Persistent TT Graph-History Interaction (GHI) across turns & overflow double-counting:** [`negamax`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L2048) stores TT entries whenever `saw_repetition == false` (`rep_count + 1 < 3`). Entries stored on earlier turns when a position `P` was at its 1st occurrence remain in the persistent `self.tt` when `P` reaches its 2nd occurrence in `base_history`, allowing TT cutoffs ([`search.rs:1833-1840`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L1833-L1840)) to return stale non-repetition scores without expanding the child where `rep_count(P) + 1 >= 3` now fires. Conversely, [`spend_remaining`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L1446) pushes `root_key` onto `self.path` even though [`rust-ai.js`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/engine/rust-ai.js#L403) already includes `sfn` in `historySfns`, double-counting the root position (`rep_count = 2` on its 1st occurrence) during overflow search.
3.  **Single-stone Providence bank (`bank[c] > 0`) Cartesian product and transposition duplicates (`GWSMF5`):**
    *   Whenever a player holds even 1 banked stone (`pm:1:0`, `pm:1:1`, or `pm:0:1`, as on Turns 3–24 of `GWSMF5`), [`Board::ordered_first_steps_scored`](file:///storage/emulated/10/Documents/sigil/engine/src/order.rs#L279-L302) takes the full Cartesian product of ~25 legal first moves with ~25 post-move bank placements (400–600 first steps).
    *   Nearly half of those `(move, place)` pairs are exact board-state transpositions (`Move A + Place B` produces the identical board state as `Move B + Place A`). This bloats `Stage::Moves` in `TurnIter` (starving `Stage::MoveCast` and `Stage::DashCast`), dilutes the Level-0 (`L_M`) softmax in `PolicyIter` by $\sim \ln(25) \approx 3.2$ nats, and floods `tiers[0]` transposition-table hint promotion in [`search.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L2197-L2230).
4.  **Per-leaf `FOLD` cache thrashing on Fissure boards and missing wall/bank NNUE inputs:**
    *   In [`engine/src/nn.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs#L245-L261), [`nn::eval`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs#L251-L258) masks out Fissure-walled charms via `let live = !b.dead_slots();` in the single-slot thread-local `FOLD` cache key `(net_ptr, b.spells, use_rel)`. Whenever a search tree branches across a `Fissure` cast, child leaves with a wall have a different `use_rel` mask than sibling leaves without that wall, causing `FOLD` to miss on every leaf transition and call [`Net::fold_masked`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs#L159-L193) (3 heap allocations + ~180,000 operations per leaf miss).
    *   Furthermore, while `dead_slots()` zeroes the dead charm's embedding, `nnue_mt256` has no input plane for the physical Fissure wall bitmask (`b.walls`, which blocks movement/pushing and alters local topology) or Providence bank reserve counts (`b.bank`), and historic self-play games generated under the old search generator suffered from the same `Stage::DashCast`, repetition, and bank-branching blind spots.

## Goals

*   **Pre-Training Search, Repetition & Generator Fixes (Stage 1):**
    *   Eliminate interior-node `move + dash + cast` starvation by reordering `Stage::DashCast` ahead of non-key bare `Stage::Dash` turns in [`TurnIter::step`](file:///storage/emulated/10/Documents/sigil/engine/src/turn_iter.rs#L479-L610), lowering `SHIPPED_POLICY`'s `min_width` threshold (`96 -> 24..32`), and ensuring spell-enabling dash sacrifice pairs (`dash_per`) are included in the primary candidate window for both serve (`PolicyIter`) and train (`policy_example`).
    *   Eliminate threefold-repetition blindness for both Red (defensive avoidance) and Blue (offensive execution) by:
        1.  Appending `b.key_dash_turns(c, self.key_dash_reasons, self.key_dash_extra)` in the `PolicyIter` branch of [`Search::ordered_turns_action_hint`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L2133-L2160) so bare crushing dashes never disappear when a node crosses `width >= pol_min`.
        2.  Adding a repetition-mate prepass when any position key has `rep_count(k) >= 2` so that when Blue is to move, any legal turn (bare move, push chain, or bare dash) reaching a 2x-repeated state is promoted to the front of the candidate list (giving Blue instant mate-in-1 detection and giving Red 100% visibility of Blue's 1-ply repetition refutations).
        3.  Clearing stale TT entries whenever `base_history` acquires a key with count $\ge 2$ and fixing the root-key double-count in [`spend_remaining`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L1446).
    *   Bound [`Board::ordered_first_steps_scored`](file:///storage/emulated/10/Documents/sigil/engine/src/order.rs#L279-L302) when `bank[c] > 0` by deduplicating `(move, place)` transpositions via `state_key()` and capping bank-placement variants per move (preserving bare moves, sigil-completing or enemy-pushing/crushing placements, and the top-K placements by heuristic score), while capping `tiers[0]` TT-hint promotion in [`search.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L2197-L2230).
    *   Eliminate heap-allocating `FOLD` cache misses on Fissure boards in [`engine/src/nn.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs#L245-L261) by replacing the 1-slot `FOLD` cache with a small fixed-size per-thread ring keyed by `(net_ptr, b.spells, use_rel)`.
    *   Verify on both the `GWSMF5` Turn 26 benchmark and the `QJLGQR` Turn 25 benchmark that the fixed engine sees the tactical refutations (`dash + Flourish` in `GWSMF5` and `c10->a4, dash->c9` 3rd-repetition mate in `QJLGQR`) across all depths $\ge 2$ and avoids both blunders.
*   **Live Search Telemetry & Post-v28 Human Game Audit (Stage 2):**
    *   Persist a sanitized, flat `aiTelemetry` object on finished AI games in Firebase `completed_games` (recording `engineVersion`, `evalName`, active worker `threads`, `mtError`, and per-AI-turn `depth`, `seldepth`, `nodes`, `stones`, `mateIn`, `timeMs`, `ponderDepth`, `ponderNodes`, `ttPermille`) without altering `turns` claim hashes or breaking `OfflineGameQueue`.
    *   Update [`engine/harness/deep_review.py`](file:///storage/emulated/10/Documents/sigil/engine/harness/deep_review.py#L81) to use `engine_eval(se)` and audit all post-Oct-7 human-vs-AI games in Firebase for both opponent-turn surprise drops ($\Delta_{\text{opp}} \le -1.0$ stones) and engine own-turn blunders ($\Delta_{\text{ai}} \le -0.8$ stones).
*   **Two-Phase Post-Fix NNUE & Self-Play Pipeline (Stage 3 — Option C):**
    *   **Phase 3a (Immediate Retrain on Existing Chunks):** Prune the 3 retired embedded nets (`NNUE_SPELL`, `NNUE_SPELL3`, `NNUE_SPELL4`) from `wasm32` builds in [`engine/src/nn.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs#L61-L75), update [`nn_eval.py prep`](file:///storage/emulated/10/Documents/sigil/engine/harness/nn_eval.py#L106-L119) to extract existing `'x'` (Fissure wall) and `pm:` (Providence bank) tokens already stored in historical self-play `.npz` `sfn` strings, and train a candidate NNUE with additive wall/bank accumulator rows.
    *   **Phase 3b (Round 4 Self-Play & Policy/Value Co-Training):** Because historical self-play games were generated by an engine that was blind to interior `move + dash + cast` tactics, dropped `key_dash_turns` under `PolicyIter`, and suffered from `bank > 0` depth collapse, run a fresh Round 4 self-play generation pass using the Stage 1 fixed engine, then retrain both the in-generator policy (`policy_weights.rs`) and the NNUE value network on the combined post-fix self-play corpus + upsampled human-game surprise positions, shipping only candidates that pass the $\ge +20$ Elo arena gate.

## Non-Goals

*   Increasing per-move search time budgets on lower difficulty presets (`Easy`, `Medium`).
*   Splitting the WASM build into incompatible per-tier binaries in a way that breaks [`functions/copy-engine.js`](file:///storage/emulated/10/Documents/sigil/functions/copy-engine.js) (`pricing.js` and `analysis.js`) or [`docs/sw.js`](file:///storage/emulated/10/Documents/sigil/docs/sw.js) offline caching.
*   Modifying [`Board::material`](file:///storage/emulated/10/Documents/sigil/engine/src/board.rs#L192-L194) or altering terminal +/-3 stone lead and 6th-spell tiebreaker rules.
*   Unconditionally widening `dash_opts` or `cast_opts` only inside `policy_example` in a way that diverges from `PolicyIter`'s serve-time softmax denominator.

## Open Questions

*   None at this stage. All architectural trade-offs from `/egm-brainstorm` (including Option C for the two-phase training + Round 4 self-play pipeline and the `QJLGQR` threefold-repetition fix) have been resolved.

## Critical User Journeys (CUJs)

### CUJ 1: Desktop Player Faces Hard AI (`__ai_rust_hard__`, 10 s/move) on a Tactical or Repetition-Rich Competitive Board

*   **Given**: A human player starts a competitive game on desktop Chrome against `__ai_rust_hard__` (4-thread `wasm-mt`, 10 s/move) on a draw containing `Dividend`, `Fissure`, `Flourish`, `Fury`, or `Seal_of_Lightning` (such as `GWSMF5` or `QJLGQR`).
*   **When**:
    1.  Both players bank stones with `Dividend`, wall a sigil with `Fissure`, and enter a midgame with live `move + dash + cast` threats requiring non-default sacrifice pairs; or
    2.  A board position repeats for a 2nd time (`loopCount == 2`), creating live 3rd-repetition threats where Blue can win immediately by recreating the repeated layout via a push chain and crushing dash.
*   **Then**:
    1.  The engine deduplicates and caps bank-placement first steps (`<= 60` steps), avoids `FOLD` cache heap allocations across `Fissure` branches, and evaluates `Stage::DashCast` ahead of bare non-key dashes at interior nodes.
    2.  Search depth remains $\ge 5\text{--}6$ plies throughout the midgame instead of collapsing to depth 3, and the engine detects and parries opponent `move + dash + cast` tactics (such as `GWSMF5` Turn 27) at ply 1–3.
    3.  When playing as **Red** on a board with a 2x-repeated position (`QJLGQR` Turn 25), the engine retains `key_dash_turns` and repetition-completing Blue replies at all depths and widths (`PolicyIter` and `TurnIter` alike), sees that `c9` walks into Blue's `c10->a4, dash(sac c3,c4)->c9` 3rd-repetition win, and plays a non-repeating winning line (`c8`) instead.
    4.  When playing as **Blue** on a board with a 2x-repeated position, the repetition-mate prepass promotes any legal turn that reaches a 2x-repeated key to the front of the candidate list, allowing Blue to find and execute 3rd-repetition wins even when behind on material.

### CUJ 2: Post-Game Triage of a Human-vs-AI Game in Firebase

*   **Given**: A human completes a rated or unrated game against any Rust AI tier in the browser.
*   **When**: The game finishes and is uploaded to Firebase `completed_games/{gameId}` (either immediately or via `OfflineGameQueue`).
*   **Then**:
    1.  The `completed_games/{gameId}` record includes a sanitized top-level `aiTelemetry` object recording `engineVersion`, `evalName`, `threads`, `mtError`, and per-AI-turn search metrics (`depth`, `seldepth`, `nodes`, `stones`, `mateIn`, `timeMs`, `ponderDepth`, `ponderNodes`, `ttPermille`) without changing `turns` or breaking `_judgeAiGame` claim hashes.
    2.  Running `engine/harness/eval_games.py` and `deep_review.py` compares the live browser telemetry against deep local search and flags any turn where $\Delta_{\text{opp}} \le -1.0$ or $\Delta_{\text{ai}} \le -0.8$ with exact generator/policy ranks.

## Technical Plan (Architecture)

The technical plan is organized into three sequential stages so that all search, repetition, move-generation, and leaf-caching bottlenecks are fixed *before* generating new self-play data or shipping retrained networks.

```text
+-----------------------------------------------------------------------------------+
| STAGE 1: PRE-TRAINING SEARCH, REPETITION, GENERATOR & LEAF-CACHE FIXES            |
|                                                                                   |
|  [order.rs: ordered_first_steps_scored]                                           |
|    - Deduplicate (Move A + Place B == Move B + Place A) via post-step state key   |
|    - Keep all bare moves + sigil/crush placements + top-2/move (cap <= 60 total)  |
|                     |                                                             |
|                     +---> [turn_iter.rs: TurnIter::step]                          |
|                     |       - Reorder: Moves -> MoveCast -> DashCast -> Dash      |
|                     |       - Spell-preserving dash sac pairs in primary window   |
|                     |                                                             |
|                     +---> [policy.rs: PolicyIter & policy_example]                |
|                     |       - Lower SHIPPED_POLICY min_width (96 -> 32)           |
|                     |       - Shared dash_opts / cast_opts train-serve parity     |
|                     |                                                             |
|                     +---> [search.rs: Repetition & Ordering + nn.rs: FoldRing]    |
|                             - Append key_dash_turns in PolicyIter branch too      |
|                             - Blue 3rd-repetition mate prepass when rep_count>=2  |
|                             - Invalidate stale TT on new 2x-repeated base_history |
|                             - Fix spend_remaining root_key double-push            |
|                             - Cap tiers[0] TT-hint promotion to 1st match         |
|                             - 8-slot per-thread FoldRing in nn.rs (0 heap allocs) |
+-----------------------------------------------------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| STAGE 2: LIVE BROWSER TELEMETRY & POST-v28 HUMAN GAME AUDIT                       |
|                                                                                   |
|  [wasm.rs / rust-worker.js / rust-ai.js / game-board-local.js]                    |
|    - Export ponder_depth, ponder_nodes, tt_permille, expanded, threads, mtError   |
|    - Persist sanitized top-level `aiTelemetry` on Firebase `completed_games`      |
|                                                                                   |
|  [engine/harness/eval_games.py + deep_review.py + surprise_audit.py]              |
|    - Switch deep_review.py from 'tfit' to engine_eval(se)                         |
|    - Scan all post-Oct-7 human-vs-AI games for delta_opp <= -1.0 / delta_ai <= -.8|
+-----------------------------------------------------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| STAGE 3: TWO-PHASE NNUE & POLICY TRAINING PIPELINE (Option C)                     |
|                                                                                   |
|  Phase 3a (Existing Self-Play Chunks):                                            |
|    - #[cfg(not(target_arch = "wasm32"))] on 3 retired nets in nn.rs               |
|    - Extract 'x' (walls) & 'pm:' (bank) in nn_eval.py prep from existing z['sfn'] |
|    - Train SNN2 net with additive wall_rows[39][h] + bank_rows[2][4][h] in forward|
|                                                                                   |
|  Phase 3b (Round 4 Self-Play & Co-Training):                                      |
|    - Run Round 4 self-play with Stage 1 fixed engine (DashCast + rep + bank fix)  |
|    - Retrain policy_weights.rs + SNN2 value net on R1-R4 + human surprise corpus  |
+-----------------------------------------------------------------------------------+
```

### 1. Stage 1: Pre-Training Search, Repetition, Generator & Leaf-Cache Fixes

#### 1.1 Reordering `Stage::DashCast` Ahead of Non-Key `Stage::Dash` in `TurnIter`
*   In [`TurnIter::step`](file:///storage/emulated/10/Documents/sigil/engine/src/turn_iter.rs#L479-L610), the stage state machine currently transitions `Stage::Moves -> Stage::MoveCast -> Stage::Dash -> Stage::DashCast`.
*   Because [`TurnIter::build_key_dashes`](file:///storage/emulated/10/Documents/sigil/engine/src/turn_iter.rs#L409-L412) already extracts up to `KEY_DASH_KEEP = 8` tactical bare dashes (`CRUSH`-only by default) into reserved prepass slots (`self.key`), the remaining up to `28 * 16 = 448` bare `[move, dash, pass]` turns in `Stage::Dash` sacrifice 2 stones for a net $-1$ stone loss without casting any spell.
*   Reordering the transitions to `Stage::Moves -> Stage::MoveCast -> Stage::DashCast -> Stage::Dash` ensures that whenever an interior node uses `TurnIter`, `move + dash + cast` turns immediately follow `move + cast` turns rather than being buried behind hundreds of losing bare dashes.

#### 1.2 Lowering `SHIPPED_POLICY` `min_width` and Preserving Spell-Enabling Dash Sacrifices
*   In [`engine/src/policy.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/policy.rs#L298), `SHIPPED_POLICY` is currently `(true, 96)`. At interior nodes where [`SHIPPED_ADAPTIVE`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L127) classifies the position as easy (`scale = 2`), progressive widening widths for `w_depth = 1..3` are `w = [12, 20, 32]` (`pull = 2 * w = [24, 40, 64] < 96`), forcing [`Search::ordered_turns_action_hint`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L2132-L2155) to bypass `PolicyIter` and fall back to `TurnIter`.
*   We will benchmark lowering `SHIPPED_POLICY.1` (`min_width`) from `96` to `32` (and `24`) so `PolicyIter` interleaves moves, casts, and dash-casts by log-probability down to `w_depth = 1..3`.
*   In [`Board::ordered_dash_branches_per`](file:///storage/emulated/10/Documents/sigil/engine/src/order.rs) (called by both [`TurnIter`](file:///storage/emulated/10/Documents/sigil/engine/src/turn_iter.rs#L609) and [`dash_opts`](file:///storage/emulated/10/Documents/sigil/engine/src/policy.rs#L483-L502)), for each dash landing `(dn, dp)`, the generator currently keeps only the `per_landing = 2` lowest-cost sacrifice pairs. When a player dashes specifically to complete a 2- or 3-node spell (such as `Flourish` on Turn 27 of `GWSMF5`), the lowest-cost sacrifice pair may sacrifice a stone already sitting on that target spell's sigil (`a7` or `a8`), whereas a slightly higher-cost sacrifice pair (`c3, c5`) preserves the target spell. We will augment the per-landing sacrifice-pair selector so that if any legal sacrifice pair leaves a newly castable spell charged on the post-dash board that the top `per_landing` pairs would break, the highest-scoring spell-preserving sacrifice pair is included in the primary window (for both `PolicyIter` at serve time and `policy_example` at training time).

#### 1.3 Threefold-Repetition Defense (Red) & Offense (Blue): `key_dash_turns` in `PolicyIter`, Repetition-Mate Prepass, and TT Invalidation
*   **Append `key_dash_turns` in the `PolicyIter` branch of [`Search::ordered_turns_action_hint`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L2133-L2160):**
    *   Currently, lines 2156–2160 append `b.key_dash_turns(c, self.key_dash_reasons, self.key_dash_extra)` only in the `else if` (`TurnIter`) branch (`width < pol_min`), omitting it in the `if pol_on && width >= pol_min` (`PolicyIter`) branch. That omission caused `QJLGQR` Turn 25: at `depth = 4` (`pull = 64 < 96`, `TurnIter`), Red saw Blue's `c10->a4, dash(sac c3,c4)->c9` crushing dash into 3rd repetition and avoided `c9`; at `depth = 5` (`pull = 96 >= 96`, `PolicyIter`), `key_dash_turns` was skipped and `PolicyIter` ranked the bare dash past `pull = 96`, blinding Red to the 1-ply repetition loss.
    *   Moving the additive `if self.key_dash_extra > 0 && !self.legacy_order && width >= self.key_dash_min_width` block outside the `if/else` so it runs after *both* `PolicyIter` and `TurnIter` guarantees that tactical crushing dashes never disappear when a node crosses `pol_min` (especially once `pol_min` is lowered from `96` to `32`).
*   **Blue 3rd-Repetition Mate Prepass in `ordered_turns_action_hint` (`search.rs`):**
    *   By rulebook, the 3rd occurrence of a position (matching stones, walls, side-to-move, spell counters, and locks via `ZOBRIST.key_js`) is an immediate terminal win for **Blue** (`WIN - ply`).
    *   When `c == Color::Blue` and any key $k_{\text{rep}}$ currently has `self.rep_count(k_rep) >= 2` (either in `self.base_history` or along `self.path`), any legal Blue turn whose post-turn board has `ZOBRIST.key_js(&child) == k_rep` is an immediate **mate-in-1** for Blue.
    *   However, a repetition-completing turn may require a non-default push destination (like `c10 (pushed_to a4)` in `QJLGQR`, which only becomes a crush setup *after* `a4` is refilled) or a bare `[move, dash, pass]` whose first move was ranked outside `KEY_DASH_SCAN`'s top 4–8 moves.
    *   We will add a fast `rep_mate_prepass` in `Search::ordered_turns_action_hint`: when `c == Color::Blue` and `self.has_twofold_target()` is true, scan Blue's legal `[move (including all push_to variants), (optional place), pass]` turns and `[move, bare dash, pass]` turns (filtered by whether `b.spell_counter` can match the target key, i.e., no non-charm cast needed when spell counters already match) for any child where `self.rep_count(ckey) >= 2`. Any matching turn is inserted at index `0` of `v` (just like `decisive_lead_turns` in `front_prepass`). This both makes **Blue actively hunt and execute 1-turn threefold-repetition wins** and ensures **Red sees every 1-ply Blue repetition refutation at ply 1..N regardless of width**.
*   **Persistent TT Invalidation on New Twofold Keys & `spend_remaining` Root-Key Fix (`search.rs`):**
    *   Add `twofold_keys: Vec<u64>` to `Search`. In `Search::go_with_progress`, compute the sorted list of keys in `self.base_history` with count $\ge 2$. If that list differs from `self.twofold_keys` (meaning the real game just entered or left a 2x-repeated state), call `self.tt.clear()` and update `self.twofold_keys`. This prevents TT entries cached when a position had `rep_count == 1` (`saw_repetition == false`) from returning stale non-repetition cutoffs after that position reaches `base_history == 2`.
    *   In [`Search::spend_remaining`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L1446), only push `root_key` onto `self.path` if `self.base_history.get(&root_key).copied().unwrap_or(0) == 0` (since `wasm.rs` / `rust-ai.js` already appends the current root SFN to `history_sfns`).

#### 1.4 Deduplicating and Bounding Providence Bank (`bank[c] > 0`) First Steps
*   In [`Board::ordered_first_steps_scored`](file:///storage/emulated/10/Documents/sigil/engine/src/order.rs#L279-L302), when `self.bank[c.idx()] > 0`, the generator currently takes the full Cartesian product of `base` moves ($\sim 25$) and post-move bank placements ($\sim 25$), yielding 400–600 first steps.
*   We will replace that loop inside [`ordered_first_steps_scored`](file:///storage/emulated/10/Documents/sigil/engine/src/order.rs#L279-L302) with a bounded, deduplicated builder:
    1.  **Always emit all bare first moves (`place = None`)** scored by `move_score_goal` ($\sim 25$ steps).
    2.  **Deduplicate `(move, Some(place))` transpositions:** Track seen post-step board signatures `(b2.stones[0], b2.stones[1], b2.spells_charged)` in a small stack/vec set and keep only the higher-scored step when `Move(A) + Place(B)` and `Move(B) + Place(A)` reach the identical board state.
    3.  **Selective retention + cap:** For each first move, retain any non-duplicate bank placement that (a) newly completes a sigil (`b2.spells_charged & !b1.spells_charged != 0`), (b) pushes or crushes an enemy stone (`pp.is_some()`), or (c) is among the top `K_BANK_PER_MOVE = 2` placements for that move, and cap the total emitted `place = Some(..)` steps across the node to `MAX_BANK_STEPS = 32`.
*   Because `TurnIter`, `PolicyIter`, and `policy_example` all call `ordered_first_steps_scored`, this single change bounds first steps to $\le 60$ everywhere without train/serve drift.
*   In [`Search::ordered_turns_action_hint`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs#L2197-L2230), we will cap `tiers[0]` promotion to only the first turn matching `hint` (`Some(t.slice()[0]) == hint`), preventing secondary bank-placement variants of the TT-hinted move from flooding `tiers[0]` ahead of killer moves.

#### 1.5 Zero-Allocation 8-Slot `FoldRing` in `engine/src/nn.rs`
*   In [`engine/src/nn.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs#L240-L261), `FOLD` caches a single `Folded` entry keyed by `(net_ptr, b.spells, use_rel)` where `use_rel` masks out `b.dead_slots()` (Fissure walls). Any search subtree crossing a `Fissure` cast alternates between pre-wall and post-wall `use_rel` masks on adjacent leaves, causing `FOLD` to miss and allocate 3 `Vec<i32>` buffers on every leaf transition.
*   We will replace the 1-slot `Option<Folded>` with an 8-slot fixed array `FoldRing` per thread (`entries: [Option<Folded>; 8]`, `next: usize`) and store fixed inline arrays (`[i32; 2 * N_NODES * MAX_H]` and `[[i32; MAX_H]; 2]`) inside `Folded` so even a cold miss performs zero heap allocations.

### 2. Stage 2: Live Browser Search Telemetry & Post-v28 Human Game Audit

#### 2.1 Capturing Ponder, Thread-Pool, and Search-Tree Health Metrics
*   **WASM layer ([`engine/src/wasm.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/wasm.rs#L74-L81), [`L154-L181`](file:///storage/emulated/10/Documents/sigil/engine/src/wasm.rs#L154-L181)):** Before `Engine::search` clears `self.ponder = None`, snapshot `ponder_depth = self.ponder_depth`, `ponder_nodes = self.ponder_nodes`, and `tt_permille = ((self.s.tt_filled() as u64 * 1000) / self.s.tt_len().max(1) as u64) as u32`. Include `ponder_depth`, `ponder_nodes`, `tt_permille`, `expanded` (`st.expanded`), and `eval_name` in `move_json`.
*   **Worker & AI wrapper ([`rust-worker.js`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/engine/rust-worker.js#L214-L220), [`rust-ai.js`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/engine/rust-ai.js#L361-L514)):** Save the worker's `init` response (`threads`, `threadsWanted`, `mtError`, `engineVersion`) on the `RustAI` instance and include those fields plus the new `move_json` counters on `this.lastMeta`.
*   **Firebase `completed_games` persistence ([`game-board-local.js`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/game-board-local.js#L2890-L2920)):** Keep `turns` and [`slimGameLog`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/engine/notation.js#L188-L210) untouched so [`_judgeAiGame`](file:///storage/emulated/10/Documents/sigil/functions/rating.js#L306-L308) SHA-256 `claimKey` hashes, SGN-T exports, and `reconstructGameLog` remain invariant. Instead, attach a sanitized, null-stripped top-level `aiTelemetry` object to `gameRecord` in `_recordFinishedGame`:
    ```json
    {
      "v": 35,
      "eval": "nnue_mt256",
      "threads": 4,
      "threadsWanted": 4,
      "byPly": {
        "2": { "d": 8, "sd": 14, "n": 412050, "exp": 38910, "s": 0.54, "ms": 9980, "pd": 6, "pn": 184000, "tt": 312 }
      }
    }
    ```

#### 2.2 Post-v28 Human-vs-AI Game Audit
*   Update the 3 hardcoded `EVAL_NAME = 'tfit'` calls in [`engine/harness/deep_review.py`](file:///storage/emulated/10/Documents/sigil/engine/harness/deep_review.py#L81) to use `engine_eval(se)`.
*   Extend [`PolicyDiag`](file:///storage/emulated/10/Documents/sigil/engine/src/policy.rs#L1264-L1271) to report `in_explore_tail: bool` and `broken_stage: Option<&'static str>` so `r3_gen_diag.py` and `deep_review.py` distinguish primary-window hits from `SHIPPED_EXPLORE` tail turns.
*   Run `eval_games.py` + `deep_review.py` + `surprise_audit.py` across all post-Oct-7 human-vs-AI games in Firebase (both `completed_games` and active/finished `rooms` such as `QJLGQR`) using the Stage 1 engine to verify `GWSMF5` and `QJLGQR` and catalog any remaining human surprise turns ($\Delta_{\text{opp}} \le -1.0$) or AI blunders ($\Delta_{\text{ai}} \le -0.8$).

### 3. Stage 3: Two-Phase Post-Fix NNUE & Round 4 Self-Play Pipeline (Option C)

#### 3.1 Phase 3a — WASM Weight Pruning & Additive Wall/Bank (`SNN2`) Retrain on Existing Chunks
*   **Prune retired WASM nets:** Gate `NNUE_SPELL`, `NNUE_SPELL3`, and `NNUE_SPELL4` behind `#[cfg(not(target_arch = "wasm32"))]` in [`engine/src/nn.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs#L61-L85), keeping them available in native Rust builds for `cargo run --release --bin arena` while removing ~75% of embedded weight bytes from `sigil_engine_bg.wasm` and `sigil_engine_mt_bg.wasm`.
*   **Extract walls and banks from existing `.npz` chunks:** In [`engine/harness/nn_eval.py`](file:///storage/emulated/10/Documents/sigil/engine/harness/nn_eval.py#L106-L119), `prep` already reads `z['sfn']` from every historical self-play chunk (`r1`, `r2`, `r3`). Update `prep` to extract `walls` (`uint64` bitmask of `'x'` chars in the 39-node board field) and `bank` (`uint8[2]` parsed from the optional `pm:r:b` field) without needing to re-run historical self-play.
*   **Additive `SNN2` leaf accumulator inputs:** Extend [`Net::parse`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs#L125-L149) to support magic `b"SNN2"` (while preserving `b"SNN1"` for `nnue_mt256`), adding `wall_rows: [39][h]` and `bank_rows: [2][4][h]` (for mover/opponent bank counts `0..=3`) added directly into `acc` inside [`Net::forward`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs#L196-L226) in $O(\text{popcnt}(\text{walls}) \cdot h + h)$. Extend [`wasm.rs::nn_eval_raw`](file:///storage/emulated/10/Documents/sigil/engine/src/wasm.rs#L423-L437) and `tools/nn-wasm-parity.js` to test bit-exact SIMD128 vs. native parity on boards with non-zero `walls` and `bank`.

#### 3.2 Phase 3b — Round 4 Self-Play Generation & Policy/Value Co-Training
*   **Why a Round 4 self-play run is required after Stage 1:** All historical self-play chunks (`r1`–`r3`) were generated by an engine whose interior search nodes (`TurnIter`) never reached `Stage::DashCast` (`move + dash + cast`), whose `PolicyIter` branch dropped `key_dash_turns`, whose `dash_opts` dropped spell-preserving non-default sacrifice pairs, and whose search collapsed to depth 3 whenever `Dividend` or `Rebate` banked a stone. Retraining only on `r1`–`r3` leaves the policy and value network under-exposed to post-fix `move + dash + cast` tactics, threefold-repetition dash traps, and deep Providence bank play.
*   **Round 4 execution:**
    1.  Generate a new self-play round (`r4`, ~5,000–10,000 games) using the Stage 1 fixed engine (and the Phase 3a net if it passes the arena gate).
    2.  Retrain `policy_weights.rs` via [`policy_train.py`](file:///storage/emulated/10/Documents/sigil/engine/harness/policy_train.py) with fail-fast per-slice `target == -1` assertions and exact train/serve candidate-window parity.
    3.  Retrain the `SNN2` value network on `r1`–`r4` + 5x-upsampled human-game surprise positions from Stage 2, and ship the new weights if and only if they clear the $\ge +20$ Elo arena gate at 2.5 s/move (400 games) and pass the browser WASM parity and `GWSMF5` / `QJLGQR` tactical regression checks.

## Alternatives Considered

### Alternative A: Unconditionally Widen `dash_opts` and `cast_opts` Only Inside `policy_example`

*   **Pros**: Eliminates `target = -1` drops on `--xbetter` exploration-tail (`SHIPPED_EXPLORE`) self-play rows without changing `PolicyIter`'s serve-time candidate windows.
*   **Cons**:
    *   Violates train/serve softmax denominator parity with [`PolicyIter::expand`](file:///storage/emulated/10/Documents/sigil/engine/src/policy.rs#L929-L1033) (training `w` over 64–128 candidates while serving over 16 candidates).
    *   Maps tail candidates onto saturated rank feature buckets (`F_C_KEEPR` clamped at `3`, `F_C_ORANK` clamped at `5`, `F_D_RANK` clamped at `>= 32`), so the log-linear model cannot distinguish tail options from each other.
    *   Inflates `examples.npz` feature arrays by 4x–8x during `policy_train.py extract`.
*   **Reason for Rejection**: Train and serve must share the exact same primary candidate window by construction; spell-preserving dash sacrifice pairs and bank-step bounds must be applied identically in both `PolicyIter` and `policy_example`.

### Alternative B: Split WASM Into Separate Per-Tier Binaries with a `512+` Hidden-Unit Network Only in `wasm-mt`

*   **Pros**: Allows Desktop Hard/Very Hard to embed a multi-megabyte network without increasing the single-threaded `sigil_engine_bg.wasm` download on mobile.
*   **Cons**:
    *   Prior testing in [`2026-10-eval-simplification.md`](file:///storage/emulated/10/Documents/sigil/engine/reports/2026-10-eval-simplification.md#L29-L36) showed `nnue_mt512` was statistically flat (`+9.3 [-5.3, +24.0]` Elo) because leaf accumulator work scales linearly with `H`, trading away search depth—the exact resource `GWSMF5` ran out of.
    *   [`functions/copy-engine.js`](file:///storage/emulated/10/Documents/sigil/functions/copy-engine.js#L11-L17) copies only single-threaded `sigil_engine_bg.wasm` to Firebase Cloud Functions (`pricing.js` and `analysis.js`), which read `RUST_REVIEW_SEARCH.evalName` from [`game-review.js`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/engine/game-review.js#L42). Any `SHIPPED_EVAL` missing from single-threaded `wasm/` crashes Cloud Functions and non-COOP/COEP fallback browsers with `"unknown eval name"`.
*   **Reason for Rejection**: Gating the 3 retired legacy nets (`NNUE_SPELL`, `NNUE_SPELL3`, `NNUE_SPELL4`) behind `#[cfg(not(target_arch = "wasm32"))]` in [`engine/src/nn.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs#L61-L75) already reclaims ~75% of embedded weight bytes in the unified WASM binary without breaking Cloud Functions or Service Worker precaching.

### Alternative C: Embed Raw `this.ai.lastMeta` Inside Each `turns[i]` Entry in `slimGameLog`

*   **Pros**: Keeps move actions and search telemetry co-located in the same array element.
*   **Cons**:
    *   [`_judgeAiGame`](file:///storage/emulated/10/Documents/sigil/functions/rating.js#L306-L308) hashes `JSON.stringify([..., turns, ...])` into the SHA-256 `claimKey`.
    *   [`reconstructGameLog`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/engine/game-review.js#L1194-L1201) and [`tools/replay-transcripts.js`](file:///storage/emulated/10/Documents/sigil/tools/replay-transcripts.js#L35-L40) reconstruct turn objects with only `{ color, turnNumber, kind, actions }` and silently strip extra fields on takeback, reload, or hydration.
    *   `undefined` or `NaN` properties on `lastMeta` cause [`OfflineGameQueue`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/offline-queue.js#L173-L185) Firebase RTDB writes to fail synchronously.
*   **Reason for Rejection**: Writing a sanitized, null-stripped top-level `aiTelemetry` field on `completed_games/{gameId}` preserves `turns` integrity, SGN-T compatibility, and rating claim hashes.

### Alternative D: Retrain NNUE and Policy Only on Historical `r1`–`r3` Self-Play Chunks Without Running Round 4 Self-Play

*   **Pros**: Saves the compute time of generating 5,000–10,000 new self-play games.
*   **Cons**:
    *   Historical `r1`–`r3` self-play games were generated by an engine whose interior search nodes (`TurnIter`) never reached `Stage::DashCast` (`move + dash + cast`), whose `PolicyIter` branch dropped `key_dash_turns`, whose `dash_opts` dropped non-default spell-preserving sacrifice pairs, and whose search collapsed to depth 3 whenever a stone was banked via `Dividend` or `Rebate`.
*   **Reason for Rejection**: While Phase 3a can rapidly test additive wall/bank features on existing `r1`–`r3` chunks, Phase 3b (Round 4 self-play generated with the Stage 1 fixed engine) is required so the policy and value networks learn accurate valuations for post-fix `move + dash + cast` tactics, repetition-aware play, and deep Providence bank play.

### Alternative E: Score 2nd-Occurrence Repetition States Heuristic-Only in Static `eval` Instead of Adding a Repetition-Mate Prepass and Appending `key_dash_turns` in `PolicyIter`

*   **Pros**: Avoids scanning for repetition-completing turns in `ordered_turns_action_hint`.
*   **Cons**:
    *   A static heuristic penalty on 2nd-occurrence states cannot help when the 2nd occurrence is *already* on the board at the root (as on Turn 25 of `QJLGQR`) and Red moves to a *brand-new* board state (`rrr.rr....rr...............bbbbbbbrr..b`, `rep_count == 0`) from which Blue has a 1-turn bare-dash crush back into the 3rd occurrence.
    *   Without `key_dash_turns` in the `PolicyIter` branch and a repetition-mate prepass for Blue, the child turn that reaches the 3rd occurrence is pruned by `PolicyIter`'s width cap before `negamax` ever visits the repeated child.
*   **Reason for Rejection**: Exact terminal threefold-repetition detection requires the generator at `PolicyIter` and `TurnIter` nodes alike to include `key_dash_turns` and promote any legal Blue turn that reaches a `rep_count >= 2` key.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Performance & Latency**:
    *   Leaf evaluation in [`nn::eval`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs#L245-L261) must perform zero heap allocations across `Fissure`-walled subtrees (via the 8-slot per-thread `FoldRing`), and additive `SNN2` wall/bank accumulation must add $< 3\%$ overhead to single-leaf forward time.
    *   The Blue repetition-mate prepass in `ordered_turns_action_hint` must be gated on `c == Color::Blue && self.has_twofold_target()` so it adds zero overhead on the $> 95\%$ of search nodes where no position has occurred twice.
    *   On the `GWSMF5` midgame positions (Turns 11–27), the Stage 1 engine must reach depth $\ge 5$ within 2.5 seconds (and depth $\ge 6$ within 10 seconds on 4 threads), compared to depth 3 in `v34`; on `QJLGQR` Turn 25, the Stage 1 engine must see Blue's `c10->a4, dash(sac c3,c4)->c9` 3rd-repetition refutation at every depth $\ge 2$.
*   **Storage & Bandwidth Footprint**:
    *   Gating retired networks out of `wasm32` must reduce `docs/static/wasm/sigil_engine_bg.wasm` and `docs/static/wasm-mt/sigil_engine_mt_bg.wasm` size even after adding the `SNN2` wall/bank rows.
    *   Top-level `aiTelemetry` in `completed_games/{gameId}` must average $< 1.5\text{ KB}$ per 30-turn AI game.
*   **Rollout & Backward Compatibility**:
    *   `aiTelemetry` in [`database.rules.json`](file:///storage/emulated/10/Documents/sigil/database.rules.json#L315-L355) must remain optional so pre-deploy games queued in `OfflineGameQueue` (`sigil_offline_games_v1`) upload cleanly after deployment.
    *   [`Net::parse`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs#L125-L149) must continue to parse `b"SNN1"` weights (`nnue_mt256`) alongside `b"SNN2"` so head-to-head arena matches can benchmark the new network against `v34`.
    *   Deploying any WASM update requires lockstep updates to `RUST_ENGINE_VERSION` in [`rust-ai.js`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/engine/rust-ai.js#L40), `?v=` query strings in HTML files, `CACHE_VERSION` in [`docs/sw.js`](file:///storage/emulated/10/Documents/sigil/docs/sw.js#L28), and running `node functions/copy-engine.js`.

--------------------------------------------------------------------------------

### Additional Resources

*   [`concepts_brief.md`](../../concepts_brief.md) — Upstream `/egm-brainstorm` synthesis and 6-Goldfish audit findings.
*   [`engine/STATUS.md`](../../engine/STATUS.md) & [`engine/FINDINGS.md`](../../engine/FINDINGS.md) — Historical Elo ledger and negative-result log (`v1`–`v34`).
*   [`engine/reports/2026-10-r3-gate.md`](../../engine/reports/2026-10-r3-gate.md), [`2026-10-r3-gen.md`](../../engine/reports/2026-10-r3-gen.md), [`2026-10-eval-simplification.md`](../../engine/reports/2026-10-eval-simplification.md), [`2026-10-fissure-dead-spells.md`](../../engine/reports/2026-10-fissure-dead-spells.md).

### Future Improvements

*   **Larger Multi-Layer or Wider NNUE Architectures for Hard & Very Hard**: Once the Stage 1 search/generator bottlenecks are removed and Round 4 self-play data is collected, evaluate wider (`H = 384..512`) or two-hidden-layer (`256 -> 32 -> 1`) networks for the 10-second and 60-second tiers where multi-threaded search depth is already $\ge 6$ plies.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

#### 1. [`engine/src/order.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/order.rs) (Modify)

*   **Type / Scope**: Rust Engine — Move & Dash Ordering (`ordered_first_steps_scored`, `ordered_dash_branches_per`)
*   **Proposed Changes**:
    *   In `Board::ordered_first_steps_scored(c)` (lines 279–302), replace the unbounded Cartesian product when `self.bank[c.idx()] > 0` with a deduplicated, capped step builder:
        1.  Emit all bare moves `(n, p, is_blink, None)` scored by `move_score_goal`.
        2.  For `(n, p, is_blink, Some((pn, pp)))` bank-placement combinations, compute the post-step board signature `(b2.stones[0], b2.stones[1], b2.spells_charged)` and deduplicate transpositions (`Move A + Place B == Move B + Place A`), retaining the higher-scored step.
        3.  Retain bank placements that newly complete a sigil (`b2.spells_charged & !b1.spells_charged != 0`), push/crush an enemy stone (`pp.is_some()`), or rank in the top `K_BANK_PER_MOVE = 2` placements for that move, capped at `MAX_BANK_STEPS = 32` total placement steps per node ($\le 60$ total first steps).
    *   In `Board::ordered_dash_branches_per(c, width, per_landing)`, after selecting the top `per_landing` sacrifice pairs by lowest `dash_sacrifice_cost` for a given landing `(dn, dp)`, check whether any remaining legal sacrifice pair leaves a castable spell charged on the post-dash board (`bd.castable(c, true, true, true) != 0`) whose sigil stones were sacrificed by the default `per_landing` pairs. If so, append the highest-scoring spell-preserving sacrifice pair for that landing so `TurnIter`, `PolicyIter`, and `policy_example` all include it in the primary window.
*   **Rationale**: Eliminates the 25x Providence bank branching explosion and `Move A + Place B` transposition duplicates across `TurnIter`, `PolicyIter`, and `policy_example` from a single source of truth, and ensures `move + dash + cast` turns requiring non-default sacrifice pairs (such as `GWSMF5` Turn 27 `Flourish`) are not dropped before spell resolution.

#### 2. [`engine/src/turn_iter.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/turn_iter.rs) (Modify)

*   **Type / Scope**: Rust Engine — Stage-Ordered Turn Iterator (`TurnIter`)
*   **Proposed Changes**:
    *   In `TurnIter::step` (lines 479–610), reorder the stage state machine from `Stage::Moves -> Stage::MoveCast -> Stage::Dash -> Stage::DashCast` to `Stage::Moves -> Stage::MoveCast -> Stage::DashCast -> Stage::Dash`.
    *   Add unit tests verifying that on midgame positions with both castable post-dash spells and bare dashes, `TurnIter` yields `move + dash + cast` turns before non-key bare `[move, dash, pass]` turns, and that `ordered_first_steps` on a board with `bank[c] == 1` returns $\le 60$ deduplicated steps.
*   **Rationale**: Prevents up to 448 losing bare `[move, dash, pass]` turns from starving `Stage::DashCast` (`move + dash + cast`) at interior search nodes when `TurnIter` is used.

#### 3. [`engine/src/policy.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/policy.rs) (Modify)

*   **Type / Scope**: Rust Engine — Learned Move-Generator Policy (`PolicyIter`, `policy_example`, `PolicyDiag`)
*   **Proposed Changes**:
    *   Update `SHIPPED_POLICY` (line 298) from `(true, 96)` to `(true, 32)` (validated via arena A/B testing at `min_width = 24` and `32`) so interior nodes at `w_depth = 2..3` (`pull = 40..64`) use `PolicyIter` instead of falling back to `TurnIter`.
    *   Extend `PolicyDiag` (lines 1264–1271) with `pub in_explore_tail: bool` and `pub broken_stage: Option<&'static str>` so `policy_diag_of_turn` reports whether a turn was generated via `SHIPPED_EXPLORE` (`Node::CastKeepTail`, `Node::CastOutTail`, `Node::DashTail`, `Node::DashCastOutTail`) and which stage (`"L_M"`, `"L_C"`, `"L_D"`, `"L_DC"`) fell outside the primary window.
*   **Rationale**: Enables best-first log-probability interleaving of moves, casts, and dash-casts at interior nodes while preserving strict train/serve candidate-window parity and giving audit scripts exact visibility into tail-explored turns.

#### 4. [`engine/src/search.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs) (Modify)

*   **Type / Scope**: Rust Engine — Alpha-Beta Search, Repetition Detection, and Move Ordering (`Search`)
*   **Proposed Changes**:
    *   In `Search::ordered_turns_action_hint` (lines 2132–2173):
        1.  Move the additive `key_dash_turns` block (`if self.key_dash_extra > 0 && !self.legacy_order && width >= self.key_dash_min_width`) outside the `if pol_on / else if` branches so `b.key_dash_turns(c, self.key_dash_reasons, self.key_dash_extra)` is appended in **both** the `PolicyIter` (`width >= pol_min`) and `TurnIter` (`width < pol_min`) paths.
        2.  Add a Blue 3rd-repetition mate prepass (`rep_mate_turns`): when `c == Color::Blue` and `self.has_twofold_target()` is true (meaning at least one key in `self.base_history` or `self.path` has `self.rep_count(k) >= 2`), scan Blue's legal `[move (all push_to variants), (optional place), pass]` and `[move, bare dash, pass]` turns (gated on spell-counter compatibility with the 2x-repeated key) and promote any turn reaching `self.rep_count(ckey) >= 2` to index `0` of `v`.
        3.  In the TT/killer promotion loop (lines 2210–2229), cap `tiers[0]` to at most 1 turn (`tiers[0].is_empty() && Some(a) == hint`), sending any additional turns that share the same first action `a` (such as secondary bank placements) to `rest`.
    *   Add `twofold_keys: Vec<u64>` to `Search`. In `Search::go_with_progress` (around line 1080), collect all `k` in `self.base_history` with count $\ge 2$ (sorted); if `current_twofold != self.twofold_keys`, call `self.tt.clear()` and update `self.twofold_keys` so stale non-repetition TT entries from before a position became a 2x-repeated trap cannot cut off search.
    *   In `Search::spend_remaining` (line 1446), guard `self.path.push(root_key)` with `let pushed_root = self.base_history.get(&root_key).copied().unwrap_or(0) == 0; if pushed_root { self.path.push(root_key); }` (and pop conditionally) so `root_key` is not double-counted when `wasm.rs` / `rust-ai.js` already passed the root SFN in `history_sfns`.
    *   Add `pub fn tt_len(&self) -> usize { self.mask + 1 }` on `Search` for TT occupancy reporting.
    *   Add unit tests covering `QJLGQR` Turn 25 (verifying Red sees Blue's `c10->a4, dash(sac c3,c4)->c9` 3rd-repetition mate at depths 2, 3, 4, and 5 and does not play `c9`) and `QJLGQR` Turn 26 (verifying Blue immediately finds `c10->a4, dash(sac c3,c4)->c9` as a mate-in-1).
*   **Rationale**: Fixes the `QJLGQR` depth-5 repetition blunder (`PolicyIter` dropping `key_dash_turns`), enables Blue to actively find and execute 1-turn threefold-repetition wins, prevents stale TT cutoffs when a game enters a 2x-repeated state, and prevents TT-hint bank-placement flooding.

#### 5. [`engine/src/nn.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs) (Modify)

*   **Type / Scope**: Rust Engine — NNUE Weights, Leaf Cache (`FoldRing`), and `SNN2` Forward Pass
*   **Proposed Changes**:
    *   Gate the 3 retired legacy static networks (`NNUE_SPELL`, `NNUE_SPELL3`, `NNUE_SPELL4` and their entries in `eval.rs`) behind `#[cfg(not(target_arch = "wasm32"))]`.
    *   Replace the 1-slot heap-allocating `FOLD: RefCell<Option<Folded>>` thread-local cache (lines 240–261) with an 8-slot fixed ring buffer `FoldRing` (`entries: [Option<Folded>; 8]`, `next: usize`) where `Folded` stores inline fixed arrays (`node_bias: [i32; 2 * N_NODES * MAX_H]`, `side_bias: [[i32; MAX_H]; 2]`, `h: usize`) instead of heap-allocated `Vec<i32>`.
    *   Extend `Net` and `Net::parse` (lines 88–149) to accept both `b"SNN1"` (current `nnue_mt256`) and `b"SNN2"` (which appends `wall_rows: [39][h]` and `bank_rows: [2][4][h]` as `i16` little-endian tables). In `Net::forward` (lines 196–226), when `wall_rows` / `bank_rows` are present, add active wall rows (`b.walls` bitmask) and clamped bank rows (`b.bank[me].min(3)`, `b.bank[opp].min(3)`) into `acc` before ClippedReLU and the `w2` dot product.
*   **Rationale**: Eliminates 3 heap allocations and ~180,000 ops per leaf miss on `Fissure` boards, strips ~75% of dead weight bytes from `wasm32` builds, and supports `SNN2` wall/bank features with full backward compatibility for `SNN1`.

#### 6. [`engine/src/eval.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/eval.rs) (Modify)

*   **Type / Scope**: Rust Engine — Evaluation Preset Registry (`EVAL_NAMES`, `weights_by_name`)
*   **Proposed Changes**:
    *   Gate the `nnue_spell`, `nnue_spell3`, and `nnue_spell4` branches in `weights_by_name` and `EVAL_NAMES` behind `#[cfg(not(target_arch = "wasm32"))]` to match `nn.rs`, keeping `nnue_mt256` (and any new `SNN2` candidate preset) available on all targets.
*   **Rationale**: Keeps native arena benchmarks able to test all historical nets while compiling only active nets into WASM.

#### 7. [`engine/src/wasm.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/wasm.rs) (Modify)

*   **Type / Scope**: Rust WASM Bindings (`Engine::search`, `move_json`, `nn_eval_raw`)
*   **Proposed Changes**:
    *   In `Engine::search` (lines 154–181), snapshot `let ponder_depth = self.ponder_depth; let ponder_nodes = self.ponder_nodes;` before setting `self.ponder = None`, and compute `tt_permille = ((self.s.tt_filled() as u64 * 1000) / (self.s.tt_len().max(1) as u64)) as u32`.
    *   Pass `ponder_depth`, `ponder_nodes`, `tt_permille`, `st.expanded`, and `eval_name` into `move_json` so the JSON response includes `"ponder_depth"`, `"ponder_nodes"`, `"tt_permille"`, `"expanded"`, and `"eval"`.
    *   Update `nn_eval_raw` (lines 423–437) to accept `sfn: &str` (or optional `walls: u64, red_bank: u8, blue_bank: u8`) so `tools/nn-wasm-parity.js` tests SIMD128 vs. scalar parity with active walls and banks.
*   **Rationale**: Exposes pondering effectiveness, TT fullness, and expanded node counts to the browser telemetry pipeline without extra worker round-trips.

#### 8. [`engine/src/py.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/py.rs) (Modify)

*   **Type / Scope**: Rust PyO3 Bindings (`policy_diag_of_turn`)
*   **Proposed Changes**:
    *   Update the `policy_diag_of_turn` dictionary/tuple return in `py.rs` to include `in_explore_tail` and `broken_stage` from `PolicyDiag`.
*   **Rationale**: Allows Python audit scripts (`r3_gen_diag.py`, `deep_review.py`, `policy_train.py`) to inspect whether a human or self-play turn required `SHIPPED_EXPLORE`.

#### 9. [`docs/static/scripts/engine/rust-worker.js`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/engine/rust-worker.js) & [`docs/static/scripts/engine/rust-ai.js`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/engine/rust-ai.js) (Modify)

*   **Type / Scope**: Browser Web Worker & AI Client Wrapper
*   **Proposed Changes**:
    *   In `rust-worker.js`, include `threads: _threads`, `threadsWanted: want`, and `mtError: _mtError` in the `search` response payload alongside the fields parsed from `Engine::search`'s `move_json`.
    *   In `rust-ai.js`, bump `RUST_ENGINE_VERSION` (`34 -> 35`) and populate `this.lastMeta` with `engineVersion: RUST_ENGINE_VERSION`, `evalName: res.eval || this.evalName`, `threads: res.threads || 1`, `threadsWanted: res.threadsWanted || this.threads`, `mtError: res.mtError || null`, `expanded: res.expanded || 0`, `ponderDepth: res.ponder_depth || 0`, `ponderNodes: res.ponder_nodes || 0`, and `ttPermille: res.tt_permille || 0`.
*   **Rationale**: Captures complete per-turn search and thread-pool health metadata on `this.ai.lastMeta` for live UI reporting and post-game Firebase persistence.

#### 10. [`docs/static/scripts/game-board-local.js`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/game-board-local.js) & [`database.rules.json`](file:///storage/emulated/10/Documents/sigil/database.rules.json) (Modify)

*   **Type / Scope**: Frontend Game Recorder & Firebase RTDB Security Rules
*   **Proposed Changes**:
    *   In `game-board-local.js`:
        1.  During `ai_think_report` handling, accumulate a per-AI-turn map `_aiTelemetryByPly[turnNumber]` containing strictly finite integer/number fields (`d`, `sd`, `od`, `n`, `exp`, `s`, `m`, `mp`, `ms`, `bms`, `cms`, `pd`, `pn`, `tt`).
        2.  In `_recordFinishedGame` (around lines 2890–2920), when `this._aiOpponentId` is a Rust AI tier and `_aiTelemetryByPly` is non-empty, attach a sanitized, null/NaN-stripped top-level `aiTelemetry` object (`{ v, eval, threads, threadsWanted, mtError, byPly }`) to `gameRecord` without modifying `turns`.
    *   In `database.rules.json` (lines 315–355), allow the optional `aiTelemetry` child on `completed_games/$gameId` with size/type validation (`aiTelemetry.hasChildren(['v', 'eval', 'threads', 'byPly'])`).
*   **Rationale**: Persists live 10s/60s browser search telemetry to Firebase `completed_games` while keeping `turns` claim hashes (`_judgeAiGame`), SGN-T exports, and `OfflineGameQueue` uploads intact.

#### 11. [`engine/harness/deep_review.py`](file:///storage/emulated/10/Documents/sigil/engine/harness/deep_review.py), [`engine/harness/nn_eval.py`](file:///storage/emulated/10/Documents/sigil/engine/harness/nn_eval.py), & [`engine/harness/policy_train.py`](file:///storage/emulated/10/Documents/sigil/engine/harness/policy_train.py) (Modify)

*   **Type / Scope**: Python Audit & Training Pipeline Scripts
*   **Proposed Changes**:
    *   In `deep_review.py` (line 81 and worker init), replace the hardcoded `EVAL_NAME = 'tfit'` with `engine_eval(se)` (matching `eval_games.py`) and add support for reading `aiTelemetry.byPly` from `completed_games` records when present.
    *   In `nn_eval.py`:
        1.  In `prep` (lines 106–119), parse `'x'` wall characters from field 0 of `z['sfn']` into `walls: uint64[N]` and parse the optional `pm:r:b` token into `bank: uint8[N, 2]`, saving both arrays into `packed.npz`.
        2.  In `SpellNet` and `export` (lines 178–320), add `wall_emb = nn.EmbeddingBag(39, hidden, mode='sum')` and `bank_emb = nn.Embedding(8, hidden)` (for mover/opponent bank count `0..=3`), and export with magic `b"SNN2"` when `--snn2` is enabled.
    *   In `policy_train.py`, add a fail-fast assertion on `extract` that logs the per-slice (`L_M`, `L_C`, `L_D`, `L_DC`) `target == -1` drop rate and aborts if the primary-window (non-`in_explore_tail`) drop rate exceeds `1%`.
*   **Rationale**: Aligns the audit harness with `nnue_mt256`, extracts wall/bank features from existing `r1`–`r3` self-play chunks without re-playing historical games, and prevents silent policy-training target drops.

#### 12. [`tools/nn-wasm-parity.js`](file:///storage/emulated/10/Documents/sigil/tools/nn-wasm-parity.js), [`docs/sw.js`](file:///storage/emulated/10/Documents/sigil/docs/sw.js), [`docs/game.html`](file:///storage/emulated/10/Documents/sigil/docs/game.html), [`docs/multiplayer.html`](file:///storage/emulated/10/Documents/sigil/docs/multiplayer.html), [`docs/puzzles.html`](file:///storage/emulated/10/Documents/sigil/docs/puzzles.html), [`docs/review.html`](file:///storage/emulated/10/Documents/sigil/docs/review.html), [`engine/STATUS.md`](file:///storage/emulated/10/Documents/sigil/engine/STATUS.md), & [`engine/FINDINGS.md`](file:///storage/emulated/10/Documents/sigil/engine/FINDINGS.md) (Modify)

*   **Type / Scope**: Parity Tests, Service Worker Cache Busting, and Engine Ledger Docs
*   **Proposed Changes**:
    *   Update `tools/nn-wasm-parity.js` to test bit-exact SIMD128 WASM vs. native evaluation on positions containing active `Fissure` walls (`'x'`) and `Providence` bank reserves (`pm:`).
    *   After rebuilding `docs/static/wasm/` (`engine/build-wasm.sh`), `docs/static/wasm-mt/` (`engine/build-wasm-mt.sh`), and `functions/wasm/` (`node functions/copy-engine.js`), bump `?v=35` in `docs/game.html`, `docs/multiplayer.html`, `docs/puzzles.html`, `docs/review.html`, and `CACHE_VERSION` in `docs/sw.js`.
    *   Record all Stage 1 and Stage 3 arena Elo results and human-game audit metrics in `engine/STATUS.md` and `engine/FINDINGS.md`.
*   **Rationale**: Enforces bit-exact WASM SIMD128 parity, prevents stale Service Worker caches in browsers, and keeps the Cloud Functions engine copy in sync.

### Verification Plan

*   **Compilation & WASM Builds**:
    *   `cargo test --release --manifest-path engine/Cargo.toml`
    *   `maturin develop --release --manifest-path engine/Cargo.toml`
    *   `./engine/build-wasm.sh && ./engine/build-wasm-mt.sh && node functions/copy-engine.js`
*   **Unit & Parity Tests**:
    *   `cargo test --release --manifest-path engine/Cargo.toml` (including new unit tests for `ordered_first_steps_scored` bank deduplication/capping, `TurnIter` `Stage::DashCast` ordering, `FoldRing` multi-wall caching, and `QJLGQR` Turn 25–26 threefold-repetition detection).
    *   `node tools/wasm-smoke.js` and `node tools/nn-wasm-parity.js` (verifying 0 mismatches across 500 positions including `Fissure` walls and `Providence` bank states).
    *   `npm test` (verifying frontend and Cloud Functions test suites pass with `aiTelemetry`).
*   **Tactical Regression Gate (`GWSMF5` & `QJLGQR`)**:
    *   **`GWSMF5` Turn 26 (`b 26`)**: Verify that within a 2.5s single-thread search and 10s 4-thread search, the engine reaches depth $\ge 5$, ranks Red's `b6, dash (sac c3, c5 -> b1->a9), Flourish` threat inside the ply-1 candidate width, and does not play `b11, Charge`.
    *   **`QJLGQR` Turn 25 (`r 25`) & Turn 26 (`b 26`)**: Verify that on Turn 25 (`r 25`), Red sees Blue's `c10->a4, dash(sac c3,c4)->c9` 3rd-repetition mate at every depth $2..6$ and plays a non-repeating winning move (`c8`); and on Turn 26 (`b 26`), Blue immediately selects `c10->a4, dash(sac c3,c4)->c9` with `mate_in == 1`.
*   **Arena Elo Gate**:
    *   Run 400-game color-swapped head-to-head arena matches (`cargo run --release --bin arena` / `engine/harness/arena_zyx.py`) at matched clock (1.0 s/move and 2.5 s/move) for Stage 1 search fixes, Phase 3a `SNN2` weights, and Phase 3b Round 4 co-trained policy + `SNN2` weights against `v34`, requiring $\ge +20$ Elo with lower 95% confidence bound $> 0$ before shipping.

--------------------------------------------------------------------------------

<!-- Provenance: Indicates initial structural drafting via EGM. -->

*Drafted with EGM*
