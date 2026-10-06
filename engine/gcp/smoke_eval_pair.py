"""Does an eval preset actually change play through `play_best`?

    smoke_eval_pair.py <arm>:<base> [positions-file] [depth=4]

`smoke_spell_eval.py` generalised to any pair (Step 5 uses nnue_spell:tfit_spell):
before an arena spends money, show through the binding every arena uses that the
preset reaches the search -- the root score moves, and on some positions the chosen
turn does too. Exits non-zero if the arm is indistinguishable from the base.
"""
import os
import sys
import sigil_engine as se

MERGE_OFF = 1 << 62
HERE = os.path.dirname(os.path.abspath(__file__))


def best(sfn, ev, depth):
    b = se.Board.from_sfn(sfn)
    r = b.play_best(0, depth, 20, 16, se.DEFAULT_WIDTH_SCALE, [], ev, False, MERGE_OFF)
    return b.to_sfn(), r[5]


if __name__ == '__main__':
    arm, base = sys.argv[1].split(':')
    path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '..', 'harness', 'positions_midgame.txt')
    depth = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    sfns = [l.strip() for l in open(path) if l.strip()]
    moved = scored = 0
    for sfn in sfns:
        a, sa = best(sfn, base, depth)
        c, sc = best(sfn, arm, depth)
        moved += a != c
        scored += sa != sc
    print(f"{arm} vs {base} at depth {depth}: {moved}/{len(sfns)} different turns, "
          f"{scored}/{len(sfns)} different root scores")
    sys.exit(0 if moved > 0 and scored > 0 else 1)
