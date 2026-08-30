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
 * Tectonic, Providence, Aftershock, Ambush or the fan-made Panda pack and rejects
 * positions containing them rather than mis-resolving.
 */

// Bumped on every committed engine rebuild (see engine/build-wasm.sh). Threaded
// as ?v= onto the worker, glue and .wasm URLs so the service worker's cached
// copies can never be stale — an old set is simply never requested again.
const RUST_ENGINE_VERSION = 1;

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
		// Engine config, mirroring serve.py's shipped defaults. Deviating from
		// these is a measured strength loss (see py.rs's warnings on eval).
		this.ttBits = options.ttBits || 20;
		this.widthScale = options.widthScale || 4;
		this.evalName = options.evalName || 'tfit';
		this.adaptive = options.adaptive || [0.10, 2, 6];
		this.pondering = false;      // the search lives in another thread/process
		this.lastMeta = null;
		this._historySfns = [];
	}

	/** Start fetching+compiling the wasm now, so the first AI move doesn't pay
	 *  for the download. Safe to call any number of times. */
	static preload() {
		try { getRustEngineWorker().init().catch(() => { /* surfaced on first move */ }); }
		catch (e) { /* surfaced on first move */ }
	}

	cancelPonder() { /* nothing to cancel: one synchronous search per move */ }

	async _send(sfn, onProgress) {
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
						time_ms: this.timeMs,
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
			timeMs: this.timeMs,
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
			});
		});
	}

	async pickTurn(board, color, onProgress) {
		const sim = SimBoard.fromSigilBoard(board);
		const sfn = boardToSfn(sim);

		const res = await this._send(sfn, onProgress);
		if (!res || !res.ok) {
			throw new Error('Rust engine error: ' + ((res && res.error) || 'unknown') +
				'\nIf this mentions an out-of-scope spell, the draw includes a pack the ' +
				'engine does not implement (Tectonic / Providence / Aftershock / Ambush / Panda).');
		}

		// Verify the actions reproduce the engine's position BEFORE playing them on
		// the real board: replay on a throwaway copy and compare.
		const probe = sim.copy();
		probe.enemy = (c) => (c === 'red' ? 'blue' : 'red');
		probe.getBoardStatePayload = () => ({});
		if (probe.movesLeftThisTurn === undefined) probe.movesLeftThisTurn = 1;
		try {
			await applyAITurn(probe, { actions: res.actions }, color, () => {});
			probe.update();
			probe.checkGameOver(color);
			probe.turnCounter++;
			probe.whoseTurn = (color === 'red') ? 'blue' : 'red';
			probe.update();
		} catch (e) {
			throw new Error('Rust engine action replay threw: ' + e);
		}
		const key = (x) => { const p = x.split(' '); return [p[0], p[1], p[3], p[4], p[5]].join(' '); };
		if (key(boardToSfn(probe)) !== key(res.expected_sfn)) {
			throw new Error(
				'Rust engine action list did not reproduce its own position — refusing ' +
				'the move rather than corrupting the game record.\n' +
				'  replayed: ' + key(boardToSfn(probe)) + '\n' +
				'  expected: ' + key(res.expected_sfn));
		}

		// `score_ui` is already in the units game-board-local.js renders (it
		// multiplies by 39 and treats |s| >= 37 as a proven mate). Passing raw
		// centistones inflated the display 3900x and made ordinary positions
		// print as forced wins, e.g. "win in -94".
		this.lastMeta = {
			depth: res.depth, nodes: res.nodes,
			score: (res.score_ui !== undefined ? res.score_ui : res.score),
			scoreCentistones: res.score,
			timeMs: Math.round((res.seconds || 0) * 1000),
		};
		if (onProgress) onProgress(this.lastMeta);
		this._historySfns.push(sfn);
		return new SimTurn(res.actions.map((a) => {
			const act = new SimAction(a.type, {});
			Object.assign(act, a);
			return act;
		}));
	}
}

if (typeof window !== 'undefined') window.RustAI = RustAI;
