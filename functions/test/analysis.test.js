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
const { analyzeStep, evalPositions, claimEvalQuota, engineWorker, analysisStarted, resumeStalledAnalyses, STALL_MS, STALL_RESUMES, positionEvalKey, ANALYSIS_BATCH, EVAL_DAILY_PER_UID, EVAL_DAILY_TOTAL } = require('../analysis');
const { freshEngine } = require('../engine-loader');
const { fakeDb } = require('./fake-db');
const ONLINE = require('./online-game.json');
const AI = require('./ai-games.json');

const clone = (x) => JSON.parse(JSON.stringify(x));

// Searches after the first test are shortened (opts.timeMs) to keep the run short.
const FAST = 100;

async function runAll(db, gameId, stats, extra) {
	let res, tasks = 0;
	do { res = await analyzeStep(db, gameId, Object.assign({ stats }, extra)); tasks++; } while (!res.done && tasks < 100);
	return Object.assign(res, { tasks });
}

async function hydrate(record) {
	const e = freshEngine();
	return e.reconstructGameLog(record.spellNames, e.normalizeVariant(record.variant), record.setupSfn || null, record.turns);
}

test('a rated game is analysed in batches into a game_evals document the review panel reads', { timeout: 600000 }, async () => {
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
	assert.deepStrictEqual([stored.preset, stored.timeMs], ['server', 1000]);
	// As stored (nulls dropped, arrays as the database returns them), the
	// review panel's reader accepts it for this game.
	const review = freshEngine().rustEvalsToReview(stored, log);
	assert.ok(review, 'rustEvalsToReview accepts the stored document');
	assert.strictEqual(review.source, 'rust');
	assert.strictEqual(review.mode, 'quick', 'a Deep Review may still be computed over it');
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
	await runAll(db, 'A', first, { timeMs: FAST });
	assert.strictEqual(first.hits, 0);
	const second = { hits: 0, searched: 0, ms: 0 };
	const res = await runAll(db, 'B', second, { timeMs: FAST });
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
	assert.match(entry.engine, /^rust-v\d+-[a-z0-9_]+-t1000$/);
});

test('cached positions are searched alone; repeated ones with the game\'s history', async () => {
	const db = fakeDb({ completed_games: { A: Object.assign(clone(AI.N3WMQJ), { roomCode: 'RH' }) } });
	const w = await engineWorker();
	const calls = [];
	const search = w.search;
	w.search = async (req) => { calls.push({ sfn: req.sfn, history: req.historySfns }); return search(req); };
	try {
		await runAll(db, 'A', null, { timeMs: FAST });
	} finally {
		w.search = search;
	}
	const log = await hydrate(AI.N3WMQJ);
	const sfns = log.map((t) => t.sfnBefore).concat([log[log.length - 1].sfnAfter]);
	const cached = new Set(Object.values(db.dump().position_evals).map((e) => e.sfn));
	let repeats = 0;
	for (let i = 0; i < log.length; i++) {
		const c = calls.find((x) => x.sfn === sfns[i] && (cached.has(sfns[i]) ? true : x.history.length > 1));
		assert.ok(c, 'position ' + i + ' was searched');
		if (cached.has(sfns[i]) && !sfns.slice(0, i).some((x) => x === sfns[i])) {
			// The cache entry's search knew nothing of the game.
			assert.deepStrictEqual(calls.filter((x) => x.sfn === sfns[i]).map((x) => x.history), [[sfns[i]]], 'position ' + i);
		} else {
			repeats++;
		}
	}
	assert.ok(cached.size > 0 && cached.size + repeats >= log.length);
});

test('the review document carries the winner as rated, not as the record claims', async () => {
	const rec = Object.assign(clone(ONLINE), { roomCode: 'OVR', winner: ONLINE.winner === 'red' ? 'blue' : 'red' });
	const db = fakeDb({ completed_games: { G: rec } });
	await runAll(db, 'G', null, { timeMs: FAST, winner: ONLINE.winner });
	assert.deepStrictEqual(db.dump().game_evals.OVR.terminal, { winner: ONLINE.winner });
});

