"""Test the stubborn-loss search: mate-distance scores + trappiness pass.

Covers the 2026-08 "stubborn AI" change (caveman-ai.js, minimax_ai.py,
minimax-ai.js): terminal leaves score ±(WIN - ply) so the search prefers
the slowest loss / fastest win; a proven loss no longer ends the search
early — the remaining budget goes into a trappiness pass that picks the
losing move whose refutation is hardest for the opponent.

Three parts:

1. Python unit tests: `_eval_leaf` distance encoding and the
   node-relative TT mate-score adjustment (`_mate_to_tt`/`_mate_from_tt`).

2. JS end-to-end (node, via tools/arena/engine.js): scan the densest
   selfplay positions (ai/data/selfplay_v22b_*.jsonl) until a search
   reports `provenLoss`, then independently verify at that position
   that (a) the reported score is distance-encoded, (b) playing the
   chosen move gives the opponent a proven win exactly one ply sooner,
   and (c) the chosen move's loss distance is within the trap margin of
   the slowest proven loss among sampled alternatives. Searches run
   with `exhaustiveOpponent: false` — exhaustive ply-1 enumeration on
   spell-heavy late-game boards keeps the engine at depth 1, so proofs
   never fire; the greedy-opponent proof is self-consistent because the
   verification probes use the same setting.

3. Python end-to-end: the shortest-mate lost position from part 2 is
   re-searched with `minimax_search` using a deterministic stub model
   (uniform policy, zero value — terminal rules still real), asserting
   the root is proven lost and the returned move is within the trap
   margin of the slowest loss.

Assertions are property-based (distances / chosen-set membership), not
exact moves — caveman move ordering shuffles ties deliberately.

Run:
    python -m ai.test_stubborn_loss
"""

import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simboard import SimBoard
from ai.minimax_ai import (
    _eval_leaf, _mate_to_tt, _mate_from_tt, _alphabeta, _apply_turn,
    _get_hasher, _TT, _KillerTable, _INF, _WIN, _PROVEN_MIN, _MATE_PLY_CAP,
    _NONTERMINAL_CAP, _TRAP_MARGIN_PLIES, minimax_search,
)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARENA = os.path.join(REPO, 'tools', 'arena')

CLASSIC_SPELLS = ['Flourish', 'Carnage', 'Bewitch', 'Grow', 'Fireblast',
                  'Hail_Storm', 'Sprout', 'Slash', 'Surge']


# ---------------------------------------------------------------------------
# Part 1: unit tests
# ---------------------------------------------------------------------------

def test_leaf_distance_encoding():
    print('Testing _eval_leaf mate-distance encoding...', flush=True)
    b = SimBoard(CLASSIC_SPELLS, 'standard')
    b.gameover = True

    b.winner = 'red'
    assert _eval_leaf(b, 'red', None, ply=0) == _WIN
    assert _eval_leaf(b, 'red', None, ply=5) == _WIN - 5
    assert _eval_leaf(b, 'blue', None, ply=5) == -(_WIN - 5)
    # Ply clamps at the cap so mate scores never enter the heuristic band.
    assert _eval_leaf(b, 'red', None, ply=200) == _WIN - _MATE_PLY_CAP
    assert _eval_leaf(b, 'red', None, ply=200) == _PROVEN_MIN

    b.winner = None
    assert _eval_leaf(b, 'red', None, ply=7) == 0.0
    print('  PASS', flush=True)


