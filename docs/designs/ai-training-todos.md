# AI Training Execution Todos & Handoff Playbook

*   **Document:** `docs/designs/ai-training-todos.md`
*   **Companion Design Doc:** [`docs/designs/superhuman-desktop-engine.md`](file:///storage/emulated/10/Documents/sigil/docs/designs/superhuman-desktop-engine.md)
*   **Target Engine Version:** v35 (Merged on `main` at `c41464f`) -> v36 (Retrained SNN2 weights)
*   **Date:** 2026-11-02
*   **Branch:** `ai-training-plan`

---

## 1. Executive Summary & What Is Already Done

All engine search, move ordering, leaf caching, repetition defense, and browser telemetry changes specified in Stage 1 and Stage 2 of the Superhuman Desktop Engine design have been implemented, verified, reviewed by Codex, and **merged to `main` in PR #57 (commit `c41464f`)**.

### Shipped in Engine v35 (`c41464f`)
1.  **Bank Branching Deduplication & Capping**:
    *   Bounded Cartesian product of moves and bank placements in [`engine/src/order.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/order.rs). Deduplicates board transpositions (`Move A + Place B == Move B + Place A`) and caps total bank first steps to $\le 60$.
2.  **`TurnIter` Stage Reordering**:
    *   Interior search nodes now transition `Moves -> MoveCast -> DashCast -> Dash` in [`engine/src/turn_iter.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/turn_iter.rs), eliminating the interior-node starvation of `move + dash + cast` tactics.
3.  **Spell-Preserving Dash Sacrifices**:
    *   [`Board::ordered_dash_branches_per`](file:///storage/emulated/10/Documents/sigil/engine/src/order.rs) prioritizes sacrifice pairs that preserve charged or newly chargeable spells on post-dash boards.
4.  **Threefold-Repetition Defense (Red) & Execution (Blue)**:
    *   Appends `key_dash_turns` in the `PolicyIter` branch of [`Search::ordered_turns_action_hint`](file:///storage/emulated/10/Documents/sigil/engine/src/search.rs).
    *   Added `promote_repetition_mate` prepass giving Blue instant mate-in-1 detection and Red 100% visibility into Blue 3rd-repetition refutations.
    *   Clears stale TT entries when `base_history` acquires $\ge 2$ repeated keys and fixes root double-counting in `spend_remaining`.
5.  **8-Slot Zero-Allocation `FoldRing` Cache & SNN2 Architecture**:
    *   Replaced 1-slot heap-allocating leaf cache with an 8-slot inline `FoldRing` in [`engine/src/nn.rs`](file:///storage/emulated/10/Documents/sigil/engine/src/nn.rs).
    *   Added `SNN2` binary format supporting 39 wall inputs and mover/opponent bank counts (`[2][4]`).
    *   Gated unused legacy nets (`NNUE_SPELL`, `NNUE_SPELL3`, `NNUE_SPELL4`) out of `wasm32` builds, shrinking multi-threaded WASM by ~500 KB.
6.  **Live Search Telemetry & Firebase Validation**:
    *   Browser exports `depth`, `seldepth`, `nodes`, `eval`, `threads`, `ponder`, and `tt_permille` to `aiTelemetry` on Firebase `completed_games`.
    *   Security rules in [`database.rules.json`](file:///storage/emulated/10/Documents/sigil/database.rules.json) validate schema.

---

## 2. Environment Setup on Another Computer

Follow these steps to set up the development, testing, and training environment on another Linux workstation or cloud instance:

### 2.1 Git & Branch
```bash
git clone git@github.com:robirahman/sigil.git
cd sigil
git checkout ai-training-plan
```

### 2.2 Toolchain Setup
1.  **Rust Nightly & Target**:
    ```bash
    rustup toolchain install nightly-2026-09-15 --component rust-src --target wasm32-unknown-unknown
    rustup target add wasm32-unknown-unknown
    ```
2.  **`wasm-bindgen-cli` (Must match 0.2.127)**:
    ```bash
    cargo install wasm-bindgen-cli --version 0.2.127 --locked
    ```
3.  **Python Virtualenv & Dependencies**:
    ```bash
    python3 -m venv .venv
    source .venv/bin/activate
    pip install torch numpy maturin
    maturin develop --release --manifest-path engine/Cargo.toml
    ```
4.  **Google Cloud SDK**:
    ```bash
    # Authenticate to the Sigil GCP project
    gcloud auth login robi@intelligence.org
    gcloud config set project focus-surfer-494820-g0
    gcloud auth application-default login
    ```

---

## 3. Google Cloud (GCP) Infrastructure Reference

*   **Project ID**: `focus-surfer-494820-g0`
*   **Active Account**: `robi@intelligence.org`
*   **Primary Region/Zone**: `us-central1-a` / `us-central1-f`
*   **Active Analysis VM**: `spar-analysis-0` (`c3-standard-8`, running in `us-central1-a`)
*   **Storage Buckets**:
    *   `gs://focus-surfer-494820-g0-sigil/`: Primary bucket for self-play shards, checkpoints, candidate `.bin` nets, and fleet logs.
    *   `gs://focus-surfer-494820-g0-sigilbench-private/`: Benchmark suites and golden evaluations.
    *   `gs://focus-surfer-494820-g0-telemetry/`: Raw telemetry exports.
*   **Fleet Orchestration Scripts**:
    *   [`engine/gcp/launch_s3_fleet.sh`](file:///storage/emulated/10/Documents/sigil/engine/gcp/launch_s3_fleet.sh): Launches Spot C3/C3D fleet.
    *   [`engine/gcp/launch.sh`](file:///storage/emulated/10/Documents/sigil/engine/gcp/launch.sh): Generic single-VM launcher.
    *   [`engine/gcp/collect.sh`](file:///storage/emulated/10/Documents/sigil/engine/gcp/collect.sh): Collects remote shards and logs from GCS.
    *   [`engine/gcp/teardown.sh`](file:///storage/emulated/10/Documents/sigil/engine/gcp/teardown.sh): Shuts down fleet instances.

---

## 4. Tactical Benchmark Fixtures

The repository includes captured tactical benchmark fixtures in [`engine/data/benchmarks/`](file:///storage/emulated/10/Documents/sigil/engine/data/benchmarks/) to verify engine tactical vision before and after neural network training:

1.  **`engine/data/benchmarks/gwsmf5_hydrated.json` & `gwsmf5_evals.json`**:
    *   **Context**: Game `GWSMF5` (human Red vs AI Blue).
    *   **Benchmark Position**: Turn 26 (`b 26`).
    *   **Requirement**: At search depth $\ge 5$ (or 10s think time), the engine MUST detect Red's threat (`b6, dash [sac c3, c5 -> b1, push a9], Flourish`) inside the ply-1 candidate window and MUST NOT play `b11, Charge, hard_move b6->b12`.
2.  **`engine/data/benchmarks/qjlgqr_room.json`**:
    *   **Context**: Game `QJLGQR` (AI Red vs human Blue).
    *   **Benchmark Position 1 (Turn 25 `r 25`)**: Red must recognize that `c9` allows Blue to play `c10->a4, dash(sac c3,c4)->c9` creating a 3rd-repetition terminal win. Red must choose a non-repeating winning continuation (`c8`) at depths 2–6.
    *   **Benchmark Position 2 (Turn 26 `b 26`)**: When playing as Blue, the engine must immediately execute `c10->a4, dash(sac c3,c4)->c9` with `mate_in == 1`.

---

## 5. Step-by-Step Execution Playbook

```text
+---------------------------------------------------------------------------------------+
| STEP 1: HUMAN SURPRISE AUDIT (STAGE 2 WRAP-UP)                                        |
| python engine/harness/deep_review.py -> extract surprise positions (delta <= -1.0)    |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| STEP 2: PHASE 3a - WALL & BANK PREP ON HISTORICAL CHUNKS                              |
| python engine/harness/nn_eval.py prep -> packed_snn2.npz                              |
| python engine/harness/nn_eval.py train --snn2 -> nnue_snn2_base.bin                   |
| node tools/nn-wasm-parity.js + 400-game arena match vs v34                            |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| STEP 3: PHASE 3b - ROUND 4 SELF-PLAY FLEET ON GCP                                     |
| ./engine/gcp/launch_s3_fleet.sh r4-fleet 60 c3d-highcpu-90 us-central1-f              |
| ./engine/gcp/collect.sh r4-fleet (generate >= 5,000 games)                            |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| STEP 4: PHASE 3b - POLICY RE-TRAINING                                                 |
| python engine/harness/policy_train.py extract -> assert primary drop rate < 1%        |
| python engine/harness/policy_train.py train -> engine/src/policy_weights.rs           |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| STEP 5: PHASE 3b - FINAL SNN2 VALUE NETWORK CO-TRAINING                               |
| Prep combined R1-R4 + 5x upsampled surprise corpus -> train SNN2 candidate net        |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| STEP 6: VERIFICATION, GATING & DEPLOYMENT                                             |
| 1. Parity: node tools/nn-wasm-parity.js                                               |
| 2. Benchmarks: GWSMF5 Turn 26 + QJLGQR Turn 25                                        |
| 3. Elo Gate: 400 games @ 2.5s/move >= +20 Elo (lower 95% CI > 0)                      |
| 4. Rebuild WASM: ./engine/build-wasm.sh && ./engine/build-wasm-mt.sh                   |
| 5. Sync Functions & Service Worker: copy-engine.js + sw.js bump                       |
+---------------------------------------------------------------------------------------+
```

---

### Step 1: Human-Game Telemetry & Surprise Audit

Audit post-Oct-7 human-vs-AI games in Firebase RTDB to catalog human surprise moves and AI blunders:

```bash
# 1. Run deep review across recent games using engine_eval(se)
python engine/harness/deep_review.py \
  --games-file engine/data/benchmarks/recent_games.json \
  --walk backward \
  --out-surprises surprise_positions.npz

# 2. Inspect surprise positions where delta_opp <= -1.0 or delta_ai <= -0.8
python -c "
import numpy as np
d = np.load('surprise_positions.npz')
print('Surprise positions extracted:', len(d['sfn']))
"
```

---

### Step 2: Phase 3a — Historical Wall/Bank Prep & SNN2 Baseline Training

Historical self-play chunks (`r1`, `r2`, `r3`) in `gs://focus-surfer-494820-g0-sigil/` already contain `sfn` strings with `'x'` wall markers and `pm:r:b` bank tokens:

```bash
# 1. Download existing self-play chunks if not already local
mkdir -p data/chunks
gcloud storage cp "gs://focus-surfer-494820-g0-sigil/chunks/r*.npz" data/chunks/

# 2. Extract wall and bank features using the updated prep routine
python engine/harness/nn_eval.py prep \
  --in-dir data/chunks \
  --out data/packed_snn2_r123.npz

# 3. Train baseline SNN2 value network (additive wall and bank rows)
python engine/harness/nn_eval.py train \
  --data data/packed_snn2_r123.npz \
  --snn2 \
  --hidden 256 \
  --epochs 20 \
  --lr 0.001 \
  --out engine/nets/nnue_snn2_base.bin

# 4. Verify bit-exact SIMD128 WASM parity against native
node tools/nn-wasm-parity.js --net engine/nets/nnue_snn2_base.bin

# 5. Run 400-game head-to-head arena match against v34 (nnue_mt256)
cargo run --release --bin arena -- \
  --games 400 \
  --time 2500 \
  --eval-a nnue_snn2_base \
  --eval-b nnue_mt256
```

---

### Step 3: Phase 3b — Round 4 Self-Play Generation Fleet on GCP

Generate $\ge 5,000$ games with the v35 engine so the policy and value networks learn post-fix tactics (`Stage::DashCast`, bank-placement bounds, threefold repetition):

```bash
# 1. Package and verify build for GCP
cd engine/gcp
./buildtest.sh

# 2. Launch fleet on Spot C3D/C3 instances
# Usage: ./launch_s3_fleet.sh <run_id> <num_workers> <machine_type> <zone>
./launch_s3_fleet.sh r4-fleet 60 c3d-highcpu-90 us-central1-f

# 3. Monitor and collect shards from GCS
./collect.sh r4-fleet

# 4. Once complete, tear down instances
./teardown.sh
cd ../..
```

---

### Step 4: Phase 3b — Policy Network Re-Training

Retrain policy weights on the newly generated self-play corpus:

```bash
# 1. Extract policy training examples with fail-fast drop rate check
python engine/harness/policy_train.py extract \
  --shards "engine/gcp/runs/r4-fleet/live/*.npz" \
  --out data/r4_policy_examples.npz

# 2. Train updated log-linear policy model
python engine/harness/policy_train.py train \
  --examples data/r4_policy_examples.npz \
  --out engine/src/policy_weights.rs

# 3. Re-run Cargo tests to verify policy test assertions pass
cargo test --release --lib --manifest-path engine/Cargo.toml
```

---

### Step 5: Phase 3b — Final SNN2 Co-Training

Retrain the SNN2 value network on the combined corpus (`r1`–`r4`) plus 5x upsampled human surprise positions:

```bash
# 1. Prep combined training dataset with upsampling
python engine/harness/nn_eval.py prep \
  --in-dir data/chunks \
  --extra-data surprise_positions.npz \
  --extra-weight 5 \
  --out data/packed_snn2_r4.npz

# 2. Train final SNN2 value model
python engine/harness/nn_eval.py train \
  --data data/packed_snn2_r4.npz \
  --snn2 \
  --hidden 256 \
  --epochs 25 \
  --lr 0.001 \
  --out engine/nets/nnue_snn2_r4.bin
```

---

### Step 6: Verification, Gating & Deployment

Before merging or publishing the new network weights:

1.  **Parity Gate**:
    ```bash
    node tools/nn-wasm-parity.js --net engine/nets/nnue_snn2_r4.bin
    ```
2.  **Tactical Benchmarks**:
    ```bash
    # GWSMF5 Turn 26 tactical parry benchmark
    python engine/harness/smoke_verify.py --benchmark gwsmf5 --depth 5

    # QJLGQR Turn 25 repetition avoidance & Turn 26 mate execution benchmark
    python engine/harness/smoke_verify.py --benchmark qjlgqr --depth 5
    ```
3.  **Arena Elo Gate ($\ge +20$ Elo vs v34)**:
    ```bash
    cargo run --release --bin arena -- \
      --games 400 \
      --time 2500 \
      --eval-a nnue_snn2_r4 \
      --eval-b nnue_mt256
    ```
    *Requirement*: Point estimate $\ge +20$ Elo with lower 95% confidence bound $> 0$.
4.  **Rebuild WASM Bundles**:
    ```bash
    ./engine/build-wasm.sh
    ./engine/build-wasm-mt.sh
    node functions/copy-engine.js
    ```
5.  **Bump Asset Cache Versions**:
    *   Bump `RUST_ENGINE_VERSION` to `36` in [`docs/static/scripts/engine/rust-ai.js`](file:///storage/emulated/10/Documents/sigil/docs/static/scripts/engine/rust-ai.js).
    *   Bump `CACHE_VERSION` in [`docs/sw.js`](file:///storage/emulated/10/Documents/sigil/docs/sw.js).
    *   Update `?v=36` query parameters in `docs/*.html`.
6.  **Full Test Suite**:
    ```bash
    cargo test --release --lib --manifest-path engine/Cargo.toml
    npm --prefix functions test
    node tools/wasm-smoke.js
    ```
7.  **Documentation Update**:
    *   Log Elo results and benchmark depths in [`engine/STATUS.md`](file:///storage/emulated/10/Documents/sigil/engine/STATUS.md) and [`engine/FINDINGS.md`](file:///storage/emulated/10/Documents/sigil/engine/FINDINGS.md).

---

## 6. Checklist for Handoff

- [x] Engine core fixes merged to `main` (commit `c41464f`).
- [x] Browser search telemetry verified and persisted to `aiTelemetry` on Firebase `completed_games`.
- [x] `SNN2` binary parser and accumulator support implemented in `engine/src/nn.rs`.
- [x] Tactical benchmark fixtures committed in `engine/data/benchmarks/`.
- [ ] Stage 2: Audit human surprise positions and export `surprise_positions.npz`.
- [ ] Phase 3a: Extract historical wall/bank features and train `nnue_snn2_base.bin`.
- [ ] Phase 3a: Run 400-game arena match for `nnue_snn2_base.bin` vs `nnue_mt256`.
- [ ] Phase 3b: Launch GCP self-play fleet for Round 4 (`r4-fleet`, $\ge 5,000$ games).
- [ ] Phase 3b: Retrain policy weights in `engine/src/policy_weights.rs`.
- [ ] Phase 3b: Retrain final SNN2 value net on R1-R4 + surprise positions (`nnue_snn2_r4.bin`).
- [ ] Verification: SIMD128 parity, `GWSMF5`, and `QJLGQR` tactical gates passed.
- [ ] Verification: Arena Elo gate ($\ge +20$ Elo) cleared.
- [ ] Deployment: WASM recompiled, Cloud Functions synced, Service Worker bumped, PR opened.
