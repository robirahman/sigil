'use strict';
/**
 * Stream one headless AI-vs-AI game to a Firebase room, in the exact wire
 * format the existing multiplayer spectator replays — so you can watch it live
 * at multiplayer.html?id=CODE and rewind it afterwards.
 *
 * Per turn: play the move with the search engine, convert the resolved SimTurn
 * to the spectator's input action-string sequence (verified by replay — see
 * actions-search.js), then push it + the new board SFN to the room. Streaming
 * ABORTS rather than desync: if a turn can't be verified, the room is finished
 * with that note instead of pushing an unverified turn.
 *
 * Usage:
 *   node tools/arena/watch-game.js [--time S] [--seed N] [--pack KEY]
 *        [--red SPEC] [--blue SPEC] [--move-delay MS] [--keep]
 */

const { loadEngine, parseModeSpec, specToOpts } = require('./engine.js');
const { loadConsumer } = require('./consumer.js');
const { findActions } = require('./actions-search.js');
const { FirebaseRoom, generateRoomCode } = require('./firebase-rest.js');

function parseArgs(argv) {
	const a = { time: 3, seed: null, pack: 'core',
		red: 'pruned_minimax:plies=64,capabs=1', blue: 'pruned_minimax:plies=64,capabs=1',
		moveDelay: 350, keep: false, maxTurns: 300, site: 'http://localhost:8080', requireSpell: null };
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i];
		if (k === '--time') a.time = parseFloat(argv[++i]);
		else if (k === '--seed') a.seed = parseInt(argv[++i], 10);
		else if (k === '--pack') a.pack = argv[++i];
		else if (k === '--red') a.red = argv[++i];
		else if (k === '--blue') a.blue = argv[++i];
		else if (k === '--move-delay') a.moveDelay = parseInt(argv[++i], 10);
		else if (k === '--keep') a.keep = true;
		else if (k === '--site') a.site = argv[++i];
		else if (k === '--require-spell') a.requireSpell = argv[++i];
		else throw new Error('unknown arg ' + k);
	}
	return a;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamGame(args) {
	const engine = loadEngine();
	const consumer = loadConsumer();
	const { SimBoard, cavemanSearch, _minimaxApplyTurn, boardToSfn } = engine;
	const redCfg = parseModeSpec(args.red);
	const blueCfg = parseModeSpec(args.blue);

	// Seeded layout + room code.
	const seed = args.seed == null ? (Date.now() & 0x7fffffff) : args.seed;
	let s = seed >>> 0;
	const realRandom = Math.random;
	Math.random = () => { s = (s + 0x6D2B79F5) >>> 0; let r = Math.imul(s ^ (s >>> 15), 1 | s); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
	let spellNames = engine.generateSpellList(args.pack);
	if (args.requireSpell) {
		let tries = 0;
		while (!spellNames.includes(args.requireSpell) && tries++ < 1000) {
			spellNames = engine.generateSpellList(args.pack);
		}
	}
	const code = generateRoomCode();
	Math.random = realRandom;

	const optsByColor = {
		red: specToOpts(redCfg, { timeLimit: args.time, maxDepth: 64 }, engine.ENUM_CAPS),
		blue: specToOpts(blueCfg, { timeLimit: args.time, maxDepth: 64 }, engine.ENUM_CAPS),
	};

	// Standard opening.
	let board = new SimBoard(spellNames, 'standard');
	board.stones.a1 = 'red'; board.stones.b1 = 'blue';
	board.update();

	const room = new FirebaseRoom(code);
	await room.create({
		spellNames, variant: 'standard',
		redName: 'Red: ' + redCfg.label, blueName: 'Blue: ' + blueCfg.label,
		currentSfn: boardToSfn(board),
	});

	const url = `${args.site}/multiplayer.html?id=${code}`;
	console.log('\n  ▶ Live arena game streaming to Firebase');
	console.log(`     Red:  ${redCfg.label}`);
	console.log(`     Blue: ${blueCfg.label}`);
	console.log(`     Room: ${code}   (${args.time}s/move)`);
	console.log(`     WATCH: ${url}\n`);

	const loopCounts = {};
	const gameLog = [];
	let plies = 0;
	let aborted = null;

	while (!board.gameover && plies < args.maxTurns) {
		const color = board.whoseTurn;
		const snap = board.loopingSnapshot();
		loopCounts[snap] = (loopCounts[snap] || 0) + 1;
		if (loopCounts[snap] >= 5) { board.gameover = true; board.winner = 'blue'; break; }
		if (board.chargedSpells[color] && board.chargedSpells[color].includes('Inferno')) {
			board.gameover = true; board.winner = color === 'red' ? 'blue' : 'red'; break;
		}

		const sfnBefore = boardToSfn(board);
		const res = await cavemanSearch(board, color,
			Object.assign({ positionHistory: loopCounts }, optsByColor[color]));
		const next = _minimaxApplyTurn(board, res.turn, color);
		const sfnAfter = boardToSfn(next);

		const simTurn = { actions: res.turn.actions.map((x) => Object.assign({}, x)) };
		const conv = await findActions(consumer, spellNames, 'standard',
			sfnBefore, color, simTurn, sfnAfter);
		if (!conv.actions) {
			aborted = { plies, color, types: simTurn.actions.map((x) => x.type).join('+'),
				sfnBefore, sfnAfter };
			break;
		}

		await room.pushTurn(color, conv.actions);
		await room.setSfn(sfnAfter);
		gameLog.push({ color, turnNumber: plies + 1, sfnBefore, sfnAfter });
		process.stdout.write(`  ${String(plies + 1).padStart(3)}. ${color.padEnd(4)} ` +
			`d${res.depth} [${conv.actions.join(' ')}]\n`);

		board = next;
		plies += 1;
		if (args.moveDelay > 0) await delay(args.moveDelay);
	}

	if (aborted) {
		console.log(`\n  ✗ Aborted at ply ${aborted.plies} (${aborted.types}) — turn failed ` +
			`action-string verification; not desyncing the spectator.`);
		await room.finish(board.winner || 'red', gameLog);
	} else {
		console.log(`\n  ■ Game over — winner: ${board.winner} (${plies} plies)`);
		await room.finish(board.winner, gameLog);
	}
	console.log(`     Final / rewind: ${url}`);
	return { code, url, winner: board.winner, plies, aborted };
}

module.exports = { streamGame };

if (require.main === module) {
	streamGame(parseArgs(process.argv)).catch((e) => { console.error(e); process.exit(1); });
}