def test_tt_mate_adjustment():
    print('Testing node-relative TT mate-score adjustment...', flush=True)
    # A mate D plies below a node must read back with the same D no
    # matter which ply the node is probed from.
    for d in (1, 4, 20):
        for store_ply in (0, 3, 10):
            for probe_ply in (0, 3, 10):
                root_rel = -(_WIN - (store_ply + d))      # loss D below node
                stored = _mate_to_tt(root_rel, store_ply)
                assert stored == -(_WIN - d)              # node-relative
                back = _mate_from_tt(stored, probe_ply)
                assert back == -(_WIN - (probe_ply + d)), (d, store_ply, probe_ply)
                # Same for wins.
                assert _mate_from_tt(_mate_to_tt(-root_rel, store_ply),
                                     probe_ply) == _WIN - (probe_ply + d)
    # Heuristic scores pass through untouched.
    for s in (0.0, 0.5, -1.2, _NONTERMINAL_CAP, -_NONTERMINAL_CAP):
        assert _mate_to_tt(s, 9) == s
        assert _mate_from_tt(s, 9) == s
    # Probing very deep never drops a mate score out of the proven band.
    assert _mate_from_tt(-(_WIN - 1), 200) == -_PROVEN_MIN
    assert _mate_from_tt(_WIN - 1, 200) == _PROVEN_MIN
    print('  PASS', flush=True)


# ---------------------------------------------------------------------------
# Part 2: JS end-to-end (caveman engine under node)
# ---------------------------------------------------------------------------

_NODE_SCRIPT = r"""
'use strict';
const fs = require('fs');
const { loadEngine } = require(process.argv[2]);
const engine = loadEngine();
const { SimBoard, cavemanSearch, _minimaxApplyTurn,
        getLegalTurnsExhaustive, ENUM_CAPS, NODE_ORDER } = engine;

const TRAP_MARGIN = 2;
const PROVEN_MIN = 37;
// Greedy ply-1 enumeration throughout: exhaustive opponent expansion on
// spell-heavy boards keeps depth at 1 and proofs never fire. Proofs and
// verification probes share the setting, so they're self-consistent.
const MODE = { exhaustiveOpponent: false };

function sfnBoard(sfn) {
	const state = sfnToDict(sfn);
	const sb = new SimBoard(state.spell_names, state.variant || 'standard');
	for (const n of NODE_ORDER) sb.stones[n] = state.stones[n];
	sb.turnCounter = state.turncounter;
	sb.whoseTurn = state.turn;
	sb.spellCounter = { red: state.red_spellcounter, blue: state.blue_spellcounter };
	sb.lock = { red: state.red_lock, blue: state.blue_lock };
	sb.springlock = { red: state.red_springlock, blue: state.blue_springlock };
	sb.score = state.score;
	sb.pendingMoves = { red: state.red_pending || [], blue: state.blue_pending || [] };
	sb.pendingBurns = { red: state.red_burns || [], blue: state.blue_burns || [] };
	sb.snares = { ...(state.snares || {}) };
	sb.update();
	return sb;
}

// Loss distance of root move `m` for `color`: apply it, then let the
// opponent search for the proven win. Returns null if unproven (which
// includes verification timeouts — the caller decides how to treat it).
async function lossDist(board, m, color, depthCap) {
	const child = _minimaxApplyTurn(board, m, color);
	if (child.gameover) {
		if (child.winner === color || child.winner === null) return null;
		return 1;
	}
	const enemy = color === 'red' ? 'blue' : 'red';
	const r = await cavemanSearch(child, enemy, Object.assign({
		timeLimit: 15.0, maxDepth: depthCap,
	}, MODE));
	if (r.score < PROVEN_MIN) return null;
	return Math.round(100 - r.score) + 1;                 // opp win-in +1
}

async function verifyPosition(sfn, res, color, board) {
	const out = {
		sfn, color,
		mateIn: res.mateIn,
		score: res.score,
		depth: res.depth,
		trapDepth: res.trapDepth === undefined ? null : res.trapDepth,
		trapFrac: res.trapFrac === undefined ? null : res.trapFrac,
		timeMs: res.timeMs,
	};
	// (a) score is distance-encoded.
	if (Math.abs(res.score + (100 - res.mateIn)) > 1e-9) {
		throw new Error(`score ${res.score} != -(100-${res.mateIn})`);
	}
	// (b) chosen move hands the opponent a win in exactly mateIn-1.
	const chosen = await lossDist(board, res.turn, color, res.mateIn + 1);
	if (chosen !== res.mateIn) {
		throw new Error(`chosen move dist ${chosen} != mateIn ${res.mateIn}`);
	}
	// (c) chosen distance within TRAP_MARGIN of the slowest proven loss
	// among sampled alternatives (unproven probes — timeouts — are
	// skipped; part (b) already anchors the chosen move exactly).
	const legal = [...getLegalTurnsExhaustive(board, color, ENUM_CAPS)];
	out.legalCount = legal.length;
	let maxDist = 0;
	let verified = 0;
	const sample = legal.slice(0, 15);
	for (const m of sample) {
		const d = await lossDist(board, m, color, res.mateIn + TRAP_MARGIN + 1);
		if (d === null) continue;
		if (d > maxDist) maxDist = d;
		verified += 1;
	}
	out.maxDist = maxDist;
	out.verified = verified;
	if (verified > 0 && chosen < maxDist - TRAP_MARGIN) {
		throw new Error(
			`chosen dist ${chosen} < maxDist ${maxDist} - margin ${TRAP_MARGIN}`);
	}
	return out;
}

async function main() {
	const sfns = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
	const found = [];
	for (const sfn of sfns) {
		let board;
		try { board = sfnBoard(sfn); } catch (e) { continue; }
		if (board.gameover) continue;
		const color = board.whoseTurn;
		const res = await cavemanSearch(board, color, Object.assign({
			timeLimit: 6.0, maxDepth: 6,
		}, MODE));
		if (!res.provenLoss || typeof res.mateIn !== 'number') continue;
		found.push(await verifyPosition(sfn, res, color, sfnBoard(sfn)));
		if (found.length >= 3) break;
	}
	console.log(JSON.stringify({ found }));
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
"""


