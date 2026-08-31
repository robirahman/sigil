#!/usr/bin/env bash
# launch_analyze.sh <name> <run-id> <script> [script-args] [zone] [max-hours] [machine]
# One-shot analysis VM. See analyze.sh for why this is not runner.sh.
set -euo pipefail
NAME=$1; RUNID=$2; SCRIPT=$3; SARGS=${4:-}; ZONE=${5:-us-central1-a}
MAXH=${6:-2}; MACHINE=${7:-n2-highmem-16}
PROJECT=${PROJECT:-focus-surfer-494820-g0}
BRANCH=${BRANCH:-main}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
echo "analyze $NAME run=$RUNID script=$SCRIPT args='$SARGS' zone=$ZONE machine=$MACHINE"
gcloud compute instances create "$NAME" \
  --project="$PROJECT" --zone="$ZONE" --machine-type="$MACHINE" \
  --boot-disk-size=100GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
  --image-family=debian-12 --image-project=debian-cloud \
  --scopes=https://www.googleapis.com/auth/devstorage.read_write \
  --labels=project=sigil \
  --metadata="run-id=$RUNID,branch=$BRANCH,script=$SCRIPT,script-args=$SARGS,max-hours=$MAXH" \
  --metadata-from-file="startup-script=$HERE/analyze.sh" \
  --format="value(name,status)"
