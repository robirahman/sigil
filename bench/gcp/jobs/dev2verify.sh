#!/usr/bin/env bash
# Finish certifying dev set v2's answer key (bench/V3_PLAN.md decisions, 2026-11-03).
# Input $IN/dev2verify_in.json: {"cert_ids": [...], "within": [[id, k, time_ms], ...]}.
#   certs   certificates + Rust check for cert_ids; JS check for N <= 3 and the
#           10% sample above (certs.py defaults); 2 h extraction budget
#   within  shortest-mate proofs: no win within 2 for every mate-in-4, and longer
#           budgets for the checks phase 0 left open
set -uo pipefail
cd "$(dirname "$0")/../../.."
IDS=$(python3 -c "import json;print(','.join(json.load(open('$IN/dev2verify_in.json'))['cert_ids']))")
python3 bench/tools/certs.py bench/dev/dev_set_v2.json --tool $BIN/cert_tool --out $OUT/certs.jsonl \
  --ids "$IDS" --jobs 30 --time-ms 7200000 --leaves --js > $OUT/certs.log 2>&1 &
P1=$!
python3 - "$BIN" "$OUT" "$IN" <<'PY' > $OUT/within.log 2>&1 &
import json, subprocess, sys, concurrent.futures as cf
bin_, out, inn = sys.argv[1:4]
reqs = json.load(open(inn + '/dev2verify_in.json'))['within']
sfn = {p['id']: p['sfn'] for p in json.load(open('bench/dev/dev_set_v2.json'))['puzzles']}
def one(r):
    pid, k, t = r
    o = subprocess.run([bin_ + '/cert_tool', 'within'], input=f'{k}\t{sfn[pid]}\t20000000000000\t{t}\t1\n',
                       capture_output=True, text=True).stdout
    return dict(json.loads(o or '{}'), id=pid)
with open(out + '/within.jsonl', 'a') as f, cf.ThreadPoolExecutor(len(reqs)) as ex:
    for fu in cf.as_completed([ex.submit(one, r) for r in reqs]):
        r = fu.result()
        f.write(json.dumps(r) + '\n'); f.flush(); print(r, flush=True)
PY
P2=$!
wait $P1 $P2
echo "dev2verify done"
