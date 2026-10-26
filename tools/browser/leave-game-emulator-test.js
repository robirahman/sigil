// "Leave this game?" on multiplayer.html (guardLeavingGame, game-keys.js), on
// the Firebase emulators (no live database): two guests play a live game.
//   1. A seated player's same-tab link (the logo) asks first and stays put;
//      the text warns that the clock runs and the opponent can claim.
//   2. A spectator's logo leaves at once.
//   3. Once the game is over, the winner's Main Menu leaves at once.
//
//   (cd docs && python3 -m http.server 8765) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/leave-game-emulator-test.js http://localhost:8765'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';
const NS = 'sigil-js-default-rtdb';

// Point the page's Firebase at the emulators as soon as the app exists.
function useEmulators() {
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

const LOBBY = '[x-data^="multiplayerLobby"]';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`http://127.0.0.1:9000/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	const dialogs = [];
	try {
		const pages = [];
		for (let i = 0; i < 3; i++) {
			const ctx = await browser.createBrowserContext();
			const p = await ctx.newPage();
			await p.evaluateOnNewDocument(useEmulators);
			await p.evaluateOnNewDocument(() => {
				window.G = () => Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			});
			await p.setBypassServiceWorker(true);
			await p.setRequestInterception(true);
			p.on('request', (req) => {
				const url = req.url();
				if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
				sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }),
					() => req.continue());
			});
			p.on('pageerror', (e) => console.log('pageerror:', e.message));
			p.on('dialog', (d) => { dialogs.push(d.type()); d.accept(); });
			pages.push(p);
		}
		const [pageA, pageB, pageC] = pages;
		const onPage = (p) => new URL(p.url()).pathname.endsWith('/multiplayer.html');
		const dialogOpen = (p) => p.evaluate(() => {
			const d = document.querySelector('.leave-game');
			return !!d && !d.hidden;
		});
		const ready = async (p) => {
			for (let i = 0; i < 120; i++) {
				const r = await p.evaluate(() => {
					const el = document.querySelector('[x-data^="gameBoard"]');
					if (!el || !window.Alpine) return false;
					const g = Alpine.$data(el);
					return typeof g.sendEvent === 'function' && (!!g.whoseTurn || g.isSpectator);
				}).catch(() => false);
				if (r) return;
				await sleep(500);
			}
			throw new Error('game screen not ready');
		};

		await pageA.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		await pageA.waitForFunction((s) => !!document.querySelector(s)._x_dataStack, { timeout: 30000 }, LOBBY);
		await pageA.evaluate(async (s) => { await document.querySelector(s)._x_dataStack[0].createRoom(); }, LOBBY);
		await pageA.waitForFunction((s) => document.querySelector(s)._x_dataStack[0].phase === 'waiting', { timeout: 30000 }, LOBBY);
		const code = await pageA.evaluate((s) => document.querySelector(s)._x_dataStack[0].roomCode, LOBBY);
		await pageB.goto(`${BASE}/multiplayer.html?id=${code}`, { waitUntil: 'load', timeout: 90000 });
		await ready(pageA);
		await ready(pageB);

		// 1. A seated player is asked.
		await pageA.click('header .logo a');
		await sleep(300);
		check('player: the logo asks first', await dialogOpen(pageA) && onPage(pageA));
		const text = await pageA.$eval('.leave-game__text', (e) => e.textContent);
		check('player: the text warns about the claim', /opponent can claim the win/.test(text) && /60 s/.test(text), text);
		await pageA.keyboard.press('Escape');
		await sleep(200);
		check('player: Escape closes it', !(await dialogOpen(pageA)));

		// 2. A spectator is not.
		await pageC.goto(`${BASE}/multiplayer.html?id=${code}`, { waitUntil: 'load', timeout: 90000 });
		await pageC.waitForFunction(() => {
			const el = document.querySelector('[x-data^="gameBoard"]');
			return el && window.Alpine && Alpine.$data(el).isSpectator;
		}, { timeout: 60000, polling: 500 });
		await Promise.all([
			pageC.waitForNavigation({ timeout: 30000 }),
			pageC.click('header .logo a'),
		]);
		check('spectator: the logo leaves at once', !onPage(pageC), pageC.url());

		// 3. After game over, nobody is asked.
		await pageA.evaluate(() => { G().handleForfeit(); G().handleForfeit(); });
		await pageB.waitForFunction(() => !!G().winner, { timeout: 30000, polling: 500 });
		const menu = '.win-modal.is-visible a.win-modal__btn[href="./"]';
		await pageB.waitForSelector(menu, { visible: true, timeout: 30000 });
		await Promise.all([
			pageB.waitForNavigation({ timeout: 30000 }),
			pageB.click(menu),
		]);
		check('game over: Main Menu leaves at once', !onPage(pageB), pageB.url());
		check('no browser prompts', dialogs.length === 0, dialogs);
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'LEAVE GAME EMULATOR TEST OK' : 'LEAVE GAME EMULATOR TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
