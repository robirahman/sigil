'use strict';
// node --test functions/test/social.test.js
//
// Badges and the activity feed (social.js, and the shared catalog
// docs/static/scripts/engine/badges.js), on the in-memory database.

const test = require('node:test');
const assert = require('node:assert');
const { fakeDb } = require('./fake-db');
const social = require('../social');
const B = require('../engine-loader').requireShared('badges.js');

const t0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const DAY = 86_400_000;

function players(extra) {
	return Object.assign({
		users: {
			alice: { displayName: 'Alice', elo: 1000, gamesPlayed: 0, wins: 0, losses: 0 },
			bob: { displayName: 'Bob', elo: 1000, gamesPlayed: 0, wins: 0, losses: 0 },
		},
	}, extra);
}

function ratedEntry(i, result, before, after, extra) {
	return Object.assign({
		timestamp: t0 + i * 1000, roomCode: 'ROOM' + i, gameId: 'g' + i, opponent: 'Bob', opponentUid: 'bob',
		opponentIsAI: false, color: 'red', result, fromPosition: false, rated: true,
		eloBefore: before, eloAfter: after, eloChange: after - before, opponentEloBefore: 1000,
	}, extra);
}

/** Write a user_games entry the way rateGame does (with the counters), then run the trigger. */
async function play(db, uid, i, entry, now) {
	const u = (await db.ref('users/' + uid).once('value')).val();
	const upd = { ['user_games/' + uid + '/g' + i]: entry };
	if (entry.rated) {
		upd['users/' + uid + '/gamesPlayed'] = (u.gamesPlayed || 0) + 1;
		upd['users/' + uid + '/' + (entry.result === 'win' ? 'wins' : 'losses')] = (u[entry.result === 'win' ? 'wins' : 'losses'] || 0) + 1;
		upd['users/' + uid + '/elo'] = entry.eloAfter;
	}
	await db.ref().update(upd);
	return social.onUserGame(db, uid, 'g' + i, entry, now || t0 + i * 1000 + 5000);
}

test('the badge catalog: every rule awards a badge that exists', () => {
	const ids = new Set(B.SIGIL_BADGES.map((b) => b.id));
	assert.strictEqual(ids.size, B.SIGIL_BADGES.length, 'unique ids');
	const all = B.sigilGameBadges({ result: 'win', rated: true, eloBefore: 1000, eloAfter: 2500, opponentEloBefore: 1300, opponentIsAI: false },
		{ gamesPlayed: 1000, winStreak: 50 });
	for (const id of all.concat(B.sigilPuzzleStreakBadges(1000))) assert.ok(ids.has(id), id);
	assert.ok(ids.has('tournament-win'));
	for (const b of B.SIGIL_BADGES) assert.ok(b.name && b.desc && b.mark && b.group, b.id);
});

test('a first win: the feed entry and the First Win badge, once', async () => {
	const db = fakeDb(players());
	const res = await play(db, 'alice', 1, ratedEntry(1, 'win', 1000, 1016));
	assert.deepStrictEqual(res.posted, ['w_g1', 'b_first-win']);
	assert.deepStrictEqual(res.badges, ['first-win']);
	const d = db.dump();
	assert.deepStrictEqual(d.activity.alice.w_g1, { t: 'win', at: t0 + 6000, game: 'ROOM1', opp: 'bob', oppName: 'Bob', oppAI: false, rated: true, change: 16, elo: 1016 });
	assert.strictEqual(d.badges.alice['first-win'].at, t0 + 6000);
	// A retried event changes nothing (fixed keys, the badge exists).
	const again = await social.onUserGame(db, 'alice', 'g1', d.user_games.alice.g1, t0 + 9000);
	assert.deepStrictEqual(again.badges, []);
	assert.strictEqual(db.dump().badges.alice['first-win'].at, t0 + 6000);
	assert.strictEqual(Object.keys(db.dump().activity.alice).length, 2);
	// A loss posts nothing.
	const loss = await play(db, 'alice', 2, ratedEntry(2, 'loss', 1016, 1000));
	assert.deepStrictEqual(loss, { posted: [], badges: [] });
});

test('the feed time is the server\'s, not the game record\'s', async () => {
	const db = fakeDb(players());
	// An AI game's record carries the client's timestamp: a far-future one
	// must not pin the entry to the top of anyone's feed.
	await play(db, 'alice', 1, ratedEntry(1, 'win', 1000, 1010, { timestamp: t0 + 365 * DAY, opponentIsAI: true }), t0);
	assert.strictEqual(db.dump().activity.alice.w_g1.at, t0);
});

