'use strict';
// tournaments.js: the pure parts (scoring, pairing, standings, settings):
//   cd functions && node --test test/tournaments.test.js

const test = require('node:test');
const assert = require('node:assert');
const T = require('../tournaments');

const NOW = 1_800_000_000_000;

test('arena points: 2 a win, 4 on a streak after two wins, +1 for a berserk win, 0 a loss', () => {
	let streak = 0;
	const sheet = [];
	for (const [won, bz] of [[true, false], [true, true], [true, false], [true, true], [false, true], [true, false]]) {
		const r = T.arenaPoints(streak, won, bz && won);
		sheet.push(r.points);
		streak = r.streak;
	}
	assert.deepStrictEqual(sheet, [2, 3, 4, 5, 0, 2]);
	assert.strictEqual(streak, 1);
});

test('performance is the opponents\' average plus 400 per net win per game', () => {
	assert.strictEqual(T.performance({ games: 0 }), null);
	assert.strictEqual(T.performance({ games: 4, wins: 3, losses: 1, oppRatingSum: 4000 }), 1200);
});

test('arena pairing: neighbours in the standings, never the last opponent at once', () => {
	const P = (uid, score, extra) => Object.assign({ uid, score, rating: 1000, waitingSince: NOW }, extra);
	const pairs = T.pairArena([P('a', 6), P('b', 4), P('c', 2), P('d', 0)], NOW, () => 0.1);
	const ids = pairs.map(([r, b]) => [r.uid, b.uid].sort().join(''));
	assert.deepStrictEqual(ids.sort(), ['ab', 'cd']);
	// a and b just played: a meets c, b meets d.
	const p2 = T.pairArena([P('a', 6, { lastOpp: 'b' }), P('b', 4, { lastOpp: 'a' }), P('c', 2), P('d', 0)], NOW, () => 0.1);
	assert.deepStrictEqual(p2.map(([r, b]) => [r.uid, b.uid].sort().join('')).sort(), ['ac', 'bd']);
	// Only the two of them free: again, once both have waited.
	const fresh = [P('a', 6, { lastOpp: 'b' }), P('b', 4, { lastOpp: 'a' })];
	assert.strictEqual(T.pairArena(fresh, NOW, () => 0.1).length, 0);
	assert.strictEqual(T.pairArena(fresh, NOW + T.REMATCH_WAIT_MS, () => 0.1).length, 1);
	// An odd player out waits.
	assert.strictEqual(T.pairArena([P('a', 0), P('b', 0), P('c', 0)], NOW).length, 1);
});

test('colours go to who has had the other colour more, then who had it last', () => {
	const [r1] = T.assignColors({ uid: 'a', colors: 'rr' }, { uid: 'b', colors: 'rb' });
	assert.strictEqual(r1.uid, 'b');
	const [r2] = T.assignColors({ uid: 'a', colors: 'rb' }, { uid: 'b', colors: 'br' });
	assert.strictEqual(r2.uid, 'a');
	const [r3] = T.assignColors({ uid: 'a', colors: '' }, { uid: 'b', colors: '' }, () => 0.9);
	assert.strictEqual(r3.uid, 'b');
});

