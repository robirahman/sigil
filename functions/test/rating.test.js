'use strict';
// node --test functions/test/rating.test.js
//
// ai-games.json: four real games against the AI from rooms/ (the human's uid
// and name replaced). online-game.json: a full game of input transcripts,
// made by gen-online-fixture.js.

const test = require('node:test');
const assert = require('node:assert');
const { judgeGame, ratingUpdates, flagged, firstTurnNumber, abandoned, sideToMove, ABANDON_GRACE_MS, freshEngine } = require('../rating');
const AI = require('./ai-games.json');
const ONLINE = require('./online-game.json');

const clone = (x) => JSON.parse(JSON.stringify(x));
const full = async () => true;
// The recorded games' own prices stand in for the server's engine (pricing.js).
const price = async (sfn) => (sfn === AI.W3ZZGX.startPos.sfn ? AI.W3ZZGX.startPos.redWinProb : null);
const ctx = (extra) => Object.assign({ room: null, isFullAccount: full, priceStart: price, now: Date.now() }, extra);

// ---- games against the AI ----

test('a human win against the AI that ends on the board is rated', async () => {
	const v = await judgeGame(AI.N3WMQJ, ctx());
	assert.strictEqual(v.rated, true, v.reason);
	assert.strictEqual(v.winner, 'red');
	assert.match(v.claimKey, /^ai_[0-9a-f]{40}$/);
});

test('an AI win is rated', async () => {
	assert.strictEqual((await judgeGame(AI.F6N5H4, ctx())).rated, true);
});

test('a game from a priced position replays from that position', async () => {
	const v = await judgeGame(AI.W3ZZGX, ctx());
	assert.strictEqual(v.rated, true, v.reason);
	assert.strictEqual(v.startPos.redWinProb, AI.W3ZZGX.startPos.redWinProb);
});

test('the server\'s price replaces the client\'s', async () => {
	const forged = clone(AI.W3ZZGX);
	forged.startPos.redWinProb = 0.001;
	const v = await judgeGame(forged, ctx());
	assert.deepStrictEqual([v.rated, v.startPos.redWinProb, v.startPos.clientRedWinProb, v.startPos.pricedBy],
		[true, AI.W3ZZGX.startPos.redWinProb, 0.001, 'server']);
	assert.strictEqual((await judgeGame(AI.W3ZZGX, ctx({ priceStart: async () => null }))).reason, 'unpriced-start');
});

test('a position game without its price replays from the standard start and fails', async () => {
	const r = clone(AI.W3ZZGX);
	delete r.startPos;
	assert.deepStrictEqual(await judgeGame(r, ctx()), { rated: false, reason: 'result-not-verified', kind: 'ai' });
});

test('a price for another position does not count', async () => {
	const r = clone(AI.W3ZZGX);
	r.startPos.sfn = AI.N3WMQJ.setupSfn;
	assert.strictEqual((await judgeGame(r, ctx())).reason, 'unpriced-start');
});

test('a resignation is rated only when the AI won', async () => {
	assert.strictEqual((await judgeGame(AI.KMFSUZ, ctx())).rated, true);
	const r = clone(AI.KMFSUZ);
	r.winner = 'red';
	assert.strictEqual((await judgeGame(r, ctx())).reason, 'result-not-verified');
});

test('a claimed win the board does not show is refused', async () => {
	const flipped = clone(AI.N3WMQJ);
	flipped.winner = 'blue';
	assert.strictEqual((await judgeGame(flipped, ctx())).reason, 'result-not-verified');
	const cut = clone(AI.N3WMQJ);
	cut.turns.pop();
	assert.strictEqual((await judgeGame(cut, ctx())).reason, 'result-not-verified');
	const snap = clone(AI.N3WMQJ);
	snap.turns[3] = { color: snap.turns[3].color, turnNumber: snap.turns[3].turnNumber, kind: 'snapshot', sfnAfter: snap.finalSfn };
	assert.strictEqual((await judgeGame(snap, ctx())).reason, 'no-transcript');
});

