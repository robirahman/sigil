'use strict';
// tournaments.js against the Realtime Database emulator (admin rights, as the
// functions run), with scripted players: a full arena, a three-round Swiss
// and a simul, every result going through rating.js roomResult.
//   firebase emulators:exec --only database --project demo-sigil 'node --test test/tournaments-db.test.js'

const test = require('node:test');
const assert = require('node:assert');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getDatabaseWithUrl, ServerValue } = require('firebase-admin/database');
const T = require('../tournaments');
const ONLINE = require('./online-game.json');

const app = initializeApp({ projectId: 'demo-sigil' }, 'tournaments-db');
const db = getDatabaseWithUrl('https://tournaments-db-test.firebaseio.com', app);
test.after(() => deleteApp(app));
test.beforeEach(() => db.ref().set(null));

const other = (c) => (c === 'red' ? 'blue' : 'red');
const val = async (path) => (await db.ref(path).once('value')).val();

async function addUsers(ratings) {
	for (const [uid, elo] of Object.entries(ratings)) {
		await db.ref('users/' + uid).set({ displayName: uid.toUpperCase(), elo, gamesPlayed: 0, wins: 0, losses: 0, created: 1 });
	}
}

async function openPairings(tid) {
	const all = (await val('tournament_pairings/' + tid)) || {};
	return Object.entries(all).filter(([, g]) => g.status === 'playing').map(([pid, g]) => Object.assign({ pid }, g));
}

/** Turns as firebase-sync.js sendTurn writes them (server timestamps, chained by `after`). */
async function playTurns(code, turns) {
	const room = db.ref('rooms/' + code);
	for (const t of turns) {
		const last = await val('rooms/' + code + '/last');
		const key = room.child('turns').push().key;
		const turn = { color: t.color, actions: t.actions, timestamp: ServerValue.TIMESTAMP };
		if (last) turn.after = last.key;
		await room.update({ ['turns/' + key]: turn, last: { key, color: t.color } });
	}
}

/** The fixture's spells, so its transcript replays (the server drew others). */
const useFixture = (code) => db.ref('rooms/' + code + '/spellNames').set(ONLINE.spellNames);

/** A resignation, as firebase-sync.js sendForfeit and _closeRoom write it. */
async function resign(code, loser) {
	await db.ref('rooms/' + code).update({ forfeitedBy: loser, finishedBy: loser, winner: other(loser) });
	await db.ref('rooms/' + code).update({ status: 'finished', closedAt: ServerValue.TIMESTAMP });
}

/** `winnerUid` wins the pairing's game by the other's resignation, after `turns` fixture turns. */
async function win(g, winnerUid, turns) {
	if (turns) {
		await useFixture(g.room);
		await playTurns(g.room, ONLINE.turns.slice(0, turns));
	}
	await resign(g.room, g.red === winnerUid ? 'blue' : 'red');
	return T.onRoomEnded(db, g.room, Date.now());
}

