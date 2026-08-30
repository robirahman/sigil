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
PROJECT=${PROJECT:-focus-surfer-494820-g0}
BRANCH=${BRANCH:-rust-bitboard-engine}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RUN=$(date -u +%Y%m%dT%H%M%SZ)

SMOKE_FILE=$(mktemp); printf '%s' "$SMOKE" > "$SMOKE_FILE"
echo "RUN=$RUN  name=$NAME  harness=$HARNESS  workers=$WORKERS  zone=$ZONE  cap=${MAXH}h  machine=$MACHINE"
echo "arms: $(cat "$ARMS_FILE")"

gcloud compute instances create "$NAME" \
  --project="$PROJECT" --zone="$ZONE" \
  --machine-type="$MACHINE" \
  --boot-disk-size=25GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
  --image-family=debian-12 --image-project=debian-cloud \
  --scopes=https://www.googleapis.com/auth/devstorage.read_write \
  --labels=project=sigil \
  --metadata="run-id=$RUN,workers=$WORKERS,branch=$BRANCH,harness=$HARNESS,max-hours=$MAXH" \
  --metadata-from-file="startup-script=$HERE/runner.sh,arms=$ARMS_FILE,smoke=$SMOKE_FILE" \
  --format="value(name,status)"
rm -f "$SMOKE_FILE"
echo "$RUN"
