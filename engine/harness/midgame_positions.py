"""Write a fixed set of MIDGAME positions (SFN, one per line) for deterministic benches.

Random independent stone placement is not a valid benchmark: 52% of such positions are
already game over (FINDINGS "Benchmarking on random positions is invalid here"). These come
from engine self-play under a short clock and are sampled at fixed plies so the set has
opening-ish, middle and late positions with material on the board. The FILE is what gets
committed and reused; regenerating it changes the bench baseline, so do not.

    python3 engine/harness/midgame_positions.py --games 30 --out engine/harness/positions_midgame.txt
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import sigil_engine as se  # noqa: E402


def play(seed, time_ms, plies_wanted):
    b = se.Board(se.Board.legal_draw(seed), 'standard')
    b.setup_initial()
    hist = []
    out = []
    ply = 0
    while ply < 120:
        hist.append(b.key_js)
        if ply in plies_wanted and not b.gameover:
            out.append(b.to_sfn())
        # Shipped config: width_scale default, tfit, adaptive (0.10, 2, 6).
        r = b.play_best(time_ms, 64, 18, 16, None, hist, 'tfit', False,
                        adaptive=(0.10, 2, 6))
        over = r[3]
        ply += 1
        if over:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=30)
    ap.add_argument('--time-ms', type=int, default=150)
    ap.add_argument('--seed0', type=int, default=7000)
    ap.add_argument('--plies', default='8,14,20,26')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    plies = {int(x) for x in a.plies.split(',')}
    sfns = []
    for g in range(a.games):
        sfns += play(a.seed0 + g, a.time_ms, plies)
        print(f'game {g}: {len(sfns)} positions so far', file=sys.stderr)
    with open(a.out, 'w') as fh:
        fh.write('\n'.join(sfns) + '\n')
    print(f'wrote {len(sfns)} positions to {a.out}')


if __name__ == '__main__':
    main()
