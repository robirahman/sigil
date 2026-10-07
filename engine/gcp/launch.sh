#!/usr/bin/env bash
# Launch one runner VM. Wraps the gcloud incantation so run ids, labels, the
# watchdog cap and the disk-delete-on-terminate flag cannot be forgotten.
#
#   launch.sh <name> <harness> <arms-file> <smoke-args> [workers] [zone] [max-hours] [machine-type]
#
# Cost is ~linear in vCPU-hours, so a wider fleet finishes sooner for the same money.
# The C3 regional quota is 300 vCPUs; running one 30-vCPU VM leaves 90% of it idle.
# Prefer fewer, BIGGER machines: each VM pays ~4 minutes of apt + rustup + cargo
# build before it does any work, so 3 x highcpu-90 beats 9 x highcpu-30.
#
# `arms-file` is passed via --metadata-from-file because arms contain commas, which
# gcloud's --metadata parser treats as key separators.
set -euo pipefail
NAME=$1; HARNESS=$2; ARMS_FILE=$3; SMOKE=$4
WORKERS=${5:-5}; ZONE=${6:-us-central1-f}; MAXH=${7:-4}
MACHINE=${8:-c3d-highcpu-30}
# Which slice of the shard space this VM takes. MUST differ per VM in a fleet:
# without it every VM derives its offsets from the worker index alone and they
# all run the same shards.
SHARD_BASE=${SHARD_BASE:-0}
# Seconds the smoke arm may take before it is killed. 900 suits a fast harness;
# a CHECK A smoke that scores at depth 6 needs more, and being killed there
# means the arms never launch at all.
SMOKE_TIMEOUT=${SMOKE_TIMEOUT:-900}
PROJECT=${PROJECT:-focus-surfer-494820-g0}
# SPOT=1 runs the VM on the Spot provisioning model: roughly a third of the
# on-demand price, drawn from the PREEMPTIBLE_CPUS quota (5,000 per region, not the
# 300-vCPU C3 one), but the VM can be reclaimed at any time. Use it for harnesses
# whose shards checkpoint (the runner ships .npz and logs every 2 minutes), so a
# preemption costs at most the unshipped tail; a preempted VM is deleted, not resumed.
SPOT_FLAGS=()
if [ "${SPOT:-0}" = 1 ]; then
  SPOT_FLAGS=(--provisioning-model=SPOT --instance-termination-action=DELETE)
fi
BRANCH=${BRANCH:-main}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# The VM name is part of the run id: two fleets launched in parallel can start a
# VM in the same second, and a bare timestamp then puts both in one GCS prefix.
RUN=$(date -u +%Y%m%dT%H%M%SZ)-$NAME

SMOKE_FILE=$(mktemp); printf '%s' "$SMOKE" > "$SMOKE_FILE"
echo "RUN=$RUN  name=$NAME  harness=$HARNESS  workers=$WORKERS  zone=$ZONE \
cap=${MAXH}h  machine=$MACHINE  shard_base=$SHARD_BASE  spot=${SPOT:-0}"
echo "arms: $(cat "$ARMS_FILE")"

gcloud compute instances create "$NAME" \
  --project="$PROJECT" --zone="$ZONE" \
  --machine-type="$MACHINE" "${SPOT_FLAGS[@]}" \
  --boot-disk-size=25GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
  --image-family=debian-12 --image-project=debian-cloud \
  --scopes=https://www.googleapis.com/auth/devstorage.read_write \
  --labels=project=sigil \
  --metadata="run-id=$RUN,workers=$WORKERS,branch=$BRANCH,harness=$HARNESS,max-hours=$MAXH,shard-base=$SHARD_BASE,smoke-timeout=$SMOKE_TIMEOUT,variant=${SIGIL_VARIANT:-standard},require-spell=${SIGIL_REQUIRE_SPELL:-},base-branch=${BASE_BRANCH:-},policy-weights=${SIGIL_POLICY_WEIGHTS:-},ab-base=${SIGIL_AB_BASE:-legacy},policy-mode=${SIGIL_POLICY:-off}" \
  --metadata-from-file="startup-script=$HERE/runner.sh,arms=$ARMS_FILE,smoke=$SMOKE_FILE" \
  --format="value(name,status)"
rm -f "$SMOKE_FILE"
echo "$RUN"
