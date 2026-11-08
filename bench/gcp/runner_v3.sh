#!/usr/bin/env bash
# SigilBench v3 job runner on a GCE VM (startup script for launch_v3.sh).
# Clones the branch, builds the engine examples, installs node, downloads the
# job's inputs from the PRIVATE bucket, runs bench/gcp/jobs/<job>.sh, streams
# $OUT to gs://<private>/runs/<run-id>/ every two minutes, writes COMPLETE or
# FAILED and shuts down. A watchdog caps the VM's life. The VM runs as the
# keyless sigilbench-eval service account (read + create on the private bucket).
#
# Metadata: run-id, branch, job, max-hours, inputs (space-separated object
# names under the private bucket), args (passed to the job), shard (i/n),
# python (1 = also build the engine's Python binding).
set -uo pipefail
exec > >(tee -a /var/log/sigil-v3.log) 2>&1
echo "=== sigilbench v3 runner bootstrap $(date -u +%FT%TZ) ==="
BUCKET=focus-surfer-494820-g0-sigilbench-private
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); BRANCH=$(md branch); JOB=$(md job); MAXH=$(md max-hours)
INPUTS=$(md inputs); ARGS=$(md args); SHARD=$(md shard); PYBIND=$(md python)
: "${RUN:=unknown}" "${MAXH:=3}" "${SHARD:=0/1}"
[ -n "${BRANCH:-}" ] && [ -n "${JOB:-}" ] || { echo "FATAL: branch and job metadata are required"; shutdown -h now; exit 1; }
echo "run=$RUN branch=$BRANCH job=$JOB max_hours=$MAXH shard=$SHARD inputs=$INPUTS args=$ARGS"
( sleep $((MAXH * 3600)); echo "WATCHDOG: ${MAXH}h cap hit, shutting down"; shutdown -h now ) &

tok() { curl -sf -m 15 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'; }
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }
gcs_put() { local t; t=$(tok) || return 1
  curl -sf -m 600 -X POST -H "Authorization: Bearer $t" -H "Content-Type: application/octet-stream" \
    --data-binary "@$1" "https://storage.googleapis.com/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=$(enc "$2")" >/dev/null; }
gcs_get() { local t; t=$(tok) || return 1
  curl -sf -m 600 -H "Authorization: Bearer $t" -o "$2" \
    "https://storage.googleapis.com/storage/v1/b/$BUCKET/o/$(enc "$1")?alt=media"; }
# The eval SA may create but not overwrite objects: every upload gets a fresh
# name (a sequence number), and the collector reads the newest.
SEQ=0
put_out() { SEQ=$((SEQ + 1)); local f
  for f in "$OUT"/*; do [ -f "$f" ] && gcs_put "$f" "runs/$RUN/s$(printf %05d $SEQ)/$(basename "$f")" 2>/dev/null; done
  gcs_put /var/log/sigil-v3.log "runs/$RUN/s$(printf %05d $SEQ)/runner.log" 2>/dev/null; }

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update; apt-get -qq install -y build-essential curl git python3 nodejs >/dev/null 2>&1
WORK=/opt/sigil; OUT=$WORK/out; IN=$WORK/in; mkdir -p $OUT $IN && cd $WORK
export RUSTUP_HOME=$WORK/rustup CARGO_HOME=$WORK/cargo PATH=$WORK/cargo/bin:$PATH
[ -x $WORK/cargo/bin/rustc ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1
rm -rf repo
git clone --filter=blob:none --depth=1 --single-branch --branch "$BRANCH" https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 \
  || { echo "FATAL: clone failed"; shutdown -h now; exit 1; }
cd repo; COMMIT=$(git log --oneline -1); echo "repo at $COMMIT"; echo "$COMMIT" > $OUT/COMMIT.txt
( cd engine && cargo build --release --no-default-features --example cert_tool --example rules_children \
    --example win_table --example win_table2 --example solve_mates --example bench_grade 2>&1 | tail -2 )
export BIN=$WORK/repo/engine/target/release/examples
[ -x "$BIN/cert_tool" ] || { echo "FATAL: build"; shutdown -h now; exit 1; }
# metadata python=1: the engine's Python binding (maturin), for jobs that play games.
if [ "${PYBIND:-}" = 1 ]; then
  apt-get -qq install -y python3-venv >/dev/null 2>&1
  python3 -m venv $WORK/venv && $WORK/venv/bin/pip -q install --upgrade pip maturin 2>&1 | tail -1
  ( cd engine && VIRTUAL_ENV=$WORK/venv $WORK/venv/bin/maturin develop --release 2>&1 | tail -2 )
  $WORK/venv/bin/python -c "import sigil_engine" || { echo "FATAL: python binding"; shutdown -h now; exit 1; }
  export PATH=$WORK/venv/bin:$PATH
fi
node --version
for obj in $INPUTS; do gcs_get "$obj" "$IN/$(basename "$obj")" || { echo "FATAL: download $obj"; shutdown -h now; exit 1; }; done
( while true; do sleep 120; put_out; done ) &
export OUT IN SHARD RUN WORKERS=$(nproc)
bash "bench/gcp/jobs/$JOB.sh" $ARGS > $OUT/job.log 2>&1
STATUS=$?
if [ "$STATUS" -eq 0 ]; then MARK=COMPLETE; else MARK=FAILED; fi
echo "$(date -u +%FT%TZ) exit $STATUS" > $OUT/$MARK
put_out
echo "=== $MARK; shutting down ==="; shutdown -h now
