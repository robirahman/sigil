// BOT accounts and the bot API against a real browser, on the Firebase
// emulators (auth, database, functions; no live services):
//   1. The account page turns a fresh account into a BOT account (typed
//      confirmation), shows its BOT tag, and makes API tokens: shown once,
//      listed by name, revoked; a bot token only on the BOT account.
//   2. The reference bot (tools/sigil-bot.js) connects with that token.
//   3. A human opens the bot's profile (BOT tag), challenges it from the
//      lobby (a bot challenge is timed, casual unless Rated is picked: they
//      pick Rated), and the bot accepts through the API.
//   4. The human's page plays the game out against the bot's random turns,
//      every bot turn replayed by the page's own controller; the page ends
//      on the server's final position; the seat shows the BOT tag.
//   5. The game is rated (the human's opt-in), on the bots' board for the
//      bot, and the leaderboard's Bots tab lists it.
//
//   (cd docs && python3 -m http.server 8812) &
//   cd functions && firebase emulators:exec --only auth,database,functions --project demo-sigil \
//     'node ../tools/browser/bot-api-emulator-test.js http://localhost:8812'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { loadEngine, runBot } = require('../sigil-bot');
const BASE = process.argv[2] || 'http://localhost:8812';
const NS = 'sigil-js-default-rtdb';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FN_PORT = Number(process.env.FUNCTIONS_EMULATOR_PORT || 5001);
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-sigil';
const API = `http://127.0.0.1:${FN_PORT}/${PROJECT}/us-central1/api`;
const DB = 'http://' + DB_HOST;
const OWNER = { Authorization: 'Bearer owner' };

