#!/usr/bin/env bash
# Launch one mate-in-4 mining VM (startup script: runner_mate4.sh).
#   BRANCH=sigil-bench-v2 CANDIDATES=puzzles/m4_candidates_2026-11-01.json SHARD=0/2 \
#     launch_mate4.sh [name] [machine] [zone] [max-hours] [workers]
# Spot c3d-highcpu-90 by default; collect gs://focus-surfer-494820-g0-sigil/runs/<run>/live/work_*.jsonl
# and assemble locally with bench/tools/mine_mate4.py assemble. Teardown: engine/gcp/teardown.sh.
set -euo pipefail
NAME=${1:-sigil-m4-$(date -u +%m%d%H%M)}
MACHINE=${2:-c3d-highcpu-90}; ZONE=${3:-us-central1-f}; MAXH=${4:-3}; WORKERS=${5:-88}
PROJECT=${PROJECT:-focus-surfer-494820-g0}
BRANCH=${BRANCH:?set BRANCH}; CANDIDATES=${CANDIDATES:?set CANDIDATES}; SHARD=${SHARD:-0/1}; TIME_MS=${TIME_MS:-900000}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN=$(date -u +%Y%m%dT%H%M%SZ)-$NAME
echo "RUN=$RUN name=$NAME machine=$MACHINE zone=$ZONE cap=${MAXH}h workers=$WORKERS branch=$BRANCH shard=$SHARD"
gcloud compute instances create "$NAME" --project="$PROJECT" --zone="$ZONE" --machine-type="$MACHINE" \
  --provisioning-model=SPOT --instance-termination-action=DELETE \
  --boot-disk-size=25GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
  --image-family=debian-12 --image-project=debian-cloud \
  --scopes=https://www.googleapis.com/auth/devstorage.read_write --labels=project=sigil,purpose=mate4 \
  --metadata="run-id=$RUN,workers=$WORKERS,branch=$BRANCH,max-hours=$MAXH,candidates=$CANDIDATES,shard=$SHARD,time-ms=$TIME_MS" \
  --metadata-from-file="startup-script=$HERE/runner_mate4.sh" --format="value(name,status)"
echo "$RUN"
