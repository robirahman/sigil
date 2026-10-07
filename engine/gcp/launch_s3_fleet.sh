#!/usr/bin/env bash
# Step 3 data fleet (2026-10 training plan): N Spot VMs running selfplay_v2.py.
#
#   launch_s3_fleet.sh <depth> <stop_after_s> <max_hours> <zone>:<count>[:<machine>] ...
#
# e.g. launch_s3_fleet.sh 5 18000 6 us-central1-a:4 northamerica-south1-a:4:c3d-highcpu-90
#
# Each VM runs one arm with WORKERS = its vCPU count (one shard per vCPU; the
# measured rate is per vCPU at that load). SHARD_BASE steps by 200 per VM, so
# with <= 200 shards per VM no two shards anywhere share a seed offset; the
# harness keeps games < 1000 per shard, so seeds never overlap either. VMs are
# named sigil-s3-<n> and never touched by anything but their own lifecycle:
# DO NOT run teardown.sh while other workers have VMs up.
#
# Spot VMs draw on PREEMPTIBLE_CPUS (5,000 per region), not the 300-vCPU C3
# quota (checked 2026-10-06: a c3d Spot VM moved PREEMPTIBLE_CPUS, not C3_CPUS).
set -euo pipefail
DEPTH=$1; STOP=$2; MAXH=$3; shift 3
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LINES=${LINES_GS:-gs://focus-surfer-494820-g0-sigil/data/s3/human_starts_2026-10-06.json}
FIRST=${FIRST_VM:-0}
PREFIX=${VM_PREFIX:-sigil-s3}   # round 2 (v25 data): VM_PREFIX=sigil-r2d FIRST_VM=100
ARMS=$(mktemp)
printf '%s' "1000,$DEPTH,/opt/sigil/out/data,0.10,0.08,0.5,$LINES,$STOP,8" > "$ARMS"
SMOKE="2,3,/opt/sigil/out/smoke,0.5,0.08,0.5,$LINES,0,4"
i=$FIRST
for spec in "$@"; do
  IFS=: read -r zone count machine <<< "$spec"
  machine=${machine:-c3d-highcpu-90}
  vcpus=${machine##*-}
  for ((k=0; k<count; k++)); do
    SPOT=1 BRANCH=${BRANCH:-train-s3-data-v2} SHARD_BASE=$((i * 200)) SMOKE_TIMEOUT=900 \
      bash "$HERE/launch.sh" "$PREFIX-$i" selfplay_v2.py "$ARMS" "$SMOKE" "$vcpus" "$zone" "$MAXH" "$machine" \
      2>&1 | grep -E '^RUN=|RUNNING|ERROR|^[0-9]{8}T' || echo "LAUNCH FAILED $PREFIX-$i $zone"
    i=$((i + 1))
  done
done
rm -f "$ARMS"
