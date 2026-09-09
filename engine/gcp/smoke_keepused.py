"""Can the keep choice ever pay? Ask which keep the search PICKS.

keep_window=2 measured -0.4 Elo [-8.5, +7.7] over 7,040 games at 300ms -- a
well-powered null. Before spending more compute on dose and time-control
sweeps, this asks the question that would explain it directly: handed all ten
keep options, does the search still choose the priority one?

If it does, the fixed order was already a good heuristic and there is nothing
to win here at any dose -- the fix is then purely about being able to
REPRESENT positions the opponent can reach, not about playing better itself.
If it frequently picks another keep, the null is about depth or dose and the
sweeps are worth running.
"""
import collections, json, time, urllib.parse, urllib.request
import sigil_engine as se

BUCKET = 'focus-surfer-494820-g0-sigil'
WINDOW = getattr(se, 'CAST_OUTCOME_WINDOW', 24)
WS = se.DEFAULT_WIDTH_SCALE


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
boards, sfns = [], []
for g in lines:
    ss = g.get('sfns') or []
    if len(ss) > 20:
        # several positions per game, so this is not 40 samples of one phase
        for ix in (len(ss) // 3, len(ss) // 2, 2 * len(ss) // 3):
            sfns.append(ss[ix])
    if len(sfns) >= 240:
        break
for s in sfns:
    try:
        boards.append(se.Board.from_sfn(s))
    except Exception:
        pass
print(f"positions={len(boards)} window={WINDOW} width_scale={WS}\n", flush=True)

for depth in (3, 4):
    print(f"=== depth {depth} ===", flush=True)
    for kw in (1, 10):
        used = collections.Counter()
        n_cast = 0
        t0 = time.perf_counter()
        for b in boards:
            try:
                r = b.search_keeps(depth, 600_000, 20, WINDOW, WS, kw)
            except Exception as e:
                print(f"  kw={kw}: {e}")
                break
            k = r[5]
            used[k] += 1
            if k >= 0:
                n_cast += 1
        el = time.perf_counter() - t0
        nonprio = sum(v for k, v in used.items() if k > 0)
        print(f"  kw={kw:2d}: best move casts in {n_cast}/{len(boards)} positions; "
              f"of those it keeps NON-priority in {nonprio} "
              f"({100.0 * nonprio / max(1, n_cast):.1f}%)   {el:.1f}s")
        print(f"        keep index chosen: "
              f"{dict(sorted((k, v) for k, v in used.items()))}"
              f"   (-1 = chose a non-cast turn, -2 = no move)")
print("\nIf kw=10 almost never picks a keep above 0, the priority order was")
print("already the right heuristic and no dose or time control will change it.")
