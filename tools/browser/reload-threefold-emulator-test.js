// A seated player whose page reloads mid-game keeps the game's history
// (MultiplayerController._seedHistory), on the Firebase emulators with two
// signed-in accounts through the real lobby and game screen. The game: each
// side places twice, then plays "null" turns (move, dash sacrificing that
// stone and another, put the other back), so the position before Red's
// turn 5 comes up again before turns 7 and 9: a twofold, then threefold
// repetition (Blue wins) at the start of turn 9.
//   1. Red reloads at the twofold, Blue at the start of turn 8. Each page
//      warns of the repetition again, both end the game at the start of
//      turn 9 as a Blue win by threefold repetition, with the same review;
//      the room's record holds every turn.
//   2. Red's reload cannot rebuild the game (its first turn is unreadable
//      while it loads): a warning, and its board misses the threefold; the
//      Blue page ends the game, and the Red page takes the room's result
//      (Blue wins), writing nothing.
//   With the functions emulator running, both games are recorded and rated
//   as Blue wins, not overturned (a threefold closed by either client).
//
//   (cd docs && python3 -m http.server 8801) &
//   cd functions && firebase emulators:exec --only auth,database,functions --project demo-sigil \
//     'node ../tools/browser/reload-threefold-emulator-test.js http://localhost:8801'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8801';
const NS = 'sigil-js-default-rtdb';
// The emulators' addresses (firebase emulators:exec sets them).
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
// Set by emulators:exec when the functions emulator runs: then the games'
// records and ratings (functions/index.js recordRoom, rateGame) are checked.
const WITH_FUNCTIONS = !!process.env.FUNCTIONS_EMULATOR_HOST || process.argv.includes('--functions');
const DB = 'http://' + DB_HOST;
const OWNER = { Authorization: 'Bearer owner' };

