/**
 * Browser-side iterative-deepening alpha-beta minimax for Sigil.
 *
 * Mirror of ai/minimax_ai.py. Each leaf evaluation is one network
 * forward pass on the value head; alpha-beta with strategic+policy
 * move ordering keeps the search tractable.
 *
 * Browser caveats:
 *   - JS NN forward is ~50ms uncached vs ~3ms in Python. 4-ply is
 *     typically out of budget; we cap at depth 3 with a 12s timeout
 *     and rely on iterative deepening to return the deepest depth
 *     completed (always at least depth 1).
 *   - We reuse SigilNetJS / SigilNetGraphJS via their `forward`
 *     method — both already handle policy + value in one pass.
 */

const MINIMAX_INF = 1e9;
const MINIMAX_WIN = 100.0;

// Transposition-table bound classifications.
const _BOUND_EXACT = 0;
const _BOUND_LOWER = 1;  // fail-high
const _BOUND_UPPER = 2;  // fail-low

const _MINIMAX_TT_MAX_SIZE_DEFAULT = 50000;
const _MINIMAX_MAX_PLY_DEFAULT = 8;

class MinimaxTimeout extends Error {}

/**
 * Transposition table with depth-preferred replacement and two-generation aging.
 * Keys are strings (hashes) → entry objects. We cap entries; on overflow we
 * drop entries whose age is two searches old, then fall back to dropping the
 * oldest half by age.
 */
class MinimaxTT {
	constructor(maxSize) {
		this.entries = new Map();
		this.maxSize = maxSize || _MINIMAX_TT_MAX_SIZE_DEFAULT;
		this.age = 0;
		this.probes = 0;
		this.hits = 0;
		this.cutoffs = 0;
	}
	newSearch() { this.age += 1; }
	get(key) {
		this.probes += 1;
		const e = this.entries.get(key);
		if (e !== undefined) this.hits += 1;
		return e;
	}
	store(key, depth, score, bound, bestMove) {
		const ex = this.entries.get(key);
		if (ex === undefined || depth >= ex.depth || ex.age < this.age) {
			this.entries.set(key, { depth, score, bound, bestMove, age: this.age });
		}
		if (this.entries.size > this.maxSize) this._evict();
	}
	_evict() {
		const threshold = this.age - 1;
		for (const [k, v] of this.entries) {
			if (v.age < threshold) this.entries.delete(k);
		}
		if (this.entries.size > this.maxSize) {
			// Drop oldest half by age.
			const all = Array.from(this.entries.entries());
			all.sort((a, b) => a[1].age - b[1].age);
			const half = (all.length / 2) | 0;
			for (let i = 0; i < half; i++) this.entries.delete(all[i][0]);
		}
	}
	get size() { return this.entries.size; }
}

class MinimaxKillerTable {
	constructor(maxPly) {
		this.maxPly = maxPly || _MINIMAX_MAX_PLY_DEFAULT;
		this.slots = [];
		for (let i = 0; i < this.maxPly; i++) this.slots.push([null, null]);
	}
	add(ply, move) {
		if (ply >= this.maxPly || move === null) return;
		const slot = this.slots[ply];
		if (slot[0] !== null && _turnEq(slot[0], move)) return;
		slot[1] = slot[0];
		slot[0] = move;
	}
	get(ply) {
		if (ply >= this.maxPly) return [];
		return this.slots[ply].filter(m => m !== null);
	}
}

/**
 * Position hash: build a fixed-format string from every aspect of game
 * state that affects legal moves or evaluation. Stones, spell_counter,
 * lock, springlock, side-to-move. Excludes turn_counter (tactic on
 * turn 5 is the same as turn 50) and derived totals/mana.
 *
 * String-based hashing trades ~2 µs/call for implementation
 * simplicity; the alternative (BigInt Zobrist) is similar speed in
 * V8 with more code to maintain.
 */
function _minimaxPosHash(board, color) {
	let s = color + '|';
	for (const n of NODE_ORDER) {
		const st = board.stones[n];
		s += (st === 'red' ? 'R' : st === 'blue' ? 'B' : '.');
	}
	s += '|' + board.spellCounter.red + ',' + board.spellCounter.blue;
	s += '|' + (board.lock.red || '-') + ',' + (board.lock.blue || '-');
	s += '|' + (board.springlock.red || '-') + ',' + (board.springlock.blue || '-');
	return s;
}

/**
 * Structural identity for a SimTurn — used to match TT/killer hints
 * across copied boards. Returns a string signature.
 */
