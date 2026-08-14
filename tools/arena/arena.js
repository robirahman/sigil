'use strict';
/**
 * Headless AI-vs-AI arena for the Caveman / Prune engine.
 *
 * Runs the *same* JS engine that powers the in-browser game, under Node and
 * parallelized across CPU threads, so a batch of games finishes ~N-cores
 * faster (no rendering, no postMessage round-trip). Identical search code →
 * identical move from a given position at equal search depth.
 *
 * Usage:
 *   ~/.local/node/bin/node tools/arena/arena.js [options]
 *
 * Options:
 *   --games N        number of games to play              (default 10)
 *   --time S         seconds per move, per side           (default 10)
 *   --red MODE       red AI: caveman | prune (+:keys)     (default caveman)
 *   --blue MODE      blue AI                              (default prune)
 *   --swap           alternate which AI plays red each game (fairness) (default on)
 *   --no-swap        keep colors fixed
 *   --pack KEY       spell pack for layout generation      (default core)
 *   --seed N         RNG seed for reproducible spell layouts (default time-based)
 *   --max-depth N    ply cap per search                    (default 64)
 *   --max-turns N    ply cap per game                       (default 300)
 *   --threads N      worker threads                         (default = CPU count)
 *   --require-spell S regenerate layouts until they contain spell S
 *   --json PATH      also write full per-game results as JSON
 *
 * See engine.js parseModeSpec for the `mode:key=val` spec syntax
 * (caveman | prune, with optional pure / capabs / caps / lp / refill keys).
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { loadEngine, parseModeSpec } = require('./engine.js');

function parseArgs(argv) {
	const a = {
		games: 10, time: 10, red: 'caveman', blue: 'prune',
		swap: true, pack: 'core', seed: null, maxDepth: 64, maxTurns: 300,
		threads: os.cpus().length, json: null, requireSpell: null,
	};
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i];
		const next = () => argv[++i];
		switch (k) {
			case '--games': a.games = parseInt(next(), 10); break;
			case '--time': a.time = parseFloat(next()); break;
			case '--red': a.red = next(); break;
			case '--blue': a.blue = next(); break;
			case '--swap': a.swap = true; break;
			case '--no-swap': a.swap = false; break;
			case '--pack': a.pack = next(); break;
			case '--seed': a.seed = parseInt(next(), 10); break;
			case '--max-depth': a.maxDepth = parseInt(next(), 10); break;
			case '--max-turns': a.maxTurns = parseInt(next(), 10); break;
			case '--threads': a.threads = parseInt(next(), 10); break;
			case '--require-spell': a.requireSpell = next(); break;
			case '--json': a.json = next(); break;
			default: throw new Error(`Unknown option: ${k}`);
		}
	}
	return a;
}

// Small seeded PRNG (mulberry32) so spell layouts are reproducible.
function mulberry32(seed) {
	let t = seed >>> 0;
	return function () {
		t += 0x6D2B79F5;
		let r = Math.imul(t ^ (t >>> 15), 1 | t);
		r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

function buildGameSpecs(args, engine) {
	// Generate spell layouts deterministically by temporarily swapping in a
	// seeded Math.random (generateSpellList uses the global Math.random).
	const seed = args.seed == null ? (Date.now() & 0x7fffffff) : args.seed;
	const rng = mulberry32(seed);
	const realRandom = Math.random;
	Math.random = rng;
	const layouts = [];
	try {
		for (let i = 0; i < args.games; i++) {
			let layout = engine.generateSpellList(args.pack);
			if (args.requireSpell) {
				let tries = 0;
				while (!layout.includes(args.requireSpell) && tries++ < 1000) {
					layout = engine.generateSpellList(args.pack);
				}
			}
			layouts.push(layout);
		}
	} finally {
		Math.random = realRandom;
	}

	const cfgA = parseModeSpec(args.red);
	const cfgB = parseModeSpec(args.blue);
	const specs = [];
	for (let i = 0; i < args.games; i++) {
		const swapped = args.swap && (i % 2 === 1);
		specs.push({
			gameId: i,
			spellNames: layouts[i],
			redCfg: swapped ? cfgB : cfgA,
			blueCfg: swapped ? cfgA : cfgB,
			timeLimit: args.time,
			maxDepth: args.maxDepth,
			maxTurns: args.maxTurns,
		});
	}
	return { specs, seed, labelA: cfgA.label, labelB: cfgB.label };
}

function shardSpecs(specs, nShards) {
	const shards = Array.from({ length: nShards }, () => []);
	specs.forEach((s, i) => shards[i % nShards].push(s));
	return shards.filter((s) => s.length > 0);
}

function fmt(n) { return n.toLocaleString('en-US'); }

// Abramowitz-Stegun 7.1.26 erf approximation (|error| <= 1.5e-7) — Node has
// no built-in erf and the arena stays dependency-free.
function erf(x) {
	const sign = x < 0 ? -1 : 1;
	const ax = Math.abs(x);
	const t = 1 / (1 + 0.3275911 * ax);
	const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
		- 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
	return sign * y;
}

function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

/**
 * Win-rate stats for A over n decisive games: Wilson 95% CI and a
 * two-sided binomial p-value (normal approximation) against p=0.5.
 */
