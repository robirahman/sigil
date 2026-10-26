// Online play under the locked-down rules, on the Firebase emulators (no
// live database): two guest pages create and join a room through the real
// lobby, then write turns as the site does.
//   1. Guests are signed in anonymously, so both seats carry a uid and the
//      room is unrated (anon seats).
//   2. Each player may push a turn only in their own colour.
//   3. A third page may watch but not move.
//   4. A resignation from the game screen finishes the room for the other side.
//   5. Through the game screen: a takeback by agreement; Abort until both have moved; the reconnecting
//      banner; a minute after the opponent leaves, Claim win finishes it.
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
// The emulators' addresses (firebase emulators:exec sets them), so a
// private emulator config with other ports works too.
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

// Point the page's Firebase at the emulators as soon as the app exists.
function useEmulators(dbHost, authHost) {
	let fb;
	Object.defineProperty(window, 'firebase', {
		configurable: true,
		get() { return fb; },
		set(v) {
			fb = v;
			const init = v.initializeApp.bind(v);
			v.initializeApp = (...args) => {
				const app = init(...args);
				app.auth().useEmulator('http://' + authHost, { disableWarnings: true });
				app.database().useEmulator(dbHost.split(':')[0], Number(dbHost.split(':')[1]));
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
	const put = await fetch(`http://${DB_HOST}/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	try {
		const pages = [];
		const contexts = [];
		for (let i = 0; i < 5; i++) {
			const ctx = await browser.createBrowserContext();
			contexts.push(ctx);
			const p = await ctx.newPage();
			await p.evaluateOnNewDocument(useEmulators, DB_HOST, AUTH_HOST);
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
		const [pageA, pageB, pageC, pageD, pageE] = pages;

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
				// As firebase-sync.js sendTurn writes it: after the room's last
				// turn, moving rooms/{id}/last on in the same write.
				const roomRef = firebase.database().ref('rooms/' + c);
				// From the server: this page's cache may not have the other
				// side's last turn yet.
				const last = (await roomRef.child('last').get()).val();
				const key = roomRef.child('turns').push().key;
				const turn = { color: col, actions: ['pass'], timestamp: firebase.database.ServerValue.TIMESTAMP };
				if (last) turn.after = last.key;
				await roomRef.update({ ['turns/' + key]: turn, last: { key, color: col } });
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

		// ---- A second game, played through the game screen: abort, the
		// reconnecting banner, and claiming the game when the opponent leaves.
		// (Interval polling: background tabs get no animation frames.)
		await pageD.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		await pageD.waitForFunction(() => !!document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack, { timeout: 30000, polling: 500 });
		await pageD.evaluate(async () => { await document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].createRoom(); });
		await pageD.waitForFunction(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].phase === 'waiting', { timeout: 30000, polling: 500 });
		const code2 = await pageD.evaluate(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].roomCode);
		await pageE.goto(`${BASE}/multiplayer.html?id=${code2}`, { waitUntil: 'load', timeout: 90000 });
		const board = () => Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
		const isReady = () => {
			const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			return typeof g.sendEvent === 'function' && !!g.whoseTurn;
		};
		const ready = async (p) => {
			for (let i = 0; i < 120; i++) {
				if (await p.evaluate(isReady).catch(() => false)) return;
				await new Promise((r) => setTimeout(r, 500));
			}
			throw new Error('game screen not ready');
		};
		const state = (p) => p.evaluate(() => {
			const el = document.querySelector('[x-data^="gameBoard"]');
			const l = document.querySelector('[x-data^="multiplayerLobby"]');
			const g = el && window.Alpine ? Alpine.$data(el) : null;
			return { phase: l && Alpine.$data(l).phase, err: l && Alpine.$data(l).lobbyError, send: g && typeof g.sendEvent, whoseTurn: g && g.whoseTurn, my: g && g.myColor, msgs: g && g.messageHistory.slice(-3) };
		});
		await ready(pageD).catch(async (e) => { console.log('debug D', JSON.stringify(await state(pageD))); throw e; });
		await ready(pageE).catch(async (e) => { console.log('debug E', JSON.stringify(await state(pageE))); throw e; });
		const st2 = await pageD.evaluate(async (c) => (await firebase.database().ref('rooms/' + c).once('value')).val(), code2);
		const redP = st2.red.uid === await uidOf(pageD) ? pageD : pageE;
		const blueP = redP === pageD ? pageE : pageD;
		const blueCtx = contexts[pages.indexOf(blueP)];
		check('abort is offered before anyone moves', await redP.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).canAbort));
		const play = async (p, node) => {
			await p.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).actionList.length > 0, { timeout: 30000, polling: 500 });
			await p.evaluate((n) => { const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]')); g.sendEvent(n); }, node);
			await p.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).actionList.includes('pass'), { timeout: 30000, polling: 500 });
			await p.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).handleEndTurn());
		};
		await play(redP, 'a2');
		await play(blueP, 'b11');
		// Both turns in place on both screens before asking.
		for (const p of [redP, blueP]) {
			await p.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).turnsPlayed() >= 2, { timeout: 30000, polling: 500 });
		}
		// Red asks to take back its turn (and blue's reply); blue accepts;
		// both pages rebuild from the room, back at the start.
		const roomOf = (c) => redP.evaluate(async (code) => (await firebase.database().ref('rooms/' + code).once('value')).val(), c);
		await redP.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).canRequestTakeback, { timeout: 30000, polling: 500 });
		await redP.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).handleTakebackRequest());
		await blueP.waitForFunction(() => {
			const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			return !!g.takebackRequest && !g.takebackMine;
		}, { timeout: 20000, polling: 500 })
			.then(() => check('blue is asked to accept the takeback', true), () => check('blue is asked to accept the takeback', false));
		// A turn written while the request stands is still the opponent's to remove only.
		const tbRoom = await roomOf(code2);
		const firstKey = Object.keys(tbRoom.turns)[0];
		// As red, but over REST: a refused remove from red's page would still
		// drop the turn locally first, and that local event reloads the page
		// (takeback_done) under the evaluate.
		const redToken = await redP.evaluate(() => firebase.auth().currentUser.getIdToken());
		const selfRemove = await fetch(`http://${DB_HOST}/rooms/${code2}/turns/${firstKey}.json?ns=${NS}&auth=${redToken}`,
			{ method: 'DELETE' }).then((r) => r.status);
		check('the requester cannot remove turns itself', selfRemove === 401 || selfRemove === 403, { status: selfRemove });
		check('the turns are still there', !!(await roomOf(code2)).turns[firstKey]);
		await Promise.all([
			redP.waitForNavigation({ timeout: 60000 }).catch(() => null),
			blueP.waitForNavigation({ timeout: 60000 }).catch(() => null),
			blueP.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).handleTakebackAccept()),
		]);
		await ready(redP);
		await ready(blueP);
		const afterTb = await roomOf(code2);
		check('takeback removes both turns', !afterTb.turns && !afterTb.takeback, { turns: afterTb.turns, takeback: afterTb.takeback });
		// The same opening again: the board is back at the start.
		await play(redP, 'a2');
		await play(blueP, 'b11');
		await redP.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).turnsPlayed() >= 2, { timeout: 30000, polling: 500 });
		check('no abort once both have moved', !(await redP.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).canAbort)));

		// Our own connection drops: the banner says so, and clears on return.
		await redP.evaluate(() => firebase.database().goOffline());
		await redP.waitForFunction(() => /Connection lost/.test(Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).syncBanner), { timeout: 15000, polling: 500 })
			.then(() => check('banner while offline', true), () => check('banner while offline', false));
		await redP.evaluate(() => firebase.database().goOnline());
		await redP.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).syncBanner === '', { timeout: 15000, polling: 500 })
			.then(() => check('banner clears on reconnect', true), () => check('banner clears on reconnect', false));
		const seatBack = await redP.evaluate(async (c) => (await firebase.database().ref('rooms/' + c + '/red').once('value')).val(), code2);
		check('seat marked present again', seatBack.connected === true && !seatBack.disconnectedAt, seatBack);

		// Blue leaves for good.
		await blueCtx.close();
		await redP.waitForFunction(() => /disconnected/.test(Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).opponentAwayText), { timeout: 20000, polling: 500 })
			.then(() => check('countdown shown when the opponent leaves', true), () => check('countdown shown when the opponent leaves', false));
		check('no claim during the grace period', !(await redP.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).canClaimWin)));
		await redP.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).canClaimWin, { timeout: 90000, polling: 1000 })
			.then(() => check('claim offered after a minute', true), () => check('claim offered after a minute', false));
		await redP.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).handleClaimWin());
		let fin2 = null;
		for (let i = 0; i < 40 && !(fin2 && fin2.status === 'finished'); i++) {
			await new Promise((r) => setTimeout(r, 500));
			fin2 = await redP.evaluate(async (c) => (await firebase.database().ref('rooms/' + c).once('value')).val(), code2);
		}
		check('the claim finishes the room', fin2.status === 'finished' && fin2.winner === 'red' && fin2.endReason === 'abandon'
			&& fin2.blue.connected === false && typeof fin2.blue.disconnectedAt === 'number', { status: fin2.status, winner: fin2.winner, endReason: fin2.endReason, blue: fin2.blue });
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'ONLINE EMULATOR TEST OK' : 'ONLINE EMULATOR TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
