// Puzzle ratings (docs/static/scripts/puzzle-rating.js), headless:
//   node tools/browser/puzzle-rating-test.js <docs dir>
// 1. The Elo arithmetic: expected scores, K, integer deltas inside the rules'
//    bounds (player +-40, puzzle +-32), every rating gap from -1500 to +1500.
// 2. pickRatedPuzzle: unattempted puzzles only, near the player's rating.
// 3. The page, signed out: the rating line renders, the first result moves the
//    device rating, a second result on the same puzzle does not, and a page
//    load with no pick lands on a puzzle near the stored rating.
// Exits 1 on the first failure. Needs puppeteer (NODE_PATH).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DOCS = process.argv[2];
let failures = 0;
function check(cond, what) { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failures++; }

// ---- 1, 2: the module in a bare context
const src = fs.readFileSync(path.join(DOCS, 'static/scripts/puzzle-rating.js'), 'utf8');
const mod = new Function('localStorage', 'navigator', src
	+ '\nreturn { puzzleExpected, puzzleRatingUpdate, pickRatedPuzzle, PUZZLE_RATING_START };')(
	{ getItem() { return null; }, setItem() {} }, { onLine: false });
let maxU = 0, maxP = 0, intOk = true;
for (let gap = -1500; gap <= 1500; gap += 25) {
	for (const plays of [0, 19, 20, 500]) {
		for (const solved of [true, false]) {
			const up = mod.puzzleRatingUpdate({ rating: 1500, plays }, { rating: 1500 + gap, plays }, solved);
			maxU = Math.max(maxU, Math.abs(up.delta));
			maxP = Math.max(maxP, Math.abs(up.puzzleDelta));
			intOk = intOk && Number.isInteger(up.user.rating) && Number.isInteger(up.puzzle.rating)
				&& up.user.plays === plays + 1 && up.puzzle.plays === plays + 1
				&& (solved ? up.delta >= 0 && up.puzzleDelta <= 0 : up.delta <= 0 && up.puzzleDelta >= 0);
		}
	}
}
check(maxU <= 40 && maxP <= 32 && intOk, `deltas inside the rules' bounds (player max ${maxU}, puzzle max ${maxP}), integer, signed by result`);
check(Math.abs(mod.puzzleExpected(1500, 1500) - 0.5) < 1e-12 && mod.puzzleExpected(1900, 1500) > 0.9, 'expected score');
const pool = Array.from({ length: 50 }, (_, i) => ({ id: 'p' + i, rating: 1000 + 20 * i }));
const picks = new Set();
for (let k = 0; k < 200; k++) picks.add(mod.pickRatedPuzzle(pool, 1500, { p25: { solved: true } }, {}).id);
const ratings = [...picks].map(id => pool.find(p => p.id === id).rating);
check(!picks.has('p25') && Math.max(...ratings.map(r => Math.abs(r - 1500))) <= 220,
	`rated pick: never the attempted puzzle, within 220 of the rating (picked ${picks.size} distinct)`);

// Daily streaks: a result recorded late (a recovered pending result) counts
// against its own day, not today.
{
	const html = fs.readFileSync(path.join(DOCS, 'puzzles.html'), 'utf8');
	let store = {};
	const ls = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
	const f = new Function('localStorage', html.slice(html.indexOf('function utcDay'), html.indexOf('function dailyText'))
		+ '\nreturn { recordDaily, utcDay };')(ls);
	const D = f.utcDay;
	const seed = (d) => { store = { sigil_puzzle_daily: JSON.stringify(d) }; };
	seed({ last: D(-2), streak: 4, best: 4, done: { [D(-2)]: 'solved' } });
	let d = f.recordDaily(D(-1), 'solved');
	check(d.streak === 5 && f.recordDaily(D(0), 'solved').streak === 6, 'a late solve for yesterday extends the streak, and today extends it again');
	seed({ last: D(0), streak: 2, best: 2, done: { [D(-1)]: 'solved', [D(0)]: 'solved' } });
	d = f.recordDaily(D(-2), 'failed');
	check(d.streak === 2 && d.last === D(0), 'a late failure for an older day leaves a newer streak alone');
	seed({ last: D(0), streak: 1, best: 1, done: { [D(-2)]: 'solved', [D(0)]: 'solved' } });
	d = f.recordDaily(D(-1), 'solved');
	check(d.streak === 3 && d.best === 3, 'a late solve filling a gap joins the runs');
}

