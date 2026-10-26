'use strict';
// node --test functions/test/analysis.test.js
//
// The server's analysis of rated games (analysis.js) against an in-memory
// database (fake-db.js, which stores values as the Realtime Database does),
// with the real wasm engine: the game_evals document it writes must pass
// through the review panel's own reader (game-review.js rustEvalsToReview,
// loaded from docs/ by engine-loader.js), and the position eval cache it
// fills must serve a second game.

const test = require('node:test');
const assert = require('node:assert');
const { analyzeStep, evalPositions, positionEvalKey, ANALYSIS_BATCH } = require('../analysis');
const { freshEngine } = require('../engine-loader');
const { fakeDb } = require('./fake-db');
const ONLINE = require('./online-game.json');
const AI = require('./ai-games.json');

const clone = (x) => JSON.parse(JSON.stringify(x));

async function runAll(db, gameId, stats) {
	let res, tasks = 0;
	do { res = await analyzeStep(db, gameId, { stats }); tasks++; } while (!res.done && tasks < 100);
	return Object.assign(res, { tasks });
}

async function hydrate(record) {
	const e = freshEngine();
	return e.reconstructGameLog(record.spellNames, e.normalizeVariant(record.variant), record.setupSfn || null, record.turns);
}

test('a rated game is analysed in batches into a game_evals document the review panel reads', async () => {
	const db = fakeDb({ completed_games: { G1: Object.assign(clone(ONLINE), { roomCode: 'ROOM1' }) } });
	const stats = { hits: 0, searched: 0, ms: 0 };
	const res = await runAll(db, 'G1', stats);
	const log = await hydrate(ONLINE);
	const n = log.length;
	assert.strictEqual(res.reason, 'written');
	assert.strictEqual(res.tasks, Math.ceil(n / ANALYSIS_BATCH));
	assert.strictEqual(stats.searched + stats.hits, n);
	console.log(`    ${n} positions, ${stats.searched} searched, ${(stats.ms / Math.max(1, stats.searched)).toFixed(0)} ms per search`);
	const all = db.dump();
	assert.strictEqual(all.game_evals_progress, undefined, 'the progress record is removed');
	const stored = all.game_evals.ROOM1;
	assert.strictEqual(stored.gameId, 'G1');
	assert.strictEqual(stored.preset, 'quick');
	// As stored (nulls dropped, arrays as the database returns them), the
	// review panel's reader accepts it for this game.
	const review = freshEngine().rustEvalsToReview(stored, log);
	assert.ok(review, 'rustEvalsToReview accepts the stored document');
	assert.strictEqual(review.source, 'rust');
	assert.strictEqual(review.mode, 'quick');
	assert.strictEqual(review.evalPerPly.length, n + 1);
	assert.strictEqual(review.classificationPerPly.length, n);
	assert.strictEqual(review.terminalWinner, ONLINE.winner);
	for (let i = 0; i < n; i++) {
		assert.strictEqual(review.moverPerPly[i], log[i].color, 'mover of position ' + i);
		assert.ok(typeof review.stonesPerPly[i] === 'number' || typeof review.matePerPly[i] === 'number', 'a value at ' + i);
		assert.ok(Array.isArray(review.bestActionsPerPly[i]), 'a best turn at ' + i);
		assert.ok(typeof review.bestSfnPerPly[i] === 'string', 'the position after it at ' + i);
		assert.ok(review.depthPerPly[i] >= 1, 'a depth at ' + i);
	}
	// A game for another record with the same room code is not analysed over it.
	assert.strictEqual((await analyzeStep(db, 'G1')).reason, 'exists');
});

test('the eval cache serves a second game through the same positions', async () => {
	const db = fakeDb({ completed_games: {
		A: Object.assign(clone(AI.N3WMQJ), { roomCode: 'RA' }),
		B: Object.assign(clone(AI.N3WMQJ), { roomCode: 'RB' }),
	} });
	const first = { hits: 0, searched: 0, ms: 0 };
	await runAll(db, 'A', first);
	assert.strictEqual(first.hits, 0);
	const second = { hits: 0, searched: 0, ms: 0 };
	const res = await runAll(db, 'B', second);
	assert.strictEqual(res.reason, 'written');
	// Every position the game had not visited before comes from the cache;
	// only repeated ones (threefold repetition) are searched again.
	assert.strictEqual(second.hits, first.searched - second.searched);
	assert.ok(second.hits > 0 && second.searched <= first.searched / 4, JSON.stringify({ first, second }));
	const log = await hydrate(AI.N3WMQJ);
	const all = db.dump();
	assert.ok(freshEngine().rustEvalsToReview(all.game_evals.RB, log));
	const entry = all.position_evals[positionEvalKey(log[0].sfnBefore)];
	assert.strictEqual(entry.sfn, log[0].sfnBefore);
	assert.match(entry.engine, /^rust-v\d+-[a-z0-9_]+-quick$/);
});

test('games the Rust engine cannot review, and room codes of other games, are left alone', async () => {
	const dup = Object.assign(clone(ONLINE), { roomCode: 'DUP', variant: 'allow_duplicates' });
	const db = fakeDb({
		completed_games: { D: dup, T: Object.assign(clone(ONLINE), { roomCode: 'TAKEN' }) },
		game_evals: { TAKEN: { gameId: 'older', plies: 3 } },
	});
	assert.strictEqual((await analyzeStep(db, 'D')).reason, 'variant');
	assert.strictEqual((await analyzeStep(db, 'T')).reason, 'room-code-taken');
	assert.strictEqual((await analyzeStep(db, 'missing')).reason, 'no-record');
	assert.deepStrictEqual(db.dump().game_evals, { TAKEN: { gameId: 'older', plies: 3 } });
});

test('evalPositions searches what it caches, and refuses what is not a position', async () => {
	const log = await hydrate(ONLINE);
	const db = fakeDb({});
	await assert.rejects(evalPositions(db, new Array(11).fill(log[0].sfnBefore)), /bad-request/);
	await assert.rejects(evalPositions(db, 'x'), /bad-request/);
	const forged = log[3].sfnBefore.replace(/ (\d+) /, ' 1x ');
	const r = await evalPositions(db, [log[2].sfnBefore, log[2].sfnBefore, 'garbage', forged, 7]);
	assert.deepStrictEqual(r, { cached: 0, searched: 1, skipped: 4 });
	const entry = db.dump().position_evals[positionEvalKey(log[2].sfnBefore)];
	assert.strictEqual(entry.sfn, log[2].sfnBefore);
	assert.ok(entry.depth >= 1 && Array.isArray(entry.actions));
	assert.deepStrictEqual(await evalPositions(db, [log[2].sfnBefore]), { cached: 1, searched: 0, skipped: 0 });
});
