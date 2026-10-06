// Step 5 parity gate: the wasm build's network output must equal the golden
// vectors (engine/nets/nnue_spell_golden.txt), which `nn_matches_the_python_reference`
// already pins for Python == native. Integer-only arithmetic makes this hold by
// construction; this checks the construction (usize width, i64 product, parsing).
//
//   node tools/nn-wasm-parity.js [WASM_DIR]   (default docs/static/wasm)
//
// The shipped wasm in docs/ predates nn_eval_raw; build one first, e.g.
//   (cd engine && cargo build --release --target wasm32-unknown-unknown \
//      --no-default-features --features wasm && wasm-bindgen --target no-modules \
//      --no-typescript --out-dir /tmp/nnwasm --out-name sigil_engine \
//      target/wasm32-unknown-unknown/release/sigil_engine.wasm)
//   node tools/nn-wasm-parity.js /tmp/nnwasm
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WASM_DIR = path.resolve(process.argv[2] || path.join(ROOT, 'docs/static/wasm'));
const glue = fs.readFileSync(path.join(WASM_DIR, 'sigil_engine.js'), 'utf8');
const wasm_bindgen = new Function(glue + '\n;return wasm_bindgen;')();
(async () => {
	await wasm_bindgen({ module_or_path: fs.readFileSync(path.join(WASM_DIR, 'sigil_engine_bg.wasm')) });
	if (typeof wasm_bindgen.nn_eval_raw !== 'function') throw new Error('this build has no nn_eval_raw');
	const lines = fs.readFileSync(path.join(ROOT, 'engine/nets/nnue_spell_golden.txt'), 'utf8')
		.split('\n').filter(Boolean);
	let bad = 0;
	for (const line of lines) {
		const [mine, theirs, sp, red, want] = line.split(' ');
		const got = wasm_bindgen.nn_eval_raw(Uint8Array.from(sp.split(',').map(Number)),
			BigInt(mine), BigInt(theirs), red === '1');
		if (got !== Number(want)) { bad++; if (bad <= 5) console.error('MISMATCH ' + line + ' got ' + got); }
	}
	if (lines.length < 50) throw new Error('only ' + lines.length + ' golden vectors');
	if (bad) { console.error(bad + ' of ' + lines.length + ' differ'); process.exit(1); }
	console.log('nn wasm parity OK: ' + lines.length + ' golden vectors match');
})().catch((e) => { console.error(e); process.exit(1); });
