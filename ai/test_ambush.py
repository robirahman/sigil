"""Ambush pack tests: snare placement, persistence rules, defensive
counting, Fissure interaction, enumeration, hashing, replay, notation.

Run: python -m ai.test_ambush
"""
import os
import subprocess

from simboard import (SimBoard, Action, CompleteTurn, apply_sim_turn,
                      CORE_SPELLS, DESTROYED)
from notation import NODE_ORDER, POSITIONS

AMBUSH_SPELLS = ['Minefield', 'Carnage', 'Bewitch',
                 'Deadfall', 'Fireblast', 'Hail_Storm',
                 'Tripwire', 'Slash', 'Surge']
FISSURE_SPELLS = ['Fissure', 'Carnage', 'Bewitch',
                  'Deadfall', 'Fireblast', 'Hail_Storm',
                  'Tripwire', 'Slash', 'Surge']

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Pinned in ai/test_aftershock.py; re-asserted here because the Ambush
# snare table is appended AFTER the Aftershock tables — if this fails,
# table order was disturbed.
LEGACY_HASH_LITERAL = 0x8bf89187a1032e79


def _board(spell_names=None):
    b = SimBoard(spell_names or AMBUSH_SPELLS)
    b.setup_initial()
    return b


def test_metadata():
    print("Testing CORE_SPELLS metadata (counts 1/2/4)...")
    assert CORE_SPELLS['Tripwire'] == {'resolve': 'place_snares', 'count': 1,
                                       'static': False, 'ischarm': True}
    assert CORE_SPELLS['Deadfall']['count'] == 2
    assert CORE_SPELLS['Minefield']['count'] == 4
    print("  PASS")


def test_cast_and_placement_legality():
    print("Testing cast semantics + placement legality...")
    b = _board()
    b.stones['a7'] = 'red'
    b.update()
    acts = b._cast_spell('Tripwire', 'red')
    assert len(b.snares) == 1 and set(b.snares.values()) == {'red'}
    assert b.lock['red'] is None and b.spell_counter['red'] == 0
    pa = [a for a in acts if a.type == 'place_snares'][0]
    assert len(pa.nodes) == 1

    # Overrides skip illegal targets (occupied / walled / already snared).
    b2 = _board()
    b2.stones['c5'] = DESTROYED
    b2.snares['c4'] = 'blue'
    b2.update()
    b2._resolve_spell('Deadfall', 'red', [], target_overrides={
        'snare_targets': ['a1', 'c5', 'c4', 'c9']})  # a1 occupied (red)
    assert 'a1' not in {n for n, o in b2.snares.items() if o == 'red'}
    assert 'c5' not in b2.snares
    assert b2.snares['c4'] == 'blue', "cannot overwrite an existing snare"

    # Greedy stops at zero-score candidates ("up to N"). Mana occupied and
    # a single isolated enemy: only its two empty neighbors score > 0.
    b3 = SimBoard(AMBUSH_SPELLS)
    for n in ('a1', 'b1', 'c1'):
        b3.stones[n] = 'red'
    b3.stones['c13'] = 'blue'
    b3.update()
    b3._resolve_spell('Minefield', 'red', [])
    placed = sorted(n for n, o in b3.snares.items() if o == 'red')
    assert placed == ['c3', 'c9'], \
        "greedy must stop before wasting snares in dead space: %r" % placed
    print("  PASS")


def test_persistence_rules():
    print("Testing persistence: enemy-entry-only consumption...")
    b = _board()
    b.snares['a5'] = 'red'
    # Owner's stone coexists on top.
    b.stones['a5'] = 'red'
    b.update()
    assert b.snares.get('a5') == 'red' and b.stones['a5'] == 'red'
    # Survives the stone above being removed (sacrifice/destruction).
    b.stones['a5'] = None
    b.update()
    assert b.snares.get('a5') == 'red'
    # Enemy entry: stone destroyed, snare consumed.
    b.stones['a5'] = 'blue'
    b.update()
    assert b.stones['a5'] is None and 'a5' not in b.snares
    # Wall over a snare: coexists, inert.
    b2 = _board()
    b2.snares['c5'] = 'red'
    b2.stones['c5'] = DESTROYED
    b2.update()
    assert b2.snares.get('c5') == 'red'
    print("  PASS")


