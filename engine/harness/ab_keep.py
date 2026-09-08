"""SPRT the cast keep budget, ON THE SHIPPED CONFIG.

    ab_keep.py <pairs> <ms> <arm_keep_window> <base_keep_window> [mode]

`keep_window` is how many of a cast's keep choices the search expands. Which
stones survive a cast is the caster's CHOICE -- the live game prompts for it --
and the engine used to fix it to one priority order, so the search saw 1 of up
to 10 positions reachable through any cast, its own and the opponent's. A base
of 1 is that pre-fix search exactly, which is what makes this a clean A/B.

Why not `ab_eval.py`: it hardcodes `width_scale=1` and passes no `adaptive`, so
it runs neither of the two knobs the engine actually ships (scale 4, adaptive
(0.10, 2, 6)) -- `py.rs` documents that choice as historically fine but
confounding for any new test. A keep-choice result measured on an unwidened,
non-adaptive engine would not transfer to the engine on the site. Both sides
here read the shipped values from the engine rather than restating them, and
the ENGINE CONFIG line prints every knob that varies, including the two
`ab_eval.py` omits.

Cost is already measured, in one process at depth 4 over 30 real midgame
positions: 1.00x at kw=1, 1.07x at 2, 1.19x at 3, 1.36x at 5, 1.43x at 10. So
this asks whether seeing 2-3 keeps is worth 7-19% of the node rate.
"""
import os, statistics, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import Sprt, shard_offset

MERGE_OFF = 1 << 62
WS = se.DEFAULT_WIDTH_SCALE          # shipped, never a literal
ADAPT = tuple(se.SHIPPED_ADAPTIVE)   # shipped, never a literal
EVAL = 'tfit'                        # shipped eval


def play(b, ms, mode, hist, kw):
    """One move at the shipped config, varying ONLY keep_window."""
    if mode == 'nodes':
        # Matched DEPTH: neither side can be advantaged by its own cost, which
        # separates "does it see better?" from "is it worth the time?".
        return b.play_best(0, ms, 20, 16, WS, hist, EVAL, False, MERGE_OFF,
                           None, None, None, None, None, None, ADAPT,
                           None, None, kw)
    return b.play_best(ms, 64, 20, 16, WS, hist, EVAL, False, MERGE_OFF,
                       None, None, None, None, None, None, ADAPT,
                       None, None, kw)


def game(seed, arm_color, ms, arm_kw, base_kw, mode, max_plies=140):
    b = se.Board(se.Board.legal_draw(seed), "standard")
    b.setup_initial()
    hist = []
    dep = {'arm': [], 'base': []}
    for ply in range(max_plies):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        is_arm = (side == arm_color)
        hist.append(b.key_js)
        r = play(b, ms, mode, hist, arm_kw if is_arm else base_kw)
        dep['arm' if is_arm else 'base'].append(r[0])
        if r[3]:
            return r[4], ply + 1, dep
    return None, max_plies, dep


if __name__ == "__main__":
    pairs = int(sys.argv[1]); ms = int(sys.argv[2])
    arm_kw = int(sys.argv[3]); base_kw = int(sys.argv[4])
    mode = sys.argv[5] if len(sys.argv) > 5 else 'time'
    off = shard_offset(sys.argv[6] if len(sys.argv) > 6 else None)

    cfg = se.search_defaults()
    mmw = cfg['merge_min_width']
    print(f"  ENGINE CONFIG  keep_window arm={arm_kw} base={base_kw} "
          f"mode={mode} {'depth' if mode == 'nodes' else 'ms'}={ms} "
          f"eval={EVAL} width_scale={WS} adaptive={ADAPT} "
          f"merge_min_width={'OFF' if mmw >= (1 << 63) else mmw} "
          f"key_dash_reasons={cfg['key_dash_reasons']} "
          f"aspiration={cfg['aspiration']} "
          f"engine_default_keep_window={se.DEFAULT_KEEP_WINDOW}", flush=True)
    print(f"  SEEDS  {8_000_000 + off}..{8_000_000 + off + pairs - 1} "
          f"(shard offset {off}) -- two shards sharing a range replicate games "
          f"and invalidate the statistics", flush=True)

    s = Sprt(elo0=0.0, elo1=25.0)
    plies = []
    dep = {'arm': [], 'base': []}
    for i in range(pairs):
        for arm in ('red', 'blue'):
            w, n, d = game(8_000_000 + off + i, arm, ms, arm_kw, base_kw, mode)
            plies.append(n); dep['arm'] += d['arm']; dep['base'] += d['base']
            s.update(None if w is None else (w == arm))
            print(f"GAME seed={8_000_000 + off + i} arm={arm} winner={w} plies={n}",
                  flush=True)
        if s.verdict != 'continue':
            break
    print(f"SHARD arm_kw={arm_kw} base_kw={base_kw} mode={mode} unit={ms} "
          f"off={off} n={s.n} arm={s.wins} base={s.losses} unf={s.unfinished}")
    print(s.line(f"keep_window {arm_kw} vs {base_kw} ({mode})"))
    print(f"  mean plies {statistics.mean(plies):.1f}")
    if dep['arm']:
        print(f"  depth: arm {statistics.mean(dep['arm']):.2f}  "
              f"base {statistics.mean(dep['base']):.2f}   "
              f"(a LOWER arm depth at matched time is the node-rate cost showing up)")