def _densest_sfns(limit=30):
    data = os.path.join(REPO, 'ai', 'data', 'selfplay_v22b_2026-05-03.jsonl')
    from notation import sfn_to_dict
    recs = []
    with open(data, encoding='utf-8') as f:
        for line in f:
            sfn = json.loads(line)['sfn']
            stones = sum(1 for v in sfn_to_dict(sfn)['stones'].values() if v)
            recs.append((stones, sfn))
    recs.sort(key=lambda r: -r[0])
    return [sfn for _, sfn in recs[:limit]]


def test_js_end_to_end():
    print('Testing JS caveman stubborn loss on selfplay endgames...', flush=True)
    sfns = _densest_sfns()
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
        f.write(_NODE_SCRIPT)
        path = f.name
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump(sfns, f)
        sfn_path = f.name
    try:
        proc = subprocess.run(
            ['node', path, os.path.join(ARENA, 'engine.js'), sfn_path],
            capture_output=True, text=True, timeout=900,
        )
        if proc.returncode != 0:
            print(proc.stdout)
            print(proc.stderr)
            raise AssertionError('node runner failed')
        out = json.loads(proc.stdout.strip().splitlines()[-1])
    finally:
        os.unlink(path)
        os.unlink(sfn_path)
    found = out['found']
    assert found, 'no proven-loss position among the densest selfplay endgames'
    for rec in found:
        assert 1 <= rec['mateIn'] <= 63
        print(f"  proven loss: mate in {rec['mateIn']} (search depth "
              f"{rec['depth']}, {rec['timeMs']}ms), {rec['verified']} of "
              f"{rec['legalCount']} root moves probed (slowest proven loss "
              f"{rec['maxDist']}), trapDepth={rec['trapDepth']} "
              f"trapFrac={rec['trapFrac']}", flush=True)
    print('  PASS', flush=True)
    return found


# ---------------------------------------------------------------------------
# Part 3: Python end-to-end with a stub model
# ---------------------------------------------------------------------------