test('casual, guest-account and unrated-pack games are not rated', async () => {
	const casual = clone(AI.N3WMQJ);
	casual.ranked = false;
	assert.strictEqual((await judgeGame(casual, ctx())).reason, 'casual');
	assert.strictEqual((await judgeGame(AI.N3WMQJ, ctx({ isFullAccount: async () => false }))).reason, 'guest-account');
	const panda = clone(AI.N3WMQJ);
	panda.spellNames[0] = 'Stampede';
	assert.strictEqual((await judgeGame(panda, ctx())).reason, 'unrated-pack');
	assert.strictEqual((await judgeGame(Object.assign(clone(AI.N3WMQJ), { guest: true }), ctx())).skip, true);
});

// ---- online games ----

function onlineRoom() {
	const g = ONLINE;
	const turns = {};
	let ts = 1_700_000_000_000;
	g.turns.forEach((t, i) => {
		ts += 10_000;
		turns['-k' + String(i).padStart(4, '0')] = { color: t.color, actions: t.actions, timestamp: ts };
	});
	return {
		spellNames: g.spellNames,
		status: 'finished',
		created: 1_700_000_000_000,
		red: { uid: 'alice', displayName: 'Alice', connected: false },
		blue: { uid: 'bob', displayName: 'Bob', connected: false },
		ranked: true,
		timeControl: { type: 'none' },
		variant: 'standard',
		turns,
		gameLog: g.turns,
		winner: g.winner,
	};
}

function onlineRecord(room) {
	return { spellNames: room.spellNames, winner: room.winner, redUid: 'alice', blueUid: 'bob',
		ranked: true, variant: 'standard', roomCode: 'ABC234', timestamp: 1 };
}

test('an online game is replayed from its turns and rated', async () => {
	const room = onlineRoom();
	const v = await judgeGame(onlineRecord(room), ctx({ room }));
	assert.deepStrictEqual([v.rated, v.winner, v.claimKey, v.kind], [true, ONLINE.winner, 'room_ABC234', 'online']);
	// The finishing client's gameLog is optional for a standard start.
	const bare = onlineRoom();
	delete bare.gameLog;
	assert.strictEqual((await judgeGame(onlineRecord(bare), ctx({ room: bare }))).rated, true);
});

test('an online result must match the room, its seats and its moves', async () => {
	const room = onlineRoom();
	const rec = onlineRecord(room);
	const loser = ONLINE.winner === 'red' ? 'blue' : 'red';
	assert.strictEqual((await judgeGame(Object.assign(clone(rec), { winner: loser }), ctx({ room }))).reason, 'room-result-mismatch');
	const both = Object.assign(onlineRoom(), { winner: loser });
	assert.strictEqual((await judgeGame(Object.assign(clone(rec), { winner: loser }), ctx({ room: both }))).reason, 'result-not-verified');
	assert.strictEqual((await judgeGame(Object.assign(clone(rec), { blueUid: 'mallory' }), ctx({ room }))).reason, 'seat-mismatch');
	assert.strictEqual((await judgeGame(rec, ctx({ room: Object.assign(onlineRoom(), { local: true }) }))).reason, 'no-room');
	assert.strictEqual((await judgeGame(rec, ctx({ room: null }))).reason, 'no-room');
	assert.strictEqual((await judgeGame(rec, ctx({ room: Object.assign(onlineRoom(), { ranked: false }) }))).reason, 'casual');
	assert.strictEqual((await judgeGame(rec, ctx({ room: Object.assign(onlineRoom(), { casual: true }) }))).reason, 'casual');
	// The finishing client's gameLog plays no part: one that reloaded
	// mid-game holds only the turns since.
	const reloaded = onlineRoom();
	reloaded.gameLog = reloaded.gameLog.slice(-5);
	assert.strictEqual((await judgeGame(rec, ctx({ room: reloaded }))).rated, true);
	// a turn missing from turns/
	const short = onlineRoom();
	delete short.gameLog;
	delete short.turns[Object.keys(short.turns).sort().pop()];
	assert.strictEqual((await judgeGame(rec, ctx({ room: short }))).reason, 'result-not-verified');
});

