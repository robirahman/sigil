#!/usr/bin/env bash
# Shortest-mate proofs for SigilBench v3 pool puzzles: "is there a forced win
# within k?" (engine/examples/cert_tool within; the answer is a proof either
# way, or budget/incomplete). Input $IN/<first arg>: {"items": [{"id", "sfn", "k"}, ...]}
# (sfn = the puzzle position, mover to move; k = N - 1 to show a mate in N is
# exact). Results go to $OUT/within_<shard>.jsonl as they finish (resumed from $IN).
#   args: <input file> [time_ms=3600000] [threads_per_job=4]
set -uo pipefail
cd "$(dirname "$0")/../../.."
INP=$IN/$1; T=${2:-3600000}; TH=${3:-4}
W=${WORKERS:-$(nproc)}; J=$(( W / TH )); [ "$J" -ge 1 ] || J=1
SAFE=${SHARD//\//of}; RES=within_$SAFE.jsonl      # per shard, so the Spot keeper can resume it
for f in within.jsonl $RES; do [ -f "$IN/$f" ] && cp "$IN/$f" "$OUT/$RES"; done
python3 - "$BIN" "$INP" "$OUT/$RES" "$T" "$TH" "$J" <<'PY' > $OUT/within.log 2>&1
import json, os, subprocess, sys, concurrent.futures as cf
bin_, inp, out, t, th, j = sys.argv[1:7]
items = json.load(open(inp))['items']
done = {json.loads(l)['id'] for l in open(out)} if os.path.exists(out) else set()
todo = [x for x in items if x['id'] not in done]
print(len(items), 'items,', len(todo), 'to do,', j, 'parallel x', th, 'threads', flush=True)
def one(x):
    o = subprocess.run([bin_ + '/cert_tool', 'within'], input=f"{x['k']}\t{x['sfn']}\t20000000000000\t{t}\t{th}\n",
                       capture_output=True, text=True).stdout
    try:
        r = json.loads(o.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        r = {'result': 'error', 'error': o[-300:]}
    return dict(r, id=x['id'], k=x['k'])
with open(out, 'a') as f, cf.ThreadPoolExecutor(int(j)) as ex:
    for fu in cf.as_completed([ex.submit(one, x) for x in todo]):
        r = fu.result()
        f.write(json.dumps(r) + '\n'); f.flush()
        print(r['id'], r['k'], r.get('result'), r.get('seconds'), flush=True)
PY
tail -2 $OUT/within.log
echo "within_v3 done"
