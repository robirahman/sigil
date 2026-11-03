# AI training plan: engine v35 -> v36 (playbook and to-do list)

*   **Updated:** 2026-11-03. This replaces the 2026-11-02 version.
*   **Branch:** `ai-training-plan`, with `main` (dcf9a94) merged in.
*   **Live engine:** v35 (`RUST_ENGINE_VERSION = 35`). `main` is at service worker cache `v97`.
*   **Design doc:** [`superhuman-desktop-engine.md`](superhuman-desktop-engine.md). Its "Round 4" is called **round 6** here (see Naming).
*   **Quick task table:** [`TODO.md`](../../TODO.md)

## What changed from the 2026-11-02 version

The earlier version had problems, found by checking it against the scripts and the bucket. All of them are fixed below.

1.  **v35 shipped without a strength measurement.** PR #57 also lowered `SHIPPED_POLICY`'s `min_width` from 96 to 32. The 2026-10 policy sweep ([`engine/reports/2026-10-step4.md`](../../engine/reports/2026-10-step4.md)) measured `min_width` 40 at +57.8 against +99.1 for 96 (3 s, tfit, each against policy off), and 40 made each node about 2x as expensive. Self-play data inherits whatever `SHIPPED_POLICY` says, so **Step 0 now measures v35 before any data is generated with it.**
2.  **"Round 4" already existed.** Round 4 is the v29 self-play from 2026-10-11 (635,169 games, `runs/*-sigil-r4d-*`, `data/r4/`). Round 5 is the human-game and v31 data in `data/r5/`. Both are already in `nnue_mt256`'s training data. The new self-play round is **r6**. The earlier target of 5,000 games was about 1% of round 4. r6 is sized like round 4 (Step 3).
3.  **Most commands did not match the scripts.** The real signatures are now used throughout: `launch_s3_fleet.sh <depth> <stop_s> <max_h> <zone>:<count>[:<machine>]`, `launch.sh`, `launch_nn.sh`, `launch_deep_review.sh` and `r3_policy.sh`.
    *   There is no `cargo --bin arena`. Arenas run `engine/harness/ab_version.py` or `ab_search.py` through `launch.sh`, pooled with `pool_shards.py`.
    *   `nn_eval.py` and `policy_train.py` take positional arguments.
    *   `gs://…-sigil/chunks/` does not exist.
    *   `smoke_verify.py --benchmark` does not exist. The tactical gate needs a new script (code to-do C1).
    *   `nn-wasm-parity.js` takes `[wasm_dir] [preset]`, not `--net`.
4.  **`nnue_mt256` has hidden size 128.** The "256" is the output cap (`SNN1` header: H=128, L2=32, L3=32, cap=256). The earlier `--hidden 256` would have trained a different, wider net. A 256-wide net measured parity and 512 measured −25.8 Elo (2026-10-12).
5.  **Upweighting surprise positions 5x had no code and would do little.** A few hundred positions, even at 5x, are under 0.01% of a 27M-row corpus. Instead, the audit's cases become a **test set**, and the audited **whole human games** are relabelled and added as training data, as `data/r5/human_e9` was.
6.  **Arena draws are core-only by default.** Fissure walls (spell 39) and Providence bank stones (Dividend 42, Annuity 43, Endowment 44) never occur unless `SIGIL_REQUIRE_SPELL` is set. The v35 bank changes and the SNN2 wall and bank inputs are invisible to a default arena, so every gate now includes targeted draws.
7.  **400 games cannot resolve +20 Elo.** At 400 games the 95% interval is about ±34 Elo, so "+20 with lower bound > 0" could only pass at +34 or more. Arenas here use 2,160 games on core draws (about ±15) and 1,080 on targeted draws (about ±21).
8.  **Tactical claims were stronger than the tests.**
    *   `test_gwsmf5_spell_preserving_dash` checks only the turn generator at Red's turn 27. Blue's turn-26 decision is never searched.
    *   `test_qjlgqr_threefold_repetition_mate` checks Red's turn 25 at depth 2 only, not depths 2–6.
