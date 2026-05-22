/**
 * Browser-side Caveman AI — pure stone-count minimax.
 *
 * Iterative-deepening alpha-beta with stone-differential at the leaves.
 * No neural net, no policy, no model file to load. Useful as a baseline
 * opponent: any human who struggles against this is losing on raw board
 * geometry, not on any strategic subtlety a network would surface.
 *
 * Shares MinimaxTimeout / MinimaxTT / MinimaxKillerTable / _orderWithHints
 * / _minimaxApplyTurn / _minimaxPosHash from minimax-ai.js — they're
 * pure scaffolding and the Caveman's only deviation is the leaf
 * evaluator (stone diff instead of network forward) and move-ordering
 * pass (1-ply stone-diff sort instead of policy + strategic score).
 */

const CAVEMAN_INF = 1e9;
const CAVEMAN_WIN = 100.0;
const _CAVEMAN_TT_MAX = 200000;
const _CAVEMAN_MAX_PLY = 12;

function _cavemanLeaf(board, color) {
	if (board.gameover) {
		if (board.winner === color) return CAVEMAN_WIN;
		if (board.winner === null) return 0.0;
		return -CAVEMAN_WIN;
	}
	const enemy = color === 'red' ? 'blue' : 'red';
	const diff = board.totalStones[color] - board.totalStones[enemy];
	return diff / 39.0;
}

function _cavemanOrderedTurns(board, color, exhaustiveCaps) {
	// When `exhaustiveCaps` is set, expand every spell variant
	// (Bewitch pair, Carnage target, Meteor/Comet blink target, dash
	// sacrifice combo, …) via getLegalTurnsExhaustive. Without it,
	// the engine's greedy enumerator collapses each spell to one
	// variant and Caveman silently misses spells with better targets.
	let turns;
	if (exhaustiveCaps && typeof getLegalTurnsExhaustive === 'function') {
		turns = [...getLegalTurnsExhaustive(board, color, exhaustiveCaps)];
	} else {
		turns = [...board.getLegalTurns(color)];
	}
	if (turns.length <= 1) return turns;
	const enemy = color === 'red' ? 'blue' : 'red';
	const scored = [];
	for (let i = 0; i < turns.length; i++) {
		const sim = _minimaxApplyTurn(board, turns[i], color);
		const diff = sim.totalStones[color] - sim.totalStones[enemy];
		scored.push([diff, i]);
	}
	scored.sort((a, b) => b[0] - a[0]);
	return scored.map(s => turns[s[1]]);
}

