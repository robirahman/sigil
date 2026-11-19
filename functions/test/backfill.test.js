'use strict';
// node --test functions/test/backfill.test.js
//
// scripts/backfill-glicko.js replays the rated games to the same pool
// ratings the rating function writes game by game, and --undo removes
// exactly what it wrote.

const test = require('node:test');
const assert = require('node:assert');
const { ratingUpdates, freshEngine } = require('../rating');
const { buildPlan, buildUndo, applyPlan, indexes, ratedGames } = require('../scripts/backfill-glicko');
const { fakeDb } = require('./fake-db');

const T0 = 1790000000000;
const HOUR = 3600000;
const rt = (m, i) => ({ type: 'realtime', initialTime: m * 60000, increment: i * 1000 });

// A history: humans a, b, c and an AI tier, in several pools, one game from a
// priced position and one from a proven one.
function history() {
	const g = (redUid, blueUid, winner, variant, timeControl, extra) => Object.assign({ redUid, blueUid, winner, variant, timeControl, ranked: true }, extra);
	const AI = '__ai_rust_hard__';
	return [
		g('a', 'b', 'red', 'standard', rt(5, 0)),
		g('b', 'c', 'blue', 'standard', rt(5, 0)),
		g('a', AI, 'blue', 'competitive', { type: 'none' }),
		g('c', 'a', 'red', 'standard', rt(1, 0)),
		g('a', 'b', 'red', 'standard', rt(5, 3)),
		g(AI, 'b', 'blue', 'competitive', rt(10, 0)),
		g('b', 'a', 'red', 'standard', { type: 'correspondence', moveTimeout: 86400000 }, { startPos: { sfn: 'x', redWinProb: 0.7 } }),
		g('a', 'c', 'red', 'standard', { type: 'none' }, { startPos: { sfn: 'y', redWinProb: 1 } }),
		g('c', 'b', 'blue', 'standard', rt(3, 2)),
		g('a', 'b', 'blue', 'standard', rt(5, 0)),
	].map((r, i) => Object.assign(r, { timestamp: T0 + i * 7 * HOUR }));
}

// What the rating function writes for these games, one at a time, with the
// pool ratings on (rateGame's `now` taken as the record's time).
function rateLive(games) {
	const db = { users: {
		a: { displayName: 'Ann', elo: 1000, gamesPlayed: 0, wins: 0, losses: 0 },
		b: { displayName: 'Bob', elo: 1000, gamesPlayed: 0, wins: 0, losses: 0 },
		c: { displayName: 'Cy', elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, isDeveloper: true },
		__ai_rust_hard__: { displayName: 'AI (Hard) (Rust)', elo: 1600, gamesPlayed: 50, wins: 25, losses: 25, isAI: true },
	}, leaderboard: {}, ratings: {}, user_games: {}, completed_games: {}, pool_leaderboard: {} };
	const e = freshEngine();
	games.forEach((rec, i) => {
		const id = 'G' + i;
		db.completed_games[id] = JSON.parse(JSON.stringify(rec));
		const verdict = { rated: true, kind: 'ai', winner: rec.winner, startPos: rec.startPos || null };
		const pool = require('../rating').poolOfRecord(rec, e);
		const pools = { red: (db.ratings[rec.redUid] || {})[pool] || null, blue: (db.ratings[rec.blueUid] || {})[pool] || null, now: rec.timestamp };
		const u = ratingUpdates(id, rec, verdict, { red: db.users[rec.redUid], blue: db.users[rec.blueUid] }, { red: true, blue: true }, e, pools);
		for (const [k, v] of Object.entries(u)) {
			const ps = k.split('/');
			let node = db;
			for (const p of ps.slice(0, -1)) node = (node[p] = node[p] || {});
			node[ps[ps.length - 1]] = JSON.parse(JSON.stringify(v));
		}
	});
	return db;
}

// The same database as the old function left it: no pool ratings anywhere.
function withoutGlicko(db) {
	const d = JSON.parse(JSON.stringify(db));
	delete d.ratings;
	delete d.pool_leaderboard;
	for (const g of Object.values(d.completed_games)) { delete g.pool; delete g.glicko; delete g.ratedWinner; }
	for (const games of Object.values(d.user_games)) for (const e of Object.values(games)) delete e.glicko;
	return d;
}