9.  **Infrastructure hazards.**
    *   `teardown.sh` deletes every `sigil-*` VM and disk in the project.
    *   `spar-*` VMs (including `spar-analysis-0`) belong to other work and must not be used.
    *   Cloud Shell's `/home` is 4.8 GB, so nothing heavy runs locally.
10. **Deploy steps were missing.**
    *   Bump `CACHE_VERSION` from `main`'s current value, not v89.
    *   Refit the position win-probability curve when `SHIPPED_EVAL` changes.
    *   Robi has to run the Firebase Functions deploy.
11. **Links pointed at a phone path** (`file:///storage/emulated/10/...`). They are now relative.

## Naming and constants

| thing | value |
|---|---|
| self-play rounds | r2 (v25), r3 (v27), r4 (v29, 635,169 games), r5 (human_e9 + v31 self-play). New: **r6** (v35) |
| r6 VM prefix and shards | `sigil-r6d-400..415`, `FIRST_VM=400`, so `SHARD_BASE` runs 80,000–83,000. Seeds start at 100,000,000, past round 4's 80M–83.2M |
| shipped net | `nnue_mt256` = `--base mtempo --hidden 128 --cap 256 --lam 0.5 --qat 2`, 8 epochs, game split, held-out outcome ll 0.58115 (run `20261020T010106Z-sigil-es-train256`) |
| its corpus | [`engine/gcp/data_lists/es_mt256.txt`](../../engine/gcp/data_lists/es_mt256.txt): 20 prefixes, 27,010,137 positions, 1,268,971 games |
| candidate presets | `nnue_snn2_base` (Step 2) and `nnue_r6` (Step 5) |
| draw filters | Fissure `SIGIL_REQUIRE_SPELL=39`, Dividend `=42` (also 43 Annuity, 44 Endowment), Rock Slide `=40` |
| bucket | `gs://focus-surfer-494820-g0-sigil` (`B` below) |

## Ground rules

*   **Never run `teardown.sh` while any other `sigil-*` VM is up.** It deletes all of them. Delete your own VMs by name, after checking `gcloud compute instances list --filter='name~^sigil-'`.
*   **Never touch `spar-*` VMs.** They belong to other work.
*   **Every VM in a fleet gets its own `SHARD_BASE`.** Keep games per shard under 1000.
*   **Confirm each run with `collect.sh`.** Check `COMMIT.txt` (is it the commit you meant?) and the `COMPLETE` marker (a partial run looks exactly like a finished one).
*   **Arena shape:** Spot `c3d-highcpu-90`, 45 workers (one per physical core), 6 colour-swapped pairs per worker, so 540 games per VM.
    *   Use 4 VMs for core draws and 2 VMs per targeted draw.
    *   Keep at most 5 `c3d-highcpu-90` per region (`CPUS_PER_VM_FAMILY` = 500).
    *   Pool the logs with `pool_shards.py`, never from per-shard summaries.
    *   Send a push notification when an arena finishes.
*   **Measure throughput before scaling up.** Read games per shard-hour from the live logs after about 30 minutes.
*   **Run heavy work on VMs.** Cloud Shell has about 360 MB free on `/home`. Locally you need only `gcloud`, `gh`, `python3` with numpy, and the Firebase service account for downloads.
*   **Use Spot pricing.** `c3d-highcpu-90` costs about $0.82/h in us-central1, us-east1 and us-west1, about $1.60/h in us-east4, and about $2.12/h in europe-west4. Cost figures below are rough.
*   **Command blocks:** each one starts from the repo root and assumes `export B=gs://focus-surfer-494820-g0-sigil`. The zones shown are examples; any zone that offers `c3d` works, within the per-region limit (`us-west1-b` does not offer it; `us-west1-a` was stocked out on 2026-11-03).

## To-do list

Steps 0, 1 and 2 are independent and can run in parallel. Step 3 waits for Step 0's verdict. Step 5 needs Steps 1 and 3. Step 6 needs Steps 4 and 5.

