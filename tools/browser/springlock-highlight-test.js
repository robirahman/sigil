// Seal of Spring shows a springlock: while a side's locked spell has been
// cast a second time through Seal of Spring, the Seal takes that side's lock
// highlight (spell--red-lock / spell--blue-lock) as well as the spell.
//
//   1. game.html, local game from a position: Grow is red's lock and red has
//      Seal of Spring charged. Only Grow carries red's highlight; after red
//      casts Grow a second time the Seal carries it too; Reset Turn removes it.
//   2. game.html from a position that already has the springlocks (red's,
//      blue's, both): the Seal carries the matching highlights on load.
//   3. Review navigation (game.html, multiplayer.html): stepping between a
//      springlocked position and one without updates the Seal.
//   4. analysis.html?sfn=<springlocked position>: the Seal carries it.
//
//   (cd docs && python3 -m http.server 8765) &
//   node tools/browser/springlock-highlight-test.js http://localhost:8765
//
// multiplayer.html runs with every non-local request blocked, so it never
// reaches Firebase.
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';

// Flourish ritual1 (a2-a6), Grow sorcery1 (a8-a10), Seal of Spring charm1 (a7).
const SPELLS = 'Flourish,Carnage,Bewitch,Grow,Hail_Storm,Meteor,Seal_of_Spring,Sprout,Slash';
const NODES = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12', 'a13',
	'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10', 'b11', 'b12', 'b13',
	'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12', 'c13'];
function sfn(red, blue, locks, springs) {
	const st = NODES.map((n) => (red.includes(n) ? 'r' : blue.includes(n) ? 'b' : '.')).join('');
	return st + '/' + SPELLS + ' r 2 1:1 ' + locks + ' ' + springs + ' b0';
}
// Red: a1 + Seal of Spring + Grow (red's lock). Blue: Bewitch on c8-c10 (blue's lock).
const RED = ['a1', 'a7', 'a8', 'a9', 'a10'];
const BLUE = ['b1', 'b2', 'c1', 'c7', 'c8', 'c9', 'c10'];
const LOCKED = sfn(RED, BLUE, 'Grow:Bewitch', '-:-');
const SPRUNG_RED = sfn(RED, BLUE, 'Grow:Bewitch', 'Grow:-');
const SPRUNG_BLUE = sfn(RED, BLUE, 'Grow:Bewitch', '-:Bewitch');
const SPRUNG_BOTH = sfn(RED, BLUE, 'Grow:Bewitch', 'Grow:Bewitch');

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

// The lock classes on each spell slot's image.
const locks = () => {
	const out = {};
	for (const img of document.querySelectorAll('img.spell')) {
		const slot = [...img.classList].map((c) => /^(charm|ritual|sorcery)-spell--(\d)$/.exec(c)).find(Boolean);
		if (!slot) continue;
		const cls = [];
		if (img.classList.contains('spell--red-lock')) cls.push('red');
		if (img.classList.contains('spell--blue-lock')) cls.push('blue');
		if (cls.length) out[slot[1] + slot[2]] = cls.join('+');
	}
	return out;
};
const sorted = (o) => (Array.isArray(o) ? o.map(sorted) : Object.fromEntries(Object.entries(o).sort()));
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