test('the evalPositions quota: per account and for the site, per day', async () => {
	const db = fakeDb({});
	const now = Date.UTC(2026, 9, 26, 12);
	assert.strictEqual(await claimEvalQuota(db, 'a', EVAL_DAILY_PER_UID - 5, now), true);
	assert.strictEqual(await claimEvalQuota(db, 'a', 10, now), false);
	assert.strictEqual(await claimEvalQuota(db, 'a', 5, now), true);
	assert.strictEqual(await claimEvalQuota(db, 'a', 1, now + 86400000), true, 'a new day');
	// Many accounts: the site's cap holds, and a refused claim takes nothing.
	let ok = 0;
	for (let k = 0; k < 40; k++) if (await claimEvalQuota(db, 'u' + k, 100, now)) ok++;
	const day = db.dump().eval_quota['2026-10-26'];
	assert.strictEqual(day._total, EVAL_DAILY_TOTAL);
	assert.strictEqual(ok, (EVAL_DAILY_TOTAL - EVAL_DAILY_PER_UID) / 100);
	assert.strictEqual(day.u_u39, 0);
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
	const charged = [];
	const claim = async (n) => { charged.push(n); return true; };
	const r = await evalPositions(db, [log[2].sfnBefore, log[2].sfnBefore, 'garbage', forged, 7], { timeMs: FAST, claim });
	assert.deepStrictEqual(r, { cached: 0, searched: 1, skipped: 4 });
	// Only the position searched is charged; invalid, repeated and cached ones are free.
	assert.deepStrictEqual(charged, [1]);
	await evalPositions(db, [log[2].sfnBefore, 'garbage'], { timeMs: FAST, claim });
	assert.deepStrictEqual(charged, [1]);
	await assert.rejects(evalPositions(db, [log[4].sfnBefore], { timeMs: FAST, claim: async () => false }), /quota/);
	assert.strictEqual(db.dump().position_evals[positionEvalKey(log[4].sfnBefore)], undefined);
	const entry = db.dump().position_evals[positionEvalKey(log[2].sfnBefore)];
	assert.strictEqual(entry.sfn, log[2].sfnBefore);
	assert.ok(entry.depth >= 1 && Array.isArray(entry.actions));
	assert.deepStrictEqual(await evalPositions(db, [log[2].sfnBefore], { timeMs: FAST }), { cached: 1, searched: 0, skipped: 0 });
});

test('a chain that lost its task is resumed from its progress, a few times at most', async () => {
	const db = fakeDb({ completed_games: { G: Object.assign(clone(ONLINE), { roomCode: 'STL' }) } });
	const t0 = Date.UTC(2026, 9, 26, 12);
	await analysisStarted(db, 'G', ONLINE.winner, t0);
	// One task ran, then the chain's next task ran out of retries.
	assert.strictEqual((await analyzeStep(db, 'G', { timeMs: FAST })).done, false);
	const queued = [];
	const enqueue = async (gameId, step, winner) => { queued.push([gameId, step, winner]); };
	assert.deepStrictEqual(await resumeStalledAnalyses(db, Date.now() + 60_000, enqueue), { resumed: 0, dropped: 0 }, 'not yet stalled');
	let now = Date.now() + STALL_MS + 1;
	for (let k = 1; k <= STALL_RESUMES; k++, now += STALL_MS + 1) {
		assert.deepStrictEqual(await resumeStalledAnalyses(db, now, enqueue), { resumed: 1, dropped: 0 });
	}
	const next = ONLINE.turns.length - 1 - 10;
	assert.deepStrictEqual(queued.map((q) => q[1]), [1, 2, 3].map((k) => 'resume' + k + '-' + next));
	assert.ok(queued.every((q) => q[0] === 'G' && q[2] === ONLINE.winner));
	// The progress kept its rows: a resumed task carries on where it stopped.
	assert.strictEqual(db.dump().game_evals_progress.G.next, ONLINE.turns.length - 1 - 10);
	assert.deepStrictEqual(await resumeStalledAnalyses(db, now, enqueue), { resumed: 0, dropped: 1 });
	assert.strictEqual(db.dump().game_evals_progress, undefined);
});
