#!/usr/bin/env bash
# Arena / data-generation runner for a GCE VM. Self-contained; streams results to
# GCS; shuts itself down.
#
# LIVES IN THE REPO ON PURPose. An earlier copy lived only in an ephemeral Cloud
# Shell scratch directory, and a VM reset destroyed it along with an unpushed
# engine change. Anything needed to reproduce a run belongs under version control.
#
# Metadata attributes:
#   run-id    GCS prefix under runs/
#   workers   shards per arm
#   branch    git branch to clone (default rust-bitboard-engine)
#   harness   script name under engine/harness/
#   arms      space-separated arms; each is a comma-separated argument list for the
#             harness, with the shard's seed offset appended
#   smoke     one arm run first as a smoke test; a failure aborts before any arm
#   max-hours hard cap on VM lifetime (default 4)
set -uo pipefail
exec > >(tee -a /var/log/sigil-arena.log) 2>&1
echo "=== sigil runner bootstrap $(date -u +%FT%TZ) ==="
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); WORKERS=$(md workers); BRANCH=$(md branch)
# Base index for this VM's shards. Every VM in a fleet runs workers 0..N-1,
# so without a per-VM base they all compute the SAME SIGIL_SHARD_OFF, play
# the SAME seeds, and write the SAME npz filenames over each other in GCS --
# replication masquerading as sample size, which is the ab_eval bug again.
SHARD_BASE=$(md shard-base)
HARNESS=$(md harness); ARMS=$(md arms); SMOKE=$(md smoke); MAXH=$(md max-hours)
: "${RUN:=unknown}" "${WORKERS:=4}" "${BRANCH:=rust-bitboard-engine}" \
  "${HARNESS:=ab_eval.py}" "${ARMS:=}" "${SMOKE:=}" "${MAXH:=4}" "${SHARD_BASE:=0}"
echo "run=$RUN workers=$WORKERS harness=$HARNESS branch=$BRANCH max_hours=$MAXH shard_base=$SHARD_BASE"
echo "arms: $ARMS"

# ---------------------------------------------------------------------------
# WATCHDOG. Three VMs once billed ~10 hours each because the script never reached
# its own `shutdown`. Nothing below this line is trusted to terminate.
# ---------------------------------------------------------------------------
( sleep $((MAXH * 3600)); echo "WATCHDOG: ${MAXH}h cap hit, shutting down"; \
  shutdown -h now ) &
WATCHDOG=$!

gcs_put() {
  # --max-time matters: an upload that hangs without it blocks the whole script,
  # and the script is what shuts the VM down.
  local tok; tok=$(curl -sf -m 15 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])') || return 1
  curl -sf -m 300 -X POST -H "Authorization: Bearer $tok" \
    -H "Content-Type: application/octet-stream" --data-binary "@$1" \
    "https://storage.googleapis.com/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=$(python3 -c "
import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$2")" >/dev/null
}

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y build-essential curl git python3-venv >/dev/null 2>&1
WORK=/opt/sigil
rm -rf $WORK/repo $WORK/out                     # idempotent across restarts
mkdir -p $WORK/out && cd $WORK
export RUSTUP_HOME=$WORK/rustup CARGO_HOME=$WORK/cargo PATH=$WORK/cargo/bin:$PATH
[ -x $WORK/cargo/bin/rustc ] || curl -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null 2>&1

git clone --filter=blob:none --no-checkout --depth=1 --single-branch --branch "$BRANCH" \
  https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 \
  || { echo "FATAL: clone failed"; shutdown -h now; exit 1; }
cd repo && git sparse-checkout init --cone >/dev/null 2>&1
git sparse-checkout set engine docs/static/scripts ai notation.py simboard.py >/dev/null 2>&1
git checkout >/dev/null 2>&1
COMMIT=$(git log --oneline -1)
echo "repo at $COMMIT"
echo "$COMMIT" > $WORK/out/COMMIT.txt

# the JS-bridge harnesses read $SCRATCH/ref for the live engine + python rules
REF=$WORK/ref; mkdir -p $REF/ai $REF/docs/static/scripts
cp -r $WORK/repo/docs/static/scripts/engine $REF/docs/static/scripts/ 2>/dev/null
cp $WORK/repo/notation.py $WORK/repo/simboard.py $REF/ 2>/dev/null
cp $WORK/repo/ai/config.py $REF/ai/ 2>/dev/null

