"""Generate RANKING data: candidate-turn features plus which turn the search chose.

    selfplay_policy.py <games> <depth> <out_dir> <cap> [eval] [sample_every]

The earlier run recorded `best_rank` -- WHERE the current ordering failed -- which
cannot train a re-ranker, because it says nothing about the candidates that were
passed over. This records the candidates themselves.

Sizing. A ranking instance is `cap` turns x 18 features, so it is ~100x heavier per
position than the value data. Positions are therefore SAMPLED (`sample_every`), and
`cap` is bounded: the measured coverage curve says 98.2% of best moves sit inside
width 96, so a cap of 64-96 keeps almost every label while bounding the row size.

Instances whose chosen turn falls outside `cap` are dropped rather than trained on a
missing label -- and the count is reported, because silently dropping the hardest
positions would flatter any model trained on what remains.

Writes atomically (temp + rename): a watchdog kill inside a rewrite left one shard of
an earlier run at 0 bytes, which broke the loader for every other shard.
"""
import os, sys
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import shard_offset

MERGE_OFF = 1 << 62
CHECKPOINT_GAMES = 5


if __name__ == "__main__":
    games = int(sys.argv[1]); depth = int(sys.argv[2]); out_dir = sys.argv[3]
    cap = int(sys.argv[4])
    ev = sys.argv[5] if len(sys.argv) > 5 else "tfit"
    every = int(sys.argv[6]) if len(sys.argv) > 6 else 4
    off = shard_offset()
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"policy_{off}.npz")

    X = []          # (instances, cap, N_TURN)
    Y = []          # chosen index
    M = []          # how many candidates are real (rest are padding)
    P = []; G = []
    dropped_outside = 0
    ws = se.DEFAULT_WIDTH_SCALE

    def write():
        tmp = out + ".tmp.npz"
        np.savez_compressed(
            tmp,
            x=np.asarray(X, dtype=np.float32), y=np.asarray(Y, dtype=np.int16),
            nvalid=np.asarray(M, dtype=np.int16), ply=np.asarray(P, dtype=np.int16),
            game=np.asarray(G, dtype=np.int64),
            names=np.asarray(se.TURN_FEATURE_NAMES))
        os.replace(tmp, out)

    for i in range(games):
        b = se.Board(se.Board.legal_draw(9_500_000 + off + i), "standard")
        b.setup_initial()
        hist = []
        for ply in range(140):
            if b.gameover:
                break
            hist.append(b.key_js)
            if ply >= 4 and ply % every == 0:
                # one search: records the candidates AND plays the chosen move
                try:
                    rows, chosen, _gen = b.candidates_and_play(depth, ev, cap, ws, hist)
                except Exception:
                    rows, chosen = [], -1
                    b.play_best(0, depth, 20, 16, ws, hist, ev, False, MERGE_OFF)
                if chosen >= 0 and len(rows) >= 2:
                    pad = np.zeros((cap, len(rows[0])), dtype=np.float32)
                    pad[:len(rows)] = np.asarray(rows, dtype=np.float32)
                    X.append(pad); Y.append(chosen); M.append(len(rows))
                    P.append(ply); G.append(off * 1_000_000 + i)
                elif chosen < 0 and len(rows) > 0:
                    dropped_outside += 1
            else:
                b.play_best(0, depth, 20, 16, ws, hist, ev, False, MERGE_OFF)
        if (i + 1) % CHECKPOINT_GAMES == 0 and X:
            write()
            print(f"  {i+1}/{games} games, {len(Y)} ranking instances "
                  f"({dropped_outside} chosen-outside-cap dropped)", flush=True)
    if X:
        write()
    print(f"WROTE {out}: {len(Y)} ranking instances from {games} games, cap {cap}, "
          f"depth {depth}, eval {ev}; {dropped_outside} dropped for chosen-outside-cap")
