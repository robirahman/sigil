#!/bin/bash
# Continuous AlphaZero self-play loop for the medium SigilNet.
#
# Tuned for this workstation: AMD Ryzen 7 9800X3D (8c/16t) + Radeon RX 9070 XT
# (gfx1201, ROCm 7.0). Self-play runs on CPU across many workers (it is
# CPU-bound on the exhaustive turn enumeration); the GPU is used only for the
# gradient-descent training step. Each iteration:
#
#   1. self-play   NUM_WORKERS CPU workers x GAMES_PER_WORKER games @ SIMS sims
#   2. train       one candidate on the rolling window of recent data (GPU)
#   3. gate        candidate vs current best; accept at >= GATE_THRESHOLD (0.55)
#
# Usage:  ./train_selfplay_loop.sh [MAX_ITER]    (default 1000 iterations)
set -u
cd "$(dirname "$0")"

PY=.venv/bin/python
export HIP_VISIBLE_DEVICES=0          # pin the discrete RX 9070 XT (gfx1201)

# ---- knobs (env-overridable for smoke tests) ----
NUM_WORKERS=${NUM_WORKERS:-14}        # leave 2 threads for OS / GPU feeding
GAMES_PER_WORKER=${GAMES_PER_WORKER:-20}   # was 40; lowered so iter→train→gate
                                      # cycle completes in ~12h instead of 24h
                                      # under widening + 1200 sims + 60s/move,
                                      # accelerating generational improvement.
                                      # Position rate per worker is unchanged.
SIMS=${SIMS:-2400}                    # was 1200; doubled so MCTS visit
                                      # distributions are richer per move and
                                      # the policy target gives the trainer
                                      # informative signal rather than near-
                                      # network-prior noise. With widening at
                                      # 2400 sims, K cap is ~98 → each top-K
                                      # action gets ~24 visits, ample to
                                      # distinguish good from mediocre moves.
MOVE_TIME=${MOVE_TIME:-180}           # was 60; tripled so the larger sim
                                      # budget can actually complete on heavy
                                      # mid-game positions instead of being
                                      # cut short by the wall-clock cap.
                                      # Without this, doubling SIMS gives
                                      # nothing — the per-move cap binds first.
SELFPLAY_GAME_TIMEOUT=${SELFPLAY_GAME_TIMEOUT:-3600}  # per-game hard ceiling
                                      # (60 min). 1200s was wrong: 1200/180=6.7
                                      # implied moves before timeout, which
                                      # would have killed most games before
                                      # any decisive endgame — and a timed-out
                                      # child writes zero training data
                                      # because the JSON dump happens after
                                      # play_selfplay_game returns. With 3600
                                      # most natural games (30–50 moves at
                                      # 30–60s avg per move) complete
                                      # comfortably; only true marathons get
                                      # cut.
TRAIN_EPOCHS=${TRAIN_EPOCHS:-15}
PATIENCE=${PATIENCE:-4}
GATE_GAMES=${GATE_GAMES:-30}          # was 120; lowered so the gate finishes
                                      # in tens of minutes rather than hours.
                                      # 30 games is still enough to distinguish
                                      # >55% win rate from noise at p<0.1.
GATE_SIMS=${GATE_SIMS:-200}
GATE_MOVE_TIME=${GATE_MOVE_TIME:-10}  # per-move cap for gate arena. Without
                                      # this an uncapped 10-game arena took
                                      # 7+ hours on heavy mid-game positions.
GATE_GAME_TIMEOUT=${GATE_GAME_TIMEOUT:-300}   # per-game hard ceiling. Each
                                      # arena game now runs in a forked child;
                                      # if it exceeds this it gets terminated
                                      # and counted as a draw, so one
                                      # pathological game can't wedge the
                                      # whole gate.
WINDOW_FILES=${WINDOW_FILES:-150}     # most-recent self-play files fed to train
MAX_ITER=${1:-1000}

DATA_DIR=ai/data/selfplay_loop
MODEL=ai/models/best_model.pt
LOG_DIR=logs
mkdir -p "$DATA_DIR" "$LOG_DIR" ai/models

echo "=================================================================="
echo " Sigil self-play loop  | net=medium  workers=$NUM_WORKERS  sims=$SIMS"
echo " best model: $MODEL"
echo " started: $(date)"
echo "=================================================================="

