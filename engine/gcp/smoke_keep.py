"""Does the search now SEE the cast keep choice, and what does it cost?

Three questions, in the order that decides whether this ships:
  1. Do the new keep options actually appear in the ordered stream the search
     consumes? Full enumeration being complete is not enough.
  2. What is the node-rate delta? Expanding keeps costs one full resolution per
     keep per cast candidate, and every width lever in this project is gated by
     node rate.
  3. Does a real turn the old engine could not generate become reachable?
"""
import json, time, urllib.parse, urllib.request
import sigil_engine as se

BUCKET = 'focus-surfer-494820-g0-sigil'


def fetch(obj):
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/"
        "service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"})))["access_token"]
    u = (f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/"
         + urllib.parse.quote(obj, safe='') + "?alt=media")
    return urllib.request.urlopen(urllib.request.Request(
        u, headers={"Authorization": "Bearer " + tok})).read()


print("=== 1. keep options exposed ===", flush=True)
b = se.Board([0, 1, 2, 5, 6, 7, 8, 9, 10])
b.set_stones([0, 1, 2, 3, 4, 5, 10, 11], [13, 23, 24])
for pos in range(6):
    try:
        opts = b.keep_options(pos, 'red')
    except Exception as e:
        print(f"  pos {pos}: {e}")
        continue
    print(f"  pos {pos}: {len(opts)} keeps, count()={b.keep_count(pos,'red')}, "
          f"first={opts[0]}")

print("\n=== 2. node rate, shipped settings ===", flush=True)
# Same shape as the featbench runs: fixed depth on real midgame positions, so
# the number is comparable to the 11.4-15.0 us/node on record.
lines = json.loads(fetch('data/hydrated_lines_v2.json'))
sfns = []
for g in lines:
    ss = g.get('sfns') or []
    if len(ss) > 24:
        sfns.append(ss[len(ss) // 2])
    if len(sfns) >= 40:
        break
print(f"  {len(sfns)} midgame positions")
for depth in (3, 4):
    t0 = time.perf_counter()
    nodes = 0
    done = 0
    for s in sfns:
        try:
            bb = se.Board.from_sfn(s)
        except Exception:
            continue
        try:
            r = bb.search(depth)
        except Exception as e:
            print(f"  search failed: {e}")
            break
        nodes += r[2] if isinstance(r, tuple) and len(r) > 2 else 0
        done += 1
    el = time.perf_counter() - t0
    if done and nodes:
        print(f"  depth {depth}: {done} pos, {nodes} nodes, {el:.2f}s "
              f"-> {nodes/el:,.0f} nodes/s, {1e6*el/nodes:.2f} us/node")
    else:
        print(f"  depth {depth}: {done} pos, {el:.2f}s (no node counts)")

print("\n=== 3. previously unreachable real turns ===", flush=True)
cases = json.loads(fetch('data/reach_cases.json'))
ok = miss = 0
for c in cases:
    bb = se.Board.from_sfn(c['sfnBefore'])
    tgt = se.Board.from_sfn(c['sfnAfter']).stones
    reach, n, tr = bb.layout_reachable(c['mover'], tgt[0], tgt[1], 250_000)
    if reach:
        ok += 1
    else:
        miss += 1
print(f"  {ok} of {len(cases)} stratified Check B cases are now REACHABLE "
      f"({miss} still not)")
print("  (these were 0/83 before the fix)")
