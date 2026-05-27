'use strict';
/**
 * Diagnostic: how much does Carnage actually destroy in real games, and does
 * the sequence planner (lp) change it? Plays N games for a given config and,
 * for every Carnage cast, counts how many of its pushes were crushes
 * (pushed_to === 'X' → enemy destroyed). Tells us whether crush opportunities
 * even arise — and whether the planner converts more of them.
 *
 * Usage: node tools/arena/diag-carnage.js [--games N] [--time S] [--seed N] [--lp]
 */
const { loadEngine, parseModeSpec, specToOpts } = require('./engine.js');

function args(argv) {
	const a = { games: 24, time: 1.0, seed: 5, lp: false };
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i];
		if (k === '--games') a.games = parseInt(argv[++i], 10);
		else if (k === '--time') a.time = parseFloat(argv[++i]);
		else if (k === '--seed') a.seed = parseInt(argv[++i], 10);
		else if (k === '--lp') a.lp = true;
		else throw new Error('bad arg ' + k);
	}
	return a;
}

async function main() {
	const a = args(process.argv);
	const engine = loadEngine();
	const { SimBoard, cavemanSearch, _minimaxApplyTurn } = engine;
	const cfg = parseModeSpec('pruned_minimax:plies=64,capabs=1' + (a.lp ? ',lp=1' : ''));
	const opts = specToOpts(cfg, { timeLimit: a.time, maxDepth: 64 }, engine.ENUM_CAPS);

	// Seeded layouts, all containing Carnage.
	const real = Math.random; let s = a.seed >>> 0;
	Math.random = () => { s = (s + 0x6D2B79F5) >>> 0; let r = Math.imul(s ^ (s >>> 15), 1 | s); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
	const layouts = [];
	for (let i = 0; i < a.games; i++) {
		let L = engine.generateSpellList('core'), t = 0;
		while (!L.includes('Carnage') && t++ < 1000) L = engine.generateSpellList('core');
		layouts.push(L);
	}
	Math.random = real;

	let casts = 0, crushes = 0, pushes = 0, castsWithCrush = 0, maxCrush = 0;
	for (let g = 0; g < a.games; g++) {
		let board = new SimBoard(layouts[g], 'standard');
		board.stones.a1 = 'red'; board.stones.b1 = 'blue'; board.update();
		const loop = {}; let plies = 0;
		while (!board.gameover && plies < 200) {
			const color = board.whoseTurn;
			const snap = board.loopingSnapshot();
			loop[snap] = (loop[snap] || 0) + 1;
			if (loop[snap] >= 5) { board.winner = 'blue'; break; }
			const res = await cavemanSearch(board, color, Object.assign({ positionHistory: loop }, opts));
			// Count crushes inside a Carnage cast this turn.
			const acts = res.turn.actions;
			const isCarnage = acts.some((x) => x.type === 'cast' && x.spell === 'Carnage');
			if (isCarnage) {
				casts++;
				let c = 0, p = 0;
				for (const x of acts) if (x.type === 'hard_move') { p++; if (x.pushed_to === 'X') c++; }
				crushes += c; pushes += p;
				if (c > 0) castsWithCrush++;
				if (c > maxCrush) maxCrush = c;
			}
			board = _minimaxApplyTurn(board, res.turn, color);
			plies++;
		}
	}
	const tag = a.lp ? 'PLANNER (lp)' : 'baseline';
	console.log(`\n[${tag}] ${a.games} games, Carnage in every layout, ${a.time}s/move`);
	console.log(`  Carnage casts:        ${casts}  (${(casts / a.games).toFixed(2)}/game)`);
	console.log(`  Carnage pushes total: ${pushes}`);
	console.log(`  Stones crushed total: ${crushes}  (${casts ? (crushes / casts).toFixed(2) : 0}/cast)`);
	console.log(`  Casts that crushed:   ${castsWithCrush}/${casts}  (max crush in one cast: ${maxCrush})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
