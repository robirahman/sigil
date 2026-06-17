import sys
from simboard import SimBoard, Action
from notation import NODE_ORDER, ADJACENCY, POSITIONS

def test_fissure():
    print("Testing Fissure...")
    # Fissure: Ritual. Destroy all enemy stones on that node and all adjacent nodes.
    spell_names = ['Fissure'] + ['Grow'] * 8
    board = SimBoard(spell_names)
    
    # Place Red stones to cast
    for n in POSITIONS[1]:
        board.stones[n] = 'red'
    
    # Place Blue stones
    board.stones['a1'] = 'blue'
    board.stones['a11'] = 'blue'
    board.stones['c10'] = 'blue' # c10 is neighbor of a11
    
    # Now Red casts Fissure targeting 'a11'.
    board.whose_turn = 'red'
    board.update()
    assert 'Fissure' in board.charged_spells['red']
    
    # Resolve spell
    actions = board._resolve_spell('Fissure', 'red', POSITIONS[1], target_overrides={'fissure_target': 'a11'})
    
    # Assertions
    assert board.stones['a11'] is None, "Target node enemy stone should be destroyed"
    assert board.stones['a1'] is None, "Adjacent node 'a1' enemy stone should be destroyed"
    assert board.stones['c10'] is None, "Adjacent node 'c10' enemy stone should be destroyed"
    assert board.stones['a6'] == 'red', "Caster stone on 'a6' should NOT be destroyed"
    print("Fissure test passed!")

def test_rock_slide():
    print("Testing Rock Slide...")
    spell_names = ['Flourish', 'Rock_Slide'] + ['Grow'] * 7
    board = SimBoard(spell_names)
    
    # Red caster has stones on 'a2' and 'a6'
    board.stones['a2'] = 'red'
    board.stones['a6'] = 'red'  # Caster stone, should NOT be pushed.
    
    # Place Blue stones (adjacent to red caster on a2)
    board.stones['a1'] = 'blue'
    board.stones['a3'] = 'blue'
    
    overrides = {
        'rock_slide_pushes': [
            {'from': 'a1', 'to': 'a11'},
            {'from': 'a3', 'to': 'a2'},
            {'from': 'a11', 'to': 'c10'},
            {'from': 'a2', 'to': 'a1'},
        ]
    }
    
    board.whose_turn = 'red'
    board._resolve_spell('Rock_Slide', 'red', POSITIONS[4], target_overrides=overrides)
    
    # Assertions
    assert board.stones['a1'] == 'blue', "a2 should be pushed to a1"
    assert board.stones['c10'] == 'blue', "a11 should be pushed to c10"
    assert board.stones['a6'] == 'red', "a6 should NOT be pushed (caster stone)"
    assert board.stones['a3'] is None
    assert board.stones['a2'] is None
    print("Rock Slide test passed!")

def test_bulwark():
    print("Testing Bulwark...")
    spell_names = ['Flourish', 'Grow', 'Bulwark'] + ['Slash'] * 6
    board = SimBoard(spell_names)
    
    # Red has Bulwark charged
    board.charged_spells['red'] = ['Bulwark']
    board.lock['red'] = 'Bulwark'
    
    # Place Red stones in Bulwark spell nodes
    board.stones['c2'] = 'red'
    board.stones['c3'] = 'red'
    
    # Place Blue stone adjacent to c2
    board.stones['c1'] = 'blue'
    
    hard_targets = board._hard_moveable('blue')
    all_targets = board._all_moveable('blue')
    blink_targets = board._blinkable('blue')
    
    assert 'c2' not in hard_targets, "c2 should be immune to enemy hard moves"
    assert 'c2' not in all_targets, "c2 should be immune to enemy moves"
    assert 'c2' not in blink_targets, "c2 should not be blinkable by enemy"
    
    board.stones['c11'] = 'red'
    hard_targets_2 = board._hard_moveable('blue')
    assert 'c11' in hard_targets_2, "c11 (non-locked) should be targetable by enemy hard moves"
    print("Bulwark test passed!")

def main():
    try:
        test_fissure()
        test_rock_slide()
        test_bulwark()
        print("All tectonic tests passed successfully!")
        sys.exit(0)
    except AssertionError as e:
        print(f"Test assertion failed: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"Test encountered unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()