python3 -m venv $WORK/venv
$WORK/venv/bin/pip -q install --upgrade pip maturin numpy 2>&1 | tail -1
cd $WORK/repo/engine && VIRTUAL_ENV=$WORK/venv $WORK/venv/bin/maturin develop --release 2>&1 | tail -2
export SCRATCH=$WORK

# Uploads .npz as well as logs. Data-generation shards checkpoint their npz in
# place, so shipping them continuously is what makes a watchdog kill survivable:
# an earlier depth-8 run lost 90 minutes across 28 shards because nothing left the
# VM until the very end.
( while true; do
    for f in $WORK/out/*.log $WORK/out/*.txt; do [ -e "$f" ] || continue
      gcs_put "$f" "runs/$RUN/live/$(basename "$f")" 2>/dev/null || true; done
    for f in $WORK/out/*.npz $WORK/out/data/*.npz; do [ -e "$f" ] || continue
      gcs_put "$f" "runs/$RUN/data/$(basename "$f")" 2>/dev/null || true; done
    sleep 120; done ) &
UPLOADER=$!

if [ -n "$SMOKE" ]; then
  echo "=== smoke: $HARNESS $SMOKE ==="
  if ! timeout 900 $WORK/venv/bin/python "$WORK/repo/engine/harness/$HARNESS" \
       $(echo "$SMOKE" | tr ',' ' ') > $WORK/out/smoke.log 2>&1; then
    echo "FATAL: smoke failed"; sed -n '1,40p' $WORK/out/smoke.log
    gcs_put "$WORK/out/smoke.log" "runs/$RUN/smoke_FAILED.log"; shutdown -h now; exit 1
  fi
  tail -4 $WORK/out/smoke.log
  gcs_put "$WORK/out/smoke.log" "runs/$RUN/smoke_ok.log"
fi
echo "=== smoke passed; launching arms ==="

# Arm PIDs are collected explicitly. `wait` with NO arguments waits for every
# background job including the uploader loop, which never exits -- that single
# mistake meant no run ever reached the lines below, so no summary was ever
# written and no VM ever shut itself down. Three of them billed ~10 hours each.
PIDS=()
ai=0
for arm in $ARMS; do
  ai=$((ai+1))
  # sanitise to a safe filename: an arm may legitimately contain a path argument,
  # and leaving slashes in made every shard die with "No such file or directory".
  tag=$(echo "$arm" | tr -c 'A-Za-z0-9_.-' '_' | sed 's/__*/_/g; s/^_//; s/_$//')
  for ((w=0; w<WORKERS; w++)); do
    # The offset goes in the ENVIRONMENT. Appending it to argv silently failed for
    # every ab_eval arm that also passed an optional trailing argument: the offset
    # landed past the last position the harness reads, all shards ran identical
    # seeds, and the reported "n" was replication rather than sample size.
    ( SIGIL_SHARD_OFF=$(((SHARD_BASE + w)*1000)) \
      $WORK/venv/bin/python "$WORK/repo/engine/harness/$HARNESS" \
        $(echo "$arm" | tr ',' ' ') \
        > "$WORK/out/arm${ai}_${tag}_w$((SHARD_BASE + w)).log" 2>&1 ) &
    PIDS+=($!)
  done
done
echo "launched ${#PIDS[@]} shards"
wait "${PIDS[@]}"
echo "=== all shards done $(date -u +%FT%TZ) ==="

kill $UPLOADER 2>/dev/null || true
{ grep -h '^SPRT' $WORK/out/arm*_w*.log; grep -h '^SHARD' $WORK/out/arm*_w*.log; \
  grep -h '^WROTE' $WORK/out/arm*_w*.log; } > $WORK/out/summary.txt 2>/dev/null || true
for f in $WORK/out/*.log $WORK/out/*.txt; do
  [ -e "$f" ] || continue
  gcs_put "$f" "runs/$RUN/live/$(basename "$f")" || true
done
# data-generation shards emit .npz artefacts
for f in $WORK/out/*.npz $WORK/out/data/*.npz; do
  [ -e "$f" ] || continue
  gcs_put "$f" "runs/$RUN/data/$(basename "$f")" || true
done
gcs_put "$WORK/out/summary.txt" "runs/$RUN/summary.txt" || true
echo "DONE $(date -u +%FT%TZ) $COMMIT" > $WORK/out/COMPLETE
gcs_put "$WORK/out/COMPLETE" "runs/$RUN/COMPLETE" || true
gcs_put /var/log/sigil-arena.log "runs/$RUN/bootstrap.log" || true
kill $WATCHDOG 2>/dev/null || true
shutdown -h now
