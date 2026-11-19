'use strict';
// Tournaments end to end on the emulators: the `tournament` callable, the
// players' own writes under database.rules.json, the tournamentGameEnd
// trigger and rateGame, through the client SDK the site uses:
//   firebase emulators:exec --only database,functions,auth --project demo-sigil 'node --test test/tournaments-e2e.test.js'

const test = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInAnonymously } = require('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');
const { getDatabase, connectDatabaseEmulator, ref, set, update, push, get, onValue, serverTimestamp } = require('firebase/database');
const { initializeApp: adminApp } = require('firebase-admin/app');
const { getDatabaseWithUrl } = require('firebase-admin/database');
const ONLINE = require('./online-game.json');

const NS = 'sigil-js-default-rtdb';
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-sigil';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FN_PORT = Number(process.env.FUNCTIONS_EMULATOR_PORT || 5001);
let seq = 0;
const admin = getDatabaseWithUrl(`https://${NS}.firebaseio.com`, adminApp({ projectId: PROJECT }, 'tournaments-e2e-admin'));

test.before(async () => {
	const rules = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const res = await fetch(`http://${DB_HOST}/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	assert.strictEqual(res.status, 200, await res.text());
});

function client(name) {
	const app = initializeApp({ projectId: PROJECT, apiKey: 'demo', databaseURL: `http://${DB_HOST}?ns=${NS}` }, name + ++seq);
	const auth = getAuth(app);
	connectAuthEmulator(auth, 'http://' + AUTH_HOST, { disableWarnings: true });
	const db = getDatabase(app);
	connectDatabaseEmulator(db, DB_HOST.split(':')[0], Number(DB_HOST.split(':')[1]));
	const fns = getFunctions(app, 'us-central1');
	connectFunctionsEmulator(fns, '127.0.0.1', FN_PORT);
	const call = (data) => httpsCallable(fns, 'tournament')(data).then((r) => r.data);
	return { app, auth, db, fns, call };
}

async function player(name, elo) {
	const c = client(name);
	const cred = await createUserWithEmailAndPassword(c.auth, `${name}${seq}@example.com`, 'password123');
	const uid = cred.user.uid;
	await set(ref(c.db, 'users/' + uid), { displayName: name, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: Date.now() });
	await set(ref(c.db, 'leaderboard/' + uid), { displayName: name, elo: 1000, gamesPlayed: 0 });
	if (elo) await admin.ref('users/' + uid + '/elo').set(elo);
	return Object.assign(c, { uid, name });
}

function waitFor(db, path, pred, ms = 60000) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => { off(); reject(new Error('timed out waiting for ' + path)); }, ms);
		const off = onValue(ref(db, path), (snap) => {
			if (snap.exists() && (!pred || pred(snap.val()))) { clearTimeout(t); off(); resolve(snap.val()); }
		});
	});
}

async function pushTurn(db, code, color, actions) {
	const last = (await get(ref(db, 'rooms/' + code + '/last'))).val();
	const key = push(ref(db, 'rooms/' + code + '/turns')).key;
	const turn = { color, actions, timestamp: serverTimestamp() };
	if (last) turn.after = last.key;
	await update(ref(db, 'rooms/' + code), { ['turns/' + key]: turn, last: { key, color }, takeback: null });
}

/** A resignation as firebase-sync.js sendForfeit writes it. */
async function resign(p, code, color) {
	await update(ref(p.db, 'rooms/' + code), { forfeitedBy: color, finishedBy: color, winner: color === 'red' ? 'blue' : 'red' });
	await update(ref(p.db, 'rooms/' + code), { status: 'finished', closedAt: serverTimestamp() });
}

const openPairings = async (db, tid) => Object.entries((await get(ref(db, 'tournament_pairings/' + tid))).val() || {})
	.filter(([, g]) => g.status === 'playing').map(([pid, g]) => Object.assign({ pid }, g));

