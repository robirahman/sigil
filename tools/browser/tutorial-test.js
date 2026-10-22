// Headless check of docs/tutorial.html: plays every lesson start to finish
// with its scripted steps (real clicks on the board, spells and buttons),
// makes wrong moves in two lessons and checks the hint + reset, checks the
// saved progress, and fails on any page error or console error.
//   node tools/browser/tutorial-test.js <docs dir> [port]   (default: a random port 8900-8999)
// Phone width: the run uses a 390 px wide viewport and checks that the page
// does not scroll sideways.
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');

const DOCS = process.argv[2] || 'docs';
const PORT = parseInt(process.argv[3], 10) || 8900 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

function waitPort(port, ms) {
	return new Promise((res, rej) => {
		const t0 = Date.now();
		(function tick() {
			http.get({ host: '127.0.0.1', port, path: '/' }, r => { r.resume(); res(); })
				.on('error', () => Date.now() - t0 > ms ? rej(new Error('server not up')) : setTimeout(tick, 200));
		})();
	});
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The Alpine component's state, read in the page.
function state(page) {
	return page.evaluate(() => {
		const el = document.getElementById('tutorial-root');
		const d = window.Alpine && window.Alpine.$data(el);
		if (!d) return null;
		return {
			index: d.tutorialIndex, step: d.tutorialStep, status: d.tutorialStatus, hint: d.tutorialHint,
			awaiting: d.awaiting, actionList: d.actionList.slice(), winner: d.winner,
			validMoves: Object.assign({}, d.validMoves), nodesToRefill: Object.assign({}, d.nodesToRefill),
			targets: Object.keys(d.tutorialTargets), targetAction: d.tutorialTargetAction,
			spellDict: Object.assign({}, d.spellDict), done: Object.assign({}, d.tutorialDone),
			nodes: Object.assign({}, d.nodes),
		};
	});
}

async function waitFor(page, pred, what, ms = 15000) {
	const t0 = Date.now();
	let s = null;
	while (Date.now() - t0 < ms) {
		s = await state(page);
		if (s && pred(s)) return s;
		await sleep(100);
	}
	throw new Error('timed out waiting for ' + what + '; state ' + JSON.stringify(s && {
		index: s.index, step: s.step, status: s.status, awaiting: s.awaiting, actionList: s.actionList, hint: s.hint,
	}));
}

const isNode = (t) => /^[abc]\d{1,2}$/.test(t);

// The selector of the board element a token clicks.
function selectorFor(s, token) {
	if (isNode(token)) return '#stone-node--' + token;
	if (token === 'dash') return '.action-button--dash';
	if (token === 'pass') return '.action-button--end-turn';
	const slot = Object.keys(s.spellDict).find(k => s.spellDict[k] === token);
	if (!slot) throw new Error('spell not on the board: ' + token);
	const m = slot.match(/^(charm|ritual|sorcery)(\d)$/);
	return `img.spell.${m[1]}-spell--${m[2]}`;
}

// Wait until the game is ready for `token`, then click it.
async function play(page, token, stepIndex) {
	await waitFor(page, s => s.status === 'playing' && s.step === stepIndex && (isNode(token)
		? (s.awaiting === 'node' || (s.awaiting === 'action' && s.actionList.includes('move')))
		: (s.awaiting === 'action' && s.actionList.includes(token))), 'step ' + stepIndex + ' (' + token + ')');
	const s = await state(page);
	const sel = selectorFor(s, token);
	await page.waitForSelector(sel, { visible: true });
	// Click a point of the element that is really on top there (a charm's
	// image sits under its node's stone, so its centre is the stone).
	const pt = await page.$eval(sel, el => {
		el.scrollIntoView({ block: 'center', inline: 'center' });
		const r = el.getBoundingClientRect();
		for (let fy = 0.5; fy > 0; fy -= 0.05) {
			for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
				for (const y of [r.top + r.height * fy, r.bottom - r.height * fy]) {
					const x = r.left + r.width * fx;
					const hit = document.elementFromPoint(x, y);
					if (hit === el || el.contains(hit)) return { x, y };
				}
			}
		}
		return null;
	});
	if (!pt) throw new Error('no clickable point on ' + sel);
	await page.mouse.click(pt.x, pt.y);
	await sleep(150);
}

