# Round 2: multi-core in the browser (option A), 2026-10-07

Branch `r2-multicore`, cut from `providence-bank` at a3771ed0 (engine v25). Question: step 6 built
"option A", which splits each move's root across several Web Workers, each with its own `Engine` and
table. Does it make the shipped v25 AI stronger, the way the native parallel root did (+44 / +41 Elo at
2 / 4 threads at 3 s, `2026-10-step6.md`)?

**Answer: no.** Measured as the browser would run it, option A is no stronger than one worker at
2 or 4 workers. Its original merge rule is worse than one worker. The account setting is built,
but its card stays hidden and the default stays one worker.

## How it was measured

The fleet cannot run browsers, so the harness emulates option A natively.
* `PyBoard.play_best(split_workers=k)` builds k independent `Search` objects, each with its own
  table. Each one searches root part i of k (`Search::set_root_split`, the same hash split the wasm
  uses) on its own thread with the full move time.
* The results are merged as `rust-ai.js` merges them (`split_pick`, a native port of
  `pickSplitResult`).
* Every worker thread inherits the generator switches, including the thread-local v25 policy
  (`ThreadSwitches::capture/apply`, now `pub(crate)`).
* `ab_search.py` knob `split` sets `se.SHIPPED_POLICY` on both arms; the value is merge*10 + k. Base 1
  is the shipped single engine with eval `nnue_spell`.
* Each VM ran one k-thread shard per k physical cores: c3d-highcpu-60 (30 cores), 15 shards for
  k=2 and 7 for k=4.

**Check of the emulation.** At a fixed depth of 4 over 20 midgame positions, the split search
returns the same move as the single search in 17 of 20 positions and the same score in 17. The
differences come from widening and aspiration. The parts are disjoint and complete (pinned in Rust by
`root_split_parts_are_disjoint_and_cover_the_root`).

## Arenas (fixed time, colour-swapped, core draws, pooled from GAME lines)

| merge | k | time | games | Elo vs 1 worker (95% CI) | depth arm / base |
|---|---|---|---|---|---|
| 0 = rust-ai.js (best final score) | 2 | 3 s | 720 | **-26.6 [-52.1, -1.2]** | 6.21 / 6.06 |
| 0 | 4 | 3 s | 107 (stopped early) | **-89.6 [-157.2, -22.0]** | — |
| 0 | 2 | 10 s | 65 (stopped early) | -48.4 [-132.9, +36.0] | — |
| 1 = common completed depth | 2 | 3 s | 720 | -16.4 [-41.8, +9.0] | 6.16 / 6.00 |
| 1 | 4 | 3 s | 350 | +6.0 [-30.4, +42.3] | 6.21 / 5.96 |
| 1 | 2 | 10 s | 156 (stopped early) | -13.4 [-67.7, +41.0] | — |

Runs:
* `20261007T003146Z-sigil-r2m-k2-3s`
* `…T003157Z-…k4-3s`
* `…T003215Z-…k2-10s`
* `…T010007Z-…m1k2-3s`
* `…T010019Z-…m1k4-3s`
* `…T020003Z-…m1k2-10s`

Arena positions are saved under each run's `data/`.

**Why the merge lost.** Each part finishes a different depth in the time, and a Sigil root score is
not comparable across depths: an odd-depth score ends on the mover's own turn. Taking the best final
score therefore picks whichever part's depth flatters it. Merge mode 1 compares parts at the deepest
depth that every part completed, and then plays the winning part's final move. That recovers the
loss, but the result is still at parity.

**Why there is no gain even with a sound merge.** The split buys only about 0.15–0.25 ply (6.2 vs
6.0).
* Without a shared table or a shared alpha, each part searches its share of the root with a full
  window.
* The hash split scatters the best root moves across the parts, so the cutoffs a single
  ordered search gets from its first moves never cross parts.
* The native parallel root got its +44 from exactly the things option A lacks: the shared table and
  the shared alpha.

## Browser checks

**Headless Chromium** (playwright's chrome-headless-shell 1243 on this 8-core Chromebook VM, the
real `rust-worker.js` and the v25 wasm, 8 midgame positions, 2 s per move, `ttBits` 20):

| workers | startup to ready | total knps | knps per worker | merged depth (max part / min part) |
|---|---|---|---|---|
| 1 | 56 ms | 85 | 85 | 4.62 / 4.62 |
| 2 | 22 ms | 157 | 79 | 5.12 / 4.62 |
| 4 | 30 ms | 267 | 67 | 5.38 / 4.50 |