def test_push_scenarios():
    print("Testing push interactions (incl. Robi's displacement scenario)...")
    # Push an enemy stone onto YOUR snare: free kill.
    b = SimBoard(AMBUSH_SPELLS)
    b.stones['a1'] = 'red'
    b.stones['a2'] = 'red'
    b.stones['a3'] = 'blue'
    # a3's push options: a4, a13 (empty neighbors not red). Snare a4 AND
    # a13 so the kill happens regardless of the chosen escape cell.
    b.snares['a4'] = 'red'
    b.snares['a13'] = 'red'
    b.update()
    act = b._do_hard_move('red', 'a3')
    b.update()
    dest = act.pushed_to
    assert dest in ('a4', 'a13')
    assert b.stones[dest] is None and dest not in b.snares, \
        "pushed enemy stone must die on the snare"

    # Robi's scenario: enemy hard-moves onto a snared node occupied by the
    # owner's stone — the owner's stone is displaced, the arriving enemy
    # stone is destroyed by the snare.
    b2 = SimBoard(AMBUSH_SPELLS)
    b2.stones['a2'] = 'red'       # red stone ON red snare
    b2.snares['a2'] = 'red'
    b2.stones['a3'] = 'blue'      # blue attacker adjacent
    b2.stones['a13'] = 'blue'     # gives blue a stone adjacent for the move
    b2.update()
    act2 = b2._do_hard_move('blue', 'a2')   # blue pushes red off a2
    b2.update()
    assert b2.stones['a2'] is None and 'a2' not in b2.snares, \
        "arriving blue stone must be destroyed by the snare"
    assert act2.pushed_to != 'X' and b2.stones[act2.pushed_to] == 'red', \
        "displaced red stone survives at the push destination"
    print("  PASS")


def test_no_crush_credit():
    print("Testing snare kills do not set crushedThisTurn (JS-side check in smoke)...")
    # Python sim has no crushedThisTurn; assert the kill leaves pushes'
    # bookkeeping untouched by checking a plain soft-move suicide.
    b = _board()
    b.snares['a4'] = 'red'
    b.stones['a3'] = 'blue'
    b.stones['a13'] = 'blue'
    b.update()
    before = b.totalstones['blue']
    b.stones['a4'] = 'blue'   # blue soft-moves onto the snare
    b.update()
    assert b.totalstones['blue'] == before - 0  # entered (+1) then died (-1)
    assert b.stones['a4'] is None
    print("  PASS")


def test_snares_and_charging():
    print("Testing snares block charging until the owner fills the sigil...")
    b = _board()
    # Red snare inside position 1 (a2..a6) blocks BOTH sides' charge.
    b.snares['a4'] = 'red'
    for n in POSITIONS[1]:
        if n != 'a4':
            b.stones[n] = 'red'
    b.update()
    assert 'Minefield' not in b.charged_spells['red'], \
        "empty snared node keeps the sigil uncharged"
    # Owner fills the snared node: coexistence -> sigil charges.
    b.stones['a4'] = 'red'
    b.update()
    assert 'Minefield' in b.charged_spells['red']
    assert b.snares.get('a4') == 'red', "snare still there underneath"
    print("  PASS")


def test_elimination_via_snare():
    print("Testing elimination when the last enemy stone dies on a snare...")
    b = SimBoard(AMBUSH_SPELLS)
    b.stones['a1'] = 'red'
    b.stones['a3'] = 'blue'
    b.snares['a2'] = 'red'
    b.update()
    b.stones['a3'] = None
    b.stones['a2'] = 'blue'   # blue's last stone steps on the snare
    b.update()
    assert b.gameover and b.winner == 'red'
    print("  PASS")


