// Headless check of docs/drills.html: plays every practice drill start to
// finish with its scripted steps (real clicks on the board, spells and
// buttons), answers each drill's first explained mistake wrongly and checks
// that the page shows that explanation (and resets, except after a wrong
// prediction), checks "Show me", the saved progress (its own key, not the
// tutorial's) and the practice-vs-AI form, and fails on any page error.
//   node tools/browser/drills-test.js <docs dir> [port]   (default: a random port 8900-8999)
// The drills' answers themselves are proved against the rules by
// tools/drills-verify.js; this checks the page plays them. Phone width: a
// 390 px viewport, and the page must not scroll sideways.
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
			nodes: Object.assign({}, d.nodes), answer: d.tutorialAnswer, hintReset: d.tutorialHintReset,
			reveal: d.tutorialReveal,
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

// The tokens a step's first accepted answer clicks.
function stepTokens(step) {
	const d = step.do;
	if (step.ask) return [step.ask];
	if (typeof d === 'string') return [d];
	if (d.oneOf) return [d.oneOf[0]];
	if (d.all) return d.all.slice();
	if (d.pick) return d.from.slice(0, d.pick);
	return null;   // { any }
}

// Play steps [0, upto) of a drill; an { any } step takes the first node offered.
async function playSteps(page, lesson, upto) {
	for (let i = 0; i < upto; i++) {
		const step = lesson.steps[i];
		let toks = stepTokens(step);
		if (step.do && step.do.oneOf && step.do.oneOf.every(isNode)) {
			// The first answer the board offers (one may be taken by now).
			// A push choice offers its nodes by push arrows, not as moves.
			const s = await waitFor(page, s => s.step === i && (s.awaiting === 'node' || (s.awaiting === 'action' && s.actionList.includes('move'))),
				'the prompt at step ' + i);
			toks = [step.do.oneOf.find(t => s.validMoves[t]) || step.do.oneOf[0]];
		}
		if (toks) {
			for (const t of toks) await play(page, t, i);
		} else {
			const s = await waitFor(page, s => s.step === i && (s.awaiting === 'node' || (s.awaiting === 'action' && s.actionList.includes('move')))
				&& (Object.keys(s.validMoves).length || Object.keys(s.nodesToRefill).length), 'offered nodes at step ' + i);
			const offered = Object.keys(s.nodesToRefill).length ? s.nodesToRefill : s.validMoves;
			await play(page, Object.keys(offered)[0], i);
		}
	}
}