function _turnSig(turn) {
	if (!turn || !turn.actions) return '';
	const parts = [];
	for (const a of turn.actions) {
		const sac = a.sacrificed ? a.sacrificed.join('+') : '';
		const kept = a.kept ? a.kept.join('+') : '';
		const dest = a.destroyed ? a.destroyed.join('+') : '';
		parts.push([
			a.type, a.node || '', a.pushed_to || '', a.spell || '',
			sac, kept, a.node2 || '', dest,
		].join(':'));
	}
	return parts.join(';');
}

function _turnEq(t1, t2) {
	if (t1 === null || t2 === null) return false;
	if (t1 === t2) return true;
	return _turnSig(t1) === _turnSig(t2);
}

/**
 * Move TT-move (if any) and killer moves to the front of `turns`.
 * Hint moves keep order TT → killer1 → killer2; remaining turns retain
 * their relative order. Returns a new array; does not mutate input.
 */
function _orderWithHints(turns, ttMove, killers) {
	if (ttMove === null && (!killers || killers.length === 0)) return turns;
	const targets = [];
	if (ttMove !== null) targets.push(ttMove);
	for (const k of killers || []) {
		if (k !== null) targets.push(k);
	}
	if (targets.length === 0) return turns;
	const headIdx = [];
	const used = new Set();
	for (const tgt of targets) {
		for (let i = 0; i < turns.length; i++) {
			if (used.has(i)) continue;
			if (_turnEq(turns[i], tgt)) {
				headIdx.push(i);
				used.add(i);
				break;
			}
		}
	}
	if (headIdx.length === 0) return turns;
	const head = headIdx.map(i => turns[i]);
	const tail = [];
	for (let i = 0; i < turns.length; i++) if (!used.has(i)) tail.push(turns[i]);
	return head.concat(tail);
}

/**
 * Apply a turn on a copy of `board`. Mirrors applySimTurn in sim-board.js
 * but also runs check_game_over + advance_turn so the returned board is
 * ready for opponent's turn enumeration.
 *
 * A 'cast' action only performs the bookkeeping (clear position, refill
 * from `action.kept`, advance the lock/counter). The resolver-emitted
 * actions that follow it in the turn (hard_move, sacrifice, fireblast,
 * etc.) carry the resolution outcome and are applied separately — calling
 * sim._castSpell would re-run resolution and double-apply on top.
 */
function _minimaxApplyTurn(board, turn, color) {
	const sim = board.copy();
	const enemy = sim._enemy(color);
	for (const action of turn.actions) {
		const t = action.type;
		if (t === 'move') sim.stones[action.node] = color;
		else if (t === 'hard_move') sim._pushEnemy(action.node, color);
		else if (t === 'blink') {
			if (sim.stones[action.node] === sim._enemy(color)) sim._pushEnemy(action.node, color);
			else sim.stones[action.node] = color;
		} else if (t === 'cast') {
			const info = CORE_SPELLS[action.spell];
			const spellIdx = sim.spellNames.indexOf(action.spell);
			const posNodes = POSITIONS[spellIdx + 1] || [];
			for (const n of posNodes) sim.stones[n] = null;
			if (info && !info.ischarm && action.kept) {
				for (const n of action.kept) sim.stones[n] = color;
			}
			if (info && !info.ischarm) {
				if (sim.lock[color] === action.spell) sim.springlock[color] = action.spell;
				else { sim.lock[color] = action.spell; sim.springlock[color] = null; }
				sim.spellCounter[color]++;
			}
		}
		else if (t === 'dash' || t === 'dash_lightning') {
			if (action.sacrificed) for (const n of action.sacrificed) sim.stones[n] = null;
		}
		// Resolver-emitted outcomes — apply the recorded result directly,
		// since the cast action above intentionally skipped resolution.
		else if (t === 'sacrifice') {
			if (action.node) sim.stones[action.node] = null;
		}
		else if (t === 'fireblast' || t === 'hail_storm'
		         || t === 'storm_front' || t === 'hurricane') {
			if (action.destroyed) for (const n of action.destroyed) sim.stones[n] = null;
		}
		else if (t === 'bewitch') {
			if (action.node) sim.stones[action.node] = color;
			if (action.node2) sim.stones[action.node2] = color;
		}
		else if (t === 'starfall') {
			if (action.node) sim.stones[action.node] = color;
			if (action.node2) sim.stones[action.node2] = color;
			if (action.destroyed) for (const n of action.destroyed) sim.stones[n] = null;
		}
		else if (t === 'meteor_destroy') {
			if (action.node) sim.stones[action.node] = null;
		}
		else if (t === 'thunder') {
			if (action.destroyed) for (const n of action.destroyed) sim.stones[n] = null;
			if (action.kept) for (const n of action.kept) sim.stones[n] = enemy;
		}
		sim.update();
	}
	sim.checkGameOver(color);
	if (!sim.gameover) sim.advanceTurn();
	return sim;
}