test('a result the room does not support is the finisher\'s resignation', async () => {
	const loser = ONLINE.winner === 'red' ? 'blue' : 'red';
	const room = Object.assign(onlineRoom(), { winner: loser, finishedBy: loser });
	const v = await judgeGame(Object.assign(onlineRecord(room), { winner: loser }), ctx({ room }));
	assert.deepStrictEqual([v.rated, v.winner, v.overturned], [true, ONLINE.winner, true]);
	// The Elo and both histories follow the verdict, not the claim.
	const u = ratingUpdates('G9', Object.assign(onlineRecord(room), { winner: loser }), v,
		{ red: { elo: 1000 }, blue: { elo: 1000 } }, { red: true, blue: true }, freshEngine());
	assert.strictEqual(u['user_games/' + (ONLINE.winner === 'red' ? 'alice' : 'bob') + '/G9'].result, 'win');
	assert.strictEqual(u['users/' + (ONLINE.winner === 'red' ? 'alice' : 'bob') + '/elo'], 1016);
	// A duplicate record leaves the histories alone.
	assert.deepStrictEqual(Object.keys(ratingUpdates('G10', onlineRecord(room), { rated: false, reason: 'duplicate' },
		{ red: {}, blue: {} }, { red: true, blue: true }, freshEngine())).sort(),
	['completed_games/G10/eloProcessed', 'completed_games/G10/unratedReason']);
});

test('a forfeit counts only when the loser wrote it', async () => {
	const room = Object.assign(onlineRoom(), { winner: 'red', forfeitedBy: 'blue' });
	delete room.gameLog;
	room.turns = {};
	const rec = Object.assign(onlineRecord(room), { winner: 'red' });
	assert.strictEqual((await judgeGame(rec, ctx({ room }))).rated, true);
	room.forfeitedBy = 'red';
	assert.strictEqual((await judgeGame(rec, ctx({ room }))).reason, 'result-not-verified');
});

test('a loss on time counts only if the clock was out when the room closed', async () => {
	const room = onlineRoom();
	delete room.gameLog;
	const keys = Object.keys(room.turns).sort().slice(0, 10);
	room.turns = Object.fromEntries(keys.map((k) => [k, room.turns[k]]));
	const last = room.turns[keys[keys.length - 1]];
	const loser = last.color === 'red' ? 'blue' : 'red';
	Object.assign(room, { timeControl: { type: 'realtime', initialTime: 60_000, increment: 0 },
		endReason: 'time', winner: last.color, finishedBy: last.color });
	const rec = Object.assign(onlineRecord(room), { winner: last.color });
	// Closed ten seconds into a minute: an early claim, however late it is rated.
	room.closedAt = last.timestamp + 10_000;
	const early = await judgeGame(rec, ctx({ room, now: last.timestamp + 3_600_000 }));
	assert.deepStrictEqual([early.rated, early.winner, early.overturned], [true, loser, true]);
	room.closedAt = last.timestamp + 61_000;
	const v = await judgeGame(rec, ctx({ room }));
	assert.deepStrictEqual([v.rated, v.winner, v.overturned], [true, last.color, undefined]);
});

test('an upheld abandonment claim names the player who left', async () => {
	const room = onlineRoom();
	delete room.gameLog;
	const keys = Object.keys(room.turns).sort().slice(0, 4);
	room.turns = Object.fromEntries(keys.map((k) => [k, room.turns[k]]));
	const lastTs = room.turns[keys[3]].timestamp;
	Object.assign(room, { timeControl: { type: 'realtime', initialTime: 600_000, increment: 0 },
		endReason: 'abandon', winner: 'red', finishedBy: 'red',
		blue: { uid: 'bob', connected: false, disconnectedAt: lastTs + 1000 } });
	const rec = Object.assign(onlineRecord(room), { winner: 'red' });
	room.closedAt = lastTs + 1000 + ABANDON_GRACE_MS;
	const v = await judgeGame(rec, ctx({ room }));
	assert.deepStrictEqual([v.rated, v.winner, v.abandonedBy], [true, 'red', 'blue']);
	// A claim made too early is the claimer's loss, and nobody's abandonment.
	room.closedAt = lastTs + 5000;
	const early = await judgeGame(rec, ctx({ room }));
	assert.deepStrictEqual([early.rated, early.winner, early.overturned, early.abandonedBy], [true, 'blue', true, undefined]);
});

