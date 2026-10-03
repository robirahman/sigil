#!/usr/bin/env bash
# Post-game deep review on a GCE VM (startup script for launch_deep_review.sh).
#
# Same bootstrap as runner_surprise.sh, then ONE stage of
# engine/harness/deep_review.py's pipeline (metadata `mode`):
#   scan   eval_games.py eval --walk backward at DEPTH over the corpus (or one
#          game shard of it) -> scan.jsonl
#   probe  deep_review.py probe --depth DEPTH over the cases object (or one
#          task shard of it) -> probes.jsonl
# `flag` and `report` are cheap and run locally between the two. Work files
# stream to GCS every two minutes; COMPLETE is written at the end.
#
# Source: metadata `src` (a tar.gz object under the bucket, the working tree's
# engine/ directory) when set, else a clone of `branch`. The tarball lets an
# unpushed branch run on the fleet.
#
# Metadata: run-id, mode, branch, src, workers, max-hours, corpus, cases,
# depth, time-ms (per-search cap, 0 = untimed), shard (k/n), resume, walk (scan:
# backward / backward-plain / fresh), kinds (probe: only these task kinds).
set -uo pipefail
exec > >(tee -a /var/log/sigil-deep.log) 2>&1
echo "=== sigil deep-review runner bootstrap $(date -u +%FT%TZ) ==="
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); MODE=$(md mode); BRANCH=$(md branch); SRC=$(md src); : "${SRC:=}"
WORKERS=$(md workers); MAXH=$(md max-hours); CORPUS=$(md corpus); CASES=$(md cases); : "${CASES:=}"
DEPTH=$(md depth); TMS=$(md time-ms); SHARD=$(md shard); : "${SHARD:=}"
RESUME=$(md resume); : "${RESUME:=}"
WALK=$(md walk); : "${WALK:=backward}"
KINDS=$(md kinds); : "${KINDS:=}"
: "${RUN:=unknown}" "${MODE:=scan}" "${BRANCH:=main}" "${WORKERS:=$(nproc)}" "${MAXH:=4}" "${DEPTH:=6}" "${TMS:=0}"
echo "run=$RUN mode=$MODE branch=$BRANCH src=${SRC:-git} workers=$WORKERS max_hours=$MAXH corpus=$CORPUS cases=$CASES depth=$DEPTH time_ms=$TMS shard=${SHARD:-all}"

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
mkdir -p $WORK/out $WORK/repo && cd $WORK
export RUSTUP_HOME=$WORK/rustup CARGO_HOME=$WORK/cargo PATH=$WORK/cargo/bin:$PATH
[ -x $WORK/cargo/bin/rustc ] || curl -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1

if [ -n "$SRC" ]; then
  gcs_get "$SRC" $WORK/src.tgz && tar -xzf $WORK/src.tgz -C $WORK/repo \
    || { echo "FATAL: source tarball"; shutdown -h now; exit 1; }
  echo "source tarball $SRC" > $WORK/out/COMMIT.txt
else
  rmdir $WORK/repo
  git clone --filter=blob:none --no-checkout --depth=1 --single-branch --branch "$BRANCH" \
    https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 \
    || { echo "FATAL: clone failed"; shutdown -h now; exit 1; }
  (cd repo && git sparse-checkout init --cone >/dev/null 2>&1 && git sparse-checkout set engine ai >/dev/null 2>&1 \
     && git checkout >/dev/null 2>&1 && git log --oneline -1 > $WORK/out/COMMIT.txt)
fi
echo "repo at $(cat $WORK/out/COMMIT.txt)"

python3 -m venv $WORK/venv
$WORK/venv/bin/pip -q install --upgrade pip maturin 2>&1 | tail -1
cd $WORK/repo/engine && VIRTUAL_ENV=$WORK/venv $WORK/venv/bin/maturin develop --release 2>&1 | tail -2
$WORK/venv/bin/python -c "import sigil_engine as se; se.SearchSession(10).analyze" \
  || { echo "FATAL: engine build (or no SearchSession.analyze)"; shutdown -h now; exit 1; }

gcs_get "$CORPUS" $WORK/lines.json || { echo "FATAL: corpus download"; shutdown -h now; exit 1; }
echo "corpus: $(stat -c%s $WORK/lines.json) bytes"
OUTF=$WORK/out/$([ "$MODE" = probe ] && echo probes.jsonl || echo scan.jsonl)
if [ -n "$RESUME" ]; then
  gcs_get "$RESUME" "$OUTF" && echo "resume: $(wc -l < "$OUTF") rows already done" \
    || { echo "WARNING: resume download failed; starting fresh"; rm -f "$OUTF"; }
fi

( while true; do
    for f in $WORK/out/*.jsonl $WORK/out/*.txt $WORK/out/*.log; do [ -e "$f" ] || continue
      gcs_put "$f" "runs/$RUN/live/$(basename "$f")" 2>/dev/null || true; done
    gcs_put /var/log/sigil-deep.log "runs/$RUN/live/runner.log" 2>/dev/null || true
    sleep 120; done ) &

cd $WORK/repo
H=engine/harness
SH=(); [ -n "$SHARD" ] && SH=(--shard "$SHARD")
KI=(); [ -n "$KINDS" ] && KI=(--kinds "$KINDS")
if [ "$MODE" = probe ]; then
  gcs_get "$CASES" $WORK/cases.json || { echo "FATAL: cases download"; shutdown -h now; exit 1; }
  echo "=== probe: depth $DEPTH, cap ${TMS} ms/search, $WORKERS workers ==="
  $WORK/venv/bin/python -u $H/deep_review.py probe --lines $WORK/lines.json --cases $WORK/cases.json \
    --out "$OUTF" --depth "$DEPTH" --time-ms "$TMS" --workers "$WORKERS" "${SH[@]}" "${KI[@]}" >> $WORK/out/probe.log 2>&1
  tail -3 $WORK/out/probe.log
else
  # A fresh walk is order-free, so it splits games into single positions.
  SPLIT=(); [ "$WALK" = fresh ] && SPLIT=(--split 1)
  echo "=== scan: $WALK walk, depth $DEPTH, cap ${TMS} ms/position, $WORKERS workers ==="
  $WORK/venv/bin/python -u $H/eval_games.py eval --walk "$WALK" "${SPLIT[@]}" --lines $WORK/lines.json \
    --out "$OUTF" --depth "$DEPTH" --time-ms "$TMS" --workers "$WORKERS" "${SH[@]}" > $WORK/out/scan.log 2>&1
  tail -3 $WORK/out/scan.log
fi

for f in $WORK/out/*; do gcs_put "$f" "runs/$RUN/live/$(basename "$f")" || true; done
gcs_put /var/log/sigil-deep.log "runs/$RUN/live/runner.log" || true
date -u +%FT%TZ > $WORK/out/COMPLETE; gcs_put $WORK/out/COMPLETE "runs/$RUN/COMPLETE" || true
echo "=== done $(date -u +%FT%TZ); shutting down ==="
shutdown -h now
