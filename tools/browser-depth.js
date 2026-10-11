// Browser-depth probe: how deep does the SHIPPED wasm search get at a tier's
// real settings? Drives docs/static/wasm the way rust-worker.js does (one
// persistent `Engine`, `Engine.search` with the per-depth callback), single
// threaded, and records the time and nodes at which every iterative-deepening
// depth completed.
//
//   node tools/browser-depth.js games LINES.json OUT.jsonl [--shard k/n]
//        [--time-ms 10000] [--ponder-ms 0] [--tt-bits 20] [--ai-uid __ai_rust_hard__]
//   node tools/browser-depth.js cases CASES.json OUT.jsonl [--shard k/n] [--time-ms 10000]
//        [--field sfn|pre]
//
// `games`: replays every game of an `eval_games.py hydrate` lines file as the
//   browser played it -- `new_game` at the start, then for each position where
//   the AI (the side whose uid is --ai-uid) is to move a 10 s search on the
//   persistent table with the repetition history rust-ai.js sends (last 64
//   positions plus the root). With --ponder-ms P the engine also ponders every
//   human-to-move position for P ms in 250 ms slices to depth 12 (rust-ai.js's
//   ponderSliceMs / ponderMaxDepth), as the Hard tier does by default.
// `cases`: a benchmark suite (surprise_cases*.json, guest_2026-10_cases.json),
//   each case on a FRESH table: `--field sfn` searches the case position (the
//   human to move), `--field pre` the position before it (history[-1], the
//   AI's own decision).
//
// Tier settings mirror docs/static/scripts/game-board-local.js (rust_hard:
// time 10, ttBits 20) and rust-ai.js (widthScale 4, eval nnue_spell3,
// adaptive [0.10, 2, 6], one worker).
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WASM_DIR = process.env.SIGIL_WASM_DIR || path.join(ROOT, 'docs/static/wasm');

const argv = process.argv.slice(2);
const [mode, inPath, outPath] = argv;
function opt(name, def) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : def;
}
if (!mode || !inPath || !outPath) {
	console.error('usage: browser-depth.js games|cases IN OUT.jsonl [options]');
	process.exit(2);
}
const TIME_MS = parseInt(opt('--time-ms', '10000'), 10);
const PONDER_MS = parseInt(opt('--ponder-ms', '0'), 10);
const TT_BITS = parseInt(opt('--tt-bits', '20'), 10);
const AI_UID = opt('--ai-uid', '__ai_rust_hard__');
const FIELD = opt('--field', 'sfn');
const [shardK, shardN] = (opt('--shard', '0/1')).split('/').map((x) => parseInt(x, 10));
const EVAL = 'nnue_spell3', WIDTH = 4, ADAPT = [0.10, 2, 6];

const glue = fs.readFileSync(path.join(WASM_DIR, 'sigil_engine.js'), 'utf8');
const wasm_bindgen = new Function(glue + '\n;return wasm_bindgen;')();
const out = fs.createWriteStream(outPath, { flags: 'a' });

function search(eng, sfn, history) {
	const ticks = [];
	const t0 = process.hrtime.bigint();
	const raw = eng.search(sfn, TIME_MS, WIDTH, history, EVAL, ADAPT[0], ADAPT[1], ADAPT[2],
		(depth, score, nodes) => {
			ticks.push([depth, Math.round(Number(process.hrtime.bigint() - t0) / 1e6), nodes]);
		});
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	const r = JSON.parse(raw);
	if (!r.ok) return { ok: false, error: r.error, ms };
	return {
		ok: true, depth: r.depth, seldepth: r.seldepth, overflow_depth: r.overflow_depth,
		nodes: r.nodes, ms: Math.round(ms), knps: Math.round(r.nodes / Math.max(ms, 1)),
		stones: r.stones, mate_in: r.mate_in, ticks, expected: r.expected_sfn,
	};
}

function ponder(eng, sfn, history) {
	const r = JSON.parse(eng.ponder_begin(sfn, WIDTH, history, EVAL, ADAPT[0], ADAPT[1], ADAPT[2]));
	if (!r.ok) return null;
	const t0 = Date.now();
	let last = null;
	while (Date.now() - t0 < PONDER_MS) {
		last = JSON.parse(eng.ponder_step(Math.min(250, PONDER_MS - (Date.now() - t0)) || 1, 12));
		if (last.done) break;
	}
	eng.ponder_end();
	return last;
}

(async () => {
	await wasm_bindgen({ module_or_path: fs.readFileSync(path.join(WASM_DIR, 'sigil_engine_bg.wasm')) });
	const eng = new wasm_bindgen.Engine(TT_BITS);
	const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
	if (mode === 'games') {
		const keys = Object.keys(data).sort((a, b) => data[a].timestamp - data[b].timestamp);
		keys.forEach((g, gi) => {
			if (gi % shardN !== shardK) return;
			const game = data[g];
			const ai = game.redUid === AI_UID ? 'r' : (game.blueUid === AI_UID ? 'b' : null);
			if (!ai) return;
			eng.new_game();
			const P = game.positions;
			for (let i = 0; i < P.length; i++) {
				const mover = P[i].split(' ')[1];
				const history = P.slice(Math.max(0, i - 64), i).concat([P[i]]);
				if (mover !== ai) {
					if (PONDER_MS > 0 && i + 1 < P.length) {
						const p = ponder(eng, P[i], history);
						if (p) out.write(JSON.stringify({ g, i, ponder: p }) + '\n');
					}
					continue;
				}
				const r = search(eng, P[i], history);
				out.write(JSON.stringify(Object.assign({ g, i, ai, ponder_ms: PONDER_MS,
					played: P[i + 1] || null }, r)) + '\n');
			}
			console.error('game ' + gi + ' ' + g + ' done');
		});
	} else if (mode === 'cases') {
		data.forEach((c, k) => {
			if (k % shardN !== shardK) return;
			const hist = c.history || [];
			const sfn = FIELD === 'pre' ? hist[hist.length - 1] : c.sfn;
			const h = FIELD === 'pre' ? hist.slice(-65) : hist.slice(-64).concat([c.sfn]);
			if (!sfn) return;
			eng.new_game();
			const r = search(eng, sfn, h);
			out.write(JSON.stringify(Object.assign({ k, g: c.g, i: c.i, field: FIELD }, r)) + '\n');
		});
	} else {
		throw new Error('unknown mode ' + mode);
	}
	out.end();
})().catch((e) => { console.error(e); process.exit(1); });
