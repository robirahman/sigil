"""Node-rate and correctness A/B for the cast keep fix, per position.

The first A/B showed the fix searching 15x FEWER nodes at the same depth. That
is either much better move ordering or a search that stops early / cannot see
moves, and a totals-only comparison cannot tell those apart. So this prints,
for every position: the depth actually completed, the score, and the node
count. Two runs of this on two branches diff position-by-position:

  * same depth_completed and same score, far fewer nodes  -> ordering gain
  * lower depth_completed                                 -> stopping early
  * different score                                       -> different search,
                                                             and which is right
                                                             is then the question

It also counts what the ROOT generator yields, because a generator starved of
candidates produces both fewer nodes and worse play while looking fast.
"""
import json, time, urllib.parse, urllib.request
import sigil_engine as se

BUCKET = 'focus-surfer-494820-g0-sigil'
WINDOW = getattr(se, 'CAST_OUTCOME_WINDOW', 24)
WS = getattr(se, 'DEFAULT_WIDTH_SCALE', 4)


def fetch(obj):
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/"
        "service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"})))["access_token"]
    u = (f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/"
         + urllib.parse.quote(obj, safe='') + "?alt=media")
    return urllib.request.urlopen(urllib.request.Request(
        u, headers={"Authorization": "Bearer " + tok})).read()


lines = json.loads(fetch('data/hydrated_lines_v2.json'))
sfns = []
for g in lines:
    ss = g.get('sfns') or []
    if len(ss) > 24:
        sfns.append(ss[len(ss) // 2])
    if len(sfns) >= 40:
        break

print(f"window={WINDOW} width_scale={WS}  positions={len(sfns)}", flush=True)

print("\n=== root generator width ===", flush=True)
tot_turns = 0
for i, s in enumerate(sfns[:12]):
    try:
        b = se.Board.from_sfn(s)
        kinds = b.ordered_turn_kinds(400, 400)
    except Exception as e:
        print(f"  [{i}] {e}")
        continue
    tot_turns += len(kinds)
    ncast = sum(1 for k in kinds if 'cast' in k)
    print(f"  [{i:2d}] {len(kinds):4d} turns in the first 400, {ncast:3d} with a cast")
print(f"  total {tot_turns}")

print("\n=== per-position search, fixed depth ===", flush=True)
for depth in (3, 4):
    print(f"--- depth {depth} ---", flush=True)
    tn = 0.0
    tnodes = 0
    for i, s in enumerate(sfns):
        try:
            b = se.Board.from_sfn(s)
        except Exception:
            continue
        t0 = time.perf_counter()
        try:
            r = b.search(depth, 600_000, 20, WINDOW, WS)
        except Exception as e:
            print(f"  [{i:2d}] search failed: {e}")
            continue
        dt = time.perf_counter() - t0
        score, depth_done, nodes = r[0], r[1], r[2]
        tn += dt
        tnodes += nodes
        # SCORE and DEPTH are the correctness columns; nodes is the cost column.
        print(f"  [{i:2d}] d_done={depth_done} score={score:+7d} "
              f"nodes={nodes:8d} {dt*1000:7.1f}ms", flush=True)
    if tnodes:
        print(f"  TOTAL depth {depth}: {tnodes} nodes, {tn:.2f}s, "
              f"{tnodes/tn:,.0f} nodes/s, {1e6*tn/tnodes:.2f} us/node")

print("\n=== previously unreachable real turns ===", flush=True)
cases = json.loads(fetch('data/reach_cases.json'))
ok = 0
for c in cases:
    b = se.Board.from_sfn(c['sfnBefore'])
    tgt = se.Board.from_sfn(c['sfnAfter']).stones
    reach, _n, _tr = b.layout_reachable(c['mover'], tgt[0], tgt[1], 250_000)
    ok += bool(reach)
print(f"  {ok} of {len(cases)} reachable")
