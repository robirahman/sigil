/**
 * Rated games from a position ("Rematch from here", Import Position, online
 * rooms from a position): the engine's eval of the start position, turned
 * into P(red wins), sets each side's rating payoffs so that picking a side is
 * worth nothing on average (elo.js positionExpectedScore / computeEloChange).
 *
 * P(red wins) is calibrated to the Very Hard AI (60 s a move) playing both
 * sides from the position (engine/harness/position_selfplay.py, fitted by
 * fit_position_winprob.py into static/data/position-winprob.json), one curve
 * per search depth (and game phase): a live in-browser search reports the depth it completed,
 * and stored or Deep-review evals carry theirs. A PROVEN forced win is a
 * certainty (0 or 1); a "likely" mate gets its calibrated rate.
 *
 * Eval info, always from red's side: { depth, stones, mateIn, proven }, with
 * mateIn in the winner's own turns, + when red wins (the game_evals
 * convention).
 */

const POSITION_MODEL_URL = 'static/data/position-winprob.json';
/** Live search budget: long enough for depth 5 on a typical laptop. */
const POSITION_EVAL_MS = 5000;
let _positionModelPromise = null;

/** The calibration (memoized). Resolves null when it cannot be loaded. */
function loadPositionModel() {
	if (!_positionModelPromise) {
		const url = new URL(POSITION_MODEL_URL, document.baseURI).href;
		_positionModelPromise = fetch(url).then(r => (r.ok ? r.json() : null)).then((m) => {
			// The curves belong to one eval; a new shipped eval needs a refit
			// (engine/harness/fit_position_winprob.py).
			if (m && m.evalName && typeof RUST_REVIEW_SEARCH !== 'undefined' && m.evalName !== RUST_REVIEW_SEARCH.evalName) {
				console.warn('[position-rating] calibration is for ' + m.evalName + ', the engine plays ' + RUST_REVIEW_SEARCH.evalName);
			}
			return m;
		}).catch(() => null);
	}
	return _positionModelPromise;
}

function _sfnRedToMove(sfn) { return String(sfn).split(' ')[1] === 'r'; }

/**
 * The SFN a game started from `sfn` opens its first turn on: GameController
 * advances the turn counter and gives the move to the parity's side before
 * each turn, so a recorded position (a review's after-turn SFN carries the
 * last mover's token) becomes the side to move's SFN, which is what the
 * engine searches and what the game records as its setup.
 */
function positionTurnSfn(sfn) {
	const d = sfnToDict(sfn);
	const b = new SigilBoard(null, normalizeVariant(d && d.variant));
	b.loadFromSfn(sfn);
	if (d && d.variant) b.variant = d.variant;
	b.turnCounter++;
	b.whoseTurn = b.turnCounter % 2 === 1 ? 'red' : 'blue';
	return boardToSfn(b);
}

/** The fitted curve for a search depth: the deepest fitted depth <= depth. */
function _positionCurve(model, depth) {
	const ds = Object.keys((model && model.depths) || {}).map(Number).sort((a, b) => a - b);
	let pick = null;
	for (const d of ds) if (d <= depth) pick = d;
	return pick === null ? null : model.depths[String(pick)];
}

/**
 * P(red wins | position) from an eval, or null when the eval is too shallow
 * for any fitted curve (or the model is missing).
 */
function positionRedWinProb(model, info, sfn) {
	if (!info) return null;
	if (typeof info.mateIn === 'number' && info.mateIn !== 0 && info.proven) return info.mateIn > 0 ? 1 : 0;
	const curve = _positionCurve(model, info.depth || 0);
	if (!curve) return null;
	if (typeof info.mateIn === 'number' && info.mateIn !== 0) {
		const w = curve.likelyMateWin;
		return info.mateIn > 0 ? w : 1 - w;
	}
	if (typeof info.stones !== 'number') return null;
	// Game phase: a stone is worth less late in the game (fitted terms).
	const ph = Math.min(Number(String(sfn).split(' ')[2]) || 0, 60) / 60;
	const z = curve.a + curve.b * info.stones + (_sfnRedToMove(sfn) ? curve.c : 0)
		+ ph * ((curve.aPhase || 0) + (curve.bPhase || 0) * info.stones);
	return 1 / (1 + Math.exp(-z));
}

/**
 * Rating payoffs of each side at these ratings: { red: {win, loss}, blue:
 * {win, loss} }, loss negative. The same rounding as the real update.
 */
