# Active Engineering TODOs & Campaign Roadmap

*   **Branch:** `ai-training-plan`
*   **Base Commit:** `c41464f` (Merge PR #57 on `main`)
*   **Updated:** 2026-11-02
*   **Current Engine Version:** v35 (`RUST_ENGINE_VERSION = 35`, Service Worker Cache `v89`)
*   **Detailed Playbook:** [`docs/designs/ai-training-todos.md`](file:///storage/emulated/10/Documents/sigil/docs/designs/ai-training-todos.md)
*   **Design Document:** [`docs/designs/superhuman-desktop-engine.md`](file:///storage/emulated/10/Documents/sigil/docs/designs/superhuman-desktop-engine.md)
*   **GCP Campaign Ledger:** [`engine/gcp/CAMPAIGN.md`](file:///storage/emulated/10/Documents/sigil/engine/gcp/CAMPAIGN.md)

---

## Quick-Start: Resuming on Another Machine

```bash
# 1. Clone & switch to active training branch
git clone git@github.com:robirahman/sigil.git
cd sigil
git checkout ai-training-plan

# 2. Set up Python venv with PyTorch & build native engine bindings
python3 -m venv .venv
source .venv/bin/activate
pip install torch numpy maturin
maturin develop --release --manifest-path engine/Cargo.toml

# 3. Authenticate with Google Cloud
gcloud auth login robi@intelligence.org
gcloud config set project focus-surfer-494820-g0
```

---

## Active Task Matrix

| ID | Task | Status | Target File / Script | Next Action |
|---|---|---|---|---|
| **ST1** | Stage 1 Pre-Training Engine Fixes | **COMPLETED (v35)** | [`engine/src/`](file:///storage/emulated/10/Documents/sigil/engine/src/) | Merged in PR #57 (bank cap, DashCast order, rep prepass, FoldRing, SNN2) |
| **ST2** | Stage 2 Live Search Telemetry | **COMPLETED (v35)** | [`game-board-local.js`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/game-board-local.js) | Merged in PR #57 (`aiTelemetry` validated in `database.rules.json`) |
| **AUD** | Stage 2 Human Game Surprise Audit | **PENDING** | [`engine/harness/deep_review.py`](file:///storage/emulated/10/Documents/sigil/engine/harness/deep_review.py) | Run deep review over Firebase games; export `surprise_positions.npz` |
| **P3a** | Phase 3a: Historical Wall/Bank Prep & SNN2 Baseline | **PENDING** | [`engine/harness/nn_eval.py`](file:///storage/emulated/10/Documents/sigil/engine/harness/nn_eval.py) | Run `prep` on R1-R3 chunks, train `nnue_snn2_base.bin`, test SIMD128 parity |
| **P3b-1** | Phase 3b: Round 4 Self-Play Fleet Launch | **PENDING** | [`engine/gcp/launch_s3_fleet.sh`](file:///storage/emulated/10/Documents/sigil/engine/gcp/launch_s3_fleet.sh) | Launch 60-worker C3D fleet for >= 5,000 games on v35 engine |
| **P3b-2** | Phase 3b: Policy Retraining | **PENDING** | [`engine/harness/policy_train.py`](file:///storage/emulated/10/Documents/sigil/engine/harness/policy_train.py) | Extract with drop-rate check (< 1%); update `engine/src/policy_weights.rs` |
| **P3b-3** | Phase 3b: Final SNN2 Co-Training | **PENDING** | [`engine/harness/nn_eval.py`](file:///storage/emulated/10/Documents/sigil/engine/harness/nn_eval.py) | Train on R1-R4 + 5x upsampled surprises; export `nnue_snn2_r4.bin` |
| **GATE** | Verification & Arena Elo Gate | **PENDING** | [`tools/nn-wasm-parity.js`](file:///storage/emulated/10/Documents/sigil/tools/nn-wasm-parity.js) | 400-game match @ 2.5s/move vs v34 (>= +20 Elo); GWSMF5/QJLGQR benchmarks |
| **DEP** | WASM Rebuild & Release Deploy | **PENDING** | [`docs/static/wasm/`](file:///storage/emulated/10/Documents/sigil/docs/static/wasm/) | Bump to v36, rebuild WASM, bump Service Worker cache, open PR |

---

## Tactical Benchmark Suite

Benchmark fixtures are preserved in the repository so regression checks run identically on any machine:
*   [`engine/data/benchmarks/gwsmf5_hydrated.json`](file:///storage/emulated/10/Documents/sigil/engine/data/benchmarks/gwsmf5_hydrated.json): `GWSMF5` Turn 26 (`b 26`) parry of Red's `dash + Flourish`.
*   [`engine/data/benchmarks/gwsmf5_evals.json`](file:///storage/emulated/10/Documents/sigil/engine/data/benchmarks/gwsmf5_evals.json): Server 1s reference evaluations.
*   [`engine/data/benchmarks/qjlgqr_room.json`](file:///storage/emulated/10/Documents/sigil/engine/data/benchmarks/qjlgqr_room.json): `QJLGQR` Turn 25 (`r 25`) repetition avoidance and Turn 26 (`b 26`) mate execution.

---

## Command Reference Cheat-Sheet

```bash
# Run unit & parity tests locally
cargo test --release --lib --manifest-path engine/Cargo.toml
npm --prefix functions test
node tools/wasm-smoke.js
node tools/nn-wasm-parity.js

# Launch Round 4 GCP Fleet (Engine v35)
cd engine/gcp
./buildtest.sh
./launch_s3_fleet.sh r4-fleet 60 c3d-highcpu-90 us-central1-f
./collect.sh r4-fleet
./teardown.sh

# Run head-to-head arena Elo match (400 games, 2.5s/move)
cargo run --release --bin arena -- --games 400 --time 2500 --eval-a nnue_snn2_r4 --eval-b nnue_mt256
```

See [`docs/designs/ai-training-todos.md`](file:///storage/emulated/10/Documents/sigil/docs/designs/ai-training-todos.md) for full documentation and command explanations.