function winStats(winsA, n) {
	if (n === 0) return null;
	const p = winsA / n;
	const z = 1.96;
	const denom = 1 + z * z / n;
	const center = (p + z * z / (2 * n)) / denom;
	const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
	const zStat = (2 * winsA - n) / Math.sqrt(n);
	const pValue = 2 * (1 - normCdf(Math.abs(zStat)));
	return { p, lo: center - half, hi: center + half, pValue };
}

function summarize(args, seed, results) {
	const A = args.red, B = args.blue;
	const tally = { A: 0, B: 0, draw: 0, error: 0 };
	const perMode = {};
	for (const m of [A, B]) {
		perMode[m] = { moves: 0, nodes: 0, cutoffs: 0, depthSum: 0, maxDepth: 0, timeMs: 0 };
	}
	const reasons = {};
	let totalPlies = 0;

	for (const r of results) {
		if (!r.ok) { tally.error++; continue; }
		const g = r.result;
		reasons[g.endReason] = (reasons[g.endReason] || 0) + 1;
		totalPlies += g.plies;
		const redAI = g.redMode, blueAI = g.blueMode;
		if (g.winner === 'red') bump(redAI);
		else if (g.winner === 'blue') bump(blueAI);
		else tally.draw++;
		accumulate(perMode[redAI], g.stats.red);
		accumulate(perMode[blueAI], g.stats.blue);
	}
	function bump(aiMode) { if (aiMode === A) tally.A++; else tally.B++; }
	function accumulate(dst, src) {
		dst.moves += src.moves; dst.nodes += src.nodes; dst.cutoffs += src.cutoffs;
		dst.depthSum += src.depthSum; dst.timeMs += src.timeMs;
		dst.maxDepth = Math.max(dst.maxDepth, src.maxDepth);
	}

	const line = '─'.repeat(64);
	console.log('\n' + line);
	console.log(`ARENA RESULTS   seed=${seed}  games=${args.games}  ${args.time}s/move  pack=${args.pack}`);
	console.log(`  color fairness: ${args.swap ? 'on (colors alternate)' : 'off'}`);
	console.log(line);
	console.log(`  ${A.padEnd(16)} wins: ${tally.A}`);
	console.log(`  ${B.padEnd(16)} wins: ${tally.B}`);
	console.log(`  draws: ${tally.draw}   errors: ${tally.error}`);
	// Significance on decisive games only (draws here are turn-cap
	// non-results; threefold repetition already scores as a blue win).
	// Only meaningful when the two arms have distinct spec labels —
	// identical labels collapse into tally.A.
	const ws = winStats(tally.A, tally.A + tally.B);
	if (ws && A !== B) {
		const sig = ws.pValue < 0.05 ? '  (p<0.05)' : '';
		console.log(`  ${A} win rate: ${(ws.p * 100).toFixed(1)}%  `
			+ `Wilson 95% CI [${(ws.lo * 100).toFixed(1)}%, ${(ws.hi * 100).toFixed(1)}%]  `
			+ `p=${ws.pValue.toFixed(4)}${sig}`);
	}
	console.log(`  end reasons: ${JSON.stringify(reasons)}`);
	console.log(`  avg plies/game: ${(totalPlies / Math.max(1, args.games - tally.error)).toFixed(1)}`);
	console.log(line);
	console.log(`  ${'engine'.padEnd(16)} ${'moves'.padStart(7)} ${'avgDepth'.padStart(9)} ${'maxD'.padStart(5)} ${'nodes'.padStart(14)} ${'nodes/s'.padStart(12)} ${'ttCuts/mv'.padStart(11)}`);
	for (const m of [A, B]) {
		const p = perMode[m];
		const avgDepth = p.moves ? (p.depthSum / p.moves) : 0;
		const nps = p.timeMs ? (p.nodes / (p.timeMs / 1000)) : 0;
		const avgCut = p.moves ? (p.cutoffs / p.moves) : 0;
		console.log(`  ${m.padEnd(16)} ${String(p.moves).padStart(7)} ${avgDepth.toFixed(2).padStart(9)} ${String(p.maxDepth).padStart(5)} ${fmt(p.nodes).padStart(14)} ${fmt(Math.round(nps)).padStart(12)} ${fmt(Math.round(avgCut)).padStart(11)}`);
	}
	console.log(line);
	console.log('  caveman enumerates every legal turn (no caps) so it reaches');
	console.log('  shallower avgDepth at equal time; prune ranks top-1 per choice');
	console.log('  point and searches deeper. Win-rate is the strength signal;');
	console.log('  avgDepth/nodes are the cost/coverage trade.');
	console.log(line + '\n');
}

