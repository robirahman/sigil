"""§2 label generation: (position, search-chosen turn) pairs for the move-ordering prior.

    selfplay_prior.py <games> <out_dir> [label_depth=7] [play_depth=5] [every=3] [from_ply=4]

Per sampled position we store ONLY the SFN, game id, ply, the chosen turn as packed
actions (`search::pack_action`), the root score and the label depth. Inputs (context
vector, candidate parts, stub ids) are regenerated at training time through
`PyBoard.prior_dataset`, the same Rust code that will serve the prior, so train and
serve inputs are identical by construction.

Labels come from a FIXED-DEPTH search with the shipped config (eval tfit, engine-default
width_scale, SHIPPED_ADAPTIVE, engine-default keep_window) so they do not depend on the
speed of the VM. Unlabelled plies are played at `play_depth`. Seeds come from
$SIGIL_SHARD_OFF (never argv) and games are keyed by seed so shards pool without
collisions. Writes atomically (temp + rename).
"""
import os, sys, time
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import shard_offset

CHECKPOINT_GAMES = 10
SEED_BASE = 12_000_000
AD = tuple(se.SHIPPED_ADAPTIVE)


def main():
    games = int(sys.argv[1]); out_dir = sys.argv[2]
    label_depth = int(sys.argv[3]) if len(sys.argv) > 3 else 7
    play_depth = int(sys.argv[4]) if len(sys.argv) > 4 else 5
    every = int(sys.argv[5]) if len(sys.argv) > 5 else 3
    from_ply = int(sys.argv[6]) if len(sys.argv) > 6 else 4
    off = shard_offset()
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"prior_{off}.npz")

    sfns, gid, ply_l, chosen, score, nodes = [], [], [], [], [], []
    print(f"  CONFIG label_depth={label_depth} play_depth={play_depth} every={every} "
          f"from_ply={from_ply} eval=tfit width_scale=default adaptive={AD} "
          f"seeds {SEED_BASE + off}..{SEED_BASE + off + games - 1}", flush=True)

    def write():
        tmp = out + ".tmp.npz"
        # Packed action lists are variable length; store as a padded (n, 8) uint32 with 0 = none.
        ch = np.zeros((len(chosen), 8), dtype=np.uint32)
        for i, c in enumerate(chosen):
            ch[i, :len(c)] = c[:8]
        np.savez_compressed(tmp, sfn=np.asarray(sfns), game=np.asarray(gid, dtype=np.int64),
                            ply=np.asarray(ply_l, dtype=np.int16), chosen=ch,
                            score=np.asarray(score, dtype=np.int32),
                            nodes=np.asarray(nodes, dtype=np.int64),
                            label_depth=np.int16(label_depth))
        os.replace(tmp, out)

    t0 = time.time()
    for g in range(games):
        seed = SEED_BASE + off + g
        b = se.Board(se.Board.legal_draw(seed), "standard")
        b.setup_initial()
        hist = []
        for ply in range(140):
            hist.append(b.key_js)
            label = ply >= from_ply and (ply - from_ply) % every == 0
            d = label_depth if label else play_depth
            before, packed, sc, nn = b.prior_label_and_play(d, 'tfit', None, AD, None, hist)
            if label and packed:
                sfns.append(before); gid.append(seed); ply_l.append(ply)
                chosen.append(packed); score.append(sc); nodes.append(nn)
            if b.gameover or not packed:
                break
        if (g + 1) % CHECKPOINT_GAMES == 0:
            write()
            print(f"  game {g+1}/{games}: {len(sfns)} labels, {time.time()-t0:.0f}s", flush=True)
    write()
    print(f"WROTE {out}: {len(sfns)} labels from {games} games in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
