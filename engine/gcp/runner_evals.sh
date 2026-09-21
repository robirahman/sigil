#!/usr/bin/env bash
# Per-position game evaluation on a GCE VM (startup script for launch_evals.sh).
#
# Clones the branch, builds the engine's Python module, downloads the
# pre-hydrated corpus from GCS, runs engine/harness/eval_games.py eval over ONE
# resumable work file, uploads it every two minutes so a preemption or the
# watchdog keeps everything scored so far, writes COMPLETE, and shuts down.
#
# Metadata attributes: run-id, branch, workers, max-hours, corpus (GCS object
# under the sigil bucket), depth, time-ms (per-position cap, 0 = untimed),
# resume (optional prior work file object).
set -uo pipefail
exec > >(tee -a /var/log/sigil-evals.log) 2>&1
echo "=== sigil eval runner bootstrap $(date -u +%FT%TZ) ==="
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); BRANCH=$(md branch); WORKERS=$(md workers); MAXH=$(md max-hours)
CORPUS=$(md corpus); DEPTH=$(md depth); TMS=$(md time-ms); RESUME=$(md resume); : "${RESUME:=}"
: "${RUN:=unknown}" "${BRANCH:=main}" "${WORKERS:=$(nproc)}" "${MAXH:=4}" \
  "${CORPUS:=data/eval_lines_2026-09-21.json}" "${DEPTH:=6}" "${TMS:=300000}"
echo "run=$RUN branch=$BRANCH workers=$WORKERS max_hours=$MAXH corpus=$CORPUS depth=$DEPTH time_ms=$TMS"

# WATCHDOG: nothing below is trusted to terminate (see runner.sh for why).
( sleep $((MAXH * 3600)); echo "WATCHDOG: ${MAXH}h cap hit, shutting down"; \
  shutdown -h now ) &

tok() { curl -sf -m 15 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'; }
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }
gcs_put() {   # file, object
  local t; t=$(tok) || return 1
  curl -sf -m 600 -X POST -H "Authorization: Bearer $t" -H "Content-Type: application/octet-stream" \
    --data-binary "@$1" \
    "https://storage.googleapis.com/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=$(enc "$2")" >/dev/null
}
gcs_get() {   # object, file
  local t; t=$(tok) || return 1
  curl -sf -m 600 -H "Authorization: Bearer $t" -o "$2" \
    "https://storage.googleapis.com/storage/v1/b/$BUCKET/o/$(enc "$1")?alt=media"
}

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y build-essential curl git python3-venv >/dev/null 2>&1
WORK=/opt/sigil
rm -rf $WORK/repo
mkdir -p $WORK/out && cd $WORK
export RUSTUP_HOME=$WORK/rustup CARGO_HOME=$WORK/cargo PATH=$WORK/cargo/bin:$PATH
[ -x $WORK/cargo/bin/rustc ] || curl -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1

git clone --filter=blob:none --no-checkout --depth=1 --single-branch --branch "$BRANCH" \
  https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 \
  || { echo "FATAL: clone failed"; shutdown -h now; exit 1; }
cd repo && git sparse-checkout init --cone >/dev/null 2>&1
git sparse-checkout set engine ai >/dev/null 2>&1
git checkout >/dev/null 2>&1
COMMIT=$(git log --oneline -1)
echo "repo at $COMMIT"; echo "$COMMIT" > $WORK/out/COMMIT.txt

python3 -m venv $WORK/venv
$WORK/venv/bin/pip -q install --upgrade pip maturin 2>&1 | tail -1
cd $WORK/repo/engine && VIRTUAL_ENV=$WORK/venv $WORK/venv/bin/maturin develop --release 2>&1 | tail -2
$WORK/venv/bin/python -c "import sigil_engine; print('engine import ok')" || { echo "FATAL: engine build"; shutdown -h now; exit 1; }

gcs_get "$CORPUS" $WORK/lines.json || { echo "FATAL: corpus download"; shutdown -h now; exit 1; }
echo "corpus: $(stat -c%s $WORK/lines.json) bytes"
if [ -n "$RESUME" ]; then
  gcs_get "$RESUME" $WORK/out/evals.jsonl && echo "resume: $(wc -l < $WORK/out/evals.jsonl) positions already scored" \
    || { echo "WARNING: resume download failed; starting fresh"; rm -f $WORK/out/evals.jsonl; }
fi

# Continuous upload of the work file + log: a preemption or the watchdog then
# loses at most two minutes of scoring.
( while true; do
    for f in $WORK/out/*.jsonl $WORK/out/*.txt $WORK/out/*.log; do [ -e "$f" ] || continue
      gcs_put "$f" "runs/$RUN/live/$(basename "$f")" 2>/dev/null || true; done
    gcs_put /var/log/sigil-evals.log "runs/$RUN/live/runner.log" 2>/dev/null || true
    sleep 120; done ) &

cd $WORK/repo
echo "=== eval: depth $DEPTH, cap ${TMS} ms/position, $WORKERS workers ==="
$WORK/venv/bin/python -u engine/harness/eval_games.py eval --lines $WORK/lines.json \
  --out $WORK/out/evals.jsonl --depth "$DEPTH" --time-ms "$TMS" --workers "$WORKERS" > $WORK/out/eval.log 2>&1
tail -3 $WORK/out/eval.log

for f in $WORK/out/*; do gcs_put "$f" "runs/$RUN/live/$(basename "$f")" || true; done
gcs_put /var/log/sigil-evals.log "runs/$RUN/live/runner.log" || true
date -u +%FT%TZ > $WORK/out/COMPLETE; gcs_put $WORK/out/COMPLETE "runs/$RUN/COMPLETE" || true
echo "=== done $(date -u +%FT%TZ); shutting down ==="
shutdown -h now