/** Play a Swiss of `n` players over `rounds`, the higher rating winning, through swissPair. */
function simulateSwiss(n, rounds) {
	const players = Array.from({ length: n }, (_, i) => ({ uid: 'p' + i, rating: 1500 - i * 10, score: 0, opps: [], colors: '', byes: 0 }));
	const byUid = Object.fromEntries(players.map((p) => [p.uid, p]));
	const pairings = [];
	for (let r = 1; r <= rounds; r++) {
		const { pairs, bye } = T.swissPair(players.map((p) => Object.assign({}, p, { opps: p.opps.slice() })), () => 0.5);
		const seen = new Set();
		for (const [red, blue] of pairs) {
			for (const u of [red.uid, blue.uid]) { assert.ok(!seen.has(u), 'paired twice in a round'); seen.add(u); }
			const winner = byUid[red.uid].rating > byUid[blue.uid].rating ? 'red' : 'blue';
			const w = winner === 'red' ? red.uid : blue.uid;
			byUid[w].score++;
			byUid[red.uid].opps.push(blue.uid);
			byUid[blue.uid].opps.push(red.uid);
			byUid[red.uid].colors += 'r';
			byUid[blue.uid].colors += 'b';
			pairings.push({ round: r, red: red.uid, blue: blue.uid, winner, status: 'done' });
		}
		if (bye) {
			assert.ok(!seen.has(bye.uid));
			seen.add(bye.uid);
			byUid[bye.uid].score++;
			byUid[bye.uid].byes++;
			pairings.push({ round: r, red: bye.uid, blue: null, bye: true, status: 'done', winner: 'red' });
		}
		assert.strictEqual(seen.size, n, 'everyone plays or has the bye');
	}
	return { players, pairings };
}

test('Swiss: no repeat opponents, one bye each at most, no colour three times running', () => {
	for (const [n, rounds] of [[4, 3], [5, 3], [6, 5], [7, 5], [8, 3], [9, 4], [12, 5], [33, 7]]) {
		const { players, pairings } = simulateSwiss(n, rounds);
		const met = new Set();
		for (const g of pairings) {
			if (g.bye) continue;
			const key = [g.red, g.blue].sort().join('-');
			assert.ok(!met.has(key), `n=${n}: ${key} met twice`);
			met.add(key);
		}
		for (const p of players) {
			assert.ok(p.byes <= 1, `n=${n}: ${p.uid} had ${p.byes} byes`);
			const reds = [...p.colors].filter((c) => c === 'r').length;
			assert.ok(Math.abs(2 * reds - p.colors.length) <= 2, `n=${n}: ${p.uid} colours ${p.colors}`);
			assert.ok(!/rrr|bbb/.test(p.colors), `n=${n}: ${p.uid} colours ${p.colors}`);
		}
	}
});

test('Swiss: round one pairs the top half against the bottom half', () => {
	const players = ['a', 'b', 'c', 'd', 'e', 'f'].map((uid, i) => ({ uid, rating: 2000 - i * 100, score: 0, opps: [], colors: '' }));
	const { pairs, bye } = T.swissPair(players, () => 0.5);
	assert.strictEqual(bye, null);
	assert.deepStrictEqual(pairs.map(([r, b]) => [r.uid, b.uid].sort().join('')).sort(), ['ad', 'be', 'cf']);
});

test('Swiss: two players meet again rather than not play', () => {
	const players = [{ uid: 'a', score: 1, opps: ['b'], colors: 'r' }, { uid: 'b', score: 0, opps: ['a'], colors: 'b' }];
	const { pairs } = T.swissPair(players);
	assert.strictEqual(pairs.length, 1);
	assert.deepStrictEqual([pairs[0][0].uid, pairs[0][1].uid], ['b', 'a']);
});

test('Swiss standings: points, then Buchholz, then Sonneborn-Berger', () => {
	const players = [{ uid: 'a', score: 2 }, { uid: 'b', score: 2 }, { uid: 'c', score: 1 }, { uid: 'd', score: 1 }];
	const pairings = [
		{ red: 'a', blue: 'c', winner: 'red', status: 'done' },
		{ red: 'b', blue: 'd', winner: 'red', status: 'done' },
		{ red: 'a', blue: 'b', winner: 'blue', status: 'done' },
		{ red: 'c', blue: 'd', winner: 'red', status: 'done' },
		{ red: 'a', blue: null, bye: true, winner: 'red', status: 'done' },
	];
	// a: 1 (c) + 2 (b) = 3; b: 1 (d) + 2 (a) = 3; SB: a beat c (1), b beat d and a (1 + 2 = 3).
	// c: 2 (a) + 1 (d) = 3 and beat d (1); d: 2 (b) + 1 (c) = 3, beat no one.
	const rows = T.swissStandings(players, pairings);
	assert.deepStrictEqual(rows.map((r) => [r.uid, r.buchholz, r.sb, r.rank]), [['b', 3, 3, 1], ['a', 3, 1, 2], ['c', 3, 1, 3], ['d', 3, 0, 4]]);
});