test('an arena: pairs at once, scores streaks and berserks, pauses no-shows, ends on time', async () => {
	await addUsers({ a: 1500, b: 1400, c: 1300, d: 1200 });
	const { id } = await T.act(db, 'a', { action: 'create', config: { kind: 'arena', name: 'Test Arena', minutes: 3,
		durationMin: 30, startsAt: Date.now() + 3600e3, rated: true, official: true } }, { admin: true, now: Date.now() });
	const t0 = await val('tournaments/' + id);
	assert.deepStrictEqual([t0.status, t0.rated, t0.official, t0.berserk], ['created', true, true, true]);
	assert.strictEqual((await val('tournament_index/' + id)).name, 'Test Arena');
	for (const u of ['a', 'b', 'c', 'd']) await T.act(db, u, { action: 'join', id }, { admin: false, now: Date.now() });
	assert.deepStrictEqual(await openPairings(id), []);
	// Everyone has the event's page open (tournament.html writes this).
	for (const u of ['a', 'b', 'c', 'd']) await db.ref('tournament_presence/' + id + '/' + u + '/tab1').set(Date.now());
	// Only the creator (or an admin) starts it early.
	await assert.rejects(T.act(db, 'b', { action: 'start', id }, { admin: false, now: Date.now() }), (e) => e.code === 'permission-denied');
	await T.act(db, 'a', { action: 'start', id }, { admin: false, now: Date.now() });
	let open = await openPairings(id);
	assert.strictEqual(open.length, 2);
	// Neighbours by rating at the start: a-b and c-d.
	const pairOf = (g) => [g.red, g.blue].sort().join('');
	assert.deepStrictEqual(open.map(pairOf).sort(), ['ab', 'cd']);
	const ab = open.find((g) => pairOf(g) === 'ab');
	const cd = open.find((g) => pairOf(g) === 'cd');
	// The room is an ordinary online room, already joined, rated, with its clock.
	const room = await val('rooms/' + ab.room);
	assert.deepStrictEqual([room.status, room.ranked, room.seq, room.red.uid, room.blue.uid, room.tournament.id, room.tournament.berserk],
		['playing', true, true, ab.red, ab.blue, id, true]);
	assert.deepStrictEqual([room.timer.red, room.timer.blue, room.timer.activeColor], [180000, 180000, 'red']);
	assert.strictEqual(room.spellNames.length, 9);
	assert.strictEqual((await val('user_active_games/' + ab.red + '/' + ab.room)).myColor, 'red');
	assert.strictEqual(await val('live_rooms/' + ab.room), true);

	// a berserks, plays four turns of their own, and b resigns: 2 + 1.
	const aColor = ab.red === 'a' ? 'red' : 'blue';
	await db.ref('rooms/' + ab.room + '/berserk/' + aColor).set(true);
	await win(ab, 'a', 9);
	let pl = await val('tournament_players/' + id);
	assert.deepStrictEqual([pl.a.score, pl.a.sheet, pl.a.streak, pl.a.berserks, pl.b.score, pl.b.sheet], [3, '3', 1, 1, 0, '0']);
	// a and b just met, and c-d is still on: nobody to pair yet.
	assert.strictEqual((await openPairings(id)).length, 1);
	// d resigns at once: no berserk, no turns needed for a plain win.
	await win(cd, 'c', 0);
	open = await openPairings(id);
	assert.deepStrictEqual(open.map(pairOf).sort(), ['ac', 'bd']);
	// a's second and third wins: 2, then 4 on the streak.
	await win(open.find((g) => pairOf(g) === 'ac'), 'a', 0);
	await win(open.find((g) => pairOf(g) === 'bd'), 'd', 0);
	open = await openPairings(id);
	assert.deepStrictEqual(open.map(pairOf).sort(), ['ad', 'bc']);
	await win(open.find((g) => pairOf(g) === 'ad'), 'a', 0);
	pl = await val('tournament_players/' + id);
	assert.deepStrictEqual([pl.a.score, pl.a.sheet, pl.a.streak, pl.a.wins], [9, '324', 3, 3]);

	// b-c: the first mover never moves. Too early, nothing; after NOSHOW_MS the
	// room is aborted, the no-show paused and the other back in the pool.
	const bc = (await openPairings(id)).find((g) => pairOf(g) === 'bc');
	await T.advance(db, id, Date.now() + 5000);
	assert.strictEqual((await val('rooms/' + bc.room)).status, 'playing');
	await T.advance(db, id, Date.now() + T.NOSHOW_MS.arena + 1000);
	const aborted = await val('rooms/' + bc.room);
	assert.deepStrictEqual([aborted.status, aborted.abortedBy, aborted.endReason], ['aborted', 'red', 'noshow']);
	assert.strictEqual(await val('live_rooms/' + bc.room), null);
	const g = await val('tournament_pairings/' + id + '/' + bc.pid);
	assert.deepStrictEqual([g.status, g.how, g.noShow], ['void', 'noshow', 'red']);
	pl = await val('tournament_players/' + id);
	assert.strictEqual(pl[bc.red].active, false);
	assert.strictEqual(pl[bc.blue].active, true);
	// The status trigger fires on the abort too: already scored, ignored.
	assert.strictEqual(await T.onRoomEnded(db, bc.room, Date.now()), null);
	// a, d and the no-show's opponent are free: one game, between two who
	// did not just meet (a played d last; the opponent's last depends on colours).
	open = await openPairings(id);
	assert.strictEqual(open.length, 1);
	pl = await val('tournament_players/' + id);
	assert.ok(pl[open[0].red].lastOpp !== open[0].blue && pl[open[0].blue].lastOpp !== open[0].red, pairOf(open[0]));
	// The no-show joins again and is paired with d.
	await T.act(db, bc.red, { action: 'join', id }, { admin: false, now: Date.now() });
	open = await openPairings(id);
	assert.strictEqual(open.length, 2);

	// The end: no more pairings, the games still going count, then it is final.
	for (const p of open) {
		await useFixture(p.room);
		await playTurns(p.room, ONLINE.turns.slice(0, 2));
	}
	const endsAt = (await val('tournaments/' + id)).endsAt;
	await T.advance(db, id, endsAt + 1000);
	let t = await val('tournaments/' + id);
	assert.deepStrictEqual([t.status, t.final], ['finished', false]);
	assert.strictEqual(await val('tournament_active/' + id), true);
	for (const p of open) await win(p, p.red, 0);
	t = await val('tournaments/' + id);
	assert.deepStrictEqual([t.status, t.final], ['finished', true]);
	assert.strictEqual(t.podium[0].uid, 'a');
	assert.strictEqual(await val('tournament_active/' + id), null);
	assert.strictEqual(await val('tournament_limits/a/' + id), null);
	pl = await val('tournament_players/' + id);
	assert.deepStrictEqual(Object.values(pl).map((p) => p.rank).sort(), [1, 2, 3, 4]);
	// Nothing more is paired after the end.
	assert.deepStrictEqual(await openPairings(id), []);
	assert.strictEqual(await T.onRoomEnded(db, ab.room, Date.now()), null);
});

