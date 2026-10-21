"""Very Hard vs Very Hard from sampled start positions: the position win-probability data.

    position_selfplay.py <games> <starts> [ms=60000] [max_plies=160] [depths=4,5,6]

`starts` is a position_starts.py file (local path or gs:// URL). The shard offset
comes from $SIGIL_SHARD_OFF (never argv), so the argument list composes with
`gcp/runner.sh`: shard s = off // 1000 plays starts s*games .. s*games+games-1.

Each start is first scored with `se.analyze` (a fresh table per call, the shipped
eval, width and adaptive config) at every depth in
`depths`; those are the evals the site will hold for a position (the live
in-browser search reports the depth it completed; stored game_evals are depth
6), and fit_position_winprob.py fits one eval -> P(red wins) curve per depth.
Then both sides play as the site's Very Hard tier (tier_roundrobin.py's TIERS:
60 s a move, 21-bit persistent table, shipped policy and exploration tail),
without pondering: the two sides are identical, so the target is the result
between equal, strongest-available players. A game that hits `max_plies` is
reported with winner None and left out of the fit.

No earlier history goes into either the evals or the game: a rated game from a
position starts with no repetition counts (GameController loads only the SFN),
so the calibration must not either. (The 2026-10-21 run passed the human
games' history; fit_position_winprob.py --exclude drops the 50 starts whose
history held a repetition, the only ones it could affect.)

One `POSRESULT {json}` line per game (start, src, per-depth evals, winner,
plies, seconds); the runner ships the logs.
"""
import json, os, sys, time
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import shard_offset
from selfplay_v2 import _fetch
from tier_roundrobin import TIERS, WIDTH, ADAPTIVE

EVAL = se.SHIPPED_EVAL


def evals_at(sfn, hist, depths):
    out = {}
    for d in depths:
        t = time.time()
        r = se.analyze(sfn, EVAL, max_depth=d, time_ms=0, tt_bits=20, history_sfns=hist,
                       width_scale=WIDTH, adaptive=ADAPTIVE)
        out[str(d)] = dict(mover=r['mover'], stones=r.get('stones'), mate=r.get('mate_in_turns'),
                           proven=r.get('proven'), score=r.get('score'), depth=r.get('depth'),
                           secs=round(time.time() - t, 2))
    return out


def play(sfn, hist, ms, tt, max_plies):
    sess = {c: se.SearchSession(tt) for c in ('red', 'blue')}
    for s in sess.values():
        s.new_game()
    b = se.Board.from_sfn(sfn)
    keys = [se.Board.from_sfn(h).key_js for h in hist]
    for ply in range(max_plies):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        keys.append(b.key_js)
        d, nodes, dt, over, w, score, _ = sess[side].play_best(
            b, ms, 64, 16, WIDTH, list(keys), EVAL, adaptive=ADAPTIVE)
        print(f"  ply {ply+1} {side} depth={d} nodes={nodes} s={dt:.1f} score={score}", flush=True)
        if over:
            return w, ply + 1
    return None, max_plies


def main():
    a = sys.argv[1:]
    games, starts_path = int(a[0]), a[1]
    ms = int(a[2]) if len(a) > 2 else TIERS['very_hard']['ms']
    max_plies = int(a[3]) if len(a) > 3 else 160
    depths = [int(x) for x in (a[4] if len(a) > 4 else '4,5,6').split(',')]
    assert games < 1000, "offsets step by 1000 per shard"
    if hasattr(se, 'SHIPPED_POLICY'):
        se.set_policy(*se.SHIPPED_POLICY)
    if hasattr(se, 'SHIPPED_EXPLORE'):
        se.set_policy_explore(*se.SHIPPED_EXPLORE)
    starts = json.loads(_fetch(starts_path))
    shard = shard_offset() // 1000
    tt = TIERS['very_hard']['tt']
    print(f"CONFIG eval={EVAL} ms={ms} tt={tt} width={WIDTH} adaptive={ADAPTIVE} "
          f"depths={depths} shard={shard} starts={len(starts)}", flush=True)
    for g in range(games):
        i = shard * games + g
        if i >= len(starts):
            break
        st = starts[i]
        t0 = time.time()
        ev = evals_at(st['sfn'], [], depths)
        winner, plies = play(st['sfn'], [], ms, tt, max_plies)
        rec = dict(i=i, sfn=st['sfn'], src=st['src'], ply=st['ply'], evals=ev, winner=winner,
                   plies=plies, ms=ms, eval=EVAL, secs=round(time.time() - t0))
        print("POSRESULT " + json.dumps(rec, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
