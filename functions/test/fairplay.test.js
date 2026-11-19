'use strict';
// node --test functions/test/fairplay.test.js
//
// The automatic suspensions (docs/static/scripts/engine/fair-play.js), as
// rateGame applies them, and the stall rule (rating.js stalled).

const test = require('node:test');
const assert = require('node:assert');
const { requireShared } = require('../engine-loader');
const { stalled } = require('../rating');
const {
	FAIR_PLAY, FAIR_PLAY_DAY_MS: DAY, fairPlayApplyOffense, fairPlayStanding, fairPlayDuration, fairPlayRecentOffenses,
} = requireShared('fair-play.js');

const NOW = 1_800_000_000_000;

test('the first offense in a month is recorded, the second suspends for a day', () => {
	const a = fairPlayApplyOffense(null, { room: 'R1', kind: 'abandon', at: NOW - 5 * DAY }, NOW - 5 * DAY);
	assert.strictEqual(a.counted, true);
	assert.strictEqual(a.restriction, null);
	assert.deepStrictEqual([a.flags.abandons, a.flags.abandonedGames, a.flags.offenses.R1.kind, a.flags.banUntil],
		[1, { R1: true }, 'abandon', undefined]);
	const ev = { satMs: 300_000, leftMs: 300_000, medianMs: 20_000, turns: 6 };
	const b = fairPlayApplyOffense(a.flags, { room: 'R2', kind: 'stall', at: NOW - 1000, evidence: ev }, NOW);
	assert.strictEqual(b.counted, true);
	assert.deepStrictEqual(b.restriction, { key: 'R2', at: NOW, until: NOW + DAY, level: 1, kind: 'stall', rooms: { R1: 'abandon', R2: 'stall' } });
	const f = b.flags;
	assert.deepStrictEqual([f.banUntil, f.auto, f.by, f.at, f.stalls, f.abandons], [NOW + DAY, true, 'auto', NOW, 1, 1]);
	assert.deepStrictEqual(f.offenses.R2, Object.assign({ kind: 'stall', at: NOW - 1000 }, ev));
	assert.match(f.reason, /^Automatic: 2 online games abandoned or stalled in 30 days \(1 left, 1 stalled\), suspension level 1\.$/);
	assert.ok(f.reason.length <= 500);
	// The input is not changed (a transaction may run the update again).
	assert.strictEqual(a.flags.banUntil, undefined);
});

test('a room counts once, including rooms counted before offenses were timed', () => {
	const a = fairPlayApplyOffense(null, { room: 'R1', kind: 'abandon', at: NOW }, NOW);
	assert.deepStrictEqual(fairPlayApplyOffense(a.flags, { room: 'R1', kind: 'abandon', at: NOW }, NOW), { counted: false });
	assert.deepStrictEqual(fairPlayApplyOffense(a.flags, { room: 'R1', kind: 'stall', at: NOW }, NOW), { counted: false });
	// abandonedGames from before this change: counted, but not timed, so
	// outside every window (no retroactive suspension).
	const legacy = { abandons: 3, abandonedGames: { OLD1: true, OLD2: true, OLD3: true } };
	assert.deepStrictEqual(fairPlayApplyOffense(legacy, { room: 'OLD2', kind: 'abandon', at: NOW }, NOW), { counted: false });
	const n = fairPlayApplyOffense(legacy, { room: 'NEW', kind: 'abandon', at: NOW }, NOW);
	assert.deepStrictEqual([n.counted, n.restriction, n.flags.abandons], [true, null, 4]);
});

test('every further offense in the window suspends again, longer each time, up to the cap', () => {
	let f = null;
	const lengths = [];
	for (let i = 0; i < 7; i++) {
		const t = NOW + i * 2 * DAY;
		const r = fairPlayApplyOffense(f, { room: 'G' + i, kind: 'abandon', at: t }, t);
		f = r.flags;
		lengths.push(r.restriction ? (r.restriction.until - t) / DAY : 0);
	}
	assert.deepStrictEqual(lengths, [0, 1, 3, 7, 30, 30, 30]);
	assert.strictEqual(f.banUntil, NOW + 12 * DAY + 30 * DAY);
	assert.strictEqual(Object.keys(f.restrictions).length, 6);
});

test('old offenses, forgiven offenses and overturned suspensions do not count', () => {
	const t0 = NOW - 40 * DAY;
	let f = fairPlayApplyOffense(null, { room: 'OLD', kind: 'abandon', at: t0 }, t0).flags;
	// Forty days later a new one is the first in the window.
	let r = fairPlayApplyOffense(f, { room: 'A', kind: 'abandon', at: NOW }, NOW);
	assert.strictEqual(r.restriction, null);
	r = fairPlayApplyOffense(r.flags, { room: 'B', kind: 'stall', at: NOW + 1 }, NOW + 1);
	assert.strictEqual(r.restriction.level, 1);
	// An admin upholds the appeal: the suspension is overturned and its games forgiven.
	f = JSON.parse(JSON.stringify(r.flags));
	f.restrictions.B.overturned = true;
	f.offenses.A.forgiven = true;
	f.offenses.B.forgiven = true;
	f.banUntil = 0;
	assert.strictEqual(fairPlayStanding(f, NOW + 2).count, 0);
	r = fairPlayApplyOffense(f, { room: 'C', kind: 'abandon', at: NOW + 2 }, NOW + 2);
	assert.strictEqual(r.restriction, null);
	r = fairPlayApplyOffense(r.flags, { room: 'D', kind: 'abandon', at: NOW + 3 }, NOW + 3);
	// Level 1 again: the overturned suspension does not raise it.
	assert.deepStrictEqual([r.restriction.level, r.restriction.rooms], [1, { C: 'abandon', D: 'abandon' }]);
	// Suspensions more than 90 days old no longer raise the level.
	const late = NOW + 100 * DAY;
	let g = fairPlayApplyOffense(r.flags, { room: 'E', kind: 'abandon', at: late }, late);
	g = fairPlayApplyOffense(g.flags, { room: 'F', kind: 'abandon', at: late + 1 }, late + 1);
	assert.strictEqual(g.restriction.level, 1);
});

