'use strict';
// node --test functions/test/matchmaking.test.js
//
// Matchmaking pools: the buckets and rating windows (engine/match-pools.js)
// and the server's pairing passes (matchmaking.js) on test/fake-db.js.

const test = require('node:test');
const assert = require('node:assert');
const M = require('../../docs/static/scripts/engine/match-pools.js');
const { matchBucket, sweep, claimPair } = require('../matchmaking');
const { fakeDb } = require('./fake-db');

const NOW = 1800000000000;
const full = (guests) => ({ isFullAccount: async (uid) => !(guests || []).includes(uid), isSuspended: async () => false });
const ticket = (bucket, ageMs, pingAgo) => ({ bucket, at: NOW - ageMs, ping: NOW - (pingAgo || 0) });
const BLITZ = 'rt-300-0~standard~r';

test('buckets name the exact game, and only Standard and Competitive', () => {
	const rt = { type: 'realtime', initialTime: 300000, increment: 3000 };
	assert.strictEqual(M.bucketOf({ timeControl: rt, variant: 'standard', rated: true }), 'rt-300-3~standard~r');
	assert.strictEqual(M.bucketOf({ timeControl: { type: 'correspondence', moveTimeout: 86400000 }, variant: 'competitive', rated: false }), 'cr-24~competitive~c');
	assert.strictEqual(M.bucketOf({ timeControl: { type: 'none' }, variant: 'standard', rated: true }), 'none~standard~r');
	assert.strictEqual(M.bucketOf({ timeControl: { type: 'none' }, variant: 'competitive_deathmatch', rated: false }), null);
	assert.strictEqual(M.bucketOf({ timeControl: { type: 'realtime', initialTime: 30500, increment: 0 }, variant: 'standard' }), null);
	for (const b of ['rt-300-3~standard~r', 'cr-72~competitive~c', 'none~standard~r', 'rt-30-0~standard~c']) {
		assert.strictEqual(M.bucketOf(M.parseBucket(b)), b);
	}
	assert.deepStrictEqual(M.parseBucket('rt-120-1~standard~c'),
		{ timeControl: { type: 'realtime', initialTime: 120000, increment: 1000 }, variant: 'standard', rated: false });
	assert.strictEqual(M.parseBucket('rt-120-1~deathmatch~c'), null);
	assert.strictEqual(M.parseBucket('../x'), null);
});

test('the rating window starts at 100 plus the deviation and widens while waiting', () => {
	assert.strictEqual(M.windowFor(60, 0), 160);
	assert.strictEqual(M.windowFor(60, 30000), 310);
	assert.strictEqual(M.windowFor(350, 0), 450);
	assert.strictEqual(M.windowFor(60, M.C.ANY_AFTER_MS), Infinity);
});

test('pairing: both windows must hold the gap, closest rating first, oldest ticket hosts', () => {
	const t = (uid, r, rd, waited, blocks) => ({ uid, r, rd, at: NOW - waited, blocks });
	// 300 apart, both fresh with a deviation of 60: not yet.
	assert.deepStrictEqual(M.pairTickets([t('a', 1500, 60, 0), t('b', 1800, 60, 0)], NOW), []);
	// The older has widened, but the newer's window still holds: no.
	assert.deepStrictEqual(M.pairTickets([t('a', 1500, 60, 120000), t('b', 1800, 60, 0)], NOW), []);
	// Both have waited 30 s (window 310): paired, the older hosting.
	const p = M.pairTickets([t('b', 1800, 60, 30000), t('a', 1500, 60, 31000)], NOW);
	assert.deepStrictEqual(p.map(([h, g]) => [h.uid, g.uid]), [['a', 'b']]);
	// The closest rating is taken, not the first in line.
	const q = M.pairTickets([t('a', 1500, 60, 50000), t('far', 1650, 60, 40000), t('near', 1520, 60, 10000)], NOW);
	assert.deepStrictEqual(q.map(([h, g]) => [h.uid, g.uid]), [['a', 'near']]);
	// A block either way keeps two apart.
	assert.deepStrictEqual(M.pairTickets([t('a', 1500, 60, 0, ['b']), t('b', 1500, 60, 0)], NOW), []);
	assert.deepStrictEqual(M.pairTickets([t('a', 1500, 60, 0), t('b', 1500, 60, 0, ['a'])], NOW), []);
	// Four players: two pairs, nobody twice.
	const r = M.pairTickets([t('a', 1500, 60, 4), t('b', 1510, 60, 3), t('c', 1900, 60, 2), t('d', 1890, 60, 1)], NOW);
	assert.deepStrictEqual(r.map(([h, g]) => h.uid + g.uid), ['ab', 'cd']);
	// After three minutes any rating will do.
	assert.strictEqual(M.pairTickets([t('a', 1000, 45, M.C.ANY_AFTER_MS), t('b', 2400, 45, M.C.ANY_AFTER_MS)], NOW).length, 1);
});