function _minimaxEvalLeaf(board, color, model) {
	if (board.gameover) {
		if (board.winner === color) return MINIMAX_WIN;
		if (board.winner === null) return 0.0;
		return -MINIMAX_WIN;
	}
	const { raw, spellIds } = boardToTensor(board, color);
	const { value } = model.forward(raw, spellIds, null, 0);
	return value;
}

function _minimaxOrderedTurns(board, color, model, orderingAlpha, exhaustiveCaps, blunderLambda) {
	let turns;
	if (exhaustiveCaps && typeof getLegalTurnsExhaustive === 'function') {
		turns = getLegalTurnsExhaustive(board, color, exhaustiveCaps);
	} else {
		turns = [...board.getLegalTurns(color)];
	}
	if (turns.length <= 1) return turns;
	const { raw, spellIds } = boardToTensor(board, color);
	const tf = encodeAllTurns(turns, board, color);
	const N = turns.length;
	blunderLambda = blunderLambda || 0;
	const useBlunder = blunderLambda > 0;
	const { value, policyLogits, blunderLogits } = model.forward(
		raw, spellIds, tf, N, useBlunder);
	void value;
	// Softmax to get policy (with optional blunder suppression)
	const adj = useBlunder && blunderLogits
		? new Float32Array(N)
		: policyLogits;
	if (useBlunder && blunderLogits) {
		for (let i = 0; i < N; i++) {
			const sig = 1 / (1 + Math.exp(-blunderLogits[i]));
			adj[i] = policyLogits[i] - blunderLambda * sig;
		}
	}
	let maxL = -Infinity;
	for (let i = 0; i < N; i++) if (adj[i] > maxL) maxL = adj[i];
	const policy = new Float32Array(N);
	let sum = 0;
	for (let i = 0; i < N; i++) { policy[i] = Math.exp(adj[i] - maxL); sum += policy[i]; }
	for (let i = 0; i < N; i++) policy[i] /= sum;
	// Score = log(policy) + alpha * strategic_score
	const order = [];
	for (let i = 0; i < N; i++) {
		const slice = tf.subarray(i * TURN_FEATURE_DIM, (i + 1) * TURN_FEATURE_DIM);
		const s = strategicScore(slice);
		order.push([i, Math.log(Math.max(policy[i], 1e-6)) + orderingAlpha * s]);
	}
	order.sort((a, b) => b[1] - a[1]);
	return order.map(o => turns[o[0]]);
}

