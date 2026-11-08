#!/usr/bin/env bash
# Winning-turn pilot on blunder-kind candidates ($IN/<first arg>, bench/tools/
# mine_v3.py swing): complete root tables for a seeded sample, verdicts
# (bench/tools/win_puzzle.py), Very Hard playouts for the table-passing
# positions and the near misses (one idea, idea gap >= 0.2), and the final
# playout rule (bench/tools/win_select.py). Measures the yield.
#   args: <candidates file> [sample=400] [games=6] [ms=10000]
set -uo pipefail
cd "$(dirname "$0")/../../.."
CANDS=$IN/$1; N=${2:-400}; GAMES=${3:-6}; MS=${4:-10000}
W=${WORKERS:-$(nproc)}
python3 - "$CANDS" "$OUT/tables.jsonl" "$N" "$W" "$BIN" <<'PY' > $OUT/tables.log 2>&1
import json, os, random, subprocess, sys, time
cands_f, out, n, w, bin_ = sys.argv[1:6]
cands = json.load(open(cands_f))['candidates']
random.Random(20261108).shuffle(cands)
with open(out, 'a') as f:
    for c in cands[:int(n)]:
        req = '\t'.join([c['sfn'], '2', '20000', '4,5', '30000', 'nnue_mt256,nnue_spell4,mtempo',
                         '1.0', '4', '10', w, '60', '3']) + '\n'
        t0 = time.time()
        o = subprocess.run([bin_ + '/win_table2'], input=req, capture_output=True, text=True).stdout
        try:
            r = json.loads(o)
        except Exception:
            print(c['id'], 'FAILED', o[:200], flush=True); continue
        r.update(id=c['id'], game=c['game'], kind=c.get('kind'), self_play_score=c.get('score'))
        f.write(json.dumps(r) + '\n'); f.flush()
        print(c['id'], r['children'], r['deep_count'], round(time.time() - t0), flush=True)
PY
python3 bench/tools/win_puzzle.py $OUT/tables.jsonl --out $OUT/verdicts.jsonl > $OUT/verdicts.log 2>&1
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
echo "winpilot done"
