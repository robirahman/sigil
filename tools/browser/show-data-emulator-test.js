// What the online lobby and game show from data the site stores, on the
// Firebase emulators (no live database):
//   1. Rated / Casual badges: for a room code typed in the lobby (a guest
//      sees Casual, a signed-in player Rated), the creator's waiting room,
//      and the game header of both players.
//   2. The spectator count, shown to the players once a third page watches,
//      and not to the spectator.
//   3. After a forfeit, both signed-in players' game-over modal and log show
//      the rating change the rateGame function wrote; the spectator sees none.
//   4. The same for a Deathmatch room: Casual badges and "Unrated: ..." lines.
//      Its room is created straight after a reload, before Firebase has
//      restored the saved sign-in: the creator must keep their account.
//
//   (cd docs && python3 -m http.server 8765) &
//   cd functions && firebase emulators:exec --only auth,database,functions --project demo-sigil \
//     'node ../tools/browser/show-data-emulator-test.js http://localhost:8765'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';
const NS = 'sigil-js-default-rtdb';

// Point the page's Firebase at the emulators as soon as the app exists.
// emulators:exec sets the hosts; the defaults are firebase.json's ports.
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

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

// The service worker's cached CDN scripts race the emulator hook, and
// gstatic downloads flake: serve the Firebase SDK from memory (as
// online-emulator-test.js does).
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

async function preparePage(p) {
	await p.evaluateOnNewDocument(useEmulators, DB_HOST, AUTH_HOST);
	await p.setBypassServiceWorker(true);
	await p.setRequestInterception(true);
	p.on('request', (req) => {
		const url = req.url();
		if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
		sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }),
			() => req.continue());
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOBBY = '[x-data^="multiplayerLobby"]';
const BOARD = '[x-data^="gameBoard"]';

async function openLobby(p, query) {
	await p.goto(`${BASE}/multiplayer.html${query || ''}`, { waitUntil: 'load', timeout: 90000 });
	await p.waitForFunction((s) => { const el = document.querySelector(s); return !!(el && el._x_dataStack && el._x_dataStack[0].authReady); }, { timeout: 30000 }, LOBBY);
}

async function signIn(p, email) {
	// As account.html does: sign in, then write the profile.
	await p.evaluate(async (e) => {
		await _authManager.signInWithEmail(e, 'password123');
	}, email);
	await p.waitForFunction(async () => {
		const u = firebase.auth().currentUser;
		return !!(u && (await firebase.database().ref('users/' + u.uid + '/elo').once('value')).exists());
	}, { timeout: 30000, polling: 500 });
}

const lobbyVal = (p, expr) => p.evaluate((s, x) => {
	const L = document.querySelector(s)._x_dataStack[0];
	return JSON.parse(JSON.stringify(new Function('L', 'return ' + x)(L)) ?? 'null');
}, LOBBY, expr);
const boardVal = (p, expr) => p.evaluate((s, x) => {
	const el = document.querySelector(s);
	if (!el || !el._x_dataStack) return undefined;
	return JSON.parse(JSON.stringify(new Function('B', 'return ' + x)(el._x_dataStack[0])) ?? 'null');
}, BOARD, expr);
const text = (p, sel) => p.evaluate((s) => {
	const el = document.querySelector(s);
	if (!el) return null;
	const st = getComputedStyle(el);
	return st.display === 'none' || el.offsetParent === null ? null : el.textContent.replace(/\s+/g, ' ').trim();
}, sel);

