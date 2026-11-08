#!/usr/bin/env bash
# Gather a runner_v3 run's outputs: the newest copy of every file (the highest
# sNNNNN prefix holding it) into <dest>.
#   bench/gcp/collect_v3.sh <run-id> <dest>
set -euo pipefail
RUN=$1; DEST=$2; B=gs://focus-surfer-494820-g0-sigilbench-private/runs/$RUN
mkdir -p "$DEST"
gsutil ls "$B/**" | grep -E '/s[0-9]{5}/' | sort | awk -F/ '{f=$NF; last[f]=$0} END {for (f in last) print last[f]}' \
  | xargs -P 8 -I{} gsutil -q cp {} "$DEST/"
ls "$DEST" | head -50
