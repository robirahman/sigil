// Friends, challenges and blocking on the Firebase emulators (no live
// database), with two signed-in players in separate browser contexts:
//   1. Alice follows Bob from his profile (both halves of the follow land;
//      his follower count goes up); a guest sees no Follow/Challenge buttons.
//   2. Bob has a tab open: Alice's friends list (active-games.html) shows him
//      online.
//   3. Alice challenges Bob from his profile through the lobby's create form:
//      a private room that invites him, and challenges/{bob}/{room}.
//   4. Bob sees the challenge banner on another page, accepts, and the game
//      starts on both pages; the challenge is cleared.
//   5. Bob blocks Alice: her challenge is refused (and leaves no room), the
//      Challenge button is gone from his profile, and his open game is hidden
//      from her lobby while a third player's stays listed.
//
//   (cd docs && python3 -m http.server 8805) &
//   cd functions && firebase emulators:exec --only auth,database,functions --project demo-sigil \
//     'node ../tools/browser/friends-emulator-test.js http://localhost:8805'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8805';
const NS = 'sigil-js-default-rtdb';
const DB = 'http://127.0.0.1:9000';
const OWNER = { Authorization: 'Bearer owner' };

// Point the page's Firebase at the emulators as soon as the app exists.
function useEmulators() {
	let fb;
	Object.defineProperty(window, 'firebase', {
		configurable: true,
		get() { return fb; },
		set(v) {
			fb = v;
			const init = v.initializeApp.bind(v);
			v.initializeApp = (...args) => {
				const app = init(...args);
				app.auth().useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
				app.database().useEmulator('127.0.0.1', 9000);
				return app;
			};
		},
	});
}

const _sdk = new Map();
async function sdk(url) {
	for (let i = 0; !_sdk.has(url) && i < 5; i++) {
		try {
			const r = await fetch(url);
			if (r.ok) _sdk.set(url, await r.text());
		} catch (e) { /* retry */ }
	}
	if (!_sdk.has(url)) throw new Error('could not fetch ' + url);
	return _sdk.get(url);
}

async function rest(method, p, body) {
	const r = await fetch(`${DB}/${p}.json?ns=${NS}`, { method, headers: OWNER, body: body === undefined ? undefined : JSON.stringify(body) });
	if (!r.ok) throw new Error(method + ' ' + p + ': ' + r.status + ' ' + await r.text());
	return r.json();
}