test('a loss on time is recomputed from the turn timestamps', () => {
	const t0 = 1_000_000;
	const room = {
		timeControl: { type: 'realtime', initialTime: 60_000, increment: 0 },
		turns: {
			a: { color: 'red', timestamp: t0 },
			b: { color: 'blue', timestamp: t0 + 30_000 },
			c: { color: 'red', timestamp: t0 + 50_000 },
		},
	};
	// Blue spent 30 s and has 30 s left from t0 + 50 s.
	assert.strictEqual(flagged(room, 'blue', t0 + 70_000), false);
	assert.strictEqual(flagged(room, 'blue', t0 + 79_000), true);
	// Red is not on move, so red cannot have flagged.
	assert.strictEqual(flagged(room, 'red', t0 + 500_000), false);
	room.timeControl.increment = 5_000;
	assert.strictEqual(flagged(room, 'blue', t0 + 79_000), false);
	// Nobody has moved: the first mover's clock runs from startedAt.
	const fresh = { timeControl: { type: 'realtime', initialTime: 60_000 }, startedAt: t0 };
	assert.strictEqual(flagged(fresh, 'red', t0 + 30_000), false);
	assert.strictEqual(flagged(fresh, 'red', t0 + 59_000), true);
	assert.strictEqual(flagged(fresh, 'blue', t0 + 600_000), false);
	assert.strictEqual(flagged({ timeControl: fresh.timeControl }, 'red', t0 + 600_000), false);
	const corr = { timeControl: { type: 'correspondence', moveTimeout: 86_400_000 }, turns: room.turns };
	assert.strictEqual(flagged(corr, 'blue', t0 + 50_000 + 3_600_000), false);
	assert.strictEqual(flagged(corr, 'blue', t0 + 50_000 + 86_400_000), true);
});

// ---- vacation pauses and +15 s gifts (room-clock.js) ----

const DAY = 86_400_000;

// A correspondence room cut to its first ten turns, closed with a claim on
// time by the side that moved last; `at` is the last turn's time.
function corrClaim() {
	const room = onlineRoom();
	delete room.gameLog;
	const keys = Object.keys(room.turns).sort().slice(0, 10);
	room.turns = Object.fromEntries(keys.map((k) => [k, room.turns[k]]));
	const last = room.turns[keys[keys.length - 1]];
	const loser = last.color === 'red' ? 'blue' : 'red';
	Object.assign(room, { timeControl: { type: 'correspondence', moveTimeout: DAY },
		endReason: 'time', winner: last.color, finishedBy: last.color });
	return { room, rec: Object.assign(onlineRecord(room), { winner: last.color }), at: last.timestamp, loser };
}

test('a paused correspondence game is not flagged', async () => {
	const t0 = 1_000_000;
	const room = {
		timeControl: { type: 'correspondence', moveTimeout: DAY },
		turns: { a: { color: 'red', timestamp: t0 } },
		// Blue went on vacation an hour into the move, for three days.
		pauses: { p: { color: 'blue', from: t0 + 3_600_000, to: t0 + 3_600_000 + 3 * DAY } },
	};
	assert.strictEqual(flagged(room, 'blue', t0 + 2 * DAY), false);
	assert.strictEqual(flagged(room, 'blue', t0 + 3 * DAY + 3_600_000), false);
	assert.strictEqual(flagged(room, 'blue', t0 + 4 * DAY - 10_000), false);
	assert.strictEqual(flagged(room, 'blue', t0 + 4 * DAY), true);
	// Ended early (setVacation writes `to`): the clock runs again from then.
	room.pauses.p.to = t0 + DAY;
	assert.strictEqual(flagged(room, 'blue', t0 + 2 * DAY - 3_600_000 - 10_000), false);
	assert.strictEqual(flagged(room, 'blue', t0 + 2 * DAY - 3_600_000), true);
	// Two overlapping pauses count once; a pause before the move counts nothing.
	room.pauses = {
		p: { color: 'blue', from: t0 + 1000, to: t0 + 1000 + DAY },
		q: { color: 'blue', from: t0 + 1000 + DAY / 2, to: t0 + 1000 + DAY },
		old: { color: 'blue', from: t0 - 5 * DAY, to: t0 },
	};
	assert.strictEqual(flagged(room, 'blue', t0 + 2 * DAY - 10_000), false);
	assert.strictEqual(flagged(room, 'blue', t0 + 2 * DAY + 1000), true);
	// The rating function: a claim made while the loser was on vacation is
	// the claimer's own loss.
	const c = corrClaim();
	c.room.pauses = { p: { color: c.loser, from: c.at + 1000, to: c.at + 5 * DAY } };
	c.room.closedAt = c.at + DAY + 3_600_000;
	const v = await judgeGame(c.rec, ctx({ room: c.room }));
	assert.deepStrictEqual([v.rated, v.winner, v.overturned], [true, c.loser, true]);
	delete c.room.pauses;
	const w = await judgeGame(c.rec, ctx({ room: c.room }));
	assert.deepStrictEqual([w.rated, w.winner, w.overturned], [true, c.rec.winner, undefined]);
});

