#!/usr/bin/env bash
# SigilBench engine baseline on a GCE VM (startup script for launch_engine_baseline.sh).
# Clones the branch, builds the Python engine module and the grader, plays the
# engine on this VM's puzzles (bench/tools/engine_baseline.py), grades and
# resolves them, streams the run directory to gs://<bucket>/runs/<run-id>/live/
# every two minutes, writes COMPLETE or FAILED and shuts down. Watchdog-capped.
# Metadata: run-id, branch, max-hours, puzzles (repo path), ids (comma list),
# tier, workers, name.
set -uo pipefail
exec > >(tee -a /var/log/sigil-engbase.log) 2>&1
echo "=== sigil engine baseline bootstrap $(date -u +%FT%TZ) ==="
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); BRANCH=$(md branch); MAXH=$(md max-hours); PUZ=$(md puzzles); IDS=$(md ids); TIER=$(md tier)
WORKERS=$(md workers); NAME=$(md name)
: "${RUN:=unknown}" "${MAXH:=3}" "${TIER:=very_hard}" "${WORKERS:=44}" "${NAME:=engine}"
( sleep $((MAXH * 3600)); echo "WATCHDOG: ${MAXH}h cap hit"; shutdown -h now ) &
tok() { curl -sf -m 15 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'; }
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }
gcs_put() { local t; t=$(tok) || return 1
  curl -sf -m 600 -X POST -H "Authorization: Bearer $t" -H "Content-Type: application/octet-stream" --data-binary "@$1" \
    "https://storage.googleapis.com/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=$(enc "$2")" >/dev/null; }
( while true; do gcs_put /var/log/sigil-engbase.log "runs/$RUN/bootstrap.log" 2>/dev/null || true; sleep 20; done ) &
trap 'echo "EXIT status $? at line $LINENO"; gcs_put /var/log/sigil-engbase.log "runs/$RUN/bootstrap.log" 2>/dev/null' EXIT
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update; apt-get -qq install -y build-essential curl git python3-venv nodejs >/dev/null 2>&1
node --version || { echo "FATAL: no node"; shutdown -h now; exit 1; }
WORK=/opt/sigil; mkdir -p $WORK && cd $WORK
export RUSTUP_HOME=$WORK/rustup CARGO_HOME=$WORK/cargo PATH=$WORK/cargo/bin:$PATH
[ -x $WORK/cargo/bin/rustc ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1
rm -rf repo; git clone --filter=blob:none --depth=1 --single-branch --branch "$BRANCH" https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 \
  || { echo "FATAL: clone"; shutdown -h now; exit 1; }
cd repo; echo "repo at $(git log --oneline -1)"
python3 -m venv $WORK/venv; $WORK/venv/bin/pip -q install --upgrade pip maturin 2>&1 | tail -1
(cd engine && VIRTUAL_ENV=$WORK/venv $WORK/venv/bin/maturin develop --release 2>&1 | tail -2)
$WORK/venv/bin/python -c "import sigil_engine" || { echo "FATAL: engine module"; shutdown -h now; exit 1; }
(cd engine && cargo build --release --no-default-features --example bench_grade --example children 2>&1 | tail -1)
export SIGILBENCH_GRADE_BIN=$WORK/repo/engine/target/release/examples/bench_grade
[ -x "$SIGILBENCH_GRADE_BIN" ] || { echo "FATAL: grader build"; shutdown -h now; exit 1; }
OUT=$WORK/out/$NAME; mkdir -p $OUT
( while true; do for f in $OUT/*; do [ -f "$f" ] && gcs_put "$f" "runs/$RUN/live/$NAME/$(basename "$f")" 2>/dev/null; done
    gcs_put /var/log/sigil-engbase.log "runs/$RUN/live/runner.log" 2>/dev/null; sleep 120; done ) &
cd bench
$WORK/venv/bin/python -u tools/engine_baseline.py --puzzles "$PUZ" --tier "$TIER" --workers "$WORKERS" \
  ${IDS:+--ids "$IDS"} --out "$OUT" > $WORK/out/engine_baseline.log 2>&1
STATUS=$?
[ "$STATUS" -eq 0 ] && MARK=COMPLETE || MARK=FAILED
echo "$(date -u +%FT%TZ) exit $STATUS" > $WORK/out/$MARK
for f in $OUT/*; do gcs_put "$f" "runs/$RUN/live/$NAME/$(basename "$f")" || true; done
gcs_put $WORK/out/engine_baseline.log "runs/$RUN/live/engine_baseline.log" || true
gcs_put $WORK/out/$MARK "runs/$RUN/$MARK" || true
echo "=== $MARK; shutting down ==="; shutdown -h now
