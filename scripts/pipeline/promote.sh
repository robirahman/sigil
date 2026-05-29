#!/bin/bash
# Pipeline step: promote the bootstrap candidate to best_model.pt.
#
# Idempotent: the dated backup is created only on the FIRST promote of the
# day — subsequent runs leave it alone so the pre-bootstrap snapshot is
# preserved even if the candidate is regenerated and re-promoted. The
# best / snapshot copies are refreshed via tempfile + atomic rename, so a
# kill mid-copy can't leave a half-written .pt at the published path.
#
# Input:  ai/models/candidate_bootstrap.pt
# Output: ai/models/best_model.pt, ai/models/eval_medium_current.pt,
#         ai/models/best_model_pre_bootstrap_<YYYY-MM-DD>.pt (first run only)
# Log:    logs/promote.log (appended)

set -u
cd "$(dirname "$0")/../.."

LOG=logs/promote.log
mkdir -p logs ai/models

CAND=ai/models/candidate_bootstrap.pt
BEST=ai/models/best_model.pt
SNAP=ai/models/eval_medium_current.pt
BACKUP=ai/models/best_model_pre_bootstrap_$(date +%Y-%m-%d).pt

{
  echo ""
  echo "=================================================================="
  echo " pipeline/promote.sh started at $(date)"
  echo "=================================================================="
} >> "$LOG"

if [ ! -f "$CAND" ]; then
  echo "ERROR: no candidate at $CAND" >> "$LOG"
  exit 1
fi

# First-promote-of-the-day backup; subsequent runs preserve it.
if [ -f "$BACKUP" ]; then
  echo "backup already exists at $BACKUP — leaving in place" >> "$LOG"
elif [ -f "$BEST" ]; then
  cp "$BEST" "$BACKUP.tmp" && mv "$BACKUP.tmp" "$BACKUP"
  echo "backup saved -> $BACKUP" >> "$LOG"
else
  echo "no prior $BEST to back up" >> "$LOG"
fi

# Atomic refresh of best + snapshot.
cp "$CAND" "$BEST.tmp" && mv "$BEST.tmp" "$BEST"
cp "$CAND" "$SNAP.tmp" && mv "$SNAP.tmp" "$SNAP"
echo "promoted $CAND -> $BEST and $SNAP" >> "$LOG"

{
  echo "=================================================================="
  echo " pipeline/promote.sh finished at $(date) (exit=0)"
  echo "=================================================================="
} >> "$LOG"
