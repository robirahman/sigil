#!/usr/bin/env bash
# One shard of a mate-in-k chaining pass (bench/tools/mine_mate_k.py solve) on a
# prepared candidate file ($IN/<first arg>): certificate (cert_tool make),
# independent Rust check, no mate in 1, and "no win within 2" for k >= 3.
#   args: <candidates file> <k> [cert_ms=1200000] [within2_ms=600000]
set -uo pipefail
cd "$(dirname "$0")/../../.."
CANDS=$IN/$1; K=$2; CMS=${3:-1200000}; W2=${4:-600000}
SAFE=${SHARD//\//of}
python3 bench/tools/mine_mate_k.py solve --k "$K" --candidates "$CANDS" --shard "$SHARD" \
  --work $OUT/m${K}_work_$SAFE.jsonl --workers ${WORKERS:-$(nproc)} --time-ms "$CMS" --within2-ms "$W2" \
  --tool $BIN/cert_tool > $OUT/chain_m${K}_$SAFE.log 2>&1
echo "chain_shard k=$K shard $SHARD done"