function positionPayoffs(pRed, redElo, blueElo) {
	return {
		red: { win: computeEloChange(redElo, blueElo, pRed), loss: -computeEloChange(blueElo, redElo, 1 - pRed) },
		blue: { win: computeEloChange(blueElo, redElo, 1 - pRed), loss: -computeEloChange(redElo, blueElo, pRed) },
	};
}

/** "Red wins 71%" / "Red has a forced win". */
function describePositionOdds(pRed) {
	if (pRed >= 1) return 'Red has a forced win';
	if (pRed <= 0) return 'Blue has a forced win';
	const pct = Math.round(100 * pRed);
	return pct >= 50 ? 'Red wins ' + Math.min(99, pct) + '%' : 'Blue wins ' + Math.min(99, 100 - pct) + '%';
}

/** "+1.2" / "Red wins in 3" style readout of an eval (red's side). */
function describePositionEval(info) {
	if (typeof info.mateIn === 'number' && info.mateIn !== 0) {
		return (info.mateIn > 0 ? 'Red' : 'Blue') + ' wins in ' + Math.abs(info.mateIn) + (info.proven ? '' : ' (likely)');
	}
	const s = info.stones;
	return Math.abs(s) < 0.05 ? '0.0' : (s > 0 ? '+' : '') + s.toFixed(1);
}

/**
 * Search the position with the Rust engine (rust-ai.js worker, the review
 * settings) and return its eval info. The search runs for POSITION_EVAL_MS on
 * a fresh table; one that completes fewer than 4 plies is retried longer.
 */
async function evaluateStartPosition(sfn, historySfns) {
	const worker = getRustEngineWorker();
	worker.post({ type: 'new_game', ttBits: 20 });
	const hist = (historySfns || []).slice(-63).concat([sfn]);
	let res = null;
	for (let tms = POSITION_EVAL_MS, k = 0; k < 3; k++, tms *= 3) {
		res = await worker.search(Object.assign({
			sfn, timeMs: tms, ttBits: 20, historySfns: hist,
			threads: typeof rustThreadCount === 'function' ? rustThreadCount() : 1,
		}, RUST_REVIEW_SEARCH));
		if (!res || res.ok === false) throw new Error((res && res.error) || 'the engine cannot evaluate this position');
		const proven = typeof res.mate_in === 'number' && res.mate_in !== 0 && res.mate_proven;
		if ((res.depth || 0) >= 4 || proven) break;
	}
	const sign = _sfnRedToMove(sfn) ? 1 : -1;            // mover POV -> red POV
	return {
		depth: res.depth || 0,
		stones: typeof res.stones === 'number' ? res.stones * sign : null,
		mateIn: (typeof res.mate_in === 'number' && res.mate_in !== 0) ? res.mate_in * sign : null,
		proven: res.mate_in == null ? true : !!res.mate_proven,
	};
}

/**
 * Eval info for review position i, when the review holds one deep enough to
 * use (a stored game_evals document or a review that recorded per-ply depth).
 */
function reviewPositionEval(review, i) {
	if (!review || !Array.isArray(review.depthPerPly) || !Array.isArray(review.moverPerPly)) return null;
	const depth = review.depthPerPly[i];
	if (!(depth >= 4)) return null;
	const m = review.matePerPly && review.matePerPly[i];
	const sign = review.moverPerPly[i] === 'red' ? 1 : -1;   // matePerPly is mover POV
	const stones = review.stonesPerPly && review.stonesPerPly[i];
	if (typeof m !== 'number' && typeof stones !== 'number') return null;
	return {
		depth,
		stones: typeof stones === 'number' ? stones : null,
		mateIn: typeof m === 'number' && m !== 0 ? m * sign : null,
		proven: review.provenPerPly ? review.provenPerPly[i] !== false : true,
	};
}

/**
 * The `startPos` field of a game record from an eval, or null if the model
 * cannot price it (the game is then unrated).
 */
function makeStartPos(model, sfn, info, source) {
	const p = positionRedWinProb(model, info, sfn);
	if (p === null) return null;
	return {
		sfn,
		redWinProb: p,
		source,                       // 'live' | 'review'
		depth: info.depth,
		stones: info.stones,
		mateIn: info.mateIn,
		proven: info.proven,
		model: model.version,
		engineVersion: typeof RUST_ENGINE_VERSION !== 'undefined' ? RUST_ENGINE_VERSION : null,
	};
}
