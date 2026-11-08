#!/usr/bin/env bash
# SigilBench v3 mining: complete root tables for winning-turn candidates
# (bench/tools/mine_v3.py candidates --out-win files in $IN/win_cands_*.json).
# Takes this shard's share of a seeded random sample and writes win_table2
# lines (with id) to $OUT/tables_<shard>.jsonl; verdicts are drawn locally
# with bench/tools/win_puzzle.py, so the thresholds can change without a rerun.
#   args: [sample=600] [deep_depths=4,5] [deep_ms=30000] [margin=1.0] [min_top=4] [rand=10]
set -uo pipefail
cd "$(dirname "$0")/../../.."
N=${1:-600}; DD=${2:-4,5}; DMS=${3:-30000}; MARGIN=${4:-1.0}; MINTOP=${5:-4}; RAND=${6:-10}
SAFE=${SHARD//\//of}
W=${WORKERS:-$(nproc)}
python3 - "$IN" "$OUT/tables_$SAFE.jsonl" "$SHARD" "$N" "$DD" "$DMS" "$MARGIN" "$MINTOP" "$RAND" "$W" "$BIN" <<'PY' > $OUT/wintables_$SAFE.log 2>&1
import glob, json, os, random, subprocess, sys, time
inn, out, shard, n, dd, dms, margin, mintop, rand, w, bin_ = sys.argv[1:12]
i, k = (int(x) for x in shard.split('/'))
cands = []
for f in sorted(glob.glob(os.path.join(inn, 'win_cands_*.json'))):
    cands += json.load(open(f))['candidates']
random.Random(20261108).shuffle(cands)
mine = [c for j, c in enumerate(cands[:int(n)]) if j % k == i]
done = set()
if os.path.exists(out):
    done = {json.loads(l)['id'] for l in open(out) if l.strip()}
print(len(cands), 'candidates;', len(mine), 'in this shard;', len(done), 'done', flush=True)
with open(out, 'a') as f:
    for c in mine:
        if c['id'] in done: continue
        req = '\t'.join([c['sfn'], '2', '20000', dd, dms, 'nnue_mt256,nnue_spell4,mtempo', margin, mintop, rand, w, '60']) + '\n'
        t0 = time.time()
        o = subprocess.run([bin_ + '/win_table2'], input=req, capture_output=True, text=True).stdout
        try:
            r = json.loads(o)
        except Exception:
            print(c['id'], 'FAILED', o[:200], flush=True); continue
        r.update(id=c['id'], game=c['game'], self_play_score=c.get('score'))
        f.write(json.dumps(r) + '\n'); f.flush()
        print(c['id'], r['children'], r['deep_count'], round(time.time() - t0), flush=True)
PY
echo "wintables_v3 shard $SHARD done"
