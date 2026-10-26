// Correspondence vacation and "+15 s" on the Firebase emulators (auth,
// database and functions: setVacation runs for real):
//   1. In a live timed game, +15 s gives the opponent 15 seconds: the gift is
//      in the room, both pages show the opponent's clock 15 s higher, and the
//      opponent is told.
//   2. account.html starts a vacation through setVacation: the bank shows
//      14 days, then 11; every correspondence game of the player gets a
//      pause (the one in play and a second one), the live game none.
//   3. The opponent's game page says "… is on vacation until …" and shows the
//      player's deadline moved on by the vacation; active-games.html shows
//      "You are on vacation until …".
//   4. Ending it early on account.html refunds the days not begun, ends the
//      pauses, and the game page's banner and deadline follow.
//
//   (cd docs && python3 -m http.server 8810) &
//   cd functions && firebase emulators:exec --only auth,database,functions --project demo-sigil \
//     'node ../tools/browser/vacation-emulator-test.js http://localhost:8810'
// (with other emulator ports: VAC_FUNCTIONS_PORT=<functions port>)
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8810';
const NS = 'sigil-js-default-rtdb';
// emulators:exec sets the database and auth hosts; the functions port and
// project come from VAC_FUNCTIONS_PORT and GCLOUD_PROJECT (a private
// emulator config may move them all).
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const EMU = { db: DB_HOST, auth: AUTH_HOST, fn: Number(process.env.VAC_FUNCTIONS_PORT || 5001),
	project: process.env.GCLOUD_PROJECT || 'demo-sigil' };
const DB = 'http://' + DB_HOST;
const OWNER = { Authorization: 'Bearer owner' };
const DAY = 24 * 3600_000;

// Point the page's Firebase at the emulators as soon as the app exists. The
// functions emulator serves the demo project only.
function useEmulators(emu) {
	let fb;
	Object.defineProperty(window, 'firebase', {
		configurable: true,
		get() { return fb; },
		set(v) {
			fb = v;
			const init = v.initializeApp.bind(v);
			v.initializeApp = (cfg, ...rest) => {
				const app = init(Object.assign({}, cfg, { projectId: emu.project }), ...rest);
				const [dbHost, dbPort] = emu.db.split(':');
				app.auth().useEmulator('http://' + emu.auth, { disableWarnings: true });
				app.database().useEmulator(dbHost, Number(dbPort));
				if (typeof app.functions === 'function') app.functions().useEmulator('127.0.0.1', emu.fn);
				return app;
			};
		},
	});
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
	const t0 = Date.now();
	let v;
	while (Date.now() - t0 < (ms || 30000)) {
		v = await fn();
		if (v) return v;
		await sleep(250);
	}
	return v;
}