async function main() {
	const args = parseArgs(process.argv);
	const engine = loadEngine();
	const { specs, seed } = buildGameSpecs(args, engine);

	const nThreads = Math.max(1, Math.min(args.threads, specs.length));
	const shards = shardSpecs(specs, nThreads);
	console.log(`Launching ${args.games} games across ${shards.length} worker thread(s) `
		+ `on ${os.cpus().length} logical CPUs…`);
	console.log(`  ${args.red}  vs  ${args.blue}   @ ${args.time}s/move, depth≤${args.maxDepth}`);

	const results = [];
	let finished = 0;
	const startWall = Date.now();

	await Promise.all(shards.map((shardSpecsList) => new Promise((resolve, reject) => {
		const w = new Worker(path.join(__dirname, 'worker.js'), {
			workerData: { specs: shardSpecsList },
		});
		w.on('message', (msg) => {
			if (msg.done) { resolve(); return; }
			results.push(msg);
			finished++;
			if (msg.ok) {
				const g = msg.result;
				const w1 = g.winner ? `${g.winner} wins` : 'draw';
				process.stdout.write(
					`  [${String(finished).padStart(3)}/${args.games}] game ${g.gameId}: `
					+ `${g.redMode}(R) vs ${g.blueMode}(B) → ${w1} in ${g.plies} plies `
					+ `(${(g.durationMs / 1000).toFixed(1)}s, ${g.endReason})\n`);
			} else {
				process.stdout.write(`  [game ${msg.gameId}] ERROR: ${msg.error.split('\n')[0]}\n`);
			}
		});
		w.on('error', reject);
		w.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
	})));

	const wallSec = (Date.now() - startWall) / 1000;
	summarize(args, seed, results);
	console.log(`Total wall time: ${wallSec.toFixed(1)}s for ${args.games} games `
		+ `(${(wallSec / args.games).toFixed(1)}s/game wall; sequential would be ~${shards.length}x longer).`);

	if (args.json) {
		const out = results.filter((r) => r.ok).map((r) => r.result);
		fs.writeFileSync(args.json, JSON.stringify({ args, seed, games: out }, null, 2));
		console.log(`Wrote per-game results to ${args.json}`);
	}
}

main().catch((err) => { console.error(err); process.exit(1); });
