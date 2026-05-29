#!/bin/bash
# Pipeline step: train the bootstrap candidate from the latest human-games
# JSONL.
#
# Idempotent: re-running overwrites ai/models/candidate_bootstrap.pt. The
# save itself is atomic (train_sigil_v2.py writes to .tmp then renames),
# so a kill mid-save can't leave a half-written .pt that downstream
# torch.load would silently accept.
#
# Input:  latest ai/data/human/human_games_*.jsonl
# Output: ai/models/candidate_bootstrap.pt
# Log:    logs/train_bootstrap.log (appended)

set -u
cd "$(dirname "$0")/../.."

PY=.venv/bin/python
LOG=logs/train_bootstrap.log
mkdir -p logs ai/models
export HIP_VISIBLE_DEVICES=0

FILE=$(ls -t ai/data/human/human_games_*.jsonl 2>/dev/null | head -1)
CAND=ai/models/candidate_bootstrap.pt

{
  echo ""
  echo "=================================================================="
  echo " pipeline/train.sh started at $(date)"
  echo "=================================================================="
} >> "$LOG"

if [ -z "$FILE" ] || [ ! -s "$FILE" ]; then
  echo "ERROR: no human-games file in ai/data/human/" >> "$LOG"
  exit 1
fi
NREC=$(wc -l < "$FILE")
echo "training on $FILE ($NREC positions)" >> "$LOG"

"$PY" -u -m ai.train_sigil_v2 --net medium \
  --human "$FILE" \
  --output "$CAND" \
  --epochs 25 --patience 5 \
  --min-elo 0 \
  --device cuda \
  >> "$LOG" 2>&1
RC=$?

if [ $RC -eq 0 ] && [ ! -f "$CAND" ]; then
  echo "ERROR: trainer reported success but $CAND was not produced" >> "$LOG"
  RC=2
fi

{
  echo "=================================================================="
  echo " pipeline/train.sh finished at $(date) (exit=$RC)"
  echo "=================================================================="
} >> "$LOG"

exit $RC
