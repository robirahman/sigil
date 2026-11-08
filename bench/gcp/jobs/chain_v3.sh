#!/usr/bin/env bash
# SigilBench v3 mining, stage 3: chain longer mates. From a mined pool's mates
# in 3 ($IN/<first arg>) and the corpus game files ($IN/games_*.json), the
# position two plies earlier with the played turn: mate in 4 (certificate,
# Rust check, no mate in 1, no win within 2); then the same from the proven
# mates in 4 for mate in 5.
#   args: <pool file name> [cert_ms=3600000]
set -uo pipefail
cd "$(dirname "$0")/../../.."
POOL=$IN/$1; CMS=${2:-3600000}
W=${WORKERS:-$(nproc)}
GAMES=$(ls $IN/games_*.json)
python3 - "$POOL" "$OUT/m3_pool.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['puzzles'] = [p for p in d['puzzles'] if p.get('mate') == 3]
json.dump(d, open(sys.argv[2], 'w'))
print(len(d['puzzles']), 'mates in 3')
PY
for K in 4 5; do
  PREV=$([ $K = 4 ] && echo $OUT/m3_pool.json || echo $OUT/m4_pool.json)
  python3 bench/tools/mine_mate_k.py candidates --k $K --pool $PREV --games $GAMES --out $OUT/m${K}_cands.json \
    > $OUT/chain_m$K.log 2>&1
  python3 bench/tools/mine_mate_k.py solve --k $K --candidates $OUT/m${K}_cands.json --work $OUT/m${K}_work.jsonl \
    --workers "$W" --time-ms "$CMS" --tool $BIN/cert_tool >> $OUT/chain_m$K.log 2>&1
  python3 bench/tools/mine_mate_k.py assemble --k $K --candidates $OUT/m${K}_cands.json \
    --work "$OUT/m${K}_work.jsonl" --out $OUT/m${K}_pool.json >> $OUT/chain_m$K.log 2>&1
  tail -1 $OUT/chain_m$K.log
done
echo "chain_v3 done"
