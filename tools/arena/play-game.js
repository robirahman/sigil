'use strict';
/**
 * Drive one full headless AI-vs-AI game.
 *
 * Mirrors the live game-controller loop (docs/.../game-controller.js) without
 * any DOM/event plumbing:
 *   - standard variant opening: red on a1, blue on b1
 *   - per-turn repetition tracking (3rd occurrence of a snapshot => blue wins)
 *   - Inferno charged at a player's turn start => that player loses
 *   - move application + game-over check via the engine's own
 *     `_minimaxApplyTurn` (the same primitive the search uses), which also
 *     advances the turn — the single source of turn advancement.
 *
 * Per-move stats (depth/nodes/cutoffs/time) accumulate per color. `cutoffs` is
 * direct evidence of pruning: ~0 with `:pure`, large otherwise.
 */

const { specToOpts } = require('./engine.js');

async function playGame(engine, spec) {
	const { SimBoard, cavemanSearch, _minimaxApplyTurn, ENUM_CAPS } = engine;
	const { spellNames, redCfg, blueCfg, timeLimit, maxDepth, maxTurns } = spec;
	const redMode = redCfg.label, blueMode = blueCfg.label;

	const budget = { timeLimit, maxDepth };
	const optsByColor = {
		red: specToOpts(redCfg, budget, ENUM_CAPS),
		blue: specToOpts(blueCfg, budget, ENUM_CAPS),
	};

	// Standard opening.
	let board = new SimBoard(spellNames, 'standard');
	board.stones.a1 = 'red';
	board.stones.b1 = 'blue';
	board.update();

	const loopCounts = {};
	const stats = {
		red: { moves: 0, nodes: 0, cutoffs: 0, depthSum: 0, maxDepth: 0, timeMs: 0 },
		blue: { moves: 0, nodes: 0, cutoffs: 0, depthSum: 0, maxDepth: 0, timeMs: 0 },
	};
	const t0 = Date.now();
	let plies = 0;
	let endReason = 'normal';

	while (!board.gameover && plies < maxTurns) {
		const color = board.whoseTurn;

		// Repetition snapshot, taken at the start of the turn (3rd occurrence
		// ends the game — matches game-controller's threefold rule).
		const snap = board.loopingSnapshot();
		loopCounts[snap] = (loopCounts[snap] || 0) + 1;
		if (loopCounts[snap] >= 3) {
			board.gameover = true;
			board.winner = 'blue';
			endReason = 'repetition';
			break;
		}

		// Inferno self-destruct trigger (charged at own turn start).
		if (board.chargedSpells[color] && board.chargedSpells[color].includes('Inferno')) {
			board.gameover = true;
			board.winner = color === 'red' ? 'blue' : 'red';
			endReason = 'inferno';
			break;
		}

		const res = await cavemanSearch(board, color,
			Object.assign({ positionHistory: loopCounts }, optsByColor[color]));

		const s = stats[color];
		s.moves += 1;
		s.nodes += res.nodes || 0;
		s.cutoffs += res.cutoffs || 0;
		s.depthSum += res.depth || 0;
		s.maxDepth = Math.max(s.maxDepth, res.depth || 0);
		s.timeMs += res.timeMs || 0;

		// Apply the chosen turn. `_minimaxApplyTurn` runs update(),
		// checkGameOver(color), then advanceTurn() if the game continues —
		// the sole turn-advancement authority here.
		board = _minimaxApplyTurn(board, res.turn, color);
		plies += 1;
	}

	if (!board.gameover && plies >= maxTurns) endReason = 'turn_cap';

	return {
		gameId: spec.gameId,
		redMode, blueMode,
		winner: board.gameover ? board.winner : null,
		plies,
		endReason,
		finalStones: { red: board.totalStones.red, blue: board.totalStones.blue },
		durationMs: Date.now() - t0,
		stats,
		spellNames,
	};
}

module.exports = { playGame };
