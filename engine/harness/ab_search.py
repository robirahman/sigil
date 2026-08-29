"""A/B one SEARCH knob against its current value, holding the eval fixed.

    ab_search.py <pairs> <ms> <eval> <knob> <arm_value> <base_value>

    knob = q_depth      plies of quiescence at the horizon (0 = off)
         = aspiration   half-width of the aspiration window, centistones
         = width_scale  multiplier on the progressive-widening schedule

The shard's seed offset comes from $SIGIL_SHARD_OFF, never a positional argument.

WHY NOW. Every search parameter in this engine was tuned against the MATERIAL eval,
whose score at fixed depth is a one-stone square wave. `tfit` is worth ~+58 Elo over
it and has a completely different score distribution, so the tuned values are no
longer the tuned values -- the aspiration window in particular was a hardcoded +/-60
chosen by eye against that square wave.

Both arms are the same binary at the same eval, differing only in the knob.
Colour-swapped and seeded.
"""
import os, statistics, sys
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import Sprt, shard_offset

MERGE_OFF = 1 << 62
# Baseline widening comes from the ENGINE, not a literal: the shipped scale is now 4,
# and a harness that hardcoded 1 would silently test every other knob under the old,
# far-too-narrow budget -- which is exactly the confound this re-test exists to remove.
BASE_WS = se.DEFAULT_WIDTH_SCALE
KNOBS = ('q_depth', 'aspiration', 'width_scale', 'merge_min_width',
         'key_dash_extra', 'key_dash_min_width', 'adaptive')

# Adaptive arms are named `adaptive` and encode (easy_scale, hard_scale) in the arm
# value as easy*100 + hard, with the threshold fixed at ADAPTIVE_P. Keeps the
# one-knob-one-integer shape of this harness.
ADAPTIVE_P = 0.10


def play(b, ms, ev, hist, knob, val):
    """One move with `knob` set to `val`; everything else at engine defaults."""
    ws = val if knob == 'width_scale' else BASE_WS
    qd = val if knob == 'q_depth' else None
    asp = val if knob == 'aspiration' else None
    merge = val if knob == 'merge_min_width' else MERGE_OFF
    adaptive = None
    if knob == 'adaptive' and val > 0:
        adaptive = (ADAPTIVE_P, val // 100, val % 100)
    # key_dash needs BOTH its reason mask and its slot count to do anything, so the
    # extra/min_width knobs turn on CRUSH-only reasons, the one rule that was not
    # harmful at scale 1.
    kdr = 1 if knob in ('key_dash_extra', 'key_dash_min_width') else None
    kdx = val if knob == 'key_dash_extra' else None
    kdmw = val if knob == 'key_dash_min_width' else None
    return b.play_best(ms, 64, 20, 16, ws, hist, ev, False, merge,
                       kdr, kdmw, kdx, qd, None, asp, adaptive)


def game(seed, arm_color, ms, ev, knob, arm_val, base_val, max_plies=140):
    b = se.Board(se.Board.legal_draw(seed), "standard")
    b.setup_initial()
    hist = []
    dep = {'arm': [], 'base': []}
    for ply in range(max_plies):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        is_arm = (side == arm_color)
        hist.append(b.key_js)
        r = play(b, ms, ev, hist, knob, arm_val if is_arm else base_val)
        dep['arm' if is_arm else 'base'].append(r[0])
        if r[3]:
            return r[4], ply + 1, dep
    return None, max_plies, dep


if __name__ == "__main__":
    pairs = int(sys.argv[1]); ms = int(sys.argv[2]); ev = sys.argv[3]
    knob = sys.argv[4]; arm_val = int(sys.argv[5]); base_val = int(sys.argv[6])
    if knob not in KNOBS:
        sys.exit(f"unknown knob {knob!r}; expected one of {KNOBS}")
    off = shard_offset()

    cfg = se.search_defaults()
    print(f"  ENGINE CONFIG  eval={ev} knob={knob} arm={arm_val} base={base_val} "
          f"base_width_scale={BASE_WS} "
          f"ms={ms} merge_min_width="
          f"{'OFF' if cfg['merge_min_width'] >= (1 << 63) else cfg['merge_min_width']} "
          f"defaults(q_depth={cfg['q_depth']}, aspiration={cfg['aspiration']})",
          flush=True)
    print(f"  SEEDS  {6_000_000 + off}..{6_000_000 + off + pairs - 1} "
          f"(shard offset {off}) -- two shards sharing a range replicate games "
          f"and invalidate the statistics", flush=True)

    s = Sprt(elo0=0.0, elo1=25.0)
    plies = []; dep = {'arm': [], 'base': []}
    for i in range(pairs):
        for arm in ('red', 'blue'):
            w, n, d = game(6_000_000 + off + i, arm, ms, ev, knob, arm_val, base_val)
            plies.append(n); dep['arm'] += d['arm']; dep['base'] += d['base']
            s.update(None if w is None else (w == arm))
            print(f"GAME seed={6_000_000+off+i} arm={arm} winner={w} plies={n}",
                  flush=True)
        if s.verdict != 'continue':
            break
    print(f"SHARD knob={knob} arm={arm_val} base={base_val} eval={ev} ms={ms} "
          f"off={off} n={s.n} armwins={s.wins} basewins={s.losses} unf={s.unfinished}")
    print(s.line(f"{knob}={arm_val} vs {base_val} (eval={ev}, {ms}ms)"))
    print(f"  mean plies {statistics.mean(plies):.1f}")
    if dep['arm']:
        print(f"  depth: arm {statistics.mean(dep['arm']):.2f}  "
              f"base {statistics.mean(dep['base']):.2f}")
