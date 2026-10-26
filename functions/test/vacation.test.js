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

test('the game page\'s clocks add the pauses and gifts its timer node leaves out', () => {
	const { roomTimerView } = require('../engine-loader').requireShared('room-clock.js');
	// Correspondence: blue on vacation for three days; the deadline shows as
	// if taken in full, and blue is not out at the old deadline.
	const ts = { red: 0, blue: T + DAY_MS, activeColor: 'blue', lastUpdated: T };
	const corr = { timeControl: { type: 'correspondence', moveTimeout: DAY_MS },
		pauses: { p: { color: 'blue', from: T + 1000, to: T + 1000 + 3 * DAY_MS } } };
	const v = roomTimerView(ts, corr, T + 2 * DAY_MS);
	assert.deepStrictEqual([v.blue, v.out, v.paused.blue, v.paused.red], [T + 4 * DAY_MS, null, T + 1000 + 3 * DAY_MS, null]);
	assert.strictEqual(roomTimerView(ts, corr, T + 4 * DAY_MS + 2000).out, 'blue');
	assert.strictEqual(roomTimerView(ts, { timeControl: corr.timeControl }, T + DAY_MS + 1).out, 'blue');
	// Realtime: a gift to the running side keeps it in the game.
	const rt = { timeControl: { type: 'realtime', initialTime: 60_000 }, gifts: { g: { to: 'red', ms: 15_000, at: T + 5000 } } };
	const live = { red: 10_000, blue: 30_000, activeColor: 'red', lastUpdated: T };
	const w = roomTimerView(live, rt, T + 12_000);
	assert.deepStrictEqual([w.red, w.blue, w.out], [13_000, 30_000, null]);
	assert.strictEqual(roomTimerView(live, rt, T + 25_000).out, 'red');
});

test('a pause whose vacation has ended is due to end then', () => {
	const { pauseDueEnd, pauseKey } = require('../vacation');
	const v = startRecord(null, 5, T);
	const ended = endRecord(v, T + DAY_MS);
	const k = pauseKey('alice', v.from, 'red');
	const p = { color: 'red', from: T + 1000, to: v.until };
	assert.strictEqual(pauseDueEnd(k, p, { alice: v }, T + 2000), null);
	assert.strictEqual(pauseDueEnd(k, p, { alice: ended }, T + 2 * DAY_MS), T + DAY_MS);
	// Added by a sweep after the end: ends where it began.
	assert.strictEqual(pauseDueEnd(k, { color: 'red', from: T + DAY_MS + 5, to: v.until }, { alice: ended }, T + 2 * DAY_MS), T + DAY_MS + 5);
	// A later vacation keeps the last one's span; one no longer on record ends now.
	const next = startRecord(ended, 2, T + 3 * DAY_MS);
	assert.strictEqual(pauseDueEnd(k, p, { alice: next }, T + 3 * DAY_MS), T + DAY_MS);
	const later = startRecord(endRecord(next, T + 4 * DAY_MS), 1, T + 5 * DAY_MS);
	assert.strictEqual(pauseDueEnd(k, Object.assign({}, p, { to: T + 10 * DAY_MS }), { alice: later }, T + 5 * DAY_MS), T + 5 * DAY_MS);
	// A stale record (read before a newer vacation began elsewhere) never
	// ends the newer vacation's pause.
	const newer = startRecord(ended, 2, T + 3 * DAY_MS);
	const nk = pauseKey('alice', newer.from, 'red');
	assert.strictEqual(pauseDueEnd(nk, { color: 'red', from: newer.from, to: newer.until }, { alice: ended }, T + 3 * DAY_MS + 5), null);
	assert.strictEqual(pauseDueEnd(nk, { color: 'red', from: newer.from, to: newer.until }, { alice: v }, T + 3 * DAY_MS + 5), null);
	// Other players' pauses are left to their own records.
	assert.strictEqual(pauseDueEnd(k, p, { bob: ended }, T + 2 * DAY_MS), null);
});
