#!/usr/bin/env bash
# SigilBench v3 mining, stage 1 (V3_PLAN item 4): one shard of the fresh
# self-play corpus staged in the private bucket (v3/corpus/r6d/<run>/<worker
# base>/*.npz). Downloads this shard's worker bases (base j goes to shard
# j % n), rebuilds the games, writes mate and winning-turn candidates (public
# positions excluded) and solves the mate candidates (solve_mates, max_mate 3).
#   args: [time_ms=120000]
set -uo pipefail
cd "$(dirname "$0")/../../.."
TMS=${1:-120000}
SAFE=${SHARD//\//of}
mkdir -p $WORK/npz
python3 - "$SHARD" "$WORK/npz" <<'PY' > $OUT/download_$SAFE.log 2>&1
import json, os, sys, urllib.parse, urllib.request
shard, dest = sys.argv[1], sys.argv[2]
i, n = (int(x) for x in shard.split('/'))
B = 'focus-surfer-494820-g0-sigilbench-private'
def tok():
    r = urllib.request.Request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
                               headers={'Metadata-Flavor': 'Google'})
    return json.load(urllib.request.urlopen(r, timeout=15))['access_token']
names, page, t = [], None, tok()
while True:
    q = {'prefix': 'v3/corpus/r6d/', 'fields': 'items(name),nextPageToken'}
    if page: q['pageToken'] = page
    r = urllib.request.Request(f'https://storage.googleapis.com/storage/v1/b/{B}/o?' + urllib.parse.urlencode(q),
                               headers={'Authorization': 'Bearer ' + t})
    j = json.load(urllib.request.urlopen(r, timeout=60))
    names += [x['name'] for x in j.get('items', []) if x['name'].endswith('.npz')]
    page = j.get('nextPageToken')
    if not page: break
bases = sorted({os.path.dirname(x) for x in names})
mine = {b for k, b in enumerate(bases) if k % n == i}
got = 0
for x in names:
    if os.path.dirname(x) not in mine: continue
    out = os.path.join(dest, x.split('v3/corpus/r6d/', 1)[1])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    r = urllib.request.Request(f'https://storage.googleapis.com/storage/v1/b/{B}/o/' + urllib.parse.quote(x, safe='') + '?alt=media',
                               headers={'Authorization': 'Bearer ' + t})
    open(out, 'wb').write(urllib.request.urlopen(r, timeout=120).read()); got += 1
print(f'{len(bases)} bases, {len(mine)} mine, {got} files')
PY
tail -1 $OUT/download_$SAFE.log
apt-get -qq install -y python3-numpy >/dev/null 2>&1
python3 bench/tools/mine_v3.py corpus --npz-dir $WORK/npz --out $OUT/games_$SAFE.json > $OUT/corpus_$SAFE.log 2>&1
python3 bench/tools/mine_v3.py candidates --games $OUT/games_$SAFE.json \
  --exclude docs/static/puzzles/mate_puzzles.json bench/dev/dev_set.json bench/dev/dev_set_v2.json \
  --out-mates $OUT/mate_cands_$SAFE.json --out-win $OUT/win_cands_$SAFE.json >> $OUT/corpus_$SAFE.log 2>&1
cat $OUT/corpus_$SAFE.log
python3 bench/tools/mine_v3.py solve --candidates $OUT/mate_cands_$SAFE.json --bin $BIN/solve_mates \
  --work $OUT/work_$SAFE.jsonl --workers ${WORKERS:-$(nproc)} --time-ms "$TMS" > $OUT/solve_$SAFE.log 2>&1
echo "mine_v3 shard $SHARD done"
