// Zen mode and arrows inside a live multiplayer game (multiplayer.html).
//
//   (cd docs && python3 -m http.server 8809) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/board-tools-emulator-test.js http://localhost:8809'
//
// DB_EMULATOR_PORT / AUTH_EMULATOR_PORT override the default 9000 / 9099,
// for a private emulator config.
//
// Two guests: A creates a room, B joins. Checks:
// - the lobby is not a zen page and Z does nothing there;
// - in the game Z hides the header, log, share link, names and Forfeit and
//   keeps the board, the timer bar and the turn buttons; the opponent's
//   page is unaffected; Z again leaves zen;
// - an arrow drawn by the player to move stays on their page only, and
//   a click on a legal node still plays it.
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8809';
const NS = 'sigil-js-default-rtdb';
const DB_PORT = Number(process.env.DB_EMULATOR_PORT) || 9000;
const AUTH_PORT = Number(process.env.AUTH_EMULATOR_PORT) || 9099;

function useEmulators(dbPort, authPort) {
	let fb;
	Object.defineProperty(window, 'firebase', {
		configurable: true,
		get() { return fb; },
		set(v) {
			fb = v;
			const init = v.initializeApp.bind(v);
			v.initializeApp = (...args) => {
				const app = init(...args);
				app.auth().useEmulator('http://127.0.0.1:' + authPort, { disableWarnings: true });
				app.database().useEmulator('127.0.0.1', dbPort);
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const visible = (page, sel) => page.evaluate((s) => {
	const el = document.querySelector(s);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0;
}, sel);
const game = (page) => page.evaluate(() => {
	const d = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
	return {
		whose: d.whoseTurn, my: d.myColor, actions: [...d.actionList],
		valid: Object.keys(d.validMoves).filter(k => d.validMoves[k]),
		stones: Object.keys(d.nodes).filter(k => d.nodes[k] === 'red' || d.nodes[k] === 'blue').sort(),
	};
});
const markCount = (page) => page.evaluate(() => document.querySelectorAll('.board-marks .board-mark').length);

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`http://127.0.0.1:${DB_PORT}/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	const errors = [];
	try {
		const pages = [];
		for (let i = 0; i < 2; i++) {
			const ctx = await browser.createBrowserContext();
			const p = await ctx.newPage();
			await p.setViewport({ width: 1200, height: 900 });
			await p.evaluateOnNewDocument(useEmulators, DB_PORT, AUTH_PORT);
			await p.setBypassServiceWorker(true);
			await p.setRequestInterception(true);
			p.on('request', (req) => {
				const url = req.url();
				if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
				sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }),
					() => req.continue());
			});
			p.on('pageerror', (e) => errors.push(e.message));
			pages.push(p);
		}
		const [pageA, pageB] = pages;
		const lobbyData = 'document.querySelector(\'[x-data^="multiplayerLobby"]\')._x_dataStack[0]';

		await pageA.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		await pageA.waitForFunction(() => !!document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack && document.getElementById('settings-panel'), { timeout: 30000 });
		await sleep(300);
		await pageA.keyboard.press('z');
		check('lobby: not a zen page, Z does nothing', await pageA.evaluate(() =>
			!document.body.classList.contains('zen-page') && !document.documentElement.hasAttribute('data-zen')));

		await pageA.evaluate(`${lobbyData}.createRoom()`);
		await pageA.waitForFunction(`${lobbyData}.phase === 'waiting'`, { timeout: 30000 });
		const code = await pageA.evaluate(`${lobbyData}.roomCode`);
		await pageB.goto(`${BASE}/multiplayer.html?id=${code}`, { waitUntil: 'load', timeout: 90000 });
		for (const p of pages) {
			await p.waitForFunction(() => {
				const el = document.querySelector('[x-data^="gameBoard"]');
				return el && window.Alpine && Alpine.$data(el).whoseTurn;
			}, { timeout: 60000 });
		}
		check('in the game both pages are zen pages', (await Promise.all(pages.map(p => p.evaluate(() => document.body.classList.contains('zen-page'))))).every(Boolean));

		// The player to move.
		await sleep(500);
		const gA = await game(pageA);
		const mover = gA.whose === gA.my ? pageA : pageB;
		const other = mover === pageA ? pageB : pageA;
		await mover.waitForFunction(() => Object.values(Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).validMoves).some(Boolean), { timeout: 30000 });

		await mover.evaluate(() => document.activeElement && document.activeElement.blur());
		await mover.keyboard.press('z');
		check('Z turns zen on in the game', await mover.evaluate(() => document.documentElement.hasAttribute('data-zen')));
		check('zen hides the header', !(await visible(mover, 'header .header-container')));
		check('zen hides the game log', !(await visible(mover, '.feed--history')));
		check('zen hides the share link', !(await visible(mover, '.in-game-share')));
		check('zen hides the player names', !(await visible(mover, '.ladder-details .name')));
		check('zen hides Forfeit', !(await visible(mover, '.action-button--forfeit')));
		check('zen keeps the board', await visible(mover, '.game-board-container'));
		check('zen keeps the timer bar', await visible(mover, '.ladder-details .timer'));
		check('zen shows the exit button', await visible(mover, '.zen-exit'));
		check('the opponent is not in zen', await other.evaluate(() => !document.documentElement.hasAttribute('data-zen')) && await visible(other, 'header .header-container'));

		// An arrow on the mover's board, then a real move under it.
		const g = await game(mover);
		const all = await mover.evaluate(() => Object.keys(Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).nodes));
		const from = g.valid[0], to = all.find(n => n !== from);
		const centre = (n) => mover.$eval('#stone-node--' + n, el => {
			el.scrollIntoView({ block: 'center', inline: 'center' });
			const r = el.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		});
		const a = await centre(from);
		await mover.mouse.move(a.x, a.y);
		await mover.mouse.down({ button: 'right' });
		const b = await mover.$eval('#stone-node--' + to, el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
		await mover.mouse.move(b.x, b.y, { steps: 6 });
		await mover.mouse.up({ button: 'right' });
		await sleep(100);
		check('a right-drag draws an arrow in the game', await markCount(mover) === 1);
		check('the opponent does not see it', await markCount(other) === 0);
		const c = await centre(from);
		await mover.mouse.click(c.x, c.y);
		await mover.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).actionList.includes('pass'), { timeout: 20000 });
		check('a click under the arrow plays the node', (await game(mover)).stones.includes(from));
		check('zen keeps End Turn', await visible(mover, '.action-button--end-turn'));
		await mover.click('.action-button--end-turn');
		await mover.waitForFunction(() => {
			const d = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			return d.whoseTurn && d.whoseTurn !== d.myColor;
		}, { timeout: 20000 });
		await sleep(200);
		check('End Turn clears the arrow', await markCount(mover) === 0);

		await mover.keyboard.press('z');
		check('Z again leaves zen', await mover.evaluate(() => !document.documentElement.hasAttribute('data-zen')) && await visible(mover, 'header .header-container'));
	} catch (e) {
		console.log('FAIL exception: ' + (e.stack || e));
		ok = false;
	}
	const ours = errors.filter(m => !/INTERNAL|firebase is not defined/.test(m));
	check('no page errors', ours.length === 0, ours);
	await browser.close();
	console.log(ok ? 'BOARD TOOLS EMULATOR TEST OK' : 'BOARD TOOLS EMULATOR TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