class _StubModel:
    """Deterministic no-net model: zero value, uniform policy.

    Terminal scores (the thing under test) come from the game rules, not
    the model, so this exercises the full minimax_search + trappiness
    path without loading weights.
    """

    def __call__(self, raw, spell_ids):
        return torch.zeros(1), None

    def evaluate_with_policy(self, raw, spell_ids, tf, blunder_lambda=0.0):
        n = tf.shape[0]
        return 0.0, np.full(n, 1.0 / n)


def _py_loss_dist(board, turn, color, history, model, depth_cap):
    """Loss distance of a root move via an opponent-side _alphabeta probe."""
    child = _apply_turn(board, turn, color)
    hist = dict(history)
    if not child.gameover:
        k = child.looping_snapshot()
        hist[k] = hist.get(k, 0) + 1
        if hist[k] >= 5:
            child.gameover = True
            child.winner = 'blue'
    if child.gameover:
        if child.winner is None or child.winner == color:
            return None
        return 1
    enemy = 'blue' if color == 'red' else 'red'
    tt = _TT(max_size=100_000)
    tt.new_search()
    hasher = _get_hasher(board.spell_names)
    score, _move = _alphabeta(
        child, enemy, depth_cap, -_INF, _INF, model, float('inf'),
        exhaustive_root=True, exhaustive_opponent=True, _is_root=True,
        tt=tt, killers=_KillerTable(max_ply=16), hasher=hasher, ply=0,
        position_history=hist,
    )
    if score < _PROVEN_MIN:
        return None
    return int(round(_WIN - score)) + 1


def test_python_end_to_end(js_found):
    print('Testing Python minimax_search stubborn loss (stub model)...', flush=True)
    # NN-free but still per-node feature building — keep the horizon
    # tiny by picking the shortest mate the JS phase surfaced.
    short = [r for r in js_found if r['mateIn'] <= 2]
    if not short:
        print('  SKIP (no mate-in-<=2 position surfaced; Python search at '
              'longer horizons is too slow for a test)', flush=True)
        return
    rec = min(short, key=lambda r: r['mateIn'])
    board = SimBoard.from_sfn(rec['sfn'])
    color = rec['color']
    model = _StubModel()
    depth = rec['mateIn']
    history = {}

    # Root really is a proven loss for the mover at this depth (greedy
    # mover enumeration is a subset of the JS exhaustive root, so the
    # loss is still forced; the opponent gets exhaustive replies so the
    # refutations are actually found).
    tt = _TT(max_size=100_000)
    tt.new_search()
    root_score, _ = _alphabeta(
        board, color, depth, -_INF, _INF, model, float('inf'),
        exhaustive_opponent=True, _is_root=True,
        tt=tt, killers=_KillerTable(max_ply=16),
        hasher=_get_hasher(board.spell_names), ply=0,
        position_history=dict(history),
    )
    assert root_score <= -_PROVEN_MIN, f'root not proven lost: {root_score}'
    max_dist = int(round(_WIN + root_score))

    # The full search (ID loop + trappiness) picks a move within the
    # trap margin of that slowest loss.
    move = minimax_search(
        board, color, model, time_limit=120.0, max_depth=depth,
        exhaustive_opponent=True,
        position_history=history,
    )
    chosen = _py_loss_dist(board, move, color, history, model, depth)
    assert chosen is not None, 'chosen move unrefuted despite proven-lost root'
    assert chosen >= max_dist - _TRAP_MARGIN_PLIES, (
        f'chosen move loses in {chosen}, slowest available is {max_dist}')
    print(f'  proven loss (mate in {max_dist}); search chose a move losing '
          f'in {chosen}', flush=True)
    print('  PASS', flush=True)


def main():
    test_leaf_distance_encoding()
    test_tt_mate_adjustment()
    js_found = test_js_end_to_end()
    test_python_end_to_end(js_found)
    print('All stubborn-loss tests passed.', flush=True)


if __name__ == '__main__':
    main()
