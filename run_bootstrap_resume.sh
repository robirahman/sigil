#!/bin/bash
# Resume the bootstrap pipeline starting at PHASE 2.
#
# Use this when PHASE 1 (the human-game import) has already produced a
# usable JSONL file (even if partial) and you want to skip straight to
# training the bootstrap candidate from it.
#
# Designed to run unattended in its own systemd --user scope so it isn't
# fate-shared with the previous terminal:
#   systemd-run --user --unit=sigil-bootstrap-resume \
#     --working-directory=/path/to/repo \
#     -- bash run_bootstrap_resume.sh
#
# Phases mirror run_bootstrap_pipeline.sh: train -> promote -> self-play.

set -u
cd "$(dirname "$0")"

PY=.venv/bin/python
LOG=logs/bootstrap_pipeline.log
mkdir -p logs
exec >> "$LOG" 2>&1
echo ""
echo "=================================================================="
echo " Bootstrap pipeline RESUMED at $(date) (skipping PHASE 1)"
echo "=================================================================="

export HIP_VISIBLE_DEVICES=0

HUMAN_FILE=$(ls -t ai/data/human/human_games_*.jsonl 2>/dev/null | head -1)
if [ -z "$HUMAN_FILE" ] || [ ! -s "$HUMAN_FILE" ]; then
  echo "ERROR: no human-game output file found in ai/data/human/; aborting."
  exit 1
fi
nrec=$(wc -l < "$HUMAN_FILE")
echo "[$(date +%T)] using human-game file: $HUMAN_FILE ($nrec records)"

# -------- 2. Supervised bootstrap train --------
echo ""
echo "[$(date +%T)] PHASE 2: bootstrap training (medium net)"
CAND=ai/models/candidate_bootstrap.pt
"$PY" -m ai.train_sigil_v2 --net medium \
  --human "$HUMAN_FILE" \
  --output "$CAND" \
  --epochs 25 --patience 5 \
  --min-elo 0 \
  --device cuda
TRAIN_EXIT=$?
if [ $TRAIN_EXIT -ne 0 ] || [ ! -f "$CAND" ]; then
  echo "ERROR: training failed (exit $TRAIN_EXIT) or no checkpoint produced; aborting."
  exit 2
fi
echo "[$(date +%T)] bootstrap training done -> $CAND"

# -------- 3. Snapshot + promote --------
echo ""
echo "[$(date +%T)] PHASE 3: snapshot + promote bootstrap"
cp "$CAND" ai/models/eval_medium_current.pt
if [ -f ai/models/best_model.pt ]; then
  cp ai/models/best_model.pt "ai/models/best_model_pre_bootstrap_$(date +%Y-%m-%d).pt"
fi
cp "$CAND" ai/models/best_model.pt
echo "[$(date +%T)] best_model.pt updated; backup saved to ai/models/best_model_pre_bootstrap_$(date +%Y-%m-%d).pt"

# -------- 4. Resume the self-play loop against the bootstrapped net --------
echo ""
echo "[$(date +%T)] PHASE 4: starting self-play loop (against bootstrapped model)"
echo "NOTE: self-play throughput is still limited by enumeration breadth on"
echo "      explosive positions (progressive widening deferred)."
nohup ./train_selfplay_loop.sh > logs/loop_main_post_bootstrap.log 2>&1 &
echo "[$(date +%T)] self-play loop launched (PID $!) -> logs/loop_main_post_bootstrap.log"

echo ""
echo "=================================================================="
echo " Pipeline finished at $(date)"
echo " Bootstrap candidate: $CAND"
echo " Snapshot for playtest: ai/models/eval_medium_current.pt"
echo " New best_model.pt is the bootstrap"
echo " Self-play loop running in background"
echo "=================================================================="
