#!/usr/bin/env bash
# Launch one deep-review VM (startup script: runner_deep_review.sh), one stage
# of engine/harness/deep_review.py's pipeline (see its docstring):
#
#   MODE=scan  CORPUS=data/deep_review/lines.json DEPTH=6 launch_deep_review.sh
#   MODE=probe CORPUS=... CASES=data/deep_review/cases.json DEPTH=8 TIME_MS=1800000 \
#       SHARD=0/3 launch_deep_review.sh sigil-deep-p0 c3d-highcpu-90 us-central1-f
#
#   launch_deep_review.sh [name] [machine-type] [zone] [max-hours] [workers]
#
# Defaults: a Spot c3d-highcpu-90 in us-central1-f for at most 4 h, 88 workers.
# Source: SRC=<object> (tar.gz of a working tree's engine/, see upload below)
# or BRANCH (cloned from GitHub). To run an unpushed tree, pack engine/ without
# target/ with Python's tarfile (GNU tar on the ChromeOS 9p mount reads short
# and pads every file with zeros) and copy it to the bucket:
#   python3 -c "import tarfile; t = tarfile.open('/tmp/src.tgz', 'w:gz'); \
#     t.add('engine', filter=lambda i: None if '/target' in i.name or '__pycache__' in i.name else i); t.close()"
#   gcloud storage cp /tmp/src.tgz gs://focus-surfer-494820-g0-sigil/data/deep_review/src.tgz
# Collect: gcloud storage cp gs://focus-surfer-494820-g0-sigil/runs/<run-id>/live/*.jsonl .
# One VM per SHARD k (distinct k!); C3 quota is 300 vCPUs per region.
set -euo pipefail
NAME=${1:-sigil-deep-$(date -u +%m%d%H%M)}
MACHINE=${2:-c3d-highcpu-90}; ZONE=${3:-us-central1-f}; MAXH=${4:-4}; WORKERS=${5:-88}
PROJECT=${PROJECT:-focus-surfer-494820-g0}
MODE=${MODE:-scan}; BRANCH=${BRANCH:-main}; SRC=${SRC:-}
CORPUS=${CORPUS:?CORPUS=<gcs object of the hydrated lines.json>}; CASES=${CASES:-}
DEPTH=${DEPTH:-6}; TIME_MS=${TIME_MS:-0}; SHARD=${SHARD:-}; RESUME=${RESUME:-}; WALK=${WALK:-backward}; KINDS=${KINDS:-}
SPOT=${SPOT:-1}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN=$(date -u +%Y%m%dT%H%M%SZ)-$NAME
SPOT_FLAGS=()
if [ "$SPOT" = "1" ]; then
  SPOT_FLAGS=(--provisioning-model=SPOT --instance-termination-action=DELETE)
fi
echo "RUN=$RUN name=$NAME machine=$MACHINE zone=$ZONE cap=${MAXH}h mode=$MODE depth=$DEPTH time_ms=$TIME_MS shard=${SHARD:-all} src=${SRC:-$BRANCH}"
gcloud compute instances create "$NAME" \
  --project="$PROJECT" --zone="$ZONE" \
  --machine-type="$MACHINE" "${SPOT_FLAGS[@]}" \
  --boot-disk-size=25GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
  --image-family=debian-12 --image-project=debian-cloud \
  --scopes=https://www.googleapis.com/auth/devstorage.read_write \
  --labels=project=sigil,purpose=deep-review \
  --metadata="run-id=$RUN,mode=$MODE,branch=$BRANCH,src=$SRC,workers=$WORKERS,max-hours=$MAXH,corpus=$CORPUS,cases=$CASES,depth=$DEPTH,time-ms=$TIME_MS,shard=$SHARD,resume=$RESUME,walk=$WALK,kinds=$KINDS" \
  --metadata-from-file="startup-script=$HERE/runner_deep_review.sh" \
  --format="value(name,status)"
echo "$RUN"
