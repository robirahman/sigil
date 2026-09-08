"""Name the ONE stone that differs, for the Fireblast/Meteor residual.

Those two buckets have survived every fix so far -- the cast keep choice,
Surge becoming castable, and the post-dash Summer second cast -- and they sit
at distance exactly 1 in 14 of 14 sampled cases each, with resolver_truncated
0. Perfectly uniform, so it is one deterministic rule difference, and I have
guessed its cause wrong twice.

Distance 1 over both masks means exactly ONE node differs in exactly ONE
colour. `layout_nearest` already returns the nearest layout, so print the
node and the direction: an ENEMY stone that survived in the target but died
in ours means the destruction set is too wide; one that died in the target
and survived in ours means too narrow; an OWN stone missing from ours means a
placement we cannot make; an extra OWN stone means a cost we levy and the
real game does not.
"""
import collections, json, urllib.parse, urllib.request
import sigil_engine as se

BUCKET = 'focus-surfer-494820-g0-sigil'
CAP = 250_000
NAMES = se.NODE_NAMES


def fetch(obj):
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/"
        "service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"})))["access_token"]
    u = (f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/"
         + urllib.parse.quote(obj, safe='') + "?alt=media")
    return urllib.request.urlopen(urllib.request.Request(
        u, headers={"Authorization": "Bearer " + tok})).read()


def bits(m):
    out = []
    while m:
        b = m & -m
        out.append(b.bit_length() - 1)
        m ^= b
    return out


cases = json.loads(fetch('data/residual_cases.json'))
cases = [c for c in cases if c['bucket'] in ('cast_fireblast', 'cast_meteor')]
print(f"{len(cases)} Fireblast/Meteor residual cases\n")

verdict = collections.Counter()
for i, c in enumerate(cases):
    b = se.Board.from_sfn(c['sfnBefore'])
    tgt = se.Board.from_sfn(c['sfnAfter'])
    tr_, tb_ = tgt.stones
    dist, br, bb, _log, _n, _tt, _res = b.layout_nearest(
        c['mover'], tr_, tb_, CAP)
    mover = c['mover']
    own_i, en_i = (0, 1) if mover == 'red' else (1, 0)
    got = (br, bb)
    want = (tr_, tb_)
    diffs = []
    for ci, label in ((own_i, 'OWN'), (en_i, 'ENEMY')):
        only_ours = got[ci] & ~want[ci]
        only_theirs = want[ci] & ~got[ci]
        for nd in bits(only_ours):
            diffs.append(f'{label} {NAMES[nd]} present in OURS, absent in target')
            verdict[f'{label}: we keep a stone the real turn removed'] += 1
        for nd in bits(only_theirs):
            diffs.append(f'{label} {NAMES[nd]} absent in OURS, present in target')
            verdict[f'{label}: real turn keeps a stone we remove'] += 1
    print(f"[{i:2d}] {c['bucket']:14s} dist={dist} {c['game']} t{c['turnNumber']}")
    for d in diffs:
        print(f"       {d}")

print("\n=== what the single differing stone is, pooled ===")
for k, v in verdict.most_common():
    print(f"  {v:3d}  {k}")
