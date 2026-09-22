'use strict';
/**
 * RustAI — plays through the normal web UI, backed by the Rust engine over one
 * of two transports:
 *
 *   'worker' (default) — the engine's WebAssembly build inside a dedicated Web
 *   Worker (rust-worker.js). Fully client-side, so it works on the static
 *   GitHub Pages deployment. Roughly 1.5-3x slower than native for the same
 *   wall clock, which is priced into the site's tier time budgets.
 *
 *   'fetch' — the native engine on a localhost helper (engine/server/serve.py
 *   answering /api/move). Dev playtests only; reached via ?ai=rust_native.
 *
 * Both transports return the SAME response shape, so everything below the
 * transport seam — the replay-verification gate, lastMeta, history threading —
 * is one code path.
 *
 * The engine chooses from its OWN full enumeration — every push destination, dash
 * sacrifice subset, dash target and spell-resolution variant — and returns a JS
 * action list plus the position that list must produce. The browser asserts the
 * replay landed there and refuses the move otherwise.
 *
 * Why the assertion matters: `turns[].actions` feeds game review,
 * `reconstructGameLog`, SGN export and `ai/import_human_games.py`, so a silent
 * divergence between the engine's idea of the position and the board's would
 * corrupt recorded history and training data. Better to stop with a clear error.
 *
 * An earlier version had the browser propose candidates and the engine pick an
 * index. That was safe but capped the engine at the browser's `ENUM_CAPS`, which
 * offers on the order of 4,000x fewer turns per position.
 *
 * Only the 39 official spells are supported: the engine does not implement
 * Tectonic, Providence, Aftershock, Ambush, the fan-made Panda pack or the
 * Experimental playtest pack and rejects positions containing them rather
 * than mis-resolving.
 */

// Bumped on every committed engine rebuild (see engine/build-wasm.sh). Threaded
// as ?v= onto the worker, glue and .wasm URLs so the service worker's cached
// copies can never be stale — an old set is simply never requested again.
const RUST_ENGINE_VERSION = 14;

/**
 * Singleton owner of the wasm worker. Modeled on caveman-ai.js's
 * AiSearchWorker: id-keyed promise map; on worker error every pending search
 * rejects and the worker is torn down, to be rebuilt on the next call so one
 * crash doesn't strand the rest of the game.
 */
class RustEngineWorker {
	constructor() {
		this._worker = null;
		this._pending = new Map();   // id -> {resolve, reject, onProgress}
		this._nextId = 1;
		this._readyPromise = null;
	}

	_ensureWorker() {
		if (this._worker) return this._worker;
		if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
			throw new Error('This browser cannot run the Rust engine ' +
				'(missing Worker or WebAssembly support).');
		}
		const base = (typeof window !== 'undefined' && window.RUST_WORKER_URL)
			|| 'static/scripts/engine/rust-worker.js';
		this._worker = new Worker(base + '?v=' + RUST_ENGINE_VERSION);
		this._worker.onmessage = (e) => this._onMessage(e.data || {});
		this._worker.onerror = (e) => this._onWorkerError(e);
		return this._worker;
	}

	_onMessage(msg) {
		if (msg.type === 'ponder_progress') {
			if (this.onPonderProgress) this.onPonderProgress(msg);
			return;                                    // fire-and-forget, no id
		}
		const p = this._pending.get(msg.id);
		if (!p) return;
		if (msg.type === 'progress') {
			if (p.onProgress) p.onProgress(msg);
			return;                                    // search still running
		}
		this._pending.delete(msg.id);
		if (msg.type === 'error') p.reject(new Error(msg.message));
		else if (msg.type === 'ready') p.resolve(msg.info);
		else p.resolve(msg.res);
	}

	_onWorkerError(e) {
		const err = new Error('Rust engine worker crashed: ' +
			((e && e.message) || 'unknown') +
			'. If this is the first run, the engine download may have failed — ' +
			'reload while online.');
		for (const p of this._pending.values()) p.reject(err);
		this._pending.clear();
		if (this._worker) { this._worker.terminate(); this._worker = null; }
		this._readyPromise = null;                    // rebuild + re-init next call
	}

	/** Fetch+compile the wasm once, off the critical path. Memoized. */
	init() {
		if (!this._readyPromise) {
			this._readyPromise = new Promise((resolve, reject) => {
				const id = this._nextId++;
				this._pending.set(id, { resolve, reject });
				this._ensureWorker().postMessage({ type: 'init', id });
			});
		}
		return this._readyPromise;
	}

	async search(req, onProgress) {
		await this.init();
		return new Promise((resolve, reject) => {
			const id = this._nextId++;
			this._pending.set(id, { resolve, reject, onProgress });
			this._worker.postMessage(Object.assign({ type: 'search', id }, req));
		});
	}

	/** Puzzles: judge the position after the mover's turn (opponent to move) and
	 *  get the opponent's reply. See wasm.rs judge_move for the result shape. */
	async judge(req) {
		await this.init();
		return new Promise((resolve, reject) => {
			const id = this._nextId++;
			this._pending.set(id, { resolve, reject });
			this._worker.postMessage(Object.assign({ type: 'judge', id }, req));
		});
	}

	/** Fire-and-forget control message (new_game / ponder / ponder_stop). The
	 *  worker handles messages in order, so this never races a search. */
	post(msg) {
		try { this._ensureWorker().postMessage(msg); }
		catch (e) { /* surfaced on the next search */ }
	}
}