test('a gift of 15 s extends the opponent\'s time', () => {
	const t0 = 1_000_000;
	const room = {
		timeControl: { type: 'realtime', initialTime: 60_000, increment: 0 },
		turns: {
			a: { color: 'red', timestamp: t0 },
			b: { color: 'blue', timestamp: t0 + 30_000 },
			c: { color: 'red', timestamp: t0 + 50_000 },
		},
	};
	// Blue has 30 s from t0 + 50 s (see above); red gives blue 15 s.
	assert.strictEqual(flagged(room, 'blue', t0 + 80_000), true);
	room.gifts = { g: { to: 'blue', ms: 15_000, at: t0 + 60_000 } };
	assert.strictEqual(flagged(room, 'blue', t0 + 80_000), false);
	assert.strictEqual(flagged(room, 'blue', t0 + 94_000), true);
	// Two gifts, two times 15 s; a gift to red gives blue nothing.
	room.gifts.h = { to: 'blue', ms: 15_000, at: t0 + 61_000 };
	room.gifts.r = { to: 'red', ms: 15_000, at: t0 + 62_000 };
	assert.strictEqual(flagged(room, 'blue', t0 + 107_000), false);
	assert.strictEqual(flagged(room, 'blue', t0 + 109_000), true);
	// Before the first move too.
	const fresh = { timeControl: { type: 'realtime', initialTime: 60_000 }, startedAt: t0,
		gifts: { g: { to: 'red', ms: 15_000, at: t0 + 1000 } } };
	assert.strictEqual(flagged(fresh, 'red', t0 + 70_000), false);
	assert.strictEqual(flagged(fresh, 'red', t0 + 74_000), true);
});

test('forged or late pauses and gifts change nothing', async () => {
	const t0 = 1_000_000;
	const turns = { a: { color: 'red', timestamp: t0 }, b: { color: 'blue', timestamp: t0 + 30_000 }, c: { color: 'red', timestamp: t0 + 50_000 } };
	// A pause in a realtime game, a gift in a correspondence game, a gift of
	// another size, a malformed pause: all ignored.
	const live = { timeControl: { type: 'realtime', initialTime: 60_000 }, turns,
		pauses: { p: { color: 'blue', from: t0 + 50_000, to: t0 + 10 * DAY } },
		gifts: { big: { to: 'blue', ms: 600_000, at: t0 + 55_000 }, bad: { to: 'blue', ms: 15_000, at: 'now' } } };
	assert.strictEqual(flagged(live, 'blue', t0 + 80_000), true);
	const corr = { timeControl: { type: 'correspondence', moveTimeout: DAY }, turns,
		gifts: { g: { to: 'blue', ms: 15_000, at: t0 + 55_000 } },
		pauses: { p: { color: 'blue', from: String(t0), to: t0 + 10 * DAY }, q: { color: 'blue', from: t0 + 3 * DAY, to: t0 + DAY } } };
	assert.strictEqual(flagged(corr, 'blue', t0 + 50_000 + DAY), true);
	// A pause or a gift recorded after the room closed does not count: the
	// flag is judged as of closedAt.
	const c = corrClaim();
	c.room.closedAt = c.at + DAY + 3_600_000;
	c.room.pauses = { p: { color: c.loser, from: c.room.closedAt + 1, to: c.at + 5 * DAY } };
	const v = await judgeGame(c.rec, ctx({ room: c.room }));
	assert.deepStrictEqual([v.rated, v.winner, v.overturned], [true, c.rec.winner, undefined]);
	const r = corrClaim();
	r.room.timeControl = { type: 'realtime', initialTime: 60_000, increment: 0 };
	r.room.closedAt = r.at + 61_000;
	r.room.gifts = { g: { to: r.loser, ms: 15_000, at: r.room.closedAt + 1 } };
	const g = await judgeGame(r.rec, ctx({ room: r.room }));
	assert.deepStrictEqual([g.rated, g.winner, g.overturned], [true, r.rec.winner, undefined]);
	// Gifts in time would have saved the loser (the clock was well out).
	for (let i = 0; i < 100; i++) r.room.gifts['g' + i] = { to: r.loser, ms: 15_000, at: r.room.closedAt - 5_000 };
	const h = await judgeGame(r.rec, ctx({ room: r.room }));
	assert.deepStrictEqual([h.rated, h.winner, h.overturned], [true, r.loser, true]);
});

