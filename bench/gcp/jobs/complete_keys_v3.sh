#!/usr/bin/env bash
# Complete answer keys for winning-turn puzzles (bench/tools/complete_keys.py).
#   args: <puzzles file in $IN>
set -uo pipefail
cd "$(dirname "$0")/../../.."
[ -f "$IN/keys.jsonl" ] && cp "$IN/keys.jsonl" "$OUT/keys.jsonl"
python3 bench/tools/complete_keys.py "$IN/$1" --bin "$BIN" --out $OUT/keys.jsonl --workers ${WORKERS:-$(nproc)} > $OUT/keys.log 2>&1
tail -2 $OUT/keys.log
echo "complete_keys_v3 done"
