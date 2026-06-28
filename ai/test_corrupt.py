import sys
from simboard import SimBoard
from notation import NODE_ORDER, ADJACENCY, POSITIONS


def _fresh_board():
    board = SimBoard(['Corrupt'] + ['Grow'] * 8)
    for n in NODE_ORDER:
        board.stones[n] = None
    board.whose_turn = 'red'
    return board


def test_corrupt_converts_up_to_three_no_chaining():
    print("Testing Corrupt: up-to-3 conversion, no chaining, sacrifice...")
    board = _fresh_board()

    # Two non-adjacent red anchors with four distinct blue neighbours, so the
    # caster touches 4 eligible enemy stones but may only convert 3.
    # Anchors: a1, a3. Eligible blues: a2, a4, a11, a13.
    # Chain stone: a5 (touches a4 but NOT any red) — must stay blue.
    # Far stone:   a8 (touches no red) — must stay blue.
    red_anchors = ['a1', 'a3']
    eligible = ['a2', 'a4', 'a11', 'a13']
    chain = 'a5'
    far = 'a8'

    for n in red_anchors:
        board.stones[n] = 'red'
    for n in eligible + [chain, far]:
        board.stones[n] = 'blue'

    # Sanity: chain stone touches an eligible blue but no red; far touches neither.
    assert 'a4' in ADJACENCY[chain] and not any(board.stones[nb] == 'red' for nb in ADJACENCY[chain])
    assert not any(board.stones[nb] == 'red' for nb in ADJACENCY[far])

    # Greedy converts the first 3 eligible by NODE_ORDER.
    expected_converted = [n for n in NODE_ORDER if n in eligible][:3]
    leftover_eligible = [n for n in eligible if n not in expected_converted]
    assert len(expected_converted) == 3 and len(leftover_eligible) == 1

    actions = board._resolve_spell('Corrupt', 'red', POSITIONS[1])

    corrupt_actions = [a for a in actions if a.type == 'corrupt']
    sac_actions = [a for a in actions if a.type == 'sacrifice']
    assert len(corrupt_actions) == 1, "exactly one corrupt action expected"
    assert set(corrupt_actions[0].converted) == set(expected_converted), \
        f"converted {corrupt_actions[0].converted}, expected {expected_converted}"
    assert len(sac_actions) == 1, "Corrupt must sacrifice exactly one stone"

    # Cap of 3: the 4th eligible enemy stone is untouched and still blue.
    assert board.stones[leftover_eligible[0]] == 'blue', "only 3 of 4 eligible may convert"
    # No chaining: a5 (adjacent only to a freshly-converted stone) stays blue.
    assert board.stones[chain] == 'blue', "no chaining: chain stone must stay blue"
    # Out of range: a8 (touching no red) stays blue.
    assert board.stones[far] == 'blue', "non-touching enemy stone must stay blue"
    # The converted stones became red (none of them was the sacrificed one here,
    # but at minimum the conversion happened before the sacrifice).
    converted_now_red = [n for n in expected_converted if board.stones[n] == 'red']
    sacrificed = sac_actions[0].node
    assert sacrificed not in converted_now_red or board.stones[sacrificed] is None
    print("  PASS")


def test_corrupt_sacrifice_skipped_when_enemy_wiped():
    print("Testing Corrupt: no sacrifice if the enemy's last stones are converted...")
    board = _fresh_board()
    # One red touching up to 3 blues that are the enemy's ONLY stones. Converting
    # them leaves the enemy with zero stones -> game over, so no sacrifice fires.
    board.stones['a1'] = 'red'
    targets = [nb for nb in ADJACENCY['a1']][:3]
    for n in targets:
        board.stones[n] = 'blue'

    actions = board._resolve_spell('Corrupt', 'red', POSITIONS[1])
    assert board.gameover, "converting the enemy's last stones should end the game"
    assert not any(a.type == 'sacrifice' for a in actions), \
        "no sacrifice should be paid once the game is already over"
    print("  PASS")


def test_corrupt_override_targets_and_sacrifice():
    print("Testing Corrupt: target/sacrifice overrides...")
    board = _fresh_board()
    board.stones['a1'] = 'red'
    board.stones['a3'] = 'red'
    board.stones['b1'] = 'red'  # spare so a sacrifice never ends the game
    eligible = ['a2', 'a4', 'a11', 'a13']
    for n in eligible:
        board.stones[n] = 'blue'
    # also keep an extra enemy stone alive so converting doesn't end the game
    board.stones['c1'] = 'blue'

    overrides = {'corrupt_targets': ['a13', 'a11'], 'corrupt_sacrifice': 'b1'}
    actions = board._resolve_spell('Corrupt', 'red', POSITIONS[1], overrides)
    corrupt_actions = [a for a in actions if a.type == 'corrupt']
    sac_actions = [a for a in actions if a.type == 'sacrifice']
    assert corrupt_actions, "expected a corrupt action"
    conv = corrupt_actions[0].converted
    # The two override targets come first; the cap fills the rest greedily.
    assert conv[0] == 'a13' and conv[1] == 'a11', f"override order not respected: {conv}"
    assert sac_actions and sac_actions[0].node == 'b1', "sacrifice override not respected"
    assert board.stones['b1'] is None
    print("  PASS")


if __name__ == '__main__':
    test_corrupt_converts_up_to_three_no_chaining()
    test_corrupt_sacrifice_skipped_when_enemy_wiped()
    test_corrupt_override_targets_and_sacrifice()
    print("All Corrupt tests passed.")
