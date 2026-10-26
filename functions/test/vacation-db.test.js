'use strict';
// vacation.js against the Realtime Database emulator (admin rights, as the
// functions run):
//   firebase emulators:exec --only database --project demo-sigil 'node --test test/vacation-db.test.js'

const test = require('node:test');
const assert = require('node:assert');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getDatabaseWithUrl } = require('firebase-admin/database');
const { setVacation, pauseNewGames, pauseKey } = require('../vacation');

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
	assert.strictEqual((await db.ref('vacations/alice/usedDays').once('value')).val(), 1);
});
