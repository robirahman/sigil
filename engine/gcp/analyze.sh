#!/usr/bin/env bash
# One-shot analysis VM: pull a run's .npz shards out of GCS, run one analysis
# script over them, ship the log back, shut down.
#
# Separate from runner.sh because the shape of the job is different: no arms, no
# shards, no engine. The ladder imports only numpy and sklearn, so skipping the
# rustup + cargo build saves ~8 minutes of boot on every analysis pass.
#
# It exists at all because Cloud Shell is the wrong place to fit 6M positions:
# that container has been recycled mid-task twice in one session, taking a scratch
# directory with it each time, and its network stalled a git clone for 20 minutes.
# A VM next to the bucket downloads 3.5GB in under a minute.
#
# Metadata attributes:
#   run-id     GCS prefix under runs/ whose data/ holds the shards
#   branch     git branch to clone
#   script     analysis script under engine/harness/
#   script-args  arguments AFTER the data dir, space separated
#   max-hours  hard cap on VM lifetime (default 2)
set -uo pipefail
exec > >(tee -a /var/log/sigil-analyze.log) 2>&1
echo "=== sigil analyze bootstrap $(date -u +%FT%TZ) ==="
BUCKET=focus-surfer-494820-g0-sigil
md() { curl -sf -m 10 -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
RUN=$(md run-id); BRANCH=$(md branch); SCRIPT=$(md script)
SARGS=$(md script-args); MAXH=$(md max-hours)
: "${RUN:=unknown}" "${BRANCH:=main}" "${SCRIPT:=fit_eval_ladder.py}" \
  "${SARGS:=}" "${MAXH:=2}"
echo "run=$RUN branch=$BRANCH script=$SCRIPT args=$SARGS cap=${MAXH}h"

# Same watchdog rule as runner.sh: nothing below is trusted to terminate.
( sleep $((MAXH * 3600)); echo "WATCHDOG: ${MAXH}h cap hit"; shutdown -h now ) &

gcs_put() {
  local tok; tok=$(curl -sf -m 15 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])') || return 1
  curl -sf -m 600 -X POST -H "Authorization: Bearer $tok" \
    -H "Content-Type: application/octet-stream" --data-binary "@$1" \
    "https://storage.googleapis.com/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=$(python3 -c "
import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$2")" >/dev/null
}

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y git python3-venv >/dev/null 2>&1
WORK=/opt/sigil; rm -rf $WORK; mkdir -p $WORK/data $WORK/out; cd $WORK
git clone --filter=blob:none --no-checkout --depth=1 --single-branch --branch "$BRANCH" \
  https://github.com/robirahman/sigil.git repo >/dev/null 2>&1 \
  || { echo "FATAL: clone failed"; shutdown -h now; exit 1; }
cd repo && git sparse-checkout init --cone >/dev/null 2>&1
git sparse-checkout set engine >/dev/null 2>&1
git checkout >/dev/null 2>&1
git log --oneline -1 | tee $WORK/out/COMMIT.txt

python3 -m venv $WORK/venv
$WORK/venv/bin/pip -q install --upgrade pip numpy scikit-learn 2>&1 | tail -1

echo "=== downloading shards ==="
gsutil -m -q cp "gs://$BUCKET/runs/$RUN/data/*.npz" $WORK/data/ 2>&1 | tail -2
echo "$(ls $WORK/data/*.npz | wc -l) shards, $(du -sh $WORK/data | cut -f1)"

echo "=== $SCRIPT ==="
timeout $((MAXH * 3300)) $WORK/venv/bin/python \
  "$WORK/repo/engine/harness/$SCRIPT" "$WORK/data" $SARGS \
  > $WORK/out/analysis.log 2>&1
echo "exit $?"
tail -40 $WORK/out/analysis.log
gcs_put "$WORK/out/analysis.log" "runs/$RUN/analysis/$SCRIPT.log" || true
gcs_put /var/log/sigil-analyze.log "runs/$RUN/analysis/bootstrap.log" || true
shutdown -h now
