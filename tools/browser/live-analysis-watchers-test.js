// Regression check (PR #67 Codex review): live analysis must follow the
// reviewed position when the review is entered through a path that returns
// early from the board's init():
//   - game.html opened directly into review (?review=<JSON>, like
//     ?review=session and SGN-T imports);
//   - multiplayer.html on a room that is already finished (the lobby hands the
//     board reviewMode state, and init returns before the live-game wiring).
// No engine runs: liveAnalysisRefresh is replaced by a counter, live analysis
// is switched on, and the review index is stepped; every step must call it,
// and so must a change of the (watched) winner, which nothing but the
// watcher reacts to. It also checks the analysed position: index 0 of a turn
// line is rewound to the after-turn form, a final-only review is not.
// multiplayer.html runs with every Firebase database and auth request blocked.
//
//   node tools/browser/live-analysis-watchers-test.js docs [port]
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const DOCS = path.resolve(process.argv[2] || 'docs');
const PORT = Number(process.argv[3]) || 8840 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const SPELLS = 'Flourish,Syzygy,Fissure,Decay,Gather,Seal_of_Wind,Seal_of_Summer,Azimuth,Surge';
const SFNS = [
	'r............b........................./' + SPELLS + ' r 1 0:0 -:- -:- b1',
	'r.........r..b........................./' + SPELLS + ' b 2 0:0 -:- -:- tied',
	'r.........r..bb......................../' + SPELLS + ' r 3 0:0 -:- -:- b1',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what, detail) => {
	console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail !== undefined ? ' ' + JSON.stringify(detail) : ''));
	if (!ok) failures++;
};
function waitPort(ms) {
	return new Promise((res, rej) => {
		const t0 = Date.now();
		(function tick() {
			http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (r) => { r.resume(); res(); })
				.on('error', () => (Date.now() - t0 > ms ? rej(new Error('server not up')) : setTimeout(tick, 200)));
		})();
	});
}

// Count liveAnalysisRefresh calls while stepping reviewIndex.
async function stepCount(page, sel) {
	return page.evaluate(async (q) => {
		const c = document.querySelector(q)._x_dataStack[0];
		window.__refreshes = 0;
		c.liveAnalysisRefresh = function () { window.__refreshes++; };
		c.reviewIndex = c.reviewSfns.length - 1;   // so every step below moves
		c.liveAnaOn = true;
		await new Promise((r) => setTimeout(r, 50));
		window.__refreshes = 0;
		const n = c.reviewSfns.length;
		for (const i of [0, Math.min(1, n - 1), 0]) {
			c.reviewIndex = i;
			await new Promise((r) => setTimeout(r, 50));
		}
		const steps = window.__refreshes;
		// A watched property that does not move the board (no sfn_update, no
		// redraw): only the watcher itself can refresh on it.
		window.__refreshes = 0;
		c.winner = c.winner === 'red' ? 'blue' : 'red';
		await new Promise((r) => setTimeout(r, 50));
		return { refreshes: steps, onWinner: window.__refreshes, reviewMode: c.reviewMode, positions: n };
	}, sel);
}

