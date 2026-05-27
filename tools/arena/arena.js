'use strict';
/**
 * Headless AI-vs-AI arena for the Caveman engine.
 *
 * Runs the *same* JS engine that powers the in-browser arena
 * (?red=...&blue=...), but under Node and parallelized across CPU threads,
 * so a batch of games finishes ~N-cores faster (no rendering, no postMessage
 * round-trip). It is the identical search code, so it makes the identical
 * move from a given position at equal search depth.
 *
 * Usage:
 *   node tools/arena/arena.js [options]
 *
 * Options:
 *   --games N        number of games to play              (default 10)
 *   --time S         seconds per move, per side           (default 10)
 *   --red MODE       red AI: pure_minimax | pruned_minimax (default pure_minimax)
 *   --blue MODE      blue AI                               (default pruned_minimax)
 *   --swap           alternate which AI plays red each game (fairness) (default on)
 *   --no-swap        keep colors fixed
 *   --pack KEY       spell pack for layout generation      (default core)
 *   --seed N         RNG seed for reproducible spell layouts (default time-based)
 *   --max-depth N    ply cap per search                    (default 64)
 *   --max-turns N    ply cap per game                       (default 300)
 *   --threads N      worker threads                         (default = CPU count)
 *   --json PATH      also write full per-game results as JSON
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { loadEngine, parseModeSpec } = require('./engine.js');

function parseArgs(argv) {
	const a = {
		games: 10, time: 10, red: 'pure_minimax', blue: 'pruned_minimax',
		swap: true, pack: 'core', seed: null, maxDepth: 64, maxTurns: 300,
		threads: os.cpus().length, json: null,
		watch: false, moveDelay: 700, site: 'http://localhost:8080',
		requireSpell: null,
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
			case '--json': a.json = next(); break;
			case '--watch': a.watch = true; break;
			case '--move-delay': a.moveDelay = parseInt(next(), 10); break;
			case '--site': a.site = next(); break;
			case '--require-spell': a.requireSpell = next(); break;
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
			// --require-spell: regenerate until the layout contains it, so a
			// spell-specific change (e.g. a Carnage heuristic) is actually
			// exercised instead of diluted by layouts that lack the spell.
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
		// Swap colors on odd games so each AI plays red half the time.
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

function fmt(n) {
	return n.toLocaleString('en-US');
}

function summarize(args, seed, results) {
	const A = args.red, B = args.blue;
	// Tally wins by AI identity (not color), using redIsA per game.
	const specById = new Map();
	const tally = { A: 0, B: 0, draw: 0, error: 0 };
	const perMode = {};
	for (const m of [A, B]) {
		perMode[m] = { moves: 0, nodes: 0, cutoffs: 0, depthSum: 0, maxDepth: 0, timeMs: 0 };
	}
	const reasons = {};
	let totalPlies = 0, totalWall = 0;

	for (const r of results) {
		if (!r.ok) { tally.error++; continue; }
		const g = r.result;
		specById.set(g.gameId, g);
		reasons[g.endReason] = (reasons[g.endReason] || 0) + 1;
		totalPlies += g.plies;
		totalWall += g.durationMs;

		// Which AI was which color this game?
		const redAI = g.redMode, blueAI = g.blueMode;
		if (g.winner === 'red') bump(redAI);
		else if (g.winner === 'blue') bump(blueAI);
		else tally.draw++;

		accumulate(perMode[redAI], g.stats.red);
		accumulate(perMode[blueAI], g.stats.blue);
	}

	function bump(aiMode) {
		if (aiMode === A) tally.A++; else tally.B++;
	}
	function accumulate(dst, src) {
		dst.moves += src.moves; dst.nodes += src.nodes; dst.cutoffs += src.cutoffs;
		dst.depthSum += src.depthSum; dst.timeMs += src.timeMs;
		dst.maxDepth = Math.max(dst.maxDepth, src.maxDepth);
	}

	const line = '─'.repeat(64);
	console.log('\n' + line);
	console.log(`ARENA RESULTS   seed=${seed}  games=${args.games}  ${args.time}s/move  pack=${args.pack}`);
	console.log(`  RED-or-swap fairness: ${args.swap ? 'on (colors alternate)' : 'off'}`);
	console.log(line);
	console.log(`  ${A.padEnd(16)} wins: ${tally.A}`);
	console.log(`  ${B.padEnd(16)} wins: ${tally.B}`);
	console.log(`  draws: ${tally.draw}   errors: ${tally.error}`);
	console.log(`  end reasons: ${JSON.stringify(reasons)}`);
	console.log(`  avg plies/game: ${(totalPlies / Math.max(1, args.games - tally.error)).toFixed(1)}`);
	console.log(line);
	console.log('  Per-engine search efficiency (aggregate over all its moves):');
	console.log(`  ${'engine'.padEnd(16)} ${'moves'.padStart(7)} ${'avgDepth'.padStart(9)} ${'maxD'.padStart(5)} ${'nodes'.padStart(14)} ${'nodes/s'.padStart(12)} ${'ttCuts/mv'.padStart(11)}`);
	for (const m of [A, B]) {
		const p = perMode[m];
		const avgDepth = p.moves ? (p.depthSum / p.moves) : 0;
		const nps = p.timeMs ? (p.nodes / (p.timeMs / 1000)) : 0;
		const avgCut = p.moves ? (p.cutoffs / p.moves) : 0;
		console.log(`  ${m.padEnd(16)} ${String(p.moves).padStart(7)} ${avgDepth.toFixed(2).padStart(9)} ${String(p.maxDepth).padStart(5)} ${fmt(p.nodes).padStart(14)} ${fmt(Math.round(nps)).padStart(12)} ${fmt(Math.round(avgCut)).padStart(11)}`);
	}
	console.log(line);
	console.log('  Pruning evidence is the depth reached at an equal time budget:');
	console.log('  pruned_minimax reaches higher avgDepth/maxD because alpha-beta');
	console.log('  cutoffs let it skip subtrees, while pure_minimax spends its');
	console.log('  budget on full-width search and explores far more nodes/ply.');
	console.log('  (ttCuts counts transposition-table-hit cutoffs only — present');
	console.log('   in both variants — not the alpha-beta beta-cutoffs themselves.)');
	console.log(line + '\n');
}

async function main() {
	const args = parseArgs(process.argv);

	// --watch streams a single live game to a Firebase room (watchable at
	// multiplayer.html?id=CODE) instead of running the parallel batch.
	if (args.watch) {
		const { streamGame } = require('./watch-game.js');
		await streamGame({
			time: args.time, seed: args.seed, pack: args.pack,
			red: args.red, blue: args.blue, requireSpell: args.requireSpell,
			moveDelay: args.moveDelay, maxTurns: args.maxTurns, site: args.site,
		});
		return;
	}

	const engine = loadEngine();  // also used here for deterministic layout gen
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