test('win streaks, game counts and a giant killer win earn their badges', async () => {
	const db = fakeDb(players());
	let elo = 1000;
	for (let i = 1; i <= 5; i++) { await play(db, 'alice', i, ratedEntry(i, 'win', elo, elo + 10)); elo += 10; }
	let b = db.dump().badges.alice;
	assert.ok(b['streak-5'] && !b['streak-10'], 'five in a row');
	assert.ok(db.dump().activity.alice['b_streak-5'], 'posted when it happens');
	await play(db, 'alice', 6, ratedEntry(6, 'loss', elo, elo - 10)); elo -= 10;
	for (let i = 7; i <= 10; i++) { await play(db, 'alice', i, ratedEntry(i, 'win', elo, elo + 10)); elo += 10; }
	b = db.dump().badges.alice;
	assert.ok(b['games-10'], 'ten rated games');
	assert.ok(!b['streak-10'], 'the loss broke the streak');
	assert.ok(!b['giant-killer']);
	await play(db, 'alice', 11, ratedEntry(11, 'win', elo, elo + 25, { opponentEloBefore: elo + 200 }));
	assert.strictEqual(db.dump().badges.alice['giant-killer'].game, 'ROOM11');
	// Not against the AI, and not in an unrated game.
	const db2 = fakeDb(players());
	await play(db2, 'alice', 1, ratedEntry(1, 'win', 1000, 1030, { opponentEloBefore: 1400, opponentIsAI: true }));
	await play(db2, 'alice', 2, Object.assign(ratedEntry(2, 'win', 1030, 1030, { opponentEloBefore: 1400 }), { rated: false }));
	assert.ok(!db2.dump().badges.alice['giant-killer']);
});

test('unrated games: the win is posted, the counts and streaks ignore them', async () => {
	const db = fakeDb(players());
	const e = { timestamp: t0, roomCode: 'R1', gameId: 'g1', opponent: 'Guest', opponentUid: 'guest1', opponentIsAI: false,
		color: 'blue', result: 'win', fromPosition: false, rated: false, unratedReason: 'guest' };
	const res = await play(db, 'alice', 1, e);
	assert.deepStrictEqual(res.badges, ['first-win']);
	const w = db.dump().activity.alice.w_g1;
	assert.strictEqual(w.rated, false);
	assert.ok(!('change' in w) && !('elo' in w));
	assert.ok(!db.dump().achievements, 'no peak from an unrated game');
});

test('rating milestones are posted once, the first time a player gets there', async () => {
	const db = fakeDb(players());
	// The first game after the feature ships starts from the rating before it.
	await play(db, 'alice', 1, ratedEntry(1, 'win', 1390, 1410));
	let a = db.dump().activity.alice;
	assert.ok(a.r_1400 && a.r_1400.elo === 1400);
	assert.ok(!a.r_1300 && !a.r_1200 && !a.r_1100, 'no catch-up milestones');
	assert.ok(db.dump().badges.alice['rating-1400'] && db.dump().badges.alice['rating-1200'], 'badges catch up');
	assert.ok(!a['b_rating-1400'], 'rating badges are not posted (the milestone is)');
	await play(db, 'alice', 2, ratedEntry(2, 'loss', 1410, 1390));
	await play(db, 'alice', 3, ratedEntry(3, 'win', 1390, 1405));
	a = db.dump().activity.alice;
	assert.strictEqual(a.r_1400.at, t0 + 6000, 'not again');
	assert.deepStrictEqual(Object.keys(db.dump().achievements.alice.milestones), ['r1400']);
	await play(db, 'alice', 4, ratedEntry(4, 'win', 1405, 1620));
	a = db.dump().activity.alice;
	assert.ok(a.r_1500 && a.r_1600 && !a.r_1700);
	assert.deepStrictEqual(B.sigilRatingMilestones(1000, 1099), []);
	assert.deepStrictEqual(B.sigilRatingMilestones(1050, 1120), [1100]);
	assert.deepStrictEqual(B.sigilRatingMilestones(1500, 1500), []);
});

test('rating milestones survive games handled out of order', async () => {
	// Two games end together and the later one's trigger runs first.
	const db = fakeDb(players());
	await play(db, 'alice', 2, ratedEntry(2, 'win', 1105, 1115));
	await play(db, 'alice', 1, ratedEntry(1, 'win', 1090, 1105));
	const a = db.dump().activity.alice;
	assert.ok(a.r_1100 && a.r_1100.elo === 1100, 'the earlier game still posts 1100');
	assert.ok(!a.r_1200);
	// And the activity log being pruned does not let one post again.
	await db.ref('activity/alice/r_1100').remove();
	await play(db, 'alice', 3, ratedEntry(3, 'loss', 1115, 1095));
	await play(db, 'alice', 4, ratedEntry(4, 'win', 1095, 1110));
	assert.ok(!db.dump().activity.alice.r_1100);
});

