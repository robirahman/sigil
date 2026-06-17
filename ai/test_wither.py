import sys
from simboard import SimBoard, Action
from notation import NODE_ORDER, ADJACENCY, POSITIONS

def test_wither_double_decay():
    print("Testing Wither double-decay...")
    # Initialize board with Wither spell
    spell_names = ['Wither'] + ['Grow'] * 8
    board = SimBoard(spell_names)
    
        # Place Red stones to cast (not strictly necessary but kept for consistency)
    for n in POSITIONS[1]:
        board.stones[n] = 'red'
        
    # Clear all nodes to None first
    for n in NODE_ORDER:
        board.stones[n] = None
            
    board.stones['a2'] = 'blue'
    board.stones['a3'] = 'blue'
    board.stones['a4'] = 'blue'
    board.stones['a6'] = 'blue'
    board.stones['a7'] = 'blue'
    board.stones['a8'] = 'blue'
    board.stones['b12'] = 'blue'
    
    board.stones['b1'] = 'red'
    
    # a1, a11, a13, a5, a12, c7 are empty by default because we set them to None.
    # Let's double check their neighbors' initial states.
    # a6 neighbors: a2 (blue), a5 (None), a11 (None) -> 2 empties -> Should decay in Step 1.
    # a2 neighbors: a1 (None), a3 (blue), a6 (blue) -> 1 empty -> Should NOT decay in Step 1.
    # a3 neighbors: a2 (blue), a4 (blue), a13 (None) -> 1 empty -> Should NOT decay in Step 1.
    # a4 neighbors: a3 (blue), a5 (None), a7 (blue) -> 1 empty -> Should NOT decay in Step 1.
    
    # Cast Wither
    board.whose_turn = 'red'

    actions = board._resolve_spell('Wither', 'red', POSITIONS[1])
    
    # Verify actions
    assert len(actions) == 2, f"Should have 2 decay actions, got {len(actions)}"
    assert actions[0].type == 'decay'
    assert 'a6' in actions[0].destroyed, "a6 should be destroyed in first decay"
    assert 'a2' not in actions[0].destroyed, "a2 should NOT be destroyed in first decay"
    
    assert actions[1].type == 'decay'
    assert 'a2' in actions[1].destroyed, "a2 should be destroyed in second decay"
    assert 'a3' not in actions[1].destroyed, "a3 should NOT be destroyed in second decay"
    
    # Verify final board state
    assert board.stones['a6'] is None, "a6 should be empty"
    assert board.stones['a2'] is None, "a2 should be empty"
    assert board.stones['a3'] == 'blue', "a3 should still be occupied"
    assert board.stones['a4'] == 'blue', "a4 should still be occupied"
    
    print("Wither test passed!")

def main():
    try:
        test_wither_double_decay()
        sys.exit(0)
    except AssertionError as e:
        print(f"Test assertion failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    except Exception as e:
        print(f"Test encountered unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()
