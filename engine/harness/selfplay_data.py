"""C1: generate self-play positions labelled with the eventual game outcome.

    selfplay_data.py <games> <depth> <out_dir> <random_ply_pct> [seed_offset]

`seed_offset` is LAST so the argument list composes with the generic cloud runner,
which appends the shard offset. Each shard writes `<out_dir>/positions_<offset>.npz`.

Phase C asks the cheapest possible question that can kill the learned-eval plan:
**is there positional signal in a Sigil position that the hand features miss?**

Note what the label is. Positions are labelled with **who actually won**, not with
the engine's own search score. That matters for two reasons:

  * it does not depend on Phase B, so this runs on the current engine. A teacher's
    score would inherit whatever is wrong with today's eval; the game result cannot.
  * it cannot be Goodharted. A model that fits search scores has learned to imitate
    the search, which is worthless; a model that fits outcomes has learned something
    about winning.

Outcome labels are unusually cheap here: 34.5 plies and **no draws**, so credit
assignment is ~2.5x better per position than chess.

Diversity, so the set is not one opening repeated: the spell draw varies by seed, a
fraction of plies are played at random (`random_ply_pct`), and the competitive
variant's free opening placement is used for a share of games -- uniform-random
first placements give 1,482 distinct rule-legal openings at zero label distortion.

Output is a compressed npz with, per position: hand features, full features, the
game's 9 spell ids, ply index, side to move, and the eventual winner.
"""
import os, sys, random
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as se

MERGE_OFF = 1 << 62
# Positions are dumped from every ply, but the consumer weights plies ~5-22: with
# depth 10-12 over a 34.5-ply game the engine is already near-exact over the last
# third, so that is where the evaluation earns its keep.


def play_one(seed, depth, rng, random_ply_pct, competitive):
    variant = "competitive" if competitive else "standard"
    b = se.Board(se.Board.legal_draw(seed), variant)
    b.setup_initial()
    spells = b.spell_ids()
    rows = []          # (ply, side_is_red, hand, full, search_score)
    hist = []
    for ply in range(140):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        # Record BEFORE moving, from the side-to-move's point of view.
        row = [ply, 1 if side == 'red' else 0,
               b.hand_features(side), b.full_features(side), float('nan')]
        rows.append(row)
        hist.append(b.key_js)
        if rng.random() < random_ply_pct:
            # A random legal turn. Cheap diversity, and safe because the label is
            # the game outcome rather than a per-move judgement.
            turns = b.enumerate_turns()
            if turns:
                b.apply_turn_tuples(turns[rng.randrange(len(turns))], side)
                if b.gameover:
                    return rows, b.winner, spells
                b.advance_turn()
                continue    # row keeps NaN: no search was run for this position
        d, n, dt, over, w, sc, wd = b.play_best(
            0, depth, 20, 16, 1, hist, "material", False, MERGE_OFF)
        row[4] = float(sc)          # the depth-`depth` score for THIS position
        if over:
            return rows, w, spells
    return rows, None, spells


if __name__ == "__main__":
    games = int(sys.argv[1]); depth = int(sys.argv[2]); out_dir = sys.argv[3]
    rpct = float(sys.argv[4]) if len(sys.argv) > 4 else 0.08
    off = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"positions_{off}.npz")

    rng = random.Random(12345 + off)
    H, F, S, P, R, Y, G, Q = [], [], [], [], [], [], [], []
    kept = dropped = 0
    for i in range(games):
        seed = 9_000_000 + off + i
        competitive = (i % 4 == 0)      # a quarter of games use the free opening
        rows, winner, spells = play_one(seed, depth, rng, rpct, competitive)
        if winner not in ('red', 'blue'):
            dropped += 1                # unfinished games carry no label
            continue
        kept += 1
        for ply, is_red, hand, full, q in rows:
            H.append(hand); F.append(full); S.append(spells)
            P.append(ply); R.append(is_red); G.append(off * 1_000_000 + i)
            Q.append(q)
            # y = 1 if the SIDE TO MOVE at this position went on to win.
            Y.append(1 if (winner == 'red') == bool(is_red) else 0)
        if (i + 1) % 200 == 0:
            print(f"  {i+1}/{games} games, {len(Y)} positions", flush=True)

    np.savez_compressed(
        out,
        hand=np.asarray(H, dtype=np.int32), full=np.asarray(F, dtype=np.float32),
        spells=np.asarray(S, dtype=np.uint8), ply=np.asarray(P, dtype=np.int16),
        is_red=np.asarray(R, dtype=np.uint8), y=np.asarray(Y, dtype=np.uint8),
        game=np.asarray(G, dtype=np.int64),
        score=np.asarray(Q, dtype=np.float32),
        hand_names=np.asarray(se.HAND_FEATURE_NAMES))
    print(f"WROTE {out}: {len(Y)} positions from {kept} games "
          f"({dropped} unfinished dropped), depth {depth}, random_ply {rpct}")
