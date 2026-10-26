// Fair play on the Firebase emulators (no live database):
//   1. A signed-in player reports another from their profile (profile.html
//      "Report this player"); the report lands in reports/ as filed.
//   2. A player who is not an admin sees no reports on admin.html.
//   3. An admin (admins/{uid}, seeded) sees the report on admin.html with the
//      target's abandonment count, suspends the target and resolves it.
//   4. The suspended player sees the suspension and its reason on account.html.
//   5. The online game-over modal offers "Report opponent" with the room.
//
//   (cd docs && python3 -m http.server 8801) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/fair-play-emulator-test.js http://localhost:8801'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8801';
const NS = 'sigil-js-default-rtdb';
// The emulators' addresses (firebase emulators:exec sets them), so a
// private emulator config with other ports works too.
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const DB = 'http://' + DB_HOST;
const OWNER = { Authorization: 'Bearer owner' };

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
	if (navigator.serviceWorker) navigator.serviceWorker.getRegistration = () => Promise.resolve(undefined);
}

// gstatic downloads flake here: serve the Firebase SDK from memory.
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
	const res = await (await fetch('http://' + AUTH_HOST + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }),
	})).json();
	if (!res.localId) throw new Error('sign-up failed: ' + JSON.stringify(res));
	return res.localId;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const stamp = Date.now();
	const emails = { alice: `fpa${stamp}@example.com`, bob: `fpb${stamp}@example.com`, root: `fpr${stamp}@example.com` };
	const uid = {};
	for (const k of Object.keys(emails)) uid[k] = await signUp(emails[k]);
	const profile = (name) => ({ displayName: name, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: stamp });
	await rest('PATCH', '', {
		['users/' + uid.alice]: profile('Alice'),
		['users/' + uid.bob]: profile('Bob'),
		['users/' + uid.root]: profile('Root'),
		['admins/' + uid.root]: true,
		// One upheld abandonment, as rateGame records it.
		['user_flags/' + uid.bob]: { abandons: 1 },
	});

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	const errors = [];

	// Each player in their own browser context (their own auth session).
	async function openAs(who, url) {
		const ctx = await browser.createBrowserContext();
		const page = await ctx.newPage();
		await page.setViewport({ width: 412, height: 860 });
		await page.evaluateOnNewDocument(useEmulators, DB_HOST, AUTH_HOST);
		await page.setBypassServiceWorker(true);
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const u = req.url();
			if (!u.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(u).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		page.on('pageerror', (e) => { errors.push(who + ': ' + e.message); console.log('pageerror (' + who + '):', e.message); });
		await page.goto(`${BASE}/${url}`, { waitUntil: 'load', timeout: 90000 });
		await page.waitForFunction(() => !!window.Alpine && !!window.firebase && firebase.apps.length > 0, { timeout: 30000, polling: 250 });
		await page.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), emails[who]);
		return page;
	}
	const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

	try {
		// 1. Alice reports Bob from his profile.
		const pa = await openAs('alice', 'profile.html?uid=' + uid.bob);
		await waitIn(pa, () => {
			const b = document.querySelector('[data-testid="report-player"]');
			return b && b.offsetParent !== null;
		});
		await pa.click('[data-testid="report-player"]');
		await waitIn(pa, () => document.querySelector('.report-dialog.is-visible'));
		await pa.select('#report-reason', 'cheating');
		await pa.type('#report-note', 'Moves came instantly, every one an engine move.');
		check('report dialog fits a phone', await noHScroll(pa));
		await pa.click('.report-dialog__btn--send');
		await waitIn(pa, () => document.querySelector('.report-dialog__msg--ok'));
		const reports = await rest('GET', 'reports');
		const list = Object.values(reports || {});
		check('the report is filed as written', list.length === 1 && list[0].by === uid.alice && list[0].target === uid.bob
			&& list[0].reason === 'cheating' && /engine move/.test(list[0].note) && typeof list[0].at === 'number', list);
		// Her own profile has no Report button.
		await pa.goto(`${BASE}/profile.html?uid=${uid.alice}`, { waitUntil: 'load' });
		await waitIn(pa, () => !!document.querySelector('.profile__name'));
		await wait(1500);
		check('no Report on your own profile', await pa.evaluate(() => {
			const b = document.querySelector('[data-testid="report-player"]');
			return !b || b.offsetParent === null;
		}));

		// 2. Alice is no admin.
		await pa.goto(`${BASE}/admin.html`, { waitUntil: 'load' });
		await waitIn(pa, () => {
			const d = document.querySelector('[data-testid="admin-denied"]');
			return d && d.offsetParent !== null;
		});
		check('a player who is not an admin is turned away', (await pa.$$('[data-testid="report-card"]')).length === 0);

		// 3. The admin suspends Bob and resolves the report.
		const pr = await openAs('root', 'admin.html');
		await waitIn(pr, () => document.querySelectorAll('[data-testid="report-card"]').length === 1);
		const card = await pr.evaluate(() => {
			const c = document.querySelector('[data-testid="report-card"]');
			return { target: c.querySelector('[data-testid="report-target"]').textContent, text: c.textContent.replace(/\s+/g, ' ') };
		});
		check('the admin sees the report, its note and the abandonment count', card.target === 'Bob'
			&& /engine move/.test(card.text) && /1 upheld abandonment\b/.test(card.text), card);
		check('admin page fits a phone', await noHScroll(pr));
		await pr.type('.report-card input[type="text"]', 'Engine use in game ABC234');
		await pr.click('[data-testid="ban"]');
		let flags = null;
		for (let i = 0; i < 40; i++) {
			flags = await rest('GET', 'user_flags/' + uid.bob);
			if (flags && flags.banUntil) break;
			await wait(250);
		}
		check('a 7-day suspension with its reason, keeping the count', flags && flags.banUntil > Date.now() + 6 * 86400000
			&& flags.banUntil < Date.now() + 8 * 86400000 && flags.reason === 'Engine use in game ABC234' && flags.abandons === 1 && flags.by === uid.root, flags);
		await waitIn(pr, () => /Suspended until/.test(document.querySelector('[data-testid="report-card"]').textContent));
		await pr.type('.report-card textarea', 'Suspended 7 days.');
		await pr.click('[data-testid="resolve"]');
		await waitIn(pr, () => document.querySelectorAll('[data-testid="report-card"]').length === 0);
		const rep = Object.values(await rest('GET', 'reports'))[0];
		check('the report is resolved with the admin note', rep.resolved === true && rep.adminNote === 'Suspended 7 days.' && rep.resolvedBy === uid.root, rep);

		// 4. Bob sees the suspension on his account page.
		const pb = await openAs('bob', 'account.html');
		await waitIn(pb, () => {
			const n = document.querySelector('[data-testid="ban-notice"]');
			return n && n.offsetParent !== null;
		});
		const notice = await pb.evaluate(() => document.querySelector('[data-testid="ban-notice"]').textContent.replace(/\s+/g, ' '));
		check('the suspended player sees the reason', /suspended from rated play/.test(notice) && /Engine use in game ABC234/.test(notice), notice);
		check('account page fits a phone', await noHScroll(pb));

		// 5. The game-over modal of an online game: "Report opponent" names the room.
		// The modal's state is set as the game screen sets it at the end of a game.
		const room = 'FPGAME';
		// Reports are one a minute per account (report_limits): Alice filed
		// one at step 1.
		await rest('DELETE', 'report_limits');
		await pa.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load' });
		// The game screen mounts when the lobby's phase turns to playing.
		await waitIn(pa, () => !!(document.querySelector('[x-data^="multiplayerLobby"]') || {})._x_dataStack);
		await pa.evaluate(() => { document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].phase = 'playing'; });
		await waitIn(pa, () => !!(document.querySelector('[x-data^="gameBoard"]') || {})._x_dataStack);
		await pa.evaluate((r, a, b) => {
			const d = document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0];
			Object.assign(d, { myColor: 'red', redUid: a, blueUid: b, redName: 'Alice', blueName: 'Bob', isSpectator: false, _roomCodeForReview: r, reviewMode: false, winner: 'blue' });
		}, room, uid.alice, uid.bob);
		// x-show on the button, and the modal itself shown for a winner.
		const shown = await pa.waitForFunction(() => {
			const b = document.querySelector('[data-testid="report-opponent"]');
			return b && getComputedStyle(b).display !== 'none' && b.closest('.win-modal').classList.contains('is-visible');
		}, { timeout: 45000, polling: 500 }).then(() => true, () => false);
		check('the game-over modal offers Report opponent', shown);
		if (shown) {
			await pa.evaluate(() => document.querySelector('[data-testid="report-opponent"]').click());
			await waitIn(pa, () => document.querySelector('.report-dialog.is-visible'));
			const title = await pa.evaluate(() => document.querySelector('.report-dialog__title').textContent);
			await pa.click('.report-dialog__btn--send');
			await waitIn(pa, () => document.querySelector('.report-dialog__msg--ok'));
			const all = Object.values(await rest('GET', 'reports'));
			check('a report from the game carries the room', title === 'Report Bob' && all.some((r) => r.room === room && r.target === uid.bob), { title, all });
		}
		check('no page errors', errors.length === 0, errors);
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'FAIR PLAY TEST OK' : 'FAIR PLAY TEST FAILED');
	process.exit(ok ? 0 : 1);
})();

function waitIn(page, fn) {
	return page.waitForFunction(fn, { timeout: 30000, polling: 250 });
}
