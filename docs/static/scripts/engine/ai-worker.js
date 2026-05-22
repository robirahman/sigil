/**
 * Web worker that runs cavemanSearch off the main thread, so a 60s Very Hard
 * AI search or a deep game review doesn't trigger Chrome's "page unresponsive"
 * prompt.
 *
 * Message protocol:
 *   in:  { type: 'search', id, sfn, color, opts }
 *   out: { type: 'progress', id, depth, score, timeMs, nodes, ttSize }
 *        { type: 'result',   id, turn, score, depth, timeMs, nodes, ttSize, cutoffs }
 *        { type: 'error',    id, message }
 *
 * `opts.useSharedTt: true` reuses the worker's persistent MinimaxTT across
 * calls (game-review primes the table once then walks plies in reverse).
 * `opts.resetSharedTt: true` clears it first.
 */

// Engine modules — load order mirrors game.html's script tags. None of these
// touch the DOM, so they run unchanged inside a Worker scope.
importScripts(
	'constants.js',
	'notation.js',
	'sim-board.js',
	'features.js',
	'sigil-net.js',
	'sigil-net-graph.js',
	'strategic-eval.js',
	'enumerator.js',
	'minimax-ai.js',
	'caveman-ai.js',
);

let _sharedTt = null;

function _ensureSharedTt() {
	if (!_sharedTt) {
		_sharedTt = new MinimaxTT(_CAVEMAN_TT_MAX);
		_sharedTt.nodes = 0;
	}
	return _sharedTt;
}

/** Rebuild a SimBoard from the SFN string the main thread sent over. */
function _sfnToSimBoard(sfn) {
	const state = sfnToDict(sfn);
	const sb = new SimBoard(state.spell_names, state.variant || 'standard');
	for (const n of NODE_ORDER) sb.stones[n] = state.stones[n];
	sb.turnCounter = state.turncounter;
	sb.whoseTurn = state.turn;
	sb.spellCounter = { red: state.red_spellcounter, blue: state.blue_spellcounter };
	sb.lock = { red: state.red_lock, blue: state.blue_lock };
	sb.springlock = { red: state.red_springlock, blue: state.blue_springlock };
	sb.score = state.score;
	sb.update();
	return sb;
}

/** structured-clone-safe representation of a SimTurn. */
function _serializeTurn(turn) {
	if (!turn) return null;
	return {
		actions: (turn.actions || []).map((a) => ({
			type: a.type,
			node: a.node,
			pushed_to: a.pushed_to,
			spell: a.spell,
			sacrificed: a.sacrificed,
			kept: a.kept,
			node2: a.node2,
			destroyed: a.destroyed,
		})),
	};
}

self.onmessage = (e) => {
	const msg = e.data || {};
	if (msg.type !== 'search') return;
	const { id, sfn, color, opts = {} } = msg;

	try {
		if (opts.resetSharedTt) {
			_sharedTt = null;
		}
		const tt = opts.useSharedTt ? _ensureSharedTt() : new MinimaxTT(_CAVEMAN_TT_MAX);

		const sim = _sfnToSimBoard(sfn);

		const searchOpts = {
			timeLimit: opts.timeLimit,
			maxDepth: opts.maxDepth,
			exhaustiveRoot: opts.exhaustiveRoot,
			exhaustiveOpponent: opts.exhaustiveOpponent,
			positionHistory: opts.positionHistory || null,
			tt,
			onDepthComplete: (info) => {
				self.postMessage({ type: 'progress', id, ...info });
			},
		};

		const result = cavemanSearch(sim, color, searchOpts);

		self.postMessage({
			type: 'result',
			id,
			turn: _serializeTurn(result.turn),
			score: result.score,
			depth: result.depth,
			timeMs: result.timeMs,
			nodes: result.nodes,
			ttSize: result.ttSize,
			cutoffs: result.cutoffs,
		});
	} catch (err) {
		self.postMessage({
			type: 'error',
			id,
			message: err && err.message ? err.message : String(err),
		});
	}
};