| # | Task | Depends on | Rough cost | Status |
|---|---|---|---|---|
| 0 | Measure v35: v35 vs v34 (core + Dividend draws), `min_width` 32 vs 96, tactical gate | – | ~$20 | **running** (arenas launched 2026-11-03 03:37 UTC, runs in `data/r6/step0_runs.txt`); tactical gate run: 9/12 (see below) |
| 1 | Human-game audit (deep_review scan/flag/probe/report) and relabelled human chunks | – | ~$35 | **running** (529 games / 15,002 positions since 10-07; scan runs in `data/deep_review/scan_runs_2026-11.txt`) |
| 2 | Phase 3a: re-prep `nnue_mt256`'s corpus with walls/bank, train `snn2` + `ctrl`, arenas | – | ~$20 | **running** (prep run in `data/r6/prep_run.txt`) |
| 3 | r6 self-play on the corrected v35 (16 Spot c3d-90, depth 4, ~300k games) | 0 (and 2, optionally) | ~$80 | **todo** |
| 4 | Policy retrain on r6 (`r3_policy.sh`), policy arena | 3 | ~$15 | **todo** |
| 5 | Final value net `nnue_r6` on corpus + r6 + human chunks, net arena | 1, 3 | ~$20 | **todo** |
| 6 | Release gate: candidate vs live `main` (core + Fissure + Dividend), tactical gate, human regression set | 4, 5 | ~$20 | **todo** |
| 7 | Release v36: wasm, versions, tests, win-probability refit, PR, functions deploy | 6 | ~$80 (refit) | **todo** |

Code that does not exist yet:

| id | What | Needed by |
|---|---|---|
| C1 | **Done** (d5e979a): `engine/harness/tactical_gate.py` + `engine/data/benchmarks/qjlgqr_hydrated.json`. G1 = Red's search after Blue's GWSMF5 blunder values the position within 0.5 stones of the recorded refutation; G2 = Blue does not replay the blunder (depth 5, 10 s); Q1 = no 3rd-repetition loss at QJLGQR `r 25` (depths 2–6, 10 s); Q2 = mate in 1 at `b 26` | 0, 6 |
| C2 | **Done** (d5e979a): `nn_eval.py golden --n-feature 32` adds walled and banked positions for SNN2 nets | 2, 5 |
| C3 | **Done** (7ea0404): `nn_eval.py prep` prints a `COVERAGE` line | 2 |
| C4 | **Done** (d5e979a): `engine/harness/add_net_preset.py <name> <net.bin> <golden.txt> --doc ... [--wasm]`; self-tested (199/199 cargo tests) | 2, 5 |
| C5 | *(Optional, only if upweighting human data is still wanted.)* A per-prefix sample weight in prep or train, keeping copies of a game on one side of the game split | 5 |

Open check (now resolved):

| id | What |
|---|---|
| T1 | **Checked 2026-11-03: telemetry is arriving.** Every Rust-AI game since 2026-11-01 03:35 UTC carries `aiTelemetry` (55 of 55 in the last 80 records; schema `v: 1`, `engineVersion: 35`, `byPly` stored by Firebase as an array indexed by turn number). The **live** rules do not contain the repo's `aiTelemetry` validation block, but the live `completed_games/$gameId` rule has no catch-all `$other` rule, so the field is accepted unvalidated. Deploying the repo rules would add the validation. |

---

### Step 0: Measure what v35 shipped

**Tactical gate on v35 (2026-11-03, `tactical_gate.py`, single thread, 9/12):**
*   QJLGQR: all pass. At `r 25`, depths 2–6 and 10 s, Red never allows the 3rd repetition. At `b 26`, Blue finds the mate in 1. The repetition fixes work.
*   GWSMF5 G2 passes: Blue does not replay `b11, Charge` at depth 5 or at 10 s (10 s reaches only depth 3 single-threaded).
*   **GWSMF5 G1 fails at depths 3, 4 and 5.** After Blue's blunder, Red's own search values the position at +0.52 / +1.07 / +0.52 stones, while the recorded refutation is worth +2.84 to +2.88. So v35 still does not see Red's `dash + Flourish`.
    *   The dash itself is generated.
    *   The missing piece is the **Flourish resolution**. `rank_of_result_budget` finds the exact turn only with a cast-outcome window of 4,096 (rank 31k–102k), not at 24, 64, 128 or 512.
    *   This is the "cast resolution" generator gap from the 2026-09-26 surprise audit, and v35 did not touch it.