// Play a lesson's steps; an { any } step takes the first node offered.
async function playLesson(page, lesson) {
	for (let i = 0; i < lesson.steps.length; i++) {
		const d = lesson.steps[i].do;
		if (typeof d === 'string') {
			await play(page, d, i);
		} else if (d.oneOf) {
			await play(page, d.oneOf[0], i);
		} else if (d.all) {
			for (const t of d.all) await play(page, t, i);
		} else if (d.any) {
			const s = await waitFor(page, s => s.step === i && s.awaiting === 'node'
				&& (Object.keys(s.validMoves).length || Object.keys(s.nodesToRefill).length), 'offered nodes at step ' + i);
			const offered = Object.keys(s.nodesToRefill).length ? s.nodesToRefill : s.validMoves;
			await play(page, Object.keys(offered)[0], i);
		}
	}
	return waitFor(page, s => s.status === 'done', 'lesson "' + lesson.id + '" to finish');
}

(async () => {
	const srv = spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS], { stdio: 'ignore' });
	let failed = 0;
	const check = (ok, msg) => {
		console.log((ok ? 'ok   ' : 'FAIL ') + msg);
		if (!ok) failed++;
	};
	try {
		await waitPort(PORT, 15000);
		const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
		const page = await browser.newPage();
		await page.setViewport({ width: 390, height: 844 });
		const errors = [];
		page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
		page.on('pageerror', e => errors.push('pageerror: ' + e.message));
		page.on('response', r => { if (r.status() >= 400) errors.push('http ' + r.status() + ': ' + r.url().slice(0, 120)); });

		await page.goto(`${BASE}/tutorial.html`, { waitUntil: 'networkidle2', timeout: 60000 });
		await page.evaluate(() => { try { localStorage.removeItem('sigil_tutorial_done'); } catch (e) { /* */ } });
		const lessons = await page.evaluate(() => window.SIGIL_TUTORIAL_LESSONS);
		check(lessons && lessons.length >= 8, 'lessons loaded: ' + (lessons && lessons.length));

		for (let i = 0; i < lessons.length; i++) {
			const lesson = lessons[i];
			await page.goto(`${BASE}/tutorial.html?lesson=${i + 1}`, { waitUntil: 'networkidle2', timeout: 60000 });
			await waitFor(page, s => s.index === i && s.status === 'playing', 'lesson ' + (i + 1) + ' to load');

			if (lesson.id === 'placing') {
				// Wrong move: a node that does not touch Blue's stone.
				await play(page, 'c5', 0);
				const s = await waitFor(page, s => s.step === 0 && s.hint, 'the hint after a wrong move');
				check(s.hint === lesson.hint && s.status === 'playing', 'wrong move in "placing" shows the hint and resets');
			}
			if (lesson.id === 'dashing') {
				// Wrong move after a correct first step: End Turn instead of Dash.
				await play(page, lesson.steps[0].do, 0);
				await play(page, 'pass', 1);
				const s = await waitFor(page, s => s.step === 0 && s.hint, 'the hint after a wrong button');
				check(!!s.hint, 'wrong button in "dashing" shows the hint and resets to step 1');
				// The lesson's start position is back (the crushed stone returned).
				await waitFor(page, s => s.nodes.a13 === 'red', 'the reset board');
			}

			const end = await playLesson(page, lesson);
			check(end.status === 'done' && !!end.done[lesson.id],
				`lesson ${i + 1} "${lesson.title}" played to the end` + (lesson.win ? ' (winner ' + end.winner + ')' : ''));
			if (lesson.win) check(end.winner === 'blue', `lesson ${i + 1} ends with Blue winning`);
			const shown = await page.evaluate(() => {
				const el = document.querySelector('.tutorial-panel__success');
				return !!el && el.offsetParent !== null && el.innerText.length > 10;
			});
			check(shown, `lesson ${i + 1} shows its success message`);
			const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
			check(wide <= 0, `lesson ${i + 1} fits a 390 px viewport (overflow ${wide}px)`);
		}

		// Progress survives a reload, and the page then opens on the first
		// lesson not yet done (none: the first).
		await page.goto(`${BASE}/tutorial.html`, { waitUntil: 'networkidle2', timeout: 60000 });
		const s = await waitFor(page, s => s.status === 'playing', 'reload');
		check(Object.keys(s.done).length === lessons.length, 'progress saved for all ' + lessons.length + ' lessons');
		const ticks = await page.$$eval('.tutorial-lessons button.is-done', els => els.length);
		check(ticks === lessons.length, 'lesson list ticks every finished lesson (' + ticks + ')');

		check(errors.length === 0, 'no page errors' + (errors.length ? ':\n  ' + errors.join('\n  ') : ''));
		await browser.close();
	} finally {
		srv.kill();
	}
	if (failed) {
		console.error(failed + ' check(s) failed');
		process.exit(1);
	}
	console.log('all checks passed');
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