// Point the page's Firebase (database, auth, functions) at the emulators.
function useEmulators(dbPort, authHost, fnPort) {
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
				app.database().useEmulator('127.0.0.1', dbPort);
				if (typeof app.functions === 'function') app.functions('us-central1').useEmulator('127.0.0.1', fnPort);
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

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const stamp = Date.now();
	const emailBot = `bot${stamp}@example.com`, emailHuman = `hu${stamp}@example.com`;
	const botUid = await signUp(emailBot);
	const humanUid = await signUp(emailHuman);
	const botName = 'Randy' + (stamp % 100000);
	const humanName = 'Hugo' + (stamp % 100000);
	const prof = (name) => ({ displayName: name, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: stamp });
	await rest('PATCH', '', {
		['users/' + botUid]: prof(botName), ['leaderboard/' + botUid]: { displayName: botName, elo: 1000, gamesPlayed: 0 },
		['usernames/' + botName.toLowerCase()]: botUid,
		['users/' + humanUid]: prof(humanName), ['leaderboard/' + humanUid]: { displayName: humanName, elo: 1000, gamesPlayed: 0 },
		['usernames/' + humanName.toLowerCase()]: humanUid,
	});

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	let stopBot = null;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	const until = async (fn, ms) => {
		let v;
		for (let t = 0; t < (ms || 20000); t += 250) {
			v = await fn();
			if (v) return v;
			await sleep(250);
		}
		return v;
	};
	try {
		const newPage = async () => {
			const ctx = await browser.createBrowserContext();
			const p = await ctx.newPage();
			await p.evaluateOnNewDocument(useEmulators, Number(DB_HOST.split(':')[1]), AUTH_HOST, FN_PORT);
			await p.setBypassServiceWorker(true);
			await p.setRequestInterception(true);
			p.on('request', (req) => {
				const url = req.url();
				if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
				sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
			});
			p.on('pageerror', (e) => console.log('pageerror:', e.message));
			p.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text()); });
			p.on('dialog', (d) => d.accept());
			return p;
		};
		const signIn = async (p, email) => {
			await p.waitForFunction(() => typeof firebase !== 'undefined' && firebase.apps.length > 0, { timeout: 30000, polling: 250 });
			await p.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), email);
		};
		const acct = () => Alpine.$data(document.querySelector('[x-data^="accountPage"]'));

		// ---- 1. The account page: BOT upgrade and tokens ----
		const pageA = await newPage();
		await pageA.goto(`${BASE}/account.html`, { waitUntil: 'load', timeout: 90000 });
		await signIn(pageA, emailBot);
		await pageA.waitForSelector('#bot-open', { visible: true, timeout: 30000 });
		check('the account is not a bot yet', await pageA.evaluate(() => !document.querySelector('.profile-card__name .bot-tag')));
		await pageA.click('#bot-open');
		await pageA.type('#bot-confirm', 'BOT');
		await pageA.click('#bot-submit');
		await pageA.waitForFunction(() => !!document.querySelector('.profile-card__name .bot-tag'), { timeout: 60000, polling: 250 });
		const marks = await rest('GET', '');
		check('BOT account: bots/{uid}, users isBot, off the players\' board, on the bots\'',
			!!(marks.bots && marks.bots[botUid]) && marks.users[botUid].isBot === true && !(marks.leaderboard || {})[botUid]
			&& marks.bot_leaderboard && marks.bot_leaderboard[botUid] && marks.bot_leaderboard[botUid].displayName === botName);
		check('the upgrade card says so and offers no second upgrade', await pageA.evaluate(() =>
			!document.querySelector('#bot-open') && /This is a BOT account/.test(document.querySelector('#bot-account').textContent)));
		// A read token, then revoked.
		await pageA.type('#api-token-name', 'scratch');
		await pageA.evaluate(() => { Alpine.$data(document.querySelector('[x-data^="accountPage"]')).tokenBot = false; });
		await pageA.click('#api-token-create');
		const readToken = await until(() => pageA.evaluate(() => { const el = document.getElementById('api-token-value'); return el && /^sgl_/.test(el.textContent) ? el.textContent : null; }), 30000);
		check('a token is shown once made', /^sgl_[A-Za-z0-9_-]{43}$/.test(readToken || ''));
		check('it is listed by name and scope', await until(() => pageA.evaluate(() =>
			Array.from(document.querySelectorAll('.api-token')).some((r) => /scratch/.test(r.textContent) && /read/.test(r.textContent)))));
		const meRead = await (await fetch(API + '/v1/account', { headers: { Authorization: 'Bearer ' + readToken } })).json();
		check('the token works', meRead.uid === botUid && meRead.isBot === true && meRead.scopes.join() === 'read', meRead);
		await pageA.evaluate(() => {
			const row = Array.from(document.querySelectorAll('.api-token')).find((r) => /scratch/.test(r.textContent));
			row.querySelector('.api-token__revoke').click();
		});
		check('revoked, it is gone from the list and refused', await until(async () =>
			(await pageA.evaluate(() => document.querySelectorAll('.api-token').length)) === 0
			&& (await fetch(API + '/v1/account', { headers: { Authorization: 'Bearer ' + readToken } })).status === 401));
		// The bot token.
		await pageA.evaluate(() => { Alpine.$data(document.querySelector('[x-data^="accountPage"]')).tokenBot = true; });
		await pageA.type('#api-token-name', 'engine');
		await pageA.click('#api-token-create');
		const botToken = await until(() => pageA.evaluate((old) => { const el = document.getElementById('api-token-value'); return el && /^sgl_/.test(el.textContent) && el.textContent !== old ? el.textContent : null; }, readToken), 30000);
		const stored = JSON.stringify(await rest('GET', ''));
		check('tokens are stored hashed', !!botToken && !stored.includes(botToken) && !stored.includes(readToken));

		// ---- 2. The reference bot ----
		const engine = await loadEngine(path.join(__dirname, '..', '..', 'docs', 'static', 'scripts', 'engine'));
		const botLog = [];
		const botRun = runBot({ api: API, token: botToken, engine, accept: 'all', games: 1, seed: stamp % 1000,
			log: (...a) => botLog.push(a.join(' ')) });
		botRun.catch((e) => console.log('bot failed:', e.message));
		stopBot = () => {};

		// ---- 3. A human challenges the bot ----
		const pageH = await newPage();
		await pageH.goto(`${BASE}/profile.html?uid=${botUid}`, { waitUntil: 'load', timeout: 90000 });
		await signIn(pageH, emailHuman);
		await pageH.waitForSelector('.profile__name', { timeout: 30000 });
		check('the bot\'s profile shows the BOT tag', await until(() => pageH.evaluate(() => !!document.querySelector('.profile__name .bot-tag'))));
		await pageH.waitForSelector('.profile__challenge', { visible: true, timeout: 30000 });
		await Promise.all([pageH.waitForNavigation({ waitUntil: 'load', timeout: 90000 }), pageH.click('.profile__challenge')]);
		const lobby = () => pageH.evaluate(() => {
			const d = Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]'));
			return { target: d.challengeTarget, casual: d.casualGame, tc: d.tcType, phase: d.phase, code: d.roomCode, error: d.lobbyError };
		});
		const set = await until(async () => { const l = await lobby(); return l.target && l.target.isBot ? l : null; }, 60000);
		check('a challenge to a bot: tagged, timed, casual unless chosen', !!set && set.casual === true && set.tc !== 'none'
			&& await pageH.evaluate(() => !!document.querySelector('.challenge-setup .bot-tag')
				&& getComputedStyle(document.querySelector('.challenge-setup__bot')).display !== 'none'), set);
		// Real-time 10+5, Rated.
		await pageH.evaluate(() => {
			const d = Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]'));
			d.tcType = 'realtime';
			if (Array.isArray(d.tcLadder) && d.tcLadder.includes('10+5')) d.setTimePreset('10+5');
			d.casualGame = false;
		});
		const sendBtn = await pageH.evaluateHandle(() => Array.from(document.querySelectorAll('button.lobby-button')).find((b) => /Send Challenge/.test(b.textContent)));
		await sendBtn.click();
		const code = (await until(async () => { const l = await lobby(); return l.code && l.phase !== 'lobby' ? l.code : null; }, 60000));
		check('the challenge room is made', !!code, await lobby());
		const room0 = await rest('GET', 'rooms/' + code);
		check('the human opted in (rateBot), and the room invites the bot', room0 && room0.rateBot === true && room0.invite === botUid, room0 && { rateBot: room0.rateBot, invite: room0.invite });
		const started = await until(async () => { const r = await rest('GET', 'rooms/' + code + '/status'); return r === 'playing'; }, 60000);
		check('the bot accepted through the API and the game started', started, botLog.slice(-3));
		const room1 = await rest('GET', 'rooms/' + code);
		check('the bot\'s seat and the rated game', room1.ranked === true && room1[room1.creatorColor === 'red' ? 'blue' : 'red'].bot === true);

		// ---- 4. Play it out: the page's human moves and passes ----
		const step = () => pageH.evaluate(() => {
			const el = document.querySelector('[x-data^="gameBoard"]');
			const d = el && window.Alpine && Alpine.$data(el);
			const e = d && d._engine;
			if (!e) return 'no-engine';
			if (!e.__wrapped) {
				const orig = e.emit;
				e.emit = (p) => { if (p && p.awaiting) window.__last = p; return orig.call(e, p); };
				e.__wrapped = true;
			}
			if (e.board && e.board.gameover) return 'over';
			const p = window.__last;
			if (!e._inputResolve || !p || !e.board || e.board.whoseTurn !== e.myColor) return 'wait';
			window.__last = null;
			const opts = Object.keys(p.moveoptions || {});
			const acts = p.actionlist || [];
			const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
			let tok = 'pass';
			if (opts.length && (p.awaiting === 'node' || acts.includes('move'))) tok = pick(opts);
			else if (acts.includes('pass')) tok = 'pass';
			else if (acts.includes('skip_providence')) tok = 'skip_providence';
			e.handlePlayerAction(tok);
			return 'sent ' + tok;
		});
		let state = '';
		let humanTurns = 0;
		for (let t = 0; t < 600000 && state !== 'over'; t += 150) {
			state = await step().catch((err) => 'error ' + err.message);
			if (/^sent pass/.test(state)) humanTurns++;
			const st = state === 'over' ? null : await rest('GET', 'rooms/' + code + '/status');
			if (st && st !== 'playing') break;
			await sleep(150);
		}
		const fin = await until(async () => { const r = await rest('GET', 'rooms/' + code); return r && r.status === 'finished' ? r : null; }, 60000);
		check('the game ended', !!fin && (fin.winner === 'red' || fin.winner === 'blue'), fin && { winner: fin.winner, endReason: fin.endReason, turns: Object.keys(fin.turns || {}).length, humanTurns });
		const view = await (await fetch(API + '/v1/games/' + code)).json();
		const page = await until(() => pageH.evaluate((serverSfn) => {
			const d = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			const e = d && d._engine;
			if (!e || !e.board || !e.board.gameover) return null;
			const sfn = boardToSfn(e.board);
			return { sfn, same: normalizeSfnString(sfn) === normalizeSfnString(serverSfn), winner: e.board.winner,
				tag: !!document.querySelector('.ladder-details .bot-tag') };
		}, view.sfn), 30000);
		check('the page played every bot turn as the server replays it', !!page && view.replayed === true && view.moves.length > 1
			&& page.winner === view.winner && page.same, { page, server: view.sfn, winner: view.winner, moves: view.moves.length });
		check('the bot\'s seat shows the BOT tag', !!page && page.tag);

		// ---- 5. Rated, on the right boards ----
		const gameId = await until(() => rest('GET', 'rooms/' + code + '/gameId'), 60000);
		const entry = await until(() => rest('GET', 'user_games/' + humanUid + '/' + gameId), 60000);
		check('rated for the human, against a bot', !!entry && entry.rated === true && entry.opponentIsBot === true, entry);
		const boards = await rest('GET', '');
		check('the bot is on the bots\' board only', boards.bot_leaderboard[botUid].gamesPlayed === 1 && !(boards.leaderboard || {})[botUid]
			&& boards.leaderboard[humanUid].gamesPlayed === 1);
		await pageA.goto(`${BASE}/leaderboard.html?tab=bots`, { waitUntil: 'load', timeout: 90000 });
		check('the Bots tab lists it with its tag', await until(() => pageA.evaluate((u) => {
			const row = document.getElementById('lb-row-' + u);
			return !!row && !!row.querySelector('.bot-tag');
		}, botUid), 30000));
		const res = await Promise.race([botRun, sleep(30000).then(() => null)]);
		check('the bot saw the game finish', !!res && res.finished.length === 1 && res.finished[0].room === code, botLog.slice(-2));
	} catch (e) {
		console.log('FAIL', e && e.stack || e);
		ok = false;
	} finally {
		if (stopBot) stopBot();
		await browser.close();
	}
	console.log(ok ? 'ALL OK' : 'FAILED');
	process.exit(ok ? 0 : 1);
})();