* Startup is with the wasm already in the HTTP cache; the first visit pays for one 1.1 MB download.
  Each further worker compiles from the cache.
* Memory (PSS of all Chromium processes) grows about 40 MB for the first worker and about 25–30 MB
  for each further one: its 16 MB table, its wasm instance and its heap.
* Throughput per worker falls 21% at 4 workers (shared caches and memory bandwidth).

**Smoke (`tools/wasm-smoke.js`).**
* It now plays the SHIPPED eval in every game. It reads `rust-ai.js`'s default, which mirrors
  `eval.rs SHIPPED_EVAL`, overridable with `SIGIL_SMOKE_EVAL`.
* Before this, every game searched with a literal `'tfit'`, so the v24 and v25 smoke gates verified
  the rules replay but never the eval the site ships.
* Its root-split section drives 2 or 4 engines (`SIGIL_SMOKE_SPLIT`, default 4) with the
  common-depth merge and per-depth progress. It replay-verifies 8 split moves, with whole-root
  ponders between them, and passes with v25.
* The old in-JS disjointness check is gone. A part whose hash range is empty searches the list's
  first turn, so several parts can report the same turn on small roots, for example at ply 0.

**Policy per worker.** The wasm applies `SHIPPED_POLICY` once per module, in `Engine::new` and
`judge_move` (`ensure_shipped_policy`). Each Web Worker loads its own module, so every worker plays
with the policy on.

## What changed on the branch

* `engine/src/py.rs`: `play_best(split_workers=, split_merge=)`, and `split_pick` (merge modes 0 and 1).
* `engine/src/search.rs`: `ThreadSwitches` is `pub(crate)`.
* `engine/harness/ab_search.py`: the `split` knob.
* `engine/gcp/arms/r2m_*.txt`: the arena arm files.
* `docs/static/scripts/engine/rust-ai.js`:
  * `pickSplitResult(results, perDepth)` compares parts at their common completed depth, from each
    worker's progress messages. Without `perDepth` it behaves as before.
  * The split path records the per-worker progress.
  * The device setting: `localStorage['sigil.rustWorkers'] = 'auto'` gives
    `recommendedRustWorkers = min(4, hardwareConcurrency - 1)`. It is read after `options.workers`
    and `window.SIGIL_RUST_WORKERS`; unset means one worker, the shipped behaviour.
* `docs/account.html`: the "Let the AI use more than one CPU core (this device)" card and its
  handler. The card is commented out, because the arenas show no gain.
  * It is device-level (localStorage), not a Firebase profile field. Core count is a property of
    the device, and this needs no database rules deploy.
* `tools/wasm-smoke.js`: as above.
* None of this changes what the site does by default. Before deploying, the `rust-ai.js` change
  still needs a `docs/sw.js` CACHE_VERSION bump.

## Recommendation

* **Do not enable option A.** Leave the device setting hidden and the default at one worker.
* The browser strength from extra cores needs what the native engine had: a shared table and a
  shared alpha. That means wasm threads (option B).
* A cheaper middle step would be option A with alpha shared through `postMessage`. It is not
  measured, and it would lose the cutoffs within an iteration, so it is not worth building first.

## Option B (wasm threads) risks

These are unchanged from `2026-10-step6.md` and still apply.
* `crossOriginIsolated` needs COOP and COEP headers. GitHub Pages cannot set them, so `docs/sw.js`
  would inject them (the coi-serviceworker pattern).
* The risks:
  * COOP `same-origin` breaks the Firebase `signInWithPopup` flow, so sign-in would move to
    redirect.
  * COEP `require-corp` blocks the Typekit, unpkg and font assets that do not send CORP.
    `credentialless` is not supported in Safari.
  * The Realtime Database long-poll fallback is a cross-origin script load.
  * The service worker becomes load-bearing. The first visit is not isolated, and a stale or
    failed worker silently drops isolation, so the engine must fall back to one thread.
* New with v25: each thread would need the shipped policy applied in its own thread-local state.
  `ensure_shipped_policy` covers that, as it does for `ThreadSwitches` natively.
* Only the game page needs isolation. The way to do it is to isolate `game.html` alone and keep
  sign-in on the other pages.

## Cost

About $14 (about 6.5 VM-hours), on on-demand c3d-highcpu-60 in us-east4:
* runs k2-3s, m1k2-3s and m1k4-3s at about 1.4–1.5 h each;
* the two mode-0 runs stopped early at about 0.5 h each;
* m1k2-10s at about 1.1 h, stopped early once the 3 s results settled the question.

All `sigil-r2m-*` VMs are deleted.
