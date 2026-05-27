'use strict';
/**
 * Drive one full headless Caveman-vs-Caveman game.
 *
 * Mirrors the live game-controller loop (docs/.../game-controller.js
 * _runGameLoop) but without any DOM/event plumbing:
 *   - standard variant opening: red on a1, blue on b1
 *   - per-turn threefold-repetition tracking (5x same snapshot => blue wins)
 *   - Inferno charged at a player's turn start => that player loses
 *   - move application + game-over check via the engine's own
 *     `_minimaxApplyTurn` (the same primitive the search uses), which also
 *     advances the turn — so it is the single source of turn advancement.
 *
 * Per-move search stats (depth/nodes/cutoffs/time) are accumulated per color.
 * `cutoffs` is the direct evidence of pruning: ~0 for pure_minimax, large
 * for pruned_minimax.
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

		// Threefold-repetition snapshot, taken at the start of the turn.
		const snap = board.loopingSnapshot();
		loopCounts[snap] = (loopCounts[snap] || 0) + 1;
		if (loopCounts[snap] >= 5) {
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
		// so it is the sole turn-advancement authority here.
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
