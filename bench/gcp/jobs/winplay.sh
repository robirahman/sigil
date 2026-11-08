#!/usr/bin/env bash
# Playouts for root tables already computed ($IN/tables*.jsonl): verdicts with
# bench/tools/win_puzzle.py, then Very Hard vs Very Hard playouts for the
# table-passing positions and the near misses (one idea, idea gap >= 0.2),
# then the playout rule (bench/tools/win_select.py).
#   args: [games=6] [ms=10000]
set -uo pipefail
cd "$(dirname "$0")/../../.."
GAMES=${1:-6}; MS=${2:-10000}
W=${WORKERS:-$(nproc)}
cat $IN/tables*.jsonl > $OUT/tables_all.jsonl
python3 bench/tools/win_puzzle.py $OUT/tables_all.jsonl --out $OUT/verdicts.jsonl > $OUT/verdicts.log 2>&1
python3 - "$OUT/verdicts.jsonl" "$OUT/verdicts_play.jsonl" <<'PY'
import json, sys
n = 0
with open(sys.argv[2], 'w') as f:
    for l in open(sys.argv[1]):
        v = json.loads(l)
        if v['verdict'] == 'puzzle' or (v.get('n_ideas') == 1 and (v.get('idea_gap') or 0) >= 0.2):
            f.write(l); n += 1
print(n, 'positions to play out')
PY
python3 bench/tools/win_playouts.py $OUT/verdicts_play.jsonl --out $OUT/playouts.jsonl --games "$GAMES" --ms "$MS" \
  --workers "$W" > $OUT/playouts.log 2>&1
python3 bench/tools/win_select.py $OUT/verdicts_play.jsonl $OUT/playouts.jsonl --out $OUT/final.jsonl > $OUT/final.log 2>&1
tail -1 $OUT/final.log
echo "winplay done"
