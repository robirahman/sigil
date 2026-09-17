#!/usr/bin/env bash
# Launch one puzzle-generation VM (startup script: runner_puzzles.sh).
#
#   launch_puzzles.sh [name] [machine-type] [zone] [max-hours] [workers]
#
# Defaults: a Spot c3d-highcpu-90 (45 cores / 90 vCPU, 180 GB) in us-central1-f
# for at most 5 h -- the solver is CPU-bound and each process holds < 1 GB, so
# the biggest machine the C3D per-family quota (500 vCPU) allows is the cheapest
# way to a full pass. The work file streams to
# gs://focus-surfer-494820-g0-sigil/runs/<run-id>/live/mates.jsonl every two
# minutes; collect it with
#   gcloud storage cp gs://focus-surfer-494820-g0-sigil/runs/<run-id>/live/mates.jsonl .
# and assemble with tools/gen_mate_puzzles.py --no-solve.
#
# The corpus must already be at gs://<bucket>/<CORPUS> (upload the hydrated
# dump from gen_mate_puzzles.py --hydrated). Environment overrides: PROJECT,
# BRANCH, CORPUS, TIME_MS_1, TIME_MS_2, MAX_MATE_2, SPOT (1/0).
set -euo pipefail
NAME=${1:-sigil-puzzles-$(date -u +%m%d%H%M)}
MACHINE=${2:-c3d-highcpu-90}; ZONE=${3:-us-central1-f}; MAXH=${4:-5}; WORKERS=${5:-88}
PROJECT=${PROJECT:-focus-surfer-494820-g0}
BRANCH=${BRANCH:-puzzles}
CORPUS=${CORPUS:-puzzles/hydrated_2026-09-17.json}
TIME_MS_1=${TIME_MS_1:-40000}; TIME_MS_2=${TIME_MS_2:-30000}; MAX_MATE_2=${MAX_MATE_2:-3}
SPOT=${SPOT:-1}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN=$(date -u +%Y%m%dT%H%M%SZ)
SPOT_FLAGS=()
if [ "$SPOT" = "1" ]; then
  SPOT_FLAGS=(--provisioning-model=SPOT --instance-termination-action=DELETE)
fi
echo "RUN=$RUN name=$NAME machine=$MACHINE zone=$ZONE cap=${MAXH}h workers=$WORKERS branch=$BRANCH spot=$SPOT"
gcloud compute instances create "$NAME" \
  --project="$PROJECT" --zone="$ZONE" \
  --machine-type="$MACHINE" "${SPOT_FLAGS[@]}" \
  --boot-disk-size=25GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
  --image-family=debian-12 --image-project=debian-cloud \
  --scopes=https://www.googleapis.com/auth/devstorage.read_write \
  --labels=project=sigil,purpose=puzzles \
  --metadata="run-id=$RUN,workers=$WORKERS,branch=$BRANCH,max-hours=$MAXH,corpus=$CORPUS,time-ms-1=$TIME_MS_1,time-ms-2=$TIME_MS_2,max-mate-2=$MAX_MATE_2" \
  --metadata-from-file="startup-script=$HERE/runner_puzzles.sh" \
  --format="value(name,status)"
echo "$RUN"