def test_defensive_counting():
    print("Testing defensive counting (Robi's 6 vs 3+3 example)...")
    b = SimBoard(AMBUSH_SPELLS)
    for n in ('b2', 'b3', 'b4', 'b5', 'b6', 'b7'):
        b.stones[n] = 'blue'
    for n in ('a1', 'a2', 'a3'):
        b.stones[n] = 'red'
    for n in ('c8', 'c9', 'c10'):
        b.snares[n] = 'red'
    b.update()
    assert not b.check_game_over('blue'), \
        "opponent 6 vs your 3 stones + 3 snares must NOT lose"
    b2 = b.copy()
    b2.snares = {}
    b2.update()
    assert b2.check_game_over('blue') and b2.winner == 'blue'

    # Snares never power your own win claim.
    b3 = SimBoard(AMBUSH_SPELLS)
    for n in ('a1', 'a2', 'a3', 'a4', 'a5'):
        b3.stones[n] = 'red'
    for n in ('b2', 'b3', 'b4'):
        b3.stones[n] = 'blue'
    for n in ('c8', 'c9', 'c10'):
        b3.snares[n] = 'red'
    b3.update()
    assert not b3.check_game_over('red')

    # Elimination stays real-only.
    b4 = SimBoard(AMBUSH_SPELLS)
    b4.stones['b1'] = 'blue'
    for n in ('c8', 'c9'):
        b4.snares[n] = 'red'
    b4.update()
    assert b4.gameover and b4.winner == 'blue'

    # Score display includes snares (effective counts).
    b5 = _board()
    for n in ('c8', 'c9'):
        b5.snares[n] = 'red'
    b5.update()
    assert b5.score.startswith('r'), b5.score
    print("  PASS")


def test_fissure_interaction():
    print("Testing Fissure clears enemy snares in its blast radius...")
    b = SimBoard(FISSURE_SPELLS)
    b.setup_initial()
    b.stones['a4'] = 'red'
    b.snares['a2'] = 'blue'   # on target
    b.snares['a3'] = 'blue'   # adjacent to target
    b.snares['a6'] = 'red'    # caster's own snare in radius — survives
    b.snares['c9'] = 'blue'   # out of radius — survives
    b.update()
    acts = b._resolve_spell('Fissure', 'red', [],
                            target_overrides={'fissure_target': 'a2'})
    fa = [a for a in acts if a.type == 'fissure'][0]
    assert set(fa.nodes or []) == {'a2', 'a3'}, fa.nodes
    assert 'a6' in b.snares and 'c9' in b.snares
    assert 'a2' not in b.snares and 'a3' not in b.snares

    # Replay equivalence for fissure-with-snares.
    b2 = SimBoard(FISSURE_SPELLS)
    b2.setup_initial()
    b2.stones['a4'] = 'red'
    b2.snares.update({'a2': 'blue', 'a3': 'blue', 'a6': 'red', 'c9': 'blue'})
    b2.update()
    apply_sim_turn(b2, CompleteTurn([fa, Action('pass')]), 'red')
    assert b2.snares == b.snares and b2.stones == b.stones
    print("  PASS")


def test_copy_isolation():
    print("Testing copy() isolation...")
    b = _board()
    b.snares['a4'] = 'red'
    c = b.copy()
    c.snares['b9'] = 'blue'
    del c.snares['a4']
    assert b.snares == {'a4': 'red'}
    print("  PASS")


def test_hashing_and_repetition_keys():
    print("Testing hashing (pinned legacy + snare sensitivity) + |S keys...")
    from ai.minimax_ai import _get_hasher
    spells = ['Conflagration', 'Carnage', 'Bewitch', 'Smolder', 'Fireblast',
              'Hail_Storm', 'Ember', 'Slash', 'Surge']
    h = _get_hasher(spells)
    fresh = SimBoard(spells)
    fresh.setup_initial()
    assert h.hash(fresh, 'red') == LEGACY_HASH_LITERAL, (
        "legacy hash changed — the Ambush _snare table must be appended "
        "AFTER the Aftershock tables in _PositionHasher.__init__")
    f2 = fresh.copy()
    f2.snares['a4'] = 'red'
    f3 = fresh.copy()
    f3.snares['a4'] = 'blue'
    assert len({h.hash(fresh, 'red'), h.hash(f2, 'red'),
                h.hash(f3, 'red')}) == 3

    # Loop keys: NODE_ORDER-canonical regardless of insertion order.
    s1 = _board()
    s1.snares['b9'] = 'blue'
    s1.snares['a4'] = 'red'
    s2 = _board()
    s2.snares['a4'] = 'red'
    s2.snares['b9'] = 'blue'
    assert s1.looping_snapshot() == s2.looping_snapshot()
    assert '|S' in s1.looping_snapshot()
    assert '|S' not in _board().looping_snapshot()
    print("  PASS")


