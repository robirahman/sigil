'use strict';
/**
 * Web Worker hosting the Rust engine's WebAssembly build.
 *
 * Classic worker (importScripts), because the wasm glue is built with
 * `wasm-bindgen --target no-modules` — the only form loadable from the classic
 * scripts this site ships. The main thread appends `?v=<RUST_ENGINE_VERSION>`
 * to this worker's URL; the same v is threaded onto the glue and .wasm URLs so
 * the three files always update as one atomic, cache-busted set (docs/sw.js
 * precaches exactly these versioned URLs).
 *
 * Protocol (mirrors ai-worker.js):
 *   in:  { type:'configure', threads }     // first message: pool size (threads > 1
 *                                          // loads the threaded engine when this
 *                                          // worker is cross-origin isolated)
 *   in:  { type:'init',   id }
 *   in:  { type:'search', id, sfn, timeMs, ttBits, widthScale, threads?,
 *          historySfns, evalName, adaptive: [p, easy, hard],
 *          split?: [part, parts] }       // step 6 root split (prototype, off by default)
 *   in:  { type:'new_game', ttBits }                    // forget the last game
 *   in:  { type:'ponder', sfn, ttBits, widthScale, threads?, historySfns, evalName,
 *          adaptive, sliceMs, maxDepth }                // prime the TT while the human thinks
 *   in:  { type:'ponder_stop' }
 *   in:  { type:'judge', id, sfn, plies, timeMs, ttBits }   // puzzles: verdict + reply
 *   out: { type:'ready',    id, info }
 *   out: { type:'progress', id, depth, score, nodes }   // per completed depth
 *   out: { type:'result',   id, res }                   // res = /api/move JSON
 *   out: { type:'error',    id, message }
 *   out: { type:'ponder_progress', depth, nodes }       // per ponder slice
 *
 * ONE persistent `Engine` (one transposition table) lives here for the whole
 * game, so each move starts from the table the previous move -- and the ponder
 * -- filled. A search is still one synchronous wasm call and cannot be
 * interrupted; pondering therefore runs in SLICES (`Engine.ponder_step`) with a
 * `setTimeout(…, 0)` between them, so a queued `search` or `ponder_stop`
 * message is handled within one slice.
 */

const V = new URLSearchParams(self.location.search).get('v') || '0';
const GLUE_URL = new URL('../../wasm/sigil_engine.js?v=' + V, self.location.href).href;
const WASM_URL = new URL('../../wasm/sigil_engine_bg.wasm?v=' + V, self.location.href).href;

// Threaded engine (2026-10-12, engine/build-wasm-mt.sh): the native parallel
// root on rayon's pool of Web Workers over shared wasm memory. Its glue is an ES
// module (rayon's workers are module workers), loaded with a dynamic import();
// SharedArrayBuffer needs this worker to be cross-origin isolated (docs/sw.js
// adds COOP/COEP to the game pages), so anywhere else the single-threaded
// engine below loads instead. Same protocol either way.
const MT_GLUE_URL = new URL('../../wasm-mt/sigil_engine_mt.js?v=' + V, self.location.href).href;
const MT_WASM_URL = new URL('../../wasm-mt/sigil_engine_mt_bg.wasm?v=' + V, self.location.href).href;

// The loaded glue: the no-modules global `wasm_bindgen`, or the threaded
// module's namespace. Both expose Engine, judge_move and engine_info.
let api = null;
let _threads = 1;
let _wantThreads = 1;   // from 'configure', which precedes every engine load
let _mtError = null;   // why the threaded engine did not load (reported in `info`)

function threadsUsable(n) {
	return n > 1 && self.crossOriginIsolated === true
		&& typeof SharedArrayBuffer !== 'undefined';
}

let _initPromise = null;
function ensureInit() {
	if (!_initPromise) {
		_initPromise = (async () => {
			const want = Math.max(1, Math.min(16, _wantThreads | 0 || 1));
			if (threadsUsable(want)) {
				try {
					const mt = await import(MT_GLUE_URL);
					await mt.default({ module_or_path: MT_WASM_URL });
					await mt.initThreadPool(want);
					api = mt;
					_threads = want;
				} catch (err) {
					api = null;                // fall back to one thread
					_mtError = String((err && err.message) || err);
				}
			} else if (want > 1) {
				_mtError = self.crossOriginIsolated ? 'no SharedArrayBuffer' : 'not cross-origin isolated';
			}
			if (!api) {
				importScripts(GLUE_URL);       // defines the global `wasm_bindgen`
				await wasm_bindgen({ module_or_path: WASM_URL });
				api = wasm_bindgen;
				_threads = 1;
			}
			return Object.assign(JSON.parse(api.engine_info()), { threads: _threads, threads_error: _mtError });
		})();
	}
	return _initPromise;
}

let _busy = false;

// The persistent engine, keyed by table size. Every other setting is passed
// per call (they are the same for a whole game in practice).
let _engine = null;
let _engineTtBits = 0;
function engineFor(ttBits) {
	const bits = (ttBits || 20) >>> 0;
	if (!_engine || _engineTtBits !== bits) {
		if (_engine && typeof _engine.free === 'function') _engine.free();
		_engine = new api.Engine(bits);       // one thread until a search/ponder asks
		_engineTtBits = bits;
	}
	return _engine;
}