test('a three-round Swiss: no repeats, a bye, a no-show, tie-breaks', async () => {
	await addUsers({ p1: 1600, p2: 1500, p3: 1400, p4: 1300, p5: 1200 });
	// p5 is suspended: a rated event still plays their games, unrated.
	await db.ref('user_flags/p5/banUntil').set(Date.now() + 86400e3);
	const { id } = await T.act(db, 'p1', { action: 'create', config: { kind: 'swiss', name: 'Test Swiss', minutes: 5, rounds: 3,
		roundGapSec: 0, startsAt: Date.now() + 3600e3, rated: true } }, { admin: true, now: Date.now() });
	for (const u of ['p1', 'p2', 'p3', 'p4']) await T.act(db, u, { action: 'join', id }, { admin: false, now: Date.now() });
	// A suspended player may not join a rated event; once it is lifted they may.
	await assert.rejects(T.act(db, 'p5', { action: 'join', id }, { admin: false, now: Date.now() }), (e) => e.code === 'permission-denied');
	await db.ref('user_flags/p5/banUntil').set(Date.now() - 1);
	await T.act(db, 'p5', { action: 'join', id }, { admin: false, now: Date.now() });
	// A late leaver before the start is simply gone; joins again.
	await T.act(db, 'p4', { action: 'withdraw', id }, { admin: false, now: Date.now() });
	assert.strictEqual(await val('tournament_players/' + id + '/p4'), null);
	await T.act(db, 'p4', { action: 'join', id }, { admin: false, now: Date.now() });
	assert.strictEqual((await val('tournaments/' + id)).nbPlayers, 5);
	// At the start time the tick starts round 1.
	await T.advance(db, id, (await val('tournaments/' + id)).startsAt + 1);
	let t = await val('tournaments/' + id);
	assert.deepStrictEqual([t.status, t.round], ['started', 1]);
	const rating = { p1: 1600, p2: 1500, p3: 1400, p4: 1300, p5: 1200 };
	const all = async () => Object.values((await val('tournament_pairings/' + id)) || {});
	for (let round = 1; round <= 3; round++) {
		t = await val('tournaments/' + id);
		assert.strictEqual(t.round, round);
		const games = (await all()).filter((g) => g.round === round);
		const playing = games.filter((g) => g.status === 'playing');
		// One spell layout per round.
		const spells = new Set();
		for (const g of playing) spells.add(JSON.stringify((await val('rooms/' + g.room)).spellNames));
		assert.strictEqual(spells.size, 1);
		if (round < 3) {
			assert.strictEqual(playing.length, 2);
			assert.strictEqual(games.filter((g) => g.bye).length, 1);
		}
		if (round === 2) {
			// The first game's red never moves: blue wins by forfeit, red is
			// withdrawn. The other game is under way.
			const ns = playing.shift();
			for (const g of playing) {
				await useFixture(g.room);
				await playTurns(g.room, ONLINE.turns.slice(0, 2));
			}
			await T.advance(db, id, Date.now() + T.NOSHOW_MS.swiss + 1000);
			const g = await val('tournament_pairings/' + id + '/' + (Object.entries(await val('tournament_pairings/' + id)).find(([, x]) => x.room === ns.room)[0]));
			assert.deepStrictEqual([g.status, g.winner, g.how], ['done', 'blue', 'noshow']);
			assert.strictEqual((await val('tournament_players/' + id + '/' + ns.red)).withdrawn, true);
			t = await val('tournaments/' + id);
			assert.strictEqual(t.round, 2, 'the round waits for its last game');
		}
		// The higher rating wins the rest.
		for (const g of playing) await win(g, rating[g.red] > rating[g.blue] ? g.red : g.blue, 0);
	}
	t = await val('tournaments/' + id);
	assert.deepStrictEqual([t.status, t.final, t.round], ['finished', true, 3]);
	const games = await all();
	// Round 3: four players left, two games, no bye.
	assert.deepStrictEqual([games.filter((g) => g.round === 3 && !g.bye).length, games.filter((g) => g.round === 3 && g.bye).length], [2, 0]);
	const met = new Set();
	for (const g of games.filter((x) => !x.bye)) {
		const k = [g.red, g.blue].sort().join('-');
		assert.ok(!met.has(k), k + ' met twice');
		met.add(k);
	}
	const players = await val('tournament_players/' + id);
	for (const p of Object.values(players)) assert.ok((p.byes || 0) <= 1);
	// Final standings carry ranks and tie-breaks, and the podium matches.
	const ranks = Object.entries(players).sort((x, y) => x[1].rank - y[1].rank);
	assert.deepStrictEqual(ranks.map(([, p]) => p.rank), [1, 2, 3, 4, 5]);
	for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i - 1][1].score >= ranks[i][1].score);
	assert.ok(ranks.every(([, p]) => typeof p.buchholz === 'number' && typeof p.sb === 'number'));
	assert.deepStrictEqual(t.podium.map((p) => p.uid), ranks.slice(0, 3).map(([uid]) => uid));
	// Every game of a rated event was rated, the bye aside.
	for (const g of games.filter((x) => !x.bye)) assert.strictEqual((await val('rooms/' + g.room)).ranked, true);
});

