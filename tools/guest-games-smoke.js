// Headless check of guest-game uploads in offline-queue.js: games played
// against the AI while not signed in are queued as guest games and uploaded
// under an anonymous session; rated games stay queued until a real sign-in.
//
//   node tools/guest-games-smoke.js
'use strict';
const fs = require('fs');
const path = require('path');

const store = {};
global.localStorage = {
	getItem: (k) => (k in store ? store[k] : null),
	setItem: (k, v) => { store[k] = String(v); },
};
global.navigator = { onLine: true };
const listeners = [];
global.window = { addEventListener: () => {} };

let currentUser = null;
const pushed = [];
const auth = {
	get currentUser() { return currentUser; },
	async signInAnonymously() {
		currentUser = { uid: 'anon123', isAnonymous: true };
		listeners.forEach((f) => f(currentUser));
		return { user: currentUser };
	},
	onAuthStateChanged(f) { listeners.push(f); },
};
const db = {
	ref(p) {
		return {
			async set() {},
			async once() { return { exists: () => true }; },
			async push(v) { pushed.push({ path: p, v }); return { key: 'k' + pushed.length }; },
		};
	},
};
global.firebase = { apps: [1], auth: () => auth, database: () => db };
let eloCalls = 0;
global.processEloClientSide = async () => { eloCalls++; return null; };

eval(fs.readFileSync(path.join(__dirname, '..', 'docs', 'static', 'scripts', 'offline-queue.js'), 'utf8'));
const Q = window.OfflineGameQueue;

function check(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } }

(async () => {
	Q.enqueue({ gameRecord: { winner: 'red', timestamp: 1, ranked: true }, aiUid: '__ai_rust__', aiName: 'AI (Rust)' });
	Q.enqueue({ gameRecord: { winner: 'blue', timestamp: 2, ranked: false, guest: true }, aiUid: '__ai_rust__', aiName: 'AI (Rust)', guest: true });
	check(Q.hasGuestGames(), 'guest game detected');

	// Signed out: autoflush signs in anonymously, then uploads ONLY the guest game.
	Q.installAutoflush({});
	await new Promise((r) => setTimeout(r, 20));
	check(currentUser && currentUser.isAnonymous, 'anonymous session started');
	check(pushed.length === 1 && pushed[0].v.guest === true, 'only the guest game uploaded: ' + JSON.stringify(pushed));
	check(eloCalls === 0, 'no Elo for guest games');
	check(Q.count() === 1 && !Q.hasGuestGames(), 'rated game still queued');

	// A real sign-in later uploads the rated game (with Elo).
	currentUser = { uid: 'real', isAnonymous: false };
	const res = await Q.flushAll(db, processEloClientSide);
	check(res.uploaded === 1 && eloCalls === 1 && Q.count() === 0, 'rated game uploads after sign-in');
	console.log('guest games smoke OK');
})().catch((e) => { console.error(e); process.exit(1); });