Do this first: r6 self-play plays with whatever `SHIPPED_POLICY` and `SHIPPED_EVAL` say.

**0.1 Make the base branches** (each is one push):
```bash
git push origin 9432b1c:refs/heads/base-v34     # main just before PR #57: engine v34
git checkout -b base-v35-pol96 origin/ai-training-plan
#   engine/src/policy.rs: SHIPPED_POLICY (true, 32) -> (true, 96)
git commit -am "Arena base: v35 with SHIPPED_POLICY min_width 96" && git push origin base-v35-pol96
```

**0.2 Run the arenas.** These are release A/Bs: `ab_version.py` has each side play its own shipped config, at 10 s per move.
```bash
cd engine/gcp
# A: v35 vs v34, core draws (4 VMs, 2,160 games)
for i in 0 1 2 3; do SPOT=1 BRANCH=ai-training-plan BASE_BRANCH=base-v34 SHARD_BASE=$((i*100)) \
  ./launch.sh sigil-v35ab-$i ab_version.py arms/release_ab_10s.txt "1,300" 45 us-central1-f 4 c3d-highcpu-90; done
# A-bank: same, Dividend draws, where the bank-step cap acts (2 VMs, 1,080 games)
for i in 0 1; do SPOT=1 BRANCH=ai-training-plan BASE_BRANCH=base-v34 SIGIL_REQUIRE_SPELL=42 SHARD_BASE=$((i*100)) \
  ./launch.sh sigil-v35abk-$i ab_version.py arms/release_ab_10s.txt "1,300" 45 us-west1-c 4 c3d-highcpu-90; done
# B: v35 (min_width 32) vs v35 with 96, core draws (4 VMs)
for i in 0 1 2 3; do SPOT=1 BRANCH=ai-training-plan BASE_BRANCH=base-v35-pol96 SHARD_BASE=$((i*100)) \
  ./launch.sh sigil-pol32-$i ab_version.py arms/release_ab_10s.txt "1,300" 45 us-east1-b 4 c3d-highcpu-90; done
# collect each run id printed above, then pool one arena at a time:
./collect.sh <run-id> runs/v35ab/<run-id>    # for each VM of the arena
python3 ../harness/pool_shards.py 'runs/v35ab/*/arm*.log'
```

**0.3 Decide:**
*   **If B favours 96** (lower bound > 0): set `SHIPPED_POLICY` back to `(true, 96)` on `ai-training-plan` before Step 3. Ship it to the site with v36, or sooner as a hotfix.
*   **If A is negative on core or on Dividend draws:** find the cause before generating any data.
    *   B isolates `min_width`.
    *   If Dividend draws are the problem, the bank-step cap (`order.rs`, at most 4 placements per move) is the suspect.

**0.4 Tactical gate:** write C1, then run it against v35. Record what it actually shows in `engine/STATUS.md`. The 2026-11-02 claim "verified across depths 2..6" is not backed by the tests.

### Step 1: Human-game audit and human training chunks

**1.0** Resolve T1 (telemetry is arriving, and the live rules allow it).

**1.1 Corpus (local):**
```bash
python3 engine/harness/eval_games.py download --since 2026-10-07 \
  --service-account "$HOME/firebase service account.json" --out raw_2026-11.json
python3 engine/harness/eval_games.py hydrate --raw raw_2026-11.json --out lines_2026-11.json
gcloud storage cp lines_2026-11.json $B/data/deep_review/lines_2026-11.json
```

**1.2 Scan:** every position at depth 6, each game walked backwards. Use one VM per shard, Spot.
```bash
cd engine/gcp
for k in 0 1 2; do MODE=scan CORPUS=data/deep_review/lines_2026-11.json DEPTH=6 BRANCH=ai-training-plan \
  SHARD=$k/3 ./launch_deep_review.sh sigil-deep-s$k c3d-highcpu-90 us-central1-f 8; done
```

