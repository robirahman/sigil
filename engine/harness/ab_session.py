"""A/B a PERSISTENT search (one table for the whole game, optionally pondering)
against the shipped fresh-table-per-move engine.

    ab_session.py <pairs> <ms> <mode>

    mode = persist   arm keeps one `SearchSession` per game (TT persistence only)
         = ponder    arm also ponders the opponent's position for the opponent's
                     move time before every move (TT priming, root position)

The base arm is `PyBoard.play_best`: a fresh `Search` per move, shipped config.
Both arms play eval `tfit`, engine-default width_scale, SHIPPED_ADAPTIVE and
keep_window; colour-swapped and seeded; the shard offset comes from
$SIGIL_SHARD_OFF, never argv.

HONEST PONDERING. The ponder sees the position BEFORE the opponent moves and
never the opponent's choice -- exactly what the browser's TT-priming ponder
sees while a human thinks. The opponent then searches with its own fresh
table, and only then does the arm search with the primed one. CPU per game is
~1.5x a plain arena.
"""
import os, statistics, sys
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import Sprt, shard_offset

EV = 'tfit'
TT_BITS = 20
ADAPTIVE = tuple(se.SHIPPED_ADAPTIVE) if hasattr(se, 'SHIPPED_ADAPTIVE') else (0.10, 2, 6)


def game(seed, arm_color, ms, mode, max_plies=140):
    b = se.Board(se.Board.legal_draw(seed), "standard")
    b.setup_initial()
    sess = se.SearchSession(TT_BITS)
    hist = []
    dep = {'arm': [], 'base': []}
    warm_first = None
    for ply in range(max_plies):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        is_arm = (side == arm_color)
        hist.append(b.key_js)
        if is_arm:
            r = sess.play_best(b, ms, 64, 16, None, hist, EV, False, adaptive=ADAPTIVE)
        else:
            if mode == 'ponder':
                # The arm ponders THIS position (opponent to move) for the
                # opponent's think time, without seeing what they will play.
                sess.ponder(b, ms, 64, 16, None, hist, EV, adaptive=ADAPTIVE)
            r = b.play_best(ms, 64, TT_BITS, 16, None, hist, EV, False, adaptive=ADAPTIVE)
        dep['arm' if is_arm else 'base'].append(r[0])
        if is_arm and warm_first is None and ply >= 2:
            warm_first = sess.tt_filled
        if r[3]:
            return r[4], ply + 1, dep, warm_first
    return None, max_plies, dep, warm_first


if __name__ == "__main__":
    pairs = int(sys.argv[1]); ms = int(sys.argv[2]); mode = sys.argv[3]
    if mode not in ('persist', 'ponder'):
        sys.exit("mode must be persist or ponder")
    off = shard_offset()
    cfg = se.search_defaults()
    print(f"  ENGINE CONFIG  eval={EV} mode={mode} tt_bits={TT_BITS} ms={ms} "
          f"width_scale=default adaptive={ADAPTIVE} keep_window=default "
          f"defaults(q_depth={cfg['q_depth']}, aspiration={cfg['aspiration']})", flush=True)
    print(f"  SEEDS  {8_000_000 + off}..{8_000_000 + off + pairs - 1} (shard offset {off})",
          flush=True)
    s = Sprt(elo0=0.0, elo1=15.0)
    plies = []; dep = {'arm': [], 'base': []}; filled = []
    for i in range(pairs):
        for arm in ('red', 'blue'):
            w, n, d, wf = game(8_000_000 + off + i, arm, ms, mode)
            plies.append(n); dep['arm'] += d['arm']; dep['base'] += d['base']
            if wf is not None: filled.append(wf)
            s.update(None if w is None else (w == arm))
            print(f"GAME seed={8_000_000+off+i} arm={arm} winner={w} plies={n}", flush=True)
        if s.verdict != 'continue':
            break
    print(f"SHARD mode={mode} eval={EV} ms={ms} off={off} n={s.n} armwins={s.wins} "
          f"basewins={s.losses} unf={s.unfinished}")
    print(s.line(f"{mode} vs fresh (eval={EV}, {ms}ms)"))
    print(f"  mean plies {statistics.mean(plies):.1f}")
    if dep['arm']:
        print(f"  depth: arm {statistics.mean(dep['arm']):.2f}  base {statistics.mean(dep['base']):.2f}")
    if filled:
        print(f"  arm table entries at its 2nd move: median {statistics.median(filled):.0f} "
              f"(0 would mean persistence is not wired)")
