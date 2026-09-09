"""Every knob an arena passes must demonstrably BITE through that binding.

`play_best` accepted `keep_window` in its signature and never applied it. Two
SPRTs of 7,040 and 6,997 games therefore compared identical engines and
reported -0.4 and -0.6 Elo, which I read as a clean null. A binding that
takes an argument and drops it is the same class of bug as one that restates
a default, and it is harder to see: the only tell was two independent runs
landing within 0.1% of parity.

So this asserts, through `play_best` -- the binding every arena uses -- that
each knob changes something measurable. A knob that cannot be shown to bite
must not be SPRT'd, because the SPRT will "pass" by measuring nothing.
"""
import json, sys, urllib.parse, urllib.request
import sigil_engine as se

MERGE_OFF = 1 << 62
BUCKET = 'focus-surfer-494820-g0-sigil'


def adaptive():
    a = getattr(se, 'SHIPPED_ADAPTIVE', None)
    return tuple(a) if a else None


def pb(sfn, **kw):
    b = se.Board.from_sfn(sfn)
    r = b.play_best(kw.pop('ms', 0), kw.pop('depth', 4), 20,
                    kw.pop('window', 16),
                    se.DEFAULT_WIDTH_SCALE, [], 'tfit', False, MERGE_OFF,
                    None, None, None, None, None, None, adaptive(),
                    None, None, kw.pop('keep_window', None),
                    kw.pop('mate_guard', None))
    # (depth_completed, nodes, secs, over, winner, score, widened)
    return {'depth': r[0], 'nodes': r[1], 'score': r[5], 'widened': r[6]}


def fetch(obj):
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/"
        "service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"})))["access_token"]
    u = (f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/"
         + urllib.parse.quote(obj, safe='') + "?alt=media")
    return urllib.request.urlopen(urllib.request.Request(
        u, headers={"Authorization": "Bearer " + tok})).read()


# Midgame positions from real games: keeps and mates both need material on the
# board, and an opening position exercises neither.
lines = json.loads(fetch('data/hydrated_lines_v2.json'))
sfns = []
for g in lines:
    ss = g.get('sfns') or []
    if len(ss) > 24:
        sfns.append(ss[len(ss) // 2])
    if len(sfns) >= 60:
        break

fail = 0

print("=== keep_window must bite through play_best ===")
diff = same = 0
for s in sfns:
    try:
        a = pb(s, keep_window=1)
        b = pb(s, keep_window=10)
    except Exception as e:
        print(f"  call failed: {e}")
        fail = 1
        break
    if (a['nodes'], a['score']) != (b['nodes'], b['score']):
        diff += 1
    else:
        same += 1
print(f"  kw=1 vs kw=10 differ on {diff}/{diff+same} positions")
if diff == 0:
    print("  FAIL: the knob does not bite -- an SPRT on it would measure nothing")
    fail = 1

print("\n=== mate_guard must bite through play_best ===")
# The first version of this block compared guard on/off over the same 60
# midgame positions, saw 0 of 60 differ, printed a WARNING and exited 0 --
# reasoning that "the guard only fires where a mate meets a width-limited
# search, so a low count is expected". That excuse is indistinguishable from
# the knob not being wired at all, which is exactly what it was: the guard was
# written into `pick_successor` and `play_best` drives `go_with_progress`.
#
# So do not sample and hope. CONSTRUCT the condition: search positions that are
# known to produce a mate announcement, with `window=1` starving the
# cast-outcome window so the search is certainly width-limited. Every mate
# reported with the guard off MUST come back clamped with it on. No escape
# hatch: zero clamps is a FAIL.
UNPROVEN = getattr(se, 'UNPROVEN_MATE', 5000)
MATE_FLOOR = 10_000_000 - 64
try:
    cases = json.loads(fetch('data/mateflip_cases.json'))
    mate_sfns = [c['sfn_i'] for c in cases if c.get('sfn_i')]
except Exception as e:
    print(f"  could not load mateflip_cases.json: {e}")
    mate_sfns = []

if not mate_sfns:
    print("  FAIL: no mate-bearing positions to test the guard on")
    fail = 1
else:
    n_mate = n_clamped = n_missed = 0
    for s in mate_sfns:
        try:
            off = pb(s, mate_guard=False, window=1)
            if abs(off['score']) < MATE_FLOOR:
                continue
            n_mate += 1
            on = pb(s, mate_guard=True, window=1)
        except Exception as e:
            print(f"  call failed: {e}")
            fail = 1
            break
        if abs(on['score']) == UNPROVEN:
            n_clamped += 1
        else:
            n_missed += 1
            if n_missed <= 3:
                print(f"    NOT clamped: off={off['score']} on={on['score']}"
                      f" widened={off['widened']}")
    print(f"  {n_mate} of {len(mate_sfns)} positions announced a mate with the"
          " guard off")
    print(f"  of those, the guard clamped {n_clamped} and missed {n_missed}")
    if n_mate == 0:
        print("  FAIL: the construction did not produce a single mate score,"
              " so the guard is UNTESTED -- fix the construction, do not pass")
        fail = 1
    elif n_clamped == 0:
        print("  FAIL: the guard does not bite through play_best")
        fail = 1

print(f"\nKNOBBITE_EXIT={fail}")
sys.exit(fail)
