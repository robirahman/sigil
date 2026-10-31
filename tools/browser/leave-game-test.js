// "Leave this game?" on game.html (guardLeavingGame, game-keys.js): a
// same-tab link asks first while a local or AI game is live.
//   1. Local 1v1: the logo opens the dialog and the page stays; Stay and
//      Escape close it; after a turn the text says the game is saved.
//   2. A link that opens a new tab, or the page's own Rules menu, doesn't ask.
//   3. Leave game goes to the main menu with no browser prompt on top.
//   4. vs AI: the dialog opens too.
//   5. After game over, and in review, the logo leaves at once.
//   6. The analysis board (same component) never asks.
//   7. An old service worker's cached copies live under the unversioned
//      URLs; game.html loads ?v=35 ones, so it keeps the guard and styles.
//
//   (cd docs && python3 -m http.server 8765) &
//   node tools/browser/leave-game-test.js http://localhost:8765
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';

let failures = 0;
function check(label, ok, detail) {
	console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
	if (!ok) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

async function newPage(browser, errors, dialogs, intercept) {
	const ctx = await browser.createBrowserContext();
	const page = await ctx.newPage();
	await page.setBypassServiceWorker(true);
	await page.setRequestInterception(true);
	page.on('request', (r) => {
		const u = r.url();
		if (/firebaseio\.com|identitytoolkit|securetoken|firebaseinstallations/.test(u)) return r.abort();
		if (u.startsWith('https://www.gstatic.com/firebasejs/')) {
			return sdk(u).then((body) => r.respond({ status: 200, contentType: 'text/javascript', body }), () => r.continue());
		}
		if (intercept && intercept(r)) return;
		r.continue();
	});
	page.on('pageerror', (e) => errors.push(page.url().replace(BASE, '') + ': ' + e.message));
	// Any native prompt (beforeunload, confirm) is recorded and accepted.
	page.on('dialog', (d) => { dialogs.push(d.type()); d.accept(); });
	await page.setViewport({ width: 1200, height: 900 });
	await page.evaluateOnNewDocument(() => {
		window.G = () => Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
	});
	return page;
}

const dialogOpen = (page) => page.evaluate(() => {
	const d = document.querySelector('.leave-game');
	return !!d && !d.hidden;
});
const ready = (page) => page.waitForFunction(() => {
	const el = document.querySelector('[x-data^="gameBoard"]');
	if (!el || !window.Alpine) return false;
	const g = Alpine.$data(el);
	return typeof g.sendEvent === 'function' && g.actionList.length > 0;
}, { timeout: 60000, polling: 200 });
const path = (page) => new URL(page.url()).pathname;

(async () => {
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
	const errors = [];
	try {
		// ---- 1-3. Local 1v1.
		let dialogs = [];
		let page = await newPage(browser, errors, dialogs);
		await page.goto(`${BASE}/game.html`, { waitUntil: 'load', timeout: 90000 });
		await ready(page);
		await page.click('header .logo a');
		await sleep(300);
		check('local: the logo asks first', await dialogOpen(page), path(page));
		check('local: the page stays', path(page).endsWith('/game.html'), path(page));
		const text = await page.$eval('.leave-game__text', (e) => e.textContent);
		check('local: dialog says the game is in progress', /still in progress/.test(text), text);
		check('local: focus moves to Stay', await page.evaluate(() => document.activeElement && document.activeElement.textContent) === 'Stay');
		await page.keyboard.press('Escape');
		await sleep(200);
		check('local: Escape closes it', !(await dialogOpen(page)));
		check('local: Escape left the game alone', await page.evaluate(() => G().winner === '' && G().actionList.length > 0));

		// One turn: the game is now saved, and the dialog says where.
		await page.evaluate(() => G().sendEvent('a2'));
		await page.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).actionList.includes('pass'), { timeout: 30000, polling: 200 });
		await page.evaluate(() => G().handleEndTurn());
		await sleep(500);
		await page.click('header .logo a');
		await sleep(300);
		const text2 = await page.$eval('.leave-game__text', (e) => e.textContent);
		check('local: after a turn the game is said to be saved', /In progress/.test(text2), text2);
		await page.evaluate(() => [...document.querySelectorAll('.leave-game button')].find(b => b.textContent === 'Stay').click());
		await sleep(200);
		check('local: Stay closes it', !(await dialogOpen(page)));

		// A new-tab link (Rules > Tutorial) doesn't ask.
		const newTab = new Promise((r) => browser.once('targetcreated', r));
		await page.evaluate(() => document.querySelector('a[href="tutorial.html"][target="_blank"]').click());
		await Promise.race([newTab, sleep(5000)]);
		await sleep(300);
		check('local: a new-tab link does not ask', !(await dialogOpen(page)) && path(page).endsWith('/game.html'));

		await page.click('header .logo a');
		await sleep(300);
		await Promise.all([
			page.waitForNavigation({ timeout: 30000 }),
			page.evaluate(() => [...document.querySelectorAll('.leave-game button')].find(b => b.textContent === 'Leave game').click()),
		]);
		check('local: Leave game goes to the main menu', !path(page).endsWith('/game.html'), path(page));
		check('local: no browser prompt on top of the dialog', dialogs.length === 0, dialogs);
		await page.browserContext().close();

		// ---- 4. vs AI.
		dialogs = [];
		page = await newPage(browser, errors, dialogs);
		await page.goto(`${BASE}/game.html?ai=rust_easy`, { waitUntil: 'load', timeout: 90000 });
		await ready(page);
		await page.click('header .logo a');
		await sleep(300);
		check('ai: the logo asks first', await dialogOpen(page) && path(page).endsWith('/game.html'));
		await page.keyboard.press('Escape');

		// ---- 5. Game over, and review: no question.
		await page.evaluate(() => { G().handleForfeit(); G().handleForfeit(); });
		await page.waitForFunction(() => !!Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).winner, { timeout: 30000, polling: 200 });
		await Promise.all([
			page.waitForNavigation({ timeout: 30000 }),
			page.click('header .logo a'),
		]);
		check('ai, game over: the logo leaves at once', !path(page).endsWith('/game.html') && dialogs.length === 0, { path: path(page), dialogs });
		await page.browserContext().close();

		// Local, game over: the win modal's Main Menu, then the logo in review.
		const overLocal = async () => {
			dialogs = [];
			page = await newPage(browser, errors, dialogs);
			await page.goto(`${BASE}/game.html`, { waitUntil: 'load', timeout: 90000 });
			await ready(page);
			await page.evaluate(() => G().sendEvent('a2'));
			await page.waitForFunction(() => G().actionList.includes('pass'), { timeout: 30000, polling: 200 });
			await page.evaluate(() => G().handleEndTurn());
			await sleep(500);
			await page.evaluate(() => { G().handleForfeit(); G().handleForfeit(); });
			await page.waitForSelector('.win-modal.is-visible a.win-modal__btn[href="./"]', { visible: true, timeout: 30000 });
		};
		await overLocal();
		await Promise.all([
			page.waitForNavigation({ timeout: 30000 }),
			// A DOM click: the modal may still be fading in under the pointer.
			page.$eval('.win-modal.is-visible a.win-modal__btn[href="./"]', (el) => el.click()),
		]);
		check('game over: Main Menu leaves at once', !path(page).endsWith('/game.html') && dialogs.length === 0, { path: path(page), dialogs });
		await page.browserContext().close();
		await overLocal();
		await page.evaluate(() => G().startReview());
		await sleep(300);
		check('review mode is on', await page.evaluate(() => G().reviewMode));
		await Promise.all([
			page.waitForNavigation({ timeout: 30000 }),
			page.click('header .logo a'),
		]);
		check('review: the logo leaves at once', !path(page).endsWith('/game.html') && dialogs.length === 0, { path: path(page), dialogs });
		await page.browserContext().close();

		// ---- 6. The analysis board never asks.
		dialogs = [];
		page = await newPage(browser, errors, dialogs);
		await page.goto(`${BASE}/analysis.html`, { waitUntil: 'load', timeout: 90000 });
		await page.waitForFunction(() => !!window.Alpine && !!document.querySelector('[x-data^="gameBoard"]'), { timeout: 60000 });
		await sleep(1500);
		await Promise.all([
			page.waitForNavigation({ timeout: 30000 }),
			page.click('header .logo a'),
		]);
		check('analysis: the logo leaves at once', !path(page).endsWith('/analysis.html') && dialogs.length === 0, { path: path(page), dialogs });
		await page.browserContext().close();

		// ---- 7. An old worker's cache: the unversioned URLs answer with the
		// previous build (no guardLeavingGame, no moved game.html rules). The
		// page loads ?v=35 URLs, so it still gets the guard and the styles.
		dialogs = [];
		const local = async (rel) => (await fetch(BASE + '/' + rel)).text();
		const oldKeys = (await local('static/scripts/game-keys.js')).replace('function guardLeavingGame(', 'function _notYetShipped(');
		const oldBoard = (await local('static/scripts/game-board-local.js')).replace(/if \(typeof guardLeavingGame === 'function'\) guardLeavingGame\(/, 'void (');
		const css = await local('static/css/styles.css');
		const oldCss = css.slice(0, css.indexOf('/* --- game.html (moved from its inline <style>) --- */'));
		const oldServed = [];
		page = await newPage(browser, errors, dialogs, (r) => {
			const u = r.url();
			const old = u.endsWith('/static/scripts/game-keys.js') ? ['text/javascript', oldKeys]
				: u.endsWith('/static/scripts/game-board-local.js?v=34') ? ['text/javascript', oldBoard]
				: u.endsWith('/static/css/styles.css') ? ['text/css', oldCss] : null;
			if (!old) return false;
			oldServed.push(u.replace(BASE, ''));
			r.respond({ status: 200, contentType: old[0], body: old[1] });
			return true;
		});
		await page.goto(`${BASE}/game.html`, { waitUntil: 'load', timeout: 90000 });
		await ready(page);
		check('stale cache: game.html requests none of the old URLs', oldServed.length === 0, oldServed);
		check('stale cache: the moved rules apply', await page.evaluate(() => getComputedStyle(document.querySelector('body > header')).position === 'absolute'));
		await page.click('header .logo a');
		await sleep(300);
		check('stale cache: the logo still asks', await dialogOpen(page));
		await page.browserContext().close();
	} catch (e) {
		check('exception', false, e.message);
	}
	check('no page errors', errors.length === 0, errors.slice(0, 5));
	await browser.close();
	console.log(failures ? `LEAVE GAME TEST FAILED (${failures})` : 'LEAVE GAME TEST OK');
	process.exit(failures ? 1 : 0);
})();