test('a simul: the host against every opponent, extra time, one layout', async () => {
	await addUsers({ h: 1800, x: 1200, y: 1100, z: 1000, w: 900 });
	const { id } = await T.act(db, 'h', { action: 'create', config: { kind: 'simul', name: 'Simul night', minutes: 5,
		hostExtraSec: 30, hostColor: 'alternate', maxPlayers: 3 } }, { admin: false, now: Date.now() });
	await assert.rejects(T.act(db, 'h', { action: 'join', id }, { admin: false, now: Date.now() }), (e) => e.message === 'host');
	// (A private event's games stay off Watch Live: see the cancel test.)
	for (const u of ['x', 'y', 'z']) await T.act(db, u, { action: 'join', id }, { admin: false, now: Date.now() });
	await assert.rejects(T.act(db, 'w', { action: 'join', id }, { admin: false, now: Date.now() }), (e) => e.code === 'resource-exhausted');
	// The host removes one before the start; w takes the seat.
	await assert.rejects(T.act(db, 'x', { action: 'kick', id, uid: 'z' }, { admin: false, now: Date.now() }), (e) => e.code === 'permission-denied');
	await T.act(db, 'h', { action: 'kick', id, uid: 'z' }, { admin: false, now: Date.now() });
	await T.act(db, 'w', { action: 'join', id }, { admin: false, now: Date.now() });
	await assert.rejects(T.act(db, 'x', { action: 'start', id }, { admin: false, now: Date.now() }), (e) => e.code === 'permission-denied');
	await T.act(db, 'h', { action: 'start', id }, { admin: false, now: Date.now() });
	const open = await openPairings(id);
	assert.strictEqual(open.length, 3);
	const rooms = await Promise.all(open.map((g) => val('rooms/' + g.room)));
	assert.strictEqual(new Set(rooms.map((r) => JSON.stringify(r.spellNames))).size, 1);
	assert.deepStrictEqual(rooms.map((r) => r.red.uid === 'h').sort(), [false, true, true]);
	for (const r of rooms) {
		const hc = r.red.uid === 'h' ? 'red' : 'blue';
		assert.deepStrictEqual([r.ranked, r.casual, r.extraTime[hc], r.timer[hc], r.timer[other(hc)]], [false, true, 90000, 390000, 300000]);
	}
	// Joining after the start is refused.
	await assert.rejects(T.act(db, 'z', { action: 'join', id }, { admin: false, now: Date.now() }), (e) => e.message === 'closed');
	// The host's own slow first moves are no no-show while the host is
	// there (the simul pages hold their seat on every board); an opponent
	// who moves first must.
	for (const g of open) await db.ref('rooms/' + g.room + '/' + (g.red === 'h' ? 'red' : 'blue') + '/conns/tab1').set(Date.now());
	const oppRed = open.find((g) => g.red !== 'h');
	await useFixture(oppRed.room);
	await playTurns(oppRed.room, ONLINE.turns.slice(0, 1));
	await T.advance(db, id, Date.now() + T.NOSHOW_MS.simul + 1000);
	for (const g of open) assert.strictEqual((await val('rooms/' + g.room)).status, 'playing');
	// The host wins two, loses one.
	const sorted = open.slice().sort((a, b) => (a.red === 'h' ? 0 : 1) - (b.red === 'h' ? 0 : 1));
	await win(sorted[0], 'h', 0);
	await win(sorted[1], 'h', 0);
	await win(sorted[2], sorted[2].red === 'h' ? sorted[2].blue : sorted[2].red, 0);
	const t = await val('tournaments/' + id);
	assert.deepStrictEqual([t.status, t.final, t.hostWins, t.hostLosses], ['finished', true, 2, 1]);
	const pl = await val('tournament_players/' + id);
	assert.deepStrictEqual(Object.values(pl).map((p) => p.result).sort(), ['loss', 'loss', 'win']);
});

