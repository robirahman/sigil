"""Engine spell values from real self-play positions (counterfactual access probes).

    spell_value_probe.py <rows_per_chunk> <depth> [pairs_per_side=4]

Positions come from the round-4 self-play corpus (engine v29, every official spell
drawn equally often, real rules). For each sampled position the shipped search
(fixed depth, no clock) scores it as played, then again with ONE spell made
unusable for ONE side (`PyBoard.set_access`: the slot never counts as charged
for that side, so it can neither be cast nor give its static effect, anywhere in
the search tree). The drop is that spell's value to that side in that position,
including the chance to charge it within the search horizon. Every one of the 9
drawn spells is probed for both sides (18 probes), plus `pairs_per_side` random
same-side pairs (both spells removed together, for synergy).

The game itself is never altered: the probes are counterfactual searches of
positions reached under the real rules, so a spell like Bulwark is valued in the
positions where it actually matters, not in a game whose rules make it moot.

Positions: $SIGIL_PROBE_PLAN (default DEFAULT_PLAN) is a JSON file (local or gs://) {"chunks": [gs://
paths], "shards": [shard numbers]}. The shard numbered off // 1000 (gcp/runner.sh
sets SIGIL_SHARD_OFF) takes chunks i with i % len(shards) == its index and
samples `rows_per_chunk` positions from each (seeded by chunk index).

One `PROBE {json}` line per position: chunk, row, game, ply, kind, spells (slot
order), mover, score (mover POV, centistones), self[9] (score with the mover's
access to slot p removed), opp[9] (with the opponent's removed), pairs [[side,
p, q, score]] (side 0 mover, 1 opponent), charged [mover mask, opponent mask].
fit_spell_values.py turns these into the tier list, matchup and synergy charts.
"""
import io, json, os, random, sys, time, urllib.parse, urllib.request
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import shard_offset

ALL = 0x1FF
# The plan the GCP runner uses (it passes no extra environment).
DEFAULT_PLAN = 'gs://focus-surfer-494820-g0-sigil/data/spell_values/plan_2026-10-12.json'
EVAL = se.SHIPPED_EVAL
AD = tuple(se.SHIPPED_ADAPTIVE)


def _fetch(path):
    if not path.startswith('gs://'):
        return open(path, 'rb').read()
    bucket, name = path[5:].split('/', 1)
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        headers={'Metadata-Flavor': 'Google'}), timeout=15))['access_token']
    url = (f'https://storage.googleapis.com/storage/v1/b/{bucket}/o/'
           f'{urllib.parse.quote(name, safe="")}?alt=media')
    return urllib.request.urlopen(urllib.request.Request(
        url, headers={'Authorization': f'Bearer {tok}'}), timeout=120).read()


def search(sfn, depth, red_mask=ALL, blue_mask=ALL):
    b = se.Board.from_sfn(sfn)
    if red_mask != ALL or blue_mask != ALL:
        b.set_access(red_mask, blue_mask)
    return b.root_scores_and_play(depth, EVAL, False, 1, [], False, None, AD)[1]


def probe(sfn, depth, pairs_per_side, rng):
    b = se.Board.from_sfn(sfn)
    mover = 'red' if sfn.split()[1] == 'r' else 'blue'
    masks = lambda own, other: (own, other) if mover == 'red' else (other, own)
    base = search(sfn, depth)
    self_v = [search(sfn, depth, *masks(ALL & ~(1 << p), ALL)) for p in range(9)]
    opp_v = [search(sfn, depth, *masks(ALL, ALL & ~(1 << p))) for p in range(9)]
    pairs = []
    allp = [(p, q) for p in range(9) for q in range(p + 1, 9)]
    for side in (0, 1):
        for p, q in rng.sample(allp, pairs_per_side):
            m = ALL & ~(1 << p) & ~(1 << q)
            pairs.append([side, p, q, search(sfn, depth, *(masks(m, ALL) if side == 0 else masks(ALL, m)))])
    return dict(mover=mover, score=base, self=self_v, opp=opp_v, pairs=pairs,
                spells=list(b.spell_ids()))


def main():
    a = sys.argv[1:]
    per_chunk, depth = int(a[0]), int(a[1])
    pairs_per_side = int(a[2]) if len(a) > 2 else 4
    se.set_policy(*se.SHIPPED_POLICY)
    se.set_policy_explore(*se.SHIPPED_EXPLORE)
    se.set_opening_book(False)
    off = shard_offset()
    plan = json.loads(_fetch(os.environ.get('SIGIL_PROBE_PLAN', DEFAULT_PLAN)))
    shards = list(plan['shards'])
    if off // 1000 not in shards:          # e.g. the runner's smoke arm
        chunks = plan['chunks'][:1]
        print(f'shard {off // 1000} not in the plan: smoke on one chunk', flush=True)
    else:
        k = shards.index(off // 1000)
        chunks = [c for i, c in enumerate(plan['chunks']) if i % len(shards) == k]
    t0 = time.time(); n = 0
    for ci, path in enumerate(chunks):
        try:
            z = np.load(io.BytesIO(_fetch(path)))
        except Exception as e:  # noqa: BLE001
            print(f'skip {path}: {e}', flush=True); continue
        rng = random.Random(hash(path) & 0xffffffff)
        rows = [i for i in range(len(z['sfn']))
                if not (int(z['kind'][i]) == 1 and int(z['ply'][i]) <= 2)]
        for r in rng.sample(rows, min(per_chunk, len(rows))):
            sfn = str(z['sfn'][r])
            if se.Board.from_sfn(sfn).gameover:
                continue
            res = probe(sfn, depth, pairs_per_side, rng)
            res.update(chunk=os.path.basename(path), row=r, game=int(z['game'][r]),
                       ply=int(z['ply'][r]), kind=int(z['kind'][r]), sfn=sfn, depth=depth, eval=EVAL)
            print('PROBE ' + json.dumps(res, separators=(',', ':')), flush=True)
            n += 1
    print(f'SHARD off={off} chunks={len(chunks)} positions={n} {time.time() - t0:.0f}s', flush=True)


if __name__ == '__main__':
    main()
