"""Does `tfit_spell*` actually change play through `play_best`?

    smoke_spell_eval.py [positions-file] [depth=4]

The eval knob analogue of smoke_knobbite.py: before an arena spends money on
`tfit_spell` vs `tfit`, show through the binding every arena uses that the preset
reaches the search -- the root score moves, and on some positions the chosen turn
does too. Exits non-zero if a preset is indistinguishable from `tfit`.
"""
import os, sys
import sigil_engine as se

MERGE_OFF = 1 << 62
HERE = os.path.dirname(os.path.abspath(__file__))


def best(sfn, ev, depth):
    b = se.Board.from_sfn(sfn)
    r = b.play_best(0, depth, 20, 16, se.DEFAULT_WIDTH_SCALE, [], ev, False, MERGE_OFF)
    return b.to_sfn(), r[5]


if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', 'harness', 'positions_midgame.txt')
    depth = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    sfns = [l.strip() for l in open(path) if l.strip()]
    ok = True
    for ev in ('tfit_spell', 'tfit_spell2'):
        moved = scored = 0
        for sfn in sfns:
            a, sa = best(sfn, 'tfit', depth)
            c, sc = best(sfn, ev, depth)
            moved += a != c
            scored += sa != sc
        print(f"{ev} vs tfit at depth {depth}: {moved}/{len(sfns)} different turns, "
              f"{scored}/{len(sfns)} different root scores")
        ok &= moved > 0 and scored > 0
    sys.exit(0 if ok else 1)
