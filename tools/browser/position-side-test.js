// A game vs AI from a position: the side picker evaluates the start, the
// player's choice seats them, and the game's setup SFN is the priced start
// (so the finished record carries startPos and can be rated).
//
//   1. game.html?ai=rust_easy&sfn=<S>: the picker shows an engine eval and
//      odds from a live search; choosing Blue seats the human as Blue.
//   2. After the first human turn the local save holds fromPosition, the
//      startPos (source 'live') and a setupSfn equal to startPos.sfn.
//   3. A review handoff (sessionStorage sigil_rematch_startpos) is used
//      instead of a search: source 'review', the handed depth.
//
//   (cd docs && python3 -m http.server 8765) &
//   node tools/browser/position-side-test.js http://localhost:8765
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';
const SFN = 'r.........r..bbbbbbb.......rr.....rr..r/Bewitch,Seal_of_Lightning,Starfall,Meteor,Grow,Hail_Storm,Slash,Surge,Sprout r 13 0:0 -:- -:- b1';

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
const comp = () => document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0];
const humanPrompt = () => !!(window.__gc && window.__gc._inputResolve && window.__last
	&& window.__last.awaiting === 'action' && Object.keys(window.__last.moveoptions || {}).length > 0);
const passPrompt = () => !!(window.__gc && window.__gc._inputResolve && window.__last
	&& window.__last.awaiting === 'action' && (window.__last.actionlist || []).includes('pass'));

async function offer(page) {
	await page.waitForFunction(() => {
		const c = document.querySelector('[x-data^="gameBoard"]');
		const o = c && c._x_dataStack && c._x_dataStack[0].sideOffer;
		return o && !o.loading;
	}, { timeout: 120000 });
	return page.evaluate(() => JSON.parse(JSON.stringify(document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0].sideOffer)));
}

async function firstHumanTurn(page) {
	await page.waitForFunction(humanPrompt, { timeout: 120000 });
	await page.evaluate(() => { const n = Object.keys(window.__last.moveoptions)[0]; window.__last = null; window.__gc.handlePlayerAction(n); });
	await page.waitForFunction(passPrompt, { timeout: 60000 });
	await page.evaluate(() => { window.__last = null; window.__gc.handlePlayerAction('pass'); });
	await page.waitForFunction(() => {
		const id = new URLSearchParams(location.search).get('id');
		const key = Object.keys(localStorage).find((k) => k.includes(id));
		return key && JSON.parse(localStorage.getItem(key)).setupSfn;
	}, { timeout: 60000 });
	return page.evaluate(() => {
		const id = new URLSearchParams(location.search).get('id');
		const key = Object.keys(localStorage).find((k) => k.includes(id));
		return JSON.parse(localStorage.getItem(key));
	});
}

(async () => {
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	try {
		// 1-2. Live evaluation.
		let page = await browser.newPage();
		page.on('pageerror', (e) => console.log('pageerror:', e.message));
		await page.evaluateOnNewDocument(hook);
		await page.goto(`${BASE}/game.html?ai=rust_easy&sfn=${encodeURIComponent(SFN)}`, { waitUntil: 'load', timeout: 90000 });
		const o = await offer(page);
		check('picker shows an engine eval', /^Engine: /.test(o.evalText), o);
		check('picker shows odds', /wins|forced win/.test(o.oddsText), o.oddsText);
		check('engine not started before the choice', await page.evaluate(() => !window.__gc));
		await page.evaluate(() => document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0].chooseSide('blue'));
		await page.waitForFunction(() => window.__gc, { timeout: 30000 });
		check('human seated as Blue', await page.evaluate(() => window.__gc.aiColor === 'red'
			&& document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0].myColor === 'blue'));
		const save = await firstHumanTurn(page);
		check('save marks fromPosition', save.fromPosition === true);
		check('save holds a live startPos', !!save.startPos && save.startPos.source === 'live'
			&& typeof save.startPos.redWinProb === 'number', save.startPos);
		check('setupSfn is the priced start', save.startPos && save.setupSfn === save.startPos.sfn,
			{ setup: save.setupSfn, priced: save.startPos && save.startPos.sfn });
		await page.evaluate(() => { window.onbeforeunload = null; });
		await page.close();

		// 3. Review handoff.
		page = await browser.newPage();
		page.on('pageerror', (e) => console.log('pageerror:', e.message));
		await page.evaluateOnNewDocument(hook);
		await page.goto(`${BASE}/index.html`, { waitUntil: 'load', timeout: 90000 });
		await page.evaluate((sfn) => sessionStorage.setItem('sigil_rematch_startpos', JSON.stringify({
			sfn, info: { depth: 6, stones: 1.5, mateIn: null, proven: true }, hist: [] })), SFN);
		await page.goto(`${BASE}/game.html?ai=rust_easy&sfn=${encodeURIComponent(SFN)}`, { waitUntil: 'load', timeout: 90000 });
		const o2 = await offer(page);
		check('handed eval used', o2.evalText === 'Engine: +1.5', o2.evalText);
		await page.evaluate(() => document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0].chooseSide('red'));
		const save2 = await firstHumanTurn(page);
		check('review startPos', save2.startPos && save2.startPos.source === 'review' && save2.startPos.depth === 6, save2.startPos);
		await page.evaluate(() => { window.onbeforeunload = null; });
	} catch (e) {
		console.log('ERROR', e.message);
		ok = false;
	} finally {
		await browser.close();
	}
	console.log(ok ? 'position-side-test: PASS' : 'position-side-test: FAIL');
	process.exit(ok ? 0 : 1);
})();