**1.3 Flag, probe, report:**
```bash
for r in <the three scan run ids>; do gcloud storage cat $B/runs/$r/live/scan.jsonl; done > scan_2026-11.jsonl
python3 engine/harness/deep_review.py flag --lines lines_2026-11.json --evals scan_2026-11.jsonl --out cases_2026-11.json
gcloud storage cp cases_2026-11.json $B/data/deep_review/cases_2026-11.json
for k in 0 1 2; do MODE=probe CORPUS=data/deep_review/lines_2026-11.json CASES=data/deep_review/cases_2026-11.json \
  DEPTH=8 TIME_MS=1800000 BRANCH=ai-training-plan SHARD=$k/3 \
  ./engine/gcp/launch_deep_review.sh sigil-deep-p$k c3d-highcpu-90 us-east1-b 6; done
for r in <the three probe run ids>; do gcloud storage cat $B/runs/$r/live/probes.jsonl; done > probes_2026-11.jsonl
python3 engine/harness/deep_review.py report --lines lines_2026-11.json --evals scan_2026-11.jsonl \
  --cases cases_2026-11.json --probes probes_2026-11.jsonl --md deep_review_2026-11.md --json deep_review_2026-11.json
```

**Outputs:**
*   The report, written up in `engine/FINDINGS.md`. Split it by `aiTelemetry.v` where present.
*   `cases_2026-11.json`, the **human regression set** used in Step 6.

**1.4 Human training chunks.** This replaces the earlier "surprise_positions.npz x5". Write the audited whole games in the chunk format, then relabel them at depth 4, as `data/r5/human_e9/d4_v2` was (run `20261014T180204Z-sigil-r5-hrel2`):
```bash
python3 engine/harness/human_evals_to_chunks.py lines_2026-11.json human_2026-11/ scan_2026-11.jsonl --depth 6
gcloud storage cp human_2026-11/*.npz $B/data/r6/human_2026-11/scan/
{ echo '# shard_base=9000'; gcloud storage ls "$B/data/r6/human_2026-11/scan/*.npz"; } > relabel_list.txt
gcloud storage cp relabel_list.txt $B/data/r6/human_2026-11/relabel_list.txt
printf '%s' "$B/data/r6/human_2026-11/relabel_list.txt,4,/opt/sigil/out/data,88" > /tmp/arms_hrel.txt
cd engine/gcp && SHARD_BASE=9000 BRANCH=ai-training-plan ./launch.sh sigil-r6-hrel relabel_depth.py /tmp/arms_hrel.txt \
  "$B/data/r6/human_2026-11/relabel_list.txt,4,/opt/sigil/out/smoke,88" 88 us-central1-f 3 c3d-highcpu-90
# then copy runs/<run-id>/data/*.npz -> $B/data/r6/human_2026-11/d4/
```

### Step 2: Phase 3a, wall and bank inputs on the existing corpus

The question here: on the same data and recipe, do the SNN2 wall and bank rows help?

**2.1 Re-prep `nnue_mt256`'s exact corpus** with the new prep, on a CPU VM:
```bash
cd engine/gcp
DATA="$(grep -v '^#' data_lists/es_mt256.txt | tr '\n' ' ')"
echo prep-only > /tmp/jobs_prep.txt
BRANCH=ai-training-plan DATA="$DATA" PREP=$B/data/r6/prep_es_snn2.npz EVALS=mtempo,tfit_spell_v2,nnue_spell4 \
  DROP_SPELLS=40 DROP_BEFORE=80000000 JOBS_FILE=/tmp/jobs_prep.txt GPU=0 DEVICE=cpu \
  ./launch_nn.sh sigil-r6-prep us-central1-f 4 c3d-highcpu-90
```

Check the log line `WROTE … N positions from M chunks, G games`. It must read **27,010,137 positions from 132,565 chunks, 1,268,971 games**, as the original prep did. If not, the data list or the drop flags differ. The drop flags come from the 2026-10-19 notes; the prep log does not record them.

With C3 in place, the log also shows wall and bank coverage. If either is near zero, stop: SNN2 cannot learn those rows from this corpus.

