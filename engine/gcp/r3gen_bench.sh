#!/usr/bin/env bash
# Round 3 generator bench on one quiet VM (startup script): node cost of the policy
# exploration tail (examples/bench.rs --explore) and fixed-node sees-rate / coverage
# (bench_suites.py) on the guest and surprise suites, v27 (nnue_spell3 + policy 96)
# vs the explore presets. Ships to gs://…/runs/<run-id>/ and shuts down.
#
#   gcloud compute instances create sigil-r3gen-bench ... \
#     --metadata=run-id=<id>,branch=r3-gen,max-hours=3,jobs=<bench|sees|all>,explore="<cfg> <cfg>" \
#     --metadata-from-file=startup-script=engine/gcp/r3gen_bench.sh
set -uo pipefail
exec > >(tee -a /var/log/sigil-r3g.log) 2>&1
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); BRANCH=$(md branch); MAXH=$(md max-hours); JOBS=$(md jobs); EXPLORE=$(md explore)
NODES=$(md nodes)
: "${RUN:=r3g-unknown}" "${BRANCH:=r3-gen}" "${MAXH:=3}" "${JOBS:=all}" "${NODES:=50000,300000,1500000}"
: "${EXPLORE:=3,64,128,8,48,256,8 3,32,64,4,32,256,16}"
( sleep $((MAXH * 3600)); echo "WATCHDOG"; shutdown -h now ) &
WATCHDOG=$!
gcs_put() {
  local tok; tok=$(curl -sf -m 15 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])') || return 1
  curl -sf -m 300 -X POST -H "Authorization: Bearer $tok" \
    -H "Content-Type: application/octet-stream" --data-binary "@$1" \
    "https://storage.googleapis.com/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=$(python3 -c "
import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$2")" >/dev/null
}
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update; apt-get -qq install -y build-essential curl git python3-venv >/dev/null 2>&1
W=/opt/r3g; mkdir -p $W/out; cd $W
export RUSTUP_HOME=$W/rustup CARGO_HOME=$W/cargo PATH=$W/cargo/bin:$PATH
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1
git clone --filter=blob:none --no-checkout --depth=1 --single-branch --branch "$BRANCH" \
  https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 || { echo clone failed; shutdown -h now; }
cd repo && git sparse-checkout init --cone && git sparse-checkout set engine ai && git checkout >/dev/null 2>&1
git log --oneline -1 > $W/out/COMMIT.txt
python3 -m venv $W/venv; $W/venv/bin/pip -q install numpy
cd engine
cargo build --release 2>&1 | tail -1
cargo build --release --no-default-features --example bench 2>&1 | tail -1
mkdir -p $W/py; cp target/release/libsigil_engine.so $W/py/sigil_engine.so
( while true; do for f in $W/out/*; do gcs_put "$f" "runs/$RUN/$(basename "$f")" || true; done; sleep 120; done ) &
UP=$!
B=./target/release/examples/bench
P=harness/positions_midgame.txt
N=$(nproc)
if [ "$JOBS" = all ] || [ "$JOBS" = bench ]; then
  # node cost: each config twice per depth, at most N/2 at a time (c3d vCPUs are hyperthreads)
  i=0
  for rep in 1 2; do
    for d in 4 5; do
      for cfg in off $EXPLORE; do
        name=$(echo "$cfg" | tr ',' '_')
        if [ "$cfg" = off ]; then args=""; else args="--explore $cfg"; fi
        ( $B $P $d --eval nnue_spell3 --policy 96 $args | grep -E "TOTAL|SMP" > $W/out/bench_${name}_d${d}_r${rep}.txt ) &
        i=$((i+1)); if [ $((i % (N / 2))) = 0 ]; then wait; fi
      done
    done
  done
  wait
fi
if [ "$JOBS" = all ] || [ "$JOBS" = sees ]; then
  cd $W/repo
  CFGS=(--config 'v27:eval=nnue_spell3;call=set_policy(True,96)')
  for cfg in $EXPLORE; do
    CFGS+=(--config "x$(echo "$cfg" | tr ',' '_'):eval=nnue_spell3;call=set_policy(True,96);call=set_policy_explore($cfg)")
  done
  PYTHONPATH=$W/py $W/venv/bin/python engine/harness/bench_suites.py --nodes "$NODES" \
    --cover 24,96,192,480 --workers $N --surprise-file guest_2026-10_cases.json "${CFGS[@]}" \
    --json $W/out/sees_guest.json > $W/out/sees_guest.log 2>&1
  PYTHONPATH=$W/py $W/venv/bin/python engine/harness/bench_suites.py --nodes "$NODES" \
    --cover 24,96,192,480 --workers $N --surprise-file surprise_cases_v25.json "${CFGS[@]}" \
    --json $W/out/sees_v25.json > $W/out/sees_v25.log 2>&1
fi
kill $UP 2>/dev/null
for f in $W/out/*; do gcs_put "$f" "runs/$RUN/$(basename "$f")" || true; done
echo "DONE $(date -u +%FT%TZ)" > $W/out/COMPLETE; gcs_put $W/out/COMPLETE "runs/$RUN/COMPLETE"
gcs_put /var/log/sigil-r3g.log "runs/$RUN/bootstrap.log" || true
kill $WATCHDOG 2>/dev/null; shutdown -h now
