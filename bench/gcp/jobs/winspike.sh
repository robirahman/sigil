#!/usr/bin/env bash
# SigilBench v3 winning-turn measurement (V3_PLAN item 3): two-stage root
# tables (engine/examples/win_table2) for N published winning-turn puzzles,
# verdicts (bench/tools/win_puzzle.py), then Very Hard playouts at 10 s a move
# of every key and the 3 best alternatives (bench/tools/win_playouts.py).
#   args: [N=20] [games=6] [ms=10000]
set -uo pipefail
cd "$(dirname "$0")/../../.."
N=${1:-20}; GAMES=${2:-6}; MS=${3:-10000}
W=${WORKERS:-$(nproc)}
python3 - "$N" "$BIN" "$OUT" "$W" <<'PY' > $OUT/tables.log 2>&1
import json, random, subprocess, sys, time
n, bin_, out, w = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
d = json.load(open('docs/static/puzzles/mate_puzzles.json'))
ps = [p for p in d['puzzles'] if p['kind'] == 'winning']
random.Random(20261108).shuffle(ps)
with open(out + '/tables.jsonl', 'a') as f:
    for p in ps[:n]:
        req = '\t'.join([p['sfn'], '2', '20000', '4,5,6', '120000', 'nnue_mt256,nnue_spell4,mtempo',
                         '1.5', '8', '30', w]) + '\n'
        t0 = time.time()
        o = subprocess.run([bin_ + '/win_table2'], input=req, capture_output=True, text=True).stdout
        try:
            r = json.loads(o)
        except Exception:
            print(p['id'], 'FAILED', o[:200], flush=True); continue
        r['id'], r['solution_keys'] = p['id'], p.get('solution_keys')
        f.write(json.dumps(r) + '\n'); f.flush()
        print(p['id'], r['children'], r['deep_count'], r['seconds'], round(time.time() - t0), flush=True)
PY
python3 bench/tools/win_puzzle.py $OUT/tables.jsonl --out $OUT/verdicts.jsonl > $OUT/verdicts.log 2>&1
python3 bench/tools/win_playouts.py $OUT/verdicts.jsonl --out $OUT/playouts.jsonl --games "$GAMES" --ms "$MS" \
  --workers "$W" > $OUT/playouts.log 2>&1
python3 bench/tools/win_playouts.py $OUT/verdicts.jsonl --out $OUT/playouts.jsonl --summary > $OUT/playout_summary.jsonl
echo "winspike done"
