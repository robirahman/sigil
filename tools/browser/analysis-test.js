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
		page.on('requestfailed', r => console.log('requestfailed:', r.url(), r.failure() && r.failure().errorText));
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

		// ---------------- 3b. final-only review: no rewind ----------------
		// A review holding only the final (after-turn) position must open
		// that position as is, not stepped back a turn.
		const finalOnly = await page.evaluate(() => {
			const b = new SigilBoard(['Flourish', 'Carnage', 'Bewitch', 'Grow', 'Fireblast', 'Hail_Storm', 'Sprout', 'Slash', 'Surge']);
			b.setupInitial();
			b.turnCounter = 5; b.whoseTurn = 'red';
			b.update();
			return boardToSfn(b);
		});
		await page.goto(`${BASE}/game.html`, { waitUntil: 'networkidle2', timeout: 60000 });
		await page.waitForFunction(() => window.Alpine && document.querySelector('[x-data]'), { timeout: 15000 });
		await sleep(800);
		await Promise.all([
			page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
			page.evaluate((sfn) => {
				const d = window.Alpine.$data(document.querySelector('[x-data*="gameBoard"]'));
				window.onbeforeunload = null;
				d.reviewSfns = [sfn];
				d.reviewTurnLabels = ['Final position'];
				d._gameLogForExport = null;
				d.openAnalysis(0);
			}, finalOnly),
		]);
		st = await waitFor(page, s => s.mode === 'analyse' && s.tree.length === 1, 20000, 'the final-only review on the analysis board');
		check(st.tree[0].sfn === finalOnly && st.whoseTurn === 'blue',
			'openAnalysis() on a final-only review keeps the after-turn position (blue to move)', st.tree[0].sfn + ' / ' + st.whoseTurn);

		// ---------------- 3c. spell-target endings load ----------------
		const target = await page.evaluate(() => {
			const mk = (red, blue, tc) => {
				const b = new SigilBoard(['Flourish', 'Carnage', 'Bewitch', 'Grow', 'Fireblast', 'Hail_Storm', 'Sprout', 'Slash', 'Surge']);
				b.setupInitial();
				b.turnCounter = tc; b.whoseTurn = tc % 2 === 1 ? 'red' : 'blue';
				b.spellCounter = { red, blue };
				b.update();
				return boardToSfn(b);
			};
			const t = BOARD.spellTarget;
			const hit = mk(t, 2, 11), over = mk(t + 1, 2, 11), notMover = mk(2, t, 11);
			return {
				hit, hitErrs: analysisValidateSfn(hit).errors,
				overErrs: analysisValidateSfn(over).errors,
				notMoverErrs: analysisValidateSfn(notMover).errors,
			};
		});
		check(target.hitErrs.length === 1 && /already decided/.test(target.hitErrs[0]),
			'casting exactly the spell target is a decided, loadable position', JSON.stringify(target.hitErrs));
		check(target.overErrs.some(e => /ends the game/.test(e)), 'more casts than the target are refused', JSON.stringify(target.overErrs));
		check(target.notMoverErrs.some(e => /did not just move/.test(e)), 'the target on the side that did not just move is refused', JSON.stringify(target.notMoverErrs));
		await page.goto(`${BASE}/analysis.html?sfn=${encodeURIComponent(target.hit)}`, { waitUntil: 'networkidle2', timeout: 60000 });
		st = await waitFor(page, s => s.mode, 20000, 'the spell-target ending');
		check(st.mode === 'analyse' && st.tree.length === 1 && st.tree[0].sfn === target.hit,
			'a spell-target ending opens on the analysis board, not the editor', st.mode);

		// ---------------- 3d. Allow Duplicates survives the editor ----------------
		const dup = await page.evaluate(() => {
			const v = composeVariant(false, false, true, false, false);
			const b = new SigilBoard(['Flourish', 'Flourish~2', 'Bewitch', 'Grow', 'Fireblast', 'Hail_Storm', 'Sprout', 'Slash', 'Surge'], v);
			b.setupInitial();
			b.variant = v;
			return boardToSfn(b);
		});
		await page.goto(`${BASE}/analysis.html?mode=edit&sfn=${encodeURIComponent(dup)}`, { waitUntil: 'networkidle2', timeout: 60000 });
		st = await waitFor(page, s => s.mode === 'edit' && s.edSfn, 15000, 'the editor on a duplicates SFN');
		const dupOut = await page.evaluate(() => {
			const d = window.Alpine.$data(document.querySelector('#analysis-root'));
			return { sfn: d.edSfn, dup: variantHasDuplicates(sfnToDict(d.edSfn).variant), blocker: analysisEngineBlocker(d.edSfn) };
		});
		check(dupOut.dup && dupOut.sfn === dup, 'the editor keeps the Allow Duplicates variant', dupOut.sfn);
		check(/Allow Duplicates/.test(dupOut.blocker || ''), 'and the engine stays blocked for it', dupOut.blocker);

		// ---------------- 3e. a running search stops for a decided node ----------------
		await page.goto(`${BASE}/analysis.html?sfn=${encodeURIComponent(start)}`, { waitUntil: 'networkidle2', timeout: 60000 });
		await waitFor(page, s => s.mode === 'analyse' && s.awaiting === 'action', 20000, 'the board for the cancel check');
		const searching = await page.waitForFunction(() => {
			const d = window.Alpine.$data(document.querySelector('#analysis-root'));
			return d._anaSearching;
		}, { timeout: 20000, polling: 100 }).then(() => true, () => false);
		const cancel = await page.evaluate(() => {
			const d = window.Alpine.$data(document.querySelector('#analysis-root'));
			const w = getRustEngineWorker();
			let n = 0;
			const orig = w.cancel;
			w.cancel = function () { n++; return orig.apply(this, arguments); };
			d.anaTree[d.anaCur].winner = 'red';      // as if the selected node were decided
			d.anaStartEval();
			const out = { n, searching: d._anaSearching, status: d.anaEval.status };
			w.cancel = orig;
			d.anaTree[d.anaCur].winner = null;
			return out;
		});
		check(searching && cancel.n === 1 && !cancel.searching && cancel.status === 'decided',
			'selecting a decided node cancels the running search', JSON.stringify({ searching, cancel }));

		// ---------------- 3f. Silence survives a restart ----------------
		const silence = await page.evaluate(() => {
			const spells = ['Flourish', 'Carnage', 'Bewitch', 'Grow', 'Fireblast', 'Hail_Storm', 'Sprout', 'Slash', 'Silence'];
			const b0 = new SigilBoard(spells); b0.setupInitial();
			const s0 = boardToSfn(b0);
			const b1 = new SigilBoard(spells); b1.setupInitial();
			b1.turnCounter = 1; b1.whoseTurn = 'red'; b1.update();
			const s1 = boardToSfn(b1);
			const d = window.Alpine.$data(document.querySelector('#analysis-root'));
			const b2 = new SigilBoard(spells); b2.setupInitial();
			b2.turnCounter = 2; b2.whoseTurn = 'blue'; b2.update();
			const s2 = boardToSfn(b2);
			d.anaSetLine([s0, s1, s2], [
				{ color: 'red', turnNumber: 1, kind: 'input', actions: ['a2', 'Silence', 'submit'] },
				{ color: 'blue', turnNumber: 1, kind: 'input', actions: ['submit'] },
			], 1);
			const after = d._engine && d._engine.board ? Object.assign({}, d._engine.board.silenced) : null;
			const hrefs = ['ai', 'online', 'local'].map(k => d.anaPlayHref(k));
			const note = d.anaPlayNote();
			d.anaGoto(2);
			const keys = d._engine && d._engine.board ? Object.keys(d._engine.board.allLoopingSnapshotCounts || {}) : [];
			d.anaGoto(0);
			const before = d._engine && d._engine.board ? Object.assign({}, d._engine.board.silenced) : null;
			const hrefs0 = ['ai', 'online', 'local'].map(k => d.anaPlayHref(k));
			return { after, before, node: Object.assign({}, d.anaTree[1].silenced), hrefs, hrefs0, note,
				silencedKey: keys.some(k => k.indexOf('|S0/1') >= 0) };
		});
		check(silence.hrefs.every(h => h === null) && /silenced/.test(silence.note),
			'hand-off links are off (with a note) on a silenced position', JSON.stringify({ hrefs: silence.hrefs, note: silence.note }));
		check(silence.hrefs0.every(h => typeof h === 'string' && h.length > 0), 'and back on before it', JSON.stringify(silence.hrefs0));
		check(silence.silencedKey, 'repetition history keeps a silenced ancestor\'s Silence flags');
		check(silence.after && silence.after.blue === true && silence.after.red === false && silence.node.blue === true,
			'the position after a Silence cast restarts with blue silenced', JSON.stringify(silence));
		check(silence.before && !silence.before.red && !silence.before.blue, 'and the position before it does not', JSON.stringify(silence.before));
		// The same SFN with and without Silence are different positions (a
		// charm cast leaves the spell counter alone): replaying the turn
		// without the cast from the root must not reuse the silenced child.
		const reuse = await page.evaluate(() => {
			const d = window.Alpine.$data(document.querySelector('#analysis-root'));
			d.anaGoto(0);
			const s1 = d.anaTree[1].sfn;
			d._analysisOnTurn({ color: 'red', turnNumber: 1, kind: 'input', actions: ['a2', 'submit'], sfnAfter: s1 },
				{ silenced: { red: false, blue: false } });
			const plain = d.anaCur;
			d.anaGoto(0);
			d._analysisOnTurn({ color: 'red', turnNumber: 1, kind: 'input', actions: ['a2', 'Silence', 'submit'], sfnAfter: s1 },
				{ silenced: { red: false, blue: true } });
			const silenced = d.anaCur;
			return { plain, silenced, kids: d.anaTree[0].children.slice(), plainFlags: Object.assign({}, d.anaTree[plain].silenced) };
		});
		check(reuse.plain !== 1 && reuse.silenced === 1 && reuse.kids.length === 2 && !reuse.plainFlags.blue,
			'a turn without Silence to the same SFN is its own node; with it, the silenced node is reused', JSON.stringify(reuse));
		check(await page.evaluate(() => {
			const r = analysisSilencedAfter({ color: 'blue', kind: 'sim', actions: [{ type: 'cast', spell: 'Silence' }] });
			return r.red === true && r.blue === false;
		}), 'sim turns: a cast Silence action silences the enemy');

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
