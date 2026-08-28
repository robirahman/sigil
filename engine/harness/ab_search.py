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
KNOBS = ('q_depth', 'aspiration', 'width_scale')


def play(b, ms, ev, hist, knob, val):
    """One move with `knob` set to `val`; everything else at engine defaults."""
    ws = val if knob == 'width_scale' else 1
    qd = val if knob == 'q_depth' else None
    asp = val if knob == 'aspiration' else None
    return b.play_best(ms, 64, 20, 16, ws, hist, ev, False, MERGE_OFF,
                       None, None, None, qd, None, asp)


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
