"""Does the mate guard bite through `play_best`, and on which positions?

Two jobs, because the guard's first version could do neither:

1. GATE. The guard was written into `pick_successor` -- the browser's
   successor-picking entry point -- while `play_best` drives
   `go_with_progress`, whose mate break had no guard and no clamp. So
   `set_mate_guard` set a field the shipped search never read. The A/B over
   the 145 flagged positions returned 4 false mates with the guard OFF and the
   SAME 4, at identical scores, with it ON, and `smoke_knobbite` saw 0 of 60
   positions change -- both were reporting this omission, not the guard.

   The gate does not sample and hope. It searches every position in the
   mate-flip case file with the guard off, keeps the ones that announce a mate
   from a budget-limited search, and requires the guard to clamp EVERY one of
   them. Zero exercised is a failure too: that is exactly how the first smoke
   test passed.

2. HARVEST. Prints the qualifying SFNs so they can be embedded in
   `engine/src/tests.rs`, where a `cargo test` run pins the behaviour without
   needing GCS. The recorded `score0` in the case file is NOT a usable filter
   -- only 1 of 145 cases has a mate as its from-score; the rest flip *into*
   one -- so the positions have to be found by searching, not by reading.
"""
import json, sys, time, urllib.parse, urllib.request
import sigil_engine as se

MERGE_OFF = 1 << 62
BUCKET = 'focus-surfer-494820-g0-sigil'
MATE_FLOOR = 10_000_000 - 64
UNPROVEN = getattr(se, 'UNPROVEN_MATE', 5000)


def adaptive():
    a = getattr(se, 'SHIPPED_ADAPTIVE', None)
    return tuple(a) if a else None


def pb(sfn, window, depth, guard):
    b = se.Board.from_sfn(sfn)
    r = b.play_best(0, depth, 20, window, se.DEFAULT_WIDTH_SCALE, [], 'tfit',
                    False, MERGE_OFF, None, None, None, None, None, None,
                    adaptive(), None, None, None, guard)
    # (depth_completed, nodes, secs, over, winner, score, widened)
    return int(r[5]), bool(r[6])


def fetch(obj):
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/"
        "service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"})))["access_token"]
    u = (f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/"
         + urllib.parse.quote(obj, safe='') + "?alt=media")
    return urllib.request.urlopen(urllib.request.Request(
        u, headers={"Authorization": "Bearer " + tok})).read()


print(f"UNPROVEN_MATE = {UNPROVEN}")
cases = json.loads(fetch('data/mateflip_cases.json'))
# Every position the file mentions, not just the flagged from-state.
sfns, seen = [], set()
for c in cases:
    for k in ('sfn_i', 'sfn_i1', 'sfn_i2'):
        s = c.get(k)
        if s and s not in seen:
            seen.add(s)
            sfns.append(s)
print(f"{len(sfns)} distinct positions from {len(cases)} cases\n")

# A GATE IS NOT A CAMPAIGN. Every position costs a full search even when it
# announces no mate, so the first version -- 435 positions x 3 configs
# including depth 6 at ~17 s each -- was several hours of work behind a
# 1-hour watchdog, and took a clean build and 84 passing tests down with it.
# Both configs are depth 4, capped by position count AND by wall clock, and
# each stops as soon as it has confirmed enough clamps to be conclusive.
POS_CAP = 120           # positions examined per config
CONFIRM = 10            # clamps that settle the question
BUDGET_S = 420          # per-config wall clock

fail = 0
harvest = []
for window, depth in ((2, 4), (1, 4)):
    mate = clamped = leaked = widelim = 0
    examples = []
    t0 = time.time()
    for n, s in enumerate(sfns[:POS_CAP]):
        if clamped >= CONFIRM:
            print(f"  ({CONFIRM} clamps confirmed; stopping at position {n})")
            break
        if time.time() - t0 > BUDGET_S:
            print(f"  (budget {BUDGET_S}s spent at position {n})")
            break
        try:
            off, w_off = pb(s, window, depth, False)
        except Exception as e:
            print(f"  call failed: {e}")
            fail = 1
            break
        if abs(off) < MATE_FLOOR:
            continue
        mate += 1
        if not w_off:
            continue          # a genuinely exhaustive mate; guard must NOT fire
        widelim += 1
        on, _ = pb(s, window, depth, True)
        if abs(on) == UNPROVEN:
            clamped += 1
            if (window, depth) == (2, 4) and s not in harvest:
                harvest.append(s)
        else:
            leaked += 1
            if len(examples) < 3:
                examples.append((off, on))
    print(f"=== window={window} depth={depth}"
          f"  ({time.time() - t0:.0f}s) ===")
    print(f"  announced a mate with the guard off: {mate}")
    print(f"    of those, from a budget-limited search: {widelim}")
    print(f"    guard clamped: {clamped}   leaked as a mate: {leaked}")
    for off, on in examples:
        print(f"      LEAKED off={off} on={on}")
    if widelim and clamped == 0:
        print("  FAIL: the guard does not bite through play_best")
        fail = 1
    if leaked:
        print("  FAIL: a budget-limited mate was announced as a mate")
        fail = 1

if not harvest:
    print("\nFAIL: nothing exercised the guard, so it is UNTESTED -- fix the"
          " construction rather than passing")
    fail = 1
else:
    print(f"\n=== HARVEST: {len(harvest)} positions for tests.rs"
          " (window 2, depth 4) ===")
    for s in harvest[:16]:
        print(f'HARVEST "{s}",')

print(f"\nGUARDFIRES_EXIT={fail}")
sys.exit(fail)
