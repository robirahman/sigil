"""Providence pack tests: scheduled extra moves, asymmetric phantom
stones, enumeration, hashing, replay, and notation.

Run: python -m ai.test_providence
"""
import subprocess
import os
import sys

from simboard import (SimBoard, Action, CompleteTurn, apply_sim_turn,
                      CORE_SPELLS)
from notation import NODE_ORDER, POSITIONS

PROVIDENCE_SPELLS = ['Endowment', 'Carnage', 'Bewitch',
                     'Annuity', 'Fireblast', 'Hail_Storm',
                     'Dividend', 'Slash', 'Surge']

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _board(spell_names=None):
    b = SimBoard(spell_names or PROVIDENCE_SPELLS)
    b.setup_initial()
    return b


def test_metadata():
    print("Testing CORE_SPELLS metadata...")
    assert CORE_SPELLS['Dividend'] == {'resolve': 'schedule_moves', 'turns': 1,
                                       'static': False, 'ischarm': True}
    assert CORE_SPELLS['Annuity']['turns'] == 2
    assert CORE_SPELLS['Endowment']['turns'] == 4
    print("  PASS")


def test_cast_semantics():
    print("Testing cast semantics + charm/lock behavior...")
    # Dividend (charm at slot 6 -> position 7 = a7).
    b = _board()
    b.stones['a7'] = 'red'
    b.update()
    assert 'Dividend' in b.charged_spells['red']
    acts = b._cast_spell('Dividend', 'red')
    assert b.pending_moves['red'] == [1]
    assert b.stones['a7'] is None, "charm sigil sacrificed, no refill"
    assert b.lock['red'] is None and b.spell_counter['red'] == 0, \
        "charms advance neither lock nor counter"
    assert any(a.type == 'schedule_moves' and a.turns == 1 and
               a.spell == 'Dividend' for a in acts)

    # Endowment (ritual at slot 0 -> position 1 = a2..a6), with full mana.
    b2 = _board()
    for n in POSITIONS[1]:
        b2.stones[n] = 'red'
    for n in ('a1', 'b1', 'c1'):
        b2.stones[n] = 'red'
    b2.update()
    assert b2.mana['red'] == 3
    b2._cast_spell('Endowment', 'red')
    assert b2.pending_moves['red'] == [1, 1, 1, 1]
    assert b2.lock['red'] == 'Endowment' and b2.spell_counter['red'] == 1
    kept = sum(1 for n in POSITIONS[1] if b2.stones[n] == 'red')
    assert kept == 3, "ritual refills mana stones"
    print("  PASS")


def test_additive_stacking():
    print("Testing additive stacking...")
    b = _board()
    b._resolve_spell('Endowment', 'blue', [])
    assert b.pending_moves['blue'] == [1, 1, 1, 1]
    b._resolve_spell('Dividend', 'blue', [])
    assert b.pending_moves['blue'] == [2, 1, 1, 1]
    b._resolve_spell('Annuity', 'blue', [])
    assert b.pending_moves['blue'] == [3, 2, 1, 1]
    print("  PASS")


def test_advance_turn_pop_and_forfeit():
    print("Testing advance_turn pop + implicit forfeit...")
    b = _board()
    b.pending_moves['blue'] = [2, 1]
    b.advance_turn()  # red -> blue
    assert b.whose_turn == 'blue'
    assert b.extra_moves_this_turn == 2 and b.pending_moves['blue'] == [1]
    b.advance_turn()  # blue -> red (unused extras overwritten = forfeited)
    assert b.extra_moves_this_turn == 0
    b.advance_turn()  # red -> blue
    assert b.extra_moves_this_turn == 1 and b.pending_moves['blue'] == []
    print("  PASS")


def test_copy_isolation():
    print("Testing copy() isolation...")
    b = _board()
    b.pending_moves['red'] = [1, 1]
    b.extra_moves_this_turn = 2
    c = b.copy()
    assert c.pending_moves == b.pending_moves
    assert c.extra_moves_this_turn == 2
    c.pending_moves['red'].append(9)
    c.pending_moves['blue'].append(9)
    assert b.pending_moves == {'red': [1, 1], 'blue': []}
    print("  PASS")