const lobby = () => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0];
const board = () => Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	const newPage = async () => {
		const ctx = await browser.createBrowserContext();
		const p = await ctx.newPage();
		await p.evaluateOnNewDocument(useEmulators, EMU);
		await p.setBypassServiceWorker(true);
		await p.setRequestInterception(true);
		p.on('request', (req) => {
			const url = req.url();
			if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		p.on('pageerror', (e) => console.log('pageerror:', e.message));
		return p;
	};
	// A room through the real lobby: `host` creates it with time control
	// `tc` (lobby fields), `guest` joins by its link.
	const openRoom = async (host, guest, tc) => {
		await host.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		await host.waitForFunction(() => !!document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack, { timeout: 30000 });
		await host.evaluate(async (t) => {
			const l = document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0];
			Object.assign(l, t);
			await l.createRoom();
		}, tc);
		await host.waitForFunction(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].phase === 'waiting', { timeout: 30000 });
		const code = await host.evaluate(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].roomCode);
		await guest.goto(`${BASE}/multiplayer.html?id=${code}`, { waitUntil: 'load', timeout: 90000 });
		const room = await until(async () => { const r = await rest('GET', 'rooms/' + code); return r && r.status === 'playing' ? r : null; }, 30000);
		for (const p of [host, guest]) {
			await p.waitForFunction(() => { try { const b = Alpine.$data(document.querySelector('[x-data^="gameBoard"]')); return !!b.whoseTurn && b.timerType !== 'none'; } catch (e) { return false; } },
				{ timeout: 30000, polling: 250 });
		}
		return { code, room };
	};
	const uidOf = (p) => p.evaluate(() => firebase.auth().currentUser && firebase.auth().currentUser.uid);
	try {
		// ---- 1. +15 s in a live game ----
		const [pa, pb] = [await newPage(), await newPage()];
		const live = await openRoom(pa, pb, { tcType: 'realtime', tcPreset: '5+0' });
		check('a live 5+0 room', live.room && live.room.timeControl.type === 'realtime', live.room && live.room.timeControl);
		const aColor = live.room.red.uid === await uidOf(pa) ? 'red' : 'blue';
		const bColor = aColor === 'red' ? 'blue' : 'red';
		const clockOf = (p, c) => p.evaluate((col) => { const b = Alpine.$data(document.querySelector('[x-data^="gameBoard"]')); return col === 'red' ? b.redTimer : b.blueTimer; }, c);
		await until(async () => (await clockOf(pb, bColor)) > 0, 15000);
		const shown = await pa.evaluate(() => { const b = document.querySelector('.action-button--give-time'); return !!b && !b.classList.contains('is-hidden'); });
		check('+15 s is offered in a live game', shown);
		const beforeB = await clockOf(pb, bColor);
		const beforeA = await clockOf(pa, bColor);
		await pa.click('.action-button--give-time');
		const gifts = await until(async () => { const g = await rest('GET', 'rooms/' + live.code + '/gifts'); return g && Object.keys(g).length ? g : null; }, 15000);
		const g = gifts && Object.values(gifts)[0];
		check('the gift is in the room, to the opponent', !!g && g.to === bColor && g.ms === 15000 && typeof g.at === 'number', gifts);
		await sleep(1500);
		const afterB = await clockOf(pb, bColor);
		const afterA = await clockOf(pa, bColor);
		check('the opponent\'s clock is 15 s higher on their page', afterB - beforeB > 12000 && afterB - beforeB <= 15000, { beforeB, afterB });
		check('… and on the giver\'s page', afterA - beforeA > 12000 && afterA - beforeA <= 15000, { beforeA, afterA });
		const told = await pb.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).messageHistory.slice(-5));
		check('the opponent is told', told.some((m) => /gave you 15 seconds/.test(m)), told);
		const st = await rest('GET', 'rooms/' + live.code + '/status');
		check('the game goes on', st === 'playing', st);

		// ---- 2. a vacation from account.html ----
		const email = `vac${Date.now()}@example.com`;
		const signUp = await (await fetch('http://' + AUTH_HOST + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, password: 'password123', returnSecureToken: true, displayName: 'Vacationer' }),
		})).json();
		const me = signUp.localId;
		if (!me) throw new Error('sign-up failed: ' + JSON.stringify(signUp));
		const [pc, pd] = [await newPage(), await newPage()];
		await pd.goto(`${BASE}/account.html`, { waitUntil: 'load', timeout: 90000 });
		await pd.waitForFunction(() => !!window.Alpine && !!window.firebase && firebase.apps.length > 0, { timeout: 30000, polling: 250 });
		await pd.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), email);
		const acct = () => pd.evaluate(() => {
			const d = Alpine.$data(document.querySelector('[x-data]'));
			const t = (sel) => { const el = document.querySelector(sel); return el && el.offsetParent !== null ? el.textContent.trim() : null; };
			return { user: !!d.user, left: t('.vacation-card__left'), status: t('.vacation-card__status'), error: d.vacationError };
		});
		let a = await until(async () => { const s = await acct(); return s.user && s.left ? s : null; }, 30000);
		check('account page: 14 days in the bank', !!a && a.left === '14 days left this year.', a);

		const corr = await openRoom(pc, pd, { tcType: 'correspondence', tcCorr: '24h' });
		const dColor = corr.room.red.uid === me ? 'red' : 'blue';
		check('a correspondence room with the player seated', corr.room.timeControl.type === 'correspondence' && corr.room[dColor].uid === me, corr.room.timeControl);
		// A second correspondence game of the player, and a live one.
		const now = Date.now();
		const seeded = (tc) => ({ status: 'playing', created: now - DAY, ranked: false, variant: 'standard', spellNames: ['a'], timeControl: tc,
			red: { uid: me, displayName: 'Vacationer', connected: false }, blue: { uid: 'opp_x', displayName: 'Xena', connected: false },
			startedAt: now - 2 * 3600_000, turns: { t1: { color: 'blue', actions: ['pass'], timestamp: now - 3600_000 } } });
		await rest('PATCH', '', {
			'rooms/VACCO2': seeded({ type: 'correspondence', moveTimeout: DAY }),
			'rooms/VACLIV': seeded({ type: 'realtime', initialTime: 300000, increment: 0 }),
			['user_active_games/' + me + '/VACCO2']: { roomCode: 'VACCO2', myColor: 'red', timeControlType: 'correspondence', created: now - DAY },
		});

		await pd.goto(`${BASE}/account.html`, { waitUntil: 'load', timeout: 90000 });
		a = await until(async () => { const s = await acct(); return s.user && s.left ? s : null; }, 30000);
		await pd.select('#vacation-days', '3');
		await pd.click('.vacation-card__start');
		a = await until(async () => { const s = await acct(); return s.status || s.error ? s : null; }, 30000);
		check('account page: on vacation until …', !!a && /^On vacation until .+\.$/.test(a.status || ''), a);
		const vac = await rest('GET', 'vacations/' + me);
		check('the bank holds 3 days used', vac && vac.usedDays === 3 && vac.until - vac.from === 3 * DAY, vac);
		const pausesIn = async (code) => Object.values((await rest('GET', 'rooms/' + code + '/pauses')) || {});
		const p1 = await pausesIn(corr.code);
		const p2 = await pausesIn('VACCO2');
		const p3 = await pausesIn('VACLIV');
		check('both correspondence games are paused for the player', p1.length === 1 && p1[0].color === dColor && p1[0].to === vac.until
			&& p2.length === 1 && p2[0].color === 'red', { p1, p2 });
		check('the live game is not', p3.length === 0, p3);

		// ---- 3. what the opponent and the player see ----
		const banner = () => pc.evaluate(() => { const el = document.querySelector('.vacation-banner'); return el && el.offsetParent !== null ? el.textContent.trim() : ''; });
		const bannerText = await until(banner, 15000);
		check('the opponent\'s game page: "… is on vacation until …"', /is on vacation until /.test(bannerText), bannerText);
		// The player's deadline (the timer node the clients write) moves on
		// by the vacation on the opponent's page.
		const deadline = Date.now() + 20 * 3600_000;
		await rest('PATCH', 'rooms/' + corr.code + '/timer', { [dColor]: deadline, activeColor: dColor, lastUpdated: Date.now() - 3600_000 });
		const want = deadline + (vac.until - p1[0].from);
		const seen = await until(async () => { const v = await clockOf(pc, dColor); return Math.abs(v - want) < 5000 ? v : null; }, 15000);
		check('the paused deadline shows the vacation added', !!seen, { seen: await clockOf(pc, dColor), want });
		const pe = await newPage();
		await pe.goto(`${BASE}/active-games.html`, { waitUntil: 'load', timeout: 90000 });
		await pe.waitForFunction(() => !!window.Alpine && !!window.firebase && firebase.apps.length > 0, { timeout: 30000, polling: 250 });
		await pe.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), email);
		const cardText = await until(() => pe.evaluate(() => {
			const el = document.querySelector('.game-card[data-room="VACCO2"] .game-card__vacation');
			return el && el.offsetParent !== null ? el.textContent.trim() : '';
		}), 30000);
		check('active-games.html: "You are on vacation until …"', /^You are on vacation until /.test(cardText), cardText);

		// ---- 4. ending it early ----
		await pd.click('.vacation-card__end');
		a = await until(async () => { const s = await acct(); return s.left ? s : null; }, 30000);
		check('account page: one day used, 13 left', !!a && a.left === '13 days left this year.', a);
		const v2 = await rest('GET', 'vacations/' + me);
		check('the bank refunds the days not begun', v2 && v2.usedDays === 1 && v2.until <= Date.now(), v2);
		const q1 = await pausesIn(corr.code);
		const q2 = await pausesIn('VACCO2');
		check('the pauses end now', q1[0].to <= Date.now() && q1[0].to < vac.until && q2[0].to === q1[0].to, { q1, q2 });
		const gone = await until(async () => (await banner()) === '', 15000);
		check('the banner goes', gone);
		const back = deadline + (q1[0].to - q1[0].from);
		const seen2 = await until(async () => { const v = await clockOf(pc, dColor); return Math.abs(v - back) < 5000 ? v : null; }, 15000);
		check('the deadline keeps only the time actually paused', !!seen2, { seen: await clockOf(pc, dColor), back });
		const st2 = await rest('GET', 'rooms/' + corr.code + '/status');
		check('the correspondence game goes on', st2 === 'playing', st2);
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'VACATION TEST OK' : 'VACATION TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
