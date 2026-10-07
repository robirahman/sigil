// Node-vs-Chrome speed of the shipped wasm on IDENTICAL trees (round-3 gate calibration).
//
//   node tools/browser/wasm-speed.js node [DEPTH=4] [POSITIONS] [REPS=1]
//   node tools/browser/wasm-speed.js page OUT.html [DEPTH=4] [POSITIONS] [REPS=1]
//   <chrome-headless-shell> --headless --dump-dom file://OUT.html | grep RESULT
//
// Each position gets a clockless fixed-depth search on a fresh table (`bench_hash`,
// the shipped policy and nnue_spell3), so both runtimes search the same nodes and
// the wall-time ratio is a pure speed ratio. The page inlines the glue and the
// wasm (base64) and runs synchronously during load (`initSync`), so --dump-dom
// prints the result without any server.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const WASM_DIR = process.env.SIGIL_WASM_DIR || path.join(ROOT, 'docs/static/wasm');
const [mode, ...rest] = process.argv.slice(2);
const outHtml = mode === 'page' ? rest.shift() : null;
const DEPTH = parseInt(rest[0] || '4', 10);
const POS = path.resolve(rest[1] || path.join(ROOT, 'engine/harness/positions_midgame.txt'));
const REPS = parseInt(rest[2] || '1', 10);
const positions = fs.readFileSync(POS, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

function bench(wb, positions, depth, reps, now) {
	let nodes = 0;
	const t0 = now();
	for (let r = 0; r < reps; r++) {
		for (const p of positions) {
			const res = JSON.parse(wb.bench_hash(p, depth, 'nnue_spell3', 20));
			if (!res.ok) throw new Error(res.error);
			nodes += res.nodes;
		}
	}
	const ms = now() - t0;
	return { positions: positions.length, depth, reps, nodes, ms: Math.round(ms), knps: Math.round(nodes / ms) };
}

const glue = fs.readFileSync(path.join(WASM_DIR, 'sigil_engine.js'), 'utf8');
const wasm = fs.readFileSync(path.join(WASM_DIR, 'sigil_engine_bg.wasm'));
if (mode === 'node') {
	const wb = new Function(glue + '\n;return wasm_bindgen;')();
	wb.initSync({ module: wasm });
	console.log('RESULT node ' + process.version + ' ' + JSON.stringify(bench(wb, positions, DEPTH, REPS, () => performance.now())));
} else if (mode === 'page') {
	const html = `<!doctype html><meta charset="utf-8"><title>wasm speed</title><pre id="out"></pre>
<script>${glue}</script>
<script>
const b64 = ${JSON.stringify(wasm.toString('base64'))};
const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
wasm_bindgen.initSync({ module: bytes });
const positions = ${JSON.stringify(positions)};
${bench.toString()}
let out;
try { out = 'RESULT chrome ' + navigator.userAgent.match(/Chrome\\/[0-9.]+/) + ' ' +
	JSON.stringify(bench(wasm_bindgen, positions, ${DEPTH}, ${REPS}, () => performance.now())); }
catch (e) { out = 'RESULT error ' + e; }
document.getElementById('out').textContent = out;
</script>`;
	fs.writeFileSync(outHtml, html);
	console.log('wrote ' + outHtml);
} else {
	console.error('usage: wasm-speed.js node|page ...');
	process.exit(2);
}
