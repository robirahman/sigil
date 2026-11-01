#!/usr/bin/env bash
# Launch one SigilBench engine-baseline VM (startup script: runner_engine_baseline.sh).
#   BRANCH=... PUZZLES=dev/dev_set_v2.json IDS=sbdev2-001,... TIER=very_hard WORKERS=44 \
#     launch_engine_baseline.sh <name> [machine] [zone] [max-hours]
# Spot c3d-highcpu-90 by default (45 cores: one 60 s search per core). Collect
# gs://focus-surfer-494820-g0-sigil/runs/<run>/live/<name>/ ; teardown: engine/gcp/teardown.sh.
set -euo pipefail
NAME=${1:?name}; MACHINE=${2:-c3d-highcpu-90}; ZONE=${3:-us-central1-f}; MAXH=${4:-3}
PROJECT=${PROJECT:-focus-surfer-494820-g0}
BRANCH=${BRANCH:?}; PUZZLES=${PUZZLES:?}; IDS=${IDS:-}; TIER=${TIER:-very_hard}; WORKERS=${WORKERS:-44}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN=$(date -u +%Y%m%dT%H%M%SZ)-$NAME
# Commas in IDS would split the metadata string: pass it from a file.
MD=$(mktemp); printf '%s' "$IDS" > "$MD"
gcloud compute instances create "$NAME" --project="$PROJECT" --zone="$ZONE" --machine-type="$MACHINE" \
  --provisioning-model=SPOT --instance-termination-action=DELETE \
  --boot-disk-size=25GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
  --image-family=debian-12 --image-project=debian-cloud \
  --scopes=https://www.googleapis.com/auth/devstorage.read_write --labels=project=sigil,purpose=engbase \
  --metadata="run-id=$RUN,branch=$BRANCH,max-hours=$MAXH,puzzles=$PUZZLES,tier=$TIER,workers=$WORKERS,name=$NAME" \
  --metadata-from-file="startup-script=$HERE/runner_engine_baseline.sh,ids=$MD" --format="value(name,status)"
rm -f "$MD"
echo "$RUN"
