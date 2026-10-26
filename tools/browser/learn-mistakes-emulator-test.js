// "Learn from your mistakes" and the server analysis it reads, on the Firebase
// emulators (no live database):
//   1. a game_evals document made by the server's own analysis code
//      (functions/analysis.js, run here in node on test/online-game.json),
//      with one of the player's turns made a blunder, is seeded with its
//      finished room; the player opens the replay and asks for a Quick
//      Review: the stored analysis is used (no search in the browser);
//   2. the review panel offers "Learn from your mistakes (N)" for exactly the
//      player's mistakes and blunders;
//   3. puzzles.html?learn= steps through them: the seeded blunder shows the
//      position before the turn, and playing the engine's best turn solves
//      it by position (puzzleSfnKey), with no engine judging;
//   4. the evalPositions callable fills position_evals for a position the
//      page asks about, and the page reads it back under its own key.
//
//   (cd docs && python3 -m http.server 8803) &
//   cd functions && firebase emulators:exec --only auth,database,functions --project demo-sigil \
//     'node ../tools/browser/learn-mistakes-emulator-test.js http://localhost:8803'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8803';
const NS = 'sigil-js-default-rtdb';
const DB = 'http://' + (process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000');
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const OWNER = { Authorization: 'Bearer owner' };
const FUNCTIONS = path.join(__dirname, '..', '..', 'functions');
const { analyzeStep } = require(path.join(FUNCTIONS, 'analysis'));
const { freshEngine } = require(path.join(FUNCTIONS, 'engine-loader'));
const { fakeDb } = require(path.join(FUNCTIONS, 'test', 'fake-db'));
const ONLINE = require(path.join(FUNCTIONS, 'test', 'online-game.json'));

function pageHooks(dbHost, authHost) {
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
				if (v.functions) app.functions().useEmulator('127.0.0.1', 5001);
				return app;
			};
		},
	});
}

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