**2.2 Train two arms on that prep** (A100, about 3 minutes each, as in 2026-10). `/tmp/jobs_3a.txt` holds:
```text
snn2 --lam 0.5 --base mtempo --hidden 128 --cap 256 --qat 2 --snn2
ctrl --lam 0.5 --base mtempo --hidden 128 --cap 256 --qat 2
```
Launch it:
```bash
cd engine/gcp && PREP=$B/data/r6/prep_es_snn2.npz DATA=unused EVALS=mtempo BRANCH=ai-training-plan EPOCHS=8 \
  JOBS_FILE=/tmp/jobs_3a.txt ./launch_nn.sh sigil-r6-train3a us-central1-c 6 a2-highgpu-1g
```
*   `ctrl` should reproduce about 0.5812 held-out outcome ll; if it doesn't, something changed.
*   Compare `snn2` with `ctrl` in `out/<tag>/result.json`.
*   If `us-central1-c` has no A100s, try other zones: the 2026-10 chain script looped through `us-central1-a/b/f`, `us-east1-b`, `us-west1-b` and `europe-west4-a`.

**2.3 Bake the preset:** C4 with C2 for `nnue_snn2_base`, from `runs/<id>/out/snn2/net.bin`:
```bash
python3 engine/harness/nn_eval.py golden engine/nets/nnue_snn2_base.bin <local copy of prep_es_snn2.npz> \
  engine/nets/nnue_snn2_base_golden.txt --n 128
cargo test --release --lib --manifest-path engine/Cargo.toml   # on a VM if Cloud Shell disk is short
```

**2.4 Arenas.** These are net-only A/Bs: `ab_search.py` with `SIGIL_AB_BASE=shipped`, 10 s per move.
```bash
cd engine/gcp
for i in 0 1; do SPOT=1 BRANCH=ai-training-plan SIGIL_AB_BASE=shipped SIGIL_REQUIRE_SPELL=39 SHARD_BASE=$((i*100)) \
  ./launch.sh sigil-snn2f-$i ab_search.py arms/snn2_base_10s.txt "1,200,nnue_snn2_base:nnue_mt256,preset,1,0" 45 us-central1-f 4 c3d-highcpu-90; done
for i in 0 1; do SPOT=1 BRANCH=ai-training-plan SIGIL_AB_BASE=shipped SIGIL_REQUIRE_SPELL=42 SHARD_BASE=$((i*100)) \
  ./launch.sh sigil-snn2k-$i ab_search.py arms/snn2_base_10s.txt "1,200,nnue_snn2_base:nnue_mt256,preset,1,0" 45 us-west1-c 4 c3d-highcpu-90; done
for i in 0 1 2 3; do SPOT=1 BRANCH=ai-training-plan SIGIL_AB_BASE=shipped SHARD_BASE=$((i*100)) \
  ./launch.sh sigil-snn2c-$i ab_search.py arms/snn2_base_10s.txt "1,200,nnue_snn2_base:nnue_mt256,preset,1,0" 45 us-east1-b 4 c3d-highcpu-90; done
```

**Pass if** the pooled Fissure and Dividend arenas have a lower bound > 0, and core draws show no regression (interval not entirely below 0). Core draws contain no walls or banks, so they can only show harm, not benefit.

If it passes, set `SHIPPED_EVAL = "nnue_snn2_base"` on `ai-training-plan` so r6 self-play uses it. If Step 3 has to start before this verdict, r6 runs on `nnue_mt256`; that is fine.

### Step 3: r6 self-play (Phase 3b data)

**Before launching:**
*   Step 0's verdict is applied (`SHIPPED_POLICY`).
*   `SHIPPED_EVAL` is decided.
*   The branch is pushed.
*   `launch_s3_fleet.sh` defaults to the old `train-s3-data-v2` branch, so always pass `BRANCH`.

```bash
cd engine/gcp
BRANCH=ai-training-plan VM_PREFIX=sigil-r6d FIRST_VM=400 COMP_FRAC=0.67 \
LINES_GS=$B/data/s3/human_starts_2026-10-07.json \
  ./launch_s3_fleet.sh 4 18000 6 us-central1-f:4 us-east1-b:4 us-west1-c:4 northamerica-south1-a:4
```

