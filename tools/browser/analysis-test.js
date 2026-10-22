// Headless check of docs/analysis.html (the analysis board and board editor).
//   node tools/browser/analysis-test.js <docs dir> [port] [--coi]
//
// 1. Editor: build a position by clicking nodes (red, blue, a wall) and
//    setting the side to move, turn number, a spell counter and a lock; the
//    exported SFN must reload identically, from the URL and from the Load box.
// 2. Analysis: open ?sfn=<start position>, play a turn on the board, go back,
//    play a different turn (a branch), navigate with the arrow keys, wait for
//    the engine's eval and play its best turn.
// 3. The review hand-off: game.html's openAnalysis() opens the game's line.
// 4. Phone width: no horizontal scroll.
// --coi serves with COOP/COEP (tools/browser/coi-server.py) for the threaded
// engine; without it the single-threaded wasm build runs.
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const DOCS = process.argv[2];
const PORT = Number(process.argv[3]) || 8791;
const COI = process.argv.includes('--coi');
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(ok, what, detail) {
	console.log((ok ? 'PASS ' : 'FAIL ') + what + (detail !== undefined ? ': ' + detail : ''));
	if (!ok) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function waitPort(port, ms) {
	return new Promise((res, rej) => {
		const t0 = Date.now();
		(function tick() {
			http.get({ host: '127.0.0.1', port, path: '/' }, r => { r.resume(); res(); })
				.on('error', () => Date.now() - t0 > ms ? rej(new Error('server not up')) : setTimeout(tick, 200));
		})();
	});
}

// The Alpine component's state (a JSON-safe projection).
async function state(page) {
	return page.evaluate(() => {
		const el = document.querySelector('#analysis-root');
		const d = window.Alpine && window.Alpine.$data(el);
		if (!d) return null;
		return {
			mode: d.anaMode, edSfn: d.edSfn, edErrors: d.edErrors.slice(), cur: d.anaCur,
			tree: d.anaTree.map(n => ({ id: n.id, parent: n.parent, sfn: n.sfn, children: n.children.slice(), kind: n.turn && n.turn.kind, deleted: n.deleted })),
			whoseTurn: d.whoseTurn, awaiting: d.awaiting, actionList: d.actionList.slice(),
			validMoves: Object.keys(d.validMoves || {}),
			evalStatus: d.anaEval.status, evalText: d.anaEval.text, evalDepth: d.anaEval.depth,
			evalBest: !!d.anaEval.best, evalSfn: d.anaEval.sfn, evalNote: d.anaEval.note,
			nodes: Object.assign({}, d.nodes),
		};
	});
}

async function waitFor(page, pred, ms, what) {
	const t0 = Date.now();
	let st = null;
	while (Date.now() - t0 < ms) {
		st = await state(page);
		if (st && pred(st)) return st;
		await sleep(150);
	}
	throw new Error('timed out waiting for ' + what + '; last state ' + JSON.stringify(st && Object.assign({}, st, { nodes: undefined })));
}

// Play one turn for the side to move: a stone on `pick(validMoves)`, then
// end the turn at the first prompt that offers it.
async function playTurn(page, pick) {
	const st = await waitFor(page, s => s.awaiting === 'action' && s.validMoves.length > 0, 20000, 'a move prompt');
	const node = pick(st.validMoves);
	await page.click(`#stone-node--${node}`);
	await waitFor(page, s => s.actionList.includes('pass') || s.awaiting === 'node', 10000, 'the end-turn prompt');
	await page.click('.action-button--end-turn');
	return node;
}

async function key(page, k) {
	await page.keyboard.press(k);
	await sleep(250);
}

(async () => {
	const srv = COI
		? spawn('python3', [path.join(__dirname, 'coi-server.py'), String(PORT), DOCS], { stdio: 'ignore' })
		: spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS, '--bind', '127.0.0.1'], { stdio: 'ignore' });
	let browser;
	try {
		await waitPort(PORT, 15000);
		browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
		const page = await browser.newPage();
		await page.setViewport({ width: 1100, height: 900 });
		page.on('dialog', d => d.accept().catch(() => {}));
		// Every load from the network: the pages register docs/sw.js, whose
		// cached CDN copies coi-server's COEP require-corp refuses (production
		// isolates with credentialless), and a stale worker would mask changes.
		await page.setBypassServiceWorker(true);
		const logs = [];
		page.on('console', m => { if (m.type() === 'error') logs.push('console: ' + m.text()); });
		page.on('pageerror', e => logs.push('pageerror: ' + e.message));

		// ---------------- 1. editor round trip ----------------
		await page.goto(`${BASE}/analysis.html?mode=edit`, { waitUntil: 'networkidle2', timeout: 60000 });
		let st = await waitFor(page, s => s.mode === 'edit' && s.edSfn, 15000, 'the editor');
		check(st.edErrors.length === 0, 'editor opens on a valid start position', st.edSfn);
		// a3 -> red, c2 -> blue (two clicks), b11 -> wall (three clicks).
		await page.click('#stone-node--a3');
		for (let i = 0; i < 2; i++) await page.click('#stone-node--c2');
		for (let i = 0; i < 3; i++) await page.click('#stone-node--b11');
		await page.select('.ed-to-move', 'blue');
		await page.$eval('.ed-turn-no', el => { el.value = '4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
		await page.$eval('.ed-red-sc', el => { el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
		const lockName = await page.$eval('.ed-red-lock', el => (el.options[1] || {}).value || '');
		await page.select('.ed-red-lock', lockName);
		await sleep(300);
		st = await state(page);
		const edited = st.edSfn;
		const parts = edited.split(' ');
		check(st.edErrors.length === 0, 'edited position is valid', JSON.stringify(st.edErrors));
		check(st.nodes.a3 === 'red' && st.nodes.c2 === 'blue' && st.nodes.b11 === 'X', 'node clicks cycle red / blue / wall',
			JSON.stringify({ a3: st.nodes.a3, c2: st.nodes.c2, b11: st.nodes.b11 }));
		check(parts[2] === '7' && parts[3] === '2:0' && parts[4] === lockName + ':-', 'turn, counter and lock fields',
			parts.slice(1, 6).join(' '));
		const wallDrawn = await page.$eval('#stone-node--b11', el => el.classList.contains('stone-node--destroyed'));
		check(wallDrawn, 'the wall is drawn on the board');
		const shownSfn = await page.$eval('.ana-current-sfn', el => el.value);
		check(shownSfn === edited, 'the live SFN box shows the position');

		// Reload from the URL.
		await page.goto(`${BASE}/analysis.html?mode=edit&sfn=${encodeURIComponent(edited)}`, { waitUntil: 'networkidle2', timeout: 60000 });
		st = await waitFor(page, s => s.mode === 'edit' && s.edSfn, 15000, 'the editor (reload)');
		check(st.edSfn === edited, 'editor round-trips its SFN through the URL', st.edSfn);
		// Reload through the Load box, from a different position.
		await page.click('.ana-edit .ana-btn');            // Clear board
		st = await state(page);
		check(st.edErrors.some(e => /already decided/.test(e)), 'an empty board is reported as decided', JSON.stringify(st.edErrors));
		await page.$eval('.ed-import', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, edited);
		await page.click('.ed-load');
		await sleep(300);
		st = await state(page);
		check(st.edSfn === edited, 'editor round-trips its SFN through the Load box', st.edSfn);
		// A malformed SFN is refused with a message.
		await page.$eval('.ed-import', el => { el.value = 'rb../Flourish r 0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
		await page.click('.ed-load');
		await sleep(200);
		const importErr = await page.$eval('.ed-import ~ *, .ana-edit .ana-errors[role="alert"]', () =>
			window.Alpine.$data(document.querySelector('#analysis-root')).edImportError);
		check(!!importErr, 'a malformed SFN is refused', importErr);
		// Hand-off links.
		const hrefs = await page.evaluate(() => ({
			ai: document.querySelector('.ana-play-ai').getAttribute('href'),
			online: document.querySelector('.ana-play-online').getAttribute('href'),
			local: document.querySelector('.ana-play-local').getAttribute('href'),
		}));
		check(hrefs.ai === 'game.html?sfn=' + encodeURIComponent(edited) + '&ai=rust_hard', 'Play vs AI hands the SFN to game.html', hrefs.ai);
		check(hrefs.online === 'multiplayer.html?sfn=' + encodeURIComponent(edited), 'Play a friend online opens multiplayer.html from the position', hrefs.online);
		check(hrefs.local === 'game.html?sfn=' + encodeURIComponent(edited), 'Play a friend on this device', hrefs.local);

		// ---------------- 2. analysis ----------------
		const start = await page.evaluate(() => {
			const b = new SigilBoard(['Flourish', 'Carnage', 'Bewitch', 'Grow', 'Fireblast', 'Hail_Storm', 'Sprout', 'Slash', 'Surge']);
			b.setupInitial();
			return boardToSfn(b);
		});
		await page.goto(`${BASE}/analysis.html?sfn=${encodeURIComponent(start)}`, { waitUntil: 'networkidle2', timeout: 60000 });
		st = await waitFor(page, s => s.mode === 'analyse' && s.whoseTurn === 'red' && s.awaiting === 'action', 20000, 'the analysis board');
		check(st.tree.length === 1 && st.tree[0].sfn === start, 'analysis loads ?sfn as the root');
		const first = await playTurn(page, v => v.slice().sort()[0]);
		st = await waitFor(page, s => s.tree.length === 2 && s.cur === 1, 15000, 'the first turn in the tree');
		check(st.tree[0].children.length === 1, 'a played turn becomes a child node', first);
		st = await waitFor(page, s => s.whoseTurn === 'blue' && s.awaiting === 'action', 15000, 'blue to move');
		check(true, 'the board continues with blue to move');

		// Back, then a different turn: a branch.
		await key(page, 'ArrowLeft');
		st = await waitFor(page, s => s.cur === 0 && s.whoseTurn === 'red' && s.awaiting === 'action', 15000, 'back at the root');
		const second = await playTurn(page, v => v.filter(n => n !== first).sort()[0]);
		st = await waitFor(page, s => s.tree.length === 3 && s.cur === 2, 15000, 'the branch');
		check(st.tree[0].children.length === 2, 'a different turn from an earlier node adds a variation', first + ' / ' + second);
		const rows = await page.$$eval('.ana-tree__row', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
		check(rows.length === 3, 'the tree lists the root and both variations', JSON.stringify(rows));

		// Keys: up/down switch variation, left/right step.
		await key(page, 'ArrowUp');
		st = await state(page);
		check(st.cur === 1, 'ArrowUp switches to the previous variation', st.cur);
		await key(page, 'ArrowDown');
		st = await state(page);
		check(st.cur === 2, 'ArrowDown switches to the next variation', st.cur);
		await key(page, 'ArrowLeft');
		st = await state(page);
		check(st.cur === 0, 'ArrowLeft goes back', st.cur);
		await key(page, 'ArrowRight');
		st = await state(page);
		check(st.cur === 2, 'ArrowRight follows the last visited variation', st.cur);
		// Clicking a row selects it.
		await page.click('.ana-tree__row[data-node="1"]');
		await sleep(250);
		st = await state(page);
		check(st.cur === 1, 'clicking a tree row selects it', st.cur);

		// The engine: an eval for the selected node, then its best turn.
		st = await waitFor(page, s => s.evalText && s.evalSfn === s.tree[s.cur].sfn && s.evalBest, 90000, 'an engine eval');
		check(/^([+-]?\d+\.\d|0\.0|(Red|Blue) wins in \d+)/.test(st.evalText) && st.evalDepth >= 1,
			'the engine evaluates the node', st.evalText + ' at depth ' + st.evalDepth);
		const before = st.tree.length;
		const parentId = st.cur;
		await page.click('.ana-play-best');
		st = await waitFor(page, s => s.tree.length === before + 1, 30000, 'the engine turn in the tree');
		const added = st.tree[st.tree.length - 1];
		check(added.parent === parentId && added.kind === 'sim' && st.cur === added.id, 'Play best turn adds the engine\'s turn', added.kind);
		st = await waitFor(page, s => s.awaiting === 'action' && s.whoseTurn === 'red', 20000, 'red to move after the engine turn');
		check(true, 'the board is playable after the engine turn');

		// ---------------- 3. hand-off from a game review ----------------
		const line = await page.evaluate(() => {
			const d = window.Alpine.$data(document.querySelector('#analysis-root'));
			const a = d.anaTree[0], b = d.anaTree[1];
			return { sfns: [positionTurnSfn(a.sfn), b.sfn], turn: Object.assign({ sfnBefore: positionTurnSfn(a.sfn), sfnAfter: b.sfn }, b.turn) };
		});
		await page.goto(`${BASE}/game.html`, { waitUntil: 'networkidle2', timeout: 60000 });
		await page.waitForFunction(() => window.Alpine && document.querySelector('[x-data]'), { timeout: 15000 });
		await sleep(800);
		await Promise.all([
			page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
			page.evaluate((line) => {
				const d = window.Alpine.$data(document.querySelector('[x-data*="gameBoard"]'));
				window.onbeforeunload = null;
				d.reviewSfns = line.sfns;
				d._gameLogForExport = [line.turn];
				d.openAnalysis(1);
			}, line),
		]);
		st = await waitFor(page, s => s.mode === 'analyse' && s.tree.length === 2, 20000, 'the review line on the analysis board');
		check(st.cur === 1 && st.tree[1].sfn === line.sfns[1] && st.tree[0].sfn !== line.sfns[0],
			'openAnalysis() opens the game line at the reviewed position (start stepped back to a loadable SFN)');

		// ---------------- 4. phone width ----------------
		await page.setViewport({ width: 375, height: 800, isMobile: true, hasTouch: true });
		await page.goto(`${BASE}/analysis.html?sfn=${encodeURIComponent(start)}`, { waitUntil: 'networkidle2', timeout: 60000 });
		await waitFor(page, s => s.mode === 'analyse' && s.awaiting === 'action', 20000, 'the board at phone width');
		const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
		check(widths.doc <= widths.win + 1, 'no horizontal scroll at 375 px', JSON.stringify(widths));
		await page.click('.ana-tab:nth-child(2)');
		await sleep(400);
		const widthsEdit = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
		check(widthsEdit.doc <= widthsEdit.win + 1, 'no horizontal scroll in the editor at 375 px', JSON.stringify(widthsEdit));

		const errs = logs.filter(l => !/typekit|fonts\.g|favicon|ERR_BLOCKED|firebase|auth/i.test(l));
		check(errs.length === 0, 'no page errors', errs.join(' | '));
	} finally {
		if (browser) await browser.close();
		srv.kill();
	}
	console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
	process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
