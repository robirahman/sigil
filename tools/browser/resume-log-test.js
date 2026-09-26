// A reloaded vs-AI game must resume with its whole turn log. The local save
// was written on `sfn_update`, which the controller emits BEFORE
// `turn_complete`, so every save held the newest position but not the newest
// turn; a reload resumed from it and the finished record (rooms/<code> and
// completed_games) lacked the last turn played before the reload. 18 recorded
// games have such a gap (2026-08-14 .. 09-26).
//
// Plays three human turns against the Easy AI (first offered move, then pass),
// reloads, plays one more turn, and checks that the controller's log and the
// saved log are gap-free and match the saved position's turn counter.
//
//   (cd docs && python3 -m http.server 8765) &
//   node tools/browser/resume-log-test.js http://localhost:8765
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';

// Captures the controller and its latest prompt: GameController is a global
// class, defined after this runs, so patch it as soon as it exists.
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
			saveLog: save && save.gameLog ? save.gameLog.map((t) => t.turnNumber) : [],
			saveTurn: save && save.sfn ? +save.sfn.split(' ')[2] : null,
		};
	});
}

function check(label, s) {
	const gapFree = (xs) => xs.every((x, i) => x === i + 1);
	const ok = gapFree(s.log) && gapFree(s.saveLog) && s.saveLog.length === s.saveTurn;
	console.log(label.padEnd(14), JSON.stringify(s), ok ? 'ok' : 'GAP');
	return ok;
}

(async () => {
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	try {
		const page = await browser.newPage();
		await page.evaluateOnNewDocument(hook);
		await page.goto(`${BASE}/game.html?ai=rust_easy`, { waitUntil: 'load', timeout: 90000 });
		await humanTurns(page, 3);
		ok = check('before reload', await state(page)) && ok;
		await page.evaluate(() => { window.onbeforeunload = null; });
		await page.reload({ waitUntil: 'load' });
		await page.waitForFunction(humanPrompt, { timeout: 60000 });
		ok = check('after resume', await state(page)) && ok;
		await humanTurns(page, 1);
		ok = check('one turn later', await state(page)) && ok;
	} finally {
		await browser.close();
	}
	console.log(ok ? 'resume log OK' : 'resume log FAILED: a turn is missing from the log');
	process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
