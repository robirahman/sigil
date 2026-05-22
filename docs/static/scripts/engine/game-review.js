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
	mode: 'quick',
};

// Mode presets: 'quick' uses a per-ply time cap with effectively unlimited
// depth; 'deep' uses a hard depth cap with no time limit.
const REVIEW_MODE_PRESETS = {
	quick: { timeLimitPerPly: 1.0, maxDepth: 64 },
	deep:  { timeLimitPerPly: Infinity, maxDepth: 10 },
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
	// Apply mode preset for time/depth bounds, unless caller passed explicit
	// overrides — explicit opts win over the preset.
	const preset = REVIEW_MODE_PRESETS[opts.mode] || REVIEW_MODE_PRESETS.quick;
	if (!opts._timeLimitPerPlyExplicit) opts.timeLimitPerPly = preset.timeLimitPerPly;
	if (!opts._maxDepthExplicit)        opts.maxDepth        = preset.maxDepth;

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

	// Route the per-ply searches through the shared AI Web Worker so a Deep
	// review (10-ply, no time limit per ply) doesn't freeze the page. The
	// worker owns the persistent TT, which it reuses across calls when we
	// pass `useSharedTt: true` — so the reverse-walk priming still works.
	const worker = (typeof getSharedAiWorker === 'function') ? getSharedAiWorker() : null;
	const useWorker = !!(worker && typeof Worker !== 'undefined');
	let mainThreadTt = null;
	if (!useWorker) {
		mainThreadTt = new MinimaxTT(_CAVEMAN_TT_MAX);
		mainThreadTt.newSearch();
		mainThreadTt.nodes = 0;
	}

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

		let score, turnNotation;
		if (useWorker) {
			const searchOpts = {
				timeLimit: opts.timeLimitPerPly,
				maxDepth: opts.maxDepth,
				useSharedTt: true,
				// Clear the worker's TT once at the start of the review so a
				// stale priming from an earlier search doesn't bleed in.
				resetSharedTt: (i === n),
			};
			let msg;
			try {
				msg = await worker.search(sfnPerPly[i], mover, searchOpts);
			} catch (e) {
				// Worker crash: fall back to a fresh main-thread search for
				// the remaining plies. Re-seed a local TT so the rest of the
				// review still benefits from reverse-walk priming.
				console.warn('AI worker search failed during review; falling back:', e);
				mainThreadTt = new MinimaxTT(_CAVEMAN_TT_MAX);
				mainThreadTt.newSearch();
				mainThreadTt.nodes = 0;
				const result = cavemanSearch(sim, mover, {
					timeLimit: opts.timeLimitPerPly,
					maxDepth: opts.maxDepth,
					tt: mainThreadTt,
				});
				score = result.score;
				turnNotation = result.turn ? turnToNotation(result.turn) : null;
				evalPerPly[i] = score;
				winPctPerPly[i] = scoreToWinPct(score, opts.sigmoidK, opts.forcedWinFloor);
				bestTurnPerPly[i] = turnNotation;
				if (i % 2 === 0) await _sleep(0);
				continue;
			}
			score = msg.score;
			turnNotation = msg.turn ? turnToNotation(msg.turn) : null;
		} else {
			const result = cavemanSearch(sim, mover, {
				timeLimit: opts.timeLimitPerPly,
				maxDepth: opts.maxDepth,
				tt: mainThreadTt,
			});
			score = result.score;
			turnNotation = result.turn ? turnToNotation(result.turn) : null;
		}
		evalPerPly[i] = score;
		winPctPerPly[i] = scoreToWinPct(score, opts.sigmoidK, opts.forcedWinFloor);
		bestTurnPerPly[i] = turnNotation;

		// Yield to the UI between plies so the progress callback animates.
		// (Cheap when the worker is doing the heavy lifting, but keeps the
		// progress bar smooth either way.)
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
		mode: opts.mode,
		sigmoidK: opts.sigmoidK,
		forcedWinFloor: opts.forcedWinFloor,
		timeLimitPerPly: Number.isFinite(opts.timeLimitPerPly) ? opts.timeLimitPerPly : null,
		maxDepth: Number.isFinite(opts.maxDepth) ? opts.maxDepth : null,
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
		mode: opts.mode,
		sigmoidK: opts.sigmoidK,
		forcedWinFloor: opts.forcedWinFloor,
		timeLimitPerPly: Number.isFinite(opts.timeLimitPerPly) ? opts.timeLimitPerPly : null,
		maxDepth: Number.isFinite(opts.maxDepth) ? opts.maxDepth : null,
		sfnPerPly: [], evalPerPly: [], winPctPerPly: [],
		bestTurnPerPly: [], moverPerPly: [], classificationPerPly: [],
		dWpPerPly: [], playedTurnPerPly: [],
		redAccuracy: 100, blueAccuracy: 100, redAcpl: 0, blueAcpl: 0,
		aiTrainingExempt: true, computedAt: Date.now(),
	};
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Returns an object with AI-review state + methods that can be spread into an
 * Alpine.data() factory's return value. Both `game-board-local.js` and
 * `game-board-multiplayer.js` use this so the review behaviour stays in sync.
 *
 * Consumers should override `_aiReviewGetUid()` after spreading to return the
 * current signed-in user's uid (or null). It's invoked from
 * `_publishCommunityAnnotation` to attribute writes.
 */
