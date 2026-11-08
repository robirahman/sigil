#!/usr/bin/env bash
# Playouts for root tables already computed ($IN/tables*.jsonl): verdicts with
# bench/tools/win_puzzle.py (at most 2 keys and the 3 best alternatives per
# position), then Very Hard vs Very Hard playouts.
#   args: [games=6] [ms=10000]
set -uo pipefail
cd "$(dirname "$0")/../../.."
GAMES=${1:-6}; MS=${2:-10000}
W=${WORKERS:-$(nproc)}
cat $IN/tables*.jsonl > $OUT/tables_all.jsonl
python3 bench/tools/win_puzzle.py $OUT/tables_all.jsonl --out $OUT/verdicts.jsonl > $OUT/verdicts.log 2>&1
python3 bench/tools/win_playouts.py $OUT/verdicts.jsonl --out $OUT/playouts.jsonl --games "$GAMES" --ms "$MS" \
  --workers "$W" > $OUT/playouts.log 2>&1
python3 bench/tools/win_playouts.py $OUT/verdicts.jsonl --out $OUT/playouts.jsonl --summary > $OUT/playout_summary.jsonl
echo "winplay done"
