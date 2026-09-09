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
 *   in:  { type:'init',   id }
 *   in:  { type:'search', id, sfn, timeMs, ttBits, widthScale,
 *          historySfns, evalName, adaptive: [p, easy, hard], fresh }
 *          (fresh: throwaway table per move -- the frozen rust_anchor tier)
 *   in:  { type:'new_game', ttBits }                    // forget the last game
 *   in:  { type:'ponder', sfn, ttBits, widthScale, historySfns, evalName,
 *          adaptive, sliceMs, maxDepth }                // prime the TT while the human thinks
 *   in:  { type:'ponder_stop' }
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

let _initPromise = null;
function ensureInit() {
	if (!_initPromise) {
		_initPromise = (async () => {
			importScripts(GLUE_URL);           // defines the global `wasm_bindgen`
			await wasm_bindgen({ module_or_path: WASM_URL });
			return JSON.parse(wasm_bindgen.engine_info());
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
		_engine = new wasm_bindgen.Engine(bits);
		_engineTtBits = bits;
	}
	return _engine;
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
			const r = JSON.parse(eng.ponder_begin(
				msg.sfn, (msg.widthScale || 4) >>> 0, msg.historySfns || [],
				msg.evalName || 'tfit', a[0] || 0, (a[1] || 0) >>> 0, (a[2] || 0) >>> 0));
			if (!r.ok) return;                 // out-of-scope position: nothing to ponder
			_ponder.sliceMs = (msg.sliceMs || 250) >>> 0;
			_ponder.maxDepth = (msg.maxDepth || 12) | 0;
			_ponder.active = true;
			setTimeout(ponderLoop, 0);
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
			const raw = msg.fresh
				// Throwaway table per move: the frozen reference engine (rust_anchor).
				? wasm_bindgen.pick_move_actions(
					msg.sfn, msg.timeMs >>> 0, (msg.ttBits || 20) >>> 0,
					(msg.widthScale || 4) >>> 0, msg.historySfns || [], msg.evalName || 'tfit',
					a[0] || 0, (a[1] || 0) >>> 0, (a[2] || 0) >>> 0, onDepth)
				: engineFor(msg.ttBits).search(
					msg.sfn, msg.timeMs >>> 0, (msg.widthScale || 4) >>> 0,
					msg.historySfns || [], msg.evalName || 'tfit',
					a[0] || 0, (a[1] || 0) >>> 0, (a[2] || 0) >>> 0, onDepth);
			self.postMessage({ type: 'result', id, res: JSON.parse(raw) });
		} finally {
			_busy = false;
		}
	} catch (err) {
		self.postMessage({ type: 'error', id, message: String((err && err.message) || err) });
	}
};
