#!/bin/bash
# Sigil bootstrap pipeline orchestrator.
#
# Each step runs in its own systemd-run --user transient unit so a memory
# leak or crash in one step is contained to its own scope and can't take
# the others down with it. Steps that produce inputs for later steps
# (import, train, promote) run with --wait so the orchestrator can gate
# on their exit code. selfplay is fire-and-forget — it runs indefinitely
# and crashes periodically until the leak is fixed.
#
# Usage:
#   ./run_pipeline.sh import     # just the human-game import (resumable)
#   ./run_pipeline.sh train      # train bootstrap from latest data
#   ./run_pipeline.sh promote    # promote candidate to best_model.pt
#   ./run_pipeline.sh selfplay   # launch the self-play loop
#   ./run_pipeline.sh all        # import -> train -> promote -> selfplay
#
# Each step is independently idempotent — re-running any one is safe and
# does not redo finished work. See scripts/pipeline/*.sh for the per-step
# semantics.

set -u
cd "$(dirname "$0")"
REPO="$(pwd)"

usage() {
  cat <<EOF
usage: $0 [import|train|promote|selfplay|all]

  import     human-game import from Firebase (resumable, skips done games)
  train      bootstrap supervised training from latest human-games file
  promote    copy candidate to best_model.pt (with first-of-day backup)
  selfplay   launch the self-play loop (fire-and-forget; runs indefinitely)
  all        run import -> train -> promote -> selfplay, gating on each
EOF
}

# Run a step in a transient user unit, blocking until it exits, returning
# its exit code. Resets a stale failed unit of the same name first so
# repeated invocations don't error out on "unit already exists".
run_step_wait() {
  local name=$1
  local unit="sigil-pipeline-$name"
  local script="$REPO/scripts/pipeline/$name.sh"

  systemctl --user reset-failed "$unit" 2>/dev/null || true
  systemctl --user stop "$unit" 2>/dev/null || true

  echo "[$(date +%T)] === starting step: $name (unit=$unit) ==="
  systemd-run --user --wait --quiet --unit="$unit" \
    --working-directory="$REPO" \
    --setenv=HIP_VISIBLE_DEVICES=0 \
    -- bash "$script"
  local rc=$?
  echo "[$(date +%T)] === step $name finished (exit=$rc) ==="
  return $rc
}

# Launch self-play and return immediately. The unit keeps running after
# this script exits. Logs go to logs/loop_main_post_bootstrap.log.
run_step_detached() {
  local name=$1
  local unit="sigil-pipeline-$name"
  local script="$REPO/scripts/pipeline/$name.sh"

  systemctl --user reset-failed "$unit" 2>/dev/null || true
  systemctl --user stop "$unit" 2>/dev/null || true

  echo "[$(date +%T)] === launching detached step: $name (unit=$unit) ==="
  systemd-run --user --quiet --unit="$unit" \
    --working-directory="$REPO" \
    --setenv=HIP_VISIBLE_DEVICES=0 \
    -- bash "$script"
  local rc=$?
  echo "[$(date +%T)] === step $name launched (rc=$rc; runs in background) ==="
  return $rc
}

case "${1:-}" in
  import|train|promote)
    run_step_wait "$1"
    ;;
  selfplay)
    run_step_detached "$1"
    ;;
  all)
    run_step_wait import   || { echo "import failed, halting" >&2; exit 1; }
    run_step_wait train    || { echo "train failed, halting"  >&2; exit 2; }
    run_step_wait promote  || { echo "promote failed, halting" >&2; exit 3; }
    run_step_detached selfplay
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "unknown step: $1" >&2
    usage >&2
    exit 64
    ;;
esac
