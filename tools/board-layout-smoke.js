#!/usr/bin/env node
// Board layouts (constants.js BOARD_LAYOUT_RULES): the core 39-node board
// and the Cataclysm 65-node pentagon ring.
//
// Checks:
//   1. The ring builder reproduces the core literal tables exactly
//      (node order, positions, adjacency incl. neighbour order).
//   2. The pentagon layout is well-formed: 65 nodes, symmetric adjacency,
//      degrees 2-3, 15 sigils (5/5/5), 5 mana nodes, 15 void nodes.
//   3. Layout switching: a pentagon SigilBoard activates the layout, draws
//      5/5/5 spells, starts on a1/b1, round-trips through SFN; a core board
//      switches back and still reads core rules.
//   4. Fuzz: random-legal-turn games on the pentagon (every pack, standard
//      and competitive) through the SimBoard enumerator + _minimaxApplyTurn,
//      checking invariants every ply. Then short Caveman games.
//   5. Live path: GameController games on the pentagon with both sides
//      played by a random "human" answering every prompt (so the
//      interactive spells.js resolvers run), each replayed from its SGN-T
//      transcript by hydrateGameLog to the same final SFN.
//
//   node tools/board-layout-smoke.js [fuzzGames]
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.dirname(__dirname);
const ENGINE = path.join(REPO, 'docs', 'static', 'scripts', 'engine');
const FILES = [
	'constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js',
	'sim-board.js', 'features.js', 'strategic-eval.js', 'enumerator.js',
	'minimax-ai.js', 'caveman-ai.js', 'ai-player.js', 'game-controller.js',
	'game-review.js',
];
let src = FILES.map((f) => fs.readFileSync(path.join(ENGINE, f), 'utf8')).join('\n;\n');
src += `\n;\n(${driver.toString()})(process.argv).catch((e) => { console.error(e); process.exit(1); });\n`;
new Function('require', 'process', src)(require, process);

