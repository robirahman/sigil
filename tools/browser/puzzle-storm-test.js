// Puzzle progress sync, the puzzle dashboard and Puzzle Storm, headless:
//   node tools/browser/puzzle-storm-test.js <docs dir> [port]
// 1. puzzle-progress.js in a bare context: the merge is a union (earliest
//    solve, earliest first result, the account's day on a clash, the larger
//    best streak), the daily streak is recomputed from the log, the diff
//    writes only missing leaves, Storm ramps by rating and pays combos.
// 2. The page, signed out: the dashboard renders from this device's record;
//    a Storm run solves puzzles by clicking (the board switches puzzle in
//    place, across variants), a miss costs 10 s, the run ends and the
//    best is saved on the device -- and neither the puzzle rating nor the
//    solved list nor the result log moves.
// 3. With the emulators (FIREBASE_DATABASE_EMULATOR_HOST set, e.g. under
//      cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//        'node ../tools/browser/puzzle-storm-test.js ../docs'):
//    two "devices" (browser contexts) with different local progress sign in
//    to one account; both end with the union, the account holds it, and a
//    result on one device reaches the other. A signed-in Storm run writes
//    users/<uid>/puzzleStorm and storm_leaderboard, shown on the leaderboard.
// Exits 1 on any failure. Needs puppeteer (NODE_PATH).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DOCS = path.resolve(process.argv[2] || 'docs');
const PORT = Number(process.argv[3] || 8808);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(cond, what) { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failures++; }

// ---- 1: the module
const src = fs.readFileSync(path.join(DOCS, 'static/scripts/puzzle-progress.js'), 'utf8');
const store = {};
const fakeLS = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
const mod = new Function('localStorage', 'navigator', src + '\nreturn { mergePuzzleProgress, puzzleDailyFromLog, puzzleProgressDiff, pickStormPuzzle, stormComboBonus, stormPool, readLocalPuzzleProgress, writeLocalPuzzleProgress };')(fakeLS, { onLine: false });
{
	const remote = { solved: { a: 200, b: 100 }, results: { a: { r: 'f', at: 150 }, b: { r: 's', at: 100 } },
		daily: { '2026-10-01': 'solved', '2026-10-02': 'failed' }, dailyBest: 3 };
	const local = { solved: { a: 120, c: 300 }, results: { a: { r: 's', at: 120 }, c: { r: 'v', at: 300 }, 'bad.id': { r: 's', at: 1 } },
		daily: { '2026-10-02': 'solved', '2026-10-03': 'solved' }, dailyBest: 1 };
	const m = mod.mergePuzzleProgress(remote, local);
	check(JSON.stringify(m.solved) === JSON.stringify({ a: 120, b: 100, c: 300 }), 'merge: solved is the union, earliest time ' + JSON.stringify(m.solved));
	check(m.results.a.r === 's' && m.results.a.at === 120 && m.results.c.r === 'v' && m.results.b.r === 's' && !m.results['bad.id'],
		'merge: the earliest first result wins, bad keys dropped ' + JSON.stringify(m.results));
	check(m.daily['2026-10-02'] === 'failed' && m.daily['2026-10-03'] === 'solved' && m.dailyBest === 3, 'merge: the account keeps a day both recorded; best is the max');
	const again = mod.mergePuzzleProgress(m, local);
	check(JSON.stringify(again) === JSON.stringify(m), 'merge is idempotent');
	const diff = mod.puzzleProgressDiff(m, remote, 'users/u/puzzleProgress');
	check(diff['users/u/puzzleProgress/solved/c'] === 300 && diff['users/u/puzzleProgress/solved/a'] === 120 && !('users/u/puzzleProgress/solved/b' in diff)
		&& !('users/u/puzzleProgress/daily/2026-10-02' in diff) && diff['users/u/puzzleProgress/daily/2026-10-03'] === 'solved'
		&& !Object.keys(diff).some(k => /puzzleProgress$|\/solved$|\/results$|\/daily$/.test(k)),
		'diff: single leaves only, and only those the account lacks ' + Object.keys(diff).length);
	const d = mod.puzzleDailyFromLog({ '2026-10-01': 'solved', '2026-10-02': 'solved', '2026-10-03': 'solved', '2026-10-05': 'solved', '2026-10-06': 'solved' }, 0);
	check(d.streak === 2 && d.last === '2026-10-06' && d.best === 3, 'daily from the log: streak 2 after a gap, best 3 ' + JSON.stringify(d));
	const d2 = mod.puzzleDailyFromLog({ '2026-10-01': 'solved', '2026-10-02': 'failed' }, 5);
	check(d2.streak === 0 && d2.best === 5, 'daily from the log: a miss ends the streak; a stored best is kept');
	store.sigil_puzzles_solved = JSON.stringify({ x: 5 });
	mod.writeLocalPuzzleProgress(m);
	const back = mod.readLocalPuzzleProgress();
	check(back.solved.c === 300 && back.daily['2026-10-03'] === 'solved' && JSON.parse(store.sigil_puzzle_daily).last === '2026-10-03', 'the device copy round-trips');
	const pool = Array.from({ length: 200 }, (_, i) => ({ id: 'p' + i, rating: 1000 + 5 * i, kind: 'mate', mate: 1 }));
	const used = {};
	const rs = [];
	for (let k = 0; k < 30; k++) { const p = mod.pickStormPuzzle(pool, k, used); used[p.id] = 1; rs.push(p.rating); }
	const early = rs.slice(0, 5).reduce((a, b) => a + b) / 5, late = rs.slice(-5).reduce((a, b) => a + b) / 5;
	check(early < 1100 && late > early + 600 && Object.keys(used).length === 30, `Storm ramps by rating (first five ${early}, last five ${late}), never repeats`);
	check(mod.stormComboBonus(5) === 3000 && mod.stormComboBonus(12) === 5000 && mod.stormComboBonus(6) === 0 && mod.stormComboBonus(40) === 10000, 'combo bonuses');
	check(mod.stormPool([{ kind: 'winning' }, { kind: 'mate', mate: 2 }]).length === 1, 'Storm uses mate puzzles only');
}

