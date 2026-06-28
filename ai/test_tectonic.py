import sys
from simboard import SimBoard, Action, DESTROYED
from notation import NODE_ORDER, ADJACENCY, POSITIONS

def test_fissure():
    print("Testing Fissure...")
    # Fissure (new mechanic): the TARGET node is permanently destroyed (a
    # wall), regardless of occupant; ADJACENT enemy stones are destroyed.
    spell_names = ['Fissure'] + ['Grow'] * 8
    board = SimBoard(spell_names)

    # Place Red stones to cast
    for n in POSITIONS[1]:
        board.stones[n] = 'red'

    # Place Blue stones
    board.stones['a1'] = 'blue'
    board.stones['a11'] = 'blue'
    board.stones['c10'] = 'blue'  # c10 is neighbor of a11

    # Now Red casts Fissure targeting 'a11'.
    board.whose_turn = 'red'
    board.update()
    assert 'Fissure' in board.charged_spells['red']

    # Resolve spell
    board._resolve_spell('Fissure', 'red', POSITIONS[1], target_overrides={'fissure_target': 'a11'})

    # Assertions
    assert board.stones['a11'] == DESTROYED, "Target node should become a permanent wall"
    assert board.stones['a1'] is None, "Adjacent node 'a1' enemy stone should be destroyed (normal empty)"
    assert board.stones['c10'] is None, "Adjacent node 'c10' enemy stone should be destroyed (normal empty)"
    assert board.stones['a6'] == 'red', "Caster stone on 'a6' should NOT be destroyed"
    print("Fissure test passed!")

def test_fissure_target_regardless_of_occupant():
    print("Testing Fissure destroys target regardless of occupant...")
    board = SimBoard(['Fissure'] + ['Grow'] * 8)
    board.stones['b5'] = 'red'   # caster's OWN stone on the target
    board.update()
    red_before = board.totalstones['red']
    board._resolve_spell('Fissure', 'red', POSITIONS[1], target_overrides={'fissure_target': 'b5'})
    assert board.stones['b5'] == DESTROYED, "Own-occupied target must still become a wall"
    assert board.totalstones['red'] == red_before - 1, "Destroying our own stone is a real cost"

    # Empty target also becomes a wall.
    board2 = SimBoard(['Fissure'] + ['Grow'] * 8)
    board2.update()
    board2._resolve_spell('Fissure', 'red', POSITIONS[1], target_overrides={'fissure_target': 'c5'})
    assert board2.stones['c5'] == DESTROYED, "Empty target must still become a wall"
    print("Fissure occupant test passed!")

def test_wall_blocks_movement():
    print("Testing destroyed nodes block movement...")
    board = SimBoard(['Fissure'] + ['Grow'] * 8)
    board.stones = {n: None for n in NODE_ORDER}
    board.stones['a2'] = 'blue'   # blue stone adjacent to a3
    board.stones['a3'] = DESTROYED
    board.update()
    assert 'a3' not in board._soft_moveable('blue'), "wall not soft-moveable"
    assert 'a3' not in board._all_moveable('blue'), "wall not all-moveable"
    assert 'a3' not in board._blinkable('blue'), "wall not blinkable"
    print("Wall movement-block test passed!")

def test_wall_blocks_push_and_crush():
    print("Testing destroyed nodes block push/retreat...")
    board = SimBoard(['Fissure'] + ['Grow'] * 8)
    board.stones = {n: None for n in NODE_ORDER}
    # a2 (blue) hemmed in by a red attacker on a1 and walls on its other
    # neighbours -> no escape route -> crushable.
    board.stones['a1'] = 'red'
    board.stones['a2'] = 'blue'
    for nb in ADJACENCY['a2']:
        if nb != 'a1':
            board.stones[nb] = DESTROYED
    board.update()
    assert board.escape_distance('a2', 'blue', max_dist=39) >= 39, "wall must not be an escape cell"
    assert board.is_crushable('a2', 'red'), "stone walled in with attacker neighbour is crushable"
    print("Wall push-block test passed!")

def test_wall_disables_spell():
    print("Testing destroyed node disables overlapping spell...")
    # Carnage occupies position 2 (b2..b6).
    board = SimBoard(['Fissure', 'Carnage'] + ['Grow'] * 7)
    for n in POSITIONS[2]:
        board.stones[n] = 'blue'
    board.update()
    assert 'Carnage' in board.charged_spells['blue'], "Carnage should charge before the wall"
    board.stones['b5'] = DESTROYED
    board.update()
    assert 'Carnage' not in board.charged_spells['blue'], "spell with a wall node can never charge"
    print("Wall spell-disable test passed!")

def test_wall_sfn_roundtrip():
    print("Testing SFN round-trips destroyed nodes...")
    board = SimBoard(['Fissure'] + ['Grow'] * 8)
    board.stones['b5'] = 'blue'
    board.update()
    board._resolve_spell('Fissure', 'red', POSITIONS[1], target_overrides={'fissure_target': 'b5'})
    board.update()
    sfn = board.to_sfn()
    assert 'x' in sfn.split('/')[0], "SFN stone field should encode the wall as 'x'"
    restored = SimBoard.from_sfn(sfn)
    assert restored.stones['b5'] == DESTROYED, "wall must survive an SFN round-trip"
    print("Wall SFN round-trip test passed!")

def test_fissure_enumeration():
    print("Testing Fissure target enumeration for minimax...")
    from ai.enumerator import _spell_overrides, NARROW_CAPS
    board = SimBoard(['Fissure'] + ['Grow'] * 8)
    board.stones = {n: None for n in NODE_ORDER}
    board.stones['a3'] = 'red'
    for n in ['b2', 'b3', 'b4']:
        board.stones[n] = 'blue'  # cluster for red to blast
    board.update()
    overrides = _spell_overrides(board, 'red', 'Fissure', NARROW_CAPS)
    assert {} in overrides, "greedy default must be kept"
    targets = [o['fissure_target'] for o in overrides if 'fissure_target' in o]
    assert targets, "enumerator must propose Fissure targets"
    assert 'b3' in targets, "high-value cluster centre should be among the proposed targets"
    print("Fissure enumeration test passed!")

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
        test_fissure_target_regardless_of_occupant()
        test_wall_blocks_movement()
        test_wall_blocks_push_and_crush()
        test_wall_disables_spell()
        test_wall_sfn_roundtrip()
        test_fissure_enumeration()
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
