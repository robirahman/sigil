// Image / GIF export, the embeddable board, typed turns and the opening
// explorer, in a real browser on the Firebase emulators (no live database):
//   1. a finished room's review (multiplayer.html): "Image" downloads a PNG,
//      "GIF" an animated GIF of the whole game (decoded here frame by frame),
//      and the embed code names the game and the position shown;
//   2. embed.html?game= steps through that game (the stones drawn are the
//      position's), and refuses private, unfinished and missing games;
//      embed.html?sfn= draws a position in the frame's ?theme=;
//   3. embed.html?puzzle= is the Puzzles page's chrome-less embed mode, which
//      writes nothing; the Puzzles page offers Image and Embed;
//   4. typed turns on game.html go through the click path: an illegal word is
//      refused before it is sent, a word the controller asks for again is
//      reported, a whole dash turn plays; on analysis.html a typed turn adds
//      a node to the tree;
//   5. openings.html shows the shipped sample (marked as such) and one
//      player's games from user_games and their rooms.
//
//   (cd docs && python3 -m http.server 8804) &
//   firebase emulators:exec --only auth,database --project demo-sigil \
//     'node tools/browser/analysis-export-emulator-test.js http://localhost:8804'
// (FIREBASE_DATABASE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are set by emulators:exec.)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8804';
const NS = 'sigil-js-default-rtdb';
const DB = 'http://' + (process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000');
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const PROJECT = process.env.SIGIL_PROJECT || process.env.GCLOUD_PROJECT || 'demo-sigil';
const OWNER = { Authorization: 'Bearer owner' };
const FUNCTIONS = path.join(__dirname, '..', '..', 'functions');
const { freshEngine } = require(path.join(FUNCTIONS, 'engine-loader'));
const { decodeGif } = require(path.join(__dirname, 'gif-decode.js'));
const ONLINE = require(path.join(FUNCTIONS, 'test', 'online-game.json'));
const PUZZLES = require(path.join(__dirname, '..', '..', 'docs', 'static', 'puzzles', 'mate_puzzles.json'));

function pageHooks(dbHost, authHost, project) {
	let fb;
	Object.defineProperty(window, 'firebase', {
		configurable: true,
		get() { return fb; },
		set(v) {
			fb = v;
			const init = v.initializeApp.bind(v);
			v.initializeApp = (...args) => {
				const app = init(Object.assign({}, args[0], { projectId: project }), ...args.slice(1));
				if (v.auth) app.auth().useEmulator('http://' + authHost, { disableWarnings: true });
				app.database().useEmulator(dbHost.split(':')[0], Number(dbHost.split(':')[1]));
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
const boardWait = (p, expr, timeout) => p.waitForFunction((s, x) => {
	const el = document.querySelector(s);
	const d = el && el._x_dataStack && el._x_dataStack[0];
	if (!d) return false;
	try { return !!new Function('B', 'return ' + x)(d); } catch (e) { return false; }
}, { timeout: timeout || 30000, polling: 100 }, BOARD, expr);

/** Files of `dir` before a download; earlier downloads are removed first, as
 *  Chrome may overwrite a file of the same name in place. */
function downloadsBefore(dir) {
	for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
	return new Set();
}
/** Wait for a new file in `dir` ending in `ext`; resolves to its bytes. */
async function download(dir, ext, before, timeoutMs) {
	const t0 = Date.now();
	for (;;) {
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(ext) && !before.has(f));
		if (files.length) {
			await sleep(300);
			return { name: files[0], bytes: fs.readFileSync(path.join(dir, files[0])) };
		}
		if (Date.now() - t0 > (timeoutMs || 30000)) return null;
		await sleep(150);
	}
}
const pngSize = (b) => (b && b.length > 24 && b.slice(1, 4).toString() === 'PNG' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null);

/** The colour of the stone drawn at `node` on the page's canvas (#id). */
const stoneAt = (page, sel, node, layout) => page.evaluate((s, n, l) => {
	const c = document.querySelector(s);
	const g = BoardImage.geometry(l || 'core');
	const k = c.width / g.ref;
	const p = g.nodes[n];
	const d = c.getContext('2d').getImageData(Math.round(p.x * k), Math.round(p.y * k), 1, 1).data;
	return d[0] > d[2] + 40 ? 'red' : d[2] > d[0] + 40 ? 'blue' : 'other:' + [d[0], d[1], d[2]].join(',');
}, sel, node, layout);

(async () => {
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && !!cond; };
	const stamp = String(Date.now()).slice(-5);
	const CODE = 'EXP' + stamp, SHORT = 'EXS' + stamp, PRIV = 'EXP' + stamp + 'P', LIVE = 'EXL' + stamp;

	const engine = freshEngine();
	const log = await engine.reconstructGameLog(ONLINE.spellNames, 'standard', null, ONLINE.turns);
	const finalSfn = log[log.length - 1].sfnAfter;
	const dashSfn = log[3].sfnAfter;   // red to move with a2, a6: a3 then a dash
	const shortTurns = [
		{ color: 'red', turnNumber: 1, kind: 'input', actions: ['a11', 'pass'] },
		{ color: 'blue', turnNumber: 2, kind: 'input', actions: ['b2', 'pass'] },
	];

	// ---- the emulators
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());
	const email = `export${Date.now()}@example.com`;
	const signUp = await (await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }),
	})).json();
	const uid = signUp.localId;
	if (!uid) throw new Error('sign-up failed: ' + JSON.stringify(signUp));
	const room = (extra) => Object.assign({
		status: 'finished', created: Date.now() - 3600_000, finishedAt: Date.now(), ranked: true, variant: 'standard',
		spellNames: ONLINE.spellNames, allowSpectators: true, timeControl: { type: 'none' },
		red: { uid, displayName: 'Alice', connected: false },
		blue: { uid: 'opp_' + stamp, displayName: 'Bob', connected: false },
		gameLog: ONLINE.turns, winner: ONLINE.winner, finalSfn,
	}, extra);
	await rest('PATCH', '', {
		['rooms/' + CODE]: room({}),
		['rooms/' + SHORT]: room({ red: { uid: 'opp_' + stamp, displayName: 'Bob' }, blue: { uid, displayName: 'Alice' }, gameLog: shortTurns, winner: 'blue', finalSfn: null }),
		['rooms/' + PRIV]: room({ allowSpectators: false }),
		['rooms/' + LIVE]: room({ status: 'playing', winner: null }),
		['users/' + uid + '/displayName']: 'Alice',
		['user_games/' + uid + '/g1']: { timestamp: Date.now() - 2000, roomCode: CODE, color: 'red', result: 'win', opponent: 'Bob', rated: true },
		['user_games/' + uid + '/g2']: { timestamp: Date.now() - 1000, roomCode: SHORT, color: 'blue', result: 'win', opponent: 'Bob', rated: true },
	});

	const dl = fs.mkdtempSync(path.join(process.env.SIGIL_TEST_TMP || os.tmpdir(), 'export-dl-'));
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	const errors = [];
	const dialogs = [];
	const requests = [];
	const newPage = async (w, h) => {
		const page = await browser.newPage();
		await page.setViewport({ width: w || 1280, height: h || 900 });
		await page.evaluateOnNewDocument(pageHooks, DB.replace('http://', ''), AUTH, PROJECT);
		await page.setBypassServiceWorker(true);
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const url = req.url();
			requests.push(url);
			if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		page.on('pageerror', (e) => errors.push(page.url().replace(BASE, '') + ': ' + e.message));
		page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
		page.on('console', (m) => { if (m.type() === 'error') console.log('console error: ' + m.text().slice(0, 300)); });
		const cdp = await page.target().createCDPSession();
		await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
		return page;
	};
	const clickText = (page, sel, text) => page.evaluate((s, t) => {
		const el = [...document.querySelectorAll(s)].find((b) => b.textContent.trim() === t && b.offsetParent !== null);
		if (!el) return false;
		el.click();
		return true;
	}, sel, text);

	try {
		// ---- 1. the review: PNG, GIF, embed code
		let page = await newPage();
		await page.goto(`${BASE}/multiplayer.html?id=${CODE}`, { waitUntil: 'load', timeout: 90000 });
		await boardWait(page, 'B.reviewSfns.length > 1', 60000);
		const n = await boardVal(page, 'B.reviewSfns.length');
		check('the review replays the game', n === log.length + 1, n);
		let before = downloadsBefore(dl);
		check('review bar: Image', await clickText(page, '.review-bar__btn', 'Image'));
		const png = await download(dl, '.png', before);
		check('a PNG of the position (1200 px board + caption)', png && JSON.stringify(pngSize(png.bytes)) === JSON.stringify({ w: 1200, h: 1290 }), png && { name: png.name, size: pngSize(png.bytes) });
		before = downloadsBefore(dl);
		const t0 = Date.now();
		check('review bar: GIF', await clickText(page, '.review-bar__btn', 'GIF'));
		const gif = await download(dl, '.gif', before, 120000);
		check('a GIF of the game', !!gif, gif && gif.name);
		if (gif) {
			let g = null, err = null;
			try { g = decodeGif(gif.bytes); } catch (e) { err = e.message; }
			check('the GIF decodes', !!g, err || { bytes: gif.bytes.length, ms: Date.now() - t0 });
			if (g) {
				check('GIF: 480 px board + caption, loops', g.w === 480 && g.h === 516 && g.loop === 0, { w: g.w, h: g.h, loop: g.loop });
				check('GIF: a frame per position (repeats merged)', g.frames.length >= 40 && g.frames.length <= n, g.frames.length);
				check('GIF: later frames are changed rectangles', g.frames.slice(1).every((f) => f.transparent && f.w * f.h < g.w * g.h), g.frames.slice(1, 4).map((f) => [f.x, f.y, f.w, f.h]));
				check('GIF: the last position stays up longest', g.frames[g.frames.length - 1].delay >= 300, g.frames[g.frames.length - 1].delay);
				check('GIF: named after the room', gif.name === 'sigil-game-' + CODE + '.gif', gif.name);
			}
		}
		check('embed code at the last position: the game at its last ply', (await boardVal(page, 'B.embedQuery()')) === 'game=' + CODE + '&ply=' + (n - 1));
		await page.evaluate((s) => document.querySelector(s)._x_dataStack[0].reviewFirst(), BOARD);
		check('embed code at an earlier position: the game at that ply', (await boardVal(page, 'B.embedQuery()')) === 'game=' + CODE + '&ply=0');
		await browser.defaultBrowserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
		dialogs.length = 0;
		check('review bar: Embed', await clickText(page, '.review-bar__btn', 'Embed'));
		await sleep(500);
		const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')) || dialogs[0] || '';
		check('the embed code is an iframe of embed.html', copied.startsWith('<iframe src="' + BASE + '/embed.html?game=' + CODE + '&amp;ply=0"'), copied);
		await page.close();

		// ---- 2. embed.html
		page = await newPage(420, 520);
		await page.goto(`${BASE}/embed.html?game=${CODE}&ply=3`, { waitUntil: 'load', timeout: 60000 });
		await page.waitForFunction(() => /\(\d+\/\d+\)/.test(document.getElementById('embed-label').textContent), { timeout: 60000 });
		const label = () => page.evaluate(() => document.getElementById('embed-label').textContent);
		check('embed: opens at ?ply=', (await label()).endsWith('(4/' + n + ')'), await label());
		await page.click('#embed-next');
		await page.waitForFunction((t) => document.getElementById('embed-label').textContent.endsWith(t), { timeout: 10000 }, '(5/' + n + ')');
		check('embed: next', true);
		await page.keyboard.press('End');
		await page.waitForFunction((t) => document.getElementById('embed-label').textContent.endsWith(t), { timeout: 10000 }, '(' + n + '/' + n + ')');
		check('embed: End goes to the result', /Red wins/.test(await label()), await label());
		await sleep(300);
		const finStones = (() => { const s = finalSfn.split('/')[0]; const order = []; for (const z of ['a', 'b', 'c']) for (let i = 1; i <= 13; i++) order.push(z + i); const o = {}; order.forEach((k, i) => { o[k] = s[i]; }); return o; })();
		const redNode = Object.keys(finStones).find((k) => finStones[k] === 'r');
		const blueNode = Object.keys(finStones).find((k) => finStones[k] === 'b');
		check('embed: the canvas shows the final stones', await stoneAt(page, '#embed-board', redNode) === 'red' && await stoneAt(page, '#embed-board', blueNode) === 'blue',
			{ redNode, red: await stoneAt(page, '#embed-board', redNode), blueNode, blue: await stoneAt(page, '#embed-board', blueNode) });
		check('embed: the frame links to the full review', (await page.$eval('#embed-open', (a) => a.href)).endsWith('/multiplayer.html?id=' + CODE));
		check('embed: names and result in the footer', /Alice vs Bob · Red wins/.test(await page.$eval('#embed-title', (e) => e.textContent)));
		for (const [code, want] of [[PRIV, /private/], [LIVE, /not finished/], ['NOPE' + stamp, /not found/]]) {
			await page.goto(`${BASE}/embed.html?game=${code}`, { waitUntil: 'load', timeout: 60000 });
			await page.waitForFunction(() => !/Loading/.test(document.getElementById('embed-msg').textContent), { timeout: 30000 });
			const m = await page.$eval('#embed-msg', (e) => e.textContent);
			check('embed: ' + code + ' is refused', want.test(m), m);
		}
		requests.length = 0;
		await page.goto(`${BASE}/embed.html?theme=frost&sfn=${encodeURIComponent(dashSfn)}`, { waitUntil: 'networkidle0', timeout: 60000 });
		await page.waitForFunction(() => !document.getElementById('embed-board-wrap').hidden, { timeout: 10000 });
		await sleep(300);
		check('embed: a position in the frame\'s theme', requests.some((u) => u.endsWith('/static/images/themes/game-board-frost.jpg')) && await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'frost');
		check('embed: the position\'s stones', await stoneAt(page, '#embed-board', 'a2') === 'red' && await stoneAt(page, '#embed-board', 'b11') === 'blue', [await stoneAt(page, '#embed-board', 'a2'), await stoneAt(page, '#embed-board', 'b11')]);
		check('embed: no engine or Firebase loaded for a position', !requests.some((u) => /game-review\.js|firebasejs/.test(u)));
		check('embed: a position opens on the analysis board', (await page.$eval('#embed-open', (a) => a.href)).includes('/analysis.html?sfn='));
		check('embed: the viewer\'s own theme is not changed', await page.evaluate(() => localStorage.getItem('sigil_theme')) !== 'frost');
		const banks = await page.evaluate((sfn) => {
			const st = BoardImage.stateFromSfn(sfn + ' pm:2:0');
			return [st.redBank, st.blueBank, BoardImage.sideText('Alice', 1, 'standard', st.redBank), BoardImage.sideText('Bob', 0, 'deathmatch', st.blueBank)];
		}, dashSfn);
		check('images: Providence banks are read and captioned', JSON.stringify(banks) === JSON.stringify([2, 0, 'Alice · 1 spell · bank 2', 'Bob']), banks);
		await page.close();

		// ---- 3. puzzles
		const pz = PUZZLES.puzzles[0];
		page = await newPage(480, 640);
		await page.goto(`${BASE}/embed.html?puzzle=${encodeURIComponent(pz.id)}`, { waitUntil: 'load', timeout: 60000 });
		await page.waitForFunction(() => /puzzles\.html\?embed=/.test(location.href), { timeout: 20000 });
		await boardWait(page, 'B.puzzle && B.puzzleStatus === "playing" && Object.keys(B.spellDict).length', 60000);
		const pzState = await page.evaluate((s) => {
			const B = document.querySelector(s)._x_dataStack[0];
			const back = [...document.querySelectorAll('.puzzle-panel__nav a')].find((a) => a.offsetParent !== null && /Open on Sigil/.test(a.textContent));
			return {
				cls: document.documentElement.classList.contains('puzzle-embed'),
				header: getComputedStyle(document.querySelector('header')).display,
				embed: B.puzzle.embed, hook: typeof window.SIGIL_PUZZLE_ON_RESULT,
				back: back && { href: back.getAttribute('href'), target: back.getAttribute('target') },
				imageBtn: [...document.querySelectorAll('.puzzle-panel__nav button')].some((b) => b.offsetParent !== null && b.textContent.trim() === 'Image'),
				hscroll: document.documentElement.scrollWidth > window.innerWidth + 2,
			};
		}, BOARD);
		check('puzzle embed: chrome-less, nothing hooked to record a result', pzState.cls && pzState.header === 'none' && pzState.embed === true && pzState.hook === 'undefined', pzState);
		check('puzzle embed: "Open on Sigil" opens the puzzle in a new tab', pzState.back && pzState.back.href === 'puzzles.html?id=' + encodeURIComponent(pz.id) && pzState.back.target === '_blank', pzState.back);
		check('puzzle embed: no export buttons inside the frame', !pzState.imageBtn);
		check('puzzle embed: fits the frame\'s width', !pzState.hscroll);
		await page.evaluate((s) => { localStorage.removeItem('sigil_puzzles_solved'); document.querySelector(s)._x_dataStack[0]._puzzleSolve('Solved!'); }, BOARD);
		check('puzzle embed: solving writes no solved list', (await page.evaluate(() => localStorage.getItem('sigil_puzzles_solved'))) === null);
		if (process.env.SIGIL_SHOTS) await page.screenshot({ path: path.join(process.env.SIGIL_SHOTS, 'puzzle-embed.png') });
		await page.close();
		page = await newPage();
		await page.goto(`${BASE}/puzzles.html?id=${encodeURIComponent(pz.id)}`, { waitUntil: 'load', timeout: 60000 });
		await boardWait(page, 'B.puzzle && Object.keys(B.spellDict).length', 60000);
		check('puzzles page: Image and Embed buttons', await page.evaluate(() => ['Image', 'Embed'].every((t) => [...document.querySelectorAll('.puzzle-panel__nav button')].some((b) => b.offsetParent !== null && b.textContent.trim() === t))));
		check('puzzles page: the embed code names the puzzle', (await boardVal(page, 'B.embedQuery()')) === 'puzzle=' + encodeURIComponent(pz.id));
		before = downloadsBefore(dl);
		await clickText(page, '.puzzle-panel__nav button', 'Image');
		const ppng = await download(dl, '.png', before);
		check('puzzles page: Image downloads a PNG', ppng && pngSize(ppng.bytes) && pngSize(ppng.bytes).w === 1200, ppng && pngSize(ppng.bytes));
		await page.close();

		// ---- 4. typed turns
		page = await newPage();
		await page.goto(`${BASE}/game.html?sfn=${encodeURIComponent(dashSfn)}`, { waitUntil: 'load', timeout: 60000 });
		await boardWait(page, 'B.canTypeTurn() && B.whoseTurn === "red"', 60000);
		const typeTurn = async (text) => {
			await page.evaluate((s, t) => { document.querySelector(s)._x_dataStack[0].typedTurnText = t; }, BOARD, text);
			// The button enables once the board waits for input (the analysis
			// board restarts its controller as it settles on the position).
			await page.waitForFunction(() => [...document.querySelectorAll('.typed-turn__go')].some((b) => b.offsetParent !== null && !b.disabled), { timeout: 20000 });
			await page.evaluate(() => [...document.querySelectorAll('.typed-turn__go')].find((b) => b.offsetParent !== null && !b.disabled).click());
			await sleep(200);
			await boardWait(page, '!B.typedTurnBusy', 20000);
		};
		check('typed: the hint lists the legal words', /^Legal now: .*a3/.test(await boardVal(page, 'B.typedTurnHint()')), await boardVal(page, 'B.typedTurnHint()'));
		await typeTurn('c13');
		let st = await boardVal(page, '({ err: B.typedTurnError, c13: B.nodes.c13, text: B.typedTurnText })');
		check('typed: an illegal move is refused before it is sent', /"c13" is not legal here\. Legal now: /.test(st.err) && st.c13 === null && st.text === 'c13', st);
		await typeTurn('R5. a3 dash c9');
		st = await boardVal(page, '({ err: B.typedTurnError, a3: B.nodes.a3, text: B.typedTurnText, aw: B.awaiting, msg: B.message })');
		check('typed: a word the game asks for again is reported, the rest played', /"c9" was not accepted/.test(st.err) && st.a3 === 'red' && st.text === 'c9' && st.aw === 'node', st);
		check('typed: the part played can be reset, as after clicks', (await boardVal(page, 'B.showReset')) === true);
		await typeTurn('a2 a6');
		const dashTo = Object.keys(await boardVal(page, 'B._lastPrompt.moveoptions'))[0];
		check('typed: the sacrifices are made, the dash move is asked for', !!dashTo && (await boardVal(page, 'B.nodes.a2')) === null && (await boardVal(page, 'B.nodes.a6')) === null, dashTo);
		await typeTurn(dashTo + ' pass');
		st = await boardVal(page, `({ err: B.typedTurnError, who: B.whoseTurn, to: B.nodes['${dashTo}'], text: B.typedTurnText })`);
		check('typed: the dash move and pass end the turn', st.err === '' && st.who === 'blue' && st.to === 'red' && st.text === '', st);
		const recorded = await page.evaluate(() => { const B = document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0]; return JSON.parse(JSON.stringify(B._engine._gameLog.slice(-1)[0].actions)); });
		// The refused c9 stays in the transcript, as a refused click does (replay re-asks the same way).
		check('typed: the turn is recorded in the notation it was typed in', JSON.stringify(recorded) === JSON.stringify(['a3', 'dash', 'c9', 'a2', 'a6', dashTo, 'pass']), recorded);
		before = downloadsBefore(dl);
		await page.evaluate(() => [...document.querySelectorAll('.action-button--image')].find((b) => b.offsetParent !== null).click());
		const gpng = await download(dl, '.png', before);
		check('game page: Image downloads a PNG', gpng && pngSize(gpng.bytes) && pngSize(gpng.bytes).w === 1200);
		await page.close();

		page = await newPage();
		await page.goto(`${BASE}/analysis.html?sfn=${encodeURIComponent(dashSfn)}`, { waitUntil: 'load', timeout: 60000 });
		await boardWait(page, 'B.canTypeTurn()', 60000);
		const rows0 = await boardVal(page, 'B.anaRows().length');
		const first = Object.keys(await boardVal(page, 'B._lastPrompt.moveoptions'))[0];
		await typeTurn(first + ' pass');
		await boardWait(page, `B.anaRows().length > ${rows0}`, 20000).catch(async (e) => {
			console.log('analysis state:', JSON.stringify(await boardVal(page, '({ err: B.typedTurnError, text: B.typedTurnText, can: B.canTypeTurn(), aw: B.awaiting, rows: B.anaRows().length })')));
			throw e;
		});
		st = await boardVal(page, '({ rows: B.anaRows().length, err: B.typedTurnError, q: B.embedQuery(), cur: B.anaCurrentSfn() })');
		check('analysis: a typed turn adds a node to the tree', st.rows === rows0 + 1 && st.err === '', st);
		check('analysis: the embed code is the selected position', st.q === 'sfn=' + encodeURIComponent(st.cur));
		before = downloadsBefore(dl);
		await clickText(page, '.ana-btn', 'Download image');
		const apng = await download(dl, '.png', before);
		check('analysis: Download image', apng && pngSize(apng.bytes) && pngSize(apng.bytes).w === 1200);
		await page.close();

		// ---- 5. the opening explorer
		page = await newPage();
		await page.goto(`${BASE}/openings.html`, { waitUntil: 'load', timeout: 60000 });
		const OX = '[x-data^="openingExplorer"]';
		const oxVal = (expr) => page.evaluate((s, x) => JSON.parse(JSON.stringify(new Function('X', 'return ' + x)(document.querySelector(s)._x_dataStack[0])) ?? 'null'), OX, expr);
		await page.waitForFunction((s) => { const el = document.querySelector(s); const d = el && el._x_dataStack && el._x_dataStack[0]; return d && d.data && d.segment; }, { timeout: 30000 }, OX);
		check('explorer: the sample is marked as synthetic', await page.$eval('.ox__sample', (e) => e.offsetParent !== null));
		const moves = await page.$$eval('.ox__move', (b) => b.filter((x) => x.offsetParent !== null).map((x) => x.textContent.trim()));
		check('explorer: red\'s first turns', moves.length >= 1 && moves.every((m) => /^[a-c]\d+/.test(m)), moves);
		await page.evaluate(() => [...document.querySelectorAll('.ox__move')].find((b) => b.offsetParent !== null).click());
		await sleep(300);
		st = await oxVal('({ path: X.path.length, head: document.querySelector("table th").textContent, rows: X.node() ? X.node().c.length : -1 })');
		check('explorer: a turn opens the replies', st.path === 1 && /Blue/.test(st.head) && st.rows > 0, st);
		await page.evaluate((s) => { document.querySelector(s)._x_dataStack[0].tab = 'layouts'; }, OX);
		await sleep(200);
		const lrows = await page.$$eval('section .ox__spells', (r) => r.filter((x) => x.offsetParent !== null).length);
		check('explorer: the spell layouts', lrows > 0, lrows);
		const canvasDrawn = await page.waitForFunction(() => {
			const c = document.querySelector('.ox__board canvas');
			return c.width > 100 && c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data[3] === 255;
		}, { timeout: 15000 }).then(() => true, () => false);
		check('explorer: the board preview is drawn', canvasDrawn);
		await page.goto(`${BASE}/openings.html?player=${uid}`, { waitUntil: 'load', timeout: 60000 });
		await page.waitForFunction((s) => { const d = document.querySelector(s)._x_dataStack[0]; return d.source === 'player' && d.segment; }, { timeout: 60000 }, OX);
		st = await oxVal('({ games: X.segment.games, name: X.playerName, root: X.tree().p, kids: X.tree().c.map((c) => [c.m, c.n, c.p]), sample: document.querySelector(".ox__sample").offsetParent !== null })');
		check('explorer: one player\'s games from user_games and their rooms', st.games === 2 && st.name === 'Alice' && st.root === 2 && !st.sample, st);
		check('explorer: the player\'s first turns', JSON.stringify(st.kids.map((k) => k[0]).sort()) === JSON.stringify(['a11', 'a2']), st.kids);
		await page.evaluate((s) => document.querySelector(s)._x_dataStack[0].setPlayerSide('blue'), OX);
		await sleep(200);
		check('explorer: as blue only', (await oxVal('X.segment.games')) === 1);
		await page.close();
	} finally {
		await browser.close();
	}
	const real = errors.filter((e) => !/ResizeObserver|Failed to load resource|net::ERR/.test(e));
	check('no page errors', real.length === 0, real);
	fs.rmSync(dl, { recursive: true, force: true });
	console.log(ok ? 'ALL OK' : 'SOME CHECKS FAILED');
	process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
