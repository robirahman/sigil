'use strict';
// The rules and the rateGame function together, on the emulators, through
// the same client SDK calls the site makes:
//   cd functions && npm run test:e2e

const test = require('node:test');
const assert = require('node:assert');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } = require('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');
const { getDatabase, connectDatabaseEmulator, ref, set, update, push, get, onValue, serverTimestamp } = require('firebase/database');
const ONLINE = require('./online-game.json');
const AI = require('./ai-games.json');

const NS = 'sigil-js-default-rtdb';
let seq = 0;

// The emulator applies firebase.json's rules to the project's default
// namespace only; load them into the production instance's name.
test.before(async () => {
	const rules = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const res = await fetch(`http://127.0.0.1:9000/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	assert.strictEqual(res.status, 200, await res.text());
});

async function player(name) {
	const app = initializeApp({ projectId: 'demo-sigil', apiKey: 'demo', databaseURL: `http://127.0.0.1:9000?ns=${NS}` }, name + ++seq);
	const auth = getAuth(app);
	connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
	const db = getDatabase(app);
	connectDatabaseEmulator(db, '127.0.0.1', 9000);
	const cred = await createUserWithEmailAndPassword(auth, `${name}${seq}@example.com`, 'password123');
	const uid = cred.user.uid;
	// What auth-manager.js ensureUserProfile writes for a new account.
	await set(ref(db, 'users/' + uid), { displayName: name, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: Date.now() });
	await set(ref(db, 'leaderboard/' + uid), { displayName: name, elo: 1000, gamesPlayed: 0 });
	const fns = getFunctions(app, 'us-central1');
	connectFunctionsEmulator(fns, '127.0.0.1', 5001);
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

test('an online game is rated once, by the server', async () => {
	const alice = await player('alice');
	const bob = await player('bob');
	const code = 'E2E' + seq;
	await set(ref(alice.db, 'rooms/' + code), {
		spellNames: ONLINE.spellNames, status: 'waiting', created: Date.now(), ranked: false,
		red: { uid: alice.uid, displayName: 'alice', connected: true }, blue: { connected: false },
		timeControl: { type: 'none' }, allowSpectators: true, variant: 'standard',
	});
	await update(ref(bob.db, 'rooms/' + code), {
		blue: { uid: bob.uid, displayName: 'bob', connected: true }, status: 'playing', ranked: true,
	});
	for (const t of ONLINE.turns) {
		const p = t.color === 'red' ? alice : bob;
		await push(ref(p.db, 'rooms/' + code + '/turns'), { color: t.color, actions: t.actions, timestamp: serverTimestamp() });
	}
	// A client may not rate it itself.
	await assert.rejects(set(ref(alice.db, 'users/' + alice.uid + '/elo'), 1016));
	await update(ref(alice.db, 'rooms/' + code), { status: 'finished', winner: ONLINE.winner, gameLog: ONLINE.turns, finishedAt: Date.now() });
	const record = { spellNames: ONLINE.spellNames, winner: ONLINE.winner, redUid: alice.uid, blueUid: bob.uid,
		ranked: true, variant: 'standard', roomCode: code, timestamp: Date.now(), turns: ONLINE.turns, endReason: 'play' };
	const g1 = push(ref(alice.db, 'completed_games'));
	await set(g1, record);
	const mine = await waitFor(alice.db, `user_games/${alice.uid}/${g1.key}`);
	const won = ONLINE.winner === 'red';
	assert.deepStrictEqual([mine.rated, mine.eloChange, mine.result], [true, won ? 16 : -16, won ? 'win' : 'loss']);
	assert.strictEqual((await get(ref(bob.db, `users/${bob.uid}/elo`))).val(), won ? 984 : 1016);
	assert.strictEqual((await get(ref(bob.db, `leaderboard/${alice.uid}/gamesPlayed`))).val(), 1);

	// Blue recording the same game too changes nothing.
	const g2 = push(ref(bob.db, 'completed_games'));
	await set(g2, Object.assign({}, record, { timestamp: Date.now() }));
	const dup = await waitFor(bob.db, `user_games/${bob.uid}/${g2.key}`);
	assert.deepStrictEqual([dup.rated, dup.unratedReason], [false, 'duplicate']);
	assert.strictEqual((await get(ref(bob.db, `users/${bob.uid}/elo`))).val(), won ? 984 : 1016);
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
	const res = await httpsCallable(dave.fns, 'deleteUserData')();
	assert.deepStrictEqual(res.data, { ok: true });
	const other = await player('erin');
	for (const p of ['users/', 'leaderboard/', 'user_games/']) {
		assert.strictEqual((await get(ref(other.db, p + dave.uid))).exists(), false, p);
	}
});

test.after(() => setTimeout(() => process.exit(0), 100));