(async () => {
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	try {
		const page = await browser.newPage();
		page.on('pageerror', (e) => { console.log('pageerror:', e.message); ok = false; });
		await page.evaluateOnNewDocument(hook);
		page.on('dialog', (d) => d.accept());
		const open = async (path, s) => {
			await page.evaluate(() => { window.onbeforeunload = null; }).catch(() => {});
			await page.goto(`${BASE}/${path}?sfn=${encodeURIComponent(s)}`, { waitUntil: 'load', timeout: 90000 });
		};
		const waitPrompt = (pred) => page.waitForFunction(pred, { timeout: 30000 });
		const actionPrompt = () => !!(window.__gc && window.__gc._inputResolve && window.__last && window.__last.awaiting);
		// Answers the open prompt with `tok` ('?' = the first move target offered).
		const act = async (tok) => {
			await waitPrompt(actionPrompt);
			await page.evaluate((t) => {
				const p = window.__last;
				if (t === '?') t = Object.keys(p.moveoptions || {})[0];
				window.__last = null;
				window.__gc.handlePlayerAction(t);
			}, tok);
		};
		const settle = () => new Promise((r) => setTimeout(r, 300));
		const boardReady = () => {
			const el = document.querySelector('[x-data^="gameBoard"]');
			const c = el && el._x_dataStack && el._x_dataStack[0];
			return !!(c && c.awaiting === 'action' && document.querySelector('img.charm-spell--1.spell--visible'));
		};

		// 1. A live second cast.
		await open('game.html', LOCKED);
		await page.waitForFunction(() => window.__gc && window.__last, { timeout: 60000 });
		await settle();
		check('locked, not springlocked: Seal of Spring plain', same(await page.evaluate(locks), { sorcery1: 'red', ritual3: 'blue' }), await page.evaluate(locks));
		for (const tok of ['?', 'Grow', 'a8', '?', '?']) await act(tok);
		await waitPrompt(() => !!(window.__last && (window.__last.actionlist || []).includes('pass')));
		await settle();
		check('after the second Grow the Seal carries red\'s lock', same(await page.evaluate(locks), { sorcery1: 'red', ritual3: 'blue', charm1: 'red' }), await page.evaluate(locks));
		check('the engine agrees (springlock set)', await page.evaluate(() => window.__gc.board.springlock.red === 'Grow'));
		await act('reset');
		await waitPrompt(actionPrompt);
		await settle();
		check('Reset Turn clears the Seal', same(await page.evaluate(locks), { sorcery1: 'red', ritual3: 'blue' }), await page.evaluate(locks));

		// 2. Springlocks in the start position.
		for (const [s, want, label] of [
			[SPRUNG_RED, { sorcery1: 'red', ritual3: 'blue', charm1: 'red' }, 'red'],
			[SPRUNG_BLUE, { sorcery1: 'red', ritual3: 'blue', charm1: 'blue' }, 'blue'],
			[SPRUNG_BOTH, { sorcery1: 'red', ritual3: 'blue', charm1: 'red+blue' }, 'both'],
		]) {
			await open('game.html', s);
			await page.waitForFunction(boardReady, { timeout: 60000 });
			await settle();
			check('loaded springlock (' + label + ')', same(await page.evaluate(locks), want), await page.evaluate(locks));
		}

		// 3. Review navigation, local and online boards.
		const review = async (sel) => {
			const got = [];
			for (const i of [0, 1, 0]) {
				await page.evaluate((q, k, a, b) => {
					const c = document.querySelector(q)._x_dataStack[0];
					c.reviewSfns = [a, b];
					c.reviewIndex = k;
					c._showReviewPosition();
				}, sel, i, SPRUNG_RED, LOCKED);
				await settle();
				got.push(await page.evaluate(locks));
			}
			return got;
		};
		const wantReview = [{ sorcery1: 'red', ritual3: 'blue', charm1: 'red' }, { sorcery1: 'red', ritual3: 'blue' }, { sorcery1: 'red', ritual3: 'blue', charm1: 'red' }];
		const local = await review('[x-data^="gameBoard"]');
		check('game.html review steps the Seal', same(local, wantReview), local);

		const mp = await browser.newPage();
		mp.on('pageerror', (e) => console.log('multiplayer pageerror (offline, ignored):', e.message));
		await mp.setRequestInterception(true);
		mp.on('request', (r) => (new URL(r.url()).origin === new URL(BASE).origin || r.url().includes('alpinejs') || r.url().includes('popper')
			? r.continue() : r.abort()));
		await mp.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		// Mount the game board (it sits under the lobby's playing phase).
		await mp.waitForFunction(() => document.querySelector('[x-data^="multiplayerLobby"]')?._x_dataStack, { timeout: 30000 });
		await mp.evaluate(() => { document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].phase = 'playing'; });
		await mp.waitForFunction(() => document.querySelector('[x-data^="gameBoard"]')?._x_dataStack, { timeout: 30000 });
		await mp.evaluate((spells) => {
			const c = document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0];
			const names = spells.split(',');
			c.spellDict = Object.fromEntries(spellSlotNames().map((s, i) => [s, names[i]]));
		}, SPELLS);
		const online = [];
		for (const i of [0, 1, 0]) {
			await mp.evaluate((k, a, b) => {
				const c = document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0];
				c.reviewSfns = [a, b];
				c.reviewIndex = k;
				c._showReviewPosition();
			}, i, SPRUNG_RED, LOCKED);
			await settle();
			online.push(await mp.evaluate(locks));
		}
		check('multiplayer.html review steps the Seal', same(online, wantReview), online);
		await mp.close();

		// 4. The analysis board.
		await page.evaluate(() => { window.onbeforeunload = null; });
		await open('analysis.html', SPRUNG_BLUE);
		await page.waitForFunction(() => document.querySelector('img.charm-spell--1.spell--visible'), { timeout: 60000 });
		await settle();
		check('analysis board shows blue\'s springlock', same(await page.evaluate(locks), { sorcery1: 'red', ritual3: 'blue', charm1: 'blue' }), await page.evaluate(locks));
		await page.evaluate(() => { window.onbeforeunload = null; });
	} catch (e) {
		console.log('ERROR', e.message);
		ok = false;
	} finally {
		await browser.close();
	}
	console.log(ok ? 'springlock-highlight-test: PASS' : 'springlock-highlight-test: FAIL');
	process.exit(ok ? 0 : 1);
})();