async function signUp(email) {
	const res = await (await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }),
	})).json();
	if (!res.localId) throw new Error('sign-up failed: ' + JSON.stringify(res));
	return res.localId;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lobby = () => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]'));

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const stamp = Date.now();
	const emailA = `fa${stamp}@example.com`, emailB = `fb${stamp}@example.com`;
	const alice = await signUp(emailA);
	const bob = await signUp(emailB);
	const carol = 'carol_' + stamp;
	const prof = (name) => ({ displayName: name, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: stamp });
	await rest('PATCH', '', { ['users/' + alice]: prof('Alice'), ['users/' + bob]: prof('Bob'), ['users/' + carol]: prof('Carol') });

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	const until = async (fn, ms) => {
		let v;
		for (let t = 0; t < (ms || 20000); t += 250) {
			v = await fn();
			if (v) return v;
			await sleep(250);
		}
		return v;
	};
	try {
		const newPage = async () => {
			const ctx = await browser.createBrowserContext();
			const p = await ctx.newPage();
			await p.evaluateOnNewDocument(useEmulators);
			await p.setBypassServiceWorker(true);
			await p.setRequestInterception(true);
			p.on('request', (req) => {
				const url = req.url();
				if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
				sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
			});
			p.on('pageerror', (e) => console.log('pageerror:', e.message));
			p.on('dialog', (d) => d.accept());
			return p;
		};
		const signIn = async (p, email) => {
			await p.waitForFunction(() => typeof firebase !== 'undefined' && firebase.apps.length > 0, { timeout: 30000 });
			await p.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), email);
			await p.waitForFunction(() => window.SigilFriends && SigilFriends.uid, { timeout: 30000 });
		};
		const pageA = await newPage();
		const pageB = await newPage();
		const pageG = await newPage();

		// ---- 1. Follow ----
		await pageA.goto(`${BASE}/profile.html?uid=${bob}`, { waitUntil: 'load', timeout: 90000 });
		await signIn(pageA, emailA);
		await pageA.waitForSelector('.profile__follow', { visible: true, timeout: 30000 });
		check('profile shows Follow and Challenge', await pageA.evaluate(() =>
			document.querySelector('.profile__follow').textContent.trim() === 'Follow'
			&& getComputedStyle(document.querySelector('.profile__challenge')).display !== 'none'));
		await pageA.click('.profile__follow');
		await pageA.waitForFunction(() => document.querySelector('.profile__follow').textContent.trim() === 'Unfollow', { timeout: 15000 });
		const f = await rest('GET', '');
		check('follow writes both halves', f.follows && f.follows[alice] && f.follows[alice][bob] === true
			&& f.followers && f.followers[bob] && f.followers[bob][alice] === true);
		check('follower count shows', await until(() => pageA.evaluate(() => document.querySelector('.profile__followers').textContent === '1 follower')));

		// A guest sees no social buttons.
		await pageG.goto(`${BASE}/profile.html?uid=${bob}`, { waitUntil: 'load', timeout: 90000 });
		await pageG.waitForFunction(() => typeof firebase !== 'undefined' && firebase.apps.length > 0, { timeout: 30000 });
		await pageG.evaluate(() => firebase.auth().signInAnonymously());
		await pageG.waitForSelector('.profile__followers', { timeout: 30000 });
		await sleep(1500);
		check('a guest gets no Follow / Challenge / Block', await pageG.evaluate(() =>
			!document.querySelector('.profile__follow') && !document.querySelector('.profile__challenge') && !document.querySelector('.profile__block')));

		// ---- 2. Online status in the friends list ----
		await pageB.goto(`${BASE}/active-games.html`, { waitUntil: 'load', timeout: 90000 });
		await signIn(pageB, emailB);
		await pageA.goto(`${BASE}/active-games.html`, { waitUntil: 'load', timeout: 90000 });
		await signIn(pageA, emailA);
		const online = await until(() => pageA.evaluate((b) => {
			const row = document.querySelector('.friend-row[data-uid="' + b + '"]');
			return row && row.querySelector('.friend-row__status').textContent.trim() === 'Online' ? row.textContent.replace(/\s+/g, ' ').trim() : null;
		}, bob));
		check('friends list shows Bob online', !!online && /Bob/.test(online), online);

		// ---- 3. Challenge from the profile ----
		await pageA.goto(`${BASE}/profile.html?uid=${bob}`, { waitUntil: 'load', timeout: 90000 });
		await pageA.waitForSelector('.profile__challenge', { visible: true, timeout: 30000 });
		await Promise.all([pageA.waitForNavigation({ waitUntil: 'load', timeout: 90000 }), pageA.click('.profile__challenge')]);
		await pageA.waitForFunction(() => {
			const l = document.querySelector('[x-data^="multiplayerLobby"]');
			return l && window.Alpine && Alpine.$data(l).challengeTarget;
		}, { timeout: 30000 });
		const setup = await pageA.evaluate(() => {
			const btn = Array.from(document.querySelectorAll('.lobby button.lobby-button')).find((b) => /Send Challenge/.test(b.textContent));
			return { box: document.querySelector('.challenge-setup').textContent.replace(/\s+/g, ' ').trim(), btn: btn && btn.textContent };
		});
		check('the lobby form is set up to challenge Bob', /Challenging Bob/.test(setup.box) && setup.btn === 'Send Challenge to Bob', setup);
		await pageA.evaluate(() => Array.from(document.querySelectorAll('.lobby button.lobby-button')).find((b) => /Send Challenge/.test(b.textContent)).click());
		await pageA.waitForFunction((l) => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).phase === 'waiting', { timeout: 30000 });
		const code = await pageA.evaluate(() => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).roomCode);
		const room0 = await rest('GET', 'rooms/' + code);
		const ch = await rest('GET', 'challenges/' + bob + '/' + code);
		check('a private room that invites Bob', room0 && room0.invite === bob && room0.public !== true && room0.status === 'waiting', room0 && { invite: room0.invite, public: room0.public });
		check('the challenge is recorded', ch && ch.from === alice && typeof ch.at === 'number', ch);

		// ---- 4. Bob's banner, accept, the game starts ----
		const banner = await until(() => pageB.evaluate((c) => {
			const el = document.querySelector('.challenge-banner__item[data-room="' + c + '"]');
			return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
		}, code));
		check('Bob sees the challenge banner', !!banner && /Alice challenges you/.test(banner), banner);
		await Promise.all([
			pageB.waitForNavigation({ waitUntil: 'load', timeout: 90000 }),
			pageB.click('.challenge-banner__item[data-room="' + code + '"] .challenge-banner__accept'),
		]);
		const started = await until(async () => {
			const r = await rest('GET', 'rooms/' + code);
			return r && r.status === 'playing' ? r : null;
		}, 30000);
		const seats = started ? [started.red.uid, started.blue.uid].sort() : [];
		check('accepting joins the room: Alice v Bob', !!started && JSON.stringify(seats) === JSON.stringify([alice, bob].sort()), started && { status: started.status });
		const phases = await until(async () => {
			const a = await pageA.evaluate(() => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).phase);
			const b = await pageB.evaluate(() => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).phase);
			return a === 'playing' && b === 'playing' ? [a, b] : null;
		}, 30000);
		check('the game starts on both pages', !!phases, phases);
		check('the accepted challenge is cleared', await until(async () => (await rest('GET', 'challenges/' + bob + '/' + code)) === null));
		check('no banner left for Bob', await pageB.evaluate(() => !document.querySelector('.challenge-banner')));

		// ---- 5. Blocking ----
		await pageB.goto(`${BASE}/profile.html?uid=${alice}`, { waitUntil: 'load', timeout: 90000 });
		await pageB.waitForSelector('.profile__block', { visible: true, timeout: 30000 });
		await pageB.click('.profile__block');
		await pageB.waitForFunction(() => document.querySelector('.profile__block').textContent.trim() === 'Unblock', { timeout: 15000 });
		check('block recorded', (await rest('GET', 'blocks/' + bob + '/' + alice)) === true);

		await pageA.goto(`${BASE}/profile.html?uid=${bob}`, { waitUntil: 'load', timeout: 90000 });
		await pageA.waitForSelector('.profile__block', { visible: true, timeout: 30000 });
		await sleep(500);
		check('no Challenge or Follow on the blocker\'s profile', await pageA.evaluate(() =>
			getComputedStyle(document.querySelector('.profile__challenge')).display === 'none'
			&& getComputedStyle(document.querySelector('.profile__follow')).display === 'none'));

		// The lobby path anyway (an old link): refused, and no room is left.
		await pageA.goto(`${BASE}/multiplayer.html?challenge=${bob}`, { waitUntil: 'load', timeout: 90000 });
		await pageA.waitForFunction(() => {
			const l = document.querySelector('[x-data^="multiplayerLobby"]');
			return l && window.Alpine && Alpine.$data(l).challengeTarget;
		}, { timeout: 30000 });
		const before = Object.keys((await rest('GET', 'rooms')) || {}).length;
		await pageA.evaluate(() => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).createRoom());
		const refused = await pageA.evaluate(() => {
			const l = Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]'));
			return { phase: l.phase, error: l.lobbyError };
		});
		const after = Object.keys((await rest('GET', 'rooms')) || {}).length;
		const pending = await rest('GET', 'challenges/' + bob);
		check('a blocked player\'s challenge is refused', refused.phase === 'lobby' && /Could not challenge Bob/.test(refused.error) && !pending, { refused, pending });
		check('... and leaves no room behind', after === before, { before, after });

		// Bob's open game is hidden from Alice; Carol's is listed.
		const seek = (uid, name, created) => ({ status: 'waiting', created, ranked: false, variant: 'standard', spellNames: ['a'],
			timeControl: { type: 'none' }, public: true, creatorColor: 'red', allowSpectators: true,
			red: { uid, displayName: name, connected: true }, blue: { connected: false } });
		await rest('PATCH', '', { 'rooms/BOBSEK': seek(bob, 'Bob', Date.now()), 'rooms/CARSEK': seek(carol, 'Carol', Date.now()),
			'open_rooms/BOBSEK': true, 'open_rooms/CARSEK': true });
		await pageA.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		const listed = await until(() => pageA.evaluate(() => {
			const codes = Array.from(document.querySelectorAll('.lobby-list--open .lobby-game')).map((e) => e.dataset.code);
			return codes.includes('CARSEK') ? codes : null;
		}), 30000);
		await sleep(1500);
		const listed2 = await pageA.evaluate(() => Array.from(document.querySelectorAll('.lobby-list--open .lobby-game')).map((e) => e.dataset.code));
		check('the blocker\'s open game is hidden; others stay', !!listed && listed2.includes('CARSEK') && !listed2.includes('BOBSEK'), listed2);
		// And the seat itself is refused (quick pair, a typed code).
		const seat = await pageA.evaluate(async (uid) => {
			try {
				await firebase.database().ref('rooms/BOBSEK').update({ blue: { uid, displayName: 'Alice', connected: true }, status: 'playing', ranked: false });
				return 'ok';
			} catch (e) { return e.code || e.message; }
		}, alice);
		check('the blocked player cannot take the seat', seat !== 'ok', seat);
	} catch (e) {
		console.log('FAIL exception', e.stack || e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'FRIENDS TEST OK' : 'FRIENDS TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
