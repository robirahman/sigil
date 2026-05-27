'use strict';
/**
 * Coverage check for the action-string converter.
 *
 * Plays N full games with the search engine (capturing per-turn
 * sfnBefore / resolved SimTurn / sfnAfter), then for every turn runs
 * findActions() and confirms the generated input stream replays through the
 * real SpectatorController to the same board. Reports per-turn / per-game
 * success so we know whether live spectating will stay in sync.
 *
 * Usage: node tools/arena/verify-game.js [--games N] [--time S] [--seed N]
 *        [--ai SPEC] [--pack KEY] [--verbose]
 */

const { loadEngine, parseModeSpec, specToOpts } = require('./engine.js');
const { loadConsumer } = require('./consumer.js');
const { findActions } = require('./actions-search.js');

function parseArgs(argv) {
	const a = { games: 3, time: 1.0, seed: 1, ai: 'pruned_minimax:plies=64,capabs=1',
		pack: 'core', verbose: false, maxTurns: 200 };
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i];
		if (k === '--games') a.games = parseInt(argv[++i], 10);
		else if (k === '--time') a.time = parseFloat(argv[++i]);
		else if (k === '--seed') a.seed = parseInt(argv[++i], 10);
		else if (k === '--ai') a.ai = argv[++i];
		else if (k === '--pack') a.pack = argv[++i];
		else if (k === '--verbose') a.verbose = true;
		else throw new Error('unknown arg ' + k);
	}
	return a;
}

// Plays one game, returning the per-turn transcript.
async function playTranscript(engine, spellNames, cfg, time, maxTurns) {
	const { SimBoard, cavemanSearch, _minimaxApplyTurn, boardToSfn } = engine;
	const opts = specToOpts(cfg, { timeLimit: time, maxDepth: 64 }, engine.ENUM_CAPS);
	let board = new SimBoard(spellNames, 'standard');
	board.stones.a1 = 'red'; board.stones.b1 = 'blue';
	board.update();
	const loopCounts = {};
	const turns = [];
	let plies = 0;
	while (!board.gameover && plies < maxTurns) {
		const color = board.whoseTurn;
		const snap = board.loopingSnapshot();
		loopCounts[snap] = (loopCounts[snap] || 0) + 1;
		if (loopCounts[snap] >= 5) { board.gameover = true; board.winner = 'blue'; break; }
		if (board.chargedSpells[color] && board.chargedSpells[color].includes('Inferno')) {
			board.gameover = true; board.winner = color === 'red' ? 'blue' : 'red'; break;
		}
		const sfnBefore = boardToSfn(board);
		const res = await cavemanSearch(board, color,
			Object.assign({ positionHistory: loopCounts }, opts));
		board = _minimaxApplyTurn(board, res.turn, color);
		turns.push({ color, sfnBefore, sfnAfter: boardToSfn(board),
			turn: { actions: res.turn.actions.map((x) => Object.assign({}, x)) } });
		plies += 1;
	}
	return { turns, winner: board.winner, spellNames };
}

async function main() {
	const args = parseArgs(process.argv);
	const engine = loadEngine();
	const consumer = loadConsumer();
	const cfg = parseModeSpec(args.ai);

	// Deterministic layouts.
	const realRandom = Math.random;
	let s = args.seed >>> 0;
	Math.random = () => { s = (s + 0x6D2B79F5) >>> 0; let r = Math.imul(s ^ (s >>> 15), 1 | s); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
	const layouts = [];
	for (let i = 0; i < args.games; i++) layouts.push(engine.generateSpellList(args.pack));
	Math.random = realRandom;

	let totTurns = 0, okTurns = 0, totReplays = 0, failGames = 0;
	const failsByType = {};

	for (let g = 0; g < args.games; g++) {
		const t = await playTranscript(engine, layouts[g], cfg, args.time, args.maxTurns);
		let gameOk = true;
		for (let i = 0; i < t.turns.length; i++) {
			const turn = t.turns[i];
			totTurns++;
			const r = await findActions(consumer, t.spellNames, 'standard',
				turn.sfnBefore, turn.color, turn.turn, turn.sfnAfter);
			totReplays += r.replays;
			if (r.actions) {
				okTurns++;
				if (args.verbose) console.log(`  g${g} t${i} ${turn.color}: [${r.actions.join(', ')}]`);
			} else {
				gameOk = false;
				const types = turn.turn.actions.map((a) => a.type).join('+');
				failsByType[types] = (failsByType[types] || 0) + 1;
				console.log(`  ✗ g${g} t${i} ${turn.color} (${types}): ${r.error} ` +
					`[${r.replays} replays]\n     before=${turn.sfnBefore}\n      after=${turn.sfnAfter}` +
					`\n    actions=${JSON.stringify(turn.turn.actions)}`);
			}
		}
		if (!gameOk) failGames++;
	}

	console.log('\n' + '─'.repeat(60));
	console.log(`Converter coverage: ${okTurns}/${totTurns} turns ` +
		`(${(100 * okTurns / totTurns).toFixed(1)}%) across ${args.games} games`);
	console.log(`Clean games: ${args.games - failGames}/${args.games}`);
	console.log(`Total replays: ${totReplays} (${(totReplays / totTurns).toFixed(0)}/turn avg)`);
	if (Object.keys(failsByType).length) console.log('Failures by action types:', failsByType);
	console.log('─'.repeat(60));
}

main().catch((e) => { console.error(e); process.exit(1); });
