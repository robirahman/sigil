"""A/B two eval presets head-to-head under SPRT, at matched TIME and matched NODES.

    ab_eval.py <pairs> <ms> <arm_eval> <base_eval> [seed_offset] [mode]

    mode = time  (default) both sides get `ms` milliseconds
         = nodes both sides get a fixed DEPTH instead, so the comparison is
           "is the knowledge better?" rather than "is it worth the cost?"

Reporting both is the discriminator the four dash experiments lacked. A change can
easily be better per node and worse per second; those are different verdicts with
different fixes ("optimise" vs "abandon"), and a single matched-time number cannot
tell them apart.

Colour-swapped and seeded: Sigil is not colour-symmetric (red needs a real lead of
4, blue 2, blue holds the +1 token), so colours must be balanced.
"""
import os, sys, statistics
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import Sprt

MERGE_OFF = 1 << 62


def game(seed, arm_color, ms, arm_eval, base_eval, mode, max_plies=140):
    b = se.Board(se.Board.legal_draw(seed), "standard")
    b.setup_initial()
    hist = []
    dep = {'arm': [], 'base': []}
    for ply in range(max_plies):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        is_arm = (side == arm_color)
        ev = arm_eval if is_arm else base_eval
        hist.append(b.key_js)
        if mode == 'nodes':
            # Matched DEPTH: no clock, so neither side can be advantaged by the
            # cost of its own evaluation. `ms` is reused as the depth.
            r = b.play_best(0, ms, 20, 16, 1, hist, ev, False, MERGE_OFF)
        else:
            r = b.play_best(ms, 64, 20, 16, 1, hist, ev, False, MERGE_OFF)
        dep['arm' if is_arm else 'base'].append(r[0])
        if r[3]:
            return r[4], ply + 1, dep
    return None, max_plies, dep


if __name__ == "__main__":
    pairs = int(sys.argv[1]); ms = int(sys.argv[2])
    arm_eval = sys.argv[3]; base_eval = sys.argv[4]
    off = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    mode = sys.argv[6] if len(sys.argv) > 6 else 'time'

    cfg = se.search_defaults()
    mmw = cfg['merge_min_width']
    print(f"  ENGINE CONFIG  arm={arm_eval} base={base_eval} mode={mode} "
          f"{'depth' if mode=='nodes' else 'ms'}={ms} "
          f"merge_min_width={'OFF' if mmw >= (1<<63) else mmw} "
          f"key_dash_reasons={cfg['key_dash_reasons']} "
          f"key_dash_extra={cfg['key_dash_extra']}", flush=True)

    s = Sprt(elo0=0.0, elo1=25.0)
    plies = []; dep = {'arm': [], 'base': []}
    for i in range(pairs):
        for arm in ('red', 'blue'):
            w, n, d = game(8_000_000 + off + i, arm, ms, arm_eval, base_eval, mode)
            plies.append(n); dep['arm'] += d['arm']; dep['base'] += d['base']
            s.update(None if w is None else (w == arm))
            print(f"GAME seed={8_000_000+off+i} arm={arm} winner={w} plies={n}",
                  flush=True)
        if s.verdict != 'continue':
            break
    print(f"SHARD arm={arm_eval} base={base_eval} mode={mode} unit={ms} off={off} "
          f"n={s.n} arm={s.wins} base={s.losses} unf={s.unfinished}")
    print(s.line(f"{arm_eval} vs {base_eval} ({mode})"))
    print(f"  mean plies {statistics.mean(plies):.1f}")
    if dep['arm']:
        print(f"  depth: arm {statistics.mean(dep['arm']):.2f}  "
              f"base {statistics.mean(dep['base']):.2f}")