async function playLesson(page, lesson) {
	await playSteps(page, lesson, lesson.steps.length);
	return waitFor(page, s => s.status === 'done', 'drill "' + lesson.id + '" to finish');
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
		page.on('console', m => { if (m.type() === 'error' && !/firebase|gstatic|ERR_|net::/i.test(m.text())) errors.push('console: ' + m.text()); });
		page.on('pageerror', e => errors.push('pageerror: ' + e.message));
		page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(BASE)) errors.push('http ' + r.status() + ': ' + r.url().slice(0, 120)); });

		await page.goto(`${BASE}/drills.html`, { waitUntil: 'networkidle2', timeout: 60000 });
		await page.evaluate(() => { try { localStorage.removeItem('sigil_drills_done'); localStorage.removeItem('sigil_tutorial_done'); } catch (e) { /* */ } });
		const lessons = await page.evaluate(() => window.SIGIL_DRILLS);
		check(lessons && lessons.length >= 9, 'drills loaded: ' + (lessons && lessons.length));
		const groups = await page.$$eval('.drill-group__title', els => els.map(e => e.textContent));
		check(groups.join('|') === 'Pushes|Dashing|When to cast', 'the drill list is grouped: ' + groups.join(', '));

		for (let i = 0; i < lessons.length; i++) {
			const lesson = lessons[i];
			await page.goto(`${BASE}/drills.html?drill=${i + 1}`, { waitUntil: 'networkidle2', timeout: 60000 });
			await waitFor(page, s => s.index === i && s.status === 'playing', 'drill ' + (i + 1) + ' to load');

			// The first explained mistake: play up to its step, make it, and
			// check the explanation (and the reset, unless it was a prediction).
			const k = lesson.steps.findIndex(st => st.why && Object.keys(st.why).some(t => t !== '*'));
			if (k >= 0) {
				const step = lesson.steps[k];
				const wrong = Object.keys(step.why).find(t => t !== '*');
				await playSteps(page, lesson, k);
				await play(page, wrong, k);
				const s = await waitFor(page, s => s.hint, 'the explanation after ' + wrong);
				check(s.hint === step.why[wrong], `drill ${i + 1}: "${wrong}" at step ${k + 1} explains: ${s.hint.slice(0, 60)}...`);
				if (step.ask) {
					check(s.step === k && s.hintReset === false, `drill ${i + 1}: a wrong prediction keeps the drill where it was`);
				} else {
					check(s.step === 0 && s.hintReset === true, `drill ${i + 1}: a wrong move resets the drill`);
					// Back at the start position.
					await waitFor(page, s => s.status === 'playing' && s.step === 0 && s.awaiting, 'the reset drill');
				}
				if (!step.ask) {
					const shown = await page.$eval('.tutorial-panel__hint', el => el.innerText);
					check(/reset/.test(shown), `drill ${i + 1}: the panel says the drill was reset`);
				}
				await page.goto(`${BASE}/drills.html?drill=${i + 1}`, { waitUntil: 'networkidle2', timeout: 60000 });
				await waitFor(page, s => s.index === i && s.status === 'playing', 'drill ' + (i + 1) + ' to reload');
			}

			// "Show me": no rings until asked.
			const first = lesson.steps.findIndex(st => !st.ask && stepTokens(st) && stepTokens(st).some(isNode));
			if (first === 0) {
				await waitFor(page, s => s.awaiting, 'the first prompt');
				let ringed = await page.$$eval('.stone-node--tutorial-target', els => els.length);
				check(ringed === 0, `drill ${i + 1}: no answer rings before "Show me"`);
				await page.click('.drill-reveal');
				await waitFor(page, s => s.reveal, '"Show me"');
				ringed = await page.$$eval('.stone-node--tutorial-target', els => els.length);
				check(ringed > 0, `drill ${i + 1}: "Show me" rings the answer (${ringed})`);
			}

			const end = await playLesson(page, lesson);
			check(end.status === 'done' && !!end.done[lesson.id],
				`drill ${i + 1} "${lesson.title}" played to the end` + (lesson.win ? ' (winner ' + end.winner + ')' : ''));
			if (lesson.win) check(end.winner === (lesson.mover || 'blue'), `drill ${i + 1} ends with the mover winning`);
			if (lesson.steps.some(st => st.ask)) check(true, `drill ${i + 1}: prediction answered`);
			const shown = await page.evaluate(() => {
				const el = document.querySelector('.tutorial-panel__success');
				return !!el && el.offsetParent !== null && el.innerText.length > 10;
			});
			check(shown, `drill ${i + 1} shows its success message`);
			const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
			check(wide <= 0, `drill ${i + 1} fits a 390 px viewport (overflow ${wide}px)`);
		}

		// Progress survives a reload under its own key; the tutorial's is untouched.
		await page.goto(`${BASE}/drills.html`, { waitUntil: 'networkidle2', timeout: 60000 });
		const s = await waitFor(page, s => s.status === 'playing', 'reload');
		check(Object.keys(s.done).length === lessons.length, 'progress saved for all ' + lessons.length + ' drills');
		const ticks = await page.$$eval('.tutorial-lessons button.is-done', els => els.length);
		check(ticks === lessons.length, 'the drill list ticks every finished drill (' + ticks + ')');
		const tut = await page.evaluate(() => localStorage.getItem('sigil_tutorial_done'));
		check(!tut, 'the tutorial progress is untouched');

		// The practice-vs-AI form: a bad position is refused, a good one goes
		// to game.html in practice mode.
		await page.type('#practice-sfn', 'not an sfn');
		await page.click('#practice-start');
		const err = await page.$eval('#practice-error', el => !el.hidden && el.textContent);
		check(!!err, 'the practice form refuses an unreadable position: ' + err);
		const sfn = 'r............b........................./Bewitch,Flourish,Carnage,Fireblast,Grow,Hail_Storm,Surge,Slash,Sprout b 2 0:0 -:- -:- tied';
		await page.$eval('#practice-sfn', (el, v) => { el.value = v; }, sfn);
		await page.select('#practice-tier', 'rust_easy');
		await page.select('#practice-side', 'blue');
		await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#practice-start')]);
		const u = new URL(page.url());
		check(u.pathname.endsWith('/game.html') && u.searchParams.get('practice') === '1' && u.searchParams.get('ai') === 'rust_easy'
			&& u.searchParams.get('side') === 'blue' && u.searchParams.get('sfn') === sfn, 'the practice form opens game.html in practice mode: ' + u.search.slice(0, 80));

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
