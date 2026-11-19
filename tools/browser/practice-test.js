// Practice games vs the AI (game.html?practice=1, game-board-local.js) with
// the real wasm engine:
//   1. a practice game from a position with ?side= starts on the player's side
//      with no side picker, shows the practice bar, and keeps practice=1;
//   2. Hint: the first press searches and rings where the best turn starts,
//      the second shows the whole turn (the engine's turn passes the replay
//      gate); the count of hints used goes up once;
//   3. after the player's turn and the AI's reply the hint is cleared;
//   4. a reload resumes the game in practice mode with its hint count;
//   5. the game over (a forfeit) is announced as unrated and NOTHING is queued
//      for upload (no completed_games record, no rating);
//   6. without ?side= the side picker says it is a practice game and shows no
//      rating payoffs;
//   7. the analysis board and the review hand positions over (links).
//
//   (cd docs && python3 -m http.server 8803) &
//   node tools/browser/practice-test.js http://localhost:8803
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8803';

// Blue to move, a few stones each (loadable form: the counter of the turn
// before; the controller advances it).
const SFN = 'rrr..........bb...b....b..rr.........../Bewitch,Flourish,Carnage,Fireblast,Grow,Hail_Storm,Surge,Slash,Sprout b 9 0:0 -:- -:- tied';

let failed = 0;
const check = (ok, msg) => {
	console.log((ok ? 'ok   ' : 'FAIL ') + msg);
	if (!ok) failed++;
};

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
const data = () => Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));

function g(page) {
	return page.evaluate(() => {
		const d = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
		return {
			practice: d.practiceMode, hint: JSON.parse(JSON.stringify(d.practiceHint)), used: d.practiceHintsUsed,
			hintNodes: Object.keys(d.practiceHintNodes), myColor: d.myColor, whoseTurn: d.whoseTurn, winner: d.winner,
			canHint: d.canHint, sideOffer: d.sideOffer ? JSON.parse(JSON.stringify(d.sideOffer)) : null,
			log: d.messageHistory.slice(), ringed: document.querySelectorAll('.stone-node--engine-hint').length,
			barShown: (() => { const b = document.querySelector('.practice-bar'); return !!b && b.offsetParent !== null; })(),
		};
	});
}

async function waitG(page, pred, what, ms = 60000) {
	const t0 = Date.now();
	let s = null;
	while (Date.now() - t0 < ms) {
		try { s = await g(page); } catch (e) { s = null; }
		if (s && pred(s)) return s;
		await new Promise(r => setTimeout(r, 200));
	}
	throw new Error('timed out waiting for ' + what + '; state ' + JSON.stringify(s && { hint: s.hint, used: s.used, whoseTurn: s.whoseTurn, myColor: s.myColor, winner: s.winner }));
}

