// Online play under the locked-down rules, on the Firebase emulators (no
// live database): two guest pages create and join a room through the real
// lobby, then write turns as the site does.
//   1. Guests are signed in anonymously, so both seats carry a uid and the
//      room is unrated (anon seats).
//   2. Each player may push a turn only in their own colour.
//   3. A third page may watch but not move.
//   4. A resignation from the game screen finishes the room for the other side.
//
//   (cd docs && python3 -m http.server 8765) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/online-emulator-test.js http://localhost:8765'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';
const NS = 'sigil-js-default-rtdb';

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

const lobby = () => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0];

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`http://127.0.0.1:9000/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	try {
		const pages = [];
		for (let i = 0; i < 3; i++) {
			const ctx = await browser.createBrowserContext();
			const p = await ctx.newPage();
			await p.evaluateOnNewDocument(useEmulators);
			// The service worker's cached CDN scripts race the emulator hook,
			// and gstatic downloads flake here: serve the SDK from memory.
			await p.setBypassServiceWorker(true);
			await p.setRequestInterception(true);
			p.on('request', (req) => {
				const url = req.url();
				if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
				sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }),
					() => req.continue());
			});
			p.on('pageerror', (e) => console.log('pageerror:', e.message));
			p.on('requestfailed', (r) => console.log('requestfailed:', r.url(), r.failure() && r.failure().errorText));
			pages.push(p);
		}
		const [pageA, pageB, pageC] = pages;

		await pageA.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		await pageA.waitForFunction(() => !!document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack, { timeout: 30000 });
		await pageA.evaluate(async () => { await document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].createRoom(); });
		await pageA.waitForFunction(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].phase === 'waiting', { timeout: 30000 });
		const code = await pageA.evaluate(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].roomCode);
		check('guest creates a room', !!code, code);

		await pageB.goto(`${BASE}/multiplayer.html?id=${code}`, { waitUntil: 'load', timeout: 90000 });
		const room = async () => pageA.evaluate(async (c) => (await firebase.database().ref('rooms/' + c).once('value')).val(), code);
		let st = null;
		for (let i = 0; i < 60 && !(st && st.status === 'playing'); i++) {
			await new Promise((r) => setTimeout(r, 500));
			st = await room();
		}
		check('guest joins: both seats hold a uid, unrated', st.status === 'playing' && !!st.red.uid && !!st.blue.uid
			&& st.red.uid !== st.blue.uid && st.red.anon === true && st.blue.anon === true && st.ranked === false,
		{ status: st.status, red: st.red, blue: st.blue, ranked: st.ranked });

		const uidOf = async (p) => p.evaluate(() => firebase.auth().currentUser && firebase.auth().currentUser.uid);
		const colorOf = { [await uidOf(pageA)]: 'A', [await uidOf(pageB)]: 'B' };
		const redPage = colorOf[st.red.uid] === 'A' ? pageA : pageB;
		const bluePage = redPage === pageA ? pageB : pageA;
		const tryPush = (p, color) => p.evaluate(async (c, col) => {
			try {
				await firebase.database().ref('rooms/' + c + '/turns').push({ color: col, actions: ['pass'], timestamp: firebase.database.ServerValue.TIMESTAMP });
				return 'ok';
			} catch (e) { return e.code || e.message; }
		}, code, color);
		check('red may move as red', (await tryPush(redPage, 'red')) === 'ok');
		check('red may not move as blue', (await tryPush(redPage, 'blue')) !== 'ok');
		check('blue may move as blue', (await tryPush(bluePage, 'blue')) === 'ok');

		await pageC.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		await pageC.evaluate(async () => { await firebase.auth().signInAnonymously(); });
		check('a spectator may not move', (await tryPush(pageC, 'red')) !== 'ok');
		const spec = await pageC.evaluate(async (c) => {
			try { await firebase.database().ref('rooms/' + c + '/spectators').push({ joined: firebase.database.ServerValue.TIMESTAMP }); return 'ok'; } catch (e) { return e.code; }
		}, code);
		check('a spectator may register', spec === 'ok');
		const takeover = await pageC.evaluate(async (c) => {
			try { await firebase.database().ref('rooms/' + c + '/blue').set({ uid: firebase.auth().currentUser.uid, connected: true }); return 'ok'; } catch (e) { return e.code; }
		}, code);
		check('a spectator may not take a seat', takeover !== 'ok');

		// Red resigns through the game screen: the result goes in before the
		// status (the rules require winner and finishedBy to finish a room).
		// Alpine.$data: the merged proxy the component's own methods see
		// (sendEvent is attached in init, not declared as data).
		await redPage.waitForFunction(() => typeof Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).sendEvent === 'function', { timeout: 30000 });
		await redPage.evaluate(() => {
			const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			g.handleForfeit();
			g.handleForfeit();
		});
		let fin = null;
		for (let i = 0; i < 40 && !(fin && fin.status === 'finished'); i++) {
			await new Promise((r) => setTimeout(r, 500));
			fin = await room();
		}
		check('a forfeit finishes the room for blue', fin.status === 'finished' && fin.winner === 'blue'
			// Either client may close it: blue's sees the forfeit and finishes too.
			&& fin.forfeitedBy === 'red' && !!fin.finishedBy, { status: fin.status, winner: fin.winner, forfeitedBy: fin.forfeitedBy, finishedBy: fin.finishedBy });
		await bluePage.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).winner === 'blue', { timeout: 20000 })
			.then(() => check('blue\'s screen shows the win', true), () => check('blue\'s screen shows the win', false));
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'ONLINE EMULATOR TEST OK' : 'ONLINE EMULATOR TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