function aiReviewMixin() {
	return {
		_aiReviewGetUid() { return null; },  // override per page
		// State
		aiReview: null,
		aiReviewComputing: false,
		aiReviewProgress: 0,
		aiReviewActiveMode: null,
		_roomCodeForReview: '',

		async startAiReview(mode) {
			if (this.aiReviewComputing) return;
			if (typeof reviewGame !== 'function') return;
			const gameLog = this._gameLogForExport;
			if (!gameLog || gameLog.length === 0) return;
			mode = (mode === 'deep') ? 'deep' : 'quick';

			// In-memory hit: already loaded a review good enough for the
			// requested mode → just open it, skip cache RTT and compute.
			if (this.aiReview) {
				const haveMode = this.aiReview.mode || 'quick';
				if (haveMode === 'deep' || mode === 'quick') {
					if (!this.reviewMode) this.startReview();
					this.reviewFirst();
					return;
				}
			}

			// Cache rules:
			//   - deep cached → always reuse, regardless of request
			//   - quick requested + any cached → reuse
			//   - deep requested + only quick cached (or none) → recompute deep,
			//     overwriting the cached entry
			const gameId = this._roomCodeForReview;
			const db = (typeof firebase !== 'undefined' && firebase.database) ? firebase.database() : null;
			if (db && gameId && typeof loadGameReview === 'function') {
				try {
					const cached = await loadGameReview(db, gameId);
					if (cached) {
						const cachedMode = cached.mode || 'quick';
						if (cachedMode === 'deep' || mode === 'quick') {
							this.aiReview = cached;
							if (!this.reviewMode) this.startReview();
							this.reviewFirst();
							return;
						}
					}
				} catch (e) { /* fall through to compute */ }
			}

			this.aiReviewComputing = true;
			this.aiReviewActiveMode = mode;
			this.aiReviewProgress = 0;
			try {
				const result = await reviewGame(gameLog, { mode }, (done, total) => {
					this.aiReviewProgress = total ? done / total : 0;
				});
				this.aiReview = result;
				if (db && gameId && typeof saveGameReview === 'function') {
					saveGameReview(db, gameId, result).catch(e => console.warn('saveGameReview failed:', e));
				}
				if (!this.reviewMode) this.startReview();
				this.reviewFirst();
			} catch (e) {
				console.error('AI review failed:', e);
			} finally {
				this.aiReviewComputing = false;
				this.aiReviewActiveMode = null;
				this.aiReviewProgress = 1;
			}
		},

		_aiReviewRedWp(i) {
			const wp = this.aiReview.winPctPerPly[i];
			return this.aiReview.moverPerPly[i] === 'red' ? wp : 100 - wp;
		},
		_aiReviewRedScore(i) {
			const s = this.aiReview.evalPerPly[i];
			return this.aiReview.moverPerPly[i] === 'red' ? s : -s;
		},

		aiReviewCurrentEvalText() {
			if (!this.aiReview || !this.aiReview.evalPerPly.length) return '';
			const idx = Math.min(this.reviewIndex, this.aiReview.evalPerPly.length - 1);
			const redScore = this._aiReviewRedScore(idx);
			const floor = this.aiReview.forcedWinFloor || 50;
			if (redScore >= floor) return '+M';
			if (redScore <= -floor) return '-M';
			const stones = redScore * 39;
			if (Math.abs(stones) < 0.05) return '0';
			return (stones > 0 ? '+' : '') + stones.toFixed(1);
		},

		currentReviewTurnNumber() {
			if (!this._gameLogForExport || this.reviewIndex <= 0) return null;
			const entry = this._gameLogForExport[this.reviewIndex - 1];
			return entry ? entry.turnNumber : null;
		},

		isCurrentReviewPlyAmbiguous() {
			if (!this.aiReview || this.reviewIndex <= 0) return false;
			const idx = Math.min(this.reviewIndex, this.aiReview.evalPerPly.length - 1);
			const floor = this.aiReview.forcedWinFloor || 50;
			const redScore = this._aiReviewRedScore(idx);
			if (Math.abs(redScore) >= floor) return false;
			const redWp = this._aiReviewRedWp(idx);
			return redWp > 30 && redWp < 70;
		},

		setReviewAnnotation(value) {
			const tn = this.currentReviewTurnNumber();
			if (tn === null) return;
			const current = this.annotations[tn];
			const next = current === value ? null : value;
			if (next === null) delete this.annotations[tn];
			else this.annotations[tn] = next;
			this._publishCommunityAnnotation('move', tn, next);
		},

		setReviewEvalAnnotation(value) {
			const tn = this.currentReviewTurnNumber();
			if (tn === null) return;
			const current = this.evalAnnotations[tn];
			const next = current === value ? null : value;
			if (next === null) delete this.evalAnnotations[tn];
			else this.evalAnnotations[tn] = next;
			this._publishCommunityAnnotation('eval', tn, next);
		},

		async _publishCommunityAnnotation(kind, turnNumber, value) {
			const uid = this._aiReviewGetUid();
			const gameId = this._roomCodeForReview;
			if (!uid || !gameId || typeof firebase === 'undefined' || typeof saveCommunityAnnotation !== 'function') return;
			try {
				await saveCommunityAnnotation(firebase.database(), gameId, turnNumber, uid, kind, value);
			} catch (e) { console.warn('community annotation save failed:', e); }
		},

		aiReviewGraphPoints() {
			if (!this.aiReview || !this.aiReview.winPctPerPly.length) return '';
			const n = this.aiReview.winPctPerPly.length;
			const w = 480, h = 80;
			if (n < 2) return '';
			const pts = [];
			for (let i = 0; i < n; i++) {
				const x = (i / (n - 1)) * w;
				const y = h - (this._aiReviewRedWp(i) / 100) * h;
				pts.push(x.toFixed(1) + ',' + y.toFixed(1));
			}
			return pts.join(' ');
		},

		aiReviewGraphDots() {
			if (!this.aiReview) return [];
			const n = this.aiReview.classificationPerPly.length;
			const total = this.aiReview.winPctPerPly.length;
			const w = 480, h = 80;
			const dots = [];
			for (let i = 0; i < n; i++) {
				const cls = this.aiReview.classificationPerPly[i];
				if (cls === 'ok') continue;
				const x = ((i + 1) / (total - 1)) * w;
				const y = h - (this._aiReviewRedWp(i + 1) / 100) * h;
				dots.push({ x: x.toFixed(1), y: y.toFixed(1), cls, ply: i });
			}
			return dots;
		},

		jumpToReviewPly(plyIdx) {
			if (!this.aiReview) return;
			if (!this.reviewMode) this.startReview();
			const target = Math.max(0, Math.min(this.reviewSfns.length - 1, plyIdx));
			this.reviewIndex = target;
			this._showReviewPosition();
		},

		handleReviewKey(event) {
			if (!this.reviewMode) return;
			const tag = event.target && event.target.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA') return;
			switch (event.key) {
				case 'ArrowLeft':  event.preventDefault(); this.reviewPrev();  break;
				case 'ArrowRight': event.preventDefault(); this.reviewNext();  break;
				case 'ArrowUp':    event.preventDefault(); this.reviewFirst(); break;
				case 'ArrowDown':  event.preventDefault(); this.reviewLast();  break;
			}
		},
	};
}

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
