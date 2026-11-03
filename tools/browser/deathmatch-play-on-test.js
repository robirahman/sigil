// Play On as Deathmatch (game-over menu of a regular game).
//
//   1. deathmatchPlayOnSfn: a regular final SFN becomes the same position
//      tagged Deathmatch with the spell counters zeroed (Providence banks
//      kept); Deathmatch / Scramble games, positions the regular rules do not
//      end (threefold repetition) and a side with no stones get null.
//   2. game.html vs the AI: after a regular game ends on the board the
//      game-over menu offers "Play On (Deathmatch)"; not after a forfeit.
//   3. Pressing it opens a Deathmatch game from the final position with the
//      same sides and no side picker; the side ahead by 3 has not won, and
//      the AI answers the human's turn.
//
//   (cd docs && python3 -m http.server 8765) &
//   node tools/browser/deathmatch-play-on-test.js http://localhost:8765
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';
const SPELLS = 'Bewitch,Seal_of_Lightning,Starfall,Meteor,Grow,Hail_Storm,Slash,Surge,Sprout';
const START = 'r.........r..bbbbbbb.......rr.....rr..r/' + SPELLS + ' r 13 0:0 -:- -:- b1';
// Red ahead by 3 after red's turn 13 (with blue's phantom stone): a regular red win.
const FINAL = 'r.r.r.rr..r..bbbbbbb.......rr.....rr..r/' + SPELLS + ' r 13 6:3 Meteor:- -:- r1';
const PLAYON = 'r.r.r.rr..r..bbbbbbb.......rr.....rr..r/' + SPELLS + ' r 13 0:0 Meteor:- -:- r1 deathmatch';

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
const playOnVisible = () => [...document.querySelectorAll('.win-modal__btn')]
	.some((b) => b.textContent.trim() === 'Play On (Deathmatch)' && b.offsetParent !== null);

(async () => {
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	try {
		const page = await browser.newPage();
		page.on('pageerror', (e) => console.log('pageerror:', e.message));
		await page.evaluateOnNewDocument(hook);
		await page.goto(`${BASE}/game.html?ai=rust_easy&sfn=${encodeURIComponent(START)}`, { waitUntil: 'load', timeout: 90000 });

		// 1. The SFN transform.
		const u = await page.evaluate((fin, sp) => ({
			regular: deathmatchPlayOnSfn(fin),
			bank: deathmatchPlayOnSfn(fin + ' pm:1:0'),
			competitive: deathmatchPlayOnSfn(fin + ' competitive'),
			deathmatch: deathmatchPlayOnSfn(fin.replace(' 6:3 ', ' 0:0 ') + ' deathmatch'),
			scramble: deathmatchPlayOnSfn(fin + ' scramble'),
			wiped: deathmatchPlayOnSfn('r.r.r.rr..r........................rr..r/' + sp + ' r 13 6:3 -:- -:- r1'),
			junk: deathmatchPlayOnSfn('nonsense'),
			// Level stones, 2 spells: not a regular ending (e.g. threefold repetition).
			unended: deathmatchPlayOnSfn('r.........r..bbbbbbb.......rr.....rr..r/' + sp + ' r 13 2:1 Meteor:- -:- b1'),
			sixth: deathmatchPlayOnSfn('r.........r..bbbbbbb.......rr.....rr..r/' + sp + ' r 13 6:3 Meteor:- -:- b1'),
		}), FINAL, SPELLS);
		check('regular SFN -> Deathmatch, counters zeroed', u.regular === PLAYON, u.regular);
		check('Providence bank kept', u.bank === PLAYON + ' pm:1:0', u.bank);
		check('competitive kept', u.competitive === PLAYON.replace(' deathmatch', ' competitive_deathmatch'), u.competitive);
		check('no play-on from Deathmatch / Scramble', u.deathmatch === null && u.scramble === null, [u.deathmatch, u.scramble]);
		check('no play-on from a position the regular rules do not end', u.unended === null, u.unended);
		check('play-on after a sixth-spell ending', typeof u.sixth === 'string' && / 0:0 .* deathmatch$/.test(u.sixth), u.sixth);
		check('no play-on with a side eliminated', u.wiped === null && u.junk === null, [u.wiped, u.junk]);

		// 2. The game-over menu (a finished game's state, injected).
		await page.waitForFunction(() => {
			const c = document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0];
			return c.sideOffer && !c.sideOffer.loading;
		}, { timeout: 120000 });
		await page.evaluate(() => document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0].chooseSide('blue'));
		await page.waitForFunction(() => window.__gc, { timeout: 30000 });
		const finish = (reason) => page.evaluate((start, fin, r) => {
			const c = document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0];
			c._lastEndReason = r;
			c.reviewSfns = [start, fin];
			c.winner = 'red';
		}, START, FINAL, reason);
		await finish('forfeit');
		await new Promise((r) => setTimeout(r, 300));
		check('no Play On after a forfeit', !(await page.evaluate(playOnVisible)));
		await finish(null);
		await page.waitForFunction(playOnVisible, { timeout: 5000 }).catch(() => {});
		check('Play On offered after a regular ending', await page.evaluate(playOnVisible));

		// 3. Play on.
		await page.evaluate(() => { window.onbeforeunload = null; });
		await Promise.all([
			page.waitForNavigation({ waitUntil: 'load', timeout: 90000 }),
			page.evaluate(() => [...document.querySelectorAll('.win-modal__btn')]
				.find((b) => b.textContent.trim() === 'Play On (Deathmatch)').click()),
		]);
		const q = await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search)));
		check('new game from the Deathmatch SFN', q.sfn === PLAYON && q.variant === 'deathmatch' && q.ai === 'rust_easy', q);
		await page.waitForFunction(() => window.__gc, { timeout: 30000 });
		const st = await page.evaluate(() => {
			const c = document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0];
			return { picker: !!c.sideOffer, me: c.myColor, ai: window.__gc.aiColor, dm: c.isDeathmatch,
				variant: window.__gc.board.variant, over: !!c.winner };
		});
		check('same sides, no side picker', !st.picker && st.me === 'blue' && st.ai === 'red', st);
		check('Deathmatch rules, game not over', st.dm && st.variant === 'deathmatch' && !st.over, st);
		await page.waitForFunction(humanPrompt, { timeout: 120000 });
		await page.evaluate(() => { const n = Object.keys(window.__last.moveoptions)[0]; window.__last = null; window.__gc.handlePlayerAction(n); });
		await page.waitForFunction(passPrompt, { timeout: 60000 });
		await page.evaluate(() => { window.__last = null; window.__gc.handlePlayerAction('pass'); });
		// The AI (red, still 3 ahead) moves and the game goes on.
		await page.waitForFunction(humanPrompt, { timeout: 120000 });
		const after = await page.evaluate(() => {
			const c = document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0];
			const b = window.__gc.board;
			return { over: !!c.winner, turn: b.turnCounter, counters: [b.spellCounter.red, b.spellCounter.blue] };
		});
		check('the AI replied and play continues', !after.over && after.turn === 16, after);
		await page.evaluate(() => { window.onbeforeunload = null; });
	} catch (e) {
		console.log('ERROR', e.message);
		ok = false;
	} finally {
		await browser.close();
	}
	console.log(ok ? 'deathmatch-play-on-test: PASS' : 'deathmatch-play-on-test: FAIL');
	process.exit(ok ? 0 : 1);
})();