test('a casual arena made by a player: join, berserk, play, scored by the trigger', async () => {
	const ann = await player('ann');
	const ben = await player('ben');
	const cat = await player('cat');
	// Guests cannot join or create.
	const guest = client('guest');
	await signInAnonymously(guest.auth);
	const { id } = await ann.call({ action: 'create', config: { kind: 'arena', name: 'Lunch arena', minutes: 3, increment: 2,
		durationMin: 20, startsAt: Date.now() + 600e3, rated: true, official: true } });
	const t = (await get(ref(ann.db, 'tournaments/' + id))).val();
	// A player's event is casual and not official, whatever they asked.
	assert.deepStrictEqual([t.rated, t.official, t.status, t.createdBy], [false, false, 'created', ann.uid]);
	await assert.rejects(guest.call({ action: 'join', id }), (e) => /permission-denied/.test(e.code));
	await assert.rejects(guest.call({ action: 'create', config: { kind: 'simul', name: 'Guest simul', untimed: true } }), (e) => /permission-denied/.test(e.code));
	// A poke needs only a sign-in.
	assert.deepStrictEqual(await guest.call({ action: 'poke', id }), { ok: true, status: 'created' });
	await ben.call({ action: 'join', id });
	await cat.call({ action: 'join', id });
	await assert.rejects(ben.call({ action: 'start', id }), (e) => /permission-denied/.test(e.code));
	await ann.call({ action: 'start', id });
	const [g] = await openPairings(ann.db, id);
	assert.ok(g, 'two of the joined players are paired at the start');
	const seat = { [ben.uid]: ben, [cat.uid]: cat };
	const red = seat[g.red], blue = seat[g.blue];
	assert.ok(red && blue);
	// The room as the game page finds it: both seats, the clock, the event.
	const room = (await get(ref(red.db, 'rooms/' + g.room))).val();
	assert.deepStrictEqual([room.status, room.ranked, room.casual, room.tournament.id], ['playing', false, true, id]);
	assert.strictEqual((await get(ref(red.db, 'user_active_games/' + red.uid + '/' + g.room))).val().myColor, 'red');
	// Red berserks (half of 3 minutes, no increment), plays its turns, and blue resigns.
	await admin.ref('rooms/' + g.room + '/spellNames').set(ONLINE.spellNames);
	await update(ref(red.db, 'rooms/' + g.room), { 'berserk/red': true, 'timer/red': 90000 });
	for (const tr of ONLINE.turns.slice(0, 8)) await pushTurn((tr.color === 'red' ? red : blue).db, g.room, tr.color, tr.actions);
	await assert.rejects(set(ref(blue.db, 'rooms/' + g.room + '/berserk/blue'), true));
	await assert.rejects(update(ref(blue.db, 'rooms/' + g.room), { abortedBy: 'blue', status: 'aborted' }));
	await resign(blue, g.room, 'blue');
	const scored = await waitFor(ann.db, 'tournament_pairings/' + id + '/' + g.pid, (v) => v.status !== 'playing');
	assert.deepStrictEqual([scored.status, scored.winner, scored.points.red, scored.points.blue], ['done', 'red', 3, 0]);
	const pr = (await get(ref(ann.db, 'tournament_players/' + id + '/' + red.uid))).val();
	assert.deepStrictEqual([pr.score, pr.sheet, pr.berserks], [3, '3', 1]);
	// The game is recorded and indexed as any online game, here unrated (casual).
	const gameId = await waitFor(red.db, 'rooms/' + g.room + '/gameId');
	const entry = await waitFor(red.db, 'user_games/' + red.uid + '/' + gameId);
	assert.deepStrictEqual([entry.rated, entry.unratedReason, entry.result], [false, 'casual', 'win']);
	// The creator cancels it; nothing more is paired.
	await ann.call({ action: 'cancel', id });
	assert.strictEqual((await get(ref(ann.db, 'tournaments/' + id + '/status'))).val(), 'cancelled');
	await assert.rejects(ben.call({ action: 'join', id }), (e) => /failed-precondition/.test(e.code));
});

test('a rated three-round Swiss by an admin: rounds follow results, games are rated', async () => {
	const ps = [];
	for (const [n, elo] of [['sa', 1300], ['sb', 1200], ['sc', 1100], ['sd', 1000]]) ps.push(await player(n, elo));
	const boss = await player('boss');
	await admin.ref('admins/' + boss.uid).set(true);
	const { id } = await boss.call({ action: 'create', config: { kind: 'swiss', name: 'Rated Swiss', minutes: 5, rounds: 3,
		roundGapSec: 0, startsAt: Date.now() + 3600e3, rated: true, official: true } });
	assert.deepStrictEqual((await get(ref(boss.db, 'tournament_index/' + id))).val().rated, true);
	for (const p of ps) await p.call({ action: 'join', id });
	await boss.call({ action: 'start', id });
	const byUid = Object.fromEntries(ps.map((p) => [p.uid, p]));
	const rating = Object.fromEntries(ps.map((p, i) => [p.uid, 1300 - i * 100]));
	for (let round = 1; round <= 3; round++) {
		await waitFor(boss.db, 'tournaments/' + id + '/round', (v) => v === round);
		const games = await openPairings(boss.db, id);
		assert.strictEqual(games.length, 2, 'round ' + round);
		for (const g of games) {
			assert.strictEqual(g.round, round);
			assert.strictEqual((await get(ref(boss.db, 'rooms/' + g.room + '/ranked'))).val(), true);
			// The lower rating resigns after both first moves.
			await admin.ref('rooms/' + g.room + '/spellNames').set(ONLINE.spellNames);
			await pushTurn(byUid[g.red].db, g.room, 'red', ONLINE.turns[0].actions);
			await pushTurn(byUid[g.blue].db, g.room, 'blue', ONLINE.turns[1].actions);
			const loser = rating[g.red] < rating[g.blue] ? 'red' : 'blue';
			await resign(byUid[g[loser]], g.room, loser);
		}
	}
	const t = await waitFor(boss.db, 'tournaments/' + id, (v) => v.final === true);
	assert.deepStrictEqual([t.status, t.round], ['finished', 3]);
	assert.deepStrictEqual(t.podium.map((p) => p.uid), [ps[0].uid, ps[1].uid, ps[2].uid]);
	const players = (await get(ref(boss.db, 'tournament_players/' + id))).val();
	assert.deepStrictEqual(ps.map((p) => players[p.uid].score), [3, 2, 1, 0]);
	// Six games, no pair twice, all rated by rateGame.
	const all = Object.values((await get(ref(boss.db, 'tournament_pairings/' + id))).val());
	assert.strictEqual(new Set(all.map((g) => [g.red, g.blue].sort().join())).size, 6);
	const top = ps[0];
	const games = await waitFor(top.db, 'user_games/' + top.uid, (v) => Object.keys(v).length === 3, 240000);
	assert.ok(Object.values(games).every((e) => e.rated === true && e.result === 'win'));
	assert.ok((await get(ref(top.db, 'users/' + top.uid + '/elo'))).val() > 1300);
});

// The client SDKs keep their connections open.
test.after(() => setTimeout(() => process.exit(0), 100));
