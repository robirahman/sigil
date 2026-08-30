"""Whole-engine A/B: (eval, width_scale) vs (eval, width_scale).

    ab_engine.py <pairs> <ms> <arm_eval> <arm_ws> <base_eval> <base_ws>

Every other harness varies ONE thing with the rest held fixed, which is right for
attributing a change but cannot answer "is the engine better than it was". The eval
gain was measured at width_scale 1 and the widening gain at eval tfit, so neither
tells us what the two together are worth against the engine that was actually
playtested -- and Elo does not chain reliably, especially here, where the widening
gain is +223 at 3 s but only +47 at 300 ms.

The shard's seed offset comes from $SIGIL_SHARD_OFF.
"""
import os, statistics, sys
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import Sprt, shard_offset

MERGE_OFF = 1 << 62


def game(seed, arm_color, ms, aev, aws, bev, bws, max_plies=140):
    b = se.Board(se.Board.legal_draw(seed), "standard")
    b.setup_initial()
    hist = []; dep = {'arm': [], 'base': []}
    for ply in range(max_plies):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        is_arm = (side == arm_color)
        ev, ws = (aev, aws) if is_arm else (bev, bws)
        hist.append(b.key_js)
        r = b.play_best(ms, 64, 20, 16, ws, hist, ev, False, MERGE_OFF)
        dep['arm' if is_arm else 'base'].append(r[0])
        if r[3]:
            return r[4], ply + 1, dep
    return None, max_plies, dep


if __name__ == "__main__":
    pairs = int(sys.argv[1]); ms = int(sys.argv[2])
    aev = sys.argv[3]; aws = int(sys.argv[4])
    bev = sys.argv[5]; bws = int(sys.argv[6])
    off = shard_offset()
    print(f"  ENGINE CONFIG  arm=({aev}, ws{aws})  base=({bev}, ws{bws})  ms={ms}",
          flush=True)
    print(f"  SEEDS  {5_000_000+off}..{5_000_000+off+pairs-1} (shard offset {off})",
          flush=True)
    s = Sprt(elo0=0.0, elo1=25.0)
    plies = []; dep = {'arm': [], 'base': []}
    for i in range(pairs):
        for arm in ('red', 'blue'):
            w, n, d = game(5_000_000 + off + i, arm, ms, aev, aws, bev, bws)
            plies.append(n); dep['arm'] += d['arm']; dep['base'] += d['base']
            s.update(None if w is None else (w == arm))
            print(f"GAME seed={5_000_000+off+i} arm={arm} winner={w} plies={n}", flush=True)
        if s.verdict != 'continue':
            break
    print(f"SHARD arm={aev}_ws{aws} base={bev}_ws{bws} ms={ms} off={off} n={s.n} "
          f"armwins={s.wins} basewins={s.losses} unf={s.unfinished}")
    print(s.line(f"({aev},ws{aws}) vs ({bev},ws{bws}) @{ms}ms"))
    print(f"  mean plies {statistics.mean(plies):.1f}")
    if dep['arm']:
        print(f"  depth: arm {statistics.mean(dep['arm']):.2f}  "
              f"base {statistics.mean(dep['base']):.2f}")
