// Take back in a game vs the AI (game.html "Take back"): the player's last
// turn and the AI's reply are undone through the save + resume path.
//   1. After three turns each, Take back leaves the first two of each, on
//      the exact position the player had before their third turn.
//   2. The game is marked as taken back (unrated) and play goes on normally.
//   3. Taking back Red's first turn returns to the starting position.
//
//   (cd docs && python3 -m http.server 8765) &
//   node tools/browser/takeback-test.js http://localhost:8765
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';

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

function hook() {
	const t = setInterval(() => {
		if (typeof GameController === 'undefined' || GameController.prototype.__hooked) return;
		const start = GameController.prototype.startGame;
		GameController.prototype.startGame = function (...a) {
			window.__gc = this;
			const emit = this.emit;
			this.emit = (p) => { if (p && p.awaiting) window.__last = p; emit(p); };
			return start.apply(this, a);
		};
		GameController.prototype.__hooked = true;
		clearInterval(t);
	}, 1);
}
const humanPrompt = () => !!(window.__gc && window.__gc._inputResolve && window.__last
	&& window.__last.awaiting === 'action' && Object.keys(window.__last.moveoptions || {}).length > 0);
const passPrompt = () => !!(window.__gc && window.__gc._inputResolve && window.__last
	&& window.__last.awaiting === 'action' && (window.__last.actionlist || []).includes('pass'));

async function humanTurns(page, n) {
	for (let i = 0; i < n; i++) {
		await page.waitForFunction(humanPrompt, { timeout: 60000 });
		await page.evaluate(() => { const n = Object.keys(window.__last.moveoptions)[0]; window.__last = null; window.__gc.handlePlayerAction(n); });
		await page.waitForFunction(passPrompt, { timeout: 60000 });
		await page.evaluate(() => { window.__last = null; window.__gc.handlePlayerAction('pass'); });
	}
	await page.waitForFunction(humanPrompt, { timeout: 60000 });
}

function state(page) {
	return page.evaluate(() => {
		const id = new URLSearchParams(location.search).get('id');
		const key = Object.keys(localStorage).find((k) => k.includes(id));
		const save = key ? JSON.parse(localStorage.getItem(key)) : null;
		return {
			log: window.__gc._gameLog.map((t) => t.turnNumber),
			sfnAfter: window.__gc._gameLog.map((t) => t.sfnAfter || null),
			board: boardToSfn(window.__gc.board),
			tookBack: !!(save && save.tookBack),
		};
	});
}

async function takeBack(page) {
	await page.waitForFunction(() => {
		const g = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
		return typeof g.canTakeBack === 'function' && g.canTakeBack();
	}, { timeout: 30000, polling: 200 });
	await page.evaluate(() => { window.onbeforeunload = null; });
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }),
		page.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).handleTakeBack()),
	]);
	await page.waitForFunction(humanPrompt, { timeout: 60000 });
}

(async () => {
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	try {
		const page = await browser.newPage();
		page.on('pageerror', (e) => console.log('pageerror:', e.message));
		await page.setBypassServiceWorker(true);
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const url = req.url();
			if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		await page.evaluateOnNewDocument(hook);
		await page.goto(`${BASE}/game.html?ai=rust_easy`, { waitUntil: 'load', timeout: 90000 });
		await humanTurns(page, 2);
		const prompt3 = await state(page);
		await humanTurns(page, 1);
		const before = await state(page);
		check('three turns each', before.log.length === prompt3.log.length + 2, before.log);
		await takeBack(page);
		const after = await state(page);
		check('take back removes the last turn and the reply', after.log.join() === prompt3.log.join(), after.log);
		check('on the position before that turn', after.board === prompt3.board, { board: after.board, want: prompt3.board });
		check('marked as taken back', after.tookBack);
		await humanTurns(page, 1);
		const later = await state(page);
		check('play goes on', later.log.join() === before.log.join(), later.log);

		// A new game as Red: take back the very first turn of the game.
		await page.evaluate(() => { window.onbeforeunload = null; sessionStorage.setItem('sigil_rematch_human_color', 'red'); });
		await page.goto(`${BASE}/game.html?ai=rust_easy`, { waitUntil: 'load', timeout: 90000 });
		await page.waitForFunction(humanPrompt, { timeout: 60000 });
		const start = await state(page);
		await humanTurns(page, 1);
		await takeBack(page);
		const back = await state(page);
		check('back to the start', start.log.length === 0 && back.log.length === 0 && back.board === start.board, { log: back.log, board: back.board, start: start.board });
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	} finally {
		await browser.close();
	}
	console.log(ok ? 'TAKEBACK TEST OK' : 'TAKEBACK TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
