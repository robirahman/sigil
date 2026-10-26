'use strict';
// The rules and the rateGame function together, on the emulators, through
// the same client SDK calls the site makes:
//   cd functions && npm run test:e2e

const test = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } = require('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');
const { getDatabase, connectDatabaseEmulator, ref, set, update, push, get, onValue, onDisconnect, goOffline, serverTimestamp } = require('firebase/database');
const ONLINE = require('./online-game.json');
const AI = require('./ai-games.json');

const NS = 'sigil-js-default-rtdb';
// The emulators' addresses (firebase emulators:exec sets the first two), so
// a private emulator config with other ports works too.
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FN_PORT = Number(process.env.FUNCTIONS_EMULATOR_PORT || 5001);
let seq = 0;

// The emulator applies firebase.json's rules to the project's default
// namespace only; load them into the production instance's name.
test.before(async () => {
	const rules = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const res = await fetch(`http://${DB_HOST}/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	assert.strictEqual(res.status, 200, await res.text());
});

async function player(name) {
	const app = initializeApp({ projectId: 'demo-sigil', apiKey: 'demo', databaseURL: `http://${DB_HOST}?ns=${NS}` }, name + ++seq);
	const auth = getAuth(app);
	connectAuthEmulator(auth, 'http://' + AUTH_HOST, { disableWarnings: true });
	const db = getDatabase(app);
	connectDatabaseEmulator(db, DB_HOST.split(':')[0], Number(DB_HOST.split(':')[1]));
	const cred = await createUserWithEmailAndPassword(auth, `${name}${seq}@example.com`, 'password123');
	const uid = cred.user.uid;
	// What auth-manager.js ensureUserProfile writes for a new account.
	await set(ref(db, 'users/' + uid), { displayName: name, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: Date.now() });
	await set(ref(db, 'leaderboard/' + uid), { displayName: name, elo: 1000, gamesPlayed: 0 });
	const fns = getFunctions(app, 'us-central1');
	connectFunctionsEmulator(fns, '127.0.0.1', FN_PORT);
	return { uid, db, name, fns };
}

function waitFor(db, path, ms = 30000) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => { off(); reject(new Error('timed out waiting for ' + path)); }, ms);
		const off = onValue(ref(db, path), (snap) => {
			if (snap.exists()) { clearTimeout(t); off(); resolve(snap.val()); }
		});
	});
}

// A turn as firebase-sync.js sendTurn writes it: following the room's last
// turn, and moving `last` on in the same write (database.rules.json).
async function pushTurn(db, code, color, actions) {
	const last = (await get(ref(db, 'rooms/' + code + '/last'))).val();
	const key = push(ref(db, 'rooms/' + code + '/turns')).key;
	const turn = { color, actions, timestamp: serverTimestamp() };
	if (last) turn.after = last.key;
	await update(ref(db, 'rooms/' + code), { ['turns/' + key]: turn, last: { key, color } });
}

async function playRoom(alice, bob, upTo, timeControl) {
	const code = 'E2E' + ++seq;
	await set(ref(alice.db, 'rooms/' + code), {
		spellNames: ONLINE.spellNames, status: 'waiting', created: Date.now(), ranked: false,
		red: { uid: alice.uid, displayName: 'alice', connected: true }, blue: { connected: false },
		timeControl: timeControl || { type: 'none' }, allowSpectators: true, variant: 'standard', seq: true,
	});
	await update(ref(bob.db, 'rooms/' + code), {
		blue: { uid: bob.uid, displayName: 'bob', connected: true, seq: true }, status: 'playing', ranked: true,
	});
	for (const t of ONLINE.turns.slice(0, upTo)) {
		const p = t.color === 'red' ? alice : bob;
		await pushTurn(p.db, code, t.color, t.actions);
	}
	return code;
}

