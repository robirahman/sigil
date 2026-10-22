// In-game settings panel, animation level, colourblind markers and keyboard /
// screen-reader behaviour of the game pages (settings-panel.js, game-keys.js).
//
//   (cd docs && python3 -m http.server 8765) &
//   node tools/browser/settings-a11y-test.js http://localhost:8765 [screenshot-dir]
//
// Plays a local 1v1 on game.html (no engine, no Firebase writes: requests to
// Firebase hosts are blocked). With a screenshot dir it also saves the board
// with colourblind markers on every theme and on the drawn Cataclysm board.
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';
const SHOTS = process.argv[3] || '';
const THEMES = ['default', 'frost', 'parchment', 'forest', 'volcanic'];

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
		const u = r.url();
		if (/firebaseio\.com|identitytoolkit|securetoken|firebaseinstallations/.test(u)) r.abort();
		else r.continue();
	});
	// A flaky third-party CDN load (the Firebase SDK from gstatic) throws in
	// the page's own Firebase setup; count those apart, they are not ours.
	let cdnFailed = false;
	page.on('requestfailed', (r) => {
		if (!/firebaseio\.com|identitytoolkit|securetoken|firebaseinstallations/.test(r.url()) && !r.url().startsWith(BASE)) {
			cdnFailed = true;
			console.log('note: CDN request failed: ' + r.url());
		}
	});
	page.on('pageerror', (e) => {
		const msg = page.url().replace(BASE, '') + ': ' + e.message + (process.env.STACKS ? ' @ ' + (e.stack || '').split('\n').slice(0, 3).join(' / ') : '');
		if (cdnFailed && /firebase|INTERNAL/.test(e.message)) console.log('note: after a CDN failure: ' + msg);
		else errors.push(msg);
	});
	page.on('dialog', (d) => d.accept());
	if (opts.reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
	await page.setViewport({ width: opts.width || 1200, height: opts.height || 900 });
	if (opts.storage) {
		await page.evaluateOnNewDocument((s) => {
			if (sessionStorage.getItem('__seeded')) return;
			sessionStorage.setItem('__seeded', '1');
			for (const k in s) localStorage.setItem(k, s[k]);
		}, opts.storage);
	}
	return page;
}

const board = (page) => page.evaluate(() => {
	const d = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
	return {
		whose: d.whoseTurn, actions: [...d.actionList],
		valid: Object.keys(d.validMoves).filter(k => d.validMoves[k]),
		armed: d.endTurnArmed, artOnly: d.useArtOnlySpells,
		red: Object.keys(d.nodes).filter(k => d.nodes[k] === 'red'),
		blue: Object.keys(d.nodes).filter(k => d.nodes[k] === 'blue'),
	};
});

async function openGame(page, query = '') {
	await page.goto(`${BASE}/game.html${query}`, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => {
		const el = document.querySelector('[x-data^="gameBoard"]');
		if (!el || !window.Alpine) return false;
		const d = Alpine.$data(el);
		return d.actionList.includes('move') && Object.values(d.validMoves).some(Boolean);
	}, { timeout: 30000 });
}

// Place the first offered stone with a real click (the node keeps focus).
async function clickMove(page) {
	const node = (await board(page)).valid[0];
	await page.click('#stone-node--' + node);
	await page.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).actionList.includes('pass'));
	return node;
}

const markerOf = (page, node) => page.$eval('#stone-node--' + node, (el) => {
	const cs = getComputedStyle(el, '::before');
	return { content: cs.content, transform: cs.transform, radius: cs.borderRadius };
});