function _cavemanAlphaBeta(board, color, depth, alpha, beta, deadline,
                           tt, killers, ply, positionHistory,
                           exhaustiveRoot, exhaustiveOpponent, isRoot) {
	if (tt) tt.nodes += 1;
	if (Date.now() > deadline) throw new MinimaxTimeout();
	if (board.gameover || depth === 0) {
		return { score: _cavemanLeaf(board, color), move: null };
	}

	const alphaOrig = alpha;
	let ttMove = null;
	let ttKey = null;
	if (tt) {
		ttKey = _minimaxPosHash(board, color);
		const entry = tt.get(ttKey);
		if (entry) {
			ttMove = entry.bestMove;
			if (entry.depth >= depth) {
				if (entry.bound === _BOUND_EXACT) {
					tt.cutoffs += 1;
					return { score: entry.score, move: entry.bestMove };
				}
				if (entry.bound === _BOUND_LOWER) {
					if (entry.score > alpha) alpha = entry.score;
				} else if (entry.bound === _BOUND_UPPER) {
					if (entry.score < beta) beta = entry.score;
				}
				if (alpha >= beta) {
					tt.cutoffs += 1;
					return { score: entry.score, move: entry.bestMove };
				}
			}
		}
	}

	let caps = null;
	if ((exhaustiveRoot && isRoot) || (exhaustiveOpponent && ply === 1)) {
		caps = (typeof ENUM_CAPS !== 'undefined') ? ENUM_CAPS : null;
	}
	const turns = _cavemanOrderedTurns(board, color, caps);
	if (turns.length === 0) {
		return { score: _cavemanLeaf(board, color), move: null };
	}
	const killerMoves = killers ? killers.get(ply) : [];
	const ordered = (ttMove !== null || killerMoves.length > 0)
		? _orderWithHints(turns, ttMove, killerMoves)
		: turns;

	let bestScore = -CAVEMAN_INF;
	let bestMove = ordered[0];
	let cutoff = false;
	const enemy = color === 'red' ? 'blue' : 'red';
	for (const turn of ordered) {
		const sim = _minimaxApplyTurn(board, turn, color);
		let repSnap = null;
		if (positionHistory && !sim.gameover) {
			repSnap = sim.loopingSnapshot();
			const newCount = (positionHistory[repSnap] || 0) + 1;
			positionHistory[repSnap] = newCount;
			if (newCount >= 5) {
				sim.gameover = true;
				sim.winner = 'blue';
			}
		}
		try {
			if (sim.gameover && sim.winner === color) {
				bestScore = CAVEMAN_WIN;
				bestMove = turn;
				cutoff = true;
				break;
			}
			const sub = _cavemanAlphaBeta(sim, enemy, depth - 1, -beta, -alpha,
			                              deadline, tt, killers, ply + 1,
			                              positionHistory,
			                              exhaustiveRoot, exhaustiveOpponent,
			                              false);
			const score = -sub.score;
			if (score > bestScore) { bestScore = score; bestMove = turn; }
			if (bestScore > alpha) alpha = bestScore;
			if (alpha >= beta) {
				if (killers) killers.add(ply, turn);
				cutoff = true;
				break;
			}
		} finally {
			if (repSnap !== null) {
				positionHistory[repSnap] -= 1;
				if (positionHistory[repSnap] <= 0) delete positionHistory[repSnap];
			}
		}
	}

	if (tt && ttKey !== null) {
		let bound;
		if (cutoff && bestScore >= beta) bound = _BOUND_LOWER;
		else if (bestScore <= alphaOrig) bound = _BOUND_UPPER;
		else bound = _BOUND_EXACT;
		tt.store(ttKey, depth, bestScore, bound, bestMove);
	}
	return { score: bestScore, move: bestMove };
}

/**
 * Iterative-deepening pure stone-count minimax.
 *
 * @param {SimBoard} board
 * @param {string} color
 * @param {{timeLimit?: number, maxDepth?: number, verbose?: boolean,
 *          positionHistory?: object,
 *          onDepthComplete?: (info: {depth, score, timeMs, nodes, ttSize}) => void
 *         }} opts
 */
