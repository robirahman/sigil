#!/usr/bin/env bash
# Step 4 cost + quality bench on one quiet VM (startup script). Builds the branch,
# runs bench.rs node-rate configs and bench_suites.py coverage/sees configs for the
# learned generator policy, ships results to gs://…/runs/<run-id>/, shuts down.
#
#   gcloud compute instances create sigil-s4-bench ... \
#     --metadata=run-id=<id>,branch=train-s4-policy,max-hours=3,jobs=<bench|sees|all> \
#     --metadata-from-file=startup-script=engine/gcp/s4_bench.sh
set -uo pipefail
exec > >(tee -a /var/log/sigil-s4.log) 2>&1
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); BRANCH=$(md branch); MAXH=$(md max-hours); JOBS=$(md jobs)
: "${RUN:=s4-unknown}" "${BRANCH:=train-s4-policy}" "${MAXH:=3}" "${JOBS:=all}"
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
W=/opt/s4; mkdir -p $W/out; cd $W
export RUSTUP_HOME=$W/rustup CARGO_HOME=$W/cargo PATH=$W/cargo/bin:$PATH
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1
git clone --filter=blob:none --no-checkout --depth=1 --single-branch --branch "$BRANCH" \
  https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 || { echo clone failed; shutdown -h now; }
cd repo && git sparse-checkout init --cone && git sparse-checkout set engine ai && git checkout >/dev/null 2>&1
git log --oneline -1 > $W/out/COMMIT.txt
python3 -m venv $W/venv; $W/venv/bin/pip -q install numpy
cd engine
cargo build --release 2>&1 | tail -1
cargo build --release --no-default-features --example bench --example policy_cost 2>&1 | tail -1
mkdir -p $W/py; cp target/release/libsigil_engine.so $W/py/sigil_engine.so
( while true; do for f in $W/out/*; do gcs_put "$f" "runs/$RUN/$(basename "$f")" || true; done; sleep 120; done ) &
UP=$!
B=./target/release/examples/bench
P=harness/positions_midgame.txt
if [ "$JOBS" = all ] || [ "$JOBS" = bench ]; then
  ./target/release/examples/policy_cost $P 20 > $W/out/policy_cost.txt 2>&1
  # node rate: each config twice, 14 at a time (c3d vCPUs are hyperthreads)
  i=0
  for rep in 1 2; do
    for d in 4 5; do
      for cfg in "ship::" "p0_0:0:0" "p40_0:40:0" "p64_0:64:0" "p96_0:96:0" "p160_0:160:0" \
                 "p40_512:40:512" "p64_512:64:512" "p96_512:96:512" "p0_1024:0:1024"; do
        IFS=: read -r name minw pen <<< "$cfg"
        args=""
        [ -n "$minw" ] && args="--policy $minw --pcost $pen 100000"
        ( $B $P $d $args | tail -1 > $W/out/bench_${name}_d${d}_r${rep}.txt ) &
        i=$((i+1)); if [ $((i % 14)) = 0 ]; then wait; fi
      done
    done
  done
  wait
fi
if [ "$JOBS" = all ] || [ "$JOBS" = sees ]; then
  cd $W/repo
  N=$(nproc)
  PYTHONPATH=$W/py $W/venv/bin/python engine/harness/bench_suites.py --nodes 50000,300000,1500000 \
    --cover 6,10,12,24,40,96,500 --workers $N \
    --config 'shipped:eval=tfit' \
    --config 'pol64:eval=tfit;call=set_policy(True,64)' \
    --config 'pol40:eval=tfit;call=set_policy(True,40)' \
    --config 'pol40_512:eval=tfit;call=set_policy(True,40);call=set_policy_cost(512,100000)' \
    --json $W/out/sees.json > $W/out/sees.log 2>&1
fi
kill $UP 2>/dev/null
for f in $W/out/*; do gcs_put "$f" "runs/$RUN/$(basename "$f")" || true; done
echo "DONE $(date -u +%FT%TZ)" > $W/out/COMPLETE; gcs_put $W/out/COMPLETE "runs/$RUN/COMPLETE"
gcs_put /var/log/sigil-s4.log "runs/$RUN/bootstrap.log" || true
kill $WATCHDOG 2>/dev/null; shutdown -h now