test('a veteran\'s first game after the feature catches up badges without flooding the feed', async () => {
	const db = fakeDb(players({ users: { alice: { displayName: 'Alice', elo: 1650, gamesPlayed: 140, wins: 80, losses: 60 } } }));
	const res = await play(db, 'alice', 1, ratedEntry(1, 'win', 1650, 1660));
	assert.deepStrictEqual(res.badges.sort(), ['first-win', 'games-10', 'games-100', 'rating-1200', 'rating-1400', 'rating-1600'].sort());
	assert.deepStrictEqual(res.posted, ['w_g1'], 'only the win itself');
});

test('guests, AIs and deleted accounts get nothing', async () => {
	const db = fakeDb(players({ deleted_users: { bob: 1 } }));
	assert.deepStrictEqual(await social.onUserGame(db, 'guest9', 'g1', ratedEntry(1, 'win', 1000, 1010), t0), { skipped: 'no-profile' });
	assert.deepStrictEqual(await social.onUserGame(db, '__ai_rust_hard__', 'g1', ratedEntry(1, 'win', 1000, 1010), t0), { skipped: 'not-a-player' });
	assert.deepStrictEqual(await social.onUserGame(db, 'bob', 'g1', ratedEntry(1, 'win', 1000, 1010), t0), { skipped: 'deleted' });
	assert.ok(!db.dump().activity && !db.dump().badges);
});

test('the activity log keeps the newest entries', async () => {
	const acts = {};
	for (let i = 0; i < social.ACTIVITY_KEEP + 25; i++) acts['w_g' + i] = { t: 'win', at: t0 + i };
	const db = fakeDb(players({ activity: { alice: acts } }));
	await social.recordActivity(db, 'alice', 'r_1100', { t: 'rating', at: t0 + 10_000, elo: 1100 });
	const left = db.dump().activity.alice;
	assert.strictEqual(Object.keys(left).length, social.ACTIVITY_KEEP);
	assert.ok(left.r_1100 && !left.w_g0 && left['w_g' + (social.ACTIVITY_KEEP + 24)]);
});

test('daily puzzle streaks count the server\'s days only', async () => {
	const db = fakeDb(players());
	const today = B.sigilUtcDay(t0, 0);
	// A synced log of old solves builds nothing.
	assert.deepStrictEqual(await social.onPuzzleDaily(db, 'alice', B.sigilUtcDay(t0, -5), 'solved', t0), { skipped: 'no-change' });
	assert.deepStrictEqual(await social.onPuzzleDaily(db, 'alice', today, 'failed', t0), { skipped: 'not-a-solve' });
	assert.deepStrictEqual(await social.onPuzzleDaily(db, 'alice', '2026-1-1', 'solved', t0), { skipped: 'not-a-solve' });
	// Six days in a row, then the seventh: badge and feed entry.
	for (let d = 0; d < 6; d++) {
		const res = await social.onPuzzleDaily(db, 'alice', B.sigilUtcDay(t0 + d * DAY, 0), 'solved', t0 + d * DAY + 60_000);
		assert.strictEqual(res.streak, d + 1);
	}
	// The same day again: no change.
	assert.deepStrictEqual(await social.onPuzzleDaily(db, 'alice', B.sigilUtcDay(t0 + 5 * DAY, 0), 'solved', t0 + 5 * DAY + 90_000), { skipped: 'no-change' });
	// Yesterday's puzzle solved just after midnight still counts.
	const day7 = B.sigilUtcDay(t0 + 6 * DAY, 0);
	const res = await social.onPuzzleDaily(db, 'alice', day7, 'solved', Date.parse(B.sigilUtcDay(t0 + 7 * DAY, 0) + 'T00:05:00Z'));
	assert.strictEqual(res.streak, 7);
	assert.deepStrictEqual(res.badges, ['puzzle-streak-7']);
	const st = db.dump().achievements.alice.puzzleStreak;
	assert.deepStrictEqual({ day: st.day, n: st.n, best: st.best }, { day: day7, n: 7, best: 7 });
	assert.ok(res.posted[0] === 'p_7_' + B.sigilUtcDay(t0, 0), 'keyed by the run\'s first day');
	// A missed day starts again from one, keeping the best.
	const later = t0 + 9 * DAY;
	const r2 = await social.onPuzzleDaily(db, 'alice', B.sigilUtcDay(later, 0), 'solved', later);
	assert.strictEqual(r2.streak, 1);
	assert.strictEqual(db.dump().achievements.alice.puzzleStreak.best, 7);
	assert.strictEqual(today, B.sigilUtcDay(t0, 0));
});