async function driver(argv) {
	const assert = (cond, msg) => { if (!cond) throw new Error('assertion failed: ' + msg); };
	const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

	// Seeded RNG so a failure reproduces (shuffleArray uses Math.random).
	let seed = 12345;
	Math.random = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x80000000;
	};

	// 1. Ring builder vs the core literal.
	const ring3 = buildRingLayout(3);
	const core = boardLayoutDef('core');
	assert(eq(ring3.nodeOrder, core.nodeOrder), 'core node order');
	assert(eq(ring3.positions, _CORE_POSITIONS), 'core positions');
	assert(eq(ring3.adjacency, _CORE_ADJACENCY), 'core adjacency');
	assert(eq(ring3.manaNodes, ['a1', 'b1', 'c1']), 'core mana');
	assert(eq(core.syzygyOpposite, { 1: { charm: 8, sorcery: 5 }, 2: { charm: 9, sorcery: 6 }, 3: { charm: 7, sorcery: 4 } }),
		'core syzygy opposites');

	// 2. Pentagon well-formedness.
	const pent = boardLayoutDef('pentagon');
	assert(pent.nodeOrder.length === 65, '65 nodes');
	let edges = 0;
	for (const n of pent.nodeOrder) {
		const nb = pent.adjacency[n];
		assert(nb.length >= 2 && nb.length <= 3, 'degree of ' + n);
		assert(new Set(nb).size === nb.length, 'no duplicate neighbours at ' + n);
		for (const m of nb) assert(pent.adjacency[m].includes(n), 'symmetric ' + n + '-' + m);
		edges += nb.length;
	}
	assert(edges / 2 === 90, '90 edges');
	assert(pent.positionCount === 15, '15 positions');
	for (const p of pent.ritualPositions) assert(pent.positions[p].length === 5, 'ritual size');
	for (const p of pent.sorceryPositions) assert(pent.positions[p].length === 3, 'sorcery size');
	for (const p of pent.charmPositions) assert(pent.positions[p].length === 1, 'charm size');
	const onSigil = new Set();
	for (let p = 1; p <= 15; p++) for (const n of pent.positions[p]) {
		assert(!onSigil.has(n), 'sigils disjoint at ' + n);
		onSigil.add(n);
	}
	assert(onSigil.size === 45 && pent.manaNodes.length === 5, 'sigil/mana counts');

	// 3. Layout switching through the board classes.
	const pb = new SigilBoard(generateSpellListFor('pentagon', ['core']), 'pentagon');
	assert(BOARD.id === 'pentagon' && NODE_ORDER.length === 65, 'pentagon activated');
	assert(pb.spellNames.length === 15, '15 spells drawn');
	assert(eq([...pb.spellNames].sort(), [...CORE_RITUALS, ...CORE_SORCERIES, ...CORE_CHARMS].sort()),
		'core-only pentagon uses all 15 core spells');
	pb.setupInitial();
	assert(pb.stones.a1 === 'red' && pb.stones.b1 === 'blue', 'standard start');
	const sfn = boardToSfn(pb);
	assert(sfn.split('/')[0].length === 65 && / pentagon$/.test(sfn), 'pentagon SFN: ' + sfn);
	const d = sfnToDict(sfn);
	assert(d.layout === 'pentagon' && d.stones.e13 === null && d.stones.b1 === 'blue', 'SFN parse');
	// A bare 65-node stone field (no variant token) is still a pentagon.
	const bare = sfnToDict(sfn.replace(/ pentagon$/, ''));
	assert(bare.layout === 'pentagon' && variantHasPentagon(bare.variant), 'bare pentagon SFN');
	const cb = new SigilBoard(null, 'standard');
	assert(BOARD.id === 'core' && NODE_ORDER.length === 39 && BOARD.spellTarget === 6, 'core re-activated');
	assert(cb.spellNames.length === 9, 'core draws 9');
	// loadFromSfn switches a core board onto the SFN's layout.
	cb.loadFromSfn(sfn);
	assert(BOARD.id === 'pentagon' && cb.stones.b1 === 'blue' && variantHasPentagon(cb.variant), 'loadFromSfn switch');
	assert(eq(spellSlotNames().slice(4, 6), ['ritual5', 'sorcery1']), 'slot names');

	// 4. Fuzz.
	const fuzzGames = parseInt(argv[2] || '24', 10);
	const allPacks = ['core', ...EXPANSION_KEYS];
	const castCount = {};
	let plies = 0;
	const endings = {};
	for (let g = 0; g < fuzzGames; g++) {
		const variant = g % 2 ? 'competitive_pentagon' : 'pentagon';
		const packs = g % 3 === 0 ? ['core'] : allPacks;
		const names = generateSpellListFor('pentagon', packs);
		let board = new SimBoard(names, variant);
		if (!variantHasCompetitive(variant)) {
			board.stones.a1 = 'red';
			board.stones.b1 = 'blue';
		}
		board.turnCounter = 1;
		board.update();
		const seen = {};
		let turnNo = 0;
		while (!board.gameover && turnNo < 300) {
			const color = board.whoseTurn;
			const snap = board.loopingSnapshot();
			seen[snap] = (seen[snap] || 0) + 1;
			if (seen[snap] >= 3) { board.gameover = true; board.winner = 'blue'; board.endedBy = 'repetition'; break; }
			const turns = getLegalTurnsExhaustive(board, color);
			assert(turns.length > 0, 'no legal turns');
			// Prefer casting turns half the time so spells get exercised.
			const casting = turns.filter(t => t.actions.some(a => a.type === 'cast'));
			const pool = casting.length && Math.random() < 0.6 ? casting : turns;
			const turn = pool[Math.floor(Math.random() * pool.length)];
			for (const a of turn.actions) if (a.type === 'cast') castCount[a.spell] = (castCount[a.spell] || 0) + 1;
			board = _minimaxApplyTurn(board, turn, color);
			turnNo++;
			plies++;
			for (const n of NODE_ORDER) {
				const s = board.stones[n];
				assert(s === null || s === 'red' || s === 'blue' || s === DESTROYED, 'stone value at ' + n);
			}
			assert(Object.keys(board.stones).length === 65, 'stone map size');
			assert(board.spellCounter.red <= BOARD.spellTarget && board.spellCounter.blue <= BOARD.spellTarget, 'spell counter bound');
		}
		const why = board.endedBy || (!board.gameover ? 'cap'
			: board.totalStones.red === 0 || board.totalStones.blue === 0 ? 'elimination'
			: Math.max(board.spellCounter.red, board.spellCounter.blue) >= BOARD.spellTarget ? 'spells' : 'lead');
		endings[why] = (endings[why] || 0) + 1;
	}
	const casted = Object.keys(castCount).length;
	const neverCast = Object.keys(CORE_SPELLS)
		.filter(n => n === baseSpellName(n) && !CORE_SPELLS[n].static && !castCount[n]);

	// Short Caveman games (depth-limited) from both openings.
	const cavemanResults = [];
	for (const variant of ['pentagon', 'competitive_pentagon']) {
		let board = new SimBoard(generateSpellListFor('pentagon', ['core']), variant);
		if (!variantHasCompetitive(variant)) { board.stones.a1 = 'red'; board.stones.b1 = 'blue'; }
		board.turnCounter = 1;
		board.update();
		let n = 0;
		while (!board.gameover && n < 12) {
			const color = board.whoseTurn;
			const res = await cavemanSearch(board, color, { timeLimit: 0.3, maxDepth: 2, exhaustiveRoot: true });
			assert(res && res.turn, 'caveman returned a turn');
			board = _minimaxApplyTurn(board, res.turn, color);
			n++;
		}
		cavemanResults.push(variant + ':' + n + ' plies');
	}

	// 5. Live controller games with a random human on both sides.
	const liveGames = parseInt(argv[3] || '12', 10);
	const liveCasts = {};
	let livePlies = 0;
	const _realSetTimeout = setTimeout;
	for (let g = 0; g < liveGames; g++) {
		const variant = g % 2 ? 'competitive_pentagon' : 'pentagon';
		setBoardLayout('pentagon');
		const spellNames = generateSpellList(g % 3 === 0 ? ['core'] : allPacks);
		const result = await new Promise((resolve, reject) => {
			let gc = null;
			let lastMsg = null, repeats = 0, turnsSeen = 0;
			const emit = (payload) => {
				if (payload.type === 'game_over') resolve({ payload, gc });
				if (payload.type === 'whoseturndisplay' && ++turnsSeen > 400) {
					gc.handlePlayerAction('forfeit');
				}
			};
			gc = new GameController(emit, { variant, spellNames });
			gc._delay = () => Promise.resolve();
			gc._waitForInput = (payload) => {
				gc.emit(payload);
				const key = payload.message + '|' + payload.awaiting;
				repeats = key === lastMsg ? repeats + 1 : 0;
				lastMsg = key;
				if (repeats > 5000) { reject(new Error('stuck on prompt: ' + key)); return new Promise(() => {}); }
				return Promise.resolve(pickAnswer(payload));
			};
			gc.startGame().catch(reject);
		});
		const { payload, gc } = result;
		const log = payload.gameLog || gc._gameLog;
		livePlies += log.length;
		for (const t of log) for (const tok of (t.actions || [])) {
			if (typeof tok === 'string' && CORE_SPELLS[tok]) liveCasts[tok] = (liveCasts[tok] || 0) + 1;
		}
		// Replay the transcript from scratch; it must land on the same board.
		if (log.length) {
			const slim = log.map(t => ({ color: t.color, turnNumber: t.turnNumber, kind: t.kind, actions: t.actions }));
			const finalSfn = log[log.length - 1].sfnAfter;
			const fat = await hydrateGameLog(spellNames, variant, null, finalSfn, slim);
			const got = fat.length ? fat[fat.length - 1].sfnAfter : null;
			assert(got && got.split(' ')[0] === finalSfn.split(' ')[0],
				'live game ' + g + ' replays to\n  ' + got + '\nexpected\n  ' + finalSfn);
		}
	}

	function pickAnswer(payload) {
		const opts = Object.keys(payload.moveoptions || {});
		if (payload.awaiting === 'action') {
			const acts = payload.actionlist || [];
			const spells = acts.filter(a => CORE_SPELLS[a]);
			if (spells.length && Math.random() < 0.7) return spells[Math.floor(Math.random() * spells.length)];
			if (acts.includes('move') && opts.length) return opts[Math.floor(Math.random() * opts.length)];
			if (acts.includes('dash') && Math.random() < 0.3) return 'dash';
			const rest = acts.filter(a => a !== 'move');
			return rest.length ? rest[Math.floor(Math.random() * rest.length)] : 'pass';
		}
		if (opts.length) return opts[Math.floor(Math.random() * opts.length)];
		return NODE_ORDER[Math.floor(Math.random() * NODE_ORDER.length)];
	}

	console.log('board-layout smoke OK: core tables match the ring builder; pentagon 65 nodes/90 edges; ' +
		fuzzGames + ' fuzz games, ' + plies + ' plies, ' + casted + ' distinct spells cast, endings ' +
		JSON.stringify(endings) + '; caveman ' + cavemanResults.join(', ') +
		(neverCast.length ? '; never cast: ' + neverCast.join(',') : '') +
		'; live: ' + liveGames + ' games, ' + livePlies + ' turns, ' + Object.keys(liveCasts).length +
		' distinct spells cast, all transcripts replay');

	function generateSpellListFor(layout, packs) {
		setBoardLayout(layout);
		return generateSpellList(packs);
	}
}