test('the replay gives the ratings the function writes game by game', () => {
	const live = rateLive(history());
	const old = withoutGlicko(live);
	const ix = indexes(old.leaderboard, old.users, old.user_games);
	const plan = buildPlan(old.completed_games, ix.names, ix.entries, ix.devs);
	assert.strictEqual(plan.stats.games, 10);
	assert.deepStrictEqual(plan.stats.perPool, { blitz: 5, competitive: 2, bullet: 1, correspondence: 1, untimed: 1 });
	// Every pool record, leaderboard row and per-game glicko matches.
	for (const [uid, pools] of Object.entries(live.ratings)) {
		for (const [pool, rec] of Object.entries(pools)) assert.deepStrictEqual(plan.set['ratings/' + uid + '/' + pool], rec, uid + ' ' + pool);
	}
	for (const [pool, rows] of Object.entries(live.pool_leaderboard)) {
		for (const [uid, row] of Object.entries(rows)) assert.deepStrictEqual(plan.set['pool_leaderboard/' + pool + '/' + uid], row, pool + ' ' + uid);
	}
	for (const [uid, games] of Object.entries(live.user_games)) {
		for (const [id, e] of Object.entries(games)) assert.deepStrictEqual(plan.set['user_games/' + uid + '/' + id + '/glicko'], e.glicko, uid + ' ' + id);
	}
	for (const [id, g] of Object.entries(live.completed_games)) {
		assert.strictEqual(plan.set['completed_games/' + id + '/pool'], g.pool);
		assert.deepStrictEqual(plan.set['completed_games/' + id + '/glicko'], g.glicko);
	}
	// The AI is anchored at its Elo before each game; its pool record moved
	// only its counters.
	assert.strictEqual(plan.set['pool_leaderboard/blitz/c'].isDeveloper, true);
	const ai = plan.set['ratings/__ai_rust_hard__/competitive'];
	assert.deepStrictEqual([ai.n, ai.w, ai.l, ai.ai], [2, 1, 1, true]);
	assert.strictEqual(ai.r, live.completed_games.G5.redEloBefore);
	// Nothing the plan writes touches the Elo.
	assert.ok(Object.keys(plan.set).every((k) => /^(ratings|pool_leaderboard)\/|\/glicko$|\/pool$/.test(k)));
});

test('unrated, guest and deleted-player games are not replayed', () => {
	const live = rateLive(history().slice(0, 2));
	const old = withoutGlicko(live);
	old.completed_games.U1 = { redUid: 'a', blueUid: 'b', winner: 'red', timestamp: T0, eloProcessed: true, unratedReason: 'casual' };
	old.completed_games.U2 = { guest: true, winner: 'red', timestamp: T0, eloChange: 5 };
	old.completed_games.U3 = Object.assign({}, old.completed_games.G0, { redUid: 'deleted' });
	assert.deepStrictEqual(ratedGames(old.completed_games).map((g) => g.id), ['G0', 'G1']);
});

test('apply and undo on a database', async () => {
	const live = rateLive(history());
	const old = withoutGlicko(live);
	const db = fakeDb(old);
	const ix = indexes(old.leaderboard, old.users, old.user_games);
	const plan = buildPlan(old.completed_games, ix.names, ix.entries, ix.devs);
	await applyPlan(db, plan.set);
	const d = db.dump();
	// (As stored: the database drops nulls.)
	assert.deepStrictEqual(d.ratings, live.ratings);
	assert.deepStrictEqual(d.user_games, fakeDb(live).dump().user_games);
	// Running it again changes nothing.
	await applyPlan(db, buildPlan(d.completed_games, ix.names, ix.entries, ix.devs).set);
	assert.deepStrictEqual(db.dump().ratings, live.ratings);
	// Undo: back to the database as it was (ratedWinner aside, which only the new function writes).
	const after = db.dump();
	const undo = buildUndo(after.completed_games, after.user_games, after.ratings, after.pool_leaderboard);
	await applyPlan(db, undo.set);
	const back = db.dump();
	const was = fakeDb(old).dump();
	assert.strictEqual(back.ratings, undefined);
	assert.strictEqual(back.pool_leaderboard, undefined);
	assert.deepStrictEqual(back, was);
});