(async () => {
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1000, height: 1100 });
		const errors = [];
		page.on('pageerror', e => errors.push('pageerror: ' + e.message));
		page.on('console', m => { if (m.type() === 'error' && !/firebase|gstatic|ERR_|net::|Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text()); });
		await page.evaluateOnNewDocument(hook);
		// Leaving a game in progress asks first (beforeunload): always leave.
		page.on('dialog', d => d.accept().catch(() => {}));
		await page.goto(BASE + '/game.html', { waitUntil: 'domcontentloaded' });
		await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });

		// 1. A practice game on a chosen side.
		const url = BASE + '/game.html?sfn=' + encodeURIComponent(SFN) + '&ai=rust_easy&practice=1&side=blue';
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(humanPrompt, { timeout: 60000 });
		let s = await g(page);
		check(s.practice && s.myColor === 'blue' && !s.sideOffer, 'practice game starts as Blue with no side picker');
		check(s.barShown, 'the practice bar is shown');
		check(new URL(page.url()).searchParams.get('practice') === '1', 'the URL keeps practice=1');

		// 2. Hint, twice.
		check(s.canHint, 'Hint is available on the player\'s turn');
		await page.$eval('.practice-bar__hint-btn', b => b.click());
		s = await waitG(page, s => s.hint.status === 'ready' || s.hint.status === 'error', 'the hint');
		check(s.hint.status === 'ready', 'the engine gives a hint' + (s.hint.status === 'error' ? ': ' + s.hint.note : ''));
		check(s.used === 1, 'one hint counted (' + s.used + ')');
		if (s.hint.level === 1) {
			check(s.hintNodes.length === 1 && s.ringed === 1 && /Start/.test(s.hint.firstText), 'level 1 rings where the turn starts: ' + s.hint.firstText);
			await page.$eval('.practice-bar__hint-btn', b => b.click());
			s = await waitG(page, s => s.hint.level === 2, 'the whole turn');
		}
		check(s.hint.level === 2 && s.hint.text.length > 0 && s.ringed >= 1, 'level 2 shows the whole turn: ' + s.hint.text + ' (' + s.hint.evalText + ', depth ' + s.hint.depth + ')');
		check(s.used === 1, 'the second press is the same hint (' + s.used + ')');
		const shown = await page.$eval('.practice-bar__body', el => el.innerText);
		check(shown.includes(s.hint.text), 'the bar shows the turn');

		// 3. Play a turn; the AI replies; the hint is cleared.
		await page.evaluate(() => { const n = Object.keys(window.__last.moveoptions)[0]; window.__last = null; window.__gc.handlePlayerAction(n); });
		await page.waitForFunction(passPrompt, { timeout: 60000 });
		await page.evaluate(() => { window.__last = null; window.__gc.handlePlayerAction('pass'); });
		s = await waitG(page, s => s.hint.status === 'idle', 'the hint to clear', 15000);
		check(s.hint.status === 'idle' && s.ringed === 0, 'the end of the turn clears the hint (' + s.whoseTurn + ' to move)');
		await page.waitForFunction(humanPrompt, { timeout: 60000 });
		s = await waitG(page, s => s.whoseTurn === 'blue', 'the next turn');
		check(s.hint.status === 'idle' && s.ringed === 0 && s.canHint, 'the next turn starts without a hint, and offers one');

		// 4. Reload: still a practice game, hint count kept.
		await page.evaluate(() => { window.onbeforeunload = null; });
		await page.reload({ waitUntil: 'domcontentloaded' });
		try { await page.waitForFunction(humanPrompt, { timeout: 60000 }); }
		catch (e) { console.log('after reload:', page.url(), JSON.stringify(await g(page)).slice(0, 600), await page.evaluate(() => JSON.stringify(window.__last))); throw e; }
		s = await g(page);
		check(s.practice && s.used === 1, 'a reload resumes the practice game with its hint count (' + s.used + ')');
		const resumed = new URL(page.url());
		check(resumed.searchParams.get('practice') === '1', 'the resumed URL says practice=1');

		// 5. Forfeit: unrated, nothing queued for upload.
		await page.evaluate(() => { const d = Alpine.$data(document.querySelector('[x-data^="gameBoard"]')); d.handleForfeit(); d.handleForfeit(); });
		s = await waitG(page, s => !!s.winner, 'the game over');
		await new Promise(r => setTimeout(r, 1500));
		s = await g(page);
		check(s.log.some(l => /Practice game: unrated and not saved/.test(l)), 'the game over says unrated, not saved');
		const queued = await page.evaluate(() => (typeof OfflineGameQueue !== 'undefined' ? OfflineGameQueue.peek().length : -1));
		check(queued === 0, 'nothing queued for upload (' + queued + ')');

		// 6. The side picker of a practice game.
		await page.evaluate(() => { localStorage.clear(); });
		await page.goto(BASE + '/game.html?sfn=' + encodeURIComponent(SFN) + '&ai=rust_easy&practice=1', { waitUntil: 'domcontentloaded' });
		s = await waitG(page, s => s.sideOffer && !s.sideOffer.loading, 'the side picker', 90000);
		check(/Practice game: unrated/.test(s.sideOffer.note) && !s.sideOffer.payoffs, 'the side picker says practice, no rating payoffs: ' + s.sideOffer.note);
		await page.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).chooseSide('red'));
		await waitG(page, s => s.myColor === 'red' && !s.sideOffer, 'the chosen side');
		check(true, 'the side picker starts the game on the chosen side');
		await page.evaluate(() => { window.onbeforeunload = null; });

		// 7. Hand-offs: the analysis board's link, and the review's button.
		await page.goto(BASE + '/analysis.html?sfn=' + encodeURIComponent(SFN), { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => { const a = document.querySelector('.ana-practice-ai'); return a && a.getAttribute('href'); }, { timeout: 30000 });
		const href = await page.$eval('.ana-practice-ai', a => a.getAttribute('href'));
		const hu = new URL(href, BASE + '/');
		check(hu.pathname.endsWith('game.html') && hu.searchParams.get('practice') === '1' && !!hu.searchParams.get('ai') && !!hu.searchParams.get('sfn'), 'the analysis board links a practice game: ' + href.slice(0, 60));
		const bad = await page.evaluate(() => [practiceGameHref('garbage', 'rust_easy', '').error,
			practiceGameHref('', 'rust_hard', 'red').href]);
		check(!!bad[0] && bad[1] === 'game.html?ai=rust_hard&practice=1&side=red', 'practiceGameHref refuses garbage and starts a new game without a position');

		check(errors.length === 0, 'no page errors' + (errors.length ? ':\n  ' + errors.join('\n  ') : ''));
	} finally {
		await browser.close();
	}
	if (failed) {
		console.error(failed + ' check(s) failed');
		process.exit(1);
	}
	console.log('all checks passed');
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
