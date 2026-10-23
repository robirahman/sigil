'use strict';
/**
 * The server's own price of a start position: P(red wins) for a game from a
 * position, which sets its Elo payoffs (elo.js computeEloChange). The price
 * a client sends with a game (startPos.redWinProb) is only a claim; the
 * rating uses this one, computed the way the site computes it
 * (position-rating.js evaluateStartPosition + positionRedWinProb) with the
 * same wasm engine build (docs/static/wasm) and calibration
 * (docs/static/data/position-winprob.json).
 *
 * One engine for the process: rateGame runs one game at a time.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ENGINE_FILES, engineDir } = require('./engine-loader');

function assetDir(sub) {
	const copied = path.join(__dirname, sub);
	if (fs.existsSync(copied)) return copied;
	return path.resolve(__dirname, '..', 'docs', 'static', sub);
}

let _loaded = null;

async function load() {
	if (_loaded) return _loaded;
	const wasmDir = assetDir('wasm');
	const files = [...ENGINE_FILES, 'position-rating.js'];
	const src = files.map((f) => fs.readFileSync(path.join(engineDir(), f), 'utf8')).join('\n;\n')
		+ '\n;\n' + fs.readFileSync(path.join(wasmDir, 'sigil_engine.js'), 'utf8')
		// The init options object must come from this context's own realm
		// (the glue checks its prototype), so it is built in here.
		+ '\n;\nglobalThis.__p = { wasm_bindgen, positionRedWinProb, RUST_REVIEW_SEARCH, POSITION_EVAL_MS,'
		+ ' init: (bytes) => wasm_bindgen({ module_or_path: bytes }) };';
	const ctx = {
		console: { log() {}, info() {}, debug() {}, warn: console.warn, error: console.error },
		setTimeout, clearTimeout, Promise, Math, Date, JSON, WebAssembly, TextDecoder, TextEncoder,
	};
	vm.createContext(ctx);
	vm.runInContext(src, ctx, { filename: 'sigil-pricing-bundle.js' });
	const p = ctx.__p;
	await p.init(fs.readFileSync(path.join(wasmDir, 'sigil_engine_bg.wasm')));
	const model = JSON.parse(fs.readFileSync(path.join(assetDir('data'), 'position-winprob.json'), 'utf8'));
	_loaded = { p, model, engine: new p.wasm_bindgen.Engine(20) };
	return _loaded;
}

/**
 * P(red wins) for a game whose first turn opens on `sfn` (the side to move's
 * SFN, as startPos.sfn holds it), or null when the engine cannot price it.
 */
async function priceStart(sfn) {
	const { p, model, engine } = await load();
	engine.new_game();
	const s = p.RUST_REVIEW_SEARCH;
	const a = s.adaptive || [0, 0, 0];
	let res = null;
	for (let tms = p.POSITION_EVAL_MS, k = 0; k < 3; k++, tms *= 3) {
		res = JSON.parse(engine.search(sfn, tms >>> 0, (s.widthScale || 4) >>> 0, [sfn], s.evalName,
			a[0] || 0, (a[1] || 0) >>> 0, (a[2] || 0) >>> 0, () => {}));
		if (!res || res.ok === false) return null;
		const proven = typeof res.mate_in === 'number' && res.mate_in !== 0 && res.mate_proven;
		if ((res.depth || 0) >= 4 || proven) break;
	}
	const sign = String(sfn).split(' ')[1] === 'r' ? 1 : -1;
	const info = {
		depth: res.depth || 0,
		stones: typeof res.stones === 'number' ? res.stones * sign : null,
		mateIn: (typeof res.mate_in === 'number' && res.mate_in !== 0) ? res.mate_in * sign : null,
		proven: res.mate_in == null ? true : !!res.mate_proven,
	};
	const prob = p.positionRedWinProb(model, info, sfn);
	return typeof prob === 'number' ? prob : null;
}

module.exports = { priceStart };
