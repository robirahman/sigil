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

class MinimaxTimeout extends Error {}

/**
 * Apply a turn on a copy of `board`. Mirrors applySimTurn in sim-board.js
 * but also runs check_game_over + advance_turn so the returned board is
 * ready for opponent's turn enumeration.
 */
function _minimaxApplyTurn(board, turn, color) {
	const sim = board.copy();
	for (const action of turn.actions) {
		const t = action.type;
		if (t === 'move') sim.stones[action.node] = color;
		else if (t === 'hard_move') sim._pushEnemy(action.node, color);
		else if (t === 'blink') {
			if (sim.stones[action.node] === sim._enemy(color)) sim._pushEnemy(action.node, color);
			else sim.stones[action.node] = color;
		} else if (t === 'cast') sim._castSpell(action.spell, color);
		else if (t === 'dash' || t === 'dash_lightning') {
			if (action.sacrificed) for (const n of action.sacrificed) sim.stones[n] = null;
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

function _minimaxOrderedTurns(board, color, model, orderingAlpha, exhaustive) {
	let turns;
	if (exhaustive && typeof getLegalTurnsExhaustive === 'function') {
		turns = getLegalTurnsExhaustive(board, color);
	} else {
		turns = [...board.getLegalTurns(color)];
	}
	if (turns.length <= 1) return turns;
	const { raw, spellIds } = boardToTensor(board, color);
	const tf = encodeAllTurns(turns, board, color);
	const N = turns.length;
	const { value, policyLogits } = model.forward(raw, spellIds, tf, N);
	void value;
	// Softmax to get policy
	let maxL = -Infinity;
	for (let i = 0; i < N; i++) if (policyLogits[i] > maxL) maxL = policyLogits[i];
	const policy = new Float32Array(N);
	let sum = 0;
	for (let i = 0; i < N; i++) { policy[i] = Math.exp(policyLogits[i] - maxL); sum += policy[i]; }
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
                           orderingAlpha, exhaustiveRoot, isRoot) {
	if (Date.now() > deadline) throw new MinimaxTimeout();
	if (board.gameover || depth === 0) {
		return { score: _minimaxEvalLeaf(board, color, model), move: null };
	}
	const turns = _minimaxOrderedTurns(
		board, color, model, orderingAlpha,
		exhaustiveRoot && isRoot,
	);
	if (turns.length === 0) {
		return { score: _minimaxEvalLeaf(board, color, model), move: null };
	}
	let bestScore = -MINIMAX_INF;
	let bestMove = turns[0];
	const enemy = color === 'red' ? 'blue' : 'red';
	for (const turn of turns) {
		const sim = _minimaxApplyTurn(board, turn, color);
		if (sim.gameover && sim.winner === color) {
			return { score: MINIMAX_WIN, move: turn };
		}
		const sub = _minimaxAlphaBeta(sim, enemy, depth - 1, -beta, -alpha,
		                              model, deadline, orderingAlpha,
		                              exhaustiveRoot, false);
		const score = -sub.score;
		if (score > bestScore) { bestScore = score; bestMove = turn; }
		if (bestScore > alpha) alpha = bestScore;
		if (alpha >= beta) break;
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
	const verbose = opts.verbose;

	let legal;
	if (exhaustiveRoot && typeof getLegalTurnsExhaustive === 'function') {
		legal = getLegalTurnsExhaustive(board, color);
	} else {
		legal = [...board.getLegalTurns(color)];
	}
	if (legal.length === 0) return new SimTurn([new SimAction('pass')]);
	// Mate-in-1
	for (const turn of legal) {
		const sim = _minimaxApplyTurn(board, turn, color);
		if (sim.gameover && sim.winner === color) return turn;
	}

	const deadline = Date.now() + timeLimit * 1000;
	let bestMove = legal[0];
	let completedDepth = 0;
	for (let depth = 1; depth <= maxDepth; depth++) {
		const t0 = Date.now();
		try {
			const r = _minimaxAlphaBeta(board, color, depth, -MINIMAX_INF, MINIMAX_INF,
			                            model, deadline, orderingAlpha,
			                            exhaustiveRoot, true);
			if (r.move) { bestMove = r.move; completedDepth = depth; }
			if (verbose) console.log(`minimax: depth=${depth} done in ${(Date.now()-t0)/1000}s score=${r.score.toFixed(3)}`);
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
