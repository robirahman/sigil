"""Aftershock pack tests: scheduled burns, target ranking, enumeration,
hashing, replay, notation, and the horizon-credit eval term.

Run: python -m ai.test_aftershock
"""
import os
import subprocess

from simboard import (SimBoard, Action, CompleteTurn, apply_sim_turn,
                      CORE_SPELLS)
from notation import NODE_ORDER, POSITIONS

AFTERSHOCK_SPELLS = ['Conflagration', 'Carnage', 'Bewitch',
                     'Smolder', 'Fireblast', 'Hail_Storm',
                     'Ember', 'Slash', 'Surge']

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Hash of a fresh setup_initial() board with the AFTERSHOCK_SPELLS set,
# pinned when the Aftershock Zobrist tables landed. The hasher's seeded
# RNG draws tables sequentially, so this value only changes if someone
# reorders or inserts tables BEFORE existing ones — which silently
# invalidates every legacy hash. Append new tables at the end instead.
LEGACY_HASH_LITERAL = 0x8bf89187a1032e79


def _board(spell_names=None):
    b = SimBoard(spell_names or AFTERSHOCK_SPELLS)
    b.setup_initial()
    return b


def _base_burns(turn):
    n = 0
    for a in turn.actions:
        if a.type == 'burn':
            n += 1
        else:
            break
    return n


def test_metadata():
    print("Testing CORE_SPELLS metadata...")
    assert CORE_SPELLS['Ember'] == {'resolve': 'schedule_burns', 'turns': 1,
                                    'static': False, 'ischarm': True}
    assert CORE_SPELLS['Smolder']['turns'] == 2
    assert CORE_SPELLS['Conflagration']['turns'] == 4
    print("  PASS")


def test_cast_semantics():
    print("Testing cast semantics + charm/lock behavior...")
    b = _board()
    b.stones['a7'] = 'red'
    b.update()
    assert 'Ember' in b.charged_spells['red']
    acts = b._cast_spell('Ember', 'red')
    assert b.pending_burns['red'] == [1]
    assert b.lock['red'] is None and b.spell_counter['red'] == 0
    assert any(a.type == 'schedule_burns' and a.turns == 1 for a in acts)

    b2 = _board()
    for n in POSITIONS[1]:
        b2.stones[n] = 'red'
    for n in ('a1', 'b1', 'c1'):
        b2.stones[n] = 'red'
    b2.update()
    b2._cast_spell('Conflagration', 'red')
    assert b2.pending_burns['red'] == [1, 1, 1, 1]
    assert b2.lock['red'] == 'Conflagration' and b2.spell_counter['red'] == 1
    print("  PASS")


def test_additive_stacking():
    print("Testing additive stacking...")
    b = _board()
    b._resolve_spell('Conflagration', 'blue', [])
    assert b.pending_burns['blue'] == [1, 1, 1, 1]
    b._resolve_spell('Ember', 'blue', [])
    assert b.pending_burns['blue'] == [2, 1, 1, 1]
    b._resolve_spell('Smolder', 'blue', [])
    assert b.pending_burns['blue'] == [3, 2, 1, 1]
    print("  PASS")


def test_double_pop_and_forfeit():
    print("Testing advance_turn double pop + implicit forfeit...")
    b = _board()
    b.pending_moves['blue'] = [1]
    b.pending_burns['blue'] = [2, 1]
    b.advance_turn()
    assert b.extra_moves_this_turn == 1 and b.burns_this_turn == 2
    assert b.pending_moves['blue'] == [] and b.pending_burns['blue'] == [1]
    b.advance_turn()
    assert b.burns_this_turn == 0, "unresolved burns forfeit on the next pop"
    b.advance_turn()
    assert b.burns_this_turn == 1 and b.pending_burns['blue'] == []
    print("  PASS")


def test_copy_isolation():
    print("Testing copy() isolation...")
    b = _board()
    b.pending_burns['red'] = [1, 1]
    b.burns_this_turn = 2
    c = b.copy()
    assert c.pending_burns == b.pending_burns and c.burns_this_turn == 2
    c.pending_burns['red'].append(9)
    assert b.pending_burns == {'red': [1, 1], 'blue': []}
    print("  PASS")