def test_greedy_enumeration():
    print("Testing greedy enumeration (extras=0 regression + chain)...")

    def base_moves(t):
        n = 0
        for a in t.actions:
            if a.type in ('move', 'hard_move', 'blink'):
                n += 1
            else:
                break
        return n

    b = _board()
    b.stones['a2'] = 'red'
    b.stones['b2'] = 'blue'
    b.update()
    t0 = list(b.get_legal_turns('red'))
    assert set(map(base_moves, t0)) == {1}, "extras=0 must be single-move turns"

    b.extra_moves_this_turn = 2
    t2 = list(b.get_legal_turns('red'))
    counts = {}
    for t in t2:
        counts[base_moves(t)] = counts.get(base_moves(t), 0) + 1
    assert set(counts) == {1, 2, 3}, counts
    # Greedy: exactly one continuation per extra step -> equal bucket sizes.
    assert counts[1] == counts[2] == counts[3] == len(t0)
    print("  PASS")


def test_exhaustive_enumeration_and_caps():
    print("Testing exhaustive enumeration caps + dedup + cap keys...")
    from ai.enumerator import (get_legal_turns_exhaustive, DEFAULT_CAPS,
                               BALANCED_CAPS, NARROW_CAPS, OPPONENT_CAPS)
    for caps in (DEFAULT_CAPS, BALANCED_CAPS, NARROW_CAPS, OPPONENT_CAPS):
        assert 'extra_move' in caps or caps is BALANCED_CAPS or True
    assert 'extra_move' in DEFAULT_CAPS
    assert 'fissure' in DEFAULT_CAPS, "B1 regression: fissure must have a default cap"
    assert 'extra_move' in NARROW_CAPS and 'extra_move' in OPPONENT_CAPS
    assert 'extra_move' in BALANCED_CAPS

    def base_moves(t):
        n = 0
        for a in t.actions:
            if a.type in ('move', 'hard_move', 'blink'):
                n += 1
            else:
                break
        return n

    b = _board()
    b.stones['a2'] = 'red'
    b.stones['b2'] = 'blue'
    b.update()
    b.extra_moves_this_turn = 2
    # caps={} must not KeyError (B1 class of bug) and must honor extra_move.
    turns = list(get_legal_turns_exhaustive(b, 'red', caps={}))
    assert max(map(base_moves, turns)) == 3
    b.extra_moves_this_turn = 0
    turns0 = list(get_legal_turns_exhaustive(b, 'red', caps={}))
    assert max(map(base_moves, turns0)) == 1
    print("  PASS")


def test_spell_overrides_noop():
    print("Testing _spell_overrides no-op for Providence spells...")
    from ai.enumerator import _spell_overrides, NARROW_CAPS
    b = _board()
    for name in ('Dividend', 'Annuity', 'Endowment'):
        assert _spell_overrides(b, 'red', name, dict(NARROW_CAPS)) == [{}], \
            "targetless spells keep only the greedy variant"
    print("  PASS")


def test_replay_equivalence():
    print("Testing replay equivalence (schedule applied exactly once)...")
    b0 = _board()
    b0.stones['a7'] = 'red'
    b0.update()
    live = b0.copy()
    acts = live._cast_spell('Dividend', 'red')
    replay = b0.copy()
    apply_sim_turn(replay, CompleteTurn(acts), 'red')
    assert replay.pending_moves['red'] == [1], \
        "replaying a recorded cast turn must apply the schedule ONCE"
    assert replay.to_sfn() == live.to_sfn()
    print("  PASS")


def test_three_ply_decrement():
    print("Testing schedule decrement across _apply_turn plies...")
    from ai.minimax_ai import _apply_turn
    b = _board()
    b.stones['a2'] = 'red'
    for n in POSITIONS[1]:
        b.stones[n] = 'red'
    b.stones['b2'] = 'blue'
    b.stones['b3'] = 'blue'
    b.update()
    b.whose_turn = 'red'
    # Red: move + cast Endowment.
    cast_turn = None
    for t in b.get_legal_turns('red'):
        if any(a.type == 'cast' and a.spell == 'Endowment' for a in t.actions):
            cast_turn = t
            break
    assert cast_turn is not None
    after_red = _apply_turn(b, cast_turn, 'red')
    assert after_red.pending_moves['red'] == [1, 1, 1, 1]
    assert after_red.whose_turn == 'blue' and after_red.extra_moves_this_turn == 0
    # Blue: any turn. Then red's head pops.
    blue_turn = next(iter(after_red.get_legal_turns('blue')))
    after_blue = _apply_turn(after_red, blue_turn, 'blue')
    if not after_blue.gameover:
        assert after_blue.whose_turn == 'red'
        assert after_blue.extra_moves_this_turn == 1
        assert after_blue.pending_moves['red'] == [1, 1, 1]
    print("  PASS")


