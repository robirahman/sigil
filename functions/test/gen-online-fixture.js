'use strict';
/**
 * Writes test/online-game.json: a complete online-style game (every turn an
 * input-token transcript, as rooms/{code}/turns holds) played by a seeded
 * random player through the real GameController, for rating.test.js.
 *
 *   node functions/test/gen-online-fixture.js [seed]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ENGINE_FILES, engineDir } = require('../engine-loader');

function rng(seed) {
	let s = seed >>> 0;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

async function playOne(seed) {
	const ctx = { console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Promise, Math, Date, JSON };
	vm.createContext(ctx);
	const src = ENGINE_FILES.map((f) => fs.readFileSync(path.join(engineDir(), f), 'utf8')).join('\n;\n')
		+ '\n;globalThis.__e = { GameController, SigilBoard, boardToSfn, generateSpellList };';
	vm.runInContext(src, ctx);
	const { GameController, SigilBoard, generateSpellList } = ctx.__e;
	const rand = rng(seed);
	const pick = (xs) => xs[Math.floor(rand() * xs.length)];
	const spellNames = generateSpellList();
	const gc = new GameController(() => {}, { variant: 'standard' });
	const board = new SigilBoard(spellNames, 'standard');
	board.setupInitial();
	gc.board = board;
	let budget = 0;
	gc._waitForInput = async (p) => {
		if (++budget > 400) throw new Error('stuck');
		const acts = p.actionlist || [];
		const nodes = Object.keys(p.moveoptions || {});
		if (p.awaiting === 'node' && nodes.length) return pick(nodes);
		if (p.awaiting === 'node') return pick(Object.keys(board.stones));
		// The UI answers 'move' by clicking a node from moveoptions.
		if (nodes.length && acts.includes('move') && rand() < 0.7) return pick(nodes);
		const nonPass = acts.filter((a) => a !== 'pass' && a !== 'move');
		if (nonPass.length && rand() < 0.8) return pick(nonPass);
		return acts.includes('pass') ? 'pass' : pick(acts);
	};
	const turns = [];
	for (let n = 1; n <= 300 && !board.gameover; n++) {
		board.takeSnapshot();
		board.turnCounter = n;
		board.whoseTurn = n % 2 === 1 ? 'red' : 'blue';
		board.update();
		if (board.chargedSpells[board.whoseTurn].includes('Seal_of_Destruction')) {
			board.gameover = true;
			board.winner = board.enemy(board.whoseTurn);
			break;
		}
		gc._resetRequested = false;
		board.crushedThisTurn = false;
		gc._currentTurnActions = [];
		board.providenceOpen = board.providenceBank[board.whoseTurn] > 0;
		budget = 0;
		await gc._takeTurn(board.whoseTurn, true, true, true, true);
		gc._eotTriggers(board.whoseTurn);
		board.update();
		turns.push({ color: board.whoseTurn, turnNumber: n, kind: 'input', actions: gc._currentTurnActions.slice() });
	}
	if (process.env.DEBUG) console.error(seed, "turns", turns.length, "score", board.score, "charged", JSON.stringify(board.chargedSpells), turns.slice(-3).map(t => t.actions.join(" ")).join(" | "));
	return board.gameover ? { spellNames, winner: board.winner, turns } : null;
}

(async () => {
	for (let seed = Number(process.argv[2] || 1); seed < Number(process.argv[3] || 200); seed++) {
		let game = null;
		try { game = await playOne(seed); } catch (e) { if (process.env.DEBUG) console.error(seed, e.message); }
		if (game) {
			game.seed = seed;
			fs.writeFileSync(path.join(__dirname, 'online-game.json'), JSON.stringify(game, null, 1) + '\n');
			console.log('seed', seed, 'winner', game.winner, 'turns', game.turns.length);
			return;
		}
	}
	console.error('no finished game');
	process.exit(1);
})();