def test_burn_targets_and_bulwark():
    print("Testing burn-target ranking + Bulwark is ignored...")
    b = SimBoard(['Conflagration', 'Carnage', 'Bewitch', 'Smolder',
                  'Fireblast', 'Hail_Storm', 'Bulwark', 'Slash', 'Surge'])
    b.setup_initial()
    # Blue's Bulwark-locked spell: blue holds position 2 (b2..b6), locked.
    for n in POSITIONS[2]:
        b.stones[n] = 'blue'
    b.stones['a7'] = 'blue'   # Bulwark charm node (position 7)... belongs
    # to slot 6 -> position 7 = 'a7'; charge Bulwark for blue.
    b.lock['blue'] = 'Carnage'  # lock on position 2's spell name slot 1
    # Red stones adjacent to blue's locked sigil and to a plain blue stone.
    b.stones['b7'] = 'red'    # adjacent to b4 (in locked sigil) and b8
    b.stones['b11'] = 'blue'  # plain blue, adjacent to... b1(empty), b6
    b.stones['a10'] = 'red'   # adjacent to b11
    b.update()
    targets = b._burn_targets('red')
    # b4 (inside a spell position) must rank before b11 (outside).
    assert 'b4' in targets, targets
    assert 'b11' in targets, targets
    assert targets.index('b4') < targets.index('b11'), \
        "spell-position stones rank first"
    # Bulwark check: even when blue's Bulwark protects its locked sigil
    # from hard moves, burns still target it (destruction convention).
    if 'Bulwark' in b.charged_spells['blue'] and b.lock['blue']:
        hard = b._hard_moveable('red')
        assert 'b4' in targets  # burnable regardless of hard-move rules
    print("  PASS")


def test_greedy_enumeration():
    print("Testing greedy burn phase in get_legal_turns...")
    b = _board()
    b.stones['a2'] = 'red'
    b.stones['a3'] = 'blue'
    b.stones['a6'] = 'blue'
    b.stones['b5'] = 'blue'
    b.update()
    b.whose_turn = 'red'

    # burns = 0: no burn actions (regression).
    t0 = list(b.get_legal_turns('red'))
    assert all(_base_burns(t) == 0 for t in t0)

    b.burns_this_turn = 2
    t2 = list(b.get_legal_turns('red'))
    assert all(_base_burns(t) == 2 for t in t2)
    # Greedy burns are identical across variants (single ranked choice).
    first = [a.node for a in t2[0].actions[:2]]
    assert all([a.node for a in t.actions[:2]] == first for t in t2)

    # Fizzle: no adjacent enemy -> zero burn actions despite the counter.
    b5 = _board()
    b5.stones['c9'] = 'blue'
    b5.update()
    b5.whose_turn = 'red'
    b5.burns_this_turn = 3
    assert all(_base_burns(t) == 0 for t in b5.get_legal_turns('red'))

    # Burn-elimination: the only enemy stone is adjacent -> [burn, pass].
    b6 = SimBoard(AFTERSHOCK_SPELLS)
    b6.stones['a1'] = 'red'
    b6.stones['a2'] = 'blue'
    b6.update()
    b6.whose_turn = 'red'
    b6.burns_this_turn = 1
    t6 = list(b6.get_legal_turns('red'))
    assert len(t6) == 1
    assert [a.type for a in t6[0].actions] == ['burn', 'pass']
    print("  PASS")


