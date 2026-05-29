#!/bin/bash
# Pipeline step: import human games from Firebase.
#
# Idempotent: re-running with the same date file appends only the games
# that haven't been processed yet (--resume in ai.import_human_games).
# A kill mid-write is recoverable — the next resume trims any partial
# trailing line before scanning for done game_ids.
#
# Output: ai/data/human/human_games_<YYYY-MM-DD>.jsonl
# Log:    logs/import_human.log (appended)

set -u
cd "$(dirname "$0")/../.."

PY=.venv/bin/python
LOG=logs/import_human.log
mkdir -p logs ai/data/human

TODAY=$(date +%Y-%m-%d)
FILE=ai/data/human/human_games_${TODAY}.jsonl

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
  --resume "$FILE" \
  >> "$LOG" 2>&1
RC=$?

{
  echo "=================================================================="
  echo " pipeline/import.sh finished at $(date) (exit=$RC)"
  echo "=================================================================="
} >> "$LOG"

exit $RC
