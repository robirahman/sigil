#!/usr/bin/env bash
# Puzzle-set generation on a GCE VM (startup script for launch_puzzles.sh).
#
# Clones the branch, builds the engine's Python module, downloads the
# pre-hydrated corpus from GCS, runs tools/gen_mate_puzzles.py in two phases
# over ONE resumable work file (positions where the mover went on to win within
# four plies first, since that is where mate-in-2/3 puzzles live; then the rest),
# uploads the work file every two minutes so a preemption or the watchdog keeps
# everything solved so far, writes COMPLETE, and shuts the VM down.
#
# Metadata attributes:
#   run-id      GCS prefix under runs/
#   branch      git branch to clone
#   workers     solver processes
#   max-hours   hard cap on VM lifetime
#   corpus      GCS object name of the hydrated corpus (under the sigil bucket)
#   time-ms-1   per-position wall-clock cap, phase 1 (promising positions, mate <= 3)
#   time-ms-2   per-position cap, phase 2 (everything else)
#   max-mate-2  deepest mate looked for in phase 2 (2 or 3)
#   retry-ms    if > 0, a third phase re-solves the promising positions whose result
#               was "no mate" or "budget exceeded" with this per-position cap
#               (mate-in-3 nominations need a long 5-ply search on wide positions)
#   resume      optional GCS object name of a prior run's work file: downloaded
#               first, so already-solved positions are skipped (the first run
#               was a Spot VM preempted 3.5 minutes into phase 2)
set -uo pipefail
exec > >(tee -a /var/log/sigil-puzzles.log) 2>&1
echo "=== sigil puzzle runner bootstrap $(date -u +%FT%TZ) ==="
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); BRANCH=$(md branch); WORKERS=$(md workers); MAXH=$(md max-hours)
CORPUS=$(md corpus); TMS1=$(md time-ms-1); TMS2=$(md time-ms-2); MM2=$(md max-mate-2)
RESUME=$(md resume); : "${RESUME:=}"
TMS3=$(md retry-ms); : "${TMS3:=0}" 
: "${RUN:=unknown}" "${BRANCH:=puzzles}" "${WORKERS:=$(nproc)}" "${MAXH:=5}" \
  "${CORPUS:=puzzles/hydrated_2026-09-17.json}" "${TMS1:=40000}" "${TMS2:=30000}" "${MM2:=3}"
echo "run=$RUN branch=$BRANCH workers=$WORKERS max_hours=$MAXH corpus=$CORPUS tms1=$TMS1 tms2=$TMS2 mm2=$MM2"

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
git sparse-checkout set engine tools ai docs/static/scripts/engine >/dev/null 2>&1
git checkout >/dev/null 2>&1
COMMIT=$(git log --oneline -1)
echo "repo at $COMMIT"; echo "$COMMIT" > $WORK/out/COMMIT.txt

python3 -m venv $WORK/venv
$WORK/venv/bin/pip -q install --upgrade pip maturin 2>&1 | tail -1
cd $WORK/repo/engine && VIRTUAL_ENV=$WORK/venv $WORK/venv/bin/maturin develop --release 2>&1 | tail -2
$WORK/venv/bin/python -c "import sigil_engine; print('engine import ok')" || { echo "FATAL: engine build"; shutdown -h now; exit 1; }

gcs_get "$CORPUS" $WORK/hydrated.json || { echo "FATAL: corpus download"; shutdown -h now; exit 1; }
echo "corpus: $(stat -c%s $WORK/hydrated.json) bytes"
if [ -n "$RESUME" ]; then
  gcs_get "$RESUME" $WORK/out/mates.jsonl && echo "resume: $(wc -l < $WORK/out/mates.jsonl) positions already solved" \
    || { echo "WARNING: resume download failed; starting fresh"; rm -f $WORK/out/mates.jsonl; }
fi

# Continuous upload of the work file + log: a preemption or the watchdog then
# loses at most two minutes of solving.
( while true; do
    for f in $WORK/out/*.jsonl $WORK/out/*.txt $WORK/out/*.log; do [ -e "$f" ] || continue
      gcs_put "$f" "runs/$RUN/live/$(basename "$f")" 2>/dev/null || true; done
    gcs_put /var/log/sigil-puzzles.log "runs/$RUN/live/runner.log" 2>/dev/null || true
    sleep 120; done ) &

cd $WORK/repo
GEN="$WORK/venv/bin/python -u tools/gen_mate_puzzles.py --hydrated $WORK/hydrated.json --work $WORK/out/mates.jsonl --out $WORK/out/mate_puzzles.json --workers $WORKERS"
echo "=== phase 1: promising positions, mate <= 3, ${TMS1} ms/position ==="
$GEN --only-promising --max-mate 3 --time-ms "$TMS1" > $WORK/out/phase1.log 2>&1
tail -3 $WORK/out/phase1.log
echo "=== phase 2: everything else, mate <= $MM2, ${TMS2} ms/position ==="
$GEN --max-mate "$MM2" --time-ms "$TMS2" > $WORK/out/phase2.log 2>&1
tail -3 $WORK/out/phase2.log
if [ "$TMS3" -gt 0 ]; then
  echo "=== phase 3: retry promising no-mate / budget-exceeded positions, mate <= 3, ${TMS3} ms/position ==="
  $GEN --only-promising --max-mate 3 --time-ms "$TMS3" --retry promising > $WORK/out/phase3.log 2>&1
  tail -3 $WORK/out/phase3.log
fi

for f in $WORK/out/*; do gcs_put "$f" "runs/$RUN/live/$(basename "$f")" || true; done
gcs_put /var/log/sigil-puzzles.log "runs/$RUN/live/runner.log" || true
date -u +%FT%TZ > $WORK/out/COMPLETE; gcs_put $WORK/out/COMPLETE "runs/$RUN/COMPLETE" || true
echo "=== done $(date -u +%FT%TZ); shutting down ==="
shutdown -h now