async function waitPlaying(p) {
	try {
		await p.waitForFunction((s) => {
			const el = document.querySelector(s);
			return el && el._x_dataStack && el._x_dataStack[0].whoseTurn;
		}, { timeout: 60000 }, BOARD);
	} catch (e) {
		const L = await lobbyVal(p, '({ phase: L.phase, error: L.lobbyError })');
		const B = await boardVal(p, '({ engine: !!B._engine, whoseTurn: B.whoseTurn, log: B.messageHistory.slice(-3) })');
		throw new Error('game did not start: ' + JSON.stringify({ L, B }));
	}
}

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`http://${DB_HOST}/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());
	const stamp = Date.now();
	const emails = [`alice${stamp}@example.com`, `bob${stamp}@example.com`];
	for (const email of emails) {
		const r = await fetch('http://' + AUTH_HOST + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo',
			{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }) });
		if (r.status !== 200) throw new Error('signUp: ' + r.status + ' ' + await r.text());
	}

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	try {
		const pages = [];
		for (let i = 0; i < 3; i++) {
			const ctx = await browser.createBrowserContext();
			const p = await ctx.newPage();
			await preparePage(p);
			p.on('pageerror', (e) => console.log('pageerror (' + 'ABC'[i] + '):', e.message));
			pages.push(p);
		}
		const [pageA, pageB, pageC] = pages;

		// One rated game, then one Deathmatch game, between the same two accounts.
		for (const round of ['rated', 'deathmatch']) {
			const rated = round === 'rated';
			console.log('--- ' + round + ' room');
			await openLobby(pageA);
			if (rated) await signIn(pageA, emails[0]);
			if (!rated) await pageA.evaluate((s) => { document.querySelector(s)._x_dataStack[0].deathmatchVariant = true; }, LOBBY);
			await pageA.evaluate(async (s) => { await document.querySelector(s)._x_dataStack[0].createRoom(); }, LOBBY);
			await pageA.waitForFunction((s) => document.querySelector(s)._x_dataStack[0].phase === 'waiting', { timeout: 30000 }, LOBBY);
			const code = await lobbyVal(pageA, 'L.roomCode');
			await pageA.waitForFunction((s) => !!document.querySelector(s)._x_dataStack[0].waitingPreview, { timeout: 15000 }, LOBBY);
			const wait = await lobbyVal(pageA, 'L.waitingPreview');
			check('creator\'s waiting room: ' + (rated ? 'Rated if the opponent signs in' : 'Casual (Deathmatch)'),
				wait.ranked === rated && (rated || /Deathmatch/.test(wait.note)), wait);

			// A guest typing the code sees Casual.
			await openLobby(pageC);
			await pageC.type('.join-input', code);
			await pageC.waitForFunction((s) => !!document.querySelector(s)._x_dataStack[0].roomPreview, { timeout: 15000 }, LOBBY);
			const guestBadge = await text(pageC, '.lobby .room-preview');
			check('guest sees the typed room as Casual', /^Casual Unrated: both players need a signed-in account/.test(guestBadge || ''), guestBadge);

			// The signed-in joiner sees the verdict joinRoom will apply.
			await openLobby(pageB);
			if (rated) await signIn(pageB, emails[1]);
			await pageB.type('.join-input', code);
			await pageB.waitForFunction((s) => !!document.querySelector(s)._x_dataStack[0].roomPreview, { timeout: 15000 }, LOBBY);
			const joinBadge = await text(pageB, '.lobby .room-preview');
			check('signed-in joiner sees ' + (rated ? 'Rated' : 'Casual'),
				rated ? /^Rated /.test(joinBadge || '') : /^Casual Unrated: Deathmatch/.test(joinBadge || ''), joinBadge);
			await pageB.evaluate(async (s) => { await document.querySelector(s)._x_dataStack[0].joinRoom(); }, LOBBY);
			await waitPlaying(pageA);
			await waitPlaying(pageB);
			const room = await pageA.evaluate(async (c) => (await firebase.database().ref('rooms/' + c).once('value')).val(), code);
			check('room ranked flag', room.ranked === rated, room.ranked);
			for (const [n, p] of [['A', pageA], ['B', pageB]]) {
				const badge = await text(p, '.game-meta .rated-badge');
				check(`player ${n}'s header badge`, badge === (rated ? 'Rated' : 'Casual'), badge);
				check(`player ${n} sees no spectator count yet`, (await text(p, '.game-meta .spectator-count')) === null);
			}

			// A third page watches.
			await openLobby(pageC, '?id=' + code);
			await waitPlaying(pageC).catch(() => {});
			await pageC.waitForFunction((s) => { const el = document.querySelector(s); return el && el._x_dataStack && el._x_dataStack[0].isSpectator; }, { timeout: 30000 }, BOARD);
			for (const [n, p] of [['A', pageA], ['B', pageB]]) {
				await p.waitForFunction(() => {
					const el = document.querySelector('.game-meta .spectator-count');
					return el && el.offsetParent !== null;
				}, { timeout: 15000 }).catch(() => {});
				const count = await text(p, '.game-meta .spectator-count');
				const label = await p.evaluate(() => { const el = document.querySelector('.game-meta .spectator-count'); return el && el.getAttribute('aria-label'); });
				check(`player ${n} sees 1 spectator`, count === '\u{1F441} 1' && label === '1 spectator watching', { count, label });
			}
			check('the spectator sees no count', (await text(pageC, '.game-meta .spectator-count')) === null);
			check('the spectator sees the badge', (await text(pageC, '.game-meta .rated-badge')) === (rated ? 'Rated' : 'Casual'));

			// Red forfeits; both players wait for the server's rating.
			const redPage = (await boardVal(pageA, 'B.myColor')) === 'red' ? pageA : pageB;
			// The Forfeit button asks for a second click to confirm.
			await redPage.evaluate(() => { const b = document.querySelector('.action-button--forfeit'); b.click(); b.click(); });
			for (const [n, p] of [['A', pageA], ['B', pageB]]) {
				await p.waitForFunction((s) => !!document.querySelector(s)._x_dataStack[0].ratingText, { timeout: 90000 }, BOARD).catch(() => {});
				const line = await boardVal(p, 'B.ratingText');
				// Alpine shows the modal line on its next tick.
				await p.waitForFunction(() => { const el = document.querySelector('.win-modal__rating'); return el && getComputedStyle(el).display !== 'none'; }, { timeout: 5000 }).catch(() => {});
				const modal = await text(p, '.win-modal__rating');
				const logged = await boardVal(p, 'B.messageHistory.includes(B.ratingText)');
				const won = p !== redPage;
				const want = rated
					? new RegExp('^Rating: ' + (won ? '\\+' : '−') + '16 \\(1000 → ' + (won ? 1016 : 984) + '\\)$')
					: /^Unrated: Deathmatch games do not affect rating\.$/;
				check(`player ${n} (${won ? 'winner' : 'loser'}) modal and log show the rating line`, want.test(line || '') && modal === line && logged, { line, modal });
			}
			await sleep(1000);
			check('the spectator sees no rating line', !(await boardVal(pageC, 'B.ratingText'))
				&& !(await boardVal(pageC, 'B.messageHistory.some((m) => /^(Rating|Unrated):/.test(m))')));
		}
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'SHOW DATA EMULATOR TEST OK' : 'SHOW DATA EMULATOR TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
