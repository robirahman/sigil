/**
 * AI game review: per-ply eval, move classification, accuracy stats.
 *
 * Walks plies in reverse so the shared transposition table populated
 * by analyzing position N+1 primes alpha-beta at position N (lichess-style
 * TT warming).
 */

const REVIEW_DEFAULTS = {
	timeLimitPerPly: 3.0,
	maxDepth: 8,
	sigmoidK: 8.0,
	forcedWinFloor: 50,  // |score| >= this is treated as a mate.
	modelVersion: 'caveman-v1',
};

/** Convert minimax score to win% from the mover's perspective. */
function scoreToWinPct(s, k, forcedWinFloor) {
	if (s >= forcedWinFloor) return 100;
	if (s <= -forcedWinFloor) return 0;
	return 50 + 50 * Math.tanh(k * s);
}

/** lichess-style accuracy% from a win-percentage drop. */
function dWpToAccuracy(dWp) {
	const acc = 103.1668 * Math.exp(-0.04354 * Math.max(0, dWp)) - 3.1669;
	return Math.max(0, Math.min(100, acc));
}

function classifyDelta(dWp) {
	if (dWp >= 30) return 'blunder';
	if (dWp >= 20) return 'mistake';
	if (dWp >= 10) return 'inaccuracy';
	return 'ok';
}

function sfnToSimBoard(sfnStr) {
	const state = sfnToDict(sfnStr);
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

/**
 * @param {Array<{color, turnNumber, sfnBefore, sfnAfter}>} gameLog
 * @param {Object} [opts]
 * @param {Function} [onProgress] - called with (plyIndexBeingComputed, total)
 * @returns {Promise<ReviewResult>}
 */
async function reviewGame(gameLog, opts, onProgress) {
	opts = Object.assign({}, REVIEW_DEFAULTS, opts || {});

	const n = gameLog.length;
	if (n === 0) {
		return _emptyReview(opts);
	}

	// Per-ply outputs (length n + 1 for sfns since we include the initial position).
	const sfnPerPly = new Array(n + 1);
	const evalPerPly = new Array(n + 1);
	const winPctPerPly = new Array(n + 1);
	const bestTurnPerPly = new Array(n + 1);
	const moverPerPly = new Array(n + 1);

	sfnPerPly[0] = gameLog[0].sfnBefore;
	for (let i = 0; i < n; i++) sfnPerPly[i + 1] = gameLog[i].sfnAfter;

	const tt = new MinimaxTT(_CAVEMAN_TT_MAX);
	tt.newSearch();
	tt.nodes = 0;

	// Reverse walk so subtree results bubble up across ply boundaries
	// via the shared transposition table.
	for (let i = n; i >= 0; i--) {
		if (onProgress) onProgress(n - i, n + 1);
		const sim = sfnToSimBoard(sfnPerPly[i]);
		const mover = sim.whoseTurn;
		moverPerPly[i] = mover;

		// If the position is already a terminal state, eval is decided.
		if (sim.gameover) {
			evalPerPly[i] = sim.winner === mover ? 100 : sim.winner === null ? 0 : -100;
			winPctPerPly[i] = scoreToWinPct(evalPerPly[i], opts.sigmoidK, opts.forcedWinFloor);
			bestTurnPerPly[i] = null;
			continue;
		}

		const result = cavemanSearch(sim, mover, {
			timeLimit: opts.timeLimitPerPly,
			maxDepth: opts.maxDepth,
			tt,
		});
		evalPerPly[i] = result.score;
		winPctPerPly[i] = scoreToWinPct(result.score, opts.sigmoidK, opts.forcedWinFloor);
		bestTurnPerPly[i] = result.turn ? turnToNotation(result.turn) : null;

		// Yield to the UI between plies so the progress callback animates.
		if (i % 2 === 0) await _sleep(0);
	}

	// Classify each move (one per gameLog entry).
	const classificationPerPly = new Array(n);
	const dWpPerPly = new Array(n);
	for (let i = 0; i < n; i++) {
		const mover = moverPerPly[i];
		const bestWp = winPctPerPly[i];
		// After the played move, position i+1's mover is the opponent.
		// So opponent's win% there = winPctPerPly[i+1]; mover's actual = 100 - that.
		const actualWp = 100 - winPctPerPly[i + 1];
		const dWp = Math.max(0, bestWp - actualWp);
		dWpPerPly[i] = dWp;
		classificationPerPly[i] = classifyDelta(dWp);
	}

	// Per-player accuracy + ACPL (proxy = mean Δwp; lichess uses cp loss, we use wp loss).
	const redDeltas = [];
	const blueDeltas = [];
	for (let i = 0; i < n; i++) {
		(moverPerPly[i] === 'red' ? redDeltas : blueDeltas).push(dWpPerPly[i]);
	}

	function meanAccuracy(deltas) {
		if (!deltas.length) return 100;
		const accs = deltas.map(dWpToAccuracy);
		return accs.reduce((a, b) => a + b, 0) / accs.length;
	}
	function meanDelta(deltas) {
		if (!deltas.length) return 0;
		return deltas.reduce((a, b) => a + b, 0) / deltas.length;
	}

	return {
		modelVersion: opts.modelVersion,
		sigmoidK: opts.sigmoidK,
		forcedWinFloor: opts.forcedWinFloor,
		timeLimitPerPly: opts.timeLimitPerPly,
		sfnPerPly,
		evalPerPly,
		winPctPerPly,
		bestTurnPerPly,
		moverPerPly,
		classificationPerPly,
		dWpPerPly,
		playedTurnPerPly: gameLog.map(t => t.turnNotation || null),
		redAccuracy: meanAccuracy(redDeltas),
		blueAccuracy: meanAccuracy(blueDeltas),
		redAcpl: meanDelta(redDeltas),
		blueAcpl: meanDelta(blueDeltas),
		aiTrainingExempt: true,
		computedAt: Date.now(),
	};
}

function _emptyReview(opts) {
	return {
		modelVersion: opts.modelVersion,
		sigmoidK: opts.sigmoidK,
		forcedWinFloor: opts.forcedWinFloor,
		timeLimitPerPly: opts.timeLimitPerPly,
		sfnPerPly: [], evalPerPly: [], winPctPerPly: [],
		bestTurnPerPly: [], moverPerPly: [], classificationPerPly: [],
		dWpPerPly: [], playedTurnPerPly: [],
		redAccuracy: 100, blueAccuracy: 100, redAcpl: 0, blueAcpl: 0,
		aiTrainingExempt: true, computedAt: Date.now(),
	};
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Best-effort turn-to-notation. SimTurn doesn't carry a notation string. */
function turnToNotation(turn) {
	if (!turn || !turn.actions) return null;
	return turn.actions.map(a => {
		if (a.kind === 'pass') return 'pass';
		if (a.kind === 'spell') return 'cast ' + (a.spell || '');
		if (a.kind === 'dash') return 'dash ' + (a.from || '') + '->' + (a.to || '');
		if (a.kind === 'move' || a.kind === 'play') return (a.node || '');
		return a.kind || '?';
	}).join(' ');
}
