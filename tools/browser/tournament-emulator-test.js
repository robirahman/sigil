// Tournaments through the real pages in Chrome, on the Firebase emulators
// (database, auth and functions: the `tournament` callable and the
// tournamentGameEnd trigger run for real):
//   1. Alice creates an arena from tournaments.html and lands on its page.
//   2. Bob and Carol join from tournament.html; a guest watches but cannot join.
//   3. Alice starts it: the server pairs Bob and Carol, whose pages go
//      straight into the game. The game page shows the event, Berserk and
//      no Abort / Take back / +15 s.
//   4. Red berserks (the clock halves, both pages say so); blue resigns;
//      both pages offer the way back and return to the event, where the
//      winner has 2 points.
//   5. Alice creates a simul, Bob and Carol join, she starts it: her page
//      shows both boards; Bob and Carol go to theirs; "Next board" takes
//      Alice to a board, whose bar offers the other one.
//
//   (cd docs && python3 -m http.server 8807) &
//   cd functions && firebase emulators:exec --only auth,database,functions --project demo-sigil \
//     'node ../tools/browser/tournament-emulator-test.js http://localhost:8807'
// (other emulator ports: TOUR_FUNCTIONS_PORT=<functions port>; GCLOUD_PROJECT
// names the project the functions emulator serves.)
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8807';
const NS = 'sigil-js-default-rtdb';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const EMU = { db: DB_HOST, auth: AUTH_HOST, fn: Number(process.env.TOUR_FUNCTIONS_PORT || process.env.FUNCTIONS_EMULATOR_PORT || 5001),
	project: process.env.GCLOUD_PROJECT || 'demo-sigil' };
const DB = 'http://' + DB_HOST;
const OWNER = { Authorization: 'Bearer owner' };

// Point the page's Firebase at the emulators as soon as the app exists.
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
		v = await fn().catch(() => undefined);
		if (v) return v;
		await sleep(300);
	}
	return v;
}

