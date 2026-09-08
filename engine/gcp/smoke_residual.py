"""What is STILL unreachable after the keep fix, and why.

The keep fix took Check B from 2,016 unreachable real turns to 675 (66.5%),
and human-played misses from 1,623 to 318 (80%). The 675 that remain are a
DIFFERENT gap, and they cluster:

    416  no non-charm cast (charms skip finish_cast, so neither the spell
         counter nor the lock witnesses them)
    176  cast Fireblast
     59  cast Meteor
     14  two casts in one turn
      7  cast Carnage

`layout_nearest` localises each: the Hamming distance to the nearest layout
enumeration DID produce, plus that turn's action log and the resolver
truncation flag. Distance 1-2 means the turn is right but for a single choice
point; a large distance means a whole turn SHAPE is missing -- and the leading
suspect for that is `enumerate_post_dash`, which emits only Pass or
Cast+Pass, so no movement can follow a post-dash cast.

Also checks the binding-default property directly: `search` with width_scale
OMITTED must now equal `search` with the engine's own default passed
explicitly. It used to default to 1 against an engine default of 4 -- the
-223 Elo unwidened config -- and that silently mis-set every caller that
omitted it.
"""
import collections, json, urllib.parse, urllib.request
import sigil_engine as se

BUCKET = 'focus-surfer-494820-g0-sigil'
CAP = 250_000


def fetch(obj):
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/"
        "service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"})))["access_token"]
    u = (f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/"
         + urllib.parse.quote(obj, safe='') + "?alt=media")
    return urllib.request.urlopen(urllib.request.Request(
        u, headers={"Authorization": "Bearer " + tok})).read()


def fmt(log):
    out = []
    for kind, node, push_to, sacs, pos in log:
        if kind == 'cast':
            out.append(f'cast(pos={pos},keep?,out={node})')
        elif kind == 'dash':
            out.append(f'dash({node}<-{list(sacs)}'
                       + (f',push {push_to}' if push_to >= 0 else '') + ')')
        elif kind == 'pass':
            out.append('pass')
        else:
            out.append(f'{kind}({node}'
                       + (f',push {push_to}' if push_to >= 0 else '') + ')')
    return ' '.join(out)


print("=== binding default: width_scale omitted must equal the engine default ===")
b = se.Board.from_sfn(
    "r.........r..bbb.........b........rr.../Bewitch,Seal_of_Lightning,Starfall,"
    "Grow,Seal_of_Wind,Fireblast,Surge,Slash,Seal_of_Summer r 7 0:0 -:- -:- b1")
omitted = b.search(4, 600_000, 20, 16)
explicit = b.search(4, 600_000, 20, 16, se.DEFAULT_WIDTH_SCALE)
one = b.search(4, 600_000, 20, 16, 1)
print(f"  omitted  nodes={omitted[2]:8d} score={omitted[0]:+d}")
print(f"  ws={se.DEFAULT_WIDTH_SCALE} (default) nodes={explicit[2]:8d} score={explicit[0]:+d}")
print(f"  ws=1     nodes={one[2]:8d} score={one[0]:+d}")
ok = omitted[2] == explicit[2]
print(f"  omitted == engine default: {ok}"
      + ("" if ok else "   <-- STILL RESTATING A DEFAULT"))
print(f"  (ws=1 differs from the default: {one[2] != explicit[2]}, so the test has teeth)")

print("\n=== residual cases: where does enumeration land? ===", flush=True)
cases = json.loads(fetch('data/residual_cases.json'))
per_bucket = collections.defaultdict(collections.Counter)
trunc = collections.Counter()
for i, c in enumerate(cases):
    bb = se.Board.from_sfn(c['sfnBefore'])
    tgt = se.Board.from_sfn(c['sfnAfter']).stones
    dist, _r, _b, log, n, tt, tr = bb.layout_nearest(
        c['mover'], tgt[0], tgt[1], CAP)
    per_bucket[c['bucket']][dist] += 1
    if tr:
        trunc[c['bucket']] += 1
    print(f"[{i:2d}] {c['bucket']:18s} dist={dist:2d} enum={n:7d} "
          f"res_trunc={int(tr)} {c['game']} t{c['turnNumber']} by {c['playedBy']}",
          flush=True)
    if dist and i < 24:
        print(f"       nearest: {fmt(log)}")

print("\n=== distance by bucket ===")
for bk in sorted(per_bucket):
    d = per_bucket[bk]
    tot = sum(d.values())
    print(f"  {bk:18s} n={tot:3d}  "
          + ' '.join(f'{k}:{v}' for k, v in sorted(d.items()))
          + f"   resolver_truncated {trunc[bk]}/{tot}")
print("\ndistance 1-2 = one stone off, a single unenumerated choice point.")
print("large distance = a missing turn SHAPE (e.g. no move after a post-dash cast).")