let _rustEngineWorker = null;
function getRustEngineWorker() {
	if (!_rustEngineWorker) _rustEngineWorker = new RustEngineWorker();
	return _rustEngineWorker;
}

class RustAI {
	constructor(options) {
		options = options || {};
		this.transport = options.transport || 'worker';
		this.endpoint = options.endpoint || '/api/move';
		this.timeMs = (options.timeLimit !== undefined ? options.timeLimit : 60) * 1000;
		// Game clock (v15): `{ baseMs, incMs }` gives the AI a whole-game clock
		// instead of a fixed per-move budget. Each move gets
		// RustAI.moveBudgetMs(remaining, inc, movesPlayed) -- the engine's
		// `search::move_budget_ms`, mirrored here so the browser needs no
		// round trip -- and the exact-clock search spends exactly that. The
		// clock is charged with the WALL time of the move (search plus
		// messaging) and credited the increment afterwards; it never goes
		// below zero and never stops the AI (Sigil has no time forfeit).
		this.clock = options.clock ? { baseMs: options.clock.baseMs | 0, incMs: options.clock.incMs | 0 } : null;
		this.clockMs = this.clock ? this.clock.baseMs : null;
		this.movesPlayed = 0;
		this.lastBudgetMs = null;
		// Engine config, mirroring serve.py's shipped defaults. Deviating from
		// these is a measured strength loss (see py.rs's warnings on eval).
		this.ttBits = options.ttBits || 20;
		this.widthScale = options.widthScale || 4;
		this.evalName = options.evalName || 'tfit';
		this.adaptive = options.adaptive || [0.10, 2, 6];
		// Pondering: while the human thinks, the worker searches the position
		// they are looking at and primes the persistent table (TT priming, as
		// caveman-ai.js does). Set by game-board-local.js from the account
		// setting; `ponderPolicy` 'default-on' means ponder unless the user has
		// explicitly turned it off (anonymous players have no profile).
		this.pondering = false;
		this.ponderPolicy = options.ponderPolicy || 'setting';
		this.ponderSliceMs = options.ponderSliceMs || 250;
		this.ponderMaxDepth = options.ponderMaxDepth || 12;
		this.lastMeta = null;
		this._historySfns = [];
		// One RustAI per game: reset the worker's persistent table so a previous
		// game's entries cannot leak into this one.
		if (this.transport === 'worker') {
			try { getRustEngineWorker().post({ type: 'new_game', ttBits: this.ttBits }); }
			catch (e) { /* surfaced on first move */ }
		}
	}

	/** Per-move budget from a game clock: `search::move_budget_ms`, same
	 * constants (18-move horizon, floor of 6 moves, 2% reserve of at least
	 * 150 ms, 50 ms floor). Keep in step with the Rust; wasm-smoke checks. */
	static moveBudgetMs(remainingMs, incMs, movesPlayed) {
		remainingMs = Math.max(0, Math.floor(remainingMs));
		incMs = Math.max(0, Math.floor(incMs));
		const reserve = Math.max(Math.floor(remainingMs / 50), 150);
		const avail = Math.max(0, remainingMs - reserve);
		const movesLeft = Math.max(18 - movesPlayed, 6);
		const share = incMs + Math.floor(avail / movesLeft);
		return Math.max(Math.min(share, avail), 50);
	}
	/** Parse "5+0" / "10+1" (minutes + seconds per move) into { baseMs, incMs }; null if malformed. */
	static parseClock(text) {
		if (!text) return null;
		const m = /^\s*(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)\s*$/.exec(String(text));
		if (!m) return null;
		const baseMs = Math.round(parseFloat(m[1]) * 60000);
		const incMs = Math.round(parseFloat(m[2]) * 1000);
		if (!(baseMs > 0) || !(incMs >= 0)) return null;
		return { baseMs, incMs };
	}
	/** The budget the next search gets: the clock share, or the fixed per-move time. */
	nextBudgetMs() {
		if (!this.clock) return this.timeMs;
		return RustAI.moveBudgetMs(this.clockMs, this.clock.incMs, this.movesPlayed);
	}
	/** Whether pondering should be on for this AI given the auth manager's
	 *  profile. 'default-on' policy: on unless explicitly disabled. */
	ponderEnabledFor(auth) {
		if (this.ponderPolicy === 'off') return false;
		const profile = auth && auth.userProfile;
		if (this.ponderPolicy === 'default-on') {
			return !(profile && profile.enablePondering === false);
		}
		return !!(auth && auth.enablePondering);
	}