(async () => {
	const srv = spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS], { stdio: 'ignore' });
	let browser;
	try {
		await waitPort(15000);
		browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });

		// 1. game.html, straight into review.
		const page = await browser.newPage();
		const payload = { type: 'sigil-game', spellNames: SPELLS.split(','), sfns: SFNS, winner: '' };
		await page.goto(`${BASE}/game.html?review=${encodeURIComponent(JSON.stringify(payload))}`, { waitUntil: 'load', timeout: 90000 });
		await page.waitForFunction(() => {
			const el = document.querySelector('[x-data^="gameBoard"]');
			return el && el._x_dataStack && el._x_dataStack[0].reviewMode;
		}, { timeout: 60000 });
		await sleep(300);
		// The target position: index 0 of a turn line is rewound to the
		// after-turn form; a final-only review is not (openAnalysis's rule).
		const targets = (sel) => page.evaluate((q, sfns) => {
			const c = document.querySelector(q)._x_dataStack[0];
			const saved = [c.reviewSfns, c.reviewTurnLabels, c.reviewIndex];
			c.reviewIndex = 0;
			const line = c._liveAnalysisTarget().sfn;
			c.reviewSfns = [sfns[2]]; c.reviewTurnLabels = ['Final position']; c.reviewIndex = 0;
			const finalOnly = c._liveAnalysisTarget().sfn;
			[c.reviewSfns, c.reviewTurnLabels, c.reviewIndex] = saved;
			return { line, finalOnly };
		}, sel, SFNS);
		const tl = await targets('[x-data^="gameBoard"]');
		check(tl.line !== SFNS[0] && tl.line.split(' ')[2] === '0', 'game.html: review position 0 is rewound to the after-turn form', tl.line);
		check(tl.finalOnly === SFNS[2], 'game.html: a final-only review is analysed as shown, not rewound', tl.finalOnly);
		const local = await stepCount(page, '[x-data^="gameBoard"]');
		check(local.reviewMode && local.refreshes >= 3 && local.onWinner >= 1, 'game.html direct review: live analysis follows each review step', local);

		// 2. multiplayer.html, an already-finished room.
		const mp = await browser.newPage();
		await mp.setRequestInterception(true);
		// The Firebase SDK loads (the lobby needs it to start), but nothing
		// reaches the database or auth backends.
		const BACKEND = /firebaseio\.com|firebasedatabase\.app|identitytoolkit|securetoken|firestore|googleapis\.com\/(?!css)/;
		mp.on('request', (r) => (BACKEND.test(r.url()) ? r.abort() : r.continue()));
		mp.on('pageerror', () => {});   // offline backend
		await mp.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		await mp.waitForFunction(() => document.querySelector('[x-data^="multiplayerLobby"]')?._x_dataStack, { timeout: 30000 });
		await mp.evaluate((spells, sfns) => {
			window._multiplayerState = {
				sync: null, spellNames: spells.split(','), myColor: '', reconnectSfn: null, isSpectator: true,
				timeControl: null, variant: 'standard', redDisplayName: 'R', blueDisplayName: 'B',
				reviewMode: true, winner: 'red', finalSfn: sfns[sfns.length - 1], setupSfn: null,
				gameLog: [
					{ color: 'red', turnNumber: 1, kind: 'input', actions: ['a11', 'pass'], sfnBefore: sfns[0], sfnAfter: sfns[1] },
					{ color: 'blue', turnNumber: 2, kind: 'input', actions: ['b2', 'pass'], sfnBefore: sfns[1], sfnAfter: sfns[2] },
				],
			};
			document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].phase = 'playing';
		}, SPELLS, SFNS);
		await mp.waitForFunction(() => {
			const el = document.querySelector('[x-data^="gameBoard"]');
			return el && el._x_dataStack && el._x_dataStack[0].reviewMode && el._x_dataStack[0].reviewSfns.length > 1;
		}, { timeout: 60000 });
		await sleep(300);
		const to = await mp.evaluate((sfns) => {
			const c = document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0];
			const saved = [c.reviewSfns, c.reviewTurnLabels, c.reviewIndex];
			c.reviewSfns = [sfns[2]]; c.reviewTurnLabels = ['Final position']; c.reviewIndex = 0;
			const finalOnly = c._liveAnalysisTarget().sfn;
			[c.reviewSfns, c.reviewTurnLabels, c.reviewIndex] = saved;
			return finalOnly;
		}, SFNS);
		check(to === SFNS[2], 'multiplayer.html: a final-only review is analysed as shown, not rewound', to);
		const online = await stepCount(mp, '[x-data^="gameBoard"]');
		check(online.reviewMode && online.refreshes >= 3 && online.onWinner >= 1, 'multiplayer.html finished room: live analysis follows each review step', online);
	} catch (e) {
		check(false, 'test ran: ' + e.message);
	} finally {
		if (browser) await browser.close();
		srv.kill();
	}
	console.log(failures ? 'live-analysis-watchers-test: FAIL' : 'live-analysis-watchers-test: PASS');
	process.exit(failures ? 1 : 0);
})();