function cavemanSearch(board, color, opts) {
	opts = opts || {};
	const timeLimit = opts.timeLimit !== undefined ? opts.timeLimit : 60.0;
	const maxDepth = opts.maxDepth !== undefined ? opts.maxDepth : 6;
	const onDepthComplete = typeof opts.onDepthComplete === 'function'
		? opts.onDepthComplete : null;
	// Default to exhaustive enumeration at root + ply 1. Without it,
	// the engine's greedy enumerator silently collapses every spell
	// (Bewitch pair, Carnage target, dash sacrifice, …) to a single
	// variant and Caveman never sees the most damaging cast.
	const exhaustiveRoot = opts.exhaustiveRoot !== undefined
		? !!opts.exhaustiveRoot : true;
	const exhaustiveOpponent = opts.exhaustiveOpponent !== undefined
		? !!opts.exhaustiveOpponent : true;
	const verbose = !!opts.verbose;
	const abHistory = opts.positionHistory
		? Object.assign({}, opts.positionHistory)
		: null;

	const searchStart = Date.now();

	const legal = (exhaustiveRoot && typeof getLegalTurnsExhaustive === 'function')
		? [...getLegalTurnsExhaustive(board, color, ENUM_CAPS)]
		: [...board.getLegalTurns(color)];
	if (legal.length === 0) {
		return {
			turn: new SimTurn([new SimAction('pass')]),
			score: 0, depth: 0, timeMs: Date.now() - searchStart,
			nodes: 0, ttSize: 0, cutoffs: 0,
		};
	}

	// Mate-in-1 short-circuit.
	for (const turn of legal) {
		const sim = _minimaxApplyTurn(board, turn, color);
		if (abHistory && !sim.gameover) {
			const k = sim.loopingSnapshot();
			if ((abHistory[k] || 0) + 1 >= 5) {
				sim.gameover = true;
				sim.winner = 'blue';
			}
		}
		if (sim.gameover && sim.winner === color) {
			return {
				turn, score: CAVEMAN_WIN, depth: 1,
				timeMs: Date.now() - searchStart,
				nodes: 0, ttSize: 0, cutoffs: 0,
			};
		}
	}

	// Reusing a shared TT across calls (e.g. game-review) lets later
	// positions prime alpha-beta cutoffs at earlier ones.
	const tt = opts.tt || new MinimaxTT(_CAVEMAN_TT_MAX);
	tt.newSearch();
	if (typeof tt.nodes !== 'number') tt.nodes = 0;
	const killers = new MinimaxKillerTable(_CAVEMAN_MAX_PLY);

	const deadline = Date.now() + timeLimit * 1000;
	let bestMove = legal[0];
	let bestScore = 0;
	let completedDepth = 0;
	for (let depth = 1; depth <= maxDepth; depth++) {
		const t0 = Date.now();
		try {
			const r = _cavemanAlphaBeta(board, color, depth,
			                            -CAVEMAN_INF, CAVEMAN_INF, deadline,
			                            tt, killers, 0, abHistory,
			                            exhaustiveRoot, exhaustiveOpponent, true);
			if (r.move) {
				bestMove = r.move;
				bestScore = r.score;
				completedDepth = depth;
				if (verbose) {
					console.log(`caveman: depth=${depth} done in `
					            + `${((Date.now()-t0)/1000).toFixed(2)}s `
					            + `score=${r.score.toFixed(3)} `
					            + `tt=${tt.size} cuts=${tt.cutoffs}`);
				}
				if (onDepthComplete) {
					try {
						onDepthComplete({
							depth,
							score: r.score,
							timeMs: Date.now() - searchStart,
							nodes: tt.nodes,
							ttSize: tt.size,
						});
					} catch (e) { /* progress hook errors are non-fatal */ }
				}
			}
			if (Math.abs(r.score) >= CAVEMAN_WIN - 1) break;
		} catch (e) {
			if (e instanceof MinimaxTimeout) {
				if (verbose) console.log(`caveman: timed out at depth=${depth}, using depth-${completedDepth}`);
				break;
			}
			throw e;
		}
	}
	return {
		turn: bestMove,
		score: bestScore,
		depth: completedDepth,
		timeMs: Date.now() - searchStart,
		nodes: tt.nodes,
		ttSize: tt.size,
		cutoffs: tt.cutoffs,
	};
}

/**
 * AI player wrapper. Doesn't need a model file — picks its move purely
 * from the simboard state.
 */
/**
 * Path to the Web Worker script. Resolved relative to whichever page is
 * loading caveman-ai.js (game.html lives at the docs/ root; the worker sits
 * under static/scripts/engine/). Overridable via `window.AI_WORKER_URL` for
 * tests / alternate hosting.
 */
const AI_WORKER_URL =
	(typeof window !== 'undefined' && window.AI_WORKER_URL) ||
	'static/scripts/engine/ai-worker.js';

/**
 * Manages a persistent Web Worker and routes search requests through it.
 * Each call gets a unique id so progress / result messages route back to
 * the right caller. Fails gracefully (sync fallback) if Worker isn't
 * available (e.g. file:// in some browsers).
 */
class AiSearchWorker {
	constructor(url) {
		this.url = url || AI_WORKER_URL;
		this._worker = null;
		this._nextId = 1;
		this._pending = new Map();  // id -> {resolve, reject, onProgress}
	}

	_ensureWorker() {
		if (this._worker) return this._worker;
		if (typeof Worker === 'undefined') return null;
		try {
			this._worker = new Worker(this.url);
			this._worker.onmessage = (e) => this._onMessage(e.data);
			this._worker.onerror = (e) => this._onWorkerError(e);
		} catch (err) {
			console.warn('AI worker failed to start, falling back to main-thread search:', err);
			this._worker = null;
		}
		return this._worker;
	}