test('an online game is recorded and rated once, by the server', async () => {
	const alice = await player('alice');
	const bob = await player('bob');
	const code = await playRoom(alice, bob);
	// A client may neither rate it nor record it.
	await assert.rejects(set(ref(alice.db, 'users/' + alice.uid + '/elo'), 1016));
	await assert.rejects(set(push(ref(alice.db, 'completed_games')), { winner: 'red', timestamp: 1, redUid: alice.uid, blueUid: bob.uid, ranked: true }));
	// What multiplayer-controller.js does at a natural end (firebase-sync.js writeRoomFinalState).
	const fin = ONLINE.winner === 'red' ? alice : bob;
	await update(ref(fin.db, 'rooms/' + code), { gameLog: ONLINE.turns, finishedAt: Date.now() });
	await update(ref(fin.db, 'rooms/' + code), { finishedBy: ONLINE.winner, winner: ONLINE.winner, status: 'finished', closedAt: serverTimestamp() });
	// The other client's attempt is refused: the room is already finished.
	const late = fin === alice ? bob : alice;
	await assert.rejects(update(ref(late.db, 'rooms/' + code), { finishedBy: ONLINE.winner === 'red' ? 'blue' : 'red', winner: ONLINE.winner, status: 'finished', closedAt: serverTimestamp() }));
	const gameId = await waitFor(alice.db, `rooms/${code}/gameId`);
	const mine = await waitFor(alice.db, `user_games/${alice.uid}/${gameId}`);
	const won = ONLINE.winner === 'red';
	assert.deepStrictEqual([mine.rated, mine.eloChange, mine.result], [true, won ? 16 : -16, won ? 'win' : 'loss']);
	assert.strictEqual((await get(ref(bob.db, `users/${bob.uid}/elo`))).val(), won ? 984 : 1016);
	assert.strictEqual((await get(ref(bob.db, `leaderboard/${alice.uid}/gamesPlayed`))).val(), 1);
});

test('finishing a game early with a false result is a resignation', async () => {
	const alice = await player('alice');
	const bob = await player('bob');
	// Half the game, then red declares itself the winner.
	const code = await playRoom(alice, bob, 20);
	await update(ref(alice.db, 'rooms/' + code), { finishedBy: 'red', winner: 'red', status: 'finished', closedAt: serverTimestamp() });
	const gameId = await waitFor(bob.db, `rooms/${code}/gameId`);
	const bobs = await waitFor(bob.db, `user_games/${bob.uid}/${gameId}`);
	assert.deepStrictEqual([bobs.rated, bobs.result, bobs.eloChange], [true, 'win', 16]);
	const room = (await get(ref(bob.db, 'rooms/' + code))).val();
	assert.deepStrictEqual([room.winner, room.forfeitedBy], ['blue', 'red']);
});

test('an abort before both players move has no result; after, it is a forfeit', async () => {
	const alice = await player('alice');
	const bob = await player('bob');
	const early = await playRoom(alice, bob, 1);
	await update(ref(bob.db, 'rooms/' + early), { abortedBy: 'blue', status: 'aborted' });
	await new Promise((r) => setTimeout(r, 8000));
	const e = (await get(ref(alice.db, 'rooms/' + early))).val();
	assert.deepStrictEqual([e.status, e.gameId, e.winner], ['aborted', undefined, undefined]);

	const late = await playRoom(alice, bob, 6);
	// Written apart: the abort is still settled from the status change.
	await update(ref(bob.db, 'rooms/' + late), { abortedBy: 'blue' });
	await new Promise((r) => setTimeout(r, 2000));
	await update(ref(bob.db, 'rooms/' + late), { status: 'aborted' });
	const gameId = await waitFor(alice.db, `rooms/${late}/gameId`);
	const room = (await get(ref(alice.db, 'rooms/' + late))).val();
	assert.deepStrictEqual([room.status, room.winner, room.forfeitedBy], ['finished', 'red', 'blue']);
	const mine = await waitFor(alice.db, `user_games/${alice.uid}/${gameId}`);
	assert.deepStrictEqual([mine.rated, mine.result], [true, 'win']);
});