// Threaded engine: the thread count a search or ponder asked for, at most the
// pool's (a request without one gets a single thread).
function applyThreads(eng, want) {
	if (_threads > 1) eng.set_threads(Math.max(1, Math.min(_threads, (want | 0) || 1)));
}

// Pondering state. `active` is cleared by a search or a ponder_stop; the loop
// re-checks it between slices.
const _ponder = { active: false, sliceMs: 250, maxDepth: 12 };

function ponderLoop() {
	if (!_ponder.active || _busy || !_engine) return;
	let res;
	try {
		res = JSON.parse(_engine.ponder_step(_ponder.sliceMs, _ponder.maxDepth));
	} catch (err) {
		_ponder.active = false;
		return;
	}
	self.postMessage({ type: 'ponder_progress', depth: res.depth, nodes: res.nodes });
	if (res.done) { _ponder.active = false; return; }
	setTimeout(ponderLoop, 0);
}

self.onmessage = async (e) => {
	const msg = e.data || {};
	const id = msg.id;
	try {
		if (msg.type === 'configure') {
			if (!_initPromise) _wantThreads = (msg.threads | 0) || 1;
			return;
		}
		if (msg.type === 'init') {
			const info = await ensureInit();
			self.postMessage({ type: 'ready', id, info });
			return;
		}
		if (msg.type === 'ponder_stop') {
			_ponder.active = false;
			if (_engine) _engine.ponder_end();
			return;
		}
		if (msg.type === 'new_game') {
			await ensureInit();
			_ponder.active = false;
			engineFor(msg.ttBits).new_game();
			return;
		}
		if (msg.type === 'ponder') {
			await ensureInit();
			if (_busy) return;                 // a real search owns the engine
			const a = msg.adaptive || [0, 0, 0];
			const eng = engineFor(msg.ttBits);
			applyThreads(eng, msg.threads);
			// A ponder always reads the whole root, whatever split the last search used.
			if (typeof eng.set_root_split === 'function') eng.set_root_split(0, 1);
			const r = JSON.parse(eng.ponder_begin(
				msg.sfn, (msg.widthScale || 4) >>> 0, msg.historySfns || [],
				msg.evalName || 'nnue_mt256', a[0] || 0, (a[1] || 0) >>> 0, (a[2] || 0) >>> 0));
			if (!r.ok) return;                 // out-of-scope position: nothing to ponder
			_ponder.sliceMs = (msg.sliceMs || 250) >>> 0;
			_ponder.maxDepth = (msg.maxDepth || 12) | 0;
			_ponder.active = true;
			setTimeout(ponderLoop, 0);
			return;
		}
		if (msg.type === 'judge') {
			if (_busy) { self.postMessage({ type: 'error', id, message: 'engine is already searching' }); return; }
			_busy = true;
			try {
				await ensureInit();
				_ponder.active = false;
				const raw = api.judge_move(msg.sfn, (msg.plies || 2) >>> 0,
					(msg.timeMs || 4000) >>> 0, (msg.ttBits || 18) >>> 0);
				self.postMessage({ type: 'result', id, res: JSON.parse(raw) });
			} finally {
				_busy = false;
			}
			return;
		}
		if (msg.type !== 'search') return;
		if (_busy) {
			// One AI per page makes this unreachable in practice; refuse rather
			// than queue so a bug upstream surfaces instead of stacking searches.
			self.postMessage({ type: 'error', id, message: 'engine is already searching' });
			return;
		}
		_busy = true;
		try {
			await ensureInit();
			_ponder.active = false;            // the real search takes over the table
			const a = msg.adaptive || [0, 0, 0];
			const onDepth = (depth, score, nodes) => {
				self.postMessage({ type: 'progress', id, depth, score, nodes });
			};
			const eng = engineFor(msg.ttBits);
			applyThreads(eng, msg.threads);
			// Step 6 option A (prototype): `split: [part, parts]` searches one part
			// of the root; absent = the whole root, as before. An older wasm without
			// the method searches the whole root and the coordinator still works.
			if (typeof eng.set_root_split === 'function') {
				const sp = Array.isArray(msg.split) ? msg.split : [0, 1];
				eng.set_root_split(sp[0] >>> 0, sp[1] >>> 0);
			}
			const raw = eng.search(
				msg.sfn, msg.timeMs >>> 0, (msg.widthScale || 4) >>> 0,
				msg.historySfns || [], msg.evalName || 'nnue_mt256',
				a[0] || 0, (a[1] || 0) >>> 0, (a[2] || 0) >>> 0, onDepth);
			const res = JSON.parse(raw);
			res.threads = _threads;
			res.threads_wanted = _wantThreads;
			if (_mtError) res.mt_error = _mtError;
			self.postMessage({ type: 'result', id, res });
		} finally {
			_busy = false;
		}
	} catch (err) {
		self.postMessage({ type: 'error', id, message: String((err && err.message) || err) });
	}
};