test('an admin\'s longer suspension is never shortened', () => {
	const admin = { banUntil: NOW + 30 * DAY, reason: 'Engine use', by: 'root', at: NOW - DAY };
	let r = fairPlayApplyOffense(admin, { room: 'A', kind: 'abandon', at: NOW }, NOW);
	r = fairPlayApplyOffense(r.flags, { room: 'B', kind: 'abandon', at: NOW }, NOW);
	assert.ok(r.restriction);
	assert.deepStrictEqual([r.flags.banUntil, r.flags.reason, r.flags.by, r.flags.auto], [NOW + 30 * DAY, 'Engine use', 'root', undefined]);
});

test('standing: what the next offense would bring', () => {
	assert.deepStrictEqual(fairPlayStanding(null, NOW), { recent: [], count: 0, left: 1, nextLevel: 1, nextMs: DAY });
	const one = fairPlayApplyOffense(null, { room: 'A', kind: 'stall', at: NOW - DAY }, NOW - DAY).flags;
	const s = fairPlayStanding(one, NOW);
	assert.deepStrictEqual([s.count, s.left, s.nextMs, s.recent[0].room], [1, 0, DAY, 'A']);
	assert.strictEqual(fairPlayRecentOffenses(one, NOW + 31 * DAY).length, 0);
	assert.deepStrictEqual([fairPlayDuration(DAY), fairPlayDuration(3 * DAY), fairPlayDuration(2 * 3600000)], ['1 day', '3 days', '2 hours']);
	assert.strictEqual(FAIR_PLAY.THRESHOLD, 2);
});

// ---- stalling, from the turns' server timestamps ----

// A live game: `thinks` are each turn's length in ms (red first); the
// last mover's opponent is to move and loses on time at `closedAt`.
function liveRoom(thinks, initialTime) {
	const t0 = 1_700_000_000_000;
	const turns = {};
	let ts = t0;
	thinks.forEach((ms, i) => {
		ts += ms;
		turns['-k' + String(i).padStart(4, '0')] = { color: i % 2 ? 'blue' : 'red', actions: ['pass'], timestamp: ts };
	});
	return { timeControl: { type: 'realtime', initialTime, increment: 0 }, startedAt: t0, turns, last: ts };
}

test('a stall: a healthy clock run out without moving', () => {
	// Red 10 s a turn, blue 10 s a turn; blue (to move after 9 turns) sits.
	const room = liveRoom(Array(9).fill(10_000), 600_000);
	const blueLeft = 600_000 - 4 * 10_000;
	const flagAt = room.last + blueLeft + 3000;
	assert.deepStrictEqual(stalled(room, 'blue', flagAt), { satMs: blueLeft + 3000, leftMs: blueLeft, medianMs: 10_000, turns: 4 });
	// Not before the flag, and not the side that moved last.
	assert.strictEqual(stalled(room, 'blue', room.last + 60_000), null);
	assert.strictEqual(stalled(room, 'red', flagAt), null);
});

test('not a stall: time trouble, a slow player, too few turns, other clocks', () => {
	// Under two minutes left at the start of the final turn: time trouble.
	const scramble = liveRoom(Array(9).fill(10_000), 150_000);
	assert.strictEqual(stalled(scramble, 'blue', scramble.last + 110_000 + 3000), null);
	// A player who always takes 3 minutes: 4 minutes left is not 5x their pace.
	const slow = liveRoom([10_000, 180_000, 10_000, 180_000, 10_000, 180_000, 10_000, 180_000, 10_000], 960_000);
	assert.strictEqual(stalled(slow, 'blue', slow.last + 240_000 + 3000), null);
	// Two earlier turns are too few to know a pace.
	const short = liveRoom(Array(5).fill(10_000), 600_000);
	assert.strictEqual(stalled(short, 'blue', short.last + 580_000 + 3000), null);
	// Untimed, correspondence, or no start time: no clock to read.
	const base = liveRoom(Array(9).fill(10_000), 600_000);
	const flagAt = base.last + 560_000 + 3000;
	assert.strictEqual(stalled(Object.assign({}, base, { timeControl: { type: 'none' } }), 'blue', flagAt), null);
	assert.strictEqual(stalled(Object.assign({}, base, { timeControl: { type: 'correspondence', moveTimeout: 86400000 } }), 'blue', flagAt + 86400000), null);
	assert.strictEqual(stalled(Object.assign({}, base, { startedAt: undefined }), 'blue', flagAt), null);
});