def test_sfn_roundtrip():
    print("Testing SFN sn: token round-trip + four-token coexistence...")
    b = _board()
    assert ' sn:' not in b.to_sfn()
    b.variant = 'competitive'
    b.pending_moves['red'] = [1]
    b.pending_burns['blue'] = [2]
    b.snares['a4'] = 'red'
    b.snares['b9'] = 'blue'
    b.update()
    s = b.to_sfn()
    assert (' competitive' in s and ' pm:1:-' in s and ' ab:-:2' in s
            and ' sn:a4=r,b9=b' in s), s
    r = SimBoard.from_sfn(s)
    assert r.snares == {'a4': 'red', 'b9': 'blue'}
    assert r.variant == 'competitive'
    assert r.to_sfn() == s
    print("  PASS")


def test_exhaustive_enumeration_and_caps():
    print("Testing exhaustive placement-set variants under the snare cap...")
    from ai.enumerator import (_spell_overrides, DEFAULT_CAPS, BALANCED_CAPS,
                               NARROW_CAPS, OPPONENT_CAPS)
    for caps in (DEFAULT_CAPS, BALANCED_CAPS, NARROW_CAPS, OPPONENT_CAPS):
        assert 'snare' in caps
    b = _board()
    b.stones['b3'] = 'blue'
    b.stones['b5'] = 'blue'
    b.update()
    ov = _spell_overrides(b, 'red', 'Deadfall', dict(DEFAULT_CAPS))
    assert ov[0] == {}
    sets = [tuple(o['snare_targets']) for o in ov[1:]]
    assert sets and len(set(sets)) == len(sets), "distinct window sets"
    assert all(len(s) <= 2 for s in sets)
    # Each override set casts to exactly that placement.
    for s in sets[:2]:
        bb = b.copy()
        bb._resolve_spell('Deadfall', 'red', [],
                          target_overrides={'snare_targets': list(s)})
        assert all(bb.snares.get(n) == 'red' for n in s)
    print("  PASS")


def test_replay_equivalence():
    print("Testing replay equivalence for place_snares turns...")
    b0 = _board()
    b0.stones['a7'] = 'red'
    b0.stones['b3'] = 'blue'
    b0.update()
    live = b0.copy()
    acts = live._cast_spell('Tripwire', 'red')
    rep = b0.copy()
    apply_sim_turn(rep, CompleteTurn(acts), 'red')
    assert rep.snares == live.snares
    assert rep.to_sfn() == live.to_sfn()
    print("  PASS")


def test_depth1_cast_incentive():
    print("Testing depth-1 cast incentive (snares are effective material)...")
    from ai.minimax_ai import _apply_turn
    # Full mana Deadfall: cast costs 3-3=0 real, +2 snares = +2 effective.
    b = _board()
    for n in POSITIONS[4]:      # Deadfall is slot 3 -> position 4
        b.stones[n] = 'red'
    for n in ('a1', 'b1', 'c1'):
        b.stones[n] = 'red'
    b.stones['b3'] = 'blue'
    b.stones['b13'] = 'blue'
    b.update()
    b.whose_turn = 'red'
    best_cast = best_plain = None
    for t in b.get_legal_turns('red'):
        sim = _apply_turn(b, t, 'red')
        diff = sim.effective_stones('red') - sim.effective_stones('blue')
        if any(a.type == 'cast' and a.spell == 'Deadfall' for a in t.actions):
            best_cast = diff if best_cast is None else max(best_cast, diff)
        elif all(a.type in ('move', 'pass') for a in t.actions):
            best_plain = diff if best_plain is None else max(best_plain, diff)
    assert best_cast is not None and best_plain is not None
    assert best_cast > best_plain, (best_cast, best_plain)
    print("  PASS")