test('a player gone for a minute loses on a claim; an early claim is the claimer\'s loss', async () => {
	const alice = await player('alice');
	const bob = await player('bob');
	const code = await playRoom(alice, bob, 4);
	// What firebase-sync.js _goOnline arranges; then bob's connection drops.
	await onDisconnect(ref(bob.db, 'rooms/' + code + '/blue')).update({ connected: false, disconnectedAt: serverTimestamp() });
	goOffline(bob.db);
	await new Promise((r) => setTimeout(r, 61_000));
	await update(ref(alice.db, 'rooms/' + code), { finishedBy: 'red', winner: 'red', endReason: 'abandon' });
	await update(ref(alice.db, 'rooms/' + code), { status: 'finished', closedAt: serverTimestamp() });
	const gameId = await waitFor(alice.db, `rooms/${code}/gameId`);
	const mine = await waitFor(alice.db, `user_games/${alice.uid}/${gameId}`);
	assert.deepStrictEqual([mine.rated, mine.result], [true, 'win']);

	const carol = await player('carol');
	const dave = await player('dave');
	const code2 = await playRoom(carol, dave, 4);
	await update(ref(carol.db, 'rooms/' + code2), { finishedBy: 'red', winner: 'red', endReason: 'abandon', status: 'finished', closedAt: serverTimestamp() });
	const g2 = await waitFor(carol.db, `rooms/${code2}/gameId`);
	const c = await waitFor(carol.db, `user_games/${carol.uid}/${g2}`);
	assert.deepStrictEqual([c.rated, c.result], [true, 'loss']);
	// The upheld claim adds to bob's record of abandonments; the refused one to nobody's.
	const { initializeApp: adminApp } = require('firebase-admin/app');
	const { getDatabaseWithUrl } = require('firebase-admin/database');
	const admin = getDatabaseWithUrl(`https://${NS}.firebaseio.com`, adminApp({ projectId: 'demo-sigil' }, 'abandons' + seq));
	const flags = async (u) => (await admin.ref('user_flags/' + u.uid + '/abandons').once('value')).val();
	assert.deepStrictEqual([await flags(bob), await flags(alice), await flags(carol), await flags(dave)], [1, null, null, null]);
	// Counted once per room: the same record rated again (a retried
	// event: the trigger's snapshot predates eloProcessed) adds nothing.
	assert.strictEqual((await admin.ref('user_flags/' + bob.uid + '/abandonedGames/' + code).once('value')).val(), true);
	const again = admin.ref('completed_games/' + gameId);
	const rec = (await again.once('value')).val();
	for (const k of Object.keys(rec)) if (/^elo|^unrated/.test(k)) delete rec[k];
	await again.remove();
	await again.set(rec);
	for (let i = 0; i < 40 && !(await again.child('eloProcessed').once('value')).val(); i++) await new Promise((r) => setTimeout(r, 500));
	assert.strictEqual((await again.child('eloProcessed').once('value')).val(), true);
	assert.strictEqual(await flags(bob), 1);
});

test('the server ends a game whose clock ran out with nobody watching', async () => {
	const { initializeApp: adminApp } = require('firebase-admin/app');
	const { getDatabaseWithUrl } = require('firebase-admin/database');
	const { expireRooms } = require('../rooms');
	const admin = getDatabaseWithUrl(`https://${NS}.firebaseio.com`, adminApp({ projectId: 'demo-sigil' }, 'admin' + seq));
	const alice = await player('alice');
	const bob = await player('bob');
	const code = await playRoom(alice, bob, 3, { type: 'realtime', initialTime: 3000, increment: 0 });
	// Blue is to move with three seconds on the clock.
	assert.strictEqual(await expireRooms(admin, Date.now()), 0);
	await new Promise((r) => setTimeout(r, 6000));
	assert.ok((await expireRooms(admin, Date.now())) >= 1);
	const gameId = await waitFor(alice.db, `rooms/${code}/gameId`);
	const room = (await get(ref(alice.db, 'rooms/' + code))).val();
	assert.deepStrictEqual([room.status, room.winner, room.endReason], ['finished', 'red', 'time']);
	// The server left the transcript for the review.
	assert.strictEqual((room.gameLog || []).length, 3);
	const mine = await waitFor(alice.db, `user_games/${alice.uid}/${gameId}`);
	assert.deepStrictEqual([mine.rated, mine.result], [true, 'win']);
});

test('a forged win against the AI is recorded unrated', async () => {
	const carol = await player('carol');
	const real = Object.assign({}, AI.N3WMQJ, { redUid: carol.uid, timestamp: Date.now() });
	const g1 = push(ref(carol.db, 'completed_games'));
	await set(g1, real);
	const ok = await waitFor(carol.db, `user_games/${carol.uid}/${g1.key}`);
	assert.deepStrictEqual([ok.rated, ok.result], [true, 'win']);

	const forged = Object.assign({}, AI.F6N5H4, { redUid: carol.uid, winner: 'red', timestamp: Date.now() });
	const g2 = push(ref(carol.db, 'completed_games'));
	await set(g2, forged);
	const bad = await waitFor(carol.db, `user_games/${carol.uid}/${g2.key}`);
	assert.deepStrictEqual([bad.rated, bad.unratedReason], [false, 'result-not-verified']);
	assert.strictEqual((await get(ref(carol.db, `users/${carol.uid}/elo`))).val(), 1000 + ok.eloChange);
});

