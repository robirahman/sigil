"""A3: how much is thinking time actually worth? Elo per doubling, with SPRT.

    ab_time.py <pairs> <base_ms> <multiplier> <eval_name> [seed_offset]

The load-bearing claim behind the whole learned-eval plan is "20x thinking time is
worth only ~57.5%" -- but that was FORTY GAMES, i.e. 52 +/- 55 Elo. It is
indistinguishable from both zero and from healthy scaling. This harness re-measures
it properly: the same engine against itself, one side given `multiplier` times the
time, colour-swapped and seeded.

Run it for several multipliers to get the scaling CURVE rather than one point. A
healthy engine gains 40-70 Elo per doubling; an engine whose evaluation is too
coarse to reward the extra depth gains far less, and that gap is the entire
justification for Phase B onward.

Run it for more than one `eval_name` too: if the richer structural eval scales
BETTER with time than material-only does, that is independent evidence that the
evaluation, not the search, is the binding constraint.
"""
import os, sys, statistics
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import Sprt

MERGE_OFF = 1 << 62      # the class merge is a known -285 Elo regression


def game(seed, slow_color, base_ms, mult, eval_name, max_plies=140):
    """`slow_color` is the side given the LONGER think time (the arm under test)."""
    b = se.Board(se.Board.legal_draw(seed), "standard")
    b.setup_initial()
    hist = []
    dep = {'slow': [], 'fast': []}
    for ply in range(max_plies):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        is_slow = (side == slow_color)
        ms = base_ms * mult if is_slow else base_ms
        hist.append(b.key_js)
        d, n, dt, over, w, sc, wd = b.play_best(
            ms, 64, 20, 16, 1, hist, eval_name, False, MERGE_OFF)
        dep['slow' if is_slow else 'fast'].append(d)
        if over:
            return w, ply + 1, dep
    return None, max_plies, dep


if __name__ == "__main__":
    pairs = int(sys.argv[1]); base = int(sys.argv[2])
    mult = int(sys.argv[3]); ev = sys.argv[4]
    off = int(sys.argv[5]) if len(sys.argv) > 5 else 0

    cfg = se.search_defaults()
    mmw = cfg['merge_min_width']
    print(f"  ENGINE CONFIG  eval={ev} merge_min_width="
          f"{'OFF' if mmw >= (1 << 63) else mmw}"
          f" key_dash_reasons={cfg['key_dash_reasons']}"
          f" key_dash_extra={cfg['key_dash_extra']}", flush=True)

    s = Sprt(elo0=0.0, elo1=25.0)
    plies = []; dep = {'slow': [], 'fast': []}
    for i in range(pairs):
        for slow in ('red', 'blue'):
            w, n, d = game(7_000_000 + off + i, slow, base, mult, ev)
            plies.append(n); dep['slow'] += d['slow']; dep['fast'] += d['fast']
            res = None if w is None else (w == slow)
            s.update(res)
            print(f"GAME seed={7_000_000+off+i} slow={slow} winner={w} plies={n}",
                  flush=True)
        if s.verdict != 'continue':
            break
    print(f"SHARD eval={ev} base={base} mult={mult} off={off} "
          f"n={s.n} slow={s.wins} fast={s.losses} unf={s.unfinished}")
    print(s.line(f"eval={ev} {mult}x time"))
    print(f"  mean plies {statistics.mean(plies):.1f}")
    if dep['slow']:
        print(f"  depth: {mult}x {statistics.mean(dep['slow']):.2f}  "
              f"1x {statistics.mean(dep['fast']):.2f}")
