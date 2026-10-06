"""Binding checks for the Step 3 data pipeline (run: python test_selfplay_v2.py).

* `root_scores_and_play(play=False)` is deterministic and leaves the board alone;
* each candidate's parts equal `prior_dataset`'s row at its `urank`, and its
  packed actions equal that row's packed turn (the round trip the trainer uses);
* the chosen turn is a candidate whose score is the root score;
* a chunk written by `selfplay_v2.Chunk` reads back through `load_v2`.
"""
import os, sys, tempfile
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import numpy as np
import sigil_engine as se
import selfplay_v2 as v2


def positions():
    for seed in (5, 29, 101):
        b = se.Board(se.Board.legal_draw(seed), 'standard'); b.setup_initial()
        for _ in range(9):
            b.root_scores_and_play(2, 'tfit', False, 600, [], True)
            if b.gameover:
                break
        if not b.gameover:
            yield b.to_sfn()


def main():
    n = 0
    for sfn in positions():
        b = se.Board.from_sfn(sfn)
        r1 = b.root_scores_and_play(3, 'tfit', False, 600, [b.key_js], False)
        assert b.to_sfn() == sfn, "play=False must not move"
        r2 = se.Board.from_sfn(sfn).root_scores_and_play(3, 'tfit', False, 600, [b.key_js], False)
        assert r1 == r2, "not deterministic"
        _sfn, score, _n, _d, chosen, cands, nu, _tr = r1
        _x, _sp, rows, _stubs, _ranks, packed, _t = b.prior_dataset(600)
        assert nu == len(rows)
        assert any(c[0] == chosen and c[2] == score for c in cands), "chosen turn not recorded"
        for pk, parts, _v, bound, _cn, ur in cands:
            assert bound in (0, 1, 2)
            if ur >= 0:
                assert list(rows[ur]) == list(parts), "parts differ from prior_dataset"
                assert list(packed[ur]) == list(pk), "packed turn differs from prior_dataset"
        x = b.explore_unemitted(3, 6, 7, 20000, 5000, 'tfit', [b.key_js])
        assert x == b.explore_unemitted(3, 6, 7, 20000, 5000, 'tfit', [b.key_js]), "explore not deterministic"
        stream = {tuple(p) for p in packed}
        for pk, _parts, _v, _cn, cl in x[0]:
            assert tuple(pk) not in stream and cl in (0, 1, 2)
        n += 1
    assert n >= 2
    # chunk round trip
    ch = v2.Chunk()
    b = se.Board(se.Board.legal_draw(5), 'standard'); b.setup_initial()
    v2.play_game(5, 2, __import__('random').Random(1), 0.5, 4, 0.1, (b, [], 0, 0), ch)
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, 'v2_0_0000.npz')
        ch.write(p, {'t': 1})
        P, C, M = v2.load_v2([p, p])
        k = len(ch)
        assert len(P['sfn']) == 2 * k and P['cand_off'][k] == len(ch.cand['score'])
        assert (P['cand_off'][1:] - P['cand_off'][:-1] == P['n_cand'][:-1]).all()
        assert set(np.unique(P['y'])) <= {0, 1, 255}
    print(f"OK: {n} positions checked")


if __name__ == '__main__':
    main()