	_onMessage(msg) {
		if (!msg || !msg.id) return;
		const entry = this._pending.get(msg.id);
		if (!entry) return;
		if (msg.type === 'progress') {
			if (entry.onProgress) {
				try { entry.onProgress(msg); } catch (e) { /* non-fatal */ }
			}
		} else if (msg.type === 'result') {
			this._pending.delete(msg.id);
			entry.resolve(msg);
		} else if (msg.type === 'error') {
			this._pending.delete(msg.id);
			entry.reject(new Error(msg.message || 'AI worker error'));
		}
	}

	_onWorkerError(err) {
		// Reject all pending calls and tear down so the next call rebuilds
		// the worker fresh.
		for (const [, entry] of this._pending) {
			entry.reject(new Error('AI worker crashed: ' + (err.message || err)));
		}
		this._pending.clear();
		try { this._worker && this._worker.terminate(); } catch (_) {}
		this._worker = null;
	}

	search(sfn, color, opts, onProgress) {
		const w = this._ensureWorker();
		if (!w) return null;  // signal sync fallback
		const id = this._nextId++;
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject, onProgress });
			w.postMessage({ type: 'search', id, sfn, color, opts });
		});
	}

	terminate() {
		if (this._worker) {
			try { this._worker.terminate(); } catch (_) {}
			this._worker = null;
		}
		this._pending.clear();
	}
}

// Module-level singleton: one worker covers in-game AI moves AND game
// review, so the review's reverse-walk reuses the same TT across plies
// (via `useSharedTt: true`) without rebuilding.
let _sharedAiWorker = null;
function getSharedAiWorker() {
	if (!_sharedAiWorker) _sharedAiWorker = new AiSearchWorker();
	return _sharedAiWorker;
}

class CavemanAI {
	constructor(options) {
		this.options = Object.assign(
			{ maxDepth: 6, timeLimit: 60.0 },
			options || {},
		);
	}

	/**
	 * Returns a Promise that resolves to the chosen SimTurn. Runs the
	 * search in a Web Worker so the page stays responsive during multi-
	 * second Very Hard searches. Falls back to a synchronous main-thread
	 * search if Web Workers are unavailable.
	 *
	 * @param {object} board - live engine board
	 * @param {string} color
	 * @param {(info) => void} [onProgress] - per-depth progress hook
	 */
	async pickTurn(board, color, onProgress) {
		const sfn = boardToSfn(board);
		const positionHistory = board.allLoopingSnapshotCounts || {};
		const opts = Object.assign(
			{ positionHistory },
			this.options,
		);

		const worker = getSharedAiWorker();
		const promise = worker.search(sfn, color, opts, onProgress);
		if (promise) {
			try {
				const msg = await promise;
				this.lastMeta = {
					timeMs: msg.timeMs,
					depth: msg.depth,
					nodes: msg.nodes,
					score: msg.score,
					ttSize: msg.ttSize,
					cutoffs: msg.cutoffs,
				};
				return _reviveTurn(msg.turn);
			} catch (e) {
				console.warn('AI worker search failed, falling back to main thread:', e);
				// fall through to sync path
			}
		}

		// Sync fallback (worker unavailable or crashed).
		const simBoard = SimBoard.fromSigilBoard(board);
		const result = cavemanSearch(simBoard, color, Object.assign({}, opts, {
			onDepthComplete: onProgress,
		}));
		this.lastMeta = {
			timeMs: result.timeMs,
			depth: result.depth,
			nodes: result.nodes,
			score: result.score,
			ttSize: result.ttSize,
			cutoffs: result.cutoffs,
		};
		return result.turn;
	}
}

/** Rebuild a SimTurn (class instance) from the worker's serialized payload. */
function _reviveTurn(turnPayload) {
	if (!turnPayload || !turnPayload.actions) return new SimTurn([new SimAction('pass')]);
	const actions = turnPayload.actions.map((a) => {
		const sa = new SimAction(a.type);
		if (a.node !== undefined) sa.node = a.node;
		if (a.pushed_to !== undefined) sa.pushed_to = a.pushed_to;
		if (a.spell !== undefined) sa.spell = a.spell;
		if (a.sacrificed !== undefined) sa.sacrificed = a.sacrificed;
		if (a.kept !== undefined) sa.kept = a.kept;
		if (a.node2 !== undefined) sa.node2 = a.node2;
		if (a.destroyed !== undefined) sa.destroyed = a.destroyed;
		return sa;
	});
	return new SimTurn(actions);
}
