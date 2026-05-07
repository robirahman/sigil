#!/bin/bash
# Fast training loop for the hard model
# Each cycle: self-play → train → arena check
set -e

NUM_WORKERS=128
GAMES_PER_WORKER=2
SIMS=200
TRAIN_EPOCHS=5
ARENA_GAMES=100
ARENA_SIMS=100
TARGET_WINRATE=0.50
MAX_ITERATIONS=20

HARD_MODEL=ai/models/best_model_hard.pt
MEDIUM_MODEL=ai/models/best_model.pt
DATA_DIR=ai/data/hard

mkdir -p "$DATA_DIR"

# Combine any existing data
if ls ${DATA_DIR}/gen*_all.jsonl 1>/dev/null 2>&1; then
    EXISTING=$(cat ${DATA_DIR}/gen*_all.jsonl | wc -l)
    echo "Existing training data: $EXISTING positions"
fi

for iter in $(seq 1 $MAX_ITERATIONS); do
    echo ""
    echo "=========================================="
    echo "  ITERATION $iter"
    echo "=========================================="

    # --- Self-play ---
    echo "[$(date +%H:%M:%S)] Self-play: ${NUM_WORKERS} workers × ${GAMES_PER_WORKER} games × ${SIMS} sims..."
    rm -f ${DATA_DIR}/iter${iter}_w*.jsonl
    for i in $(seq 1 $NUM_WORKERS); do
        OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
        python3 -m ai.selfplay_mcts --net hard --games $GAMES_PER_WORKER --sims $SIMS \
            --model $HARD_MODEL \
            --output ${DATA_DIR}/iter${iter}_w${i}.jsonl \
            > /dev/null 2>&1 &
    done

    # Wait for all workers
    wait
    cat ${DATA_DIR}/iter${iter}_w*.jsonl > ${DATA_DIR}/iter${iter}_all.jsonl
    NEW_POS=$(wc -l < ${DATA_DIR}/iter${iter}_all.jsonl)
    TOTAL_POS=$(cat ${DATA_DIR}/*_all.jsonl | wc -l)
    echo "[$(date +%H:%M:%S)] Generated $NEW_POS new positions ($TOTAL_POS total)"

    # --- Train ---
    echo "[$(date +%H:%M:%S)] Training ${TRAIN_EPOCHS} epochs on GPU..."
    # Collect all training data: self-play + human games
    TRAIN_FILES=$(ls ${DATA_DIR}/*_all.jsonl ${DATA_DIR}/human_game_*.jsonl 2>/dev/null)
    python3 -m ai.train_sigil --net hard \
        --data $TRAIN_FILES \
        --model $HARD_MODEL \
        --output $HARD_MODEL \
        --epochs $TRAIN_EPOCHS \
        --batch-size 512 \
        --lr 0.001 \
        --device cuda 2>&1 | tail -2

    # --- Arena vs medium ---
    echo "[$(date +%H:%M:%S)] Arena: hard vs medium (${ARENA_GAMES} games, ${ARENA_SIMS} sims)..."
    OMP_NUM_THREADS=2 python3 -c "
from ai.sigil_net import SigilNet
from ai.sigil_net_hard import SigilNetHard
from ai.arena import evaluate_models

hard = SigilNetHard.load('$HARD_MODEL')
hard.eval()
medium = SigilNet.load('$MEDIUM_MODEL')
medium.eval()

w, l, d, wr = evaluate_models(hard, medium, num_games=$ARENA_GAMES, sims_per_move=$ARENA_SIMS)
print(f'Hard W={w} L={l} D={d} (win rate={wr:.3f})')

if wr > $TARGET_WINRATE:
    print('TARGET REACHED!')
    import sys; sys.exit(42)
else:
    print(f'Not yet — need >{$TARGET_WINRATE:.0%}')
" 2>&1
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 42 ]; then
        echo ""
        echo "=========================================="
        echo "  HARD MODEL BEATS MEDIUM! (iteration $iter)"
        echo "=========================================="
        exit 0
    fi

done

echo "Max iterations reached without hitting target."
exit 1