def test_js_parity_smoke():
    print("Testing JS engine parity smoke...")
    engine = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')
    js = []
    for fn in ('constants.js', 'notation.js', 'spells.js', 'moves.js',
               'sim-board.js', 'enumerator.js', 'minimax-ai.js',
               'caveman-ai.js'):
        with open(os.path.join(engine, fn), encoding='utf-8') as f:
            js.append(f.read())
    js.append(r"""
const SP = ['Minefield','Carnage','Bewitch','Deadfall','Fireblast','Hail_Storm','Tripwire','Slash','Surge'];
// Consumption + persistence.
const b = new SimBoard(SP); b.stones.a1='red'; b.stones.b1='blue';
b.snares.a5 = 'red';
b.stones.a5 = 'red'; b.update();
if (b.snares.a5 !== 'red') throw new Error('owner coexistence');
b.stones.a5 = null; b.update();
if (b.snares.a5 !== 'red') throw new Error('survives removal');
b.stones.a5 = 'blue'; b.update();
if (b.stones.a5 !== null || b.snares.a5) throw new Error('enemy entry');
if (b.crushedThisTurn) throw new Error('snare kill must not count as crush');
// Defensive counting parity: 6 blue vs 3 red + 3 red snares.
const d = new SimBoard(SP);
for (const n of ['b2','b3','b4','b5','b6','b7']) d.stones[n]='blue';
for (const n of ['a1','a2','a3']) d.stones[n]='red';
for (const n of ['c8','c9','c10']) d.snares[n]='red';
d.update();
if (d.checkGameOver('blue')) throw new Error('defensive counting');
if (d.effectiveStones('red') !== 6) throw new Error('effectiveStones: ' + d.effectiveStones('red'));
// SFN round-trip.
d.pendingBurns.blue = [1]; d.update();
const s = boardToSfn(d);
if (!s.includes(' sn:')) throw new Error('sn token');
const st = sfnToDict(s);
if (st.snares.c8 !== 'red') throw new Error('sn parse');
// Hash suffix.
if (!_minimaxPosHash(d, 'red').includes('|S')) throw new Error('hash |S');
// Exhaustive set variants.
const e = new SimBoard(SP); e.stones.a1='red'; e.stones.b3='blue'; e.stones.b5='blue'; e.update();
const ov = _spellOverrides(e, 'red', 'Deadfall', ENUM_CAPS);
if (!ov.some(o => o.snare_targets)) throw new Error('overrides');
// Fissure clears enemy snares (replay via _minimaxApplyTurn).
const f = new SimBoard(['Fissure','Carnage','Bewitch','Deadfall','Fireblast','Hail_Storm','Tripwire','Slash','Surge']);
f.stones.a1='red'; f.stones.b1='blue'; f.stones.a4='red';
f.snares.a2='blue'; f.snares.a3='blue'; f.snares.a6='red'; f.update();
const facts = f._resolveSpell('Fissure', 'red', [], { fissure_target: 'a2' });
const fa = facts.find(a => a.type === 'fissure');
if (!fa.nodes || fa.nodes.length !== 2) throw new Error('fissure nodes: ' + JSON.stringify(fa.nodes));
if (!f.snares.a6 || f.snares.a2 || f.snares.a3) throw new Error('fissure snare clearing');
console.log('JS_OK');
""")
    proc = subprocess.run(['node', '-'], input='\n'.join(js),
                          capture_output=True, text=True, timeout=120)
    if 'JS_OK' not in proc.stdout:
        print(proc.stdout[-2000:])
        print(proc.stderr[-2000:])
        raise AssertionError('JS parity smoke failed')
    print("  PASS")


def main():
    test_metadata()
    test_cast_and_placement_legality()
    test_persistence_rules()
    test_push_scenarios()
    test_no_crush_credit()
    test_snares_and_charging()
    test_elimination_via_snare()
    test_defensive_counting()
    test_fissure_interaction()
    test_copy_isolation()
    test_hashing_and_repetition_keys()
    test_sfn_roundtrip()
    test_exhaustive_enumeration_and_caps()
    test_replay_equivalence()
    test_depth1_cast_incentive()
    test_js_parity_smoke()
    print("All Ambush tests passed.")


if __name__ == '__main__':
    main()