def test_exhaustive_enumeration_and_caps():
    print("Testing exhaustive burn phase + caps + dedup...")
    from ai.enumerator import (get_legal_turns_exhaustive, DEFAULT_CAPS,
                               BALANCED_CAPS, NARROW_CAPS, OPPONENT_CAPS)
    assert 'burn' in DEFAULT_CAPS
    assert 'burn' in BALANCED_CAPS and 'burn' in NARROW_CAPS \
        and 'burn' in OPPONENT_CAPS

    b = _board()
    b.stones['a2'] = 'red'
    b.stones['a3'] = 'blue'
    b.stones['a6'] = 'blue'
    b.stones['b5'] = 'blue'
    b.update()
    b.whose_turn = 'red'
    b.burns_this_turn = 2
    # Eligible = {a3, a6}; two burns -> exactly one deduped burn set.
    ex = list(get_legal_turns_exhaustive(b, 'red', caps={}))
    sets = {tuple(sorted(a.node for a in t.actions if a.type == 'burn'))
            for t in ex}
    assert sets == {('a3', 'a6')}, sets

    # Three eligible, two burns, cap>=3 -> C(3,2)=3 deduped prefixes.
    # Built WITHOUT setup_initial so no stray adjacency (a1/b1 openers)
    # adds a fourth eligible target.
    b2 = SimBoard(AFTERSHOCK_SPELLS)
    b2.stones['a2'] = 'red'
    b2.stones['c3'] = 'red'
    for n in ('a3', 'a6', 'c4'):
        b2.stones[n] = 'blue'
    b2.update()
    b2.whose_turn = 'red'
    b2.burns_this_turn = 2
    ex2 = list(get_legal_turns_exhaustive(b2, 'red', caps={'burn': 3}))
    sets2 = {tuple(sorted(a.node for a in t.actions if a.type == 'burn'))
             for t in ex2}
    assert len(sets2) == 3, sets2

    # burns = 0 regression: identical to a control run.
    b2.burns_this_turn = 0
    ex0 = list(get_legal_turns_exhaustive(b2, 'red', caps={}))
    assert all(_base_burns(t) == 0 for t in ex0)
    print("  PASS")


def test_spell_overrides_noop():
    print("Testing _spell_overrides no-op for Aftershock spells...")
    from ai.enumerator import _spell_overrides, NARROW_CAPS
    b = _board()
    for name in ('Ember', 'Smolder', 'Conflagration'):
        assert _spell_overrides(b, 'red', name, dict(NARROW_CAPS)) == [{}]
    print("  PASS")


def test_replay_equivalence():
    print("Testing replay equivalence (schedule + burns apply once)...")
    b0 = _board()
    b0.stones['a7'] = 'red'
    b0.update()
    live = b0.copy()
    acts = live._cast_spell('Ember', 'red')
    rep = b0.copy()
    apply_sim_turn(rep, CompleteTurn(acts), 'red')
    assert rep.pending_burns['red'] == [1]
    assert rep.to_sfn() == live.to_sfn()

    # A recorded burn action replays as plain stone removal.
    b1 = _board()
    b1.stones['a2'] = 'red'
    b1.stones['a3'] = 'blue'
    b1.update()
    rep2 = b1.copy()
    apply_sim_turn(rep2, CompleteTurn([Action('burn', node='a3'),
                                       Action('pass')]), 'red')
    assert rep2.stones['a3'] is None
    print("  PASS")


def test_three_ply_decrement():
    print("Testing schedule decrement across _apply_turn plies...")
    from ai.minimax_ai import _apply_turn
    b = _board()
    b.stones['a7'] = 'red'
    b.stones['b2'] = 'blue'
    b.stones['b3'] = 'blue'
    b.update()
    b.whose_turn = 'red'
    cast_turn = None
    for t in b.get_legal_turns('red'):
        if any(a.type == 'cast' and a.spell == 'Ember' for a in t.actions):
            cast_turn = t
            break
    assert cast_turn is not None
    after_red = _apply_turn(b, cast_turn, 'red')
    assert after_red.pending_burns['red'] == [1]
    assert after_red.whose_turn == 'blue' and after_red.burns_this_turn == 0
    blue_turn = next(iter(after_red.get_legal_turns('blue')))
    after_blue = _apply_turn(after_red, blue_turn, 'blue')
    if not after_blue.gameover:
        assert after_blue.whose_turn == 'red'
        assert after_blue.burns_this_turn == 1
        assert after_blue.pending_burns['red'] == []
    print("  PASS")


