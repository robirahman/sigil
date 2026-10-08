#!/usr/bin/env bash
# Round-3 gate VM (startup script): the browser-depth probe of the shipped wasm
# (tools/browser-depth.js) on a quiet machine, the native-vs-wasm speed
# calibration, then the guest gate (bench_suites.py --guest-only) for v27 and the
# v25 / v23 releases. Results stream to gs://<bucket>/runs/<run-id>/live/.
#
#   gcloud compute instances create sigil-r3g-1 --zone us-east4-a --machine-type c3d-highcpu-16 \
#     --provisioning-model=SPOT --instance-termination-action=DELETE ... \
#     --metadata run-id=<RUN>,branch=r3-gate,max-hours=3,procs=8 \
#     --metadata-from-file startup-script=engine/gcp/runner_r3gate.sh
#
# Rerunning the startup script on the same VM (out/ kept) skips the finished steps.
# `procs` node processes run the depth probe side by side, one per PHYSICAL core
# (C3D vCPUs are hyperthreads), so each search has a core to itself.
set -uo pipefail
exec > >(tee -a /var/log/sigil-r3gate.log) 2>&1
echo "=== sigil r3 gate runner $(date -u +%FT%TZ) ==="
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); BRANCH=$(md branch); MAXH=$(md max-hours); PROCS=$(md procs)
: "${RUN:=unknown}" "${BRANCH:=r3-gate}" "${MAXH:=3}" "${PROCS:=8}"
( sleep $((MAXH * 3600)); echo "WATCHDOG: ${MAXH}h cap hit"; shutdown -h now ) &

tok() { curl -sf -m 15 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'; }
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }
gcs_put() {
  local t; t=$(tok) || return 1
  curl -sf -m 600 -X POST -H "Authorization: Bearer $t" -H "Content-Type: application/octet-stream" \
    --data-binary "@$1" \
    "https://storage.googleapis.com/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=$(enc "$2")" >/dev/null
}
gcs_get() {
  local t; t=$(tok) || return 1
  curl -sf -m 600 -H "Authorization: Bearer $t" -o "$2" \
    "https://storage.googleapis.com/storage/v1/b/$BUCKET/o/$(enc "$1")?alt=media"
}

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y build-essential curl git python3-venv nodejs >/dev/null 2>&1
node --version
WORK=/opt/sigil; OUT=$WORK/out
rm -rf $WORK/repo; mkdir -p $OUT && cd $WORK
export RUSTUP_HOME=$WORK/rustup CARGO_HOME=$WORK/cargo PATH=$WORK/cargo/bin:$PATH
[ -x $WORK/cargo/bin/rustc ] || curl -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1

clone() {  # ref dir paths...
  local ref=$1 dir=$2; shift 2
  git clone --filter=blob:none --no-checkout --depth=1 --single-branch --branch "$ref" \
    https://github.com/robirahman/sigil.git "$dir" >/dev/null 2>&1 || return 1
  (cd "$dir" && git sparse-checkout init --cone >/dev/null 2>&1 && git sparse-checkout set "$@" >/dev/null 2>&1 \
     && git checkout >/dev/null 2>&1)
}
clone "$BRANCH" repo engine ai docs/static tools || { echo "FATAL: clone"; shutdown -h now; exit 1; }
(cd repo && git log --oneline -1) | tee $OUT/COMMIT.txt