*   **Size:** 16 Spot VMs x 90 shards, depth 4 (round 5's label-depth test found depth 4 as good as 5 or 6), a 5 h stop and a 6 h watchdog. At round 4's rate (~44 games per shard-hour) that is about 300k games, roughly 7M positions.
*   **Check the rate after 30 minutes** and adjust if it is off.
*   **Draws:** with no spell schedule, half the fresh draws come from all 45 spells, so walls and banks do appear. The competitive variant stays a 67% majority (Robi's 2026-10-07 policy).
*   **Afterwards:**
    *   `collect.sh` each run and count the `COMPLETE` markers.
    *   Check that game ids are unique across r6 and every prefix in `es_mt256.txt` before any prep.
    *   Delete the VMs by name.

### Step 4: Policy retrain (Phase 3b)

`r3_policy.sh` already does the whole job:
*   extracts examples, aborting if more than 1% of primary-window targets drop;
*   trains two warm starts from the shipped weights;
*   gates them with `gate0` on held-out chunks and with the guest suite.

```bash
gcloud compute instances create sigil-r6-policy --project=focus-surfer-494820-g0 --zone=us-central1-f \
  --machine-type=c3d-highcpu-90 --boot-disk-size=50GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
  --image-family=debian-12 --image-project=debian-cloud \
  --scopes=https://www.googleapis.com/auth/devstorage.read_write --labels=project=sigil \
  --metadata="run-id=$(date -u +%Y%m%dT%H%M%SZ)-sigil-r6-policy,branch=ai-training-plan,max-hours=5,data=<r6 run data prefix>|1500|60" \
  --metadata-from-file=startup-script=engine/gcp/r3_policy.sh
```
*   **Defaults:** `xbetter` 1, `wargs` `--w-cast 2 --w-dashcast 3 --w-nondef 2 --w-xb 4`, `comp-share` 0.6.
*   **`data`:** `;`-separated entries of the form `prefix|ntrain|ngate`, one per r6 run's `data/` prefix.

**Arena** for the winning weights. Commit the `.npy` (the path is repo-relative), then:
```bash
cd engine/gcp
for i in 0 1 2 3; do SPOT=1 BRANCH=ai-training-plan SIGIL_AB_BASE=shipped SIGIL_POLICY_WEIGHTS=<repo-relative .npy> SHARD_BASE=$((i*100)) \
  ./launch.sh sigil-r6pol-$i ab_search.py arms/r6_policy_10s.txt "1,200,nnue_mt256,policy_weights,1,0" 45 us-central1-f 4 c3d-highcpu-90; done
```
*   If Step 2 shipped `nnue_snn2_base`, edit the eval in the arm and the smoke string.
*   Keep the weights only if the lower bound is > 0. Then run `python3 engine/harness/policy_train.py export <weights.npy>` to write `engine/src/policy_weights.rs`, and run `cargo test`.

### Step 5: Final value net (Phase 3b)

**Prep:** use the `es_mt256.txt` prefixes plus the r6 run `data/` prefixes plus `$B/data/r6/human_2026-11/d4`. Write it to `PREP=$B/data/r6/prep_r6.npz`, with the same flags as 2.1.

**Train:** one job, `r6 --lam 0.5 --base mtempo --hidden 128 --cap 256 --qat 2`, adding `--snn2` if Step 2 passed.

**Bake** `nnue_r6` (C4 + C2), then run the net-only arena: core x4, Fissure x2, Dividend x2, with `arms/r6_net_10s.txt` and the same launch pattern as 2.4.

Held-out log-loss is only a sanity check here. Adding data changes the test split, so the arena is the measure.

### Step 6: Release gate

The candidate branch carries Step 0's `SHIPPED_POLICY`, Step 4's weights, and `SHIPPED_EVAL = "nnue_r6"`. Gate it against the **live engine**:
```bash
cd engine/gcp
for i in 0 1 2 3; do SPOT=1 BRANCH=<candidate> BASE_BRANCH=main SHARD_BASE=$((i*100)) \
  ./launch.sh sigil-v36ab-$i ab_version.py arms/release_ab_10s.txt "1,300" 45 us-central1-f 4 c3d-highcpu-90; done
# plus SIGIL_REQUIRE_SPELL=39 x2 and =42 x2, as in Step 0
```

**Ship if:**
*   the core interval's lower bound is > 0;
*   Fissure and Dividend draws are not significantly negative;
*   C1 passes.

The 2026-11-02 bar was +20 Elo with lower bound > 0. With 2,160 games a +20 point estimate gives a lower bound near +5, so that stricter bar is now testable if you want it.

Also re-probe the Step 1 regression set (`deep_review.py probe` on the candidate) and report how many confirmed cases it now sees compared with v35. Report it alongside the arena; it is not a hard gate.

### Step 7: Release v36

1.  **Merge `main` into the release branch first.** Take `main`'s values for the monotonic counters.
2.  **Rebuild the engine for the browser and Functions.**
    *   Run `./engine/build-wasm.sh && ./engine/build-wasm-mt.sh` with `CARGO_TARGET_DIR` unset, `nightly-2026-09-15`, and `wasm-bindgen-cli` 0.2.127.
    *   Then run `node functions/copy-engine.js`.
3.  **Bump versions.**
    *   `RUST_ENGINE_VERSION` 35 -> 36 in `docs/static/scripts/engine/rust-ai.js`.
    *   `?v=36` on every page that loads `rust-ai.js` (`grep -l 'rust-ai.js?v=' docs/*.html`). On 2026-11-03 those were `analysis`, `game`, `multiplayer`, `puzzles`, `sigilbench` and `tutorial`.
    *   `CACHE_VERSION` in `docs/sw.js` to `main`'s current value + 1 (v97 on 2026-11-03, so v98 or later).
4.  **Run the tests:**
    *   `cargo test --release --lib --manifest-path engine/Cargo.toml`
    *   `npm --prefix functions test`
    *   `node tools/wasm-smoke.js`
    *   `node tools/nn-wasm-parity.js docs/static/wasm nnue_r6`
5.  **Refit the position win-probability curve** (`docs/static/data/position-winprob.json`, PR #28). Its notes say to refit whenever `SHIPPED_EVAL` changes. The original fit used 5,028 Very Hard games (runs in `$B/data/posrating/runs_v1.txt`).
6.  **Open a PR and request a Codex review.** After the merge:
    *   Robi deploys the Functions (game review and pricing load `functions/wasm`).
    *   Check that the Pages build ran; builds have stalled on quota before.
7.  **Record the results** in `engine/STATUS.md` and `engine/FINDINGS.md`. Optionally re-anchor the AI tier ratings.

## Done in v35 (PR #57, merged 2026-10-31)

*   **Search and generator:**
    *   bank first steps deduplicated and capped (at most 4 placements per move, at most 60 steps);
    *   `TurnIter` order `Moves -> MoveCast -> DashCast -> Dash`;
    *   dash sacrifice pairs that keep a spell castable;
    *   `key_dash_turns` in the `PolicyIter` branch, the repetition-mate prepass, TT clearing on new twofold keys, and the `spend_remaining` root double count.
*   **Policy width:** `SHIPPED_POLICY` 96 -> 32. **Unmeasured** (Step 0).
*   **Nets:**
    *   8-slot `FoldRing` leaf cache;
    *   `SNN2` format (39 wall rows + 2x4 bank rows);
    *   retired nets gated out of wasm.
*   **Telemetry:** `aiTelemetry` on `completed_games`, with rules in `database.rules.json`. The live deploy is unconfirmed (T1).
*   **Harness work already done** (the 2026-11-02 list treated some of it as pending):
    *   `deep_review.py` uses `engine_eval(se)` and reads `aiTelemetry`;
    *   `nn_eval.py prep` extracts walls and bank, and `train --snn2` exports `SNN2`;
    *   `policy_train.py extract` aborts above a 1% primary-window drop rate;
    *   `PolicyDiag` reports `in_explore_tail` and `broken_stage`.
*   **Tests:** 198 `cargo test --release --lib`, 49 Functions tests, wasm smoke, and nn-wasm parity 264/264. That parity covers `nnue_mt256`, an `SNN1` net. No real `SNN2` net has golden vectors yet (C2).
