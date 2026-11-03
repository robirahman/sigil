// Live engine analysis (static/scripts/live-analysis.js) on the Firebase
// emulators (no live database), with the real wasm engine:
//   1. Two guests play an online game. A developer account spectating it
//      gets the panel; switched on, the eval, best turn and expected reply
//      appear and the search deepens; a new turn moves it to the new position.
//   2. A spectator without the developer flag, and the two players, get no
//      panel and cannot switch it on; neither can a developer who is seated.
//   3. After the game ends, the review offers it to anyone (a player, a
//      fresh guest); it follows the review's position, reads the final one
//      as won, and goes away when the review is left.
//   4. game.html: the review of a loaded game offers it; play does not.
//
//   (cd docs && python3 -m http.server 8812) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/live-analysis-emulator-test.js http://localhost:8812'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8812';
const NS = 'sigil-js-default-rtdb';
// The emulators' addresses (firebase emulators:exec sets them).
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const DB = 'http://' + DB_HOST;
// LIVE_ANALYSIS_SHOTS=<dir>: also save screenshots of the panel there.
const SHOTS = process.env.LIVE_ANALYSIS_SHOTS || '';
async function shot(page, name) {
	if (!SHOTS) return;
	const el = await page.$('.live-analysis');
	if (el) await el.scrollIntoView();
	await page.screenshot({ path: path.join(SHOTS, name + '.png') });
	// The highlighted node, on a desktop-sized window.
	await page.setViewport({ width: 1200, height: 1000 });
	await sleep(500);
	const hint = await page.$('.stone-node--engine-hint');
	if (hint) {
		await hint.scrollIntoView();
		const b = await hint.boundingBox();
		const [sx, sy] = await page.evaluate(() => [scrollX, scrollY]);   // clip is in page coordinates
		if (b) await page.screenshot({ path: path.join(SHOTS, name + '-hint.png'),
			clip: { x: Math.max(0, b.x + sx - 80), y: Math.max(0, b.y + sy - 80), width: b.width + 160, height: b.height + 160 } });
	}
	await page.setViewport({ width: 412, height: 900 });
	await sleep(300);
}
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
const G = () => Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
const LOBBY = () => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0];

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const stamp = Date.now();
	const emails = { dev: `lad${stamp}@example.com`, plain: `lap${stamp}@example.com` };
	const uid = {};
	for (const k of Object.keys(emails)) uid[k] = await signUp(emails[k]);
	const profile = (name, dev) => Object.assign({ displayName: name, elo: 1500, gamesPlayed: 0, wins: 0, losses: 0, created: stamp },
		dev ? { isDeveloper: true } : {});
	await rest('PATCH', '', { ['users/' + uid.dev]: profile('Dev', true), ['users/' + uid.plain]: profile('Plain', false) });

	const browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 10 * 60 * 1000,
		args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	const errors = [];

	async function newPage(who) {
		const ctx = await browser.createBrowserContext();
		const page = await ctx.newPage();
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
		return page;
	}
	// Signed in by email, then on to `url` (the session persists in the context).
	async function openAs(who, url) {
		const page = await newPage(who);
		await page.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		await page.waitForFunction(() => !!window.Alpine && !!window.firebase && firebase.apps.length > 0, { timeout: 30000, polling: 250 });
		await page.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), emails[who]);
		await page.goto(`${BASE}/${url}`, { waitUntil: 'load', timeout: 90000 });
		return page;
	}
	const ready = async (p) => {
		await p.waitForFunction(() => {
			const el = document.querySelector('[x-data^="gameBoard"]');
			if (!el || !window.Alpine) return false;
			const g = Alpine.$data(el);
			return !!g._engine && (g.isSpectator ? !!g.currentSfn : !!g.whoseTurn);
		}, { timeout: 60000, polling: 500 });
	};
	const play = async (p, node) => {
		await p.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).actionList.length > 0, { timeout: 30000, polling: 500 });
		await p.evaluate((n) => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).sendEvent(n), node);
		await p.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).actionList.includes('pass'), { timeout: 30000, polling: 500 });
		await p.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).handleEndTurn());
	};
	const live = (p) => p.evaluate(() => {
		const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
		const panel = document.querySelector('.live-analysis');
		return {
			can: g.canLiveAnalyse, on: g.liveAnaOn, status: g.liveAna.status, text: g.liveAna.text,
			depth: g.liveAna.depth, liveDepth: g.liveAna.liveDepth, nodes: g.liveAna.nodes, label: g.liveAna.label,
			best: g.liveAna.bestText, reply: g.liveAna.replyText, odds: g.liveAna.odds, note: g.liveAna.note,
			searchSfn: g.liveAna.searchSfn, lines: g.liveAna.lines.length,
			hints: Object.keys(g.liveAnaHintNodes || {}).length,
			hinted: document.querySelectorAll('.stone-node--engine-hint').length,
			panel: !!panel && panel.offsetParent !== null,
			detail: g.liveAnalysisDetail ? g.liveAnalysisDetail() : '',
		};
	});
	const waitLive = (p, fn, arg, timeout) => p.waitForFunction(fn, { timeout: timeout || 60000, polling: 250 }, arg);

	try {
		// Two guests: A creates, B joins by the link.
		const pageA = await newPage('A');
		await pageA.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		await pageA.waitForFunction(() => !!document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack, { timeout: 30000, polling: 500 });
		await pageA.evaluate(`(${LOBBY})().createRoom()`);
		await pageA.waitForFunction(`(${LOBBY})().phase === 'waiting'`, { timeout: 30000, polling: 500 });
		const code = await pageA.evaluate(`(${LOBBY})().roomCode`);
		const pageB = await newPage('B');
		await pageB.goto(`${BASE}/multiplayer.html?id=${code}`, { waitUntil: 'load', timeout: 90000 });
		await ready(pageA);
		await ready(pageB);
		const room = await rest('GET', 'rooms/' + code);
		const uidOf = (p) => p.evaluate(() => firebase.auth().currentUser && firebase.auth().currentUser.uid);
		const redP = room.red.uid === await uidOf(pageA) ? pageA : pageB;
		const blueP = redP === pageA ? pageB : pageA;
		await play(redP, 'a2');

		// 1. The developer spectates.
		const dev = await openAs('dev', `multiplayer.html?id=${code}`);
		await ready(dev);
		let v = await live(dev);
		check('developer spectator: panel offered', v.can && v.panel && !v.on, v);
		await dev.evaluate(`(${G})().toggleLiveAnalysis()`);
		await waitLive(dev, `(${G})().liveAna.text && (${G})().liveAna.bestText && (${G})().liveAna.replyText`);
		const first = await live(dev);
		check('switched on: eval, best turn and reply', first.on && first.status === 'searching' && !!first.text && !!first.best && !!first.reply, first);
		check('the label is the side to move', first.label === 'Blue 1', first.label);
		check('the best turn is marked on the board', first.hints > 0 && first.hinted === first.hints, { hints: first.hints, hinted: first.hinted });
		await sleep(8000);
		const later = await live(dev);
		check('the search deepens', later.depth > first.depth && later.nodes > first.nodes && later.searchSfn === first.searchSfn,
			{ first: [first.depth, first.nodes], later: [later.depth, later.nodes], detail: later.detail, lines: later.lines });
		await dev.evaluate(() => { const d = document.querySelector('.live-analysis__history'); if (d) d.open = true; });
		await shot(dev, 'spectator');
		check('the readout names depth, nodes and time', /depth \d+/.test(later.detail) && /nodes/.test(later.detail) && / s$/.test(later.detail), later.detail);
		// A new turn moves the analysis to the new position.
		await play(blueP, 'b11');
		await waitLive(dev, (s) => { const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]')); return g.liveAna.searchSfn && g.liveAna.searchSfn !== s && g.liveAna.text; }, first.searchSfn);
		const next = await live(dev);
		check('a new turn restarts it on the new position', next.label === 'Red 2' && !!next.text && next.lines >= 1, next);

		// 2. Nobody else in a game in progress.
		const plain = await openAs('plain', `multiplayer.html?id=${code}`);
		await ready(plain);
		const plainV = await live(plain);
		await shot(plain, 'plain-spectator');
		await plain.evaluate(`(${G})().toggleLiveAnalysis()`);
		const plainAfter = await live(plain);
		check('spectator without the flag: no panel, no analysis', !plainV.can && !plainV.panel && !plainAfter.on, plainAfter);
		for (const [name, p] of [['red', redP], ['blue', blueP]]) {
			await p.evaluate(`(${G})().toggleLiveAnalysis()`);
			const pv = await live(p);
			check(name + ' player: no panel, no analysis', !pv.can && !pv.panel && !pv.on, pv);
		}
		const seated = await dev.evaluate(() => [
			liveAnalysisAccess({ isSpectator: true, isDeveloper: true, viewerUid: 'u1', playerUids: ['u1', 'u2'] }),
			liveAnalysisAccess({ isSpectator: false, isDeveloper: true, viewerUid: 'u1', playerUids: ['u1', 'u2'] }),
			liveAnalysisAccess({ reviewMode: true }),
		]);
		check('a seated developer is refused; any review is allowed', seated[0] === false && seated[1] === false && seated[2] === true, seated);
		// The developer switches it off: the engine stops.
		await dev.evaluate(`(${G})().toggleLiveAnalysis()`);
		const off = await live(dev);
		check('switched off', !off.on && off.status === 'off' && off.hinted === 0, off);

		// 3. Red forfeits. Blue reviews the game; then a fresh guest opens the room.
		await redP.evaluate(`(${G})().handleForfeit()`);
		await redP.evaluate(`(${G})().handleForfeit()`);
		await blueP.waitForFunction(`(${G})().winner && (${G})().reviewSfns.length >= 3`, { timeout: 60000, polling: 500 });
		await blueP.evaluate(`(() => { const g = (${G})(); g.startReview(); g.reviewFirst(); })()`);
		await waitLive(blueP, () => { const el = document.querySelector('.live-analysis'); return el && el.offsetParent !== null; }, null, 10000).catch(() => {});
		const rv = await live(blueP);
		check('review of the finished game: offered to the player', rv.can && rv.panel, rv);
		await blueP.evaluate(`(${G})().toggleLiveAnalysis()`);
		await waitLive(blueP, `(${G})().liveAna.text && (${G})().liveAna.bestText`);
		const r0 = await live(blueP);
		check('review start: analysed for Red 1', r0.label === 'Red 1' && !!r0.best, r0);
		await blueP.evaluate(`(${G})().reviewIndex = 1`);
		await waitLive(blueP, (s) => { const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]')); return g.liveAna.searchSfn !== s && g.liveAna.text; }, r0.searchSfn);
		const r1 = await live(blueP);
		check('it follows the review to Blue 1', r1.label === 'Blue 1' && !!r1.text, r1);
		await blueP.evaluate(`(${G})().reviewLast()`);
		await waitLive(blueP, `(${G})().liveAna.status === 'decided'`);
		const rEnd = await live(blueP);
		check('the final position reads as won', rEnd.text === 'Blue won', rEnd);
		await blueP.evaluate(`(${G})().exitReview()`);
		const rOut = await live(blueP);
		check('leaving the review switches it off', !rOut.can && !rOut.on, rOut);

		for (let i = 0; i < 60 && (await rest('GET', 'rooms/' + code + '/status')) !== 'finished'; i++) await sleep(500);
		const rev = await newPage('reviewer');
		await rev.goto(`${BASE}/multiplayer.html?id=${code}`, { waitUntil: 'load', timeout: 90000 });
		await rev.waitForFunction(`(${G})() && (${G})().reviewMode && (${G})().reviewSfns.length >= 1`, { timeout: 60000, polling: 500 });
		await rev.evaluate(`(() => { const g = (${G})(); g.reviewFirst(); g.toggleLiveAnalysis(); })()`);
		await waitLive(rev, `(${G})().liveAna.text`);
		const rg = await live(rev);
		check('a guest reviewing the room gets it', rg.can && rg.panel && rg.on && !!rg.text, rg);

		// 4. game.html: a loaded review offers it, play does not.
		const local = await newPage('local');
		await local.goto(`${BASE}/game.html`, { waitUntil: 'load', timeout: 90000 });
		await local.waitForFunction(`(${G})() && typeof (${G})().toggleLiveAnalysis === 'function'`, { timeout: 60000, polling: 500 });
		const lv0 = await local.evaluate(`(${G})().canLiveAnalyse`);
		check('game.html during play: not offered', lv0 === false, lv0);
		const sfns = await blueP.evaluate(`(${G})().reviewSfns.slice()`);
		const spells = await blueP.evaluate(`(${G})()._spellNamesForExport.slice()`);
		await local.evaluate((sfns, spells) => {
			const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			g._loadReviewFromPayload({ spellNames: spells, sfns, turnLabels: sfns.map((_, i) => 'P' + i), winner: '' });
			g.reviewIndex = 1;
			g.toggleLiveAnalysis();
		}, sfns, spells);
		await waitLive(local, `(${G})().liveAna.text && (${G})().liveAna.bestText`);
		const lv = await live(local);
		await sleep(3000);
		await shot(local, 'game-review');
		check('game.html review: analysis runs', lv.can && lv.panel && lv.label === 'Blue 1' && !!lv.best && lv.hinted === lv.hints, lv);
		// "Go deeper" (offered once the schedule ends) carries on from where it
		// stopped: same position, depth and node count keep growing.
		const before = await local.evaluate(`(() => { const g = (${G})(); g._liveAnaStop(); g.liveAna.status = 'done';
			return { depth: g.liveAna.depth, nodes: g.liveAna.nodes, sfn: g.liveAna.searchSfn }; })()`);
		await local.evaluate(`(${G})().liveAnalysisDeeper()`);
		await waitLive(local, (b) => { const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			return g.liveAna.status === 'searching' && g.liveAna.depth > b.depth; }, before, 90000);
		const deeper = await live(local);
		check('Go deeper continues the same search', deeper.searchSfn === before.sfn && deeper.nodes > before.nodes && deeper.depth > before.depth,
			{ before, after: [deeper.depth, deeper.nodes] });
	} catch (e) {
		console.log('ERROR', e && e.stack || e);
		ok = false;
	}
	check('no page errors', errors.length === 0, errors);
	await browser.close();
	console.log(ok ? 'PASS' : 'FAILED');
	process.exit(ok ? 0 : 1);
})();
