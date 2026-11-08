#!/usr/bin/env bash
# SigilBench v3 mining, stage 2: certify a mined mate pool (bench/tools/
# mine_v3.py assemble output, $IN/<first arg>): a certificate per puzzle, the
# independent Rust check, the browser-rules check (every N <= 3), and the
# shortest-mate proof "no forced win within 2" for each mate in 3.
#   args: <pool file name> [cert_ms=1800000] [within_ms=1800000]
set -uo pipefail
cd "$(dirname "$0")/../../.."
POOL=$IN/$1; CMS=${2:-1800000}; WMS=${3:-1800000}
W=${WORKERS:-$(nproc)}
python3 bench/tools/certs.py "$POOL" --tool $BIN/cert_tool --out $OUT/certs.jsonl \
  --jobs $((W * 2 / 3)) --time-ms "$CMS" --leaves --js > $OUT/certs.log 2>&1 &
P1=$!
python3 - "$BIN" "$OUT" "$POOL" "$WMS" $((W / 3)) <<'PY' > $OUT/within.log 2>&1 &
import json, subprocess, sys, concurrent.futures as cf
bin_, out, pool, wms, jobs = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
ps = [p for p in json.load(open(pool))['puzzles'] if p.get('mate', p.get('n')) == 3]
def one(p):
    o = subprocess.run([bin_ + '/cert_tool', 'within'], input=f"2\t{p['sfn']}\t20000000000000\t{wms}\t1\n",
                       capture_output=True, text=True).stdout
    return dict(json.loads(o or '{}'), id=p['id'])
with open(out + '/within.jsonl', 'a') as f, cf.ThreadPoolExecutor(max(1, jobs)) as ex:
    for fu in cf.as_completed([ex.submit(one, p) for p in ps]):
        r = fu.result(); f.write(json.dumps(r) + '\n'); f.flush(); print(r, flush=True)
PY
P2=$!
wait $P1 $P2
echo "verify_v3 done"