def test_asymmetric_win_semantics():
    print("Testing asymmetric phantom win semantics...")
    # (c) Phantom-inflated lead is NOT a win.
    b = _board()
    b.stones.update({n: None for n in NODE_ORDER})
    for n in ('a1', 'a2', 'a3'):
        b.stones[n] = 'red'
    b.stones['b1'] = 'blue'
    b.stones['b2'] = 'blue'
    b.pending_moves['red'] = [1, 1, 1, 1]
    b.update()
    assert not b.check_game_over('red'), "phantoms never power a win claim"

    # Defensive: pending stones cover a would-be ±3 loss.
    b2 = _board()
    b2.stones.update({n: None for n in NODE_ORDER})
    for n in ('a1', 'a2', 'a3', 'a4', 'a5'):
        b2.stones[n] = 'red'
    b2.stones['b1'] = 'blue'
    b2.update()
    assert b2.copy().check_game_over('red'), "5 vs 1(+1) is a red win baseline"
    b2.pending_moves['blue'] = [1, 1]
    assert not b2.check_game_over('red'), \
        "defender's scheduled stones must block the ±3-lead win"

    # Mover's extras never count in win checks (forfeit-at-EOT rule).
    b2b = b2.copy()
    b2b.pending_moves['blue'] = []
    b2b.whose_turn = 'red'
    b2b.extra_moves_this_turn = 5
    assert b2b.check_game_over('red'), \
        "mover's own extras-this-turn are not part of the terminal math"

    # 6th-spell tiebreak: claims are real-vs-effective.
    b3 = _board()
    b3.stones.update({n: None for n in NODE_ORDER})
    for n in ('a1', 'a2', 'a3', 'a4', 'a5'):
        b3.stones[n] = 'red'
    for n in ('b1', 'b2', 'b3'):
        b3.stones[n] = 'blue'
    b3.update()
    b3.spell_counter['red'] = 6
    with_pend = b3.copy()
    with_pend.pending_moves['blue'] = [2]
    assert with_pend.check_game_over('red') and with_pend.winner == 'blue', \
        "5 real vs 4+2 effective: red's claim fails, tie goes against caster"
    b3.pending_moves['blue'] = []
    assert b3.check_game_over('red') and b3.winner == 'red', \
        "without pending, 5 vs 4 is a red tiebreak win"

    # Elimination stays real-only.
    b4 = _board()
    b4.stones.update({n: None for n in NODE_ORDER})
    b4.stones['b1'] = 'blue'
    b4.pending_moves['red'] = [1, 1]
    b4.update()
    assert b4.gameover and b4.winner == 'blue', \
        "zero real stones loses despite pending phantoms"
    print("  PASS")


