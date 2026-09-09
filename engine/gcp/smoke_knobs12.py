"""Do the §1.2 knobs BITE through `play_best`? (Rule: a knob is not wired until it
is proven to change something in the function the deliverable calls.)

Fixed-depth (time_ms=0) for the ordering knobs, so a difference is deterministic;
timed for the time-management knobs, where the tell is a changed move, node count
or elapsed time. Runs locally on harness/positions_midgame.txt.
"""
import os, sys, statistics
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, '..', 'harness'))
import sigil_engine as se

POS = os.path.join(_HERE, '..', 'harness', 'positions_midgame.txt')
sfns = [l.strip() for l in open(POS) if l.strip() and not l.startswith('#')]
AD = tuple(se.SHIPPED_ADAPTIVE)

def run(sfn, depth, ms, **kw):
    b = se.Board.from_sfn(sfn)
    r = b.play_best(ms, depth, 20, 16, None, [], 'tfit', False, adaptive=AD, **kw)
    return b.to_sfn(), r  # (depth, nodes, dt, over, winner, score, widened)

fail = False
for knob, kw in (('force_hints', dict(force_hints=True)), ('root_resort', dict(root_resort=True)),
                 ('aspiration_steps', dict(aspiration_steps=True)), ('pvs', dict(pvs=True)),
                 ('lmr 2/1', dict(lmr=(2, 1))), ('history', dict(use_history=True))):
    diff = same = 0
    for s in sfns:
        a = run(s, 5, 0)
        b = run(s, 5, 0, **kw)
        if (a[1][1], a[1][5], a[0]) != (b[1][1], b[1][5], b[0]): diff += 1
        else: same += 1
    print(f"{knob:18} fixed depth 5: differs on {diff}/{diff+same} positions")
    if diff == 0: fail = True

for knob, kw in (('adopt_partial', dict(adopt_partial=True)),
                 ('elastic', dict(elastic=(2.0, 0.4, 2, 50, True)))):
    diff = same = 0; ta = []; tb = []
    for s in sfns[:40]:
        a = run(s, 64, 300); b = run(s, 64, 300, **kw)
        ta.append(a[1][2]); tb.append(b[1][2])
        if (a[1][0], a[0]) != (b[1][0], b[0]): diff += 1
        else: same += 1
    print(f"{knob:18} 300 ms: move/depth differs on {diff}/{diff+same}; "
          f"mean time base {statistics.mean(ta)*1000:.0f} ms, knob {statistics.mean(tb)*1000:.0f} ms")
    if diff == 0: fail = True

cfg = se.search_defaults()
print("defaults:", {k: cfg[k] for k in ('force_hints', 'root_resort', 'aspiration_steps', 'adopt_partial', 'elastic', 'pvs', 'lmr_ext', 'history')})
if fail:
    print("FAIL: a knob changed nothing"); sys.exit(1)
print("OK: every §1.2 knob bites through play_best")
