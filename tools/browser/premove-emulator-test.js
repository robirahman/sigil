// Pre-moves in online games (game-board-multiplayer.js), on the Firebase
// emulators: two guest pages create and join a room through the lobby.
//   1. During red's turn, blue's click on a node queues a pre-move (a second
//      click cancels it); red's own page offers none on its own turn.
//   2. When blue's turn comes, the queued placement is played as a click
//      would be: the stone is placed and blue is asked to end the turn;
//      nothing is sent before blue ends it, and then the room holds it.
//   3. A pre-move that is no longer a legal placement is dropped with a note.
//   4. Escape drops a pre-move; with the setting off, clicks queue nothing.
//
//   (cd docs && python3 -m http.server 8810) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/premove-emulator-test.js http://localhost:8810'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8810';
const NS = 'sigil-js-default-rtdb';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`http://${DB_HOST}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && !!cond; };
	try {
		const pages = [];
		for (let i = 0; i < 2; i++) {
			const ctx = await browser.createBrowserContext();
			const p = await ctx.newPage();
			await p.setViewport({ width: 1200, height: 1000 });
			await p.evaluateOnNewDocument(useEmulators, DB_HOST, AUTH_HOST);
			await p.setBypassServiceWorker(true);
			await p.setRequestInterception(true);
			p.on('request', (req) => {
				const url = req.url();
				if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
				sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
			});
			p.on('pageerror', (e) => console.log('pageerror:', e.message));
			pages.push(p);
		}
		const [pageA, pageB] = pages;
		await pageA.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		await pageA.waitForFunction(() => !!document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack, { timeout: 30000 });
		await pageA.evaluate(async () => { await document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].createRoom(); });
		await pageA.waitForFunction(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].phase === 'waiting', { timeout: 30000 });
		const code = await pageA.evaluate(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].roomCode);
		await pageB.goto(`${BASE}/multiplayer.html?id=${code}`, { waitUntil: 'load', timeout: 90000 });
		const ready = async (p) => {
			for (let i = 0; i < 120; i++) {
				const r = await p.evaluate(() => { const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]')); return typeof g.sendEvent === 'function' && !!g.whoseTurn; }).catch(() => false);
				if (r) return;
				await sleep(500);
			}
			throw new Error('game screen not ready');
		};
		await ready(pageA);
		await ready(pageB);
		const room = () => pageA.evaluate(async (c) => (await firebase.database().ref('rooms/' + c).once('value')).val(), code);
		const st = await room();
		const uidA = await pageA.evaluate(() => firebase.auth().currentUser.uid);
		const redP = st.red.uid === uidA ? pageA : pageB;
		const blueP = redP === pageA ? pageB : pageA;
		const g = (p, expr) => p.evaluate((e) => (new Function('g', 'return ' + e))(Alpine.$data(document.querySelector('[x-data^="gameBoard"]'))), expr);
		const until = async (p, expr, ms, what) => {
			const t0 = Date.now();
			while (Date.now() - t0 < ms) {
				if (await g(p, expr).catch(() => false)) return true;
				await sleep(250);
			}
			throw new Error('timed out waiting for ' + what + ' (' + expr + ')');
		};
		const turnsInRoom = async () => Object.keys((await room()).turns || {}).length;
		const play = async (p, pick) => {
			await until(p, "g.awaiting === 'action' && g.actionList.includes('move')", 30000, 'a move prompt');
			const node = pick ? await pick() : await g(p, 'Object.keys(g.validMoves)[0]');
			await p.click('#stone-node--' + node);
			await until(p, "g.actionList.includes('pass')", 30000, 'the end-turn prompt');
			await p.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).handleEndTurn());
			return node;
		};

		// ---- 1. Queue during red's turn; red has none on its own.
		await until(blueP, "g.whoseTurn === 'red'", 30000, 'red to move');
		check('red cannot pre-move on its own turn', !(await g(redP, 'g.canPremove')));
		check('blue can pre-move while red moves', await g(blueP, 'g.canPremove'));
		await blueP.click('#stone-node--b11');
		check('a click on a node queues it', (await g(blueP, 'g.premove')) === 'b11');
		check('the node is marked', await blueP.$eval('#stone-node--b11', (el) => el.classList.contains('stone-node--premove') && el.classList.contains('stone-node--premove-blue')));
		check('the line names it', /Pre-move: b11/.test(await blueP.$eval('.premove-line', (el) => el.textContent.replace(/\s+/g, ' '))));
		await blueP.click('#stone-node--b11');
		check('a second click cancels it', (await g(blueP, 'g.premove')) === '');
		await blueP.click('#stone-node--b11');

		// ---- 2. Red moves; blue's placement is played on arrival.
		await play(redP, async () => 'a2');
		await until(blueP, "g.nodes.b11 === 'blue' && g.actionList.includes('pass')", 30000, 'the pre-move to be played');
		check('the pre-move is placed when the turn comes, and the turn waits for blue', (await g(blueP, 'g.premove')) === '' && (await g(blueP, "g.whoseTurn")) === 'blue');
		check('nothing is sent before blue ends the turn', (await turnsInRoom()) === 1);
		await blueP.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).handleEndTurn());
		let r = null;
		for (let i = 0; i < 40; i++) {
			r = await room();
			if (Object.keys(r.turns || {}).length === 2) break;
			await sleep(250);
		}
		const blueTurn = Object.values(r.turns).find((t) => t.color === 'blue');
		check('then the room holds the placement like a clicked one', blueTurn && blueTurn.actions[0] === 'b11', blueTurn);
		await until(redP, "g.nodes.b11 === 'blue'", 30000, 'red to see it');
		check('red sees it', true);

		// ---- 3. An illegal pre-move is dropped.
		await until(blueP, "g.whoseTurn === 'red'", 30000, 'red to move again');
		const far = await blueP.evaluate(() => {
			const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			const legal = getStandardMoveTargets(g._engine.board, 'blue', true);
			return NODE_ORDER.find((n) => !g.nodes[n] && !legal[n] && n !== 'a3' && n !== 'a1');
		});
		await blueP.click('#stone-node--' + far);
		check('a node blue cannot reach is queued anyway (legality is judged on arrival)', (await g(blueP, 'g.premove')) === far, far);
		await play(redP);
		await until(blueP, "g.whoseTurn === 'blue' && g.actionList.includes('move')", 30000, 'blue to move');
		await until(blueP, "g.premove === '' && /no longer a legal placement/.test(g.premoveNote)", 10000, 'the cancel note');
		check('it is dropped with a note and blue moves by hand', !(await g(blueP, 'g.nodes["' + far + '"]')), await g(blueP, 'g.premoveNote'));
		await play(blueP);

		// ---- 4. Escape, and the setting.
		await until(blueP, "g.whoseTurn === 'red' && g.canPremove", 30000, 'red to move (3)');
		const pick = await g(blueP, 'Object.keys(g.nodes).find((n) => !g.nodes[n])');
		await blueP.click('#stone-node--' + pick);
		check('queued again', (await g(blueP, 'g.premove')) === pick);
		await blueP.keyboard.press('Escape');
		check('Escape drops it', (await g(blueP, 'g.premove')) === '');
		await blueP.evaluate(() => SigilSettings.set('premoves', false));
		await blueP.click('#stone-node--' + pick);
		check('with pre-moves off, a click queues nothing', (await g(blueP, 'g.premove')) === '' && !(await g(blueP, 'g.canPremove')));
		await play(redP);
		await until(blueP, "g.whoseTurn === 'blue' && g.actionList.includes('move')", 30000, 'blue to move (3)');
		await sleep(500);
		check('nothing is played for blue: it is still asked for its placement', (await g(blueP, "g.actionList.includes('move')")) && (await g(blueP, 'g.premove')) === '');
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'PREMOVE EMULATOR TEST OK' : 'PREMOVE EMULATOR TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