def test_shallow_depth_cast_incentive():
    print("Testing shallow-depth cast incentive (horizon guarantee)...")
    from ai.minimax_ai import _apply_turn
    # (a) Defensive: casting lifts the caster out of ±3 losing range NOW.
    # Red 9 real (Endowment sigil + all mana + a13) vs blue 13 real (+1
    # phantom = 14). After red's base move (10 real) blue still leads by 4:
    # every plain turn loses on the post-turn check. Move + Endowment ends
    # at 8 real + 4 pending: 14 > 8+4+2 is false -> only the cast survives.
    b = _board()
    for n in POSITIONS[1]:
        b.stones[n] = 'red'
    for n in ('a1', 'b1', 'c1', 'a13'):
        b.stones[n] = 'red'
    for n in ('b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10',
              'b11', 'b12', 'b13', 'c2'):
        b.stones[n] = 'blue'
    b.update()
    b.whose_turn = 'red'
    cast_survives = False
    saw_plain = False
    for t in b.get_legal_turns('red'):
        sim = _apply_turn(b, t, 'red')
        is_cast = any(a.type == 'cast' and a.spell == 'Endowment'
                      for a in t.actions)
        is_dash = any(a.type in ('dash', 'dash_lightning') for a in t.actions)
        if is_cast and not is_dash and not sim.gameover:
            cast_survives = True
        elif all(a.type in ('move', 'pass') for a in t.actions):
            saw_plain = True
            assert sim.gameover and sim.winner == 'blue', \
                "without the cast, blue's +4 lead wins on the post-turn check"
    assert saw_plain
    assert cast_survives, \
        "the pending credit must cancel the ±3 loss immediately"

    # (b) Effective-stones credit makes the cast attractive at depth 1.
    b2 = _board()
    for n in POSITIONS[1]:
        b2.stones[n] = 'red'
    for n in ('a1', 'b1', 'c1'):
        b2.stones[n] = 'red'
    b2.stones['b2'] = 'blue'
    b2.stones['b3'] = 'blue'
    b2.stones['b4'] = 'blue'
    b2.update()
    b2.whose_turn = 'red'
    best_cast = None
    best_plain = None
    for t in b2.get_legal_turns('red'):
        sim = _apply_turn(b2, t, 'red')
        diff = sim.effective_stones('red') - sim.effective_stones('blue')
        if any(a.type == 'cast' and a.spell == 'Endowment' for a in t.actions):
            best_cast = max(best_cast, diff) if best_cast is not None else diff
        elif all(a.type in ('move', 'pass') for a in t.actions):
            best_plain = max(best_plain, diff) if best_plain is not None else diff
    assert best_cast is not None and best_plain is not None
    assert best_cast > best_plain, (
        "with full mana, Endowment's +4 pending (net +2 real cost) must "
        "outscore a plain move at depth 1 — the payoff may not be deferred "
        f"beyond the horizon (cast {best_cast} vs plain {best_plain})")
    print("  PASS")


def test_hashing_and_repetition_keys():
    print("Testing Zobrist + looping-snapshot sensitivity...")
    from ai.minimax_ai import _get_hasher
    b = _board()
    h = _get_hasher(b.spell_names)
    h0 = h.hash(b, 'red')
    # Legacy byte-stability: fresh board hash unchanged by the feature.
    assert h.hash(_board(), 'red') == h0
    b1 = b.copy()
    b1.pending_moves['red'] = [1]
    assert h.hash(b1, 'red') != h0
    b2 = b.copy()
    b2.pending_moves['red'] = [2]
    assert h.hash(b2, 'red') not in (h0, h.hash(b1, 'red'))
    b3 = b.copy()
    b3.extra_moves_this_turn = 1
    assert h.hash(b3, 'red') not in (h0, h.hash(b1, 'red'))

    # Looping snapshot: canonical pre-shift form matches across live/sim.
    s1 = _board()
    s1.pending_moves['blue'] = [2, 1]
    key_live_style = s1.looping_snapshot()      # pre-shift
    s2 = _board()
    s2.pending_moves['blue'] = [2, 1]
    s2.turn_counter = 1
    s2.whose_turn = 'blue'
    s1.turn_counter = 1
    s1.whose_turn = 'blue'
    pre = s1.looping_snapshot()
    s2.pending_moves['blue'] = [1]
    s2.extra_moves_this_turn = 2                # post-pop equivalent
    assert s2.looping_snapshot() == pre
    # Empty schedules keep the legacy key byte-identical.
    fresh = _board()
    assert '|P' not in fresh.looping_snapshot()
    assert '|P' in pre
    print("  PASS")


def test_sfn_roundtrip():
    print("Testing SFN pm: token round-trip...")
    b = _board()
    s_legacy = b.to_sfn()
    assert ' pm:' not in s_legacy
    assert SimBoard.from_sfn(s_legacy).to_sfn() == s_legacy

    b.pending_moves['red'] = [2, 1, 1]
    b.pending_moves['blue'] = [1]
    b.update()
    s = b.to_sfn()
    assert ' pm:2,1,1:1' in s
    r = SimBoard.from_sfn(s)
    assert r.pending_moves == {'red': [2, 1, 1], 'blue': [1]}
    assert r.to_sfn() == s

    # Together with a non-standard variant token.
    b.variant = 'competitive'
    b.update()
    s2 = b.to_sfn()
    r2 = SimBoard.from_sfn(s2)
    assert r2.variant == 'competitive'
    assert r2.pending_moves['red'] == [2, 1, 1]
    print("  PASS")


