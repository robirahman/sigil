// active-games.html on the Firebase emulators (no live database): rooms and
// user_active_games are seeded through the admin REST API, a signed-in email
// user opens the page, and the test checks
//   1. "Your move" lists the games where it is your move, least time left
//      first, with the clock from the turns' server timestamps;
//   2. "Waiting for opponent" holds the rest (their move, open invites);
//   3. the header badge reads "Your move (N)";
//   4. the push toggle shows exactly when FCM_VAPID_KEY is set and the browser can push;
//   5. a move by the opponent in a correspondence game raises an in-tab
//      notification (permission granted) and the badge goes up.
//
//   (cd docs && python3 -m http.server 8931) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/active-games-emulator-test.js http://localhost:8931'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8931';
const NS = 'sigil-js-default-rtdb';
const DB = 'http://127.0.0.1:9000';
const OWNER = { Authorization: 'Bearer owner' };

// Point the page's Firebase at the emulators as soon as the app exists, and
// record notifications instead of showing them.
function pageHooks() {
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
	window.__notes = [];
	class FakeNotification {
		constructor(title, opts) { window.__notes.push({ title, tag: opts && opts.tag, url: opts && opts.data && opts.data.url }); }
		static requestPermission() { return Promise.resolve('granted'); }
	}
	FakeNotification.permission = 'granted';
	window.Notification = FakeNotification;
	if (navigator.serviceWorker) navigator.serviceWorker.getRegistration = () => Promise.resolve(undefined);
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

const H = 3600_000;
const DAY = 24 * H;

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const email = `ag${Date.now()}@example.com`;
	const signUp = await (await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }),
	})).json();
	const me = signUp.localId;
	if (!me) throw new Error('sign-up failed: ' + JSON.stringify(signUp));

	const now = Date.now();
	const seat = (uid, name) => ({ uid, displayName: name, connected: false });
	const turn = (color, ts) => ({ color, actions: ['pass'], timestamp: ts });
	const playing = (myColor, tc, turns, opp) => ({
		status: 'playing', created: now - 2 * DAY, ranked: false, variant: 'standard', spellNames: ['a'],
		timeControl: tc, turns,
		[myColor]: seat(me, 'Me'), [myColor === 'red' ? 'blue' : 'red']: seat('opp_' + opp, opp),
	});
	const corr = (d) => ({ type: 'correspondence', moveTimeout: d * DAY });
	const rooms = {
		// My move, about 4 h left of a day.
		AGCORA: playing('red', corr(1), { t1: turn('red', now - 30 * H), t2: turn('blue', now - 20 * H) }, 'Ann'),
		// My move, nearly three days left.
		AGCORB: playing('blue', corr(3), { t1: turn('red', now - H) }, 'Ben'),
		// My move in a 5+0 game: the first move is not charged, so 4:30 left.
		AGREAL: playing('red', { type: 'realtime', initialTime: 300_000, increment: 0 },
			{ t1: turn('red', now - 60_000), t2: turn('blue', now - 30_000) }, 'Cat'),
		// Their move.
		AGCORD: playing('red', corr(1), { t1: turn('red', now - H) }, 'Dan'),
		// An open invite.
		AGWAIT: { status: 'waiting', created: now, ranked: false, variant: 'standard', spellNames: ['a'],
			timeControl: corr(1), red: seat(me, 'Me'), blue: { connected: false } },
	};
	const index = {};
	for (const [code, r] of Object.entries(rooms)) {
		index[code] = { roomCode: code, myColor: r.red && r.red.uid === me ? 'red' : 'blue', timeControlType: r.timeControl.type, created: r.created };
	}
	await rest('PATCH', '', Object.assign({}, ...Object.keys(rooms).map((c) => ({ ['rooms/' + c]: rooms[c] })),
		{ ['user_active_games/' + me]: index }));

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	try {
		const page = await browser.newPage();
		await page.evaluateOnNewDocument(pageHooks);
		await page.setBypassServiceWorker(true);
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const url = req.url();
			if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		page.on('pageerror', (e) => console.log('pageerror:', e.message));
		await page.goto(`${BASE}/active-games.html`, { waitUntil: 'load', timeout: 90000 });
		await page.waitForFunction(() => !!window.Alpine && !!window.SigilTurns, { timeout: 30000, polling: 250 });
		await page.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), email);

		const listed = () => page.evaluate(() => {
			const read = (sel) => Array.from(document.querySelectorAll(sel + ' .game-card')).map((a) => ({
				code: a.dataset.room,
				clock: a.querySelector('.game-card__clock').textContent.trim(),
				status: a.querySelector('.game-card__status').textContent.trim(),
			}));
			const badge = document.querySelector('#auth-status .auth-status__moves');
			return { yours: read('.games-section--yours'), waiting: read('.games-section--waiting'), badge: badge ? badge.textContent : null };
		});
		let st = null;
		for (let i = 0; i < 60; i++) {
			st = await listed();
			if (st.yours.length === 3 && st.waiting.length === 2 && st.badge && st.yours.every((g) => g.clock)) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		check('your move, least time left first', JSON.stringify(st.yours.map((g) => g.code)) === '["AGREAL","AGCORA","AGCORB"]', st.yours);
		check('waiting: their move, then the invite', JSON.stringify(st.waiting.map((g) => g.code)) === '["AGCORD","AGWAIT"]', st.waiting);
		const clock = (code) => (st.yours.concat(st.waiting).find((g) => g.code === code) || {}).clock;
		check('realtime clock from the turn timestamps', /^4:(2\d|30)$/.test(clock('AGREAL')), clock('AGREAL'));
		check('correspondence deadline = last turn + moveTimeout', /^(3h 5\dm|4h 0m)$/.test(clock('AGCORA')), clock('AGCORA'));
		check('three-day clock', /^2d 2[23]h$/.test(clock('AGCORB')), clock('AGCORB'));
		check('their move shows their deadline', /^2[23]h \d+m$/.test(clock('AGCORD')) && st.waiting[0].status === 'Their move', st.waiting[0]);
		check('badge counts your moves', st.badge === 'Your move (3)', st.badge);
		const toggle = await page.evaluate(() => {
			const l = document.querySelector('.push-toggle');
			return { exists: !!l, shown: !!l && getComputedStyle(l).display !== 'none', key: SigilTurns.vapidKey, supported: SigilTurns.pushSupported() };
		});
		check('push toggle follows the VAPID key and browser support', toggle.exists && toggle.shown === (!!toggle.key && toggle.supported), toggle);

		// Dan moves in the correspondence game: it becomes my move.
		await rest('PUT', 'rooms/AGCORD/turns/t2', turn('blue', Date.now()));
		await page.waitForFunction(() => window.__notes.length > 0, { timeout: 15000, polling: 250 })
			.catch(() => {});
		const notes = await page.evaluate(() => window.__notes);
		check('an in-tab notification for the new move', notes.length === 1 && notes[0].tag === 'sigil-turn-AGCORD'
			&& /multiplayer\.html\?id=AGCORD$/.test(notes[0].url), notes);
		for (let i = 0; i < 20; i++) {
			st = await listed();
			if (st.badge === 'Your move (4)') break;
			await new Promise((r) => setTimeout(r, 500));
		}
		check('badge and list follow the move', st.badge === 'Your move (4)' && st.yours.length === 4, { badge: st.badge, yours: st.yours.map((g) => g.code) });
		// My own move raises nothing.
		await rest('PUT', 'rooms/AGCORB/turns/t2', turn('blue', Date.now()));
		await new Promise((r) => setTimeout(r, 2000));
		check('no notification for my own move', (await page.evaluate(() => window.__notes.length)) === 1);
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'ACTIVE GAMES TEST OK' : 'ACTIVE GAMES TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