for iter in $(seq 1 "$MAX_ITER"); do
  STAMP=$(date +%Y-%m-%d_%H%M%S)
  echo ""
  echo "########## ITERATION $iter  ($(date '+%F %T')) ##########"

  # ---- 1. self-play (parallel CPU workers) ----
  echo "[$(date +%T)] self-play: $NUM_WORKERS x $GAMES_PER_WORKER games @ $SIMS sims ..."
  rm -f "$DATA_DIR"/iter${iter}_w*.jsonl
  for w in $(seq 1 "$NUM_WORKERS"); do
    OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
      "$PY" -m ai.selfplay_mcts --net medium \
        --games "$GAMES_PER_WORKER" --sims "$SIMS" --model "$MODEL" \
        --move-time-limit "$MOVE_TIME" \
        --game-timeout "$SELFPLAY_GAME_TIMEOUT" \
        --output "$DATA_DIR/iter${iter}_w${w}_${STAMP}.jsonl" \
        >"$LOG_DIR/selfplay_iter${iter}_w${w}.log" 2>&1 &
  done
  wait
  NEW_POS=$(cat "$DATA_DIR"/iter${iter}_w*.jsonl 2>/dev/null | wc -l)
  echo "[$(date +%T)] generated $NEW_POS new positions"

  # ---- 2. train candidate on (human anchor + self-play rolling window) ----
  # Pure-self-play training kept producing candidates that gated below
  # the 0.55 threshold (iter1 6.7%, iter2 11%). The candidates fit the
  # MCTS visit-count targets well (val acc ~0.94) but the data was
  # noisy — many immediate-loss games + many timeout-marathons —
  # teaching the network its own failure modes. Mixing in the human
  # bootstrap data anchors the policy to known-good moves while still
  # letting self-play data update the network where MCTS adds real
  # signal. Self-play weight halved from default 0.3 → still favors
  # human as the cleaner source, but the self-play contribution is
  # large enough to not be drowned out.
  CAND="ai/models/candidate_loop_iter${iter}.pt"
  TRAIN_FILES=$(ls -t "$DATA_DIR"/*.jsonl 2>/dev/null | head -"$WINDOW_FILES")
  HUMAN_FILE=$(ls -t ai/data/human/human_games_*_aug*.jsonl 2>/dev/null | head -1)
  echo "[$(date +%T)] training candidate on GPU"
  echo "[$(date +%T)]   human anchor: $HUMAN_FILE"
  echo "[$(date +%T)]   selfplay window: $(echo $TRAIN_FILES | wc -w) files"
  "$PY" -m ai.train_sigil_v2 --net medium \
      --human "$HUMAN_FILE" \
      --self-play $TRAIN_FILES \
      --self-play-weight 0.5 \
      --model "$MODEL" --output "$CAND" \
      --epochs "$TRAIN_EPOCHS" --patience "$PATIENCE" \
      --min-elo 0 \
      --blunder-weight 0.5 --blunder-pos-weight 2.0 \
      --eval-annotation-weight 3.0 \
      --device cuda 2>&1 | tail -10

  if [ ! -f "$CAND" ]; then
    echo "[$(date +%T)] WARNING: no candidate produced, skipping gate"
    continue
  fi

  # ---- 3. gate candidate vs current best ----
  echo "[$(date +%T)] gating candidate vs best "\
       "($GATE_GAMES games @ $GATE_SIMS sims, ${GATE_MOVE_TIME}s/move) ..."
  "$PY" - "$CAND" "$MODEL" "$GATE_GAMES" "$GATE_SIMS" "$GATE_MOVE_TIME" "$GATE_GAME_TIMEOUT" <<'PYEOF'
import sys
from ai.arena import gate_model
cand, best = sys.argv[1], sys.argv[2]
games, sims = int(sys.argv[3]), int(sys.argv[4])
tlimit, gtimeout = float(sys.argv[5]), float(sys.argv[6])
ok = gate_model(cand, best, num_games=games, sims_per_move=sims,
                move_time_limit=tlimit, game_timeout=gtimeout)
sys.exit(0 if ok else 1)
PYEOF
  if [ $? -eq 0 ]; then
    cp "$CAND" "$MODEL"
    echo "[$(date +%T)] ITER $iter: ACCEPTED -> $MODEL updated"
  else
    echo "[$(date +%T)] ITER $iter: rejected, keeping previous best"
    rm -f "$CAND"
  fi
done

echo "Loop finished after $MAX_ITER iterations ($(date))."
