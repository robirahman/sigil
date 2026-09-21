#!/usr/bin/env bash
# Launch one game-evaluation VM (startup script: runner_evals.sh): the Rust
# engine scores every position of every recorded game in a pre-hydrated corpus
# at a fixed depth (engine/harness/eval_games.py eval), for game_evals/.
#
#   launch_evals.sh [name] [machine-type] [zone] [max-hours] [workers]
#
# Defaults: a Spot c3d-highcpu-90 in us-central1-f for at most 4 h, 88 worker
# processes. Depth 6 costs ~30 s per midgame position on one core (the first
# corpus was 10,344 positions), so the biggest C3D machine is the cheapest
# way to a full pass. The work file streams to
# gs://focus-surfer-494820-g0-sigil/runs/<run-id>/live/evals.jsonl every two
# minutes; collect it with
#   gcloud storage cp gs://focus-surfer-494820-g0-sigil/runs/<run-id>/live/evals.jsonl .
# and upload to Firebase with eval_games.py upload.
#
# The corpus must already be at gs://<bucket>/<CORPUS> (eval_games.py hydrate
# output). Environment overrides: PROJECT, BRANCH, CORPUS, DEPTH, TIME_MS
# (per-position cap; 0 = untimed), SPOT (1/0), RESUME (prior work file object),
# SHARD=k/n (one VM per k; every VM must get a different k).
set -euo pipefail
NAME=${1:-sigil-evals-$(date -u +%m%d%H%M)}
MACHINE=${2:-c3d-highcpu-90}; ZONE=${3:-us-central1-f}; MAXH=${4:-4}; WORKERS=${5:-88}
PROJECT=${PROJECT:-focus-surfer-494820-g0}
BRANCH=${BRANCH:-main}
CORPUS=${CORPUS:-data/eval_lines_2026-09-21.json}
DEPTH=${DEPTH:-6}; TIME_MS=${TIME_MS:-300000}
SPOT=${SPOT:-1}
RESUME=${RESUME:-}
SHARD=${SHARD:-}            # k/n to split the corpus across VMs (distinct k per VM!)
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN=$(date -u +%Y%m%dT%H%M%SZ)
SPOT_FLAGS=()
if [ "$SPOT" = "1" ]; then
  SPOT_FLAGS=(--provisioning-model=SPOT --instance-termination-action=DELETE)
fi
echo "RUN=$RUN name=$NAME machine=$MACHINE zone=$ZONE cap=${MAXH}h workers=$WORKERS branch=$BRANCH depth=$DEPTH time_ms=$TIME_MS spot=$SPOT"
gcloud compute instances create "$NAME" \
  --project="$PROJECT" --zone="$ZONE" \
  --machine-type="$MACHINE" "${SPOT_FLAGS[@]}" \
  --boot-disk-size=25GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
  --image-family=debian-12 --image-project=debian-cloud \
  --scopes=https://www.googleapis.com/auth/devstorage.read_write \
  --labels=project=sigil,purpose=evals \
  --metadata="run-id=$RUN,workers=$WORKERS,branch=$BRANCH,max-hours=$MAXH,corpus=$CORPUS,depth=$DEPTH,time-ms=$TIME_MS,resume=$RESUME,shard=$SHARD" \
  --metadata-from-file="startup-script=$HERE/runner_evals.sh" \
  --format="value(name,status)"
echo "$RUN"
