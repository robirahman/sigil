#!/usr/bin/env bash
# Launch one SigilBench v3 job VM (startup script: bench/gcp/runner_v3.sh).
#   BRANCH=sigil-bench-v3 JOB=spike0 INPUTS="v3/in/a.json v3/in/b.txt" ARGS="..." SHARD=0/1 [PYTHON_BINDING=1] \
#     launch_v3.sh [name] [machine] [zone] [max-hours]
# Spot c3d-highcpu-90 by default, running as the keyless sigilbench-eval SA.
# PROVISIONING=STANDARD launches an on-demand VM instead (no preemption: the
# 2026-11-03 dev2verify Spot run was reclaimed after 2.4 h). An on-demand VM
# only STOPS when its watchdog fires: delete it afterwards.
# Outputs: gs://focus-surfer-494820-g0-sigilbench-private/runs/<run>/sNNNNN/ (newest = last).
# Delete the VM afterwards if it did not delete itself (Spot, termination action DELETE).
set -euo pipefail
NAME=${1:-sigil-v3-$(date -u +%m%d%H%M)}
MACHINE=${2:-c3d-highcpu-90}; ZONE=${3:-us-central1-f}; MAXH=${4:-3}
PROJECT=${PROJECT:-focus-surfer-494820-g0}
SA=${SA:-sigilbench-eval@focus-surfer-494820-g0.iam.gserviceaccount.com}
BRANCH=${BRANCH:?set BRANCH}; JOB=${JOB:?set JOB}; SHARD=${SHARD:-0/1}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
case "${PROVISIONING:-SPOT}" in
  SPOT) PROV_FLAGS="--provisioning-model=SPOT --instance-termination-action=DELETE" ;;
  STANDARD) PROV_FLAGS="--provisioning-model=STANDARD" ;;
  *) echo "PROVISIONING must be SPOT or STANDARD"; exit 2 ;;
esac
RUN=$(date -u +%Y%m%dT%H%M%SZ)-$NAME
echo "RUN=$RUN name=$NAME machine=$MACHINE zone=$ZONE cap=${MAXH}h branch=$BRANCH job=$JOB shard=$SHARD provisioning=${PROVISIONING:-SPOT}"
gcloud compute instances create "$NAME" --project="$PROJECT" --zone="$ZONE" --machine-type="$MACHINE" \
  $PROV_FLAGS \
  --boot-disk-size=30GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
  --image-family=debian-12 --image-project=debian-cloud \
  --service-account="$SA" --scopes=https://www.googleapis.com/auth/devstorage.read_write \
  --labels=project=sigil,purpose=sigilbench-v3 \
  --metadata="run-id=$RUN,branch=$BRANCH,job=$JOB,max-hours=$MAXH,shard=$SHARD,inputs=${INPUTS:-},args=${ARGS:-},python=${PYTHON_BINDING:-0}" \
  --metadata-from-file="startup-script=$HERE/runner_v3.sh" --format="value(name,status)"
echo "$RUN"
