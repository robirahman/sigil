#!/usr/bin/env bash
# SigilBench v3 mate mining, all stages for one shard of a staged self-play
# prefix (e.g. v3/corpus/r6d3/): games (mine_v3.py corpus) -> mate candidates
# -> solve_mates (max_mate 3) -> pool -> mate-in-4 chain from the shard's own
# mates in 3 and games (certificate, Rust check, no win within 1 and 2) ->
# mate-in-5 chain from those mates in 4. Shortest-mate proofs beyond "within 2"
# are a separate job (within_v3.sh).
# Resume (Spot): pass the previous run's work_/m4_work_/m5_work_<shard>.jsonl as INPUTS.
#   args: <prefix> [starts=all] [solve_ms=120000] [cert_ms=1200000] [within2_ms=600000]
set -uo pipefail
cd "$(dirname "$0")/../../.."
PREFIX=$1; STARTS=${2:-all}; TMS=${3:-120000}; CMS=${4:-1200000}; W2=${5:-600000}
SAFE=${SHARD//\//of}; W=${WORKERS:-$(nproc)}
NPZ=/opt/sigil/npz; mkdir -p $NPZ
for f in work m4_work m5_work; do
  [ -f "$IN/${f}_$SAFE.jsonl" ] && cp "$IN/${f}_$SAFE.jsonl" "$OUT/" && echo "resumed ${f}_$SAFE.jsonl"
done
apt-get -qq install -y python3-numpy >/dev/null 2>&1
python3 bench/tools/fetch_private.py "$PREFIX" $NPZ --shard "$SHARD" > $OUT/download_$SAFE.log 2>&1
python3 bench/tools/mine_v3.py corpus --npz-dir $NPZ --starts "$STARTS" --out $OUT/games_$SAFE.json > $OUT/corpus_$SAFE.log 2>&1
rm -rf $NPZ
python3 bench/tools/mine_v3.py candidates --games $OUT/games_$SAFE.json \
  --exclude docs/static/puzzles/mate_puzzles.json bench/dev/dev_set.json bench/dev/dev_set_v2.json \
  --out-mates $OUT/mate_cands_$SAFE.json --out-win $OUT/win_cands_$SAFE.json >> $OUT/corpus_$SAFE.log 2>&1
cat $OUT/download_$SAFE.log $OUT/corpus_$SAFE.log
python3 bench/tools/mine_v3.py solve --candidates $OUT/mate_cands_$SAFE.json --bin $BIN/solve_mates \
  --work $OUT/work_$SAFE.jsonl --workers "$W" --time-ms "$TMS" > $OUT/solve_$SAFE.log 2>&1
python3 bench/tools/mine_v3.py assemble --candidates $OUT/mate_cands_$SAFE.json --work $OUT/work_$SAFE.jsonl \
  --out $OUT/pool_$SAFE.json > $OUT/assemble_$SAFE.log 2>&1
python3 - "$OUT/pool_$SAFE.json" "$OUT/m3_pool_$SAFE.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['puzzles'] = [p for p in d['puzzles'] if int(p.get('mate') or 0) == 3]
json.dump(d, open(sys.argv[2], 'w'))
print(len(d['puzzles']), 'mates in 3')
PY
for K in 4 5; do
  PREV=$([ $K = 4 ] && echo $OUT/m3_pool_$SAFE.json || echo $OUT/m4_pool_$SAFE.json)
  python3 bench/tools/mine_mate_k.py candidates --k $K --pool $PREV --games $OUT/games_$SAFE.json \
    --out $OUT/m${K}_cands_$SAFE.json > $OUT/chain_m${K}_$SAFE.log 2>&1
  python3 bench/tools/mine_mate_k.py solve --k $K --candidates $OUT/m${K}_cands_$SAFE.json \
    --work $OUT/m${K}_work_$SAFE.jsonl --workers "$W" --time-ms "$CMS" --within2-ms "$W2" \
    --tool $BIN/cert_tool >> $OUT/chain_m${K}_$SAFE.log 2>&1
  python3 bench/tools/mine_mate_k.py assemble --k $K --candidates $OUT/m${K}_cands_$SAFE.json \
    --work "$OUT/m${K}_work_$SAFE.jsonl" --out $OUT/m${K}_pool_$SAFE.json >> $OUT/chain_m${K}_$SAFE.log 2>&1
  tail -1 $OUT/chain_m${K}_$SAFE.log
done
echo "matemine_v3 shard $SHARD done"