test('daily puzzle streaks: yesterday\'s solve handled after today\'s still counts', async () => {
	// Five days solved, then a browser comes back online after midnight and
	// syncs yesterday's and today's solves; today's trigger runs first.
	const db = fakeDb(players());
	for (let d = 0; d < 5; d++) await social.onPuzzleDaily(db, 'alice', B.sigilUtcDay(t0 + d * DAY, 0), 'solved', t0 + d * DAY);
	const now = t0 + 6 * DAY;
	const today = B.sigilUtcDay(now, 0);
	const yesterday = B.sigilUtcDay(now, -1);
	const r1 = await social.onPuzzleDaily(db, 'alice', today, 'solved', now);
	assert.strictEqual(r1.streak, 1, 'a gap, for now');
	const r2 = await social.onPuzzleDaily(db, 'alice', yesterday, 'solved', now + 1000);
	assert.strictEqual(r2.streak, 7, 'yesterday bridges the two runs');
	assert.deepStrictEqual(r2.badges, ['puzzle-streak-7']);
	assert.deepStrictEqual(r2.posted, ['p_7_' + B.sigilUtcDay(t0, 0)]);
	const st = db.dump().achievements.alice.puzzleStreak;
	assert.deepStrictEqual({ day: st.day, n: st.n, best: st.best }, { day: today, n: 7, best: 7 });
	// Both orders give the same record.
	const db2 = fakeDb(players());
	for (let d = 0; d < 5; d++) await social.onPuzzleDaily(db2, 'alice', B.sigilUtcDay(t0 + d * DAY, 0), 'solved', t0 + d * DAY);
	await social.onPuzzleDaily(db2, 'alice', yesterday, 'solved', now);
	await social.onPuzzleDaily(db2, 'alice', today, 'solved', now + 1000);
	assert.deepStrictEqual(db2.dump().achievements.alice.puzzleStreak, st);
	// A bridge that jumps past a milestone posts it (6 + 1 + 1 = 8 passes 7).
	const db3 = fakeDb(players());
	for (let d = 0; d < 6; d++) await social.onPuzzleDaily(db3, 'alice', B.sigilUtcDay(t0 + d * DAY, 0), 'solved', t0 + d * DAY);
	const n3 = t0 + 7 * DAY;
	await social.onPuzzleDaily(db3, 'alice', B.sigilUtcDay(n3, 0), 'solved', n3);
	const r3 = await social.onPuzzleDaily(db3, 'alice', B.sigilUtcDay(n3, -1), 'solved', n3);
	assert.strictEqual(r3.streak, 8);
	assert.deepStrictEqual(r3.posted, ['p_7_' + B.sigilUtcDay(t0, 0)]);
	// Old runs are dropped from the record; the best stays.
	const later = t0 + 20 * DAY;
	await social.onPuzzleDaily(db3, 'alice', B.sigilUtcDay(later, 0), 'solved', later);
	const st3 = db3.dump().achievements.alice.puzzleStreak;
	assert.deepStrictEqual(Object.keys(st3.runs), [B.sigilUtcDay(later, 0)]);
	assert.strictEqual(st3.best, 8);
	assert.strictEqual(st3.n, 1);
});

test('tournament hooks: a join and a win', async () => {
	const db = fakeDb(players());
	assert.ok(await social.recordTournamentEntry(db, 'alice', { id: 'T1', name: 'Friday Blitz' }, t0));
	assert.ok(await social.recordTournamentWin(db, 'alice', { id: 'T1', name: 'Friday Blitz' }, t0 + 1000));
	const d = db.dump();
	assert.deepStrictEqual(d.activity.alice.tj_T1, { t: 'tournament-join', at: t0, tid: 'T1', tname: 'Friday Blitz' });
	assert.strictEqual(d.activity.alice.tw_T1.t, 'tournament-win');
	assert.strictEqual(d.badges.alice['tournament-win'].tname, 'Friday Blitz');
	assert.ok(!d.activity.alice['b_tournament-win'], 'the win entry says it');
});

test('account deletion removes the player\'s records and their name from opponents\' wins', async () => {
	const db = fakeDb(players({
		user_games: { alice: { g1: { result: 'loss', opponentUid: 'bob' }, g2: { result: 'win', opponentUid: 'bob' }, g3: { result: 'loss', opponentUid: 'carol' } } },
		activity: { bob: { w_g1: { t: 'win', at: 1, opp: 'alice', oppName: 'Alice' } } },
	}));
	const games = { forEach: (f) => Object.entries(db.dump().user_games.alice).forEach(([k, v]) => f({ key: k, val: () => v })) };
	const updates = await social.deletionUpdates(db, 'alice', games, {});
	for (const p of ['activity', 'badges', 'achievements', 'notes', 'bookmarks', 'streamers', 'titles']) assert.strictEqual(updates[p + '/alice'], null, p);
	assert.strictEqual(updates['activity/bob/w_g1/oppName'], 'Deleted player');
	assert.strictEqual(updates['activity/bob/w_g1/opp'], null);
	// carol's entry is not there: no stub.
	assert.ok(!Object.keys(updates).some((k) => k.startsWith('activity/carol')));
});