(async () => {
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	const errors = [];
	try {
		// ---- Panel: open, focus, trap, Escape, restore ----
		let page = await newPage(browser, errors);
		await openGame(page);
		check('gear button present with a label', await page.$eval('.settings-toggle', b => b.getAttribute('aria-label')) === 'Settings');
		await page.click('.settings-toggle');
		const panelState = await page.evaluate(() => {
			const p = document.getElementById('settings-panel');
			return { hidden: p.hidden, role: p.getAttribute('role'), modal: p.getAttribute('aria-modal'), focusIn: p.contains(document.activeElement) };
		});
		check('panel opens as a modal dialog with focus inside', !panelState.hidden && panelState.role === 'dialog' && panelState.modal === 'true' && panelState.focusIn, panelState);
		await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
		check('Shift+Tab from the first control wraps to the last', await page.evaluate(() => document.activeElement.textContent === 'Close'));
		await page.keyboard.press('Tab');
		check('Tab from the last control wraps to the first', await page.evaluate(() => document.activeElement.getAttribute('data-setting') === 'theme'));
		await page.keyboard.press('Escape');
		check('Escape closes the panel and returns focus to the gear', await page.evaluate(() =>
			document.getElementById('settings-panel').hidden && document.activeElement.classList.contains('settings-toggle')));

		// ---- Change every setting through the panel ----
		await page.click('.settings-toggle');
		await page.select('#settings-panel [data-setting="theme"]', 'forest');
		await page.$eval('#settings-panel [data-setting="volume"]', (el) => { el.value = '40'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
		await page.select('#settings-panel [data-setting="motion"]', 'off');
		for (const k of ['artOnly', 'colourblind', 'muted']) await page.click(`#settings-panel [data-setting="${k}"]`);
		const applied = await page.evaluate(() => ({
			theme: document.documentElement.getAttribute('data-theme'),
			motion: document.documentElement.getAttribute('data-motion'),
			cb: document.documentElement.hasAttribute('data-colourblind'),
			volume: soundManager.volume, muted: soundManager.muted,
			muteLabel: document.querySelector('.mute-toggle').getAttribute('aria-label'),
			artOnly: Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).useArtOnlySpells,
			stored: JSON.parse(localStorage.getItem('sigil_settings')),
			keys: [localStorage.getItem('sigil_theme'), localStorage.getItem('sigil_muted'), localStorage.getItem('sigilArtOnlySpellCircles')],
		}));
		check('settings apply live', applied.theme === 'forest' && applied.motion === 'off' && applied.cb && applied.volume === 0.4
			&& applied.muted && applied.muteLabel === 'Unmute sound' && applied.artOnly, applied);
		check('new settings share one key; shared ones keep their own', applied.stored && applied.stored.volume === 0.4
			&& applied.stored.motion === 'off' && applied.stored.colourblind === true
			&& applied.keys.join() === 'forest,true,true', applied);
		await page.keyboard.press('Escape');

		// ---- Persist across reload ----
		await page.evaluate(() => { window.onbeforeunload = null; });
		await page.reload({ waitUntil: 'load' });
		await page.waitForFunction(() => window.Alpine && document.querySelector('[x-data^="gameBoard"]') && Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).whoseTurn);
		await page.click('.settings-toggle');
		const reloaded = await page.evaluate(() => {
			const q = (k) => document.querySelector(`#settings-panel [data-setting="${k}"]`);
			return {
				theme: themeManager.current, motion: document.documentElement.getAttribute('data-motion'),
				cb: document.documentElement.hasAttribute('data-colourblind'), volume: soundManager.volume, muted: soundManager.muted,
				artOnly: Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).useArtOnlySpells,
				ui: [q('theme').value, q('volume').value, q('motion').value, q('artOnly').checked, q('colourblind').checked, q('muted').checked],
				twinkle: getComputedStyle(document.querySelector('.stone-node')).animationDuration,
			};
		});
		check('settings persist across reload', reloaded.theme === 'forest' && reloaded.motion === 'off' && reloaded.cb
			&& reloaded.volume === 0.4 && reloaded.muted && reloaded.artOnly
			&& reloaded.ui.join() === 'forest,40,off,true,true,true', reloaded);
		check('animation off: stone twinkle cut to an instant', parseFloat(reloaded.twinkle) < 0.001, reloaded.twinkle);
		await page.keyboard.press('Escape');

		await page.close();

		// ---- Animation level gates the spell effects ----
		page = await newPage(browser, errors);
		await openGame(page);
		const fx = await page.evaluate(async () => {
			const d = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			const overlay = d.$refs.spellFxOverlay, container = d.$refs.gameBoardContainer;
			const out = {};
			for (const level of ['full', 'reduced', 'off']) {
				SigilSettings.set('motion', level);
				overlay.innerHTML = '';
				container.classList.remove('spell-fx--shake');
				playSpellEffect(overlay, container, 'Fireblast');
				out[level] = {
					shake: container.classList.contains('spell-fx--shake'),
					overlay: overlay.firstElementChild ? overlay.firstElementChild.className : null,
					shakeAnim: getComputedStyle(container).animationName,
				};
			}
			return out;
		});
		check('full: Fireblast shakes the board', fx.full.shake && fx.full.shakeAnim === 'spell-fx-shake-frames', fx.full);
		check('reduced: colour flash only, no shake', !fx.reduced.shake && fx.reduced.overlay === 'spell-fx spell-fx--flash', fx.reduced);
		check('off: no overlay, no shake', !fx.off.shake && fx.off.overlay === null, fx.off);
		await page.close();

		// prefers-reduced-motion picks the default until the player chooses.
		page = await newPage(browser, errors, { reduced: true });
		await openGame(page);
		const rm = await page.evaluate(() => ({
			motion: document.documentElement.getAttribute('data-motion'),
			stored: localStorage.getItem('sigil_settings'),
			pulse: getComputedStyle(document.querySelector('.stone-node--valid-move-red'), '::after').animationDuration,
		}));
		check('prefers-reduced-motion defaults to reduced', rm.motion === 'reduced' && rm.stored === null && parseFloat(rm.pulse) < 0.001, rm);
		await page.click('.settings-toggle');
		check('panel shows the system default', await page.$eval('#settings-panel [data-setting="motion"]', s => s.value) === 'reduced');
		await page.close();

		// ---- Node labels, Enter, confirm, Escape, ?, tooltips ----
		page = await newPage(browser, errors);
		await openGame(page);
		const target = (await board(page)).valid[0];
		const before = await page.$eval('#stone-node--' + target, e => e.getAttribute('aria-label'));
		await clickMove(page);
		const after = await page.$eval('#stone-node--' + target, e => e.getAttribute('aria-label'));
		check('node label: empty legal move before, red stone last play after', before === `${target}, empty, legal move` && after === `${target}, red stone, last play`, { before, after });
		check('game log is a polite live region', await page.$eval('.feed--history', el => el.getAttribute('role') === 'log' && el.getAttribute('aria-live') === 'polite'));

		// Enter on a keyboard-focused button clicks it and does not also pass.
		await sleep(600);
		await page.focus('.action-button--reset-turn');
		await page.keyboard.press('Enter');
		await sleep(400);
		let s = await board(page);
		check('Enter on focused Reset Turn resets and does not pass', s.whose === 'red' && s.actions.includes('move') && s.red.length === 1, s);
		// Enter after a mouse click on a node (node holds focus) passes.
		await clickMove(page);
		await page.keyboard.press('Enter');
		await page.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).whoseTurn === 'blue', { timeout: 5000 }).catch(() => {});
		s = await board(page);
		check('Enter after clicking a node ends the turn', s.whose === 'blue', s);

		// Confirm before ending a turn: first Enter arms, Escape disarms, two presses pass.
		await page.evaluate(() => SigilSettings.set('confirmEndTurn', true));
		await clickMove(page);
		await page.keyboard.press('Enter');
		await sleep(200);
		s = await board(page);
		const label = await page.$eval('.action-button--end-turn', b => b.textContent.trim());
		check('confirm on: first Enter only arms End Turn', s.whose === 'blue' && s.armed && label === 'Confirm end turn?', { s, label });
		await page.keyboard.press('Escape');
		check('Escape disarms End Turn', !(await board(page)).armed);
		await page.click('.action-button--end-turn');
		await page.click('.action-button--end-turn');
		await page.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).whoseTurn === 'red', { timeout: 5000 }).catch(() => {});
		check('confirm on: two clicks end the turn', (await board(page)).whose === 'red');
		await page.evaluate(() => SigilSettings.set('confirmEndTurn', false));

		// ? overlay.
		await page.keyboard.type('?');
		const ov = await page.evaluate(() => {
			const o = document.getElementById('shortcuts-overlay');
			return { open: !o.hidden, rows: o.querySelectorAll('dt').length, focusIn: o.contains(document.activeElement) };
		});
		check('? opens the shortcut list', ov.open && ov.rows >= 5 && ov.focusIn, ov);
		await page.keyboard.press('Escape');
		check('Escape closes the shortcut list', await page.evaluate(() => document.getElementById('shortcuts-overlay').hidden));

		// Spell tooltip on keyboard focus; Escape closes it.
		const tip = await page.evaluate(async () => {
			const img = document.querySelector('img.spell.charm-spell[tabindex="0"]');
			img.focus();
			await new Promise(r => setTimeout(r, 100));
			const t = document.getElementById('spell-tooltip');
			return { visible: t.classList.contains('is-visible'), label: img.getAttribute('aria-label'), role: img.getAttribute('role'), heading: t.querySelector('h2').textContent };
		});
		check('spell tooltip opens on keyboard focus', tip.visible && tip.role === 'button' && tip.label && tip.label === tip.heading, tip);
		await page.keyboard.press('Escape');
		check('Escape closes the spell tooltip', await page.evaluate(() => !document.getElementById('spell-tooltip').classList.contains('is-visible')));

		// Icon-only buttons are labelled.
		const icons = await page.evaluate(() => [...document.querySelectorAll('.mute-toggle, .review-bar__btn')]
			.filter(b => !b.classList.contains('review-bar__btn--text')).map(b => b.getAttribute('aria-label')));
		check('mute and review arrows have aria-labels', icons.length >= 7 && icons.every(Boolean), icons);

		// Review-graph dots are focusable buttons.
		const dots = await page.evaluate(() => {
			const d = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			return d.aiReviewGraphDotsSvg.call({ aiReviewGraphDots: () => [{ x: '10', y: '20', cls: 'blunder', ply: 0 }], reviewTurnLabels: ['Start', 'Red Turn 1'] });
		});
		check('review-graph dots are keyboard buttons', /tabindex="0"/.test(dots) && /role="button"/.test(dots) && /aria-label="Red Turn 1: blunder"/.test(dots), dots);

		// Win modal: dialog role, focus moves in and comes back.
		await page.focus('.action-button--forfeit');
		const win = await page.evaluate(async () => {
			const d = Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
			const m = document.querySelector('.win-modal:not(.side-picker)');
			d.winner = 'red';
			await new Promise(r => setTimeout(r, 100));
			const res = { role: m.getAttribute('role'), modal: m.getAttribute('aria-modal'), label: m.getAttribute('aria-label'), focusIn: m.contains(document.activeElement) };
			d.winner = '';
			await new Promise(r => setTimeout(r, 100));
			res.restored = document.activeElement.classList.contains('action-button--forfeit');
			return res;
		});
		check('win modal is a dialog that takes and returns focus', win.role === 'dialog' && win.modal === 'true' && win.label === 'Red wins' && win.focusIn && win.restored, win);
		await page.close();

		// ---- Colourblind markers on every theme and the drawn board ----
		for (const theme of THEMES.concat(['pentagon'])) {
			const storage = { sigil_settings: JSON.stringify({ colourblind: true, motion: 'off' }), sigil_theme: theme === 'pentagon' ? 'default' : theme };
			page = await newPage(browser, errors, { storage });
			await openGame(page, theme === 'pentagon' ? '?variant=pentagon' : '');
			s = await board(page);
			const red = s.red[0], blue = s.blue[0];
			const mr = await markerOf(page, red), mb = await markerOf(page, blue);
			const glowNode = s.valid[0];
			const mg = await markerOf(page, glowNode);
			check(`colourblind markers on ${theme}: red diamond, blue ring, glow shape`,
				mr.content === '""' && /matrix/.test(mr.transform) && mr.radius === '0px'
				&& mb.content === '""' && mb.radius === '50%' && mg.content === '""', { red: mr, blue: mb, glow: mg });
			if (SHOTS) {
				const box = await page.$eval('.game-board-container', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.min(r.width, 1100), height: Math.min(r.height, 900) }; });
				await page.screenshot({ path: `${SHOTS}/cb-${theme}.png`, clip: box });
			}
			if (theme === 'default') {
				await page.evaluate(() => SigilSettings.set('colourblind', false));
				check('markers gone when colourblind is off', (await markerOf(page, red)).content === 'none');
			}
			await page.close();
		}

		// ---- index.html sees the same theme / art-only values ----
		page = await newPage(browser, errors, { storage: { sigil_theme: 'parchment', sigilArtOnlySpellCircles: 'true' } });
		await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
		const ix = await page.evaluate(() => ({ theme: document.getElementById('theme-select').value, art: document.getElementById('setting-art-only').checked }));
		check('index.html shows the same stored theme and art-only', ix.theme === 'parchment' && ix.art, ix);
		await page.close();

		// ---- 375 px: no horizontal scroll, panel fits ----
		for (const path of ['game.html', 'multiplayer.html']) {
			page = await newPage(browser, errors, { width: 375, height: 740 });
			await page.goto(`${BASE}/${path}`, { waitUntil: 'load' });
			await sleep(1200);
			await page.click('.settings-toggle');
			const w = await page.evaluate(() => {
				const r = document.querySelector('#settings-panel .settings-panel__inner').getBoundingClientRect();
				return { scroll: document.documentElement.scrollWidth, left: r.left, right: r.right, open: !document.getElementById('settings-panel').hidden };
			});
			check(`${path} at 375px: no horizontal scroll, panel fits`, w.open && w.scroll <= 375 && w.left >= 0 && w.right <= 375, w);
			if (SHOTS) await page.screenshot({ path: `${SHOTS}/panel-375-${path.replace('.html', '')}.png` });
			await page.close();
		}
	} finally {
		await browser.close();
	}
	check('no page errors', errors.length === 0, errors);
	console.log(failures ? `settings/a11y FAILED: ${failures} check(s)` : 'settings/a11y OK');
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
