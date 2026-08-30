"""E0a: how much static-eval signal SURVIVES search, as a function of search depth?

    selfplay_evalgate.py <games> <play_ms> <out_dir> <sample_every> [eval]

THE QUESTION THIS ANSWERS. Static positional features add +0.0140 nats over material
alone, but only +0.0079 on top of a DEPTH-7 search score -- search already absorbs
~44% of what they know, and the shipped engine reaches depth 7-10. If the residual
keeps decaying, a better leaf evaluation is capped no matter how good the model is.
So: score the SAME position at several SEARCH BUDGETS, and fit residual gain against
effort.

BUDGETS ARE TIMES, NOT DEPTHS. A fixed depth 9 at the shipping width_scale costs over
100 SECONDS for one position -- widths run 24..160 against a median 316 legal turns,
so fixed-depth scoring is unbounded and unusable here. Time budgets are bounded,
predictable, and are how the engine actually runs.

    KILL: residual static gain < 0.004 nats at depth 9 caps the whole direction at
    ~15-25 Elo, and the effort belongs on search instead.

WHY A FRESH RUN. The existing 4.37M-position set stores FEATURES but not SFNs, so its
positions cannot be re-scored at other depths -- a gap in the original label design.
Saving the SFN costs a few bytes and makes any future re-scoring possible; it should
have been there from the start.

Games are played at `play_ms` with the SHIPPING width_scale, so positions are
on-policy for the engine the evaluation will actually run in. Long-budget scores are taken only at sampled positions, because the 10 s budget costs
1000x the 10 ms one and would otherwise dominate everything.
"""
import os, sys
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import shard_offset

MERGE_OFF = 1 << 62
SCORE_MS = (10, 100, 1000, 10000)   # ~11.1 s of scoring per sampled position
CHECKPOINT_GAMES = 2

if __name__ == "__main__":
    games = int(sys.argv[1]); play_ms = int(sys.argv[2]); out_dir = sys.argv[3]
    every = int(sys.argv[4]); ev = sys.argv[5] if len(sys.argv) > 5 else "tfit"
    off = shard_offset()
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"evalgate_{off}.npz")
    ws = se.DEFAULT_WIDTH_SCALE

    HAND=[]; FULL=[]; SC=[]; PLY=[]; GAME=[]; SFN=[]; Y=[]
    def write():
        tmp = out + ".tmp.npz"
        np.savez_compressed(tmp,
            hand=np.asarray(HAND, dtype=np.int32), full=np.asarray(FULL, dtype=np.float32),
            scores=np.asarray(SC, dtype=np.float32), ply=np.asarray(PLY, dtype=np.int16),
            game=np.asarray(GAME, dtype=np.int64), y=np.asarray(Y, dtype=np.uint8),
            sfn=np.asarray(SFN), budgets_ms=np.asarray(SCORE_MS),
            hand_names=np.asarray(se.HAND_FEATURE_NAMES))
        os.replace(tmp, out)

    for g in range(games):
        b = se.Board(se.Board.legal_draw(9_900_000 + off + g), "standard")
        b.setup_initial()
        hist=[]; rows=[]
        for ply in range(140):
            if b.gameover: break
            sfn = b.to_sfn()
            side = 'red' if sfn.split()[1]=='r' else 'blue'
            if ply >= 4 and ply % every == 0:
                # the SAME position scored at several depths; that is the whole point
                sc=[]
                for ms in SCORE_MS:
                    c = se.Board.from_sfn(sfn)
                    r = c.play_best(ms, 64, 20, 16, ws, [], ev, False, MERGE_OFF)
                    sc.append(float(r[5]))
                rows.append((ply, 1 if side=='red' else 0, b.hand_features(side),
                             b.full_features(side), sc, sfn))
            hist.append(b.key_js)
            b.play_best(play_ms, 64, 20, 16, ws, hist, ev, False, MERGE_OFF)
        w = b.winner
        if w not in ('red','blue'):
            continue
        for ply, is_red, hand, full, sc, sfn in rows:
            HAND.append(hand); FULL.append(full); SC.append(sc); PLY.append(ply)
            GAME.append(off*1_000_000+g); SFN.append(sfn)
            Y.append(1 if (w=='red')==bool(is_red) else 0)
        if (g+1) % CHECKPOINT_GAMES == 0 and Y:
            write(); print(f"  {g+1}/{games} games, {len(Y)} scored positions", flush=True)
    if Y: write()
    print(f"WROTE {out}: {len(Y)} positions from {games} games, "
          f"play_ms {play_ms} ws {ws}, scored at {SCORE_MS} ms")