def test_js_parity_smoke():
    print("Testing JS engine parity smoke (leaf credit + enumeration)...")
    engine = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')
    js = []
    for fn in ('constants.js', 'notation.js', 'spells.js', 'moves.js',
               'sim-board.js', 'enumerator.js', 'minimax-ai.js',
               'caveman-ai.js'):
        with open(os.path.join(engine, fn), encoding='utf-8') as f:
            js.append(f.read())
    js.append(r"""
const b = new SimBoard(['Endowment','Carnage','Bewitch','Annuity','Fireblast','Hail_Storm','Dividend','Slash','Surge']);
b.stones.a1='red'; b.stones.a2='red'; b.stones.b1='blue'; b.stones.b2='blue'; b.update();
const w = { mana: 0, voidPenalty: 0, mapControl: 0 };
const l0 = _cavemanLeaf(b, 'red', w);
b.pendingMoves.red = [1,1]; b.update();
const l1 = _cavemanLeaf(b, 'red', w);
if (!(l1 > l0)) throw new Error('leaf must credit pending stones: ' + l0 + ' -> ' + l1);
// Enumeration honors extras.
b.pendingMoves.red = []; b.extraMovesThisTurn = 1; b.update();
let maxBase = 0;
for (const t of b.getLegalTurns('red')) {
    let n = 0;
    for (const a of t.actions) { if (['move','hard_move','blink'].includes(a.type)) n++; else break; }
    if (n > maxBase) maxBase = n;
}
if (maxBase !== 2) throw new Error('greedy JS enumeration must offer the extra move, got ' + maxBase);
const ex = getLegalTurnsExhaustive(b, 'red');
let maxBaseEx = 0;
for (const t of ex) {
    let n = 0;
    for (const a of t.actions) { if (['move','hard_move','blink'].includes(a.type)) n++; else break; }
    if (n > maxBaseEx) maxBaseEx = n;
}
if (maxBaseEx !== 2) throw new Error('exhaustive JS enumeration must offer the extra move');
// Depth-2 caveman search: only casting Endowment prevents the ±3 loss
// (mirrors test_shallow_depth_cast_incentive's Python position).
const d = new SimBoard(['Endowment','Carnage','Bewitch','Annuity','Fireblast','Hail_Storm','Dividend','Slash','Surge']);
for (const n of ['a2','a3','a4','a5','a6','a1','b1','c1','a13']) d.stones[n]='red';
for (const n of ['b2','b3','b4','b5','b6','b7','b8','b9','b10','b11','b12','b13','c2']) d.stones[n]='blue';
d.update(); d.whoseTurn = 'red';
cavemanSearch(d, 'red', { timeLimit: 10, maxDepth: 2 }).then((res) => {
    const castsEndowment = res.turn && res.turn.actions.some(a => a.type === 'cast' && a.spell === 'Endowment');
    if (!castsEndowment) throw new Error('depth-2 search must find the loss-preventing Endowment cast, picked: ' + JSON.stringify(res.turn && res.turn.actions.map(a => a.type + ':' + (a.spell || a.node))));
    console.log('JS_OK');
}).catch(e => { console.error(e.message || e); process.exit(1); });
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
    test_cast_semantics()
    test_additive_stacking()
    test_advance_turn_pop_and_forfeit()
    test_copy_isolation()
    test_greedy_enumeration()
    test_exhaustive_enumeration_and_caps()
    test_spell_overrides_noop()
    test_replay_equivalence()
    test_three_ply_decrement()
    test_asymmetric_win_semantics()
    test_shallow_depth_cast_incentive()
    test_hashing_and_repetition_keys()
    test_sfn_roundtrip()
    test_js_parity_smoke()
    print("All Providence tests passed.")


if __name__ == '__main__':
    main()
