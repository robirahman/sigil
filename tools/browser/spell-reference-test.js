// Headless check of the rules reference: docs/spell.html, docs/variants.html,
// the "This game's rules" help popover and the in-game spell tooltip link.
//   node tools/browser/spell-reference-test.js <docs dir> [port]
//
// 1. spell.html for every official spell: the card text, the rules notes,
//    the Try-it link and the statistics render with no page errors; name
//    spellings (hyphens, case, the legacy Flood) resolve; unknown names list
//    every spell.
// 2. Every Try-it position loads in analysis.html as an analysis line (not
//    the editor), with the example's side to move and the spell on the board.
// 3. variants.html has a section per variant; every variants.html#anchor
//    linked from index.html, cataclysm.html and spell.html exists.
// 4. spells.html's tier tiles link to spell.html.
// 5. game.html (a local Competitive Deathmatch game): the help popover's
//    "This Game's Rules" lists those variants and the nine spells; the spell
//    tooltip's "More about this spell" link names the slot's spell.
// 6. multiplayer.html: the popover is hidden in the lobby and renders a
//    room's rules (Cataclysm, Providence spells).
// 7. Phone width (375 px): spell.html and variants.html have a 16 px gutter
//    and no horizontal scroll.
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DOCS = path.resolve(process.argv[2] || 'docs');
const PORT = Number(process.argv[3]) || 8804;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(ok, what, detail) {
	console.log((ok ? 'PASS ' : 'FAIL ') + what + (detail !== undefined && !ok ? ': ' + detail : ''));
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

const EXAMPLES = JSON.parse(fs.readFileSync(path.join(DOCS, 'static', 'data', 'spell-examples.json'), 'utf8')).examples;
const OFFICIAL = Object.keys(EXAMPLES);

// A page that records its errors. Firebase's CDN may be unreachable from the
// sandbox; errors that follow such a failure are noted, not counted.
async function newPage(browser, errors, opts = {}) {
	const page = await browser.newPage();
	let cdnFailed = false;
	page.on('requestfailed', r => { if (!r.url().startsWith(BASE)) cdnFailed = true; });
	page.on('pageerror', e => {
		const msg = page.url().replace(BASE, '') + ': ' + e.message;
		if (cdnFailed && /firebase|INTERNAL/i.test(e.message)) console.log('note: after a CDN failure: ' + msg);
		else errors.push(msg);
	});
	page.on('dialog', d => d.accept());
	await page.setViewport(opts.phone
		? { width: 375, height: 800, isMobile: true, hasTouch: true }
		: { width: 1200, height: 900 });
	return page;
}

(async () => {
	const server = spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS, '--bind', '127.0.0.1'], { stdio: 'ignore' });
	let browser;
	try {
		await waitPort(PORT, 10000);
		browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
		const errors = [];
		const page = await newPage(browser, errors);

		// ---- 1. spell.html for every official spell
		check(OFFICIAL.length === 45, 'an example for each of the 45 official spells', OFFICIAL.length);
		for (const name of OFFICIAL) {
			const before = errors.length;
			await page.goto(`${BASE}/spell.html?name=${name}`, { waitUntil: 'load' });
			await page.waitForFunction(() => {
				const t = document.getElementById('try-body'), s = document.getElementById('stats-body');
				return t && s && !/Loading/.test(t.textContent) && !/Loading/.test(s.textContent);
			}, { timeout: 15000 });
			const r = await page.evaluate((n) => ({
				h1: (document.querySelector('#spell-body h1') || {}).textContent,
				text: document.getElementById('spell-text').textContent,
				want: SPELL_TEXTS[n],
				notes: document.querySelectorAll('#rules > ul > li').length,
				tryHref: (document.getElementById('try-analysis') || {}).href || '',
				stats: document.getElementById('stats-body').textContent,
				title: document.title,
			}), name);
			const ok = r.h1 === name.replace(/_/g, ' ') && r.text === r.want && r.notes > 0
				&& r.tryHref.includes('analysis.html?sfn=') && !/Could not load/.test(r.stats)
				&& r.title.startsWith(name.replace(/_/g, ' ')) && errors.length === before;
			check(ok, `spell.html?name=${name}`, JSON.stringify(Object.assign(r, { stats: r.stats.slice(0, 80), errors: errors.slice(before) })));
		}
		// Win-rate numbers come from the data files: spot-check one.
		await page.goto(`${BASE}/spell.html?name=Fireblast`, { waitUntil: 'load' });
		await page.waitForFunction(() => /recorded games/.test(document.getElementById('stats-body').textContent), { timeout: 15000 });
		const fb = await page.$eval('#stats-body', el => el.textContent);
		check(/On the board in 1,202 of 2,411 recorded games/.test(fb) && /83%/.test(fb) && /464/.test(fb), 'Fireblast statistics match spell_stats2.json', fb.slice(0, 200));
		// A spell outside the 2026-09-06 analysis says so.
		await page.goto(`${BASE}/spell.html?name=Fissure`, { waitUntil: 'load' });
		await page.waitForFunction(() => !/Loading/.test(document.getElementById('stats-body').textContent), { timeout: 15000 });
		check(/No game statistics yet/.test(await page.$eval('#stats-body', el => el.textContent)), 'Fissure has no game statistics and says so');

		for (const [q, want] of [['hail-storm', 'Hail Storm'], ['SEAL OF WIND', 'Seal of Wind'], ['Flood', 'Tsunami'], ['Silence', 'Silence']]) {
			await page.goto(`${BASE}/spell.html?name=${encodeURIComponent(q)}`, { waitUntil: 'load' });
			check(await page.$eval('#spell-body h1', el => el.textContent) === want, `?name=${q} resolves to ${want}`);
		}
		await page.goto(`${BASE}/spell.html?name=Nonsense`, { waitUntil: 'load' });
		const idx = await page.evaluate(() => ({ text: document.getElementById('spell-body').textContent, links: document.querySelectorAll('.spell-index a').length }));
		check(/No spell is called/.test(idx.text) && idx.links >= 45, 'an unknown name lists every spell', JSON.stringify(idx).slice(0, 120));
		// The picker navigates.
		await page.goto(`${BASE}/spell.html?name=Grow`, { waitUntil: 'load' });
		await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.select('#spell-select', 'Meteor')]);
		check(page.url().endsWith('spell.html?name=Meteor'), 'the spell picker opens the chosen spell', page.url());

		// ---- 2. every Try-it position loads in analysis.html
		for (const name of OFFICIAL) {
			const ex = EXAMPLES[name];
			const before = errors.length;
			await page.goto(`${BASE}/analysis.html?sfn=${encodeURIComponent(ex.sfn)}`, { waitUntil: 'load' });
			let st = null;
			try {
				await page.waitForFunction(() => {
					const el = document.querySelector('#analysis-root');
					const d = window.Alpine && el && window.Alpine.$data(el);
					return d && (d.anaMode === 'edit' || (d.anaTree.length && Object.keys(d.spellDict).length));
				}, { timeout: 20000 });
				st = await page.evaluate(() => {
					const d = Alpine.$data(document.querySelector('#analysis-root'));
					return { mode: d.anaMode, importError: d.edImportError || '', sfn: d.anaTree[0] && d.anaTree[0].sfn,
						spells: Object.values(d.spellDict), whose: d.whoseTurn };
				});
			} catch (e) { st = { error: e.message }; }
			const ok = st && st.mode === 'analyse' && !st.importError && st.sfn === ex.sfn
				&& st.spells.includes(name) && errors.length === before;
			check(ok, `Try-it position for ${name} loads in analysis.html`, JSON.stringify(Object.assign({}, st, { errors: errors.slice(before) })));
		}

		// ---- 3. variants.html and the links into it
		await page.goto(`${BASE}/variants.html#scramble`, { waitUntil: 'load' });
		const ids = await page.$$eval('#variant-sections > section', els => els.map(e => e.id));
		const wantIds = ['standard', 'competitive', 'deathmatch', 'scramble', 'duplicates', 'cataclysm', 'tectonic', 'providence'];
		check(JSON.stringify(ids) === JSON.stringify(wantIds), 'variants.html has a section per variant', JSON.stringify(ids));
		const scrolled = await page.evaluate(() => { const r = document.getElementById('scramble').getBoundingClientRect(); return r.top < 200 && r.top > -10; });
		check(scrolled, 'variants.html#scramble scrolls to its section');
		const linked = new Set();
		for (const f of ['index.html', 'cataclysm.html', 'static/scripts/rules-reference.js', 'spell.html']) {
			for (const m of fs.readFileSync(path.join(DOCS, f), 'utf8').matchAll(/variants\.html#([a-z]+)/g)) linked.add(m[1]);
		}
		const missing = [...linked].filter(a => !ids.includes(a));
		check(linked.size >= 6 && missing.length === 0, 'every variants.html# link has its section', JSON.stringify({ linked: [...linked], missing }));
		await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
		const hintLinks = await page.$$eval('.game-options__hint a[href^="variants.html#"]', els => els.map(a => a.getAttribute('href')));
		check(hintLinks.length === 4, 'the four Game options hints link to their variant', JSON.stringify(hintLinks));

		// ---- 4. spells.html tiles link to spell.html
		await page.goto(`${BASE}/spells.html`, { waitUntil: 'load' });
		await page.waitForSelector('a.tile', { timeout: 15000 });
		const tiles = await page.$$eval('a.tile', els => els.map(a => [a.dataset.spell, a.getAttribute('href')]));
		check(tiles.length >= 39 && tiles.every(([n, h]) => h === 'spell.html?name=' + encodeURIComponent(n)), 'spells.html tiles link to spell.html', JSON.stringify(tiles.slice(0, 3)));

		// ---- 5. game.html: the help popover and the tooltip link
		const before5 = errors.length;
		await page.goto(`${BASE}/game.html?variant=competitive_deathmatch`, { waitUntil: 'load' });
		await page.waitForFunction(() => {
			const el = document.querySelector('[x-data^="gameBoard"]');
			return el && window.Alpine && Object.keys(Alpine.$data(el).spellDict).length === 9 && window.sigilGameRules;
		}, { timeout: 30000 });
		await page.click('.help-menu-container label');
		await sleep(300);
		await page.click('.help-menu-container .game-rules-btn');
		await sleep(300);
		const gr = await page.evaluate(() => {
			const el = document.querySelector('.help-menu-container .game-rules');
			const d = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			return { shown: el.classList.contains('show') && el.offsetHeight > 0, text: el.textContent,
				more: [...el.querySelectorAll('a[href^="variants.html#"]')].map(a => a.getAttribute('href')),
				spells: [...el.querySelectorAll('a[href^="spell.html"]')].map(a => a.getAttribute('href')),
				want: Object.values(d.spellDict).map(n => 'spell.html?name=' + encodeURIComponent(baseSpellName(n))) };
		});
		check(gr.shown && /This game: Competitive \+ Deathmatch/.test(gr.text), 'help popover: This Game\'s Rules names the variants', gr.text.slice(0, 120));
		check(JSON.stringify(gr.more) === JSON.stringify(['variants.html#competitive', 'variants.html#deathmatch']), 'help popover: the Competitive and Deathmatch rules, no standard win rules', JSON.stringify(gr.more));
		check(gr.spells.length === 9 && JSON.stringify(gr.spells) === JSON.stringify(gr.want), 'help popover: the nine spells link to their pages', JSON.stringify(gr.spells));
		await page.click('.help-menu-container label');
		await sleep(300);
		// Keyboard focus on a spell opens its tooltip (and keeps it open).
		await page.focus('img.ritual-spell.ritual-spell--1');
		await sleep(400);
		const tip = await page.evaluate(() => {
			const a = document.querySelector('#spell-tooltip .tooltip__more');
			const d = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			return { href: a && a.getAttribute('href'), visible: !!a && a.offsetHeight > 0, target: a && a.target,
				want: 'spell.html?name=' + encodeURIComponent(baseSpellName(d.spellDict.ritual1)) };
		});
		check(tip.visible && tip.href === tip.want && tip.target === '_blank', 'the spell tooltip links to the spell\'s page in a new tab', JSON.stringify(tip));
		// Desktop hover: the pointer can travel from the spell to the link.
		const box = await page.$eval('img.sorcery-spell.sorcery-spell--1', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
		await page.mouse.move(box.x, box.y);
		await sleep(300);
		const link = await page.$eval('#spell-tooltip .tooltip__more', el => { const r = el.getBoundingClientRect(); return { x: r.x + 5, y: r.y + r.height / 2 }; });
		await page.mouse.move(link.x, link.y, { steps: 4 });
		await sleep(500);
		const held = await page.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).activeSpell);
		check(held === 'sorcery1', 'hovering from the spell onto its tooltip keeps the tooltip open', held);
		await page.mouse.move(5, 5);
		await sleep(600);
		const gone = await page.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).activeSpell);
		check(gone === '', 'leaving the tooltip closes it', gone);
		check(errors.length === before5, 'game.html: no page errors', JSON.stringify(errors.slice(before5)));

		// ---- 6. multiplayer.html: hidden in the lobby, renders a room's rules
		const before6 = errors.length;
		await page.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load' });
		await sleep(800);
		const mp = await page.evaluate(() => {
			const c = document.querySelector('.help-menu-container');
			const div = document.createElement('div');
			renderGameRules(div, { variant: 'pentagon', spellNames: ['Flourish', 'Endowment', 'Carnage', 'Grow', 'Fireblast', 'Hail_Storm', 'Sprout', 'Slash', 'Surge',
				'Bewitch', 'Starfall', 'Meteor', 'Comet', 'Annuity', 'Dividend'] });
			return { present: !!c, hidden: !!c && c.offsetParent === null, text: div.textContent,
				more: [...div.querySelectorAll('a[href^="variants.html#"]')].map(a => a.getAttribute('href')) };
		});
		check(mp.present && mp.hidden, 'multiplayer.html: the rules menu exists and is hidden in the lobby', JSON.stringify(mp).slice(0, 120));
		check(/This game: Cataclysm/.test(mp.text) && JSON.stringify(mp.more) === JSON.stringify(['variants.html#cataclysm', 'variants.html#providence']),
			'a Cataclysm room with Providence spells gets the Cataclysm and Providence rules', JSON.stringify(mp.more));
		check(errors.length === before6, 'multiplayer.html: no page errors', JSON.stringify(errors.slice(before6)));

		// ---- 7. phone width
		const phone = await newPage(browser, errors, { phone: true });
		for (const url of ['spell.html?name=Rock_Slide', 'spell.html?name=Seal_of_Destruction', 'spell.html', 'variants.html']) {
			await phone.goto(`${BASE}/${url}`, { waitUntil: 'load' });
			await sleep(800);
			const m = await phone.evaluate(() => {
				const p = document.querySelector('.rules-page');
				const r = p.getBoundingClientRect(), cs = getComputedStyle(p);
				return { doc: document.documentElement.scrollWidth, win: window.innerWidth, padL: cs.paddingLeft, padR: cs.paddingRight, left: r.left };
			});
			check(m.doc <= m.win && m.padL === '16px' && m.padR === '16px' && m.left === 0, `phone width: ${url} has a 16 px gutter and no horizontal scroll`, JSON.stringify(m));
		}
		await phone.close();

		check(errors.length === 0, 'no page errors anywhere', JSON.stringify(errors.slice(0, 5)));
	} catch (e) {
		console.log('FAIL exception: ' + (e.stack || e));
		failures++;
	} finally {
		if (browser) await browser.close();
		server.kill();
	}
	console.log(failures ? `TEST FAILED (${failures})` : 'TEST OK');
	process.exit(failures ? 1 : 0);
})();
