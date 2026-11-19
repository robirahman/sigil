#!/usr/bin/env bash
# Engine difficulty ladder for SigilBench v3 candidates (bench/tools/ladder_v3.py).
# Needs the Python binding (python=1). Resumes from $IN/ladder.jsonl if passed.
#   args: <items file> [depths=1,2,3,4,5,6] [times=1000,10000]
set -uo pipefail
cd "$(dirname "$0")/../../.."
[ -f "$IN/ladder.jsonl" ] && cp "$IN/ladder.jsonl" "$OUT/ladder.jsonl"
python3 bench/tools/ladder_v3.py "$IN/$1" --out $OUT/ladder.jsonl --workers ${WORKERS:-$(nproc)} \
  --depths "${2:-1,2,3,4,5,6}" --times "${3:-1000,10000}" > $OUT/ladder.log 2>&1
tail -2 $OUT/ladder.log
echo "ladder_v3 done"