def test_burns_not_win_material():
    print("Testing burns count toward NOTHING in win checks...")
    # Unlike Providence phantoms, a burn schedule does not defend the ±3
    # lead: red 5 real vs blue 1 real (+1 token) is a red win even if blue
    # has a huge burn schedule.
    b = SimBoard(AFTERSHOCK_SPELLS)
    for n in ('a1', 'a2', 'a3', 'a4', 'a5'):
        b.stones[n] = 'red'
    b.stones['b1'] = 'blue'
    b.pending_burns['blue'] = [3, 3, 3, 3]
    b.update()
    assert b.check_game_over('red') and b.winner == 'red'
    # Elimination via burn: replaying a burn that removes the last enemy
    # stone flags gameover inside update().
    b2 = SimBoard(AFTERSHOCK_SPELLS)
    b2.stones['a1'] = 'red'
    b2.stones['a2'] = 'blue'
    b2.update()
    apply_sim_turn(b2, CompleteTurn([Action('burn', node='a2'),
                                     Action('pass')]), 'red')
    assert b2.gameover and b2.winner == 'red'
    print("  PASS")


def test_hashing_and_repetition_keys():
    print("Testing Zobrist byte-stability (pinned) + sensitivity + |B keys...")
    from ai.minimax_ai import _get_hasher
    h = _get_hasher(AFTERSHOCK_SPELLS)
    fresh = _board()
    h0 = h.hash(fresh, 'red')
    assert h0 == LEGACY_HASH_LITERAL, (
        "hash of a schedule-free board changed (0x%x != 0x%x) — Zobrist "
        "tables were reordered or inserted before existing ones; append "
        "new tables at the END of _PositionHasher.__init__" % (
            h0, LEGACY_HASH_LITERAL))
    b1 = fresh.copy()
    b1.pending_burns['red'] = [1]
    assert h.hash(b1, 'red') != h0
    b2 = fresh.copy()
    b2.pending_burns['red'] = [2]
    assert h.hash(b2, 'red') not in (h0, h.hash(b1, 'red'))
    b3 = fresh.copy()
    b3.burns_this_turn = 1
    assert h.hash(b3, 'red') not in (h0, h.hash(b1, 'red'))

    # Loop keys: canonical pre-shift form; suffix only when non-empty.
    assert '|B' not in _board().looping_snapshot()
    s1 = _board()
    s1.pending_burns['blue'] = [2, 1]
    s1.turn_counter = 1
    s1.whose_turn = 'blue'
    pre = s1.looping_snapshot()
    assert '|B' in pre
    s2 = _board()
    s2.pending_burns['blue'] = [2, 1]
    s2.turn_counter = 0
    s2.whose_turn = 'red'
    s2.advance_turn()   # pops blue's head into the counter
    assert s2.looping_snapshot() == pre
    # |P and |B coexist.
    s3 = _board()
    s3.pending_moves['red'] = [1]
    s3.pending_burns['blue'] = [1]
    key = s3.looping_snapshot()
    assert '|P' in key and '|B' in key
    print("  PASS")


def test_sfn_roundtrip():
    print("Testing SFN ab: token round-trip + coexistence...")
    b = _board()
    s_legacy = b.to_sfn()
    assert ' ab:' not in s_legacy
    b.pending_moves['red'] = [1]
    b.pending_burns['blue'] = [2, 1]
    b.variant = 'competitive'
    b.update()
    s = b.to_sfn()
    assert ' competitive' in s and ' pm:1:-' in s and ' ab:-:2,1' in s, s
    r = SimBoard.from_sfn(s)
    assert r.variant == 'competitive'
    assert r.pending_moves['red'] == [1]
    assert r.pending_burns['blue'] == [2, 1]
    assert r.to_sfn() == s
    print("  PASS")


