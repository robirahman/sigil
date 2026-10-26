'use strict';
// vacation.js against the Realtime Database emulator (admin rights, as the
// functions run):
//   firebase emulators:exec --only database --project demo-sigil 'node --test test/vacation-db.test.js'

const test = require('node:test');
const assert = require('node:assert');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getDatabaseWithUrl } = require('firebase-admin/database');
const { setVacation, pauseNewGames, pauseKey } = require('../vacation');
const { finishRoom, expireRooms } = require('../rooms');

const app = initializeApp({ projectId: 'demo-sigil' }, 'vacation-db');
const db = getDatabaseWithUrl('https://vacation-db-test.firebaseio.com', app);
test.after(() => deleteApp(app));
test.beforeEach(() => db.ref().set(null));

const DAY = 86_400_000;
const corr = { type: 'correspondence', moveTimeout: DAY };
const room = (status, tc, red, blue) => ({ status, timeControl: tc, red: { uid: red }, blue: { uid: blue }, startedAt: Date.now() - 1000 });

test('a vacation pauses open correspondence games once, and ends their pauses', async () => {
	await db.ref('rooms').set({
		A: room('playing', corr, 'alice', 'bob'),
		B: room('playing', corr, 'carol', 'alice'),
		F: room('finished', corr, 'alice', 'dave'),
		L: room('playing', { type: 'realtime', initialTime: 60000 }, 'alice', 'erin'),
	});
	const res = await setVacation(db, 'alice', 3, Date.now());
	assert.strictEqual(res.rooms, 2);
	const v = (await db.ref('vacations/alice').once('value')).val();
	const rooms = (await db.ref('rooms').once('value')).val();
	assert.deepStrictEqual(Object.keys(rooms.A.pauses), [pauseKey('alice', v.from, 'red')]);
	assert.deepStrictEqual(Object.keys(rooms.B.pauses), [pauseKey('alice', v.from, 'blue')]);
	assert.ok(!rooms.F.pauses && !rooms.L.pauses);
	const p = rooms.A.pauses[pauseKey('alice', v.from, 'red')];
	assert.ok(p.from >= v.from && p.to === v.until);
	// Overlapping sweeps (and a new game) add one pause per seat, no more.
	await db.ref('rooms/N').set(room('playing', corr, 'frank', 'alice'));
	await Promise.all([pauseNewGames(db, Date.now()), pauseNewGames(db, Date.now()), pauseNewGames(db, Date.now())]);
	const after = (await db.ref('rooms').once('value')).val();
	assert.strictEqual(Object.keys(after.A.pauses).length, 1);
	assert.strictEqual(Object.keys(after.B.pauses).length, 1);
	assert.deepStrictEqual(Object.keys(after.N.pauses), [pauseKey('alice', v.from, 'blue')]);
	// A game that finished keeps its pause as it was; the open ones end now.
	await db.ref('rooms/B/status').set('finished');
	const t0 = Date.now();
	await setVacation(db, 'alice', 0, Date.now());
	const ended = (await db.ref('rooms').once('value')).val();
	const a = ended.A.pauses[pauseKey('alice', v.from, 'red')];
	assert.ok(a.to >= t0 && a.to <= Date.now(), JSON.stringify(a));

	assert.ok(ended.N.pauses[pauseKey('alice', v.from, 'blue')].to < v.until);
	assert.strictEqual(ended.B.pauses[pauseKey('alice', v.from, 'blue')].to, v.until);
	assert.strictEqual((await db.ref('vacations/alice/used/' + new Date().getUTCFullYear()).once('value')).val(), 1);
});

test('a pause a sweep adds after the vacation ended is ended by the next sweep', async () => {
	await db.ref('rooms/A').set(room('playing', corr, 'alice', 'bob'));
	await setVacation(db, 'alice', 3, Date.now());
	const v = (await db.ref('vacations/alice').once('value')).val();
	await setVacation(db, 'alice', 0, Date.now());
	const end = (await db.ref('vacations/alice/until').once('value')).val();
	// A late writer holding the old record (a sweep, or a failed cleanup).
	await db.ref('rooms/B').set(Object.assign(room('playing', corr, 'carol', 'alice'),
		{ pauses: { [pauseKey('alice', v.from, 'blue')]: { color: 'blue', from: end + 10, to: v.until } } }));
	await pauseNewGames(db, Date.now());
	const p = (await db.ref('rooms/B/pauses/' + pauseKey('alice', v.from, 'blue')).once('value')).val();
	assert.deepStrictEqual([p.from, p.to], [end + 10, end + 10]);
	const a = (await db.ref('rooms/A/pauses/' + pauseKey('alice', v.from, 'red')).once('value')).val();
	assert.ok(a.to <= end + 1000 && a.to < v.until, JSON.stringify(a));
});

test('the server ends a game on time only if the clock is still out inside the transaction', async () => {
	const t = Date.now() - 2 * DAY;
	await db.ref('rooms/X').set(Object.assign(room('playing', corr, 'alice', 'bob'), { startedAt: t,
		turns: { a: { color: 'red', actions: ['pass'], timestamp: t } } }));
	// Read as out, then a pause landed: the transaction re-checks and leaves it.
	const ok = await finishRoom(db, 'X', 'playing', { winner: 'red', endReason: 'time' }, () => false);
	assert.strictEqual(ok, false);
	assert.strictEqual((await db.ref('rooms/X/status').once('value')).val(), 'playing');
	assert.strictEqual(await expireRooms(db, Date.now()), 1);
	assert.strictEqual((await db.ref('rooms/X/status').once('value')).val(), 'finished');
});

test('ending an old vacation leaves the pause of a newer one alone', async () => {
	await db.ref('rooms/A').set(room('playing', corr, 'alice', 'bob'));
	await setVacation(db, 'alice', 2, Date.now());
	const old = (await db.ref('vacations/alice').once('value')).val();
	await setVacation(db, 'alice', 0, Date.now());
	const ended = (await db.ref('vacations/alice').once('value')).val();
	await new Promise((r) => setTimeout(r, 5));
	await setVacation(db, 'alice', 3, Date.now());
	const fresh = (await db.ref('vacations/alice').once('value')).val();
	// A sweep holding the record from before the new vacation.
	const { pauseDueEnd } = require('../vacation');
	const pauses = (await db.ref('rooms/A/pauses').once('value')).val();
	const nk = pauseKey('alice', fresh.from, 'red');
	assert.ok(pauses[nk] && pauses[nk].to === fresh.until);
	for (const stale of [old, ended]) assert.strictEqual(pauseDueEnd(nk, pauses[nk], { alice: stale }, Date.now()), null);
	await pauseNewGames(db, Date.now());
	const after = (await db.ref('rooms/A/pauses/' + nk).once('value')).val();
	assert.strictEqual(after.to, fresh.until);
});
