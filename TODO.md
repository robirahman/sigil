# Active engineering to-do: AI training (engine v35 -> v36)

*   **Branch:** `ai-training-plan` (main dcf9a94 merged in on 2026-11-03)
*   **Updated:** 2026-11-03
*   **Live engine:** v35 (`RUST_ENGINE_VERSION = 35`). `main` is at service worker cache `v97`.
*   **Playbook with every command:** [`docs/designs/ai-training-todos.md`](docs/designs/ai-training-todos.md)
*   **Design:** [`docs/designs/superhuman-desktop-engine.md`](docs/designs/superhuman-desktop-engine.md). Its "Round 4" is **round 6** here; the real round 4 is the v29 data in `data/r4/`.

## Tasks

| # | Task | Depends on | Status |
|---|---|---|---|
| 0 | **Measure v35 before using it to generate data.** Arenas: v35 vs v34 (core + Dividend draws), and `min_width` 32 vs 96. Write and run the tactical gate (C1). | – | **done 2026-11-03:** v35 −24.3 Elo vs v34; `v35-fix` +28.0 vs v35, level with v34; applied to `ai-training-plan` (63d6c3d) |
| 1 | Human-game audit with `deep_review.py` (scan / flag / probe / report) over games since 2026-10-07. Keep the cases as a regression set. Relabel the whole games at depth 4 as training chunks. | – | **running** (segmented scan on 6 VMs since 07:33 UTC 11-03; probes and relabel follow) |
| 2 | Phase 3a: re-prep `nnue_mt256`'s exact corpus with walls and bank, train `snn2` and `ctrl` (hidden 128, cap 256), arenas on Fissure, Dividend and core draws | – | **done 2026-11-03: passes** (+20.3 [+5.6, +35.0] Fissure + Dividend, +5.8 core); `SHIPPED_EVAL = nnue_snn2_base` (7c01638) |
| 3 | r6 self-play: 16 Spot c3d-90, depth 4, about 300k games, `FIRST_VM=400` | 0 | todo: ready |
| 4 | Policy retrain on r6 (`r3_policy.sh`), then a policy arena | 3 | todo |
| 5 | Final value net `nnue_r6` (corpus + r6 + human chunks), then a net arena | 1, 3 | todo |
| 6 | Release gate: candidate vs live `main`. Core 2,160 games with lower bound > 0; Fissure and Dividend not negative; C1 passes | 4, 5 | todo |
| 7 | Release v36: wasm, version bumps from `main`'s values, tests, win-probability refit, PR. Robi deploys Functions. | 6 | todo |

Code: C1–C4 done (`tactical_gate.py`, SNN2 golden vectors with walls and banks, prep coverage line, `add_net_preset.py`). C5 (per-prefix sample weights) is optional and not written.
Also written for Step 1: `eval_games.py eval --segment` (segmented backward walk) and `AUDIT_ENGINE` for deep-review VMs (default `shipped`).

Open check: none. **T1** resolved 2026-11-03: `aiTelemetry` is arriving and the live rules accept it (they lack the repo's validation block).

## Rules that are easy to break

*   **`teardown.sh` deletes every `sigil-*` VM and disk.** Delete your own VMs by name instead.
*   **Never touch `spar-*` VMs** (including `spar-analysis-0`).
*   **Give each VM in a fleet its own `SHARD_BASE`.** Check `COMMIT.txt` and `COMPLETE` with `collect.sh`.
*   **Default arena draws are core-only.** Walls and bank stones appear only with `SIGIL_REQUIRE_SPELL` (39 Fissure; 42/43/44 bank spells).
*   **Arena size:** 400 games is about ±34 Elo and 2,160 games about ±15.
*   **No heavy local work on Cloud Shell** (about 360 MB free on `/home`). Training, prep, arenas and builds run on VMs.

## Tactical benchmark fixtures

*   [`engine/data/benchmarks/gwsmf5_hydrated.json`](engine/data/benchmarks/gwsmf5_hydrated.json) and [`gwsmf5_evals.json`](engine/data/benchmarks/gwsmf5_evals.json): game GWSMF5, Blue's turn 26 (`b 26`). Blue must parry Red's `b6, dash (sac c3,c5), Flourish`.
*   [`engine/data/benchmarks/qjlgqr_room.json`](engine/data/benchmarks/qjlgqr_room.json): game QJLGQR. On `r 25` Red must avoid the threefold-repetition loss; on `b 26` Blue must find mate in 1.
*   The cargo tests `test_gwsmf5_spell_preserving_dash` and `test_qjlgqr_threefold_repetition_mate` cover less than this: generator reachability, and `r 25` at depth 2 only. C1 adds the full check.

## Local quick-start

```bash
git clone https://github.com/robirahman/sigil.git && cd sigil && git checkout ai-training-plan
gcloud auth login robi@intelligence.org && gcloud config set project focus-surfer-494820-g0
export B=gs://focus-surfer-494820-g0-sigil
# Tests (on a machine with disk to spare):
cargo test --release --lib --manifest-path engine/Cargo.toml
npm --prefix functions test && node tools/wasm-smoke.js && node tools/nn-wasm-parity.js docs/static/wasm nnue_mt256
```

The wasm builds need `nightly-2026-09-15` with `rust-src`, `wasm-bindgen-cli` 0.2.127, and `CARGO_TARGET_DIR` unset.