def test_leaf_credit_reference():
    print("Testing engagement-capped burn credit (Python reference)...")
    # Reference formula mirrored from caveman-ai.js _cavemanBurnCredit.
    def burn_credit(board, side, enemy_of_side):
        scheduled = board.burns_this_turn if board.whose_turn == side else 0
        scheduled += sum(board.pending_burns[side])
        if not scheduled:
            return 0
        engaged = 0
        for n in NODE_ORDER:
            if board.stones[n] != enemy_of_side:
                continue
            if any(board.stones[nb] == side
                   for nb in board._adjacent_nodes(n)):
                engaged += 1
        return min(scheduled, engaged)

    b = _board()
    b.stones['a2'] = 'red'
    b.stones['a3'] = 'blue'
    b.stones['c9'] = 'blue'
    b.update()
    assert burn_credit(b, 'red', 'blue') == 0, "no schedule -> no credit"
    b.pending_burns['red'] = [1, 1, 1, 1]
    assert burn_credit(b, 'red', 'blue') == 1, "capped at engaged count"
    b.stones['a6'] = 'blue'
    b.update()
    assert burn_credit(b, 'red', 'blue') == 2
    # burns_this_turn counts only for the side to move.
    b.pending_burns['red'] = []
    b.burns_this_turn = 2
    b.whose_turn = 'red'
    assert burn_credit(b, 'red', 'blue') == 2
    b.whose_turn = 'blue'
    assert burn_credit(b, 'red', 'blue') == 0
    print("  PASS")


def test_js_parity_smoke():
    print("Testing JS engine parity smoke (incl. depth-2 cast incentive)...")
    engine = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')
    js = []
    for fn in ('constants.js', 'notation.js', 'spells.js', 'moves.js',
               'sim-board.js', 'enumerator.js', 'minimax-ai.js',
               'caveman-ai.js'):
        with open(os.path.join(engine, fn), encoding='utf-8') as f:
            js.append(f.read())
    js.append(r"""
const SP = ['Conflagration','Carnage','Bewitch','Smolder','Fireblast','Hail_Storm','Ember','Slash','Surge'];
// Leaf credit parity with the Python reference: 4 scheduled, 1 engaged.
const b = new SimBoard(SP);
b.stones.a1='red'; b.stones.a2='red'; b.stones.a3='blue'; b.stones.c9='blue'; b.update();
const w = { mana: 0, voidPenalty: 0, mapControl: 0 };
const l0 = _cavemanLeaf(b, 'red', w);
b.pendingBurns.red = [1,1,1,1];
const l1 = _cavemanLeaf(b, 'red', w);
if (Math.abs((l1 - l0) * 39 - 1) > 1e-9) throw new Error('leaf credit: ' + ((l1 - l0) * 39));

// Depth-2 caveman search casts Conflagration in a heavily engaged
// position with full mana (cast: -2 real, +4 engagement-capped credit).
// The engaged blue stones touch red's MANA stones, which survive the
// cast, so the credit stays realizable after the sigil is spent.
const d = new SimBoard(SP);
for (const n of ['a2','a3','a4','a5','a6','a1','b1','c1']) d.stones[n]='red';
for (const n of ['b2','c2','b11','a11']) d.stones[n]='blue';  // adjacent to mana reds
d.stones.c8='blue'; d.stones.c9='blue';  // depth for blue, disengaged
d.update(); d.whoseTurn = 'red';
cavemanSearch(d, 'red', { timeLimit: 15, maxDepth: 2 }).then((res) => {
    const casts = res.turn && res.turn.actions.some(a => a.type === 'cast' && a.spell === 'Conflagration');
    if (!casts) throw new Error('depth-2 search must cast Conflagration, picked: ' + JSON.stringify(res.turn && res.turn.actions.map(a => a.type + ':' + (a.spell || a.node))));
    console.log('JS_OK');
}).catch(e => { console.error(e.message || e); process.exit(1); });
""")
    proc = subprocess.run(['node', '-'], input='\n'.join(js),
                          capture_output=True, text=True, timeout=180)
    if 'JS_OK' not in proc.stdout:
        print(proc.stdout[-2000:])
        print(proc.stderr[-2000:])
        raise AssertionError('JS parity smoke failed')
    print("  PASS")


def main():
    test_metadata()
    test_cast_semantics()
    test_additive_stacking()
    test_double_pop_and_forfeit()
    test_copy_isolation()
    test_burn_targets_and_bulwark()
    test_greedy_enumeration()
    test_exhaustive_enumeration_and_caps()
    test_spell_overrides_noop()
    test_replay_equivalence()
    test_three_ply_decrement()
    test_burns_not_win_material()
    test_hashing_and_repetition_keys()
    test_sfn_roundtrip()
    test_leaf_credit_reference()
    test_js_parity_smoke()
    print("All Aftershock tests passed.")


if __name__ == '__main__':
    main()