test('deleting an account removes its records and keeps its games anonymous', async () => {
	const dave = await player('dave');
	const g = push(ref(dave.db, 'completed_games'));
	await set(g, Object.assign({}, AI.N3WMQJ, { redUid: dave.uid, timestamp: Date.now() }));
	await waitFor(dave.db, `user_games/${dave.uid}/${g.key}`);
	await set(ref(dave.db, `push_tokens/${dave.uid}/${"d".repeat(32)}`), { token: 'dave-laptop', created: serverTimestamp() });
	// Friends: Dave and Erin follow each other; Dave blocks Gus; Frank blocks Dave.
	const erin = await player('erin');
	const frank = await player('frank');
	const gus = await player('gus');
	const pair = (a, b) => ({ [`follows/${a}/${b}`]: true, [`followers/${b}/${a}`]: true });
	const blk = (a, b) => ({ [`blocks/${a}/${b}`]: true, [`blockedBy/${b}/${a}`]: true });
	await update(ref(dave.db), Object.assign(pair(dave.uid, erin.uid), blk(dave.uid, gus.uid)));
	await update(ref(erin.db), pair(erin.uid, dave.uid));
	await update(ref(frank.db), blk(frank.uid, dave.uid));
	// An admin's suspension and the server's abandonment record, and a
	// report Dave filed (its rate-limit stamp).
	{
		const { initializeApp: adminApp } = require('firebase-admin/app');
		const { getDatabaseWithUrl } = require('firebase-admin/database');
		const a = getDatabaseWithUrl(`https://${NS}.firebaseio.com`, adminApp({ projectId: 'demo-sigil' }, 'admin-flags' + seq));
		await a.ref('user_flags/' + dave.uid).set({ banUntil: Date.now() + 86400000, reason: 'x', abandons: 1, abandonedGames: { ABC234: true } });
		await a.ref('report_limits/' + dave.uid).set(Date.now());
		// Dave's puzzle rating, synced progress, Storm record and both public
		// puzzle boards.
		await a.ref('users/' + dave.uid).update({ puzzle: { rating: 1500, plays: 3 }, puzzleProgress: { solved: { p1: 1 } }, puzzleStorm: { best: 12, runs: 2 } });
		await a.ref('puzzle_leaderboard/' + dave.uid).set({ displayName: 'dave', rating: 1500, plays: 3 });
		await a.ref('storm_leaderboard/' + dave.uid).set({ displayName: 'dave', score: 12 });
	}
	const res = await httpsCallable(dave.fns, 'deleteUserData')();
	assert.deepStrictEqual(res.data, { ok: true });
	const other = erin;
	for (const p of ['users/', 'leaderboard/', 'user_games/']) {
		assert.strictEqual((await get(ref(other.db, p + dave.uid))).exists(), false, p);
	}
	// Push tokens go too (only the server can read them now).
	const { initializeApp: adminApp } = require('firebase-admin/app');
	const { getDatabaseWithUrl } = require('firebase-admin/database');
	const admin = getDatabaseWithUrl(`https://${NS}.firebaseio.com`, adminApp({ projectId: 'demo-sigil' }, 'admin-del' + seq));
	assert.strictEqual((await admin.ref('push_tokens/' + dave.uid).once('value')).exists(), false, 'push_tokens/');
	// No follow or block on either side still names the deleted account.
	for (const p of [`follows/${dave.uid}`, `followers/${dave.uid}`, `follows/${erin.uid}/${dave.uid}`, `followers/${erin.uid}/${dave.uid}`,
		`blocks/${dave.uid}`, `blockedBy/${gus.uid}/${dave.uid}`, `blocks/${frank.uid}/${dave.uid}`, `blockedBy/${dave.uid}`]) {
		assert.strictEqual((await admin.ref(p).once('value')).exists(), false, p);
	}
	for (const p of ['push_tokens/', 'user_flags/', 'report_limits/', 'users/', 'puzzle_leaderboard/', 'storm_leaderboard/']) {
		assert.strictEqual((await admin.ref(p + dave.uid).once('value')).exists(), false, p);
	}
});