const tourPage = () => Alpine.$data(document.querySelector('[x-data^="tournamentPage"]'));
const listPage = () => Alpine.$data(document.querySelector('[x-data^="tournamentsPage"]'));
const board = () => Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());
	await fetch(`${DB}/.json?ns=${NS}`, { method: 'DELETE', headers: OWNER });

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && !!cond; };
	const errors = [];
	const newPage = async (name) => {
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
		p.on('pageerror', (e) => { errors.push(name + ': ' + e.message); console.log('pageerror (' + name + '):', e.message); });
		p.on('dialog', (d) => d.accept());
		return p;
	};
	const open = async (p, url, sel) => {
		await p.goto(BASE + '/' + url, { waitUntil: 'load', timeout: 90000 });
		await p.waitForFunction((s) => { const el = document.querySelector(s); return !!(el && el._x_dataStack && window.firebase); }, { timeout: 30000 }, sel);
	};
	// A full account with a profile, signed in on its own browser context.
	const account = async (name, elo) => {
		const p = await newPage(name);
		await open(p, 'tournaments.html', '[x-data^="tournamentsPage"]');
		await p.evaluate(async (n, e) => {
			const c = await firebase.auth().createUserWithEmailAndPassword(n.toLowerCase() + '@example.test', 'secret123');
			await firebase.database().ref('users/' + c.user.uid).set({ displayName: n, elo: e, gamesPlayed: 0, wins: 0, losses: 0, created: Date.now() });
		}, name, elo);
		await p.waitForFunction(() => !!(Alpine.$data(document.querySelector('[x-data^="tournamentsPage"]')).authUser), { timeout: 20000 });
		return p;
	};
	const uidOf = (p) => p.evaluate(() => firebase.auth().currentUser && firebase.auth().currentUser.uid);
	const onGame = (p) => until(() => p.evaluate(() => {
		if (!/multiplayer\.html/.test(location.pathname)) return null;
		try { const b = Alpine.$data(document.querySelector('[x-data^="gameBoard"]')); return b.whoseTurn && b.tournament ? location.search : null; } catch (e) { return null; }
	}), 45000);

	try {
		// ---- 1. An arena from the create form.
		const alice = await account('Alice', 1500);
		const bob = await account('Bob', 1400);
		const carol = await account('Carol', 1300);
		await alice.evaluate(() => {
			const l = Alpine.$data(document.querySelector('[x-data^="tournamentsPage"]'));
			Object.assign(l.form, { kind: 'arena', name: 'Browser Arena', minutes: 3, increment: 0, durationMin: 30, startIn: '60', berserk: true });
		});
		await alice.click('[data-testid="create-form"] button[type="submit"]');
		await alice.waitForFunction(() => /tournament\.html\?id=/.test(location.href), { timeout: 30000 });
		const id = new URL(alice.url()).searchParams.get('id');
		await alice.waitForFunction(() => { try { return !!Alpine.$data(document.querySelector('[x-data^="tournamentPage"]')).t; } catch (e) { return false; } }, { timeout: 30000 });
		const status1 = await alice.$eval('[data-testid="status-line"]', (el) => el.textContent);
		check('Alice lands on her arena, which starts in an hour', /^Starts in (59|1 h)/.test(status1), status1);
		const ev = await rest('GET', 'tournaments/' + id);
		check('a player\'s arena is casual, berserk allowed', ev && ev.rated === false && ev.berserk === true && ev.kind === 'arena', ev && { rated: ev.rated, berserk: ev.berserk });

		// ---- 2. Bob and Carol join; a guest watches.
		for (const p of [bob, carol]) {
			await open(p, 'tournament.html?id=' + id, '[x-data^="tournamentPage"]');
			await p.waitForSelector('[data-testid="join"]', { visible: true, timeout: 20000 });
			await p.click('[data-testid="join"]');
		}
		const joined = await until(() => alice.evaluate(() => document.querySelectorAll('[data-testid="standings"] tbody tr').length === 2), 20000);
		check('both show in the standings', joined);
		const guest = await newPage('guest');
		await open(guest, 'tournament.html?id=' + id, '[x-data^="tournamentPage"]');
		await guest.evaluate(() => firebase.auth().signInAnonymously());
		await sleep(1500);
		const g = await guest.evaluate(() => ({ join: !!document.querySelector('[data-testid="join"]'), rows: document.querySelectorAll('[data-testid="standings"] tbody tr').length }));
		check('a guest sees the standings but no Join', !g.join && g.rows === 2, g);
		const listed = await until(() => guest.evaluate(async () => {
			const s = await firebase.database().ref('tournament_index').once('value');
			return !!s.val();
		}), 10000);
		check('the arena is in the public list', listed);

		// ---- 3. Alice starts it: Bob and Carol are paired and taken to the game.
		await alice.waitForSelector('[data-testid="start"]', { visible: true });
		await alice.click('[data-testid="start"]');
		const [qb, qc] = await Promise.all([onGame(bob), onGame(carol)]);
		check('Bob and Carol go straight into their game', !!qb && qb === qc, { qb, qc });
		const code = new URLSearchParams(qb || '').get('id');
		const room = await rest('GET', 'rooms/' + code);
		check('the room is the tournament\'s, both seated', room && room.tournament && room.tournament.id === id && room.status === 'playing', room && room.tournament);
		const red = room.red.uid === await uidOf(bob) ? bob : carol;
		const blue = red === bob ? carol : bob;
		const bar = await red.evaluate(() => {
			const b = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			const vis = (sel) => { const el = document.querySelector(sel); return !!el && !el.classList.contains('is-hidden') && getComputedStyle(el).display !== 'none'; };
			return { label: b.tournamentLabel(), berserk: vis('[data-testid="berserk"]'), abort: vis('.action-button--abort'), takeback: vis('.action-button--take-back'), gift: vis('.action-button--give-time') };
		});
		check('the game page shows the event and Berserk, no Abort / Take back / +15 s', bar.label === 'Arena: Browser Arena' && bar.berserk && !bar.abort && !bar.takeback && !bar.gift, bar);

		// ---- 4. Red berserks; blue resigns.
		await red.click('[data-testid="berserk"]');
		const bz = await until(async () => { const r = await rest('GET', 'rooms/' + code); return r && r.berserk && r.berserk.red === true ? r : null; }, 15000);
		check('red berserked: the room says so and the clock halved', bz && bz.timer && bz.timer.red <= 90000, bz && bz.timer);
		const seen = await until(() => blue.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).berserk.red === true), 10000);
		check('blue\'s page shows red\'s berserk', seen);
		const gone = await until(() => red.evaluate(() => !Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).canBerserk), 5000);
		check('red cannot berserk twice', gone);
		await blue.evaluate(() => { const b = Alpine.$data(document.querySelector('[x-data^="gameBoard"]')); b.handleForfeit(); b.handleForfeit(); });
		const modal = await until(() => red.evaluate(() => {
			const b = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			const back = document.querySelector('[data-testid="tournament-return"]');
			const again = [...document.querySelectorAll('.win-modal__btn')].some((el) => el.textContent.trim() === 'Play Again' && getComputedStyle(el).display !== 'none');
			return b.winner ? { winner: b.winner, back: !!back && /Back to the tournament/.test(back.textContent), again } : null;
		}), 15000);
		check('the winner\'s modal offers the way back, not Play Again', modal && modal.winner === 'red' && modal.back && !modal.again, modal);
		const back = await until(() => red.evaluate(() => /tournament\.html/.test(location.pathname)), 15000);
		check('the page returns to the event by itself', back);
		const score = await until(async () => {
			const pl = await rest('GET', 'tournament_players/' + id + '/' + room.red.uid);
			return pl && pl.games === 1 ? pl : null;
		}, 20000);
		check('the winner has 2 points (no berserk bonus without 4 turns of their own)', score && score.score === 2 && score.sheet === '2' && score.berserks === 1, score);
		const row = await until(() => red.evaluate((uid) => {
			const tr = document.querySelector('[data-testid="standings"] tr[data-uid="' + uid + '"]');
			return tr ? tr.textContent.replace(/\s+/g, ' ') : null;
		}, room.red.uid), 10000);
		check('the standings show it', /2/.test(row || ''), row);

		// ---- 5. A simul.
		await open(alice, 'tournaments.html', '[x-data^="tournamentsPage"]');
		await alice.waitForFunction(() => !!Alpine.$data(document.querySelector('[x-data^="tournamentsPage"]')).authUser, { timeout: 20000 });
		await alice.evaluate(() => {
			const l = Alpine.$data(document.querySelector('[x-data^="tournamentsPage"]'));
			Object.assign(l.form, { kind: 'simul', name: 'Alice simul', untimed: true, maxPlayers: 5, hostColor: 'red' });
		});
		await alice.click('[data-testid="create-form"] button[type="submit"]');
		await alice.waitForFunction(() => /tournament\.html\?id=/.test(location.href), { timeout: 30000 });
		const sid = new URL(alice.url()).searchParams.get('id');
		for (const p of [bob, carol]) {
			await open(p, 'tournament.html?id=' + sid, '[x-data^="tournamentPage"]');
			await p.waitForSelector('[data-testid="join"]', { visible: true, timeout: 20000 });
			await p.click('[data-testid="join"]');
		}
		await until(() => alice.evaluate(() => document.querySelectorAll('[data-testid="simul"] .tour-game').length === 2), 20000);
		await alice.waitForSelector('[data-testid="start"]', { visible: true });
		await alice.click('[data-testid="start"]');
		const boards = await until(() => alice.evaluate(() => {
			const els = document.querySelectorAll('.simul-board');
			return els.length === 2 && [...els].every((el) => el.querySelector('.mini-board')) ? els.length : null;
		}), 20000);
		check('the host sees both boards', boards === 2, boards);
		const [sb, sc] = await Promise.all([onGame(bob), onGame(carol)]);
		check('each opponent goes to their own board', !!sb && !!sc && sb !== sc, { sb, sc });
		const next = await until(() => alice.evaluate(() => {
			const b = document.querySelector('[data-testid="next-board"]');
			return b && !b.disabled && /2 to move/.test(b.textContent) ? b.textContent : null;
		}), 15000);
		check('both boards wait for the host (red everywhere)', !!next, next);
		await alice.click('[data-testid="next-board"]');
		const hostGame = await onGame(alice);
		check('Next board takes the host to a board', !!hostGame, hostGame);
		const hostBar = await until(() => alice.evaluate(() => {
			const b = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			return b.simulHost && b.simulQueue.length === 1 ? { label: b.tournamentLabel(), queue: b.simulQueue.length } : null;
		}), 20000);
		check('the host\'s board offers the other board', hostBar && hostBar.label === 'Simul: Alice simul', hostBar);
		const seats = await until(async () => {
			const pairs = Object.values(await rest('GET', 'tournament_pairings/' + sid) || {});
			const rs = await Promise.all(pairs.map((x) => rest('GET', 'rooms/' + x.room + '/red/conns')));
			return rs.every((c) => c && Object.keys(c).length > 0) ? rs.length : null;
		}, 15000);
		check('the host\'s seat is live on every board', seats === 2, seats);
	} catch (e) {
		console.log('FAIL exception', e && e.stack || e);
		ok = false;
	}
	const fatal = errors.filter((e) => !/permission_denied|PERMISSION_DENIED|Client is offline/i.test(e));
	check('no page errors', fatal.length === 0, fatal);
	await browser.close();
	console.log(ok ? 'ALL OK' : 'SOME CHECKS FAILED');
	process.exit(ok ? 0 : 1);
})();
