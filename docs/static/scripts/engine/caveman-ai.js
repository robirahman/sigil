/**
 * Browser-side Caveman AI — pure stone-count minimax.
 *
 * Mirror of ai/caveman_ai.py. Iterative-deepening alpha-beta with
 * stone-differential at the leaves. No neural net, no policy, no
 * model file to load. Useful as a baseline opponent: any human who
 * struggles against this is losing on raw board geometry, not on
 * any strategic subtlety the network would surface.
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
	if (exhaustiveRoot && isRoot) {
		caps = (typeof NARROW_ENUM_CAPS !== 'undefined') ? NARROW_ENUM_CAPS : null;
	} else if (exhaustiveOpponent && ply === 1) {
		caps = (typeof OPPONENT_ENUM_CAPS !== 'undefined') ? OPPONENT_ENUM_CAPS : null;
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
 *          positionHistory?: object}} opts
 */
function cavemanSearch(board, color, opts) {
	opts = opts || {};
	const timeLimit = opts.timeLimit !== undefined ? opts.timeLimit : 60.0;
	const maxDepth = opts.maxDepth !== undefined ? opts.maxDepth : 6;
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

	const legal = (exhaustiveRoot && typeof getLegalTurnsExhaustive === 'function')
		? [...getLegalTurnsExhaustive(board, color, NARROW_ENUM_CAPS)]
		: [...board.getLegalTurns(color)];
	if (legal.length === 0) return new SimTurn([new SimAction('pass')]);

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
		if (sim.gameover && sim.winner === color) return turn;
	}

	const tt = new MinimaxTT(_CAVEMAN_TT_MAX);
	tt.newSearch();
	const killers = new MinimaxKillerTable(_CAVEMAN_MAX_PLY);

	const deadline = Date.now() + timeLimit * 1000;
	let bestMove = legal[0];
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
				completedDepth = depth;
				if (verbose) {
					console.log(`caveman: depth=${depth} done in `
					            + `${((Date.now()-t0)/1000).toFixed(2)}s `
					            + `score=${r.score.toFixed(3)} `
					            + `tt=${tt.size} cuts=${tt.cutoffs}`);
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
	return bestMove;
}

/**
 * AI player wrapper. Doesn't need a model file — picks its move purely
 * from the simboard state.
 */
class CavemanAI {
	constructor(options) {
		this.options = Object.assign(
			{ maxDepth: 6, timeLimit: 60.0 },
			options || {},
		);
	}
	pickTurn(board, color) {
		const simBoard = SimBoard.fromSigilBoard(board);
		return cavemanSearch(simBoard, color, this.options);
	}
}