function _minimaxAlphaBeta(board, color, depth, alpha, beta, model, deadline,
                           orderingAlpha, exhaustiveRoot, exhaustiveOpponent,
                           blunderLambda, isRoot, tt, killers, ply,
                           positionHistory) {
	if (Date.now() > deadline) throw new MinimaxTimeout();
	if (board.gameover || depth === 0) {
		return { score: _minimaxEvalLeaf(board, color, model), move: null };
	}

	// ---- Transposition-table probe ----
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
	const turns = _minimaxOrderedTurns(board, color, model, orderingAlpha, caps, blunderLambda);
	if (turns.length === 0) {
		return { score: _minimaxEvalLeaf(board, color, model), move: null };
	}

	const killerMoves = killers ? killers.get(ply) : [];
	const ordered = (ttMove !== null || killerMoves.length > 0)
		? _orderWithHints(turns, ttMove, killerMoves)
		: turns;

	let bestScore = -MINIMAX_INF;
	let bestMove = ordered[0];
	let cutoff = false;
	const enemy = color === 'red' ? 'blue' : 'red';
	for (const turn of ordered) {
		const sim = _minimaxApplyTurn(board, turn, color);
		// Threefold-repetition lookahead. If applying this turn would
		// reach a board snapshot whose total occurrence count (game
		// history + simulation path) hits 5, the position is a
		// forced blue-win. Mutate `positionHistory` on the way down,
		// restore on the way up so deeper subtrees see correct counts.
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
				bestScore = MINIMAX_WIN;
				bestMove = turn;
				cutoff = true;
				break;
			}
			const sub = _minimaxAlphaBeta(sim, enemy, depth - 1, -beta, -alpha,
			                              model, deadline, orderingAlpha,
			                              exhaustiveRoot, exhaustiveOpponent,
			                              blunderLambda,
			                              false, tt, killers, ply + 1,
			                              positionHistory);
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

	// ---- Transposition-table store ----
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
 * Iterative-deepening alpha-beta search. Returns the best legal turn
 * found within `timeLimit` seconds, up to `maxDepth` plies.
 *
 * @param {SimBoard} board
 * @param {string} color
 * @param {SigilNetJS} model
 * @param {{timeLimit?: number, maxDepth?: number, orderingAlpha?: number, verbose?: boolean}} opts
 */
function minimaxSearch(board, color, model, opts) {
	opts = opts || {};
	const timeLimit = opts.timeLimit !== undefined ? opts.timeLimit : 12.0;
	const maxDepth = opts.maxDepth !== undefined ? opts.maxDepth : 3;
	const orderingAlpha = opts.orderingAlpha !== undefined ? opts.orderingAlpha : 1.0;
	const exhaustiveRoot = !!opts.exhaustiveRoot;
	const exhaustiveOpponent = !!opts.exhaustiveOpponent;
	const blunderLambda = opts.blunderLambda || 0;
	const enableTT = opts.enableTT !== undefined ? !!opts.enableTT : true;
	const enableKillers = opts.enableKillers !== undefined ? !!opts.enableKillers : true;
	const aspirationDelta = opts.aspirationDelta !== undefined ? opts.aspirationDelta : 0.15;
	const ttMaxSize = opts.ttMaxSize || _MINIMAX_TT_MAX_SIZE_DEFAULT;
	const verbose = opts.verbose;
	// Mutable working copy for the alpha-beta DFS so it can
	// increment/decrement counts as it descends. Source is the live
	// game's `allLoopingSnapshotCounts` (passed via opts.positionHistory).
	const abHistory = opts.positionHistory ? Object.assign({}, opts.positionHistory) : null;

	let legal;
	if (exhaustiveRoot && typeof getLegalTurnsExhaustive === 'function') {
		legal = getLegalTurnsExhaustive(board, color);
	} else {
		legal = [...board.getLegalTurns(color)];
	}
	if (legal.length === 0) return new SimTurn([new SimAction('pass')]);
	// Mate-in-1 (also catches a rep-mate: a move that puts the board
	// into its 5th occurrence is an immediate win for blue / forced
	// loss for red, so blue should pick it on sight).
	for (const turn of legal) {
		const sim = _minimaxApplyTurn(board, turn, color);
		if (abHistory && !sim.gameover) {
			const k = sim.loopingSnapshot();
			if ((abHistory[k] || 0) + 1 >= 5) {
				sim.gameover = true;
				sim.winner = 'blue';
			}
		}
		if (sim.gameover && sim.winner === color) return turn;
	}

	const tt = enableTT ? new MinimaxTT(ttMaxSize) : null;
	if (tt) tt.newSearch();
	const killers = enableKillers
		? new MinimaxKillerTable(_MINIMAX_MAX_PLY_DEFAULT)
		: null;

	const deadline = Date.now() + timeLimit * 1000;
	let bestMove = legal[0];
	let completedDepth = 0;
	let prevScore = null;
	for (let depth = 1; depth <= maxDepth; depth++) {
		const t0 = Date.now();
		try {
			let alpha, beta;
			if (aspirationDelta > 0 && prevScore !== null && depth > 1) {
				alpha = prevScore - aspirationDelta;
				beta = prevScore + aspirationDelta;
			} else {
				alpha = -MINIMAX_INF;
				beta = MINIMAX_INF;
			}
			let r;
			while (true) {
				r = _minimaxAlphaBeta(board, color, depth, alpha, beta,
				                     model, deadline, orderingAlpha,
				                     exhaustiveRoot, exhaustiveOpponent,
				                     blunderLambda,
				                     true, tt, killers, 0,
				                     abHistory);
				if (r.score <= alpha && alpha > -MINIMAX_INF) {
					alpha = -MINIMAX_INF;
					continue;
				}
				if (r.score >= beta && beta < MINIMAX_INF) {
					beta = MINIMAX_INF;
					continue;
				}
				break;
			}
			if (r.move) { bestMove = r.move; completedDepth = depth; prevScore = r.score; }
			if (verbose) {
				let msg = `minimax: depth=${depth} done in ${(Date.now()-t0)/1000}s score=${r.score.toFixed(3)}`;
				if (tt) msg += ` tt=${tt.size} hits=${tt.hits} cuts=${tt.cutoffs}`;
				console.log(msg);
			}
			if (Math.abs(r.score) >= MINIMAX_WIN - 1) break;
		} catch (e) {
			if (e instanceof MinimaxTimeout) {
				if (verbose) console.log(`minimax: timed out at depth=${depth}, using depth-${completedDepth}`);
				break;
			}
			throw e;
		}
	}
	return bestMove;
}
