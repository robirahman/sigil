"""Summary statistics for selfplay_v2 chunks (run on a sample or the whole pool).

    selfplay_v2_stats.py <npz-glob> [...]

Prints positions, candidates per position, bound mix, exploration share and
classes, start-kind mix, winner balance, how often each Tectonic/Providence spell
appears, and how often an exploration turn scored at or above the searched best
(a turn the generator never emits that the depth D-1 search rates as good as the
engine's choice -- the cases Step 4's policy has to learn to generate).
"""
import glob, sys
import numpy as np
from selfplay_v2 import load_v2

NEW = {39: 'Fissure', 40: 'Rock_Slide', 41: 'Bulwark', 42: 'Dividend', 43: 'Annuity', 44: 'Endowment'}


def main():
    paths = sorted(p for g in sys.argv[1:] for p in glob.glob(g))
    P, C, M = load_v2(paths)
    n = len(P['sfn'])
    print(f"{len(paths)} chunks, {n} positions, {len(C['score'])} candidate rows, "
          f"engine {sorted({m['engine'] for m in M})}, depth {sorted({m['depth'] for m in M})}")
    root = C['kind'] == 0; ex = C['kind'] == 1
    print(f"root candidates/position {root.sum() / n:.1f}; bounds exact/upper/lower "
          f"{np.bincount(C['bound'][root], minlength=3).tolist()}; urank -1: {(C['urank'][root] < 0).mean():.3%}")
    xp = P['x_enum'] >= 0
    print(f"exploration: {xp.mean():.1%} of positions, {ex.sum()} rows ({ex.sum() / max(xp.sum(), 1):.1f}/explored position), "
          f"classes sac-dash/cast/other {np.bincount(C['xclass'][ex], minlength=3).tolist()}, "
          f"missing results/explored position {P['x_missing'][xp].mean():.0f} (of which instant losses {P['x_suicide'][xp].mean():.0f}), "
          f"enumeration capped {P['x_trunc'][xp].mean():.1%}")
    # exploration turns at least as good as the searched best of their position
    owner = np.repeat(np.arange(n), P['n_cand'])
    better = ex & (C['score'] >= P['score'][owner])
    near = ex & (C['score'] >= P['score'][owner] - 50)
    print(f"exploration turns >= searched best: {better.sum()} ({better.sum() / max(ex.sum(), 1):.2%}); "
          f"within 0.5 stone: {near.sum()} ({near.sum() / max(ex.sum(), 1):.2%}); "
          f"positions with one: {len(np.unique(owner[better]))}")
    print(f"start kind fresh-std/fresh-comp/human positions {np.bincount(P['kind'], minlength=3).tolist()}; "
          f"random plies {P['random_played'].mean():.1%}; y 0/1/unknown "
          f"{[(P['y'] == v).sum() for v in (0, 1, 255)]}")
    games = np.unique(P['game'], return_index=True)[1]
    sp = P['spells'][games]
    print(f"games {len(games)}; with a Tectonic/Providence spell {np.isin(sp, list(NEW)).any(1).mean():.1%}; per spell "
          + ", ".join(f"{NEW[i]} {np.isin(sp, [i]).any(1).mean():.1%}" for i in NEW))
    print(f"ply median {np.median(P['ply']):.0f}, >= 20: {(P['ply'] >= 20).mean():.1%}; "
          f"nodes/position median {np.median(P['nodes']):.0f}")


if __name__ == '__main__':
    main()
