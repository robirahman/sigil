"""Rollout labels for a learned competitive-opening selector (2026-10, round 2).

    opening_rollouts.py <draws> <games_per_cell> <ms> <out_dir>

The competitive variant starts on an empty board and each side's first turn is
a free placement. The shipped selector (`opening.rs`) picks the SIGIL from the
strategy survey's tables and leaves the node to the search. To learn a selector
from play instead, we need the value of every sigil choice, not just the one a
policy happened to make -- so this plays them all out:

  * red phase: for each sigil slot s, `games_per_cell` games in which red's first
    placement is forced into s (`se.set_opening_force`; the search picks the node
    inside it) and everything after is the shipped v25 engine, blue's reply
    included (selector on);
  * blue phase: red opens with the shipped selector's pick; for each slot s that
    still has an empty node, `games_per_cell` games with blue's reply forced into s.

Both sides play `ms` per move with the shipped eval and generator policy
(SIGIL_POLICY=shipped through ab_search.play). Colour is fixed by the phase, so a
cell's win rate is the forced side's. Seeds come from $SIGIL_SHARD_OFF; each draw is
`Board.legal_draw(2_000_000_000 + offset + i)`. One npz per shard, rewritten
atomically after every draw:

  draw[k, 9] spell ids; side[k] 0 red / 1 blue; slot[k]; red_slot[k] (blue phase:
  red's opening slot, else -1); book_slot[k] (the shipped selector's pick for the
  side to move in that phase); wins[k]; games[k]; plies[k] (mean game length).
"""
import json
import os
import sys

os.environ['SIGIL_POLICY'] = 'shipped'
os.environ['SIGIL_VARIANT'] = 'competitive'
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import numpy as np                      # noqa: E402
import sigil_engine as se               # noqa: E402
import ab_search as ab                  # noqa: E402
from sprt import shard_offset           # noqa: E402

EV = se.SHIPPED_EVAL
MAX_PLIES = 140


def new_board(draw):
    b = se.Board(list(draw), 'competitive')
    b.setup_initial()
    b.turn_counter = 1
    return b


def slot_of(node_mask_after, before):
    """The sigil slot holding the one stone that `before` -> after added."""
    added = node_mask_after & ~before
    for s, m in enumerate(se.SIGIL_MASKS):
        if added & m:
            return s
    return -1


def occupied(b):
    """Bit mask of occupied nodes, from the SFN stone field."""
    field = b.to_sfn().split('/', 1)[0]
    m = 0
    for i, ch in enumerate(field):
        if ch in 'rb':
            m |= 1 << i
    return m


def play_out(b, ms, force_first_for=None, mask=0):
    """Play `b` to the end. The first move of side `force_first_for` is forced
    into `mask`. Returns (winner, plies)."""
    hist = []
    for ply in range(MAX_PLIES):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        hist.append(b.key_js)
        forced = (force_first_for == side and occupied_by(b, side) == 0)
        se.set_opening_force(mask if forced else 0)
        r = ab.play(b, ms, EV, hist, 'opening_book', 1)
        se.set_opening_force(0)
        if r[3]:
            return r[4], ply + 1
    return None, MAX_PLIES


def occupied_by(b, side):
    field = b.to_sfn().split('/', 1)[0]
    ch = 'r' if side == 'red' else 'b'
    return sum(1 for c in field if c == ch)


def book_slot(b):
    p = se.opening_pick(b.to_sfn())
    return -1 if p is None else int(p['pos'])


def main():
    n_draws, per_cell, ms, out_dir = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    off = shard_offset()
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f'opening_rollouts_{off}.npz')
    R = {k: [] for k in ('draw', 'side', 'slot', 'red_slot', 'book_slot', 'wins', 'games', 'plies')}

    def write():
        tmp = path + '.tmp.npz'
        np.savez_compressed(tmp, draw=np.asarray(R['draw'], np.uint8).reshape(-1, 9),
                            side=np.asarray(R['side'], np.uint8), slot=np.asarray(R['slot'], np.int8),
                            red_slot=np.asarray(R['red_slot'], np.int8),
                            book_slot=np.asarray(R['book_slot'], np.int8),
                            wins=np.asarray(R['wins'], np.int16), games=np.asarray(R['games'], np.int16),
                            plies=np.asarray(R['plies'], np.float32),
                            meta=np.asarray(json.dumps(dict(ms=ms, per_cell=per_cell, eval=EV,
                                                            policy=list(se.SHIPPED_POLICY), shard_off=off))))
        os.replace(tmp, path)

    def cell(draw, side, slot, red_slot, bslot, wins, games, plies):
        R['draw'].append(list(draw)); R['side'].append(side); R['slot'].append(slot)
        R['red_slot'].append(red_slot); R['book_slot'].append(bslot)
        R['wins'].append(wins); R['games'].append(games); R['plies'].append(plies)

    for i in range(n_draws):
        draw = se.Board.legal_draw(2_000_000_000 + off + i)
        # red phase
        b0 = new_board(draw)
        red_book = book_slot(b0)
        for s in range(9):
            w = n = 0; pl = []
            for g in range(per_cell):
                b = new_board(draw)
                winner, plies = play_out(b, ms, 'red', se.SIGIL_MASKS[s])
                n += 1; w += winner == 'red'; pl.append(plies)
            cell(draw, 0, s, -1, red_book, w, n, float(np.mean(pl)))
        # blue phase: red opens with the shipped selector's pick
        b1 = new_board(draw)
        before = occupied(b1)
        se.set_opening_book(True)
        ab.play(b1, ms, EV, [b1.key_js], 'opening_book', 1)
        rs = slot_of(occupied(b1), before)
        blue_book = book_slot(b1)
        free = ~occupied(b1)
        for s in range(9):
            if se.SIGIL_MASKS[s] & free == 0:
                continue
            w = n = 0; pl = []
            for g in range(per_cell):
                b = new_board(draw)
                hist = [b.key_js]
                se.set_opening_force(se.SIGIL_MASKS[rs])
                ab.play(b, ms, EV, hist, 'opening_book', 1)   # red into its book sigil
                se.set_opening_force(0)
                winner, plies = play_out(b, ms, 'blue', se.SIGIL_MASKS[s] & free)
                n += 1; w += winner == 'blue'; pl.append(plies + 1)
            cell(draw, 1, s, rs, blue_book, w, n, float(np.mean(pl)))
        write()
        print(f"DRAW {i} off={off} draw={','.join(map(str, draw))} red_book={red_book} "
              f"red_slot={rs} blue_book={blue_book} cells={len(R['slot'])}", flush=True)
    print(f"WROTE {path}: {len(R['slot'])} cells", flush=True)


if __name__ == '__main__':
    main()