test('settings: players make casual events within limits; admins rated, official, repeating ones', () => {
	const ok = T.validateCreate({ kind: 'arena', name: '  Friday   blitz ', minutes: 3, increment: 2, durationMin: 45, startsAt: NOW + 3600e3, rated: true, official: true, repeat: 'daily' }, false, NOW);
	assert.deepStrictEqual([ok.name, ok.rated, ok.official, ok.repeat, ok.berserk, ok.endsAt - ok.startsAt], ['Friday blitz', false, false, null, true, 45 * 60e3]);
	assert.deepStrictEqual(ok.timeControl, { type: 'realtime', initialTime: 180000, increment: 2000 });
	const adm = T.validateCreate({ kind: 'swiss', name: 'Weekly Swiss', minutes: 10, rounds: 5, startsAt: NOW, rated: true, official: true, repeat: 'weekly' }, true, NOW);
	assert.deepStrictEqual([adm.rated, adm.official, adm.repeat, adm.rounds, adm.roundGapMs], [true, true, 'weekly', 5, 30000]);
	const simul = T.validateCreate({ kind: 'simul', name: 'Simul', minutes: 10, hostExtraSec: 30, hostColor: 'alternate', rated: true }, true, NOW);
	assert.deepStrictEqual([simul.rated, simul.hostExtraMs, simul.hostColor, simul.maxPlayers], [false, 30000, 'alternate', 10]);
	const bad = (input, admin, field) => assert.throws(() => T.validateCreate(input, admin, NOW), (e) => e.code === 'invalid-argument' && e.message === 'invalid-' + field);
	bad({ kind: 'ladder', name: 'x' }, false, 'kind');
	bad({ kind: 'arena', name: 'ab', minutes: 3, durationMin: 30, startsAt: NOW }, false, 'name');
	bad({ kind: 'arena', name: 'Arena', minutes: 3, durationMin: 500, startsAt: NOW }, false, 'durationMin');
	bad({ kind: 'arena', name: 'Arena', minutes: 0, durationMin: 30, startsAt: NOW }, false, 'minutes');
	bad({ kind: 'arena', name: 'Arena', minutes: 3, durationMin: 30, startsAt: NOW + 30 * 86400e3 }, false, 'startsAt');
	bad({ kind: 'swiss', name: 'Swiss', minutes: 3, rounds: 20, startsAt: NOW }, true, 'rounds');
	bad({ kind: 'swiss', name: 'Swiss', minutes: 3, rounds: 3, startsAt: NOW, maxPlayers: 500 }, false, 'maxPlayers');
	bad({ kind: 'simul', name: 'Simul', minutes: 3, maxPlayers: 30 }, false, 'maxPlayers');
	// One Core sub-pack has one spell of each size: not enough for a board.
	bad({ kind: 'arena', name: 'Arena', minutes: 3, durationMin: 30, startsAt: NOW, packs: ['core_growth'] }, false, 'packs');
});

test('the first-move window: at most half a short clock', () => {
	const t = (kind, minutes) => ({ kind, timeControl: minutes ? { type: 'realtime', initialTime: minutes * 60000 } : { type: 'none' } });
	assert.deepStrictEqual([T.noShowMs(t('arena', 1)), T.noShowMs(t('arena', 3)), T.noShowMs(t('swiss', 1)), T.noShowMs(t('swiss', 10)),
		T.noShowMs(t('simul', 1)), T.noShowMs(t('simul', 0))], [30000, 45000, 30000, 90000, 30000, 300000]);
});
