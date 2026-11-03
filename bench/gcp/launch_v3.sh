#!/usr/bin/env bash
# Launch one SigilBench v3 job VM (startup script: bench/gcp/runner_v3.sh).
#   BRANCH=sigil-bench-v3 JOB=spike0 INPUTS="v3/in/a.json v3/in/b.txt" ARGS="..." SHARD=0/1 \
#     launch_v3.sh [name] [machine] [zone] [max-hours]
# Spot c3d-highcpu-90 by default, running as the keyless sigilbench-eval SA.
# Outputs: gs://focus-surfer-494820-g0-sigilbench-private/runs/<run>/sNNNNN/ (newest = last).
# Delete the VM afterwards if it did not delete itself (Spot, termination action DELETE).
set -euo pipefail
NAME=${1:-sigil-v3-$(date -u +%m%d%H%M)}
MACHINE=${2:-c3d-highcpu-90}; ZONE=${3:-us-central1-f}; MAXH=${4:-3}
PROJECT=${PROJECT:-focus-surfer-494820-g0}
SA=${SA:-sigilbench-eval@focus-surfer-494820-g0.iam.gserviceaccount.com}
BRANCH=${BRANCH:?set BRANCH}; JOB=${JOB:?set JOB}; SHARD=${SHARD:-0/1}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN=$(date -u +%Y%m%dT%H%M%SZ)-$NAME
echo "RUN=$RUN name=$NAME machine=$MACHINE zone=$ZONE cap=${MAXH}h branch=$BRANCH job=$JOB shard=$SHARD"
gcloud compute instances create "$NAME" --project="$PROJECT" --zone="$ZONE" --machine-type="$MACHINE" \
  --provisioning-model=SPOT --instance-termination-action=DELETE \
  --boot-disk-size=30GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
  --image-family=debian-12 --image-project=debian-cloud \
  --service-account="$SA" --scopes=https://www.googleapis.com/auth/devstorage.read_write \
  --labels=project=sigil,purpose=sigilbench-v3 \
  --metadata="run-id=$RUN,branch=$BRANCH,job=$JOB,max-hours=$MAXH,shard=$SHARD,inputs=${INPUTS:-},args=${ARGS:-}" \
  --metadata-from-file="startup-script=$HERE/runner_v3.sh" --format="value(name,status)"
echo "$RUN"