test('a correspondence move is pushed to the player to move, from their own tokens', async () => {
	const { initializeApp: adminApp } = require('firebase-admin/app');
	const { getDatabaseWithUrl } = require('firebase-admin/database');
	const { notifyTurn } = require('../notify');
	const admin = getDatabaseWithUrl(`https://${NS}.firebaseio.com`, adminApp({ projectId: 'demo-sigil' }, 'admin-push' + seq));
	const alice = await player('alice');
	const bob = await player('bob');
	const carol = await player('carol');
	// What active-games.html writes when "Notify me" is turned on.
	const h = (c) => c.repeat(32);
	await set(ref(bob.db, `push_tokens/${bob.uid}/${h('b')}`), { token: 'bob-phone', created: serverTimestamp() });
	await set(ref(bob.db, `push_tokens/${bob.uid}/${h('c')}`), { token: 'bob-stale', created: serverTimestamp() });
	await set(ref(alice.db, `push_tokens/${alice.uid}/${h('a')}`), { token: 'alice-laptop', created: serverTimestamp() });
	await set(ref(carol.db, `push_tokens/${carol.uid}/${h('d')}`), { token: 'carol-spectating', created: serverTimestamp() });
	// Nobody else can read them.
	await assert.rejects(get(ref(alice.db, `push_tokens/${bob.uid}`)));

	const code = await playRoom(alice, bob, 1, { type: 'correspondence', moveTimeout: 86_400_000 });
	await push(ref(carol.db, `rooms/${code}/spectators`), { joined: serverTimestamp() });
	const turns = (await admin.ref(`rooms/${code}/turns`).once('value')).val();
	const turnId = Object.keys(turns)[0];
	const calls = [];
	const send = async (tokens, message) => {
		calls.push({ tokens, message });
		return tokens.map((t) => (t === 'bob-stale' ? { error: { code: 'messaging/registration-token-not-registered' } } : { success: true }));
	};
	const res = await notifyTurn(admin, code, turnId, Date.now(), send);
	assert.deepStrictEqual(res, { uid: bob.uid, sent: 1, removed: 1 });
	assert.deepStrictEqual(calls.map((c) => c.tokens.slice().sort()), [['bob-phone', 'bob-stale']]);
	assert.strictEqual(calls[0].message.data.room, code);
	assert.deepStrictEqual(Object.keys((await get(ref(bob.db, `push_tokens/${bob.uid}`))).val()), [h('b')]);

	// Bob replies: now alice is told, and only alice.
	await pushTurn(bob.db, code, 'blue', ['pass']);
	const all = (await admin.ref(`rooms/${code}/turns`).once('value')).val();
	const second = Object.keys(all).find((k) => k !== turnId);
	calls.length = 0;
	assert.strictEqual((await notifyTurn(admin, code, second, Date.now(), send)).uid, alice.uid);
	assert.deepStrictEqual(calls.map((c) => c.tokens), [['alice-laptop']]);
	// The first turn's event, arriving late, tells nobody.
	assert.strictEqual(await notifyTurn(admin, code, turnId, Date.now(), send), null);
});

test('a rated game is analysed by the server, and the eval cache is filled only by it', { timeout: 300000 }, async () => {
	const alice = await player('alice');
	const bob = await player('bob');
	const code = await playRoom(alice, bob);
	const fin = ONLINE.winner === 'red' ? alice : bob;
	await update(ref(fin.db, 'rooms/' + code), { gameLog: ONLINE.turns, finishedAt: Date.now() });
	await update(ref(fin.db, 'rooms/' + code), { finishedBy: ONLINE.winner, winner: ONLINE.winner, status: 'finished', closedAt: serverTimestamp() });
	const gameId = await waitFor(alice.db, `rooms/${code}/gameId`);
	assert.strictEqual((await waitFor(alice.db, `user_games/${alice.uid}/${gameId}`)).rated, true);
	// rateGame enqueues analyzeGame (the Cloud Tasks emulator), which runs
	// a chain of tasks and writes the review panel's document.
	const doc = await waitFor(alice.db, `game_evals/${code}`, 240000);
	assert.deepStrictEqual([doc.gameId, doc.roomCode, doc.preset, doc.plies], [gameId, code, 'server', ONLINE.turns.length]);
	assert.strictEqual(doc.moverPerPly.length, ONLINE.turns.length + 1);
	// A client cannot write the cache; the callable searches what it is given.
	const sfn = doc.finalSfn;
	await assert.rejects(set(ref(alice.db, 'position_evals/x'), { sfn, stones: 39 }));
	await assert.rejects(httpsCallable(alice.fns, 'evalPositions')({ sfns: new Array(11).fill(sfn) }));
	const res = await httpsCallable(alice.fns, 'evalPositions')({ sfns: ['not a position'] });
	assert.deepStrictEqual(res.data, { cached: 0, searched: 0, skipped: 1 });
	// The daily quota (200 positions an account) is charged only for positions
	// searched: 250 invalid ones cost nothing.
	for (let k = 0; k < 25; k++) {
		const r = await httpsCallable(alice.fns, 'evalPositions')({ sfns: Array.from({ length: 10 }, (_, j) => 'x' + k + '-' + j) });
		assert.strictEqual(r.data.skipped, 10);
	}
});

test.after(() => setTimeout(() => process.exit(0), 100));
