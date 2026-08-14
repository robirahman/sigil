/**
 * Web worker that runs cavemanSearch off the main thread, so a 60s Very Hard
 * AI search or a deep game review doesn't trigger Chrome's "page unresponsive"
 * prompt.
 *
 * Message protocol:
 *   in:  { type: 'search', id, sfn, color, opts }
 *        { type: 'cancel', id }  — abort the in-flight search with this id
 *   out: { type: 'progress', id, depth, score, timeMs, nodes, ttSize }
 *        { type: 'result',   id, turn, score, depth, timeMs, nodes, ttSize, cutoffs }
 *        { type: 'error',    id, message }
 *
 * `opts.useSharedTt: true` reuses the worker's persistent MinimaxTT across
 * calls (game-review primes the table once then walks plies in reverse;
 * pondering also accumulates entries that the AI's real search reuses).
 * `opts.resetSharedTt: true` clears it first.
 *
 * `opts.timeLimit: Infinity` marks a ponder search — runs until a
 * `cancel` message flips the abort flag or the soft `maxDepth` cap is hit.
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

/** Rebuild a SimBoard from the SFN string the main thread sent over.
 * `extraMoves`/`burnsNow`: Providence extras / Aftershock burns already
 * granted for the current turn — the SFN carries only the future schedules
 * (pm:/ab: tokens); the popped counters travel via opts. */
function _sfnToSimBoard(sfn, extraMoves, burnsNow) {
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
	sb.extraMovesThisTurn = extraMoves || 0;
	sb.pendingBurns = { red: state.red_burns || [], blue: state.blue_burns || [] };
	sb.burnsThisTurn = burnsNow || 0;
	sb.snares = { ...(state.snares || {}) };
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
			converted: a.converted,
			wall: a.wall,
			pushes: a.pushes,
			turns: a.turns,
			nodes: a.nodes,
			target: a.target,
			val: a.val,
			val2: a.val2,
			placed: a.placed,
		})),
	};
}

// Track in-flight searches so a `cancel` message can flip the right
// abort flag. cavemanSearch yields between iterative-deepening depths;
// the cancel handler runs in the gap and signals the search to break.
const _activeSearches = new Map();  // id -> { abortFlag, isPonder }

// Serialize search messages: when a new 'search' arrives while one is
// already running, wait for the previous to complete (post-cancel or
// otherwise) so the shared TT and worker don't run two cavemanSearch
// flows concurrently.
let _searchTail = Promise.resolve();

self.onmessage = (e) => {
	const msg = e.data || {};
	if (msg.type === 'cancel') {
		const entry = _activeSearches.get(msg.id);
		if (entry) entry.abortFlag.aborted = true;
		return;
	}
	if (msg.type !== 'search') return;
	// Auto-cancel any in-flight ponder-style search so the new
	// (real) search doesn't queue behind a never-ending one. Ponder
	// uses timeLimit=Infinity; regular searches have a finite budget.
	for (const entry of _activeSearches.values()) {
		if (entry.isPonder) entry.abortFlag.aborted = true;
	}
	_searchTail = _searchTail.then(() => _runSearch(msg));
};

async function _runSearch(msg) {
	const { id, sfn, color, opts = {} } = msg;
	const abortFlag = { aborted: false };
	// A ponder is any unbounded-time search — depth may be capped as a
	// safety net but timeLimit=Infinity is the defining signal.
	const isPonder = opts.timeLimit === Infinity;
	_activeSearches.set(id, { abortFlag, isPonder });

	try {
		if (opts.resetSharedTt) {
			_sharedTt = null;
		}
		const tt = opts.useSharedTt ? _ensureSharedTt() : new MinimaxTT(_CAVEMAN_TT_MAX);

		const sim = _sfnToSimBoard(sfn, opts.extraMoves, opts.burnsNow);

		const searchOpts = {
			timeLimit: opts.timeLimit,
			maxDepth: opts.maxDepth,
			exhaustiveRoot: opts.exhaustiveRoot,
			exhaustiveOpponent: opts.exhaustiveOpponent,
			positionHistory: opts.positionHistory || null,
			// Positional eval weights (caveman-ai.js CAVEMAN_EVAL_WEIGHTS
			// defaults when undefined). CAUTION: TT entries embed eval
			// scores — any caller passing evalWeights together with
			// useSharedTt must also pass resetSharedTt when the weights
			// change, or the shared TT serves mixed-weight scores.
			evalWeights: opts.evalWeights,
			orderMapControl: opts.orderMapControl,
			tt,
			abortFlag,
			onDepthComplete: (info) => {
				self.postMessage({ type: 'progress', id, ...info });
			},
		};

		const result = await cavemanSearch(sim, color, searchOpts);

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
			aborted: !!abortFlag.aborted,
		});
	} catch (err) {
		self.postMessage({
			type: 'error',
			id,
			message: err && err.message ? err.message : String(err),
		});
	} finally {
		_activeSearches.delete(id);
	}
}