	/** Start fetching+compiling the wasm now, so the first AI move doesn't pay
	 *  for the download. Safe to call any number of times. */
	static preload() {
		try { getRustEngineWorker().init().catch(() => { /* surfaced on first move */ }); }
		catch (e) { /* surfaced on first move */ }
	}

	/**
	 * Called by the controller when the HUMAN is on move. Always records the
	 * position in the repetition history (it used to record only AI-root
	 * positions, so a threefold that repeated on the human's move was invisible
	 * to the engine). Then, if pondering is on, asks the worker to prime the
	 * table from this position until the next search or cancelPonder.
	 */
	startPonder(board) {
		if (this.transport !== 'worker') return;
		let sfn;
		try {
			if (variantHasDuplicates(board.variant)) return;
			sfn = boardToSfn(SimBoard.fromSigilBoard(board));
		} catch (e) { return; }
		if (this._historySfns[this._historySfns.length - 1] !== sfn) this._historySfns.push(sfn);
		if (!this.pondering) return;
		getRustEngineWorker().post({
			type: 'ponder', sfn: sfn, ttBits: this.ttBits, widthScale: this.widthScale,
			historySfns: this._historySfns.slice(-64), evalName: this.evalName,
			adaptive: this.adaptive, sliceMs: this.ponderSliceMs, maxDepth: this.ponderMaxDepth,
		});
	}

	cancelPonder() {
		if (this.transport !== 'worker') return;
		getRustEngineWorker().post({ type: 'ponder_stop' });
	}

