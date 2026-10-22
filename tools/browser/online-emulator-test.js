// Online play under the locked-down rules, on the Firebase emulators (no
// live database): two guest pages create and join a room through the real
// lobby, then write turns as the site does.
//   1. Guests are signed in anonymously, so both seats carry a uid and the
//      room is unrated (anon seats).
//   2. Each player may push a turn only in their own colour.
//   3. A third page may watch but not move.
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
			p.on('pageerror', (e) => console.log('pageerror:', e.message));
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
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'ONLINE EMULATOR TEST OK' : 'ONLINE EMULATOR TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
