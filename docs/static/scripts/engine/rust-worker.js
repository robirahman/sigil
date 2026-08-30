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
 *          historySfns, evalName, adaptive: [p, easy, hard] }
 *   out: { type:'ready',    id, info }
 *   out: { type:'progress', id, depth, score, nodes }   // per completed depth
 *   out: { type:'result',   id, res }                   // res = /api/move JSON
 *   out: { type:'error',    id, message }
 *
 * No 'cancel': the search is ONE synchronous wasm call, so no message can be
 * delivered mid-search (progress works because postMessage from inside the
 * call is queued, not delivered). RustAI's cancelPonder is a no-op to match.
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

self.onmessage = async (e) => {
	const msg = e.data || {};
	const id = msg.id;
	try {
		if (msg.type === 'init') {
			const info = await ensureInit();
			self.postMessage({ type: 'ready', id, info });
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
			const a = msg.adaptive || [0, 0, 0];
			const raw = wasm_bindgen.pick_move_actions(
				msg.sfn,
				msg.timeMs >>> 0,
				(msg.ttBits || 20) >>> 0,
				(msg.widthScale || 4) >>> 0,
				msg.historySfns || [],
				msg.evalName || 'tfit',
				a[0] || 0, (a[1] || 0) >>> 0, (a[2] || 0) >>> 0,
				(depth, score, nodes) => {
					self.postMessage({ type: 'progress', id, depth, score, nodes });
				});
			self.postMessage({ type: 'result', id, res: JSON.parse(raw) });
		} finally {
			_busy = false;
		}
	} catch (err) {
		self.postMessage({ type: 'error', id, message: String((err && err.message) || err) });
	}
};
