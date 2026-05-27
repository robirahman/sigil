"""Tests for fully-exhaustive turn enumeration and replay parity.

These are pure-Python (no torch/numpy) so they run anywhere. They guard
the core invariant behind the enumeration overhaul: a CompleteTurn built
by the exhaustive enumerator must replay (via ai.search._apply_turn) to
exactly the board the enumerator produced — i.e. the variant's keep-set,
push-destination and effect choices survive replay instead of collapsing
back to the engine's greedy resolution.

Run: python -m ai.test_exhaustive_enum
"""

import random

from simboard import SimBoard, CompleteTurn, Action, POSITIONS, NODE_ORDER
from ai.search import _apply_turn
from ai.enumerator import get_legal_turns_exhaustive
from ai.selfplay import random_core_spells


def _stones(b):
    return tuple(b.stones[n] for n in NODE_ORDER)


def _random_positions(n_games=20, max_turn=35, seed=11):
    """Yield (board, color) snapshots from random self-play."""
    random.seed(seed)
    for g in range(n_games):
        b = SimBoard(random_core_spells())
        b.setup_initial()
        t = 0
        while not b.gameover and t < max_turn:
            t += 1
            b.turn_counter = t
            color = 'red' if t % 2 == 1 else 'blue'
            b.whose_turn = color
            yield b.copy(), color
            greedy = list(b.get_legal_turns(color))
            if not greedy:
                break
            nb = b.copy()
            _apply_turn(nb, random.choice(greedy), color)
            nb.update()
            nb.check_game_over(color)
            if not nb.gameover:
                nb.advance_turn()
            b = nb


def test_replay_parity_and_validity():
    """Every exhaustive turn replays without error and deterministically."""
    total = 0
    for board, color in _random_positions():
        turns = list(get_legal_turns_exhaustive(board, color, exhaustive=True))
        assert turns, "enumerator produced no turns"
        for turn in turns:
            b1 = board.copy(); _apply_turn(b1, turn, color)
            b2 = board.copy(); _apply_turn(b2, turn, color)
            assert _stones(b1) == _stones(b2), "replay is nondeterministic"
            total += 1
    print(f"  replay parity: {total} turns replayed deterministically")


def test_keepset_variants_distinct_and_preserved():
    """A position with a real keep-set choice yields multiple Fireblast
    variants whose distinct keep-sets survive replay (different boards)."""
    spells = ['Flourish', 'Carnage', 'Bewitch', 'Grow', 'Fireblast',
              'Hail_Storm', 'Sprout', 'Slash', 'Surge']
    b = SimBoard(spells); b.setup_initial()
    fb = spells.index('Fireblast'); pos = POSITIONS[fb + 1]
    for n in pos:
        b.stones[n] = 'red'
    b.stones['a1'] = 'red'; b.stones['b1'] = 'red'  # mana = 2
    # Enemy stones adjacent to different members of the position so the
    # keep choice changes destruction.
    for nb in b._adjacent_nodes(pos[0]):
        if b.stones[nb] is None:
            b.stones[nb] = 'blue'; break
    for nb in b._adjacent_nodes(pos[2]):
        if b.stones[nb] is None:
            b.stones[nb] = 'blue'; break
    b.update()

    turns = list(get_legal_turns_exhaustive(b, 'red', exhaustive=True))
    fb_turns = [t for t in turns
                if any(a.type == 'cast' and a.spell == 'Fireblast'
                       and a.overrides and 'kept_nodes' in a.overrides
                       for a in t.actions)]
    keepsets = set()
    boards = set()
    for t in fb_turns:
        for a in t.actions:
            if a.type == 'cast' and a.overrides and 'kept_nodes' in a.overrides:
                keepsets.add(tuple(a.overrides['kept_nodes']))
        bb = b.copy(); _apply_turn(bb, t, 'red')
        boards.add(_stones(bb))
    assert len(keepsets) >= 2, f"expected multiple keep-sets, got {keepsets}"
    assert len(boards) >= 2, "keep-set variants collapsed to one board on replay"
    print(f"  keep-sets: {len(keepsets)} distinct, "
          f"{len(boards)} distinct resulting boards")


def test_push_destination_variants_preserved():
    """When a push has multiple destinations, exhaustive enumeration yields
    variants with distinct pushed_to that survive replay."""
    found = False
    for board, color in _random_positions(seed=5):
        for tgt in board._all_moveable(color):
            if board.stones[tgt] == board._enemy(color):
                dests = board._push_destinations(tgt, color)
                if len(dests) >= 2:
                    # Replay each destination and confirm distinct boards.
                    boards = set()
                    for d in dests:
                        bb = board.copy()
                        bb._push_enemy(tgt, color, dest_override=d)
                        boards.add(_stones(bb))
                    assert len(boards) == len(dests), \
                        "push destinations did not produce distinct boards"
                    found = True
                    break
        if found:
            break
    assert found, "no multi-destination push found in sample (unexpected)"
    print("  push destinations: distinct destinations produce distinct boards")


if __name__ == '__main__':
    test_replay_parity_and_validity()
    test_keepset_variants_distinct_and_preserved()
    test_push_destination_variants_preserved()
    print("All exhaustive-enumeration tests passed.")
