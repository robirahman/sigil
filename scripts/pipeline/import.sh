#!/bin/bash
# Pipeline step: import human games from Firebase.
#
# Idempotent: re-running with the same output file appends only the
# (game, rotation) tasks that haven't been processed yet — dedup is by
# _gid (which carries a ':rN' suffix for non-identity rotations).
# A kill mid-write is recoverable: the next resume trims any partial
# trailing line before scanning for done tasks.
#
# Augmentation: --augment-rotations 3 multiplies the training set 3x via
# the board's 3-fold rotational symmetry (zone relabel a↔b↔c). Output
# filename gets an _aug3 suffix so the unaugmented file is preserved
# alongside.
#
# Output: ai/data/human/human_games_<YYYY-MM-DD>_aug3.jsonl
# Log:    logs/import_human.log (appended)

set -u
cd "$(dirname "$0")/../.."

PY=.venv/bin/python
LOG=logs/import_human.log
mkdir -p logs ai/data/human

TODAY=$(date +%Y-%m-%d)
ROTATIONS=3
FILE=ai/data/human/human_games_${TODAY}_aug${ROTATIONS}.jsonl

# Service account path is fixed for this workstation.
SA=/home/robi-rahman/Documents/firebase-service-account.json

{
  echo ""
  echo "=================================================================="
  echo " pipeline/import.sh started at $(date) (file=$FILE)"
  echo "=================================================================="
} >> "$LOG"

"$PY" -u -m ai.import_human_games \
  --service-account "$SA" \
  --jobs 2 \
  --game-timeout 300 \
  --augment-rotations "$ROTATIONS" \
  --resume "$FILE" \
  >> "$LOG" 2>&1
RC=$?

{
  echo "=================================================================="
  echo " pipeline/import.sh finished at $(date) (exit=$RC)"
  echo "=================================================================="
} >> "$LOG"

exit $RC