test('a room is scored once, and only the room its pairing names', async () => {
	await addUsers({ a: 1000, b: 1000 });
	const { id } = await T.act(db, 'a', { action: 'create', config: { kind: 'arena', name: 'Once', minutes: 3, durationMin: 30,
		startsAt: Date.now() } }, { admin: false, now: Date.now() });
	for (const u of ['a', 'b']) await T.act(db, u, { action: 'join', id }, { admin: false, now: Date.now() });
	const [g] = await openPairings(id);
	assert.ok(g);
	// A room claiming the pairing that is not its room: ignored.
	await db.ref('rooms/FAKE01').set(Object.assign({}, await val('rooms/' + g.room), { status: 'finished', winner: 'red', forfeitedBy: 'blue' }));
	assert.strictEqual(await T.onRoomEnded(db, 'FAKE01', Date.now()), null);
	await resign(g.room, 'blue');
	// Two deliveries of the trigger at once: one scores.
	const [x, y] = await Promise.all([T.onRoomEnded(db, g.room, Date.now()), T.onRoomEnded(db, g.room, Date.now())]);
	assert.ok(!!x !== !!y);
	const pl = await val('tournament_players/' + id);
	assert.strictEqual(pl[g.red].score + pl[g.blue].score, 2);
	// A natural end that does not follow from the board is the finisher's loss.
	await new Promise((r) => setTimeout(r, T.REMATCH_WAIT_MS + 100));
	await T.advance(db, id, Date.now());
	const [g2] = await openPairings(id);
	await useFixture(g2.room);
	await playTurns(g2.room, ONLINE.turns.slice(0, 6));
	await db.ref('rooms/' + g2.room).update({ finishedBy: 'red', winner: 'red', status: 'finished', closedAt: ServerValue.TIMESTAMP });
	const scored = await T.onRoomEnded(db, g2.room, Date.now());
	assert.deepStrictEqual([scored.winner, scored.status], ['blue', 'done']);
	// Five events at once is over a player's limit.
	for (let i = 0; i < 2; i++) {
		await T.act(db, 'a', { action: 'create', config: { kind: 'simul', name: 'S' + i + 'xx', untimed: true } }, { admin: false, now: Date.now() });
	}
	await assert.rejects(T.act(db, 'a', { action: 'create', config: { kind: 'simul', name: 'Too many', untimed: true } }, { admin: false, now: Date.now() }),
		(e) => e.code === 'resource-exhausted');
});