// The page fixture: plain-move mate-in-1 puzzles (clickable), ratings rising,
// both variants, plus the rest of the set for the dashboard.
const data = JSON.parse(fs.readFileSync(path.join(DOCS, 'static/puzzles/mate_puzzles.json'), 'utf8'));
const plain = a => a && (a.type === 'move' || a.type === 'blink' || (a.type === 'hard_move' && !a.pushed_to));
const clickable = data.puzzles.filter(p => p.mate === 1 && p.solutions.length
	&& p.solutions[0].actions.filter(a => a.type !== 'pass').length === 1 && plain(p.solutions[0].actions[0]));
const std = clickable.filter(p => p.variant === 'standard').slice(0, 4);
const comp = clickable.filter(p => p.variant === 'competitive').slice(0, 4);
// Alternating variants, rating rising: with Math.random pinned to 0 the run
// plays them in this order, so the board must switch variant in place.
const stormSet = std.flatMap((p, i) => comp[i] ? [p, comp[i]] : [p]).map((p, i) => Object.assign(JSON.parse(JSON.stringify(p)), { rating: 1000 + 40 * i }));
const stormBody = JSON.stringify(Object.assign({}, data, { puzzles: stormSet.map((p, i) => Object.assign(p, { index: i })) }));
const fullBody = JSON.stringify(data);

function useEmulators(dbHost, authHost) {
	let fb;
	Object.defineProperty(window, 'firebase', {
		configurable: true,
		get() { return fb; },
		set(v) {
			fb = v;
			const init = v.initializeApp.bind(v);
			v.initializeApp = (...args) => {
				const app = init(...args);
				app.auth().useEmulator('http://' + authHost, { disableWarnings: true });
				app.database().useEmulator(dbHost.split(':')[0], Number(dbHost.split(':')[1]));
				return app;
			};
		},
	});
}
const _sdk = new Map();
async function sdk(url) {
	for (let i = 0; !_sdk.has(url) && i < 5; i++) {
		try { const r = await fetch(url); if (r.ok) _sdk.set(url, await r.text()); } catch (e) { /* retry */ }
	}
	if (!_sdk.has(url)) throw new Error('could not fetch ' + url);
	return _sdk.get(url);
}

