#!/usr/bin/env bash
# Mate-in-4 mining on a GCE VM (startup script for launch_mate4.sh; SigilBench
# dev set v2). Clones the branch, builds engine/examples/solve_mates, downloads
# the candidate list, runs bench/tools/mine_mate4.py solve on this VM's shard,
# streams the work file to gs://<bucket>/runs/<run-id>/live/ every two minutes,
# writes COMPLETE or FAILED and shuts down. A watchdog caps the VM's life.
#
# Metadata: run-id, branch, workers, max-hours, candidates (GCS object under
# the sigil bucket), shard (i/n), time-ms (per candidate).
set -uo pipefail
exec > >(tee -a /var/log/sigil-mate4.log) 2>&1
echo "=== sigil mate-in-4 runner bootstrap $(date -u +%FT%TZ) ==="
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); BRANCH=$(md branch); WORKERS=$(md workers); MAXH=$(md max-hours)
CANDS=$(md candidates); SHARD=$(md shard); TMS=$(md time-ms)
: "${RUN:=unknown}" "${WORKERS:=$(nproc)}" "${MAXH:=3}" "${SHARD:=0/1}" "${TMS:=900000}"
[ -n "${BRANCH:-}" ] && [ -n "${CANDS:-}" ] || { echo "FATAL: branch and candidates metadata are required"; shutdown -h now; exit 1; }
echo "run=$RUN branch=$BRANCH workers=$WORKERS max_hours=$MAXH candidates=$CANDS shard=$SHARD time_ms=$TMS"
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
( while true; do gcs_put /var/log/sigil-mate4.log "runs/$RUN/bootstrap.log" 2>/dev/null || true; sleep 20; done ) &
trap 'echo "EXIT status $? at line $LINENO"; gcs_put /var/log/sigil-mate4.log "runs/$RUN/bootstrap.log" 2>/dev/null' EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update; apt-get -qq install -y build-essential curl git python3 >/dev/null 2>&1
WORK=/opt/sigil; mkdir -p $WORK/out && cd $WORK
export RUSTUP_HOME=$WORK/rustup CARGO_HOME=$WORK/cargo PATH=$WORK/cargo/bin:$PATH
[ -x $WORK/cargo/bin/rustc ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1
rm -rf repo
git clone --filter=blob:none --depth=1 --single-branch --branch "$BRANCH" https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 \
  || { echo "FATAL: clone failed"; shutdown -h now; exit 1; }
cd repo; COMMIT=$(git log --oneline -1); echo "repo at $COMMIT"; echo "$COMMIT" > $WORK/out/COMMIT.txt
cd engine && cargo build --release --no-default-features --example solve_mates 2>&1 | tail -2
export SOLVE_MATES_BIN=$WORK/repo/engine/target/release/examples/solve_mates
[ -x "$SOLVE_MATES_BIN" ] || { echo "FATAL: build"; shutdown -h now; exit 1; }
gcs_get "$CANDS" $WORK/cands.json || { echo "FATAL: candidates download"; shutdown -h now; exit 1; }
SAFE=${SHARD//\//of}
( while true; do for f in $WORK/out/*; do [ -e "$f" ] && gcs_put "$f" "runs/$RUN/live/$(basename "$f")" 2>/dev/null; done
    gcs_put /var/log/sigil-mate4.log "runs/$RUN/live/runner.log" 2>/dev/null; sleep 120; done ) &
cd $WORK/repo
python3 -u bench/tools/mine_mate4.py solve --candidates $WORK/cands.json --shard "$SHARD" \
  --work "$WORK/out/work_$SAFE.jsonl" --workers "$WORKERS" --time-ms "$TMS" > $WORK/out/solve_$SAFE.log 2>&1
STATUS=$?
if [ "$STATUS" -eq 0 ]; then MARK=COMPLETE; else MARK=FAILED; fi
echo "$(date -u +%FT%TZ) exit $STATUS" > $WORK/out/$MARK
for f in $WORK/out/*; do gcs_put "$f" "runs/$RUN/live/$(basename "$f")" || true; done
gcs_put $WORK/out/$MARK "runs/$RUN/$MARK" || true
echo "=== $MARK; shutting down ==="; shutdown -h now