test('a deleted account leaves the standings, the pairings and its events nameless', async () => {
	await addUsers({ a: 1000, b: 1000 });
	const { id } = await T.act(db, 'a', { action: 'create', config: { kind: 'arena', name: 'Gone', minutes: 3, durationMin: 30,
		startsAt: Date.now() } }, { admin: false, now: Date.now() });
	for (const u of ['a', 'b']) await T.act(db, u, { action: 'join', id }, { admin: false, now: Date.now() });
	const [g] = await openPairings(id);
	await db.ref('tournament_presence/' + id + '/a/tab1').set(Date.now());
	await db.ref('deleted_users/a').set(Date.now());
	const updates = {};
	await T.scrubUser(db, 'a', updates);
	await db.ref().update(updates);
	assert.strictEqual(await val('tournament_presence/' + id + '/a'), null);
	const pl = await val('tournament_players/' + id);
	assert.deepStrictEqual([pl.a.name, pl.a.withdrawn, pl.a.active, pl.b.name], ['Deleted player', true, false, 'B']);
	const pg = await val('tournament_pairings/' + id + '/' + g.pid);
	assert.strictEqual(g.red === 'a' ? pg.redName : pg.blueName, 'Deleted player');
	assert.strictEqual((await val('tournaments/' + id)).createdByName, 'Deleted player');
	assert.strictEqual((await val('tournament_index/' + id)).by, 'Deleted player');
	assert.deepStrictEqual([await val('user_tournaments/a'), await val('tournament_limits/a')], [null, null]);
	// Their game ends (deleteUserData resigns it): the row stays scrubbed and
	// the deleted account is not paired again, even rejoined by a stale write.
	await resign(g.room, g.red === 'a' ? 'red' : 'blue');
	await T.onRoomEnded(db, g.room, Date.now());
	await db.ref('tournament_players/' + id + '/a').update({ active: true, withdrawn: null });
	await addUsers({ c: 1000 });
	await T.act(db, 'c', { action: 'join', id }, { admin: false, now: Date.now() });
	await new Promise((r) => setTimeout(r, T.REMATCH_WAIT_MS + 100));
	await T.advance(db, id, Date.now());
	for (const x of await openPairings(id)) assert.ok(x.red !== 'a' && x.blue !== 'a', 'a deleted account is paired');
	assert.strictEqual((await val('tournament_players/' + id + '/a')).name, 'Deleted player');
	// A deleted account can neither create nor join.
	await assert.rejects(T.act(db, 'a', { action: 'create', config: { kind: 'simul', name: 'Ghost', untimed: true } }, { admin: false, now: Date.now() }),
		(e) => e.message === 'deleted');
	await assert.rejects(T.act(db, 'a', { action: 'join', id }, { admin: false, now: Date.now() }), (e) => e.message === 'deleted');
	// Nothing written for an event they only created (no player row appears).
	const { id: id2 } = await T.act(db, 'b', { action: 'create', config: { kind: 'simul', name: 'Bsimul', untimed: true } }, { admin: false, now: Date.now() });
	const u2 = {};
	await T.scrubUser(db, 'b', u2);
	await db.ref().update(u2);
	assert.strictEqual(await val('tournament_players/' + id2), null);
	assert.strictEqual((await val('tournaments/' + id2)).hostName, 'Deleted player');
});

test('the lock: renewed while held, and a writer that lost it writes nothing', async () => {
	await addUsers({ a: 1000 });
	const { id } = await T.act(db, 'a', { action: 'create', config: { kind: 'arena', name: 'Locks', minutes: 3, durationMin: 30,
		startsAt: Date.now() + 3600e3 } }, { admin: false, now: Date.now() });
	// Someone else takes the lock over while we hold it: our save is refused.
	await assert.rejects(T.withLock(db, id, async (guard) => {
		const S = await T.load(db, id);
		S.guard = guard;
		S.t.name = 'Overwritten';
		S.dirtyT = true;
		await db.ref('tournament_locks/' + id).set({ by: 'someone-else', until: Date.now() + 60000 });
		await T.save(S);
	}), (e) => e.message === 'lock-lost');
	assert.strictEqual((await val('tournaments/' + id)).name, 'Locks');
	await db.ref('tournament_locks/' + id).remove();
	// A holder renews its lease as it goes.
	await T.withLock(db, id, async (guard) => {
		const before = (await val('tournament_locks/' + id)).until;
		await new Promise((r) => setTimeout(r, 50));
		await guard.confirm();
		assert.ok((await val('tournament_locks/' + id)).until > before);
	});
	assert.strictEqual(await val('tournament_locks/' + id), null);
});

