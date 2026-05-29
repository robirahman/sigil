#!/bin/bash
# Pipeline step: run the self-play loop against the current best_model.pt.
#
# Self-play has a known memory leak that crashes its scope every ~80
# minutes; running it last and in its own systemd-run --user unit means
# that crash is contained — it can't take the import or promote with it.
# The loop itself writes timestamped per-iteration data files, so a crash
# loses at most the in-flight iteration.
#
# Input:  ai/models/best_model.pt
# Log:    logs/loop_main_post_bootstrap.log (appended)

set -u
cd "$(dirname "$0")/../.."

LOG=logs/loop_main_post_bootstrap.log
mkdir -p logs
export HIP_VISIBLE_DEVICES=0

{
  echo ""
  echo "=================================================================="
  echo " pipeline/selfplay.sh started at $(date)"
  echo "=================================================================="
} >> "$LOG"

# Delegate to the existing loop script. exec replaces this shell so the
# systemd unit's MainPID tracks the loop directly, not a wrapper bash.
exec ./train_selfplay_loop.sh >> "$LOG" 2>&1
