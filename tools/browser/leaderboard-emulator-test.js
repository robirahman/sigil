// The leaderboard on the Firebase emulators (no live database), with 230
// seeded players: it loads only the top 200 ratings, marks provisional
// ratings (under 10 games) with "?", filters by name, and "Find me" scrolls
// to the signed-in player's row or, outside the top 200, shows their own
// entry from users/{uid}.
//
//   (cd docs && python3 -m http.server 8765) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/leaderboard-emulator-test.js http://localhost:8765'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';
const NS = 'sigil-js-default-rtdb';
const OWNER = { Authorization: 'Bearer owner' };

// emulators:exec sets the hosts; the defaults are firebase.json's ports.
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const DB = 'http://' + DB_HOST;

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

async function signUp(email) {
	const r = await fetch('http://' + AUTH_HOST + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo',
		{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }) });
	if (r.status !== 200) throw new Error('signUp: ' + r.status + ' ' + await r.text());
	return (await r.json()).localId;
}

const LB = '[x-data^="leaderboardPage"]';
const val = (p, expr) => p.evaluate((s, x) => new Function('L', 'return ' + x)(document.querySelector(s)._x_dataStack[0]), LB, expr);

async function openBoard(p) {
	await p.goto(`${BASE}/leaderboard.html`, { waitUntil: 'load', timeout: 90000 });
	await p.waitForFunction((s) => { const el = document.querySelector(s); return el && el._x_dataStack && !el._x_dataStack[0].loading; }, { timeout: 60000 }, LB);
}

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const stamp = Date.now();
	const inEmail = `ina${stamp}@example.com`, outEmail = `outa${stamp}@example.com`;
	const inUid = await signUp(inEmail);
	const outUid = await signUp(outEmail);
	const leaderboard = {};
	for (let i = 0; i < 230; i++) {
		// Odd ratings never tie with the AI seeds (1000 / 1200 / 1300).
		leaderboard['p' + String(i).padStart(3, '0')] = { displayName: 'Player ' + String(i).padStart(3, '0'), elo: 1001 + 2 * i, gamesPlayed: (i % 20) + 1 };
	}
	// Zero-game records at the very top: the page must skip them and still
	// show a full 200 played entries.
	for (let i = 0; i < 12; i++) leaderboard['z' + String(i).padStart(3, '0')] = { displayName: 'Idle ' + i, elo: 1601 + 2 * i, gamesPlayed: 0 };
	leaderboard[inUid] = { displayName: 'Insider', elo: 1250, gamesPlayed: 40 };
	leaderboard[outUid] = { displayName: 'Outsider', elo: 901, gamesPlayed: 4 };
	const users = {
		[inUid]: { displayName: 'Insider', elo: 1250, gamesPlayed: 40, wins: 20, losses: 20, created: 1 },
		[outUid]: { displayName: 'Outsider', elo: 901, gamesPlayed: 4, wins: 1, losses: 3, created: 1 },
	};
	for (const [k, v] of [['leaderboard', leaderboard], ['users', users]]) {
		const r = await fetch(`${DB}/${k}.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: JSON.stringify(v) });
		if (r.status !== 200) throw new Error('seed ' + k + ': ' + r.status);
	}

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	try {
		const ctx = await browser.createBrowserContext();
		const p = await ctx.newPage();
		await preparePage(p);
		p.on('pageerror', (e) => console.log('pageerror:', e.message));

		await openBoard(p);
		// What the page should show: the top 200 played entries by rating
		// (after its AI seeding); players with no games never take a slot.
		const all = await (await fetch(`${DB}/leaderboard.json?ns=${NS}`, { headers: OWNER })).json();
		const top = Object.entries(all).sort((a, b) => b[1].elo - a[1].elo).filter(([, v]) => (v.gamesPlayed || 0) > 0).slice(0, 200);
		const rows = await val(p, 'L.allPlayers.map((r) => [r.uid, r.rank])');
		check('loads the top 200 played ratings', Object.keys(all).length > 240 && rows.length === 200 && rows.length === top.length
			&& rows.every(([uid], i) => uid === top[i][0]), { loaded: rows.length, expected: top.length, total: Object.keys(all).length });
		check('ranks run 1..n', rows.every(([, r], i) => r === i + 1));
		check('no Find me for a guest', !(await val(p, 'L.myUid')));

		const marks = await p.evaluate(() => [...document.querySelectorAll('.leaderboard-table tbody tr')].map((tr) => ({
			games: Number(tr.children[3].textContent), mark: !!tr.querySelector('.provisional'),
			title: tr.querySelector('.provisional') && tr.querySelector('.provisional').title,
		})));
		check('"?" marks exactly the ratings under 10 games', marks.length > 0 && marks.some((m) => m.mark) && marks.some((m) => !m.mark)
			&& marks.every((m) => m.mark === (m.games < 10)), marks.slice(0, 3));
		check('the marker explains itself', marks.filter((m) => m.mark).every((m) => /Provisional: fewer than 10 rated games/.test(m.title)));

		await p.type('.leaderboard-search', 'player 22');
		await new Promise((r) => setTimeout(r, 300));
		const found = await p.evaluate(() => [...document.querySelectorAll('.leaderboard-table tbody tr')].map((tr) => tr.children[1].textContent.trim()));
		const wantFound = top.filter(([, v]) => /player 22/i.test(v.displayName)).map(([, v]) => v.displayName);
		check('search filters the loaded rows by name', found.length === wantFound.length && found.length > 0
			&& found.every((n) => /Player 22/.test(n)), found);

		// Signed in, inside the top 200.
		await p.evaluate(async (e) => { await firebase.auth().signInWithEmailAndPassword(e, 'password123'); }, inEmail);
		await openBoard(p);
		check('Find me shown when signed in', (await val(p, 'L.myUid')) === inUid);
		await p.evaluate((s) => document.querySelector(s)._x_dataStack[0].findMe(), LB);
		await new Promise((r) => setTimeout(r, 1200));
		const me = await p.evaluate((u) => {
			const tr = document.getElementById('lb-row-' + u);
			if (!tr) return null;
			const r = tr.getBoundingClientRect();
			return { cls: tr.className, rank: tr.children[0].textContent, inView: r.top >= 0 && r.bottom <= innerHeight };
		}, inUid);
		const wantRank = top.findIndex(([uid]) => uid === inUid) + 1;
		check('Find me scrolls to and highlights my row', !!me && /is-me/.test(me.cls) && me.inView && Number(me.rank) === wantRank, me);

		// Signed in, outside the top 200.
		await p.evaluate(async (e) => { await firebase.auth().signOut(); await firebase.auth().signInWithEmailAndPassword(e, 'password123'); }, outEmail);
		await openBoard(p);
		await p.evaluate((s) => document.querySelector(s)._x_dataStack[0].findMe(), LB);
		await p.waitForFunction(() => { const el = document.querySelector('.my-entry'); return el && el.offsetParent !== null; }, { timeout: 15000 }).catch(() => {});
		const entry = await p.evaluate(() => { const el = document.querySelector('.my-entry'); return el && el.offsetParent !== null ? el.textContent.replace(/\s+/g, ' ').trim() : null; });
		check('Find me outside the top shows my own entry, without a rank', /^Outsider: 901\?? \(4 games\) Not in the top 200\.$/.test(entry || ''), entry);
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'LEADERBOARD EMULATOR TEST OK' : 'LEADERBOARD EMULATOR TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