( while true; do
    for f in $OUT/*; do [ -f "$f" ] || continue; gcs_put "$f" "runs/$RUN/live/$(basename "$f")" 2>/dev/null || true; done
    gcs_put /var/log/sigil-r3gate.log "runs/$RUN/live/runner.log" 2>/dev/null || true
    sleep 120; done ) &

# ---- builds (before any timing) ----
python3 -m venv $WORK/venv
$WORK/venv/bin/pip -q install --upgrade pip maturin numpy 2>&1 | tail -1
cd $WORK/repo/engine && VIRTUAL_ENV=$WORK/venv $WORK/venv/bin/maturin develop --release 2>&1 | tail -1
cargo build --release --no-default-features --example bench 2>&1 | tail -1
mkdir -p $WORK/mods
for ref in audit-v25 audit-v23; do
  clone "$ref" $WORK/$ref engine && (cd $WORK/$ref/engine && cargo build --release --lib 2>&1 | tail -1) \
    && cp $WORK/$ref/engine/target/release/libsigil_engine.so $WORK/mods/$ref.so
done
ls -la $WORK/mods
gcs_get data/guest-audit-2026-10/lines_all.json $WORK/lines_all.json || { echo "FATAL: corpus"; shutdown -h now; exit 1; }

# ---- calibration: native vs wasm on identical trees (fixed depth, one process) ----
cd $WORK/repo
P=engine/harness/positions_midgame.txt
for d in ${CALIB_DEPTHS:-4}; do
  grep -q "parity OK" $OUT/calib_wasm_d$d.txt 2>/dev/null && continue   # a failed parity reruns
  engine/target/release/examples/bench $P $d --shipped > $OUT/calib_native_d$d.txt 2>&1
  H=$(grep -o 'HASH [0-9a-f]*' $OUT/calib_native_d$d.txt | tail -1 | awk '{print $2}')
  node tools/policy-wasm-parity.js "$H" $d nnue_spell3 > $OUT/calib_wasm_d$d.txt 2>&1
  node tools/browser/wasm-speed.js node $d >> $OUT/calib_wasm_d$d.txt 2>&1   # same trees, timed
done
tail -n 2 $OUT/calib_*.txt

# ---- depth probe: the shipped wasm at the Hard tier's settings ----
B=ai/data/benchmarks
# PROCS shards side by side; SHARDS=n > PROCS samples shards 0..PROCS-1 of n.
probe() {  # out-prefix mode in [opts...]
  local pre=$1 mode=$2 in=$3; shift 3
  local nshard=${SHARDS:-$PROCS} k pids=()
  [ -s $OUT/$pre.jsonl ] && { echo "$pre: done before, skipped"; return; }
  rm -f $OUT/$pre.s*.jsonl
  for k in $(seq 0 $((PROCS - 1))); do
    node tools/browser-depth.js $mode $in $OUT/$pre.s$k.jsonl --shard $k/$nshard "$@" 2>>$OUT/$pre.log &
    pids+=($!)
  done
  wait "${pids[@]}"   # NOT a bare wait: the uploader loop and the watchdog are children too
  cat $OUT/$pre.s*.jsonl > $OUT/$pre.jsonl && rm -f $OUT/$pre.s*.jsonl
  echo "$pre: $(wc -l < $OUT/$pre.jsonl) searches $(date -u +%T)"
}
probe games10 games $WORK/lines_all.json --time-ms 10000
probe guest_pre cases $B/guest_2026-10_cases.json --field pre --time-ms 30000
probe guest_sfn cases $B/guest_2026-10_cases.json --field sfn --time-ms 30000
probe own_sfn cases $B/guest_2026-10_own.json --field sfn --time-ms 30000
SHARDS=32 probe surprise_pre cases $B/surprise_cases_v25.json --field pre --time-ms 30000
probe games10p games $WORK/lines_all.json --time-ms 10000 --ponder-ms 10000

# ---- guest gate (node budgets: machine-independent; all vCPUs) ----
git pull -q origin "$BRANCH" 2>/dev/null; git log --oneline -1 | tee -a $OUT/COMMIT.txt
NODES=${NODES:-50000,300000,600000,1500000}
for cfg in "v27:eval=shipped" "v25:eval=shipped;module=$WORK/mods/audit-v25.so" \
           "v23:eval=shipped;module=$WORK/mods/audit-v23.so"; do
  name=${cfg%%:*}
  [ -s $OUT/guest_gate_$name.json ] && continue
  nodes=$NODES; [ "$name" = v23 ] && nodes=""   # v23's analyze has no node_limit: fixed depths only
  $WORK/venv/bin/python -u engine/harness/bench_suites.py --guest-only --nodes "$nodes" --guest-depths 4,5,6 \
    --workers $(nproc) --config "$cfg" --json $OUT/guest_gate_$name.json >> $OUT/gate.log 2>&1
  tail -1 $OUT/gate.log
done

echo "DONE $(date -u +%FT%TZ)" | tee $OUT/COMPLETE
sleep 150   # last upload round
for f in $OUT/*; do [ -f "$f" ] && gcs_put "$f" "runs/$RUN/live/$(basename "$f")"; done
gcs_put /var/log/sigil-r3gate.log "runs/$RUN/live/runner.log"
gcs_put $OUT/COMPLETE "runs/$RUN/COMPLETE"
shutdown -h now
