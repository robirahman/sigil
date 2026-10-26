// Board tools: arrows and circles (board-marks.js) and zen mode
// (settings-panel.js, Z in game-keys.js).
//
//   (cd docs && python3 -m http.server 8809) &
//   node tools/browser/board-tools-test.js http://localhost:8809
//
// 1. game.html, local 1v1: right-drag draws an arrow, right-click a circle,
//    Shift a red arrow, the same gesture again removes it; none of it plays
//    a stone. A left click still plays the node it lands on, with the marks
//    on the board. End Turn clears them; Escape clears them too.
// 2. Touch (phone emulation): the pencil turns on draw mode, where a tap
//    draws a circle and a drag an arrow without playing; off again, a tap
//    plays the node.
// 3. Zen: Z hides the header, log and Forfeit but keeps the board, the
//    End Turn button and the clock; the setting persists across a reload
//    and the Exit button leaves it. The ? list shows Z. In multiplayer.html's
//    lobby Z does nothing.
// 4. analysis.html: marks are kept per tree node.
// Requests to Firebase hosts are blocked; nothing is written anywhere.
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8809';

let failures = 0;
function check(label, ok, detail) {
	console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
	if (!ok) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function newPage(browser, errors, opts = {}) {
	const ctx = await browser.createBrowserContext();
	const page = await ctx.newPage();
	await page.setRequestInterception(true);
	page.on('request', (r) => {
		if (/firebaseio\.com|identitytoolkit|securetoken|firebaseinstallations/.test(r.url())) r.abort();
		else r.continue();
	});
	let cdnFailed = false;
	page.on('requestfailed', (r) => {
		if (!/firebaseio\.com|identitytoolkit|securetoken|firebaseinstallations/.test(r.url()) && !r.url().startsWith(BASE)) cdnFailed = true;
	});
	page.on('pageerror', (e) => {
		const msg = page.url().replace(BASE, '') + ': ' + e.message;
		if (cdnFailed && /firebase|INTERNAL/.test(e.message)) console.log('note: after a CDN failure: ' + msg);
		else errors.push(msg);
	});
	page.on('dialog', (d) => d.accept());
	if (opts.phone) {
		await page.setViewport({ width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
	} else {
		await page.setViewport({ width: 1200, height: 900 });
	}
	return page;
}

const board = (page) => page.evaluate(() => {
	const d = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
	return {
		whose: d.whoseTurn, actions: [...d.actionList],
		valid: Object.keys(d.validMoves).filter(k => d.validMoves[k]),
		stones: Object.keys(d.nodes).filter(k => d.nodes[k] === 'red' || d.nodes[k] === 'blue').sort(),
	};
});

const marks = (page) => page.evaluate(() =>
	[...document.querySelectorAll('.board-marks .board-mark:not(.board-mark--preview)')].map(g => ({
		from: g.getAttribute('data-from'), to: g.getAttribute('data-to'),
		colour: [...g.classList].find(c => /^board-mark--(green|red|blue|yellow)$/.test(c)).slice(12),
		shape: g.querySelector('circle') ? 'circle' : 'arrow',
	})));

async function centre(page, node) {
	await page.$eval('#stone-node--' + node, el => el.scrollIntoView({ block: 'center', inline: 'center' }));
	return page.$eval('#stone-node--' + node, el => {
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
}

async function rightDrag(page, from, to, modifier) {
	const a = await centre(page, from);
	if (modifier) await page.keyboard.down(modifier);
	await page.mouse.move(a.x, a.y);
	await page.mouse.down({ button: 'right' });
	const b = to === from ? a : await page.$eval('#stone-node--' + to, el => {
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
	await page.mouse.move(b.x, b.y, { steps: 4 });
	await page.mouse.up({ button: 'right' });
	if (modifier) await page.keyboard.up(modifier);
	await sleep(50);
}

async function openGame(page, path = '/game.html') {
	await page.goto(BASE + path, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => {
		const el = document.querySelector('[x-data^="gameBoard"]');
		if (!el || !window.Alpine) return false;
		const d = Alpine.$data(el);
		return d.actionList.includes('move') && Object.values(d.validMoves).some(Boolean);
	}, { timeout: 30000 });
}

const visible = (page, sel) => page.evaluate((s) => {
	const el = document.querySelector(s);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0;
}, sel);

(async () => {
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	const errors = [];
	try {
		// ---------------- 1. mouse ----------------
		let page = await newPage(browser, errors);
		await openGame(page);
		let st = await board(page);
		// Marks go on any node, legal or not.
		const allNodes = await page.evaluate(() => Object.keys(Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).nodes));
		const n1 = st.valid.slice().sort()[0];
		const n2 = st.valid.slice().sort()[1] || allNodes.find(n => n !== n1);
		const n3 = allNodes.find(n => n !== n1 && n !== n2);
		const stonesBefore = st.stones;
		check('the marks layer and tools are on the board', await page.evaluate(() =>
			!!document.querySelector('.stone-nodes').parentElement.querySelector(':scope > svg.board-marks')));
		check('the pencil is hidden on a mouse screen', !(await visible(page, '.board-marks-tools__draw')));

		const menuShown = await page.evaluate(() => {
			const el = document.getElementById('stone-node--' + Object.keys(Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).nodes)[0]);
			const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
			return el.dispatchEvent(ev);
		});
		check('right-click on the board suppresses the context menu', menuShown === false);

		await rightDrag(page, n1, n2);
		let m = await marks(page);
		check('right-drag draws a green arrow', m.length === 1 && m[0].from === n1 && m[0].to === n2 && m[0].shape === 'arrow' && m[0].colour === 'green', m);
		await rightDrag(page, n3, n3);
		await rightDrag(page, n2, n3, 'Shift');
		m = await marks(page);
		check('right-click draws a circle; Shift gives a red arrow', m.length === 3
			&& m.some(x => x.from === n3 && x.to === n3 && x.shape === 'circle')
			&& m.some(x => x.from === n2 && x.to === n3 && x.colour === 'red'), m);
		await rightDrag(page, n3, n3);
		m = await marks(page);
		check('the same right-click again removes the circle', m.length === 2 && !m.some(x => x.shape === 'circle'), m);
		st = await board(page);
		check('drawing played nothing', JSON.stringify(st.stones) === JSON.stringify(stonesBefore) && st.actions.includes('move') && !st.actions.includes('pass'), st);
		check('the clear button shows while there are marks', await visible(page, '.board-marks-tools__clear'));

		// A left click still lands on the node under it, marks or not.
		const target = n2;
		const c = await centre(page, target);
		await page.mouse.click(c.x, c.y);
		await page.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).actionList.includes('pass'), { timeout: 10000 });
		st = await board(page);
		check('a left click with marks on the board plays the clicked node', st.stones.includes(target) && st.stones.length === stonesBefore.length + 1, { target, stones: st.stones });
		check('marks stay during the turn', (await marks(page)).length === 2);
		await page.click('.action-button--end-turn');
		await page.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).whoseTurn === 'blue', { timeout: 10000 });
		await sleep(100);
		check('End Turn clears the marks', (await marks(page)).length === 0, await marks(page));
		await page.waitForFunction(() => Object.values(Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).validMoves).some(Boolean), { timeout: 10000 });
		st = await board(page);
		await rightDrag(page, st.valid[0], allNodes.find(n => n !== st.valid[0]), 'Alt');
		check('Alt gives a blue arrow', (await marks(page)).some(x => x.colour === 'blue'));
		await page.keyboard.press('Escape');
		check('Escape clears the marks', (await marks(page)).length === 0);
		await rightDrag(page, st.valid[0], st.valid[0]);
		await page.click('.board-marks-tools__clear');
		check('the clear button clears the marks', (await marks(page)).length === 0);

		// ---------------- 3. zen (same page) ----------------
		check('zen is off by default', await page.evaluate(() => !document.documentElement.hasAttribute('data-zen')));
		await page.evaluate(() => document.activeElement && document.activeElement.blur());
		await page.keyboard.press('z');
		const zen = await page.evaluate(() => ({
			attr: document.documentElement.hasAttribute('data-zen'),
			stored: JSON.parse(localStorage.getItem('sigil_settings') || '{}').zen,
		}));
		check('Z turns zen on and stores it in sigil_settings', zen.attr && zen.stored === true, zen);
		check('zen hides the header', !(await visible(page, 'header .header-container')));
		check('zen hides the game log', !(await visible(page, '.feed--history')));
		check('zen hides the rules menu', !(await visible(page, '.help-menu-container')));
		check('zen hides Forfeit', !(await visible(page, '.action-button--forfeit')));
		check('zen keeps the board', await visible(page, '.game-board-container'));
		check('zen shows the exit button', await visible(page, '.zen-exit'));
		const sb = await board(page);
		const nzen = sb.valid[0];
		await page.click('#stone-node--' + nzen);
		await page.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).actionList.includes('pass'), { timeout: 10000 });
		check('zen keeps End Turn', await visible(page, '.action-button--end-turn'));
		await page.reload({ waitUntil: 'load' });
		await page.waitForFunction(() => window.Alpine && document.querySelector('[x-data^="gameBoard"]'), { timeout: 30000 });
		check('zen persists across a reload', await page.evaluate(() => document.documentElement.hasAttribute('data-zen')));
		await page.click('.settings-toggle').catch(() => {});
		await page.evaluate(() => SigilDialog.openSettings());
		check('the settings panel shows zen checked', await page.$eval('#settings-panel [data-setting="zen"]', el => el.checked && el.closest('.settings-panel__row').getBoundingClientRect().height > 0));
		await page.keyboard.press('Escape');
		await page.click('.zen-exit');
		check('the exit button leaves zen', await page.evaluate(() => !document.documentElement.hasAttribute('data-zen')
			&& JSON.parse(localStorage.getItem('sigil_settings')).zen === false));
		check('the header is back', await visible(page, 'header .header-container'));
		await page.keyboard.press('?');
		const list = await page.$$eval('#shortcuts-overlay dt', ds => ds.filter(d => d.getBoundingClientRect().height > 0).map(d => d.textContent));
		check('the ? list shows Z and Right-drag', list.includes('Z') && list.includes('Right-drag'), list);
		await page.keyboard.press('Escape');
		await page.close();

		// Multiplayer lobby: no zen there.
		page = await newPage(browser, errors);
		await page.goto(BASE + '/multiplayer.html', { waitUntil: 'load', timeout: 60000 });
		await page.waitForFunction(() => window.Alpine && document.getElementById('settings-panel'), { timeout: 30000 });
		await sleep(300);
		await page.keyboard.press('z');
		check('Z does nothing in the multiplayer lobby', await page.evaluate(() =>
			!document.body.classList.contains('zen-page') && !document.documentElement.hasAttribute('data-zen')));
		await page.close();

		// ---------------- 2. touch ----------------
		page = await newPage(browser, errors, { phone: true });
		await openGame(page);
		check('the pencil shows on a touch screen', await visible(page, '.board-marks-tools__draw'));
		st = await board(page);
		const t1 = st.valid.slice().sort()[0];
		const t2 = st.valid.slice().sort()[1] || st.valid[0];
		const before = st.stones;
		await page.tap('.board-marks-tools__draw');
		check('the pencil turns draw mode on', await page.$eval('.board-marks-tools__draw', b => b.getAttribute('aria-pressed') === 'true'));
		let p = await centre(page, t1);
		await page.touchscreen.tap(p.x, p.y);
		await sleep(100);
		m = await marks(page);
		check('in draw mode a tap draws a circle', m.length === 1 && m[0].shape === 'circle' && m[0].from === t1, m);
		const q = await centre(page, t2);
		p = await centre(page, t1);
		await page.touchscreen.touchStart(p.x, p.y);
		await page.touchscreen.touchMove((p.x + q.x) / 2, (p.y + q.y) / 2);
		await page.touchscreen.touchMove(q.x, q.y);
		await page.touchscreen.touchEnd();
		await sleep(100);
		m = await marks(page);
		check('in draw mode a drag draws an arrow', m.some(x => x.from === t1 && x.to === t2 && x.shape === 'arrow'), m);
		st = await board(page);
		check('draw mode played nothing', JSON.stringify(st.stones) === JSON.stringify(before) && !st.actions.includes('pass'), st);
		await page.tap('.board-marks-tools__draw');
		p = await centre(page, t2);
		await page.touchscreen.tap(p.x, p.y);
		await page.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).actionList.includes('pass'), { timeout: 10000 });
		st = await board(page);
		check('with draw mode off a tap plays the node', st.stones.includes(t2), st.stones);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		check('phone width: the tools add no horizontal scroll', overflow <= 0 || await page.evaluate(() => {
			// game.html's board has a min width of its own; only count overflow the tools cause.
			const t = document.querySelector('.board-marks-tools').getBoundingClientRect();
			const b = document.querySelector('.stone-nodes').parentElement.getBoundingClientRect();
			return t.right <= b.right + 1;
		}), overflow);
		await page.close();

		// ---------------- 4. analysis ----------------
		page = await newPage(browser, errors);
		await page.goto(BASE + '/analysis.html?mode=edit', { waitUntil: 'load', timeout: 60000 });
		await page.waitForFunction(() => typeof SigilBoard !== 'undefined' && window.Alpine && document.querySelector('#analysis-root'), { timeout: 30000 });
		const start = await page.evaluate(() => {
			const b = new SigilBoard(['Flourish', 'Carnage', 'Bewitch', 'Grow', 'Fireblast', 'Hail_Storm', 'Sprout', 'Slash', 'Surge']);
			b.setupInitial();
			return boardToSfn(b);
		});
		await page.goto(`${BASE}/analysis.html?sfn=${encodeURIComponent(start)}`, { waitUntil: 'load', timeout: 60000 });
		const ana = () => page.evaluate(() => {
			const d = Alpine.$data(document.querySelector('#analysis-root'));
			return { mode: d.anaMode, cur: d.anaCur, n: d.anaTree.length, awaiting: d.awaiting, valid: Object.keys(d.validMoves).filter(k => d.validMoves[k]).sort(), pass: d.actionList.includes('pass') };
		});
		await page.waitForFunction(() => {
			const d = window.Alpine && Alpine.$data(document.querySelector('#analysis-root'));
			return d && d.anaMode === 'analyse' && d.awaiting === 'action' && Object.values(d.validMoves).some(Boolean);
		}, { timeout: 30000 }).catch(async (e) => { console.log('analysis state: ' + JSON.stringify(await ana())); throw e; });
		let a = await ana();
		await rightDrag(page, a.valid[0], a.valid[1]);
		check('analysis: an arrow on the root', (await marks(page)).length === 1);
		await page.click('#stone-node--' + a.valid[0]);
		await page.waitForFunction(() => Alpine.$data(document.querySelector('#analysis-root')).actionList.includes('pass'), { timeout: 10000 });
		await page.click('.action-button--end-turn');
		await page.waitForFunction(() => Alpine.$data(document.querySelector('#analysis-root')).anaCur === 1, { timeout: 15000 });
		await sleep(100);
		check('analysis: the child node starts with no marks', (await marks(page)).length === 0, await marks(page));
		await page.waitForFunction(() => {
			const d = Alpine.$data(document.querySelector('#analysis-root'));
			return d.awaiting === 'action' && Object.values(d.validMoves).some(Boolean);
		}, { timeout: 15000 });
		a = await ana();
		await rightDrag(page, a.valid[0], a.valid[0]);
		check('analysis: a circle on the child', (await marks(page)).length === 1 && (await marks(page))[0].shape === 'circle');
		await page.evaluate(() => Alpine.$data(document.querySelector('#analysis-root')).anaGoto(0));
		await sleep(150);
		m = await marks(page);
		check('analysis: back on the root its arrow returns', m.length === 1 && m[0].shape === 'arrow', m);
		await page.evaluate(() => Alpine.$data(document.querySelector('#analysis-root')).anaGoto(1));
		await sleep(150);
		m = await marks(page);
		check('analysis: on the child its circle returns', m.length === 1 && m[0].shape === 'circle', m);
		await page.close();
	} catch (e) {
		console.log('FAIL exception: ' + (e.stack || e));
		failures++;
	}
	check('no page errors', errors.length === 0, errors);
	await browser.close();
	console.log(failures ? `TEST FAILED (${failures})` : 'TEST OK');
	process.exit(failures ? 1 : 0);
})();