test('cancelling a running event aborts its open games and frees their players', async () => {
	await addUsers({ a: 1000, b: 1000, c: 1000 });
	const { id } = await T.act(db, 'a', { action: 'create', config: { kind: 'simul', name: 'Cancelled simul', untimed: true, private: true } }, { admin: false, now: Date.now() });
	for (const u of ['b', 'c']) await T.act(db, u, { action: 'join', id }, { admin: false, now: Date.now() });
	await T.act(db, 'a', { action: 'start', id }, { admin: false, now: Date.now() });
	const open = await openPairings(id);
	assert.strictEqual(open.length, 2);
	// A private event: its games are not on Watch Live (live_rooms), nor is it listed.
	for (const g of open) assert.strictEqual(await val('live_rooms/' + g.room), null);
	assert.strictEqual(await val('tournament_index/' + id), null);
	// A planted abortedBy (the rules refuse it now) must not make the cancel a forfeit.
	await db.ref('rooms/' + open[1].room + '/abortedBy').set('red');
	// One game ends just before the cancel: it keeps its result.
	await resign(open[0].room, open[0].red === 'a' ? 'blue' : 'red');
	await T.act(db, 'a', { action: 'cancel', id }, { admin: false, now: Date.now() });
	const t = await val('tournaments/' + id);
	assert.deepStrictEqual([t.status, t.final], ['cancelled', true]);
	const r1 = await val('rooms/' + open[1].room);
	assert.deepStrictEqual([r1.status, r1.endReason, r1.abortedBy], ['aborted', 'cancelled', undefined]);
	assert.strictEqual(await val('live_rooms/' + open[1].room), null);
	const g = await val('tournament_pairings/' + id);
	assert.deepStrictEqual([g[open[0].pid].status, g[open[1].pid].status, g[open[1].pid].how], ['done', 'void', 'cancelled']);
	assert.strictEqual(await val('tournament_active/' + id), null);
	// The abort's trigger finds nothing to score.
	assert.strictEqual(await T.onRoomEnded(db, open[1].room, Date.now()), null);
});

test('a repeating event schedules its next edition for its creator', async () => {
	await addUsers({ adm: 1000, b: 1000, c: 1000 });
	const { id } = await T.act(db, 'adm', { action: 'create', config: { kind: 'swiss', name: 'Daily Swiss', minutes: 3, rounds: 3,
		roundGapSec: 0, startsAt: Date.now() + 3600e3, repeat: 'daily', private: true } }, { admin: true, now: Date.now() });
	// Not enough players at the start: cancelled, and no edition follows a cancel.
	await T.advance(db, id, (await val('tournaments/' + id)).startsAt + 1);
	assert.strictEqual((await val('tournaments/' + id)).status, 'cancelled');
	const { id: id2 } = await T.act(db, 'adm', { action: 'create', config: { kind: 'arena', name: 'Daily Arena', minutes: 3, durationMin: 10,
		startsAt: Date.now() + 3600e3, repeat: 'daily', private: true } }, { admin: true, now: Date.now() });
	const t0 = await val('tournaments/' + id2);
	await T.advance(db, id2, t0.startsAt + 1);
	await T.advance(db, id2, t0.endsAt + 1);
	const t1 = await val('tournaments/' + id2);
	assert.deepStrictEqual([t1.status, t1.final, typeof t1.repeatedTo], ['finished', true, 'string']);
	const next = await val('tournaments/' + t1.repeatedTo);
	assert.deepStrictEqual([next.status, next.startsAt - t0.startsAt, next.repeat, next.private], ['created', 86400e3, 'daily', true]);
	assert.strictEqual((await val('user_tournaments/adm/' + t1.repeatedTo)).role, 'creator');
	assert.ok(await val('tournament_limits/adm/' + t1.repeatedTo));
	assert.strictEqual(await val('tournament_active/' + t1.repeatedTo), true);
});

test('a repeating series ends when its creator is deleted', async () => {
	await addUsers({ adm: 1000 });
	const { id } = await T.act(db, 'adm', { action: 'create', config: { kind: 'arena', name: 'Doomed series', minutes: 3, durationMin: 10,
		startsAt: Date.now() + 3600e3, repeat: 'weekly' } }, { admin: true, now: Date.now() });
	await db.ref('deleted_users/adm').set(Date.now());
	await T.scrubUser(db, 'adm', {});
	const t0 = await val('tournaments/' + id);
	assert.deepStrictEqual([t0.repeat, t0.createdByName], [undefined, 'Deleted player']);
	await T.advance(db, id, t0.startsAt + 1);
	await T.advance(db, id, t0.endsAt + 1);
	const t1 = await val('tournaments/' + id);
	assert.deepStrictEqual([t1.status, t1.final, t1.repeatedTo], ['finished', true, undefined]);
});