const SPELLS = ['Starfall', 'Flourish', 'Seal_of_Lightning', 'Grow', 'Fireblast', 'Hail_Storm', 'Surge', 'Slash', 'Sprout'];
const NULL = { red: ['a6', 'dash', 'a6', 'a2', 'a2', 'pass'], blue: ['b6', 'dash', 'b6', 'b2', 'b2', 'pass'] };
const TURNS = [['a11', 'pass'], ['b11', 'pass'], ['a2', 'pass'], ['b2', 'pass'],
	NULL.red, NULL.blue, NULL.red, NULL.blue];

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOBBY = () => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0];

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const stamp = Date.now();
	const emails = { A: `rta${stamp}@example.com`, B: `rtb${stamp}@example.com` };
	const uid = {};
	for (const k of Object.keys(emails)) uid[k] = await signUp(emails[k]);
	const profile = (name) => ({ displayName: name, elo: 1500, gamesPlayed: 0, wins: 0, losses: 0, created: stamp });
	await rest('PATCH', '', {
		['users/' + uid.A]: profile('Ada'), ['users/' + uid.B]: profile('Bea'),
		['leaderboard/' + uid.A]: { displayName: 'Ada', elo: 1500, gamesPlayed: 0 },
		['leaderboard/' + uid.B]: { displayName: 'Bea', elo: 1500, gamesPlayed: 0 },
	});

	const browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 10 * 60 * 1000,
		args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	const errors = [];

	// One browser context per account: a reload keeps its sign-in.
	const contexts = {};
	async function newPage(who) {
		contexts[who] = contexts[who] || await browser.createBrowserContext();
		const page = await contexts[who].newPage();
		await page.setViewport({ width: 412, height: 900 });
		await page.evaluateOnNewDocument(useEmulators, DB_HOST, AUTH_HOST);
		await page.setBypassServiceWorker(true);
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const u = req.url();
			if (!u.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(u).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		page.on('pageerror', (e) => { errors.push(who + ': ' + e.message); console.log('pageerror (' + who + '):', e.message); });
		page.on('dialog', (d) => d.accept().catch(() => {}));
		page._warnings = [];
		page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'warn') page._warnings.push(m.text()); });
		return page;
	}
	async function openAs(who, url) {
		const page = await newPage(who);
		await page.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		await page.waitForFunction(() => !!window.Alpine && !!window.firebase && firebase.apps.length > 0, { timeout: 30000, polling: 250 });
		await page.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), emails[who]);
		if (url !== 'multiplayer.html') await page.goto(`${BASE}/${url}`, { waitUntil: 'load', timeout: 90000 });
		return page;
	}
	// The game screen's controller is running and has drawn the board.
	const ready = (p) => p.waitForFunction(() => {
		const el = document.querySelector('[x-data^="gameBoard"]');
		if (!el || !window.Alpine) return false;
		const g = Alpine.$data(el);
		return !!g._engine && !!g._engine.board && !!g.whoseTurn;
	}, { timeout: 60000, polling: 250 });
	const state = (p) => p.evaluate(() => {
		const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
		const e = g._engine;
		return {
			myColor: g.myColor, winner: g.winner || null, whoseTurn: g.whoseTurn,
			messages: g.messageHistory.slice(), log: e && e._gameLog ? e._gameLog.length : null,
			counts: e && e.board ? Object.values(e.board.allLoopingSnapshotCounts).sort().join(',') : null,
			reviewSfns: (g.reviewSfns || []).slice(), finalSfn: e && e.board ? boardToSfn(e.board) : null,
		};
	});
	// One turn through the game screen: node clicks, Dash, End Turn.
	async function playTurn(p, tokens) {
		for (const t of tokens) {
			await p.waitForFunction(() => {
				const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
				const e = g._engine;
				return !!e && !!e._inputResolve && e.board.whoseTurn === g.myColor;
			}, { timeout: 30000, polling: 100 });
			await p.evaluate((t) => {
				const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
				if (t === 'pass') g.handleEndTurn();
				else if (t === 'dash') g.handleDash();
				else g.sendEvent(t);
			}, t);
		}
	}
	const turnsIn = async (code) => Object.keys((await rest('GET', 'rooms/' + code + '/turns')) || {}).length;
	async function untilTurns(code, n) {
		for (let i = 0; i < 120 && (await turnsIn(code)) < n; i++) await sleep(250);
	}
	// Both pages have played turn `n` (1-based) of the transcript.
	async function playThrough(code, pages, from, to) {
		for (let i = from; i < to; i++) {
			await playTurn(i % 2 ? pages.blue : pages.red, TURNS[i]);
			await untilTurns(code, i + 1);
		}
	}
	async function newGame() {
		const a = await openAs('A', 'multiplayer.html');
		await a.waitForFunction(() => !!document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack, { timeout: 30000, polling: 250 });
		await a.evaluate(`(${LOBBY})().createRoom({ spellNames: ${JSON.stringify(SPELLS)}, creatorSide: 'red' })`);
		await a.waitForFunction(`(${LOBBY})().phase === 'waiting'`, { timeout: 30000, polling: 250 });
		const code = await a.evaluate(`(${LOBBY})().roomCode`);
		const b = await openAs('B', `multiplayer.html?id=${code}`);
		await ready(a);
		await ready(b);
		const room = await rest('GET', 'rooms/' + code);
		const red = room.red.uid === uid.A ? a : b;
		return { code, room, red, blue: red === a ? b : a };
	}
	async function reload(p) {
		await p.reload({ waitUntil: 'load', timeout: 90000 });
		await ready(p);
	}
	// The server's record and rating of a finished room (functions emulator).
	async function verdict(code) {
		let gameId = null;
		for (let i = 0; i < 120 && !gameId; i++) { gameId = await rest('GET', 'rooms/' + code + '/gameId'); if (!gameId) await sleep(500); }
		if (!gameId) return { gameId: null };
		let rec = null;
		for (let i = 0; i < 120; i++) {
			rec = await rest('GET', 'completed_games/' + gameId);
			if (rec && (rec.eloProcessed || rec.unratedReason)) break;
			await sleep(500);
		}
		const room = await rest('GET', 'rooms/' + code);
		const blueGame = await rest('GET', 'user_games/' + uid.B + '/' + gameId);
		return { gameId, rec, room, blueResult: blueGame && blueGame.result };
	}

	try {
		// 1. Both players reload: each rebuilds the game and ends it itself.
		const g1 = await newGame();
		check('a ranked standard room with the chosen spells', g1.room.ranked === true && (g1.room.variant || 'standard') === 'standard'
			&& JSON.stringify(g1.room.spellNames) === JSON.stringify(SPELLS), { ranked: g1.room.ranked, variant: g1.room.variant });
		await playThrough(g1.code, g1, 0, 6);
		await g1.red.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).messageHistory.some((m) => /Repeated position/.test(m)), { timeout: 30000, polling: 250 });
		await reload(g1.red);
		await g1.red.waitForFunction(() => { const e = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'))._engine; return !!e._inputResolve; }, { timeout: 30000, polling: 250 });
		let r = await state(g1.red);
		check('Red reloaded at the twofold: the game so far is rebuilt', r.myColor === 'red' && r.log === 6 && r.counts === '1,1,1,1,1,2', { log: r.log, counts: r.counts });
		check('Red reloaded: the repetition is announced again', r.messages.some((m) => /Reconnected as Red/.test(m)) && r.messages.some((m) => /Repeated position/.test(m)), r.messages);
		await playThrough(g1.code, g1, 6, 7);
		await reload(g1.blue);
		await g1.blue.waitForFunction(() => { const e = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'))._engine; return !!e._inputResolve; }, { timeout: 30000, polling: 250 });
		const b = await state(g1.blue);
		check('Blue reloaded at turn 8: the game so far is rebuilt and the repetition announced', b.log === 7 && b.counts === '1,1,1,1,2,2'
			&& b.messages.some((m) => /Repeated position/.test(m)), { log: b.log, counts: b.counts, messages: b.messages });
		await playThrough(g1.code, g1, 7, 8);
		for (const p of [g1.red, g1.blue]) {
			await p.waitForFunction(() => !!Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).winner, { timeout: 30000, polling: 250 });
		}
		r = await state(g1.red);
		const bl = await state(g1.blue);
		for (const [name, s] of [['Red', r], ['Blue', bl]]) {
			check(name + ': threefold repetition, Blue wins', s.winner === 'blue' && s.messages.some((m) => /Threefold repetition/.test(m)), s.messages.slice(-4));
		}
		check('both pages review the same 8 turns', r.reviewSfns.length === 9 && JSON.stringify(r.reviewSfns) === JSON.stringify(bl.reviewSfns),
			{ red: r.reviewSfns.length, blue: bl.reviewSfns.length });
		let room = await rest('GET', 'rooms/' + g1.code);
		check('the room: finished, Blue won, the full game log', room.status === 'finished' && room.winner === 'blue' && !room.forfeitedBy
			&& Array.isArray(room.gameLog) && room.gameLog.length === 8 && room.finalSfn === r.finalSfn,
		{ status: room.status, winner: room.winner, log: room.gameLog && room.gameLog.length, finishedBy: room.finishedBy });
		check('no page warnings from the replay', g1.red._warnings.concat(g1.blue._warnings).filter((w) => /\[Controller\]/.test(w)).length === 0);

		// 2. Red's reload cannot rebuild the game: the room's result ends it.
		const g2 = await newGame();
		await playThrough(g2.code, g2, 0, 6);
		const keys = Object.keys(await rest('GET', 'rooms/' + g2.code + '/turns')).sort();
		const saved = await rest('GET', 'rooms/' + g2.code + '/turns/' + keys[0] + '/actions');
		await rest('PUT', 'rooms/' + g2.code + '/turns/' + keys[0] + '/actions', ['pass']);
		await reload(g2.red);
		await g2.red.waitForFunction(() => { const e = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'))._engine; return !!e._inputResolve; }, { timeout: 30000, polling: 250 });
		await rest('PUT', 'rooms/' + g2.code + '/turns/' + keys[0] + '/actions', saved);
		r = await state(g2.red);
		check('unreadable transcript: Red falls back to the room\'s position, with a warning', r.log === 0 && r.counts === '1'
			&& g2.red._warnings.some((w) => /\[Controller\]/.test(w)), { log: r.log, counts: r.counts, warnings: g2.red._warnings });
		await playThrough(g2.code, g2, 6, 8);
		for (const p of [g2.red, g2.blue]) {
			await p.waitForFunction(() => !!Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).winner, { timeout: 30000, polling: 250 });
		}
		r = await state(g2.red);
		const b2 = await state(g2.blue);
		check('Blue\'s board: threefold repetition', b2.winner === 'blue' && b2.messages.some((m) => /Threefold repetition/.test(m)));
		check('Red\'s board missed it and takes the room\'s result', r.winner === 'blue' && !r.messages.some((m) => /Threefold repetition/.test(m))
			&& r.messages.some((m) => /Game over: Blue wins/.test(m)), r.messages.slice(-4));
		check('on the position Blue\'s board ended on', r.finalSfn === b2.finalSfn, { red: r.finalSfn, blue: b2.finalSfn });
		room = await rest('GET', 'rooms/' + g2.code);
		check('the room: Blue closed it, Blue won, Blue\'s full game log', room.status === 'finished' && room.winner === 'blue'
			&& room.finishedBy === 'blue' && room.gameLog && room.gameLog.length === 8, { finishedBy: room.finishedBy, log: room.gameLog && room.gameLog.length });

		if (WITH_FUNCTIONS) {
			for (const [name, code] of [['game 1', g1.code], ['game 2 (closed by Blue)', g2.code]]) {
				const v = await verdict(code);
				check(name + ': recorded and rated as a Blue win, not overturned', !!v.gameId && v.rec && v.rec.winner === 'blue'
					&& v.rec.eloProcessed === true && !v.rec.unratedReason && v.room.winner === 'blue' && !v.room.forfeitedBy
					&& v.room.endReason !== 'forfeit' && v.blueResult === 'win',
				{ gameId: v.gameId, winner: v.rec && v.rec.winner, eloChange: v.rec && v.rec.eloChange, unrated: v.rec && v.rec.unratedReason,
					room: v.room && { winner: v.room.winner, forfeitedBy: v.room.forfeitedBy, endReason: v.room.endReason }, blue: v.blueResult });
			}
		} else {
			console.log('note: no functions emulator, the server\'s verdict is not checked');
		}
	} catch (e) {
		console.log('ERROR', e && e.stack || e);
		ok = false;
	}
	check('no page errors', errors.length === 0, errors);
	await browser.close();
	console.log(ok ? 'PASS' : 'FAILED');
	process.exit(ok ? 0 : 1);
})();
