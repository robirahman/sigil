"""Price the cast keep choice: node rate at every keep budget, one VM run.

At the maximum budget of 10 keeps the node rate went 20.15 -> 108.16 us/node,
a 5.4x regression, because each extra keep is one more full `resolve_outcomes`
per cast candidate. Every width lever in this project is gated on node rate --
`full_features` was killed at 9-12% of a node -- so 5.4x cannot ship, and the
question is what the curve looks like between 1 and 10.

`keep_window = 1` is the pre-fix search exactly (priority keep only), so this
run contains its own baseline and does not depend on comparing across VMs.

Reachability is reported too, but it does NOT depend on the knob: it comes from
full enumeration, which always expands every keep.
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
    if len(sfns) >= 30:
        break
boards = []
for s in sfns:
    try:
        boards.append(se.Board.from_sfn(s))
    except Exception:
        pass
print(f"window={WINDOW} width_scale={WS} positions={len(boards)} "
      f"default_keep_window={getattr(se, 'DEFAULT_KEEP_WINDOW', '?')}\n", flush=True)

DEPTH = 4
print(f"=== keep_window sweep at depth {DEPTH} ===", flush=True)
print(f"  {'kw':>3s} {'nodes':>10s} {'seconds':>8s} {'nodes/s':>10s} "
      f"{'us/node':>8s} {'vs kw=1':>8s} {'scores differ':>13s}", flush=True)
base_us = None
base_scores = None
for kw in (1, 2, 3, 5, 10):
    nodes = 0
    el = 0.0
    scores = []
    depths = set()
    for b in boards:
        t0 = time.perf_counter()
        try:
            score, d_done, n, _tt, _cut = b.search_keeps(
                DEPTH, 600_000, 20, WINDOW, WS, kw)
        except Exception as e:
            print(f"  kw={kw}: {e}")
            break
        el += time.perf_counter() - t0
        nodes += n
        scores.append(score)
        depths.add(d_done)
    if not nodes:
        continue
    us = 1e6 * el / nodes
    if base_us is None:
        base_us, base_scores = us, scores
        diff = "-"
    else:
        diff = sum(1 for a, b_ in zip(base_scores, scores) if a != b_)
        diff = f"{diff}/{len(scores)}"
    print(f"  {kw:3d} {nodes:10,d} {el:8.2f} {nodes/el:10,.0f} {us:8.2f} "
          f"{us/base_us:7.2f}x {diff:>13s}   depths={sorted(depths)}", flush=True)

print("\n  A score that differs from kw=1 is the POINT: it means the extra keep")
print("  changed the search's verdict. Whether it changed it for the better is")
print("  an SPRT question, not a node-rate one.")

print("\n=== reachability (full enumeration; independent of the knob) ===", flush=True)
cases = json.loads(fetch('data/reach_cases.json'))
ok = 0
for c in cases:
    b = se.Board.from_sfn(c['sfnBefore'])
    tgt = se.Board.from_sfn(c['sfnAfter']).stones
    r, _n, _t = b.layout_reachable(c['mover'], tgt[0], tgt[1], 250_000)
    ok += bool(r)
print(f"  {ok} of {len(cases)} previously-unreachable real turns now reachable")