test('a deleted player frees their seat before the start; a simul without its host is cancelled', async () => {
	await addUsers({ h: 1000, x: 1000, y: 1000 });
	const { id } = await T.act(db, 'h', { action: 'create', config: { kind: 'simul', name: 'One seat', untimed: true, maxPlayers: 1 } }, { admin: false, now: Date.now() });
	await T.act(db, 'x', { action: 'join', id }, { admin: false, now: Date.now() });
	await assert.rejects(T.act(db, 'y', { action: 'join', id }, { admin: false, now: Date.now() }), (e) => e.code === 'resource-exhausted');
	await db.ref('deleted_users/x').set(Date.now());
	await T.scrubUser(db, 'x', {});
	assert.strictEqual(await val('tournament_players/' + id + '/x'), null);
	assert.strictEqual((await val('tournaments/' + id)).nbPlayers, 0);
	await T.act(db, 'y', { action: 'join', id }, { admin: false, now: Date.now() });
	await db.ref('deleted_users/h').set(Date.now());
	await T.scrubUser(db, 'h', {});
	const t = await val('tournaments/' + id);
	assert.deepStrictEqual([t.status, t.final, t.hostName, t.cancelReason], ['cancelled', true, 'Deleted player', 'host-deleted']);
	assert.strictEqual(await val('tournament_active/' + id), null);
	assert.strictEqual((await val('tournament_index/' + id)).status, 'cancelled');
});

test('a flag without a move is a no-show; a simul host gone that long forfeits the board', async () => {
	await addUsers({ a: 1200, b: 1100, h: 1500, x: 1000 });
	const { id } = await T.act(db, 'a', { action: 'create', config: { kind: 'swiss', name: 'Bullet Swiss', minutes: 1, rounds: 3,
		roundGapSec: 0, startsAt: Date.now() + 3600e3 } }, { admin: false, now: Date.now() });
	for (const u of ['a', 'b']) await T.act(db, u, { action: 'join', id }, { admin: false, now: Date.now() });
	await T.act(db, 'a', { action: 'start', id }, { admin: false, now: Date.now() });
	const [g] = await openPairings(id);
	// Red never moved and its minute ran out before any sweep: blue claims the flag.
	await db.ref('rooms/' + g.room + '/startedAt').set(Date.now() - 70000);
	await db.ref('rooms/' + g.room).update({ finishedBy: 'blue', winner: 'blue', endReason: 'time' });
	await db.ref('rooms/' + g.room).update({ status: 'finished', closedAt: ServerValue.TIMESTAMP });
	const scored = await T.onRoomEnded(db, g.room, Date.now());
	assert.deepStrictEqual([scored.status, scored.winner, scored.how], ['done', 'blue', 'noshow']);
	assert.strictEqual((await val('tournament_players/' + id + '/' + g.red)).withdrawn, true);
	// An untimed simul: the host's seat went offline before their first move.
	const { id: sid } = await T.act(db, 'h', { action: 'create', config: { kind: 'simul', name: 'Absent host', untimed: true } }, { admin: false, now: Date.now() });
	await T.act(db, 'x', { action: 'join', id: sid }, { admin: false, now: Date.now() });
	await T.act(db, 'h', { action: 'start', id: sid }, { admin: false, now: Date.now() });
	const [sg] = await openPairings(sid);
	await db.ref('rooms/' + sg.room + '/red').update({ connected: false, disconnectedAt: Date.now() });
	await T.advance(db, sid, Date.now() + 60000);
	assert.strictEqual((await val('rooms/' + sg.room)).status, 'playing');
	await T.advance(db, sid, Date.now() + T.NOSHOW_MS.simul + 1000);
	const r = await val('rooms/' + sg.room);
	assert.deepStrictEqual([r.status, r.abortedBy, r.endReason], ['aborted', 'red', 'noshow']);
	const t = await val('tournaments/' + sid);
	assert.deepStrictEqual([t.status, t.final], ['finished', true]);
});
