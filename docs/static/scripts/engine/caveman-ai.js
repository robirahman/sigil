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
// Search is bounded by THINKING TIME, not depth — iterative deepening runs to
// the per-move deadline and returns the best move from the last completed
// depth. This ceiling only bounds recursion / killer-table size; it sits far
// above any depth reachable in a realistic time budget.
const _CAVEMAN_MAX_PLY = 64;

// Two enumeration presets, both built from ENUM_CAPS (loaded earlier in the
// bundle by enumerator.js):
//   * Caveman (default) — every cap pinned to Infinity AND `__full` set, so the
//     enumerator branches EVERY legal variant of every choice point, including
//     all sub-actions of multi-step spells (Carnage's 3 pushes, etc.). This is
//     the "search all possible moves" engine; no heuristic ever drops a move.
//   * Prune — every cap pinned to 1, so the enumerator expands only the single
//     top-RANKED variant of each choice point at every ply (heuristic pruning
//     for depth). Reachable via ?ai=prune and the arena.
// Alpha-beta cutoffs, the transposition table, killer moves, and move ordering
// are SOUND (they never change the minimax value at infinite compute), so both
// presets use them — they only make the search reach the same answer faster.
const _CAVEMAN_FULL_CAPS = (function () {
	if (typeof ENUM_CAPS === 'undefined') return null;
	const c = { __full: true };
	for (const k of Object.keys(ENUM_CAPS)) c[k] = Infinity;
	return c;
})();
const _CAVEMAN_NARROW_CAPS = (function () {
	if (typeof ENUM_CAPS === 'undefined') return null;
	const c = {};
	for (const k of Object.keys(ENUM_CAPS)) c[k] = 1;
	return c;
})();

// Move-ordering tiebreaker weight per prospective spell kill. Tiny
// compared to one stone (1.0), so prep deltas only change ordering
// when two turns have identical 1-ply stone-diff. 4 prep kills tie
// about half a stone — strictly sub-material.
const _FIREBLAST_ORDER_TIEBREAK = 0.5 / 39.0;
const _HAILSTORM_ORDER_TIEBREAK = 0.5 / 39.0;

/**
 * Integer count of enemy stones adjacent to any own stone — the exact
 * kill set Fireblast would destroy if cast right now (spells.js
 * doFireblast). Zero unless Fireblast is charged for `side`. Used as
 * a move-ordering tiebreaker; the leaf eval ignores it.
 */
function _fireblastPrepKills(board, side, enemyOfSide) {
	if (!board.chargedSpells || !board.chargedSpells[side]) return 0;
	if (!board.chargedSpells[side].includes('Fireblast')) return 0;
	let kills = 0;
	for (const n of NODE_ORDER) {
		if (board.stones[n] !== enemyOfSide) continue;
		for (const nb of (ADJACENCY[n] || [])) {
			if (board.stones[nb] === side) { kills++; break; }
		}
	}
	return kills;
}

/**
 * Integer count of spell positions 1–6 (the 3-node and 5-node slots
 * Hail Storm targets per spells.js doHailStorm) that hold at least
 * one enemy stone. Each such slot yields one kill on cast. Zero
 * unless Hail Storm is charged for `side`. Used as a move-ordering
 * tiebreaker; the leaf eval ignores it.
 */
function _hailStormPrepKills(board, side, enemyOfSide) {
	if (!board.chargedSpells || !board.chargedSpells[side]) return 0;
	if (!board.chargedSpells[side].includes('Hail_Storm')) return 0;
	let slots = 0;
	for (let i = 1; i <= 6; i++) {
		const nodes = POSITIONS[i];
		if (!nodes) continue;
		for (const n of nodes) {
			if (board.stones[n] === enemyOfSide) { slots++; break; }
		}
	}
	return slots;
}

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
	// Pre-turn prep counts — used as a delta baseline so the ordering
	// score reflects how much a turn *changes* prep, not the absolute
	// level. Cost on positions without either spell charged: two
	// Array.includes early-outs.
	const preF =
		_fireblastPrepKills(board, color, enemy)
		- _fireblastPrepKills(board, enemy, color);
	const preH =
		_hailStormPrepKills(board, color, enemy)
		- _hailStormPrepKills(board, enemy, color);
	const scored = [];
	for (let i = 0; i < turns.length; i++) {
		const sim = _minimaxApplyTurn(board, turns[i], color);
		const diff = sim.totalStones[color] - sim.totalStones[enemy];
		// Sub-stone tiebreakers: prefer turns that increase our prep
		// kill set or decrease the enemy's, breaking ties between
		// otherwise-equivalent 1-ply stone-diffs. Leaf eval is
		// untouched — this only reorders alpha-beta exploration.
		const postF =
			_fireblastPrepKills(sim, color, enemy)
			- _fireblastPrepKills(sim, enemy, color);
		const postH =
			_hailStormPrepKills(sim, color, enemy)
			- _hailStormPrepKills(sim, enemy, color);
		const score = diff
			+ _FIREBLAST_ORDER_TIEBREAK * (postF - preF)
			+ _HAILSTORM_ORDER_TIEBREAK * (postH - preH);
		scored.push([score, i]);
	}
	scored.sort((a, b) => b[0] - a[0]);
	return scored.map(s => turns[s[1]]);
}