test('turn numbers follow both start-SFN conventions', () => {
	assert.strictEqual(firstTurnNumber(null, 'red'), 1);
	// An AI game's setupSfn is its first turn's sfnBefore.
	assert.strictEqual(firstTurnNumber(AI.W3ZZGX.setupSfn, 'red'), 17);
	// A room's startSfn is the position before it (tools/browser/position-room-test.js: 'r 13', Blue moves at 14).
	assert.strictEqual(firstTurnNumber('r..b/A,B r 13 0:0 -:- -:- b1', 'blue'), 14);
});

test('a game can be claimed only after the opponent has been gone for the grace period', async () => {
	const t0 = 1_000_000;
	const room = { timeControl: { type: 'realtime', initialTime: 600_000 },
		turns: { a: { color: 'red', timestamp: t0 }, b: { color: 'blue', timestamp: t0 + 1000 } },
		red: { uid: 'alice', connected: true }, blue: { uid: 'bob', connected: false, disconnectedAt: t0 + 2000 } };
	assert.strictEqual(abandoned(room, 'blue', t0 + 2000 + 30_000), false);
	assert.strictEqual(abandoned(room, 'blue', t0 + 2000 + ABANDON_GRACE_MS), true);
	assert.strictEqual(abandoned(room, 'red', t0 + 10_000_000), false);
	// Back again, or before both have moved, or by correspondence: no claim.
	assert.strictEqual(abandoned(Object.assign({}, room, { blue: { connected: true } }), 'blue', t0 + 10_000_000), false);
	assert.strictEqual(abandoned(Object.assign({}, room, { turns: { a: room.turns.a } }), 'blue', t0 + 10_000_000), false);
	assert.strictEqual(abandoned(Object.assign({}, room, { timeControl: { type: 'correspondence', moveTimeout: 1 } }), 'blue', t0 + 10_000_000), false);
	// Another tab of the same player still connected: not gone.
	const twoTabs = Object.assign({}, room, { blue: Object.assign({}, room.blue, { conns: { c2: t0 } }) });
	assert.strictEqual(abandoned(twoTabs, 'blue', t0 + 10_000_000), false);
	// Two turns of one colour are not both players moving.
	const oneSided = Object.assign({}, room, { turns: { a: room.turns.a, b: { color: 'red', timestamp: t0 + 1000 } } });
	assert.strictEqual(abandoned(oneSided, 'blue', t0 + 10_000_000), false);
	assert.strictEqual(sideToMove(room), 'red');
	// A room's startSfn is the position before the first turn: counter 13 -> Blue moves at 14.
	assert.strictEqual(sideToMove({ startSfn: 'x r 13 0:0' }), 'blue');
	assert.strictEqual(sideToMove({}), 'red');
});

// ---- the writes ----