const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const NS = 'sigil-js-default-rtdb';
const OWNER = { Authorization: 'Bearer owner' };

(async () => {
	const puppeteer = require('puppeteer');
	const srv = spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS], { stdio: 'ignore' });
	let browser;
	const errors = [];
	try {
		await new Promise((res, rej) => { const t0 = Date.now(); (function tick() {
			http.get({ host: '127.0.0.1', port: PORT, path: '/' }, r => { r.resume(); res(); })
				.on('error', () => Date.now() - t0 > 15000 ? rej(new Error('server')) : setTimeout(tick, 200)); })(); });
		browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
		async function open(ctx, q, opts) {
			opts = opts || {};
			const page = await ctx.newPage();
			await page.setViewport({ width: 412, height: 915 });
			if (DB_HOST) await page.evaluateOnNewDocument(useEmulators, DB_HOST, AUTH_HOST);
			await page.setBypassServiceWorker(true);
			await page.setRequestInterception(true);
			page.on('request', (req) => {
				const url = req.url();
				if (/static\/puzzles\/mate_puzzles\.json/.test(url)) return req.respond({ status: 200, contentType: 'application/json', body: opts.body || fullBody });
				// gstatic downloads flake: serve the SDK from memory.
				if (url.startsWith('https://www.gstatic.com/firebasejs/')) {
					return sdk(url).then(body => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
				}
				req.continue();
			});
			page.on('pageerror', e => errors.push(e.message));
			if (opts.before) await page.evaluateOnNewDocument(opts.before);
			await page.goto(`${BASE}/puzzles.html${q}`, { waitUntil: 'networkidle2', timeout: 60000 });
			return page;
		}
		const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

		// ---- 2a: dashboard, signed out
		const ctx0 = await browser.createBrowserContext();
		const [p0, p1, p2] = data.puzzles.filter(p => p.difficulty && (p.tags || []).length).slice(0, 3);
		const seed = `localStorage.setItem('sigil_puzzles_solved', JSON.stringify({ '${p0.id}': 1000, '${p2.id}': 5000 }));
			localStorage.setItem('sigil_puzzle_results', JSON.stringify({ '${p1.id}': { r: 'f', at: 2000 }, '${p2.id}': { r: 'v', at: 3000 } }));
			localStorage.setItem('sigil_puzzle_storm', JSON.stringify({ best: 7, runs: 2, history: [] }));`;
		let page = await open(ctx0, '?tab=dashboard', { before: seed });
		await page.waitForSelector('#puzzle-dashboard', { visible: true, timeout: 30000 });
		const dash = await page.$eval('#puzzle-dashboard', el => el.innerText);
		check(/3\s*puzzles attempted/.test(dash) && /33%\s*solved at the first try/.test(dash) && /7\s*Puzzle Storm best/.test(dash),
			'dashboard tiles from the device record');
		check(/By difficulty/.test(dash) && /By theme/.test(dash) && /Recent misses/.test(dash) && /solved since/.test(dash) && /Sign in/.test(dash),
			'dashboard: difficulty, theme, misses (with "solved since"), sign-in hint');
		check(await page.$$eval('#puzzle-dashboard .puzzle-dash__bar', els => els.length) >= 2, 'solve-rate bars render');
		check(await noHScroll(page), 'dashboard: no horizontal scroll at phone width');
		await page.close();

		// ---- 2b: a Storm run, signed out
		page = await open(ctx0, '?tab=storm', { body: stormBody, before: `Math.random = () => 0; ['sigil_puzzle_storm', 'sigil_puzzles_solved', 'sigil_puzzle_results', 'sigil_puzzle_rating'].forEach(k => localStorage.removeItem(k));` });
		await page.waitForSelector('#storm-start', { visible: true, timeout: 30000 });
		await page.click('#storm-start');
		await page.waitForFunction(() => window.SIGIL_PUZZLE_BOARD && window.Alpine && window.SIGIL_STORM.current, { timeout: 30000 });
		const state = () => page.evaluate(() => {
			const d = window.Alpine.$data(document.querySelector('#puzzle-root [x-data]'));
			const st = window.SIGIL_STORM;
			return { id: d.puzzle.id, cur: st.current.id, variant: d.puzzle.variant, status: d.puzzleStatus, valid: Object.keys(d.validMoves || {}),
				actions: Object.values(d.actionList || {}), score: st.score, k: st.k, left: st.deadline - Date.now(), over: st.over, combo: st.combo };
		});
		const waitFor = async (pred, ms) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await state(); if (pred(s)) return s; await sleep(250); } return s; };
		const variants = new Set();
		let s = await waitFor(x => x.valid.length > 0, 20000);
		for (let i = 0; i < 3; i++) {
			check(s.id === s.cur && s.status === 'playing', `Storm puzzle ${i + 1} is on the board (${s.id}, ${s.variant})`);
			variants.add(s.variant);
			const node = stormSet.find(p => p.id === s.id).solutions[0].actions[0].node;
			await page.click(`#stone-node--${node}`);
			await sleep(500);
			s = await state();
			if (s.actions.includes('pass')) await page.click('.action-button--end-turn');
			const score0 = i;
			s = await waitFor(x => x.score > score0, 45000);
			check(s.score === i + 1, `click-solve ${i + 1} scores (${s.score})` + (s.score === i + 1 ? "" : " " + JSON.stringify(s) + " " + await page.evaluate(() => { const d = window.Alpine.$data(document.querySelector("#puzzle-root [x-data]")); return d.puzzleMessage + " / " + d.whoseTurn + " / " + d.messageHistory.slice(-4).join(" | "); })));
			s = await waitFor(x => x.k === i + 2 && x.id === x.cur && x.status === 'playing' && x.valid.length > 0, 20000);
		}
		// A miss: Skip (a wrong click may still mate: easy puzzles often have several).
		const before = s;
		await page.click('#storm-skip');
		s = await waitFor(x => x.combo === 0 && x.k > before.k, 25000);
		check(s.score === 3 && s.left < before.left - 9000, `a miss costs 10 s and the combo (score ${s.score}, ${Math.round((before.left - s.left) / 1000)} s)`);
		s = await waitFor(x => x.id === x.cur && x.status === 'playing' && x.valid.length > 0, 20000);
		variants.add(s.variant);
		check(variants.size === 2, 'the board switched between variants in place: ' + [...variants].join(', '));
		check(await noHScroll(page), 'Storm: no horizontal scroll at phone width');
		const inView = await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); const b = document.getElementById('storm-end').getBoundingClientRect(); return b.top >= 0 && b.bottom <= window.innerHeight; });
		check(inView, 'the Storm clock and buttons stay in view when the board is scrolled');
		const hit0 = await page.evaluate(() => { const b = document.getElementById('storm-end').getBoundingClientRect();
			const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return (e && (e.id || e.className || e.tagName)) + ' @' + Math.round(b.y); });
		check(/^storm-end/.test(hit0), 'nothing covers the End run button (' + hit0 + ')');
		await page.click('#storm-end');
		await page.waitForFunction(() => window.SIGIL_STORM.saved, { timeout: 20000 }).catch(async (e) => {
			console.log('  storm state: ' + await page.evaluate(() => JSON.stringify({ over: window.SIGIL_STORM.over, k: window.SIGIL_STORM.k, saved: window.SIGIL_STORM.saved })));
			throw e;
		});
		const end = await page.evaluate(() => ({ text: document.getElementById('storm-intro').innerText, saved: window.SIGIL_STORM.saved,
			local: JSON.parse(localStorage.getItem('sigil_puzzle_storm')), rating: localStorage.getItem('sigil_puzzle_rating'),
			solved: localStorage.getItem('sigil_puzzles_solved'), results: localStorage.getItem('sigil_puzzle_results') }));
		check(/Puzzle Storm: 3 solved/.test(end.text) && end.saved.newBest && end.local.best === 3 && end.local.runs === 1, 'the run ends and saves its best on the device ' + JSON.stringify(end.local));
		check(end.rating === null && end.solved === null && end.results === null, 'Storm leaves the puzzle rating, the solved list and the result log alone');
		await page.close();
		await ctx0.close();

		// ---- 3: the account (emulators only)
		if (!DB_HOST) {
			console.log('skip emulator part (FIREBASE_DATABASE_EMULATOR_HOST not set)');
		} else {
			const DB = 'http://' + DB_HOST;
			const rules = fs.readFileSync(path.join(DOCS, '..', 'database.rules.json'), 'utf8');
			const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
			check(put.status === 200, 'rules uploaded to the emulator');
			const email = `storm${Date.now()}@example.com`;
			const su = await fetch('http://' + AUTH_HOST + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo',
				{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }) });
			const uid = (await su.json()).localId;
			await fetch(`${DB}/users/${uid}.json?ns=${NS}`, { method: 'PUT', headers: OWNER,
				body: JSON.stringify({ displayName: 'Stormer', elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: 1,
					puzzleProgress: { solved: { [p2.id]: 9000 }, daily: { '2026-10-01': 'solved' }, dailyBest: 4 } }) });
			await fetch(`${DB}/puzzle_ratings/${p2.id}.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: JSON.stringify({ rating: 1500, plays: 0 }) });
			const signIn = async (pg) => {
				await pg.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), email);
				await pg.waitForFunction(() => firebase.auth().currentUser, { timeout: 15000 });
			};
			const local = (pg) => pg.evaluate(() => ({ solved: JSON.parse(localStorage.getItem('sigil_puzzles_solved') || '{}'),
				results: JSON.parse(localStorage.getItem('sigil_puzzle_results') || '{}'), daily: JSON.parse(localStorage.getItem('sigil_puzzle_daily') || '{}') }));
			const remote = async () => (await (await fetch(`${DB}/users/${uid}.json?ns=${NS}`, { headers: OWNER })).json()) || {};

			// Device A: p0 solved; device B: p1 missed and a daily result.
			const ctxA = await browser.createBrowserContext();
			const ctxB = await browser.createBrowserContext();
			let pa = await open(ctxA, '?tab=dashboard', { before: `if (!localStorage.getItem('seeded')) { localStorage.setItem('seeded', 1); localStorage.setItem('sigil_puzzles_solved', JSON.stringify({ '${p0.id}': 1000 })); localStorage.setItem('sigil_puzzle_results', JSON.stringify({ '${p0.id}': { r: 's', at: 1000 } })); }` });
			await signIn(pa);
			let pb = await open(ctxB, '?tab=dashboard', { before: `if (!localStorage.getItem('seeded')) { localStorage.setItem('seeded', 1); localStorage.setItem('sigil_puzzle_results', JSON.stringify({ '${p1.id}': { r: 'f', at: 2000 } })); localStorage.setItem('sigil_puzzle_daily', JSON.stringify({ done: { '2026-10-02': 'solved' }, best: 1, streak: 1, last: '2026-10-02' })); }` });
			await signIn(pb);
			await pa.reload({ waitUntil: 'networkidle2' });
			await pa.waitForSelector('#puzzle-dashboard', { visible: true, timeout: 30000 });
			await pb.reload({ waitUntil: 'networkidle2' });
			await pb.waitForSelector('#puzzle-dashboard', { visible: true, timeout: 30000 });
			await sleep(1500);
			let r = await remote();
			const pp = r.puzzleProgress || {};
			check(pp.solved && pp.solved[p0.id] === 1000 && pp.solved[p2.id] === 9000 && pp.results && pp.results[p0.id] && pp.results[p1.id] && pp.results[p1.id].r === 'f'
				&& pp.daily['2026-10-01'] === 'solved' && pp.daily['2026-10-02'] === 'solved' && pp.dailyBest === 4,
				'the account holds the union of both devices and its own record ' + JSON.stringify(pp).slice(0, 200));
			// Device A has not seen B's record yet; a reload merges it in.
			await pa.reload({ waitUntil: 'networkidle2' });
			await pa.waitForSelector('#puzzle-dashboard', { visible: true, timeout: 30000 });
			let la = await local(pa), lb = await local(pb);
			check(la.solved[p0.id] && la.solved[p2.id] && la.results[p1.id] && la.daily.done['2026-10-02'] === 'solved' && la.daily.best === 4, 'device A ends with the union');
			check(lb.solved[p0.id] && lb.solved[p2.id] && lb.results[p0.id] && lb.daily.done['2026-10-01'] === 'solved' && lb.daily.streak === 2, 'device B ends with the union (streak 2 across devices)');
			const dashA = await pa.$eval('#puzzle-dashboard', el => el.innerText);
			check(/3\s*puzzles attempted/.test(dashA) && /saved to your account/.test(dashA), 'signed-in dashboard counts the merged record');
			// A result on B is written through and reaches A on its next load.
			await pb.goto(`${BASE}/puzzles.html?id=${encodeURIComponent(p2.id)}`, { waitUntil: 'networkidle2' });
			await pb.waitForFunction(() => typeof window.SIGIL_PUZZLE_ON_RESULT === 'function', { timeout: 30000 });
			await pb.evaluate(() => window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_PUZZLE, 'solved'));
			for (let t = 0; t < 40; t++) { await sleep(500); const x = await remote(); if (x.puzzleAttempts && x.puzzleAttempts[p2.id] && x.puzzleProgress.results[p2.id]) break; }
			r = await remote();
			check(r.puzzleProgress.results[p2.id] && r.puzzleProgress.results[p2.id].r === 's', 'a result writes through to the account');
			check(r.puzzle && r.puzzle.plays === 1 && r.puzzleAttempts && r.puzzleAttempts[p2.id], 'the rated attempt still records (rating flow unchanged)');
			await pa.reload({ waitUntil: 'networkidle2' });
			await pa.waitForSelector('#puzzle-dashboard', { visible: true, timeout: 30000 });
			la = await local(pa);
			check(!!la.results[p2.id], 'the other device picks it up on its next load');

			// A signed-in Storm run: the account record and the leaderboard.
			const ratingBefore = (await remote()).puzzle;
			const ps = await open(ctxA, '?tab=storm', { body: stormBody });
			ps.on('console', m => { if (/error|warn/i.test(m.type())) console.log('  [storm page ' + m.type() + '] ' + m.text().slice(0, 300)); });
			await ps.waitForSelector('#storm-start', { visible: true, timeout: 30000 });
			await ps.click('#storm-start');
			await ps.waitForFunction(() => window.SIGIL_PUZZLE_BOARD && window.SIGIL_STORM.current, { timeout: 30000 });
			for (let i = 0; i < 2; i++) {
				await ps.evaluate(() => window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_STORM.current, 'solved'));
				await ps.waitForFunction((k) => window.SIGIL_STORM.k === k, { timeout: 10000 }, i + 2);
			}
			const hit = await ps.evaluate(() => { const b = document.getElementById('storm-end').getBoundingClientRect();
				const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e && (e.id || e.className || e.tagName); });
			check(hit === 'storm-end', 'nothing covers the End run button (' + hit + ')');
			await ps.click('#storm-end');
			await ps.waitForFunction(() => window.SIGIL_STORM.saved, { timeout: 40000 }).catch(async (e) => {
				console.log('  storm state: ' + await ps.evaluate(() => JSON.stringify({ over: window.SIGIL_STORM.over, k: window.SIGIL_STORM.k, score: window.SIGIL_STORM.score,
					user: firebase.auth().currentUser && firebase.auth().currentUser.uid, intro: document.getElementById('storm-intro').innerText.slice(0, 200) })));
				throw e;
			});
			const saved = await ps.evaluate(() => window.SIGIL_STORM.saved);
			r = await remote();
			check(saved.signedIn && r.puzzleStorm && r.puzzleStorm.best === 2 && r.puzzleStorm.runs === 1, 'a signed-in run is saved to the account ' + JSON.stringify(r.puzzleStorm));
			check(JSON.stringify(r.puzzle) === JSON.stringify(ratingBefore), 'the Storm run left the puzzle rating alone');
			const lbRow = await (await fetch(`${DB}/storm_leaderboard/${uid}.json?ns=${NS}`, { headers: OWNER })).json();
			check(lbRow && lbRow.score === 2 && lbRow.displayName === 'Stormer', 'storm_leaderboard row ' + JSON.stringify(lbRow));
			await ps.goto(`${BASE}/leaderboard.html?tab=storm`, { waitUntil: 'networkidle2' });
			await ps.waitForFunction(() => /Stormer/.test(document.querySelector('.leaderboard-table') ? document.querySelector('.leaderboard-table').innerText : ''), { timeout: 20000 }).catch(() => {});
			const lbText = await ps.$eval('.leaderboard-table', el => el.innerText).catch(() => '');
			check(/Stormer\s+2\b/.test(lbText) && /Best score/i.test(lbText), 'the Storm board shows the score: ' + JSON.stringify(lbText.slice(0, 200)));
			// Two runs finishing at once both count; the best is the larger.
			await ps.goto(`${BASE}/puzzles.html?tab=dashboard`, { waitUntil: 'networkidle2' });
			await ps.waitForFunction(() => typeof recordStormRun === 'function' && firebase.auth().currentUser, { timeout: 20000 });
			const one = await ps.evaluate(() => recordStormRun(firebase.auth().currentUser, 1).then(x => x.runs, e => 'err ' + e.message));
			console.log('  single run after the first: ' + one);
			// (Two devices: one client batches its own transactions on a path into one write.)
			const run = (pg, n) => pg.evaluate((k) => recordStormRun(firebase.auth().currentUser, k).then(x => x.runs, e => 'err ' + e.message), n);
			const both = await Promise.all([run(ps, 5), run(pb, 9)]);
			r = await remote();
			const lb2 = await (await fetch(`${DB}/storm_leaderboard/${uid}.json?ns=${NS}`, { headers: OWNER })).json();
			check(r.puzzleStorm.runs === 4 && r.puzzleStorm.best === 9 && lb2.score === 9, 'concurrent runs both count (' + JSON.stringify(both) + ', ' + JSON.stringify(r.puzzleStorm) + ', board ' + lb2.score + ')');
			// Racing leaf writes keep the earliest first result.
			const leaf = `users/${uid}/puzzleProgress/results/race-1`;
			await ps.evaluate((path) => Promise.all([_ppWriteLeaves(firebase.database(), { [path]: { r: 'f', at: 3000 } }),
				_ppWriteLeaves(firebase.database(), { [path]: { r: 's', at: 2000 } }),
				_ppWriteLeaves(firebase.database(), { [path]: { r: 'v', at: 4000 } })]), leaf);
			const raced = await (await fetch(`${DB}/${leaf}.json?ns=${NS}`, { headers: OWNER })).json();
			check(raced && raced.r === 's' && raced.at === 2000, 'racing first results keep the earliest ' + JSON.stringify(raced));
			// A forged score for someone else is refused.
			const forged = await ps.evaluate((u) => firebase.database().ref('users/someone-else/puzzleStorm').set({ best: 99, runs: 1, last: 99, at: 1 }).then(() => 'ok', e => 'denied'), uid);
			check(forged === 'denied', 'a Storm score for another uid is refused');
			await ctxA.close();
			await ctxB.close();
		}
		check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
	} catch (e) {
		check(false, 'exception: ' + (e && e.stack || e));
	} finally {
		if (browser) await browser.close();
		srv.kill();
	}
	console.log(failures ? failures + ' FAILED' : 'ALL OK');
	process.exit(failures ? 1 : 0);
})();
