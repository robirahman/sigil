#!/usr/bin/env bash
# Launch the Step 5 GPU trainer (runner_nn.sh) on one Spot L4 VM.
#
#   launch_nn.sh <name> <zone> [max-hours] [machine]
#
# Env: BRANCH (default train-s5-nneval), DATA (v2 chunk prefix), PREP (gs:// path
# of the prepped npz: reused if present, written otherwise), LAMS, EPOCHS.
# Spot: a preempted VM is deleted; relaunching reuses the prepped npz, so a
# preemption costs at most the training in flight.
set -euo pipefail
NAME=$1; ZONE=$2; MAXH=${3:-5}; MACHINE=${4:-g2-standard-16}
PROJECT=${PROJECT:-focus-surfer-494820-g0}
BRANCH=${BRANCH:-train-s5-nneval}
DATA=${DATA:-gs://focus-surfer-494820-g0-sigil/data/s3/v2_2026-10-06/d4}
PREP=${PREP:-gs://focus-surfer-494820-g0-sigil/data/s5/prep_v2_d4.npz}
LAMS=${LAMS:-0 0.25 0.5 0.75 1}
EPOCHS=${EPOCHS:-6}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN=$(date -u +%Y%m%dT%H%M%SZ)-$NAME
echo "RUN=$RUN zone=$ZONE machine=$MACHINE cap=${MAXH}h"
gcloud compute instances create "$NAME" \
  --project="$PROJECT" --zone="$ZONE" --machine-type="$MACHINE" \
  --provisioning-model=SPOT --instance-termination-action=DELETE \
  --maintenance-policy=TERMINATE \
  --image-family=pytorch-2-9-cu129-ubuntu-2204-nvidia-580 \
  --image-project=deeplearning-platform-release \
  --boot-disk-size=200GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
  --scopes=https://www.googleapis.com/auth/devstorage.read_write \
  --labels=project=sigil \
  --metadata="run-id=$RUN,branch=$BRANCH,max-hours=$MAXH,data=$DATA,prep=$PREP,lams=$LAMS,epochs=$EPOCHS,install-nvidia-driver=True" \
  --metadata-from-file="startup-script=$HERE/runner_nn.sh" \
  --format="value(name,status)"
echo "$RUN"
