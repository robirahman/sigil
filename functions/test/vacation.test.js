'use strict';
// The vacation bank and pauses (vacation.js): node --test test/vacation.test.js

const test = require('node:test');
const assert = require('node:assert');
const { DAY_MS, daysLeft, onVacation, startRecord, endRecord, missingPauses } = require('../vacation');
const { roomTimeLeft } = require('../engine-loader').requireShared('room-clock.js');

const T = Date.UTC(2026, 9, 26, 12);

test('a vacation draws on a 14-day yearly bank', () => {
	assert.strictEqual(daysLeft(null, T), 14);
	const v = startRecord(null, 10, T);
	assert.deepStrictEqual([v.usedDays, v.until, v.days], [10, T + 10 * DAY_MS, 10]);
	assert.ok(onVacation(v, T + DAY_MS));
	assert.strictEqual(startRecord(v, 1, T + DAY_MS).error, 'already-on-vacation');
	const after = Object.assign({}, v, { until: T + 10 * DAY_MS });
	assert.strictEqual(daysLeft(after, T + 11 * DAY_MS), 4);
	assert.strictEqual(startRecord(after, 5, T + 11 * DAY_MS).error, 'not-enough-days');
	assert.strictEqual(startRecord(after, 4, T + 11 * DAY_MS).usedDays, 14);
	for (const bad of [0, -1, 1.5, '3', null]) assert.strictEqual(startRecord(null, bad, T).error, 'invalid-days');
	// A new year, a new bank.
	const ny = Date.UTC(2027, 0, 2);
	assert.strictEqual(daysLeft(Object.assign({}, after, { usedDays: 14 }), ny), 14);
	assert.strictEqual(startRecord(Object.assign({}, after, { usedDays: 14 }), 14, ny).usedDays, 14);
});

test('ending a vacation early refunds the days not begun', () => {
	const v = startRecord({ year: 2026, usedDays: 2 }, 10, T);
	assert.strictEqual(v.usedDays, 12);
	// Two and a half days in: three days used, seven back.
	const e = endRecord(v, T + 2.5 * DAY_MS);
	assert.deepStrictEqual([e.usedDays, e.until, e.days], [5, T + 2.5 * DAY_MS, 3]);
	assert.ok(!onVacation(e, T + 2.5 * DAY_MS));
	assert.strictEqual(daysLeft(e, T + 3 * DAY_MS), 9);
	// An hour in still costs the day; nothing to end once it is over.
	assert.strictEqual(endRecord(v, T + 3_600_000).usedDays, 3);
	assert.strictEqual(endRecord(e, T + 3 * DAY_MS).error, 'not-on-vacation');
	assert.strictEqual(endRecord(null, T).error, 'not-on-vacation');
});

test('a player on vacation in several games is paused in each correspondence game', () => {
	const v = startRecord(null, 3, T);
	const corr = (red, blue, extra) => Object.assign({ status: 'playing', timeControl: { type: 'correspondence', moveTimeout: DAY_MS },
		red: { uid: red }, blue: { uid: blue } }, extra);
	const rooms = {
		A: corr('alice', 'bob'),
		B: corr('carol', 'alice'),
		C: corr('alice', 'dave', { pauses: { p: { color: 'red', from: T, to: v.until } } }),
		D: Object.assign(corr('alice', 'erin'), { timeControl: { type: 'realtime', initialTime: 60_000 } }),
		E: corr('alice', 'frank', { status: 'finished' }),
		F: corr('bob', 'carol'),
	};
	const now = T + 60_000;
	const got = Object.fromEntries(Object.keys(rooms).map((k) => [k, missingPauses(rooms[k], { alice: v }, now)]));
	assert.deepStrictEqual(got, {
		A: [{ uid: 'alice', color: 'red', to: v.until }],
		B: [{ uid: 'alice', color: 'blue', to: v.until }],
		C: [], D: [], E: [], F: [],
	});
	// Each pause holds that game's clock for the vacation's length.
	const room = corr('alice', 'bob', { turns: { t: { color: 'blue', timestamp: T - 3_600_000 } },
		pauses: { p: { color: 'red', from: now, to: v.until } } });
	const left = roomTimeLeft(room, 'red', v.until);
	assert.strictEqual(left, DAY_MS - 3_600_000 - 60_000);
	// Over: no more pauses.
	assert.deepStrictEqual(missingPauses(rooms.A, { alice: v }, v.until), []);
});