test('a pairing pass claims both tickets and writes the match', async () => {
	const db = fakeDb({
		users: { alice: { displayName: 'Alice', elo: 1500, gamesPlayed: 20 }, bob: { displayName: 'Bob', elo: 1450, gamesPlayed: 3 },
			carol: { displayName: 'Carol', elo: 2400, gamesPlayed: 30 } },
		ratings: { carol: { blitz: { r: 2400, rd: 50, vol: 0.06, n: 30, w: 20, l: 10, at: NOW } } },
		mm_tickets: { alice: ticket(BLITZ, 20000), bob: ticket(BLITZ, 5000), carol: ticket(BLITZ, 1000),
			dave: ticket('rt-180-2~standard~r', 1000) },
	});
	const res = await matchBucket(db, BLITZ, NOW, full());
	assert.strictEqual(res.paired.length, 1);
	assert.strictEqual(res.waiting, 1);
	const d = db.dump();
	const id = res.paired[0];
	assert.strictEqual(d.mm_tickets.alice.match, id);
	assert.strictEqual(d.mm_tickets.bob.match, id);
	assert.strictEqual(d.mm_tickets.carol.match, undefined);
	assert.strictEqual(d.mm_tickets.dave.match, undefined);
	const m = d.mm_matches[id];
	assert.deepStrictEqual([m.host, m.guest, m.hostName, m.guestName, m.hostRating, m.guestRating, m.hostRd, m.bucket, m.at],
		['alice', 'bob', 'Alice', 'Bob', 1500, 1450, 250, BLITZ, NOW]);
	assert.deepStrictEqual([m.tc, m.variant, m.rated], [{ type: 'realtime', initialTime: 300000, increment: 0 }, 'standard', true]);
	assert.strictEqual(d.mm_counts[BLITZ], 1);
	// Carol is alone in range: a later pass leaves her waiting.
	const again = await matchBucket(db, BLITZ, NOW + 1000, full());
	assert.deepStrictEqual(again.paired, []);
});

test('guests pair in casual buckets; rated buckets refuse guests and suspended players', async () => {
	const CAS = 'none~standard~c';
	const db = fakeDb({ mm_tickets: { g1: ticket(CAS, 3000), g2: ticket(CAS, 1000), g3: ticket(BLITZ, 1000), s1: ticket(BLITZ, 500) },
		users: { s1: { displayName: 'S', elo: 1200, gamesPlayed: 5 } } });
	const deps = { isFullAccount: async (u) => u === 's1', isSuspended: async (u) => u === 's1' };
	const res = await matchBucket(db, CAS, NOW, deps);
	assert.strictEqual(res.paired.length, 1);
	const m = db.dump().mm_matches[res.paired[0]];
	assert.deepStrictEqual([m.host, m.guest, m.hostName, m.hostRating, m.hostRd], ['g1', 'g2', 'Guest', 1000, 350]);
	await matchBucket(db, BLITZ, NOW, deps);
	assert.strictEqual(db.dump().mm_tickets.g3.error, 'sign-in');
	assert.strictEqual(db.dump().mm_tickets.s1.error, 'suspended');
});

test('stale tickets are dropped, and a ticket withdrawn mid-claim lets the other go', async () => {
	const db = fakeDb({ mm_tickets: { old: ticket(BLITZ, 600000, M.C.STALE_MS + 1), a: ticket(BLITZ, 2000), b: ticket(BLITZ, 1000) },
		users: { a: { elo: 1500 }, b: { elo: 1500 } } });
	const res = await matchBucket(db, BLITZ, NOW, full());
	assert.strictEqual(db.dump().mm_tickets.old, undefined);
	assert.strictEqual(res.paired.length, 1);

	// claimPair with the guest gone: no match, the host is waiting again.
	const db2 = fakeDb({ mm_tickets: { a: ticket(BLITZ, 2000) } });
	const id = await claimPair(db2, BLITZ, { uid: 'a', at: NOW - 2000, r: 1500, rd: 60, name: 'A' },
		{ uid: 'b', at: NOW - 1000, r: 1500, rd: 60, name: 'B' }, NOW);
	assert.strictEqual(id, null);
	assert.deepStrictEqual(db2.dump().mm_tickets.a, ticket(BLITZ, 2000));
	assert.strictEqual(db2.dump().mm_matches, undefined);
	// A ticket re-made since it was read (a new `at`) is not claimed either.
	const db3 = fakeDb({ mm_tickets: { a: ticket(BLITZ, 2000), b: ticket(BLITZ, 10) } });
	assert.strictEqual(await claimPair(db3, BLITZ, { uid: 'a', at: NOW - 2000, r: 1, rd: 1 }, { uid: 'b', at: NOW - 1000, r: 1, rd: 1 }, NOW), null);
	assert.strictEqual(db3.dump().mm_tickets.a.match, undefined);
});

test('the sweep drops old matches and stale tickets and pairs every bucket', async () => {
	const CORR = 'cr-24~standard~r';
	const db = fakeDb({
		mm_tickets: {
			x: Object.assign(ticket(BLITZ, 300000), { match: 'mOld' }),
			y: Object.assign(ticket(BLITZ, 300000), { match: 'mOld' }),
			p: ticket(CORR, 50000), q: ticket(CORR, 40000),
			stale: ticket(CORR, 900000, M.C.STALE_MS + 5),
		},
		mm_matches: { mOld: { host: 'x', guest: 'y', at: NOW - M.C.MATCH_TTL_MS - 1, bucket: BLITZ } },
		mm_counts: { [BLITZ]: 2 },
		users: { p: { elo: 1300 }, q: { elo: 1320 } },
	});
	const res = await sweep(db, NOW, full());
	const d = db.dump();
	assert.strictEqual(res.paired, 1);
	assert.strictEqual(res.dropped, 1);
	assert.strictEqual(d.mm_tickets.x, undefined);
	assert.strictEqual(d.mm_tickets.y, undefined);
	assert.strictEqual(d.mm_tickets.stale, undefined);
	assert.ok(d.mm_tickets.p.match && d.mm_tickets.p.match === d.mm_tickets.q.match);
	assert.strictEqual(d.mm_counts, undefined);
});
