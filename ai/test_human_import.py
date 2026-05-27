"""Round-trip tests for the human-game importer's move matching.

The importer reconstructs each human turn from before/after SFN snapshots
by enumerating turns *exhaustively* and replaying each candidate to find
the one that reproduces the recorded after-state. The property under test:
when a turn involves an in-turn choice (which stones to keep when
refilling a spell, where a pushed enemy lands), the matcher recovers the
*exact* variant the human played — it does not collapse to a greedy
default. That is what makes the stored one-hot policy a real move.

Pure-Python except for the importer's feature deps; run:
    python -m ai.test_human_import
"""

from simboard import SimBoard, POSITIONS, NODE_ORDER
from ai.search import _apply_turn
from ai.enumerator import get_legal_turns_exhaustive
from ai.import_human_games import find_matching_turn

_CHAR = {'red': 'r', 'blue': 'b', None: '.'}


def _stones(b):
    return tuple(b.stones[n] for n in NODE_ORDER)


def _simboard_to_sfn(b, next_turn):
    """Serialize a SimBoard to an SFN string carrying exactly the fields
    find_matching_turn reads (stones, locks, springlocks); the rest are
    valid placeholders. Mirrors notation's SFN grammar."""
    stones = ''.join(_CHAR[b.stones[n]] for n in NODE_ORDER)
    spells = ','.join(b.spell_names)
    rlock = b.lock.get('red') or '-'
    block = b.lock.get('blue') or '-'
    rspr = b.springlock.get('red') or '-'
    bspr = b.springlock.get('blue') or '-'
    t = 'r' if next_turn == 'red' else 'b'
    return f"{stones}/{spells} {t} 1 0:0 {rlock}:{block} {rspr}:{bspr} b1"


def _after_board(board, turn, color):
    b = board.copy()
    _apply_turn(b, turn, color)
    b.update()
    return b


def _enemy(color):
    return 'blue' if color == 'red' else 'red'


def _build_keepset_board():
    """A position with a real Fireblast keep-set choice (mirrors
    test_exhaustive_enum.test_keepset_variants_distinct_and_preserved)."""
    spells = ['Flourish', 'Carnage', 'Bewitch', 'Grow', 'Fireblast',
              'Hail_Storm', 'Sprout', 'Slash', 'Surge']
    b = SimBoard(spells); b.setup_initial()
    fb = spells.index('Fireblast'); pos = POSITIONS[fb + 1]
    for n in pos:
        b.stones[n] = 'red'
    b.stones['a1'] = 'red'; b.stones['b1'] = 'red'  # mana = 2
    for nb in b._adjacent_nodes(pos[0]):
        if b.stones[nb] is None:
            b.stones[nb] = 'blue'; break
    for nb in b._adjacent_nodes(pos[2]):
        if b.stones[nb] is None:
            b.stones[nb] = 'blue'; break
    b.update()
    return b


def test_keepset_roundtrip_recovers_exact_variant():
    """Two distinct Fireblast keep-sets reach distinct boards; the matcher
    must map each after-state back to a turn replaying to *that* board."""
    b = _build_keepset_board()
    turns = list(get_legal_turns_exhaustive(b, 'red', exhaustive=True))

    # Collect Fireblast keep-set variants grouped by resulting board.
    variants = []
    for t in turns:
        if any(a.type == 'cast' and a.spell == 'Fireblast'
               and a.overrides and 'kept_nodes' in a.overrides
               for a in t.actions):
            variants.append((t, _stones(_after_board(b, t, 'red'))))

    distinct = {}
    for t, s in variants:
        distinct.setdefault(s, t)
    assert len(distinct) >= 2, \
        f"need >=2 distinct keep-set boards, got {len(distinct)}"

    # Round-trip each distinct variant: build its after-SFN, match it back,
    # and require the matched turn to replay to the SAME board (and NOT the
    # other variant's board).
    boards = list(distinct.keys())
    for target_stones in boards:
        chosen = distinct[target_stones]
        after = _after_board(b, chosen, 'red')
        sfn_after = _simboard_to_sfn(after, _enemy('red'))
        idx, legal = find_matching_turn(b, 'red', sfn_after)
        assert idx is not None, "matcher failed to match a real keep-set turn"
        got_stones = _stones(_after_board(b, legal[idx], 'red'))
        assert got_stones == target_stones, \
            "matcher recovered the wrong keep-set variant"
    print(f"  keep-set round-trip: {len(boards)} distinct variants each "
          f"recovered to the correct board")


def test_push_destination_roundtrip_recovers_exact_variant():
    """When a turn pushes an enemy stone with multiple legal destinations,
    the matcher recovers the exact destination the human chose."""
    import random
    random.seed(7)
    found = 0
    for g in range(40):
        from ai.selfplay import random_core_spells
        b = SimBoard(random_core_spells()); b.setup_initial()
        t = 0
        while not b.gameover and t < 30 and found < 3:
            t += 1
            b.turn_counter = t
            color = 'red' if t % 2 == 1 else 'blue'
            b.whose_turn = color
            turns = list(get_legal_turns_exhaustive(b, color, exhaustive=True))
            # Group push-bearing turns by resulting board.
            push_boards = {}
            for tn in turns:
                if any(a.pushed_to for a in tn.actions
                       if getattr(a, 'pushed_to', None)):
                    push_boards.setdefault(_stones(_after_board(b, tn, color)), tn)
            if len(push_boards) >= 2:
                for target_stones, chosen in list(push_boards.items())[:2]:
                    after = _after_board(b, chosen, color)
                    sfn_after = _simboard_to_sfn(after, _enemy(color))
                    idx, legal = find_matching_turn(b, color, sfn_after)
                    assert idx is not None, "matcher failed on a push turn"
                    got = _stones(_after_board(b, legal[idx], color))
                    assert got == target_stones, \
                        "matcher recovered the wrong push destination"
                found += 1
            # advance with a random legal move
            greedy = list(b.get_legal_turns(color))
            if not greedy:
                break
            nb = b.copy(); _apply_turn(nb, random.choice(greedy), color)
            nb.update(); nb.check_game_over(color)
            if not nb.gameover:
                nb.advance_turn()
            b = nb
        if found >= 3:
            break
    assert found >= 1, "no multi-destination push found to round-trip"
    print(f"  push round-trip: recovered exact destination in {found} position(s)")


def test_unmatched_returns_none():
    """An after-state no legal turn can produce yields no match (the
    importer discards rather than fabricating a policy target)."""
    b = _build_keepset_board()
    # An impossible after-state: clear the whole board.
    empty = b.copy()
    for n in NODE_ORDER:
        empty.stones[n] = None
    sfn_after = _simboard_to_sfn(empty, 'blue')
    idx, legal = find_matching_turn(b, 'red', sfn_after)
    assert idx is None, "matcher should not match an unreachable after-state"
    print("  unmatched after-state correctly returns None")


if __name__ == '__main__':
    test_keepset_roundtrip_recovers_exact_variant()
    test_push_destination_roundtrip_recovers_exact_variant()
    test_unmatched_returns_none()
    print("All human-import round-trip tests passed.")