function _cavemanAlphaBeta(board, color, depth, alpha, beta, deadline,
                           tt, killers, ply, positionHistory,
                           isRoot, abortFlag, usePruning, enumConfig) {
	if (tt) tt.nodes += 1;
	if (Date.now() > deadline) throw new MinimaxTimeout();
	// Cooperative abort: lets a ponder search exit mid-iteration when
	// the human plays, instead of running out the current depth (which
	// at mobile speeds can take 10s+). Piggybacks on the existing
	// MinimaxTimeout sentinel so the IDDFS loop catches it cleanly.
	if (abortFlag && abortFlag.aborted) throw new MinimaxTimeout();
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
				if (usePruning && alpha >= beta) {
					tt.cutoffs += 1;
					return { score: entry.score, move: entry.bestMove };
				}
			}
		}
	}

	// Exhaustive enumeration at EVERY ply (no greedy single-variant fallback).
	// The caps object decides breadth: __full (Caveman) → every variant;
	// narrow (Prune) → top-ranked only. enumConfig.enumCaps is resolved by
	// cavemanSearch from the preset / arena overrides.
	const caps = (enumConfig && enumConfig.enumCaps)
		|| _CAVEMAN_FULL_CAPS
		|| ((typeof ENUM_CAPS !== 'undefined') ? ENUM_CAPS : null);
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
			if (newCount >= 3) {
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
			                              false, abortFlag, usePruning, enumConfig);
			const score = -sub.score;
			if (score > bestScore) { bestScore = score; bestMove = turn; }
			if (bestScore > alpha) alpha = bestScore;
			if (usePruning && alpha >= beta) {
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
 * Async because pondering needs to yield between iterative-deepening
 * depths so the Worker's message queue can deliver a cancel signal
 * (see `opts.abortFlag`). The yield is a no-op cost on the main
 * thread / non-ponder paths.
 *
 * @param {SimBoard} board
 * @param {string} color
 * @param {{timeLimit?: number, maxDepth?: number, verbose?: boolean,
 *          positionHistory?: object,
 *          abortFlag?: {aborted: boolean},
 *          onDepthComplete?: (info: {depth, score, timeMs, nodes, ttSize}) => void
 *         }} opts
 */
async function cavemanSearch(board, color, opts) {
	opts = opts || {};
	const timeLimit = opts.timeLimit !== undefined ? opts.timeLimit : 60.0;
	const maxDepth = opts.maxDepth !== undefined ? opts.maxDepth : _CAVEMAN_MAX_PLY;
	const abortFlag = opts.abortFlag || null;
	const onDepthComplete = typeof opts.onDepthComplete === 'function'
		? opts.onDepthComplete : null;
	// Engine preset: 'caveman' (default) enumerates every legal turn at every
	// ply; 'prune' expands only the top-ranked variant of each choice point.
	// The arena may pass an explicit enumCaps to override either.
	const preset = opts.preset || 'caveman';
	const enumCaps = opts.enumCaps
		|| (preset === 'prune' ? _CAVEMAN_NARROW_CAPS : _CAVEMAN_FULL_CAPS)
		|| ((typeof ENUM_CAPS !== 'undefined') ? ENUM_CAPS : null);
	const enumConfig = { enumCaps };
	// Alpha-beta cutoffs are sound; on by default for both presets. The arena's
	// pure_minimax variant sets usePruning:false to disable cutoffs entirely.
	const usePruning = opts.usePruning !== undefined ? !!opts.usePruning : true;
	// Carnage refill/push planner — a Prune-only heuristic. Caveman explores
	// those choices by full enumeration instead, so it leaves the planner off.
	board._rankLaterPushes = (preset === 'prune')
		? (opts.rankLaterPushes !== undefined ? !!opts.rankLaterPushes : true)
		: false;
	board._refillHeuristic = (preset === 'prune')
		? (opts.refillHeuristic !== undefined ? opts.refillHeuristic : 'closest_enemy')
		: null;
	const verbose = !!opts.verbose;
	const abHistory = opts.positionHistory
		? Object.assign({}, opts.positionHistory)
		: null;

	const searchStart = Date.now();

	const legal = (typeof getLegalTurnsExhaustive === 'function')
		? [...getLegalTurnsExhaustive(board, color, enumCaps)]
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
			if ((abHistory[k] || 0) + 1 >= 3) {
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

	const deadline = timeLimit === Infinity
		? Infinity
		: Date.now() + timeLimit * 1000;
	let bestMove = legal[0];
	let bestScore = 0;
	let completedDepth = 0;
	for (let depth = 1; depth <= maxDepth; depth++) {
		if (abortFlag && abortFlag.aborted) {
			if (verbose) console.log(`caveman: aborted before depth=${depth}`);
			break;
		}
		// Yield to the event loop between depths so the Worker's message
		// queue (cancel signals) can be processed. Macrotask yield is
		// required — microtasks aren't sufficient because postMessage
		// dispatches are macrotasks.
		if (depth > 1) {
			await new Promise(r => setTimeout(r, 0));
			if (abortFlag && abortFlag.aborted) {
				if (verbose) console.log(`caveman: aborted before depth=${depth}`);
				break;
			}
		}
		const t0 = Date.now();
		try {
			const r = _cavemanAlphaBeta(board, color, depth,
			                            -CAVEMAN_INF, CAVEMAN_INF, deadline,
			                            tt, killers, 0, abHistory,
			                            true, abortFlag, usePruning, enumConfig);
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
		const promise = new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject, onProgress });
			w.postMessage({ type: 'search', id, sfn, color, opts });
		});
		// Expose the id on the promise so callers can cancel it.
		promise.searchId = id;
		return promise;
	}

	cancel(searchId) {
		if (!searchId || !this._worker) return;
		try { this._worker.postMessage({ type: 'cancel', id: searchId }); }
		catch (_) { /* worker gone — nothing to cancel */ }
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
			{ maxDepth: _CAVEMAN_MAX_PLY, timeLimit: 60.0, preset: 'caveman' },
			options || {},
		);
		// Set to false to disable pondering. Caller wires this from the
		// user's `enablePondering` account setting.
		this.pondering = true;
		this._ponderSearchId = null;
	}

	/**
	 * Generic TT-priming ponder. Runs an unbounded-depth search on the
	 * current board (whose turn it currently is — typically the human)
	 * via the shared Worker. The result itself is discarded; the value
	 * is the TT entries it accumulates, which the AI's real search
	 * reuses once the human has played. No move prediction.
	 *
	 * No-op when pondering is disabled or the worker is unavailable.
	 */
	startPonder(board) {
		if (!this.pondering) return;
		// Don't stack ponder calls; if one's running already, leave it.
		if (this._ponderSearchId !== null) return;
		const sfn = boardToSfn(board);
		const color = board.whoseTurn;
		const positionHistory = board.allLoopingSnapshotCounts || {};
		const opts = {
			positionHistory,
			// Ponder with the same engine the real search will use, so the
			// TT entries it primes are valid for that search.
			preset: this.options.preset,
			timeLimit: Infinity,
			// Bounded ponder depth so a single iteration can't grow
			// past ~1s of work — cancel latency is bounded by current
			// depth duration (cooperative abort can't fire mid-depth
			// because the worker is single-threaded). Depth 8 is
			// enough that the TT entries it produces still hit when
			// the real search reaches the same sub-positions; deeper
			// ponder iterations are rarely revisited and aren't worth
			// the extra cancel latency.
			maxDepth: 8,
			useSharedTt: true,
			resetSharedTt: false,
		};
		const worker = getSharedAiWorker();
		const promise = worker.search(sfn, color, opts, null);
		if (!promise) return;  // worker unavailable; no-op
		const id = promise.searchId;
		this._ponderSearchId = id;
		// Swallow result + errors — ponder's value is in the shared TT
		// entries accumulated, not in the result payload. Only clear
		// the id if it still matches; cancel + immediate restart could
		// have replaced it with a newer ponder.
		promise
			.catch(() => { /* aborted / failed — ignore */ })
			.then(() => {
				if (this._ponderSearchId === id) this._ponderSearchId = null;
			});
	}

	cancelPonder() {
		if (this._ponderSearchId === null) return;
		const id = this._ponderSearchId;
		this._ponderSearchId = null;
		getSharedAiWorker().cancel(id);
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
		const result = await cavemanSearch(simBoard, color, Object.assign({}, opts, {
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