// ---- 3: the page, signed out
(async () => {
	const puppeteer = require('puppeteer');
	const PORT = 8966 + Math.floor(Math.random() * 30);
	const srv = spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS], { stdio: 'ignore' });
	const data = JSON.parse(fs.readFileSync(path.join(DOCS, 'static/puzzles/mate_puzzles.json'), 'utf8'));
	data.puzzles.forEach((p, i) => { if (typeof p.rating !== 'number') p.rating = 900 + (i * 37) % 1400; });
	const body = JSON.stringify(data);
	let browser;
	try {
		await new Promise((res, rej) => { const t0 = Date.now(); (function tick() {
			http.get({ host: '127.0.0.1', port: PORT, path: '/' }, r => { r.resume(); res(); })
				.on('error', () => Date.now() - t0 > 15000 ? rej(new Error('server')) : setTimeout(tick, 200)); })(); });
		browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
		const errors = [];
		// `fakeUser`: firebaseAuthSettled (position-rating.js) reports this account.
		const open = async (q, before, fakeUser) => {
			const page = await browser.newPage();
			await page.setBypassServiceWorker(true);
			await page.setRequestInterception(true);
			page.on('request', (req) => {
				if (/mate_puzzles\.json/.test(req.url())) return req.respond({ status: 200, contentType: 'application/json', body });
				if (fakeUser && /position-rating\.js/.test(req.url())) {
					return req.respond({ status: 200, contentType: 'application/javascript',
						body: fs.readFileSync(path.join(DOCS, 'static/scripts/engine/position-rating.js'), 'utf8')
							+ `\nfirebaseAuthSettled = async () => (${JSON.stringify(fakeUser)});` });
				}
				req.continue();
			});
			page.on('pageerror', e => errors.push(e.message));
			if (before) await page.evaluateOnNewDocument(before);
			await page.goto(`http://127.0.0.1:${PORT}/puzzles.html${q}`, { waitUntil: 'networkidle2', timeout: 60000 });
			await page.waitForSelector('#puzzle-root [x-data]', { visible: true, timeout: 30000 });
			await new Promise(r => setTimeout(r, 1500));
			return page;
		};
		let page = await open('?p=0');
		let line = await page.$eval('#puzzle-rating-status', el => el.textContent);
		check(/Your puzzle rating: 1500 \(this device/.test(line), `rating line (${line.trim()})`);
		await page.evaluate(() => window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_PUZZLE, 'solved'));
		await new Promise(r => setTimeout(r, 500));
		const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sigil_puzzle_rating')));
		check(stored && stored.rating > 1500 && stored.plays === 1, `a solve raises the device rating (${JSON.stringify(stored && { rating: stored.rating, plays: stored.plays })})`);
		await page.evaluate(() => window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_PUZZLE, 'failed'));
		await new Promise(r => setTimeout(r, 500));
		const again = await page.evaluate(() => JSON.parse(localStorage.getItem('sigil_puzzle_rating')));
		check(again.rating === stored.rating && again.plays === 1, 'a second result on the same puzzle changes nothing');
		await page.close();
		// A failed mate puzzle waits: the game may still correct it to a solve.
		page = await open('?p=1');
		const kind = await page.evaluate(() => window.SIGIL_PUZZLE.kind);
		const read = () => page.evaluate(() => JSON.parse(localStorage.getItem('sigil_puzzle_rating') || '{"rating":1500,"plays":0}'));
		const before = await read();
		await page.evaluate(() => window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_PUZZLE, 'failed'));
		await new Promise(r => setTimeout(r, 500));
		const pend = await read();
		check(kind === 'mate' && pend.plays === before.plays, `a mate failure is not recorded while it can still be corrected (plays ${before.plays} -> ${pend.plays})`);
		await page.evaluate(() => window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_PUZZLE, 'solved'));
		await new Promise(r => setTimeout(r, 500));
		const corr = await read();
		check(corr.plays === before.plays + 1 && corr.rating > before.rating, `a corrected failure records the solve (${before.rating} -> ${corr.rating})`);
		await page.close();
		page = await open('?p=2');
		await page.evaluate(() => { window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_PUZZLE, 'failed'); window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_PUZZLE, 'failed-final'); });
		await new Promise(r => setTimeout(r, 500));
		const fin = await page.evaluate(() => JSON.parse(localStorage.getItem('sigil_puzzle_rating')));
		check(fin && fin.attempts && fin.attempts[await page.evaluate(() => window.SIGIL_PUZZLE.id)] === 0, 'a final failure is recorded as a loss');
		await page.close();
		// Leaving with a failure pending (here: a plain navigation, as the header
		// logo, Back or a typed URL would) records it as a loss -- at once, or
		// on the next visit if the write could not finish first.
		page = await open('?p=3');
		const id3 = await page.evaluate(() => window.SIGIL_PUZZLE.id);
		await page.evaluate(() => window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_PUZZLE, 'failed'));
		await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
		await page.close();
		page = await open('?p=4');
		const left = await page.evaluate(() => JSON.parse(localStorage.getItem('sigil_puzzle_rating')));
		check(left.attempts[id3] === 0, 'a failure pending when the page is left is recorded as a loss');
		const id4 = await page.evaluate(() => window.SIGIL_PUZZLE.id);
		await page.close();
		// Tabs killed before anything was written: every stored result is
		// recorded on the next visit (two puzzles, two outcomes), and an entry
		// for another account is left alone.
		const id5 = data.puzzles[5].id, id7 = data.puzzles[7].id;
		const seed = { ['|' + id5]: { id: id5, uid: null, solved: false, at: 1 }, ['|' + id7]: { id: id7, uid: null, solved: true, at: 2 },
			['someone|' + id7]: { id: id7, uid: 'someone', solved: false, at: 3 } };
		page = await open('?p=6', `if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', 1); localStorage.setItem('sigil_puzzle_pending_results', ${JSON.stringify(JSON.stringify(seed))}); }`);
		const boot = await page.evaluate(() => [JSON.parse(localStorage.getItem('sigil_puzzle_rating')), JSON.parse(localStorage.getItem('sigil_puzzle_pending_results'))]);
		check(boot[0].attempts[id5] === 0 && boot[0].attempts[id7] === 1 && Object.keys(boot[1]).join() === 'someone|' + id7,
			`stored results left by killed tabs are all recorded on the next visit (${JSON.stringify([boot[0].attempts[id5], boot[0].attempts[id7], Object.keys(boot[1])])})`);
		check(boot[0].attempts[id4] === undefined, 'opening a puzzle records nothing');
		// A device-mode entry is recovered on the device rating even when an
		// account is signed in by the next visit.
		const id10 = data.puzzles[10].id;
		page = await open('?p=11', `if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', 1); localStorage.setItem('sigil_puzzle_pending_results', ${JSON.stringify(JSON.stringify({ ['|' + id10]: { id: id10, uid: null, solved: false, at: 5 } }))}); }`,
			{ uid: 'acct', isAnonymous: false });
		const who = await page.evaluate(() => firebaseAuthSettled().then(u => u && u.uid));
		const dev = await page.evaluate(() => [JSON.parse(localStorage.getItem('sigil_puzzle_rating')), JSON.parse(localStorage.getItem('sigil_puzzle_pending_results'))]);
		check(who === 'acct' && dev[0].attempts[id10] === 0 && !dev[1]['|' + id10], 'a device-mode entry is recovered on the device rating while an account is signed in');
		await page.close();
		// A daily failed and left pending in a killed tab still counts for its day.
		const today = new Date().toISOString().slice(0, 10);
		const dseed = { ['|' + data.puzzles[8].id]: { id: data.puzzles[8].id, uid: null, solved: false, daily: today, at: 4 } };
		page = await open('?p=9', `if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', 1); localStorage.setItem('sigil_puzzle_daily', JSON.stringify({ last: '', streak: 3, best: 3, done: {} })); localStorage.setItem('sigil_puzzle_pending_results', ${JSON.stringify(JSON.stringify(dseed))}); }`);
		const dl = await page.evaluate(() => JSON.parse(localStorage.getItem('sigil_puzzle_daily')));
		check(dl.done[today] === 'failed' && dl.streak === 0, `a recovered daily failure counts for its day (${JSON.stringify(dl)})`);
		await page.close();
		page = await open('', `localStorage.setItem('sigil_puzzle_rating', JSON.stringify({ rating: 2100, plays: 30, attempts: {} }))`);
		const r = await page.evaluate(() => window.SIGIL_PUZZLE.rating);
		const near = data.puzzles.map(p => Math.abs(p.rating - 2100)).sort((a, b) => a - b)[19];
		check(Math.abs(r - 2100) <= near, `no pick lands near the stored rating (puzzle ${r}, 20th nearest gap ${near})`);
		await page.close();
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