	async _send(sfn, onProgress) {
		const budgetMs = this.nextBudgetMs();
		this.lastBudgetMs = budgetMs;
		// The CURRENT position is itself an occurrence for threefold counting
		// (the engine's search path does not include its root), so send it along
		// with the saved history. `_historySfns` only gains `sfn` after this
		// call, so each visit counts exactly once.
		const history = this._historySfns.slice(-64).concat([sfn]);
		if (this.transport === 'fetch') {
			try {
				const r = await fetch(this.endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						sfn: sfn,
						time_ms: budgetMs,
						history_sfns: history,
					}),
				});
				return await r.json();
			} catch (e) {
				throw new Error(
					'Rust engine unreachable at ' + this.endpoint + '. Start it with:\n' +
					'  python engine/server/serve.py --docs docs --time 60\n' +
					'and open the game from that server (http://localhost:8000/...).\n' +
					'Underlying error: ' + e);
			}
		}
		const t0 = Date.now();
		return getRustEngineWorker().search({
			sfn: sfn,
			timeMs: budgetMs,
			ttBits: this.ttBits,
			widthScale: this.widthScale,
			historySfns: history,
			evalName: this.evalName,
			adaptive: this.adaptive,
		}, (msg) => {
			// Per-completed-depth ticks; same fields the caveman meter renders.
			if (onProgress) onProgress({
				depth: msg.depth, score: msg.score, nodes: msg.nodes,
				timeMs: Date.now() - t0,
				budgetMs: budgetMs,
				clockMs: this.clockMs,
			});
		});
	}

	async pickTurn(board, color, onProgress) {
		// The Allow Duplicates variant names copies X~2/X~3, which the engine's
		// fixed spell table cannot represent (and its SFN reader would fold the
		// variant token to standard). Refuse up front with a clear message.
		if (variantHasDuplicates(board.variant)) {
			throw new Error('Rust engine error: the Allow Duplicates variant is not supported by this engine tier.');
		}
		const sim = SimBoard.fromSigilBoard(board);
		const sfn = boardToSfn(sim);
		const tMove0 = Date.now();
		const res = await this._send(sfn, onProgress);
		// Game clock: charge the wall time of the whole move, credit the increment.
		if (this.clock) {
			this.clockMs = Math.max(0, this.clockMs - (Date.now() - tMove0)) + this.clock.incMs;
			this.movesPlayed += 1;
		}
		if (!res || !res.ok) {
			throw new Error('Rust engine error: ' + ((res && res.error) || 'unknown') +
				'\nIf this mentions an out-of-scope spell, the draw includes a pack the ' +
				'engine does not implement (Tectonic / Providence / Aftershock / Ambush / Panda / Experimental).');
		}

		const turn = await rustActionsToTurn(sim, color, res.actions, res.expected_sfn);

		// `stones` / `mateIn` / `mateProven` are the engine's display report
		// (search::report): stones from the AI's POV with the even-game offset
		// applied (an even game reads 0.0, not ±0.5), mateIn in the WINNER's
		// own turns, signed (+ the AI wins), mateProven false when the search
		// was width- or window-limited ("likely win in N"). `score_ui` is the
		// legacy Caveman-unit field, kept for the fallback formatter.
		this.lastMeta = {
			depth: res.depth, nodes: res.nodes,
			// Selective depth (deepest ply the search reached) and, when the
			// root finished early, how deep the reply position was read with
			// the rest of the clock (v15 `exact_clock`).
			seldepth: (typeof res.seldepth === 'number') ? res.seldepth : null,
			overflowDepth: (typeof res.overflow_depth === 'number') ? res.overflow_depth : 0,
			score: (res.score_ui !== undefined ? res.score_ui : res.score),
			scoreCentistones: res.score,
			stones: (typeof res.stones === 'number') ? res.stones : null,
			mateIn: (typeof res.mate_in === 'number') ? res.mate_in : null,
			mateProven: !!res.mate_proven,
			// Competitive opening selector: {spell, node, reply, value} on the
			// free-placement turn, else null.
			opening: res.opening || null,
			timeMs: Math.round((res.seconds || 0) * 1000),
			// Game clock: this move's budget and what is left (after the increment).
			budgetMs: this.lastBudgetMs,
			clockMs: this.clockMs,
			clock: this.clock,
		};
		if (onProgress) onProgress(this.lastMeta);
		this._historySfns.push(sfn);
		return turn;
	}
}

/**
 * The replay gate, shared by every consumer of an engine action list: replay
 * the actions on a throwaway copy of `sim` and refuse them unless they
 * reproduce the position the engine said they would. Returns a SimTurn.
 */
async function rustActionsToTurn(sim, color, actions, expectedSfn) {
	{
		const probe = sim.copy();
		probe.enemy = (c) => (c === 'red' ? 'blue' : 'red');
		probe.getBoardStatePayload = () => ({});
		if (probe.movesLeftThisTurn === undefined) probe.movesLeftThisTurn = 1;
		try {
			await applyAITurn(probe, { actions: actions }, color, () => {});
			probe.update();
			probe.checkGameOver(color);
			probe.turnCounter++;
			probe.whoseTurn = (color === 'red') ? 'blue' : 'red';
			probe.update();
		} catch (e) {
			throw new Error('Rust engine action replay threw: ' + e);
		}
		const key = (x) => { const p = x.split(' '); return [p[0], p[1], p[3], p[4], p[5]].join(' '); };
		if (key(boardToSfn(probe)) !== key(expectedSfn)) {
			throw new Error(
				'Rust engine action list did not reproduce its own position — refusing ' +
				'the move rather than corrupting the game record.\n' +
				'  replayed: ' + key(boardToSfn(probe)) + '\n' +
				'  expected: ' + key(expectedSfn));
		}
	}
	return new SimTurn(actions.map((a) => {
		const act = new SimAction(a.type, {});
		Object.assign(act, a);
		return act;
	}));
}

/** Puzzles: judge + reply. `board` is a SigilBoard with the opponent to move. */
RustAI.judgeMove = async function (board, plies, timeMs) {
	const sim = SimBoard.fromSigilBoard(board);
	const sfn = boardToSfn(sim);
	const res = await getRustEngineWorker().judge({ sfn, plies, timeMs, ttBits: 18 });
	if (!res || !res.ok) throw new Error('Rust engine judge error: ' + ((res && res.error) || 'unknown'));
	res.turn = await rustActionsToTurn(sim, board.whoseTurn, res.actions, res.expected_sfn);
	return res;
};

if (typeof window !== 'undefined') window.RustAI = RustAI;
