#!/usr/bin/env bash
# SigilBench v3 phase-0 cost spikes (bench/V3_PLAN.md). Runs four measurements
# side by side on one VM and writes their JSONL to $OUT:
#   certs    certificate extraction + Rust check (all dev v2 N <= 4) + JS check (N <= 3)
#   within   shortest-mate proofs: no mate within 2 for dev v2 N = 3, within 3 for N = 4
#   m5       mate-in-5 proofs of the played turn on $IN/m5_candidates_spike.json
#   wintable complete root tables of published winning-turn puzzles: 20 at depth 2, 10 at 3, 5 at 4
set -uo pipefail
cd "$(dirname "$0")/../../.."
W=${WORKERS:-$(nproc)}
python3 bench/tools/certs.py bench/dev/dev_set_v2.json --tool $BIN/cert_tool --out $OUT/certs.jsonl \
  --jobs 24 --time-ms 1800000 --leaves --js --js-max-n 3 > $OUT/certs.log 2>&1 &
P1=$!
python3 - "$BIN" "$OUT" <<'PY' > $OUT/within.log 2>&1 &
import json, subprocess, sys, concurrent.futures as cf
bin_, out = sys.argv[1], sys.argv[2]
ps = json.load(open('bench/dev/dev_set_v2.json'))['puzzles']
reqs = [(p['id'], p['n'] - 1, p['sfn']) for p in ps if p['n'] in (3, 4)]
def one(r):
    pid, k, sfn = r
    t = 3_600_000 if k == 3 else 1_800_000
    o = subprocess.run([bin_ + '/cert_tool', 'within'], input=f'{k}\t{sfn}\t2000000000000\t{t}\t1\n',
                       capture_output=True, text=True).stdout
    return dict(json.loads(o or '{}'), id=pid)
with open(out + '/within.jsonl', 'a') as f, cf.ThreadPoolExecutor(34) as ex:
    for r in ex.map(one, reqs):
        f.write(json.dumps(r) + '\n'); f.flush(); print(r, flush=True)
PY
P2=$!
python3 - "$BIN" "$OUT" "$IN" <<'PY' > $OUT/m5.log 2>&1 &
import json, subprocess, sys, concurrent.futures as cf
bin_, out, inn = sys.argv[1:4]
cs = json.load(open(inn + '/m5_candidates_spike.json'))['candidates']
def one(c):
    o = subprocess.run([bin_ + '/cert_tool', 'make'], input=f"5\t{c['hints'][0]}\t2000000000000\t3600000\t0\n",
                       capture_output=True, text=True).stdout
    r = json.loads(o or '{}')
    return {'id': c['id'], 'ok': r.get('ok'), 'error': r.get('error'), 'nodes': r.get('nodes'),
            'seconds': r.get('seconds'), 'internal': len(r.get('internal') or [])}
with open(out + '/m5.jsonl', 'a') as f, cf.ThreadPoolExecutor(17) as ex:
    for r in ex.map(one, cs):
        f.write(json.dumps(r) + '\n'); f.flush(); print(r, flush=True)
PY
P3=$!
python3 - "$BIN" "$OUT" <<'PY' > $OUT/wintable.log 2>&1 &
import json, subprocess, sys, random, time, concurrent.futures as cf
bin_, out = sys.argv[1], sys.argv[2]
d = json.load(open('docs/static/puzzles/mate_puzzles.json'))
ps = [p for p in d['puzzles'] if p['kind'] == 'winning']
random.Random(20261103).shuffle(ps)
ps = ps[:20]
def one(args):
    p, depth = args
    t0 = time.time()
    o = subprocess.run([bin_ + '/win_table'], input=f"{p['sfn']}\t{depth}\t60000\tnnue_mt256,nnue_spell4,material\n",
                       capture_output=True, text=True).stdout
    r = json.loads(o or '{}')
    r['id'], r['depth'], r['wall'] = p['id'], depth, round(time.time() - t0, 1)
    r['solution_keys'] = p.get('solution_keys')
    return r
with open(out + '/wintable.jsonl', 'a') as f, cf.ThreadPoolExecutor(14) as ex:
    for r in ex.map(one, [(p, 2) for p in ps] + [(p, 3) for p in ps[:10]] + [(p, 4) for p in ps[:5]]):
        f.write(json.dumps(r) + '\n'); f.flush()
        print(r['id'], r['depth'], r.get('turns'), len(r.get('children') or []), r.get('seconds'), flush=True)
PY
P4=$!
wait $P1 $P2 $P3 $P4
echo "spike0 done"
