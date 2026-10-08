// v25 parity gate for the policy-ordered search: the wasm build must search the
// SAME tree as the native engine with the shipped generator policy and eval. The
// policy scores options with f32 arithmetic, so unlike the integer network this is
// not equal by construction; this checks it.
//
// Each position gets a clockless fixed-depth search on a fresh table
// (wasm `bench_hash`), hashed exactly as engine/examples/bench.rs hashes one, and
// the per-position hashes are combined the same way. Compare against
//   (cd engine && cargo run --release --no-default-features --example bench -- \
//      harness/positions_midgame.txt DEPTH --shipped)
// which prints `... HASH <hex>` on its TOTAL line. The wasm applies the shipped policy
// AND (v28+) the shipped exploration tail (policy::SHIPPED_EXPLORE) by default;
// EXPLORE=0 here matches `bench ... --shipped --explore off`.
//
//   node tools/policy-wasm-parity.js EXPECTED_HASH [DEPTH=4] [EVAL=nnue_spell]
//        [POSITIONS=engine/harness/positions_midgame.txt] [WASM_DIR=docs/static/wasm]
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const [want, depthArg, evalArg, posArg, dirArg] = process.argv.slice(2);
if (!want) { console.error('usage: policy-wasm-parity.js EXPECTED_HASH [DEPTH] [EVAL] [POSITIONS] [WASM_DIR]'); process.exit(2); }
const DEPTH = parseInt(depthArg || '4', 10);
const EVAL = evalArg || 'nnue_spell';
const POSITIONS = path.resolve(posArg || path.join(ROOT, 'engine/harness/positions_midgame.txt'));
const WASM_DIR = path.resolve(dirArg || path.join(ROOT, 'docs/static/wasm'));
const glue = fs.readFileSync(path.join(WASM_DIR, 'sigil_engine.js'), 'utf8');
const wasm_bindgen = new Function(glue + '\n;return wasm_bindgen;')();

function fnv(h, s) {
	for (const b of Buffer.from(s, 'utf8')) {
		h ^= BigInt(b);
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return h;
}

(async () => {
	await wasm_bindgen({ module_or_path: fs.readFileSync(path.join(WASM_DIR, 'sigil_engine_bg.wasm')) });
	if (typeof wasm_bindgen.bench_hash !== 'function') throw new Error('this build has no bench_hash');
	let combined = 0xcbf29ce484222325n;
	let n = 0, nodes = 0;
	// EXPLORE=mode,cast_window,dash_limit,dash_per,dash_tried,base,step[,slot_first,slot_every]:
	// the round 3 exploration tail (native: bench --explore with the same list).
	if (process.env.EXPLORE) {
		const v = process.env.EXPLORE.split(',').map((x) => parseInt(x, 10));
		while (v.length < 9) v.push(0);
		wasm_bindgen.set_policy_explore(...v);
	}
	for (const raw of fs.readFileSync(POSITIONS, 'utf8').split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const r = JSON.parse(wasm_bindgen.bench_hash(line, DEPTH, EVAL, 20));
		if (!r.ok) throw new Error('position ' + n + ': ' + r.error);
		combined = fnv(combined, r.hash);
		nodes += r.nodes;
		n++;
	}
	const got = combined.toString(16).padStart(16, '0');
	if (got !== want.toLowerCase()) {
		console.error('policy wasm parity FAILED: ' + n + ' positions, depth ' + DEPTH +
			', wasm HASH ' + got + ' != native ' + want);
		process.exit(1);
	}
	console.log('policy wasm parity OK: ' + n + ' positions, depth ' + DEPTH + ', ' + nodes +
		' nodes, HASH ' + got);
})().catch((e) => { console.error(e); process.exit(1); });