test('ratingUpdates moves Elo by the client formula and indexes both humans', async () => {
	const e = freshEngine();
	const v = await judgeGame(AI.N3WMQJ, ctx());
	const users = { red: { elo: 1500, gamesPlayed: 10, wins: 6, losses: 4, displayName: 'P' },
		blue: { elo: 1500, gamesPlayed: 99, wins: 50, losses: 49, displayName: 'AI (Medium) (Rust)', isAI: true } };
	const u = ratingUpdates('G1', AI.N3WMQJ, v, users, { red: true, blue: false }, e);
	assert.strictEqual(u['users/human_player_1/elo'], 1516);
	assert.strictEqual(u['users/__ai_rust_medium__/elo'], 1484);
	assert.strictEqual(u['users/human_player_1/wins'], 7);
	assert.strictEqual(u['users/__ai_rust_medium__/losses'], 50);
	assert.strictEqual(u['leaderboard/__ai_rust_medium__/displayName'], 'AI (Medium) (Rust)');
	assert.strictEqual(u['completed_games/G1/eloChange'], 16);
	assert.deepStrictEqual(Object.keys(u).filter((k) => k.startsWith('user_games/')), ['user_games/human_player_1/G1']);
	assert.strictEqual(u['user_games/human_player_1/G1'].eloChange, 16);
	assert.strictEqual(u['user_games/human_player_1/G1'].rated, true);

	const n = ratingUpdates('G2', AI.N3WMQJ, { rated: false, reason: 'casual' }, users, { red: true, blue: true }, e);
	assert.deepStrictEqual(Object.keys(n).sort(),
		['completed_games/G2/eloProcessed', 'completed_games/G2/unratedReason', 'user_games/human_player_1/G2']);
	assert.strictEqual(n['user_games/human_player_1/G2'].rated, false);
	assert.strictEqual(n['user_games/human_player_1/G2'].eloChange, undefined);
});

test('ratingUpdates stores the opponent\'s rating before the game, and profile stats use it for AI games', async () => {
	const e = freshEngine();
	const v = await judgeGame(AI.N3WMQJ, ctx());
	const users = { red: { elo: 1500, gamesPlayed: 10, wins: 6, losses: 4, displayName: 'P' },
		blue: { elo: 1733, gamesPlayed: 99, wins: 50, losses: 49, displayName: 'AI (Very Hard) (Rust)', isAI: true } };
	const u = ratingUpdates('G3', AI.N3WMQJ, v, users, { red: true, blue: true }, e);
	const entry = u['user_games/human_player_1/G3'];
	assert.strictEqual(entry.eloBefore, 1500);
	assert.strictEqual(entry.opponentEloBefore, 1733);
	assert.strictEqual(entry.opponentIsAI, true);
	// An unrated game stores no ratings.
	const n = ratingUpdates('G4', AI.N3WMQJ, { rated: false, reason: 'casual' }, users, { red: true, blue: true }, e);
	assert.strictEqual(n['user_games/human_player_1/G4'].opponentEloBefore, undefined);

	// profile-stats.js: the stored rating wins over the looked-up one, and lets
	// an AI game (no lookup possible) count as the best win.
	const ProfileStats = require('../../docs/static/scripts/profile-stats.js');
	const g = (id, result, extra) => Object.assign({ id, gameId: id, timestamp: 1, opponent: id, color: 'red', result, rated: true, eloChange: 0 }, extra);
	const games = [
		Object.assign(g('ai', 'win', { opponentIsAI: true }), { opponentEloBefore: entry.opponentEloBefore }),
		g('human', 'win', { opponentUid: 'h', opponentEloBefore: 1600 }),
		g('oldHuman', 'loss', { opponentUid: 'o' }),
		g('oldAi', 'win', { opponentIsAI: true }),
		g('unrated', 'win', { rated: false, opponentEloBefore: 2500 }),
	];
	const looked = { human: 1, oldHuman: 1400 };
	const s = ProfileStats.summarize(games, () => null, (x) => looked[x.id]);
	assert.strictEqual(s.bests.bestWin.game.id, 'ai');
	assert.strictEqual(s.bests.bestWin.oppElo, 1733);
	assert.strictEqual(s.bests.worstLoss.game.id, 'oldHuman');
	assert.strictEqual(s.bests.worstLoss.oppElo, 1400);
});
