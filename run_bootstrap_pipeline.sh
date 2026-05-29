#!/bin/bash
# Unattended pipeline: human-game import -> supervised bootstrap train ->
# promote to best_model.pt -> resume self-play loop.
#
# The import runs separately (already launched). This script waits for it
# to finish, then runs the train+promote+self-play chain. Designed to run
# overnight so the user can come back to a trained model and self-play
# generating data against it.
#
# Logs to logs/bootstrap_pipeline.log. Each phase is gated on the prior
# one succeeding; failures are reported and the chain halts (no
# silently-broken downstream work).
set -u
cd "$(dirname "$0")"

PY=.venv/bin/python
LOG=logs/bootstrap_pipeline.log
mkdir -p logs
exec > >(tee -a "$LOG") 2>&1
echo "=================================================================="
echo " Bootstrap pipeline started at $(date)"
echo "=================================================================="

export HIP_VISIBLE_DEVICES=0

# -------- 1. Wait for the human-game import to finish --------
echo ""
echo "[$(date +%T)] PHASE 1: waiting for human-game import"
while pgrep -f "ai.import_human_games" >/dev/null 2>&1; do
  sleep 60
done
echo "[$(date +%T)] import process finished"

HUMAN_FILE=$(ls -t ai/data/human/human_games_*.jsonl 2>/dev/null | head -1)
if [ -z "$HUMAN_FILE" ] || [ ! -s "$HUMAN_FILE" ]; then
  echo "ERROR: no human-game output file produced; aborting pipeline."
  exit 1
fi
nrec=$(wc -l < "$HUMAN_FILE")
echo "[$(date +%T)] human-game file: $HUMAN_FILE ($nrec records)"
echo "--- import stats (tail of import log) ---"
grep -E "Converted|skipped|match rate|player_elo|>= |played dates|annotated" \
  logs/import_human.log 2>/dev/null | tail -15

# -------- 2. Supervised bootstrap train (medium net, human data only) --------
echo ""
echo "[$(date +%T)] PHASE 2: bootstrap training (medium net)"
CAND=ai/models/candidate_bootstrap.pt
# Train from scratch (no --model): the existing best_model.pt is the
# <700-Elo net and not a useful starting point. Human + bot-winner data
# (--min-elo 0 keeps all, since bots have effective Elo and winners-only
# policy is automatic in the trainer).
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
# Snapshot for playtest comparison (lets user play the bootstrap explicitly
# via ?ckpt=snapshot in the playtest UI).
cp "$CAND" ai/models/eval_medium_current.pt
# Back up the pre-bootstrap best model in case the bootstrap is worse and
# we need to revert (unlikely given current net is ~700 Elo).
if [ -f ai/models/best_model.pt ]; then
  cp ai/models/best_model.pt "ai/models/best_model_pre_bootstrap_$(date +%Y-%m-%d).pt"
fi
cp "$CAND" ai/models/best_model.pt
echo "[$(date +%T)] best_model.pt updated; backup saved to ai/models/best_model_pre_bootstrap_$(date +%Y-%m-%d).pt"

# -------- 4. Resume the self-play loop against the bootstrapped net --------
echo ""
echo "[$(date +%T)] PHASE 4: starting self-play loop (against bootstrapped model)"
echo "NOTE: self-play throughput is still limited by enumeration breadth on"
echo "      explosive positions (progressive widening deferred). Expect slow"
echo "      iterations; the loop will produce some data overnight."
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