async function rest(method, p, body) {
	const r = await fetch(`${DB}/${p}.json?ns=${NS}`, { method, headers: OWNER, body: body === undefined ? undefined : JSON.stringify(body) });
	if (!r.ok) throw new Error(method + ' ' + p + ': ' + r.status + ' ' + await r.text());
	return r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOARD = '[x-data^="gameBoard"]';
const boardVal = (p, expr) => p.evaluate((s, x) => {
	const el = document.querySelector(s);
	if (!el || !el._x_dataStack) return undefined;
	return JSON.parse(JSON.stringify(new Function('B', 'return ' + x)(el._x_dataStack[0])) ?? 'null');
}, BOARD, expr);

(async () => {
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	const code = 'LRN' + String(Date.now()).slice(-5);

	// ---- the server's analysis of the game, made here with its own code
	const fdb = fakeDb({ completed_games: { G: Object.assign(JSON.parse(JSON.stringify(ONLINE)), { roomCode: code }) } });
	let res;
	do { res = await analyzeStep(fdb, 'G'); } while (!res.done);
	if (res.reason !== 'written') throw new Error('analysis: ' + res.reason);
	const doc = fdb.dump().game_evals[code];
	const engine = freshEngine();
	const log = await engine.reconstructGameLog(ONLINE.spellNames, 'standard', null, ONLINE.turns);
	// The player's blunder: a turn whose best is one plain move (clickable),
	// with no forced result around it.
	const plain = (b) => Array.isArray(b) && b[0] && b[0].type === 'move' && b.slice(1).every((a) => a.type === 'pass');
	let k = -1;
	for (let i = 2; i < log.length - 2 && k < 0; i++) {
		const mates = doc.matePerPly || {};
		if (plain(doc.bestPerPly[i]) && mates[i] == null && mates[i + 1] == null) k = i;
	}
	if (k < 0) throw new Error('no turn with a plain-move best to build the fixture from');
	const me = log[k].color;
	const sign = me === 'red' ? 1 : -1;
	doc.evalPerPly[k] = 8 * sign;       // the player was well ahead ...
	doc.evalPerPly[k + 1] = -8 * sign;  // ... and their turn threw it away
	const review = engine.rustEvalsToReview(doc, log);
	const expected = [];
	for (let i = 0; i < log.length; i++) {
		if (log[i].color === me && ['mistake', 'blunder'].includes(review.classificationPerPly[i]) && Array.isArray(review.bestActionsPerPly[i])) expected.push(i);
	}
	check('fixture: the seeded turn is a blunder', review.classificationPerPly[k] === 'blunder', { k, me, expected });

	// ---- the emulators
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());
	const email = `learn${Date.now()}@example.com`;
	const signUp = await (await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }),
	})).json();
	const uid = signUp.localId;
	if (!uid) throw new Error('sign-up failed: ' + JSON.stringify(signUp));
	const opp = me === 'red' ? 'blue' : 'red';
	await rest('PATCH', '', {
		['rooms/' + code]: {
			status: 'finished', created: Date.now() - 3600_000, finishedAt: Date.now(), ranked: true, variant: 'standard',
			spellNames: ONLINE.spellNames, allowSpectators: true, timeControl: { type: 'none' },
			[me]: { uid, displayName: 'Learner', connected: false },
			[opp]: { uid: 'opp_' + code, displayName: 'Opponent', connected: false },
			gameLog: ONLINE.turns, winner: ONLINE.winner, finalSfn: log[log.length - 1].sfnAfter, gameId: 'G',
		},
		['game_evals/' + code]: doc,
	});

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	const errors = [];
	try {
		const page = await browser.newPage();
		await page.evaluateOnNewDocument(pageHooks, DB.replace('http://', ''), AUTH);
		await page.setBypassServiceWorker(true);
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const url = req.url();
			if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		page.on('pageerror', (e) => errors.push(e.message));

		// ---- 1. the replay, signed in as the player; the stored analysis
		await page.goto(`${BASE}/multiplayer.html?id=${code}`, { waitUntil: 'load', timeout: 90000 });
		await page.waitForFunction(() => !!window.firebase && firebase.apps.length > 0, { timeout: 30000 });
		await page.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), email);
		await page.waitForFunction((s) => {
			const el = document.querySelector(s);
			const d = el && el._x_dataStack && el._x_dataStack[0];
			return d && Array.isArray(d.reviewSfns) && d.reviewSfns.length > 1 && d._authManager && d._authManager.uid;
		}, { timeout: 60000, polling: 250 }, BOARD);
		await page.evaluate(() => document.querySelector('.ai-review-trigger .ai-review-trigger__btn').click());
		await page.waitForFunction((s) => {
			const d = document.querySelector(s)._x_dataStack[0];
			return d.aiReview && !d.aiReviewComputing;
		}, { timeout: 60000, polling: 250 }, BOARD);
		const st = await boardVal(page, '({ source: B.aiReview.source, preset: B.aiReview.preset, engine: B.aiReviewEngineText(), n: B.aiReview.evalPerPly.length, color: B.learnColor(), plies: B.learnPlies(), label: B.learnButtonText() })');
		check('the Quick Review opens the stored server analysis', st.source === 'rust' && st.preset === 'quick' && st.n === log.length + 1, st);
		check('the engine line says where it was analysed', /analysed on the server/.test(st.engine), st.engine);

		// ---- 2. the button
		check('the player is recognised by their seat in the replay', st.color === me, st.color);
		check('the mistakes are the player\'s own mistakes and blunders', JSON.stringify(st.plies) === JSON.stringify(expected), { got: st.plies, expected });
		const btn = await page.evaluate(() => {
			const el = document.querySelector('.ai-review-learn');
			return el && el.offsetParent !== null ? el.textContent.trim() : null;
		});
		check('the review panel shows the button', btn === `Learn from your mistakes (${expected.length})`, btn);

		// ---- 4. the eval cache, through the callable (signed in)
		const probe = log[1].sfnBefore;
		const cached = await page.evaluate(async (sfn) => {
			await requestPositionEvals([sfn]);
			const m = await loadPositionEvals(firebase.database(), [sfn]);
			const e = m.get(sfn);
			return e ? { depth: e.depth, engine: e.engine, best: Array.isArray(e.actions), tag: positionEvalEngineTag() } : null;
		}, probe);
		check('evalPositions caches a position and the page reads it back', !!cached && cached.best && cached.depth >= 1 && cached.engine === cached.tag, cached);
		const forged = await page.evaluate(async () => {
			try { await firebase.database().ref('position_evals/forged').set({ sfn: 'x', stones: 39 }); return 'written'; } catch (e) { return 'refused'; }
		});
		check('the page cannot write the cache itself', forged === 'refused', forged);

		// ---- 3. the puzzles
		await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('.ai-review-learn button')]);
		check('the button opens the learn page', page.url().includes('puzzles.html?learn=' + code), page.url());
		const ready = async () => {
			await page.waitForFunction((s) => {
				const el = document.querySelector(s);
				const d = el && el._x_dataStack && el._x_dataStack[0];
				return d && d.whoseTurn && d.puzzle;
			}, { timeout: 60000, polling: 250 }, BOARD);
			return page.evaluate(() => document.querySelector('.puzzle-panel__title').textContent.trim());
		};
		let title = await ready();
		check('the first mistake is shown', title === `Your mistake 1 of ${expected.length} — ${me === 'red' ? 'Red' : 'Blue'} to move`, title);
		const m = expected.indexOf(k);
		await page.goto(`${BASE}/puzzles.html?learn=${code}&i=${m}`, { waitUntil: 'load', timeout: 60000 });
		title = await ready();
		check('the seeded blunder is reached by its index', title.startsWith(`Your mistake ${m + 1} of`), title);
		const pz = await boardVal(page, '({ sfn: B.puzzle.sfn, mover: B.puzzle.mover, key: puzzleSfnKey(B.currentSfn), keys: B.puzzle.solution_keys, back: window.SIGIL_PUZZLE_NAV.back, sub: document.querySelectorAll(".puzzle-panel__sub")[1].textContent })');
		check('it shows the position before the turn', pz.sfn === log[k].sfnBefore && pz.key === await page.evaluate((x) => puzzleSfnKey(x), log[k].sfnBefore), pz);
		check('the engine\'s best turn is the solution', pz.keys.length === 1, pz.keys);
		check('the way back is the game', pz.back === `multiplayer.html?id=${code}`, pz.back);
		check('the task names both win chances', /best turn keeps a \d+% chance to win; yours kept \d+%/.test(pz.sub), pz.sub);
		await page.click(`#stone-node--${doc.bestPerPly[k][0].node}`);
		await sleep(600);
		if ((await boardVal(page, 'B.actionList')).includes('pass')) await page.click('.action-button--end-turn');
		let s;
		for (let t = 0; t < 30; t++) {
			await sleep(500);
			s = await boardVal(page, '({ status: B.puzzleStatus, msg: B.puzzleMessage, judge: B.puzzleJudge })');
			if (s.status !== 'playing') break;
		}
		check('the engine\'s turn solves it by position, without judging', s.status === 'solved' && !s.judge, s);
		const solvedStore = await page.evaluate(() => localStorage.getItem('sigil_puzzles_solved'));
		check('a learn puzzle is not counted as a puzzle-set solve', !solvedStore || !/learn-/.test(solvedStore), solvedStore);

		// Without the hand-over, the page says what to do.
		const fresh = await browser.newPage();
		await fresh.goto(`${BASE}/puzzles.html?learn=NOPE`, { waitUntil: 'load', timeout: 60000 });
		const msg = await fresh.$eval('#puzzle-loading', (el) => el.textContent);
		check('an empty learn link explains itself', /Learn from your mistakes/.test(msg), msg.trim());
		check('no page errors', errors.length === 0, errors.slice(0, 5));
	} catch (e) {
		check('exception', false, String(e && e.stack || e).slice(0, 800));
	} finally {
		await browser.close();
	}
	console.log(ok ? 'TEST OK' : 'TEST FAILED');
	process.exit(ok ? 0 : 1);
})().catch((e) => { console.log('TEST FAILED', e); process.exit(1); });
