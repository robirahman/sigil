"""Seal of Stone x Seal of Wind interaction (2026-08 clarification).

Seal of Stone (enemy-held) forces the opening move to be SOFT — no
pushes. A Seal of Wind holder keeps blink moves to EMPTY nodes (a soft
blink is a soft move); only hard blinks onto occupied nodes are barred.
Before the fix, Stone wrongly suppressed ALL of Wind's blinks, and the
Python exhaustive enumerator skipped the Stone check entirely (it could
open with an illegal hard move).

Covers the greedy sim, both exhaustive enumerators, and the live JS
moves.js helpers (getStandardMoveTargets / violatesSealOfStone).

Run:
    python -m ai.test_seals
"""

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simboard import SimBoard
from notation import NODE_ORDER, ADJACENCY
from ai.enumerator import get_legal_turns_exhaustive

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Slot 7 (index 6) sits on a7, slot 8 (index 7) on b7 — single-node
# sigils, so one stone charges each seal.
SPELLS = ['Flourish', 'Carnage', 'Bewitch', 'Grow', 'Fireblast',
          'Hail_Storm', 'Seal_of_Wind', 'Seal_of_Stone', 'Surge']


def _board(red_wind=True, blue_stone=True):
    b = SimBoard(SPELLS)
    b.stones['a1'] = 'red'
    b.stones['a2'] = 'blue'   # adjacent to a1: a tempting hard-move target
    b.stones['b1'] = 'blue'
    if red_wind:
        b.stones['a7'] = 'red'    # charges Seal_of_Wind for red
    if blue_stone:
        b.stones['b7'] = 'blue'   # charges Seal_of_Stone for blue
    b.update()
    if red_wind:
        assert 'Seal_of_Wind' in b.charged_spells['red']
    if blue_stone:
        assert 'Seal_of_Stone' in b.charged_spells['blue']
    return b


def _first_moves(turns):
    """(type, node) of each turn's first action."""
    out = set()
    for t in turns:
        a = t.actions[0]
        out.add((a.type, a.node))
    return out


def _check_stone_wind(first_moves, board):
    empties = {n for n in NODE_ORDER if board.stones[n] is None}
    non_adjacent_empty = next(
        n for n in sorted(empties)
        if not any(board.stones[nb] == 'red' for nb in ADJACENCY[n]))
    types = {t for t, _ in first_moves}
    assert 'hard_move' not in types, \
        "no pushes allowed under Seal of Stone"
    for t, n in first_moves:
        if t in ('move', 'blink'):
            assert n in empties, f"first move onto occupied node {n}"
    assert any(t == 'blink' and n == non_adjacent_empty
               for t, n in first_moves), \
        "Wind's soft blink to a non-adjacent empty node must survive Stone"
    covered = {n for t, n in first_moves if t in ('move', 'blink')}
    assert covered == empties, \
        f"Stone+Wind first-move targets must be exactly the empty nodes " \
        f"(missing {sorted(empties - covered)[:5]})"


def test_greedy():
    print("Testing greedy sim: Stone + Wind => soft blinks to empty nodes...")
    b = _board()
    _check_stone_wind(_first_moves(b.get_legal_turns('red')), b)

    # Stone alone: soft ADJACENT moves only, no blinks anywhere.
    b2 = _board(red_wind=False)
    fm = _first_moves(b2.get_legal_turns('red'))
    assert all(t == 'move' for t, _ in fm), fm
    for _, n in fm:
        assert b2.stones[n] is None
        assert any(b2.stones[nb] == 'red' for nb in ADJACENCY[n])

    # Wind alone (regression): hard blinks onto enemy stones stay legal.
    b3 = _board(blue_stone=False)
    fm3 = _first_moves(b3.get_legal_turns('red'))
    assert any(t == 'blink' and b3.stones[n] == 'blue' for t, n in fm3), \
        "without Stone, Wind's hard blink must remain available"
    print("  PASS")


def test_exhaustive():
    print("Testing exhaustive enumerator honors Seal of Stone...")
    b = _board()
    _check_stone_wind(_first_moves(get_legal_turns_exhaustive(b, 'red')), b)

    # Stone alone: the root previously skipped the Stone check entirely.
    b2 = _board(red_wind=False)
    fm = _first_moves(get_legal_turns_exhaustive(b2, 'red'))
    assert all(t == 'move' for t, _ in fm), \
        f"exhaustive engine must not open with a push under Stone: {fm}"
    print("  PASS")


def test_js_parity():
    print("Testing JS parity (sim + enumerator + live moves.js helpers)...")
    engine = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')
    js = []
    for fn in ('constants.js', 'notation.js', 'moves.js', 'spells.js',
               'board.js', 'sim-board.js', 'enumerator.js'):
        with open(os.path.join(engine, fn), encoding='utf-8') as f:
            js.append(f.read())
    js.append(r"""
const SP = ['Flourish','Carnage','Bewitch','Grow','Fireblast','Hail_Storm','Seal_of_Wind','Seal_of_Stone','Surge'];
function setup(Cls) {
	const b = new Cls(SP, 'standard');
	b.stones.a1='red'; b.stones.a2='blue'; b.stones.b1='blue';
	b.stones.a7='red'; b.stones.b7='blue';
	b.update();
	if (!b.chargedSpells.red.includes('Seal_of_Wind')) throw new Error('wind not charged');
	if (!b.chargedSpells.blue.includes('Seal_of_Stone')) throw new Error('stone not charged');
	return b;
}
const empties = n => n === null;
// Sim greedy + exhaustive: no hard first move; blinks cover empty nodes.
for (const turns of [[...setup(SimBoard).getLegalTurns('red')],
                     getLegalTurnsExhaustive(setup(SimBoard), 'red', ENUM_CAPS)]) {
	const sim = setup(SimBoard);
	const first = turns.map(t => t.actions[0]);
	if (first.some(a => a.type === 'hard_move')) throw new Error('push under Stone');
	const targets = new Set(first.filter(a => a.type === 'move' || a.type === 'blink').map(a => a.node));
	for (const n of NODE_ORDER) {
		if (sim.stones[n] === null && !targets.has(n)) throw new Error('missing empty target ' + n);
		if (sim.stones[n] !== null && targets.has(n)) throw new Error('occupied target ' + n);
	}
}
// Live helpers on SigilBoard.
const live = setup(SigilBoard);
const opts = getStandardMoveTargets(live, 'red', true);
for (const n of NODE_ORDER) {
	const want = live.stones[n] === null;
	if (want !== (n in opts)) throw new Error('getStandardMoveTargets mismatch at ' + n);
}
if (violatesSealOfStone(live, 'red', 'c9', true)) throw new Error('soft blink flagged illegal');
if (!violatesSealOfStone(live, 'red', 'a2', true)) throw new Error('hard move not flagged');
if (!violatesSealOfStone(live, 'red', 'b1', true)) throw new Error('hard blink not flagged');
console.log('JS_OK');
""")
    proc = subprocess.run(['node', '-'], input='\n'.join(js),
                          capture_output=True, text=True, timeout=120)
    if 'JS_OK' not in proc.stdout:
        print(proc.stdout[-2000:])
        print(proc.stderr[-2000:])
        raise AssertionError('JS parity failed')
    print("  PASS")


def main():
    test_greedy()
    test_exhaustive()
    test_js_parity()
    print("All seal-interaction tests passed.")


if __name__ == '__main__':
    main()
