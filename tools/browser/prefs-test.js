// Preferences (prefs.js), the preferences page and blind mode (blind-mode.js),
// with no Firebase (requests to its hosts are blocked):
//   1. preferences.html shows every setting, as a guest; a change is stored
//      and reaches game.html; "Reset to defaults".
//   2. The in-game panel has the same rows and links to the page.
//   3. Board settings: node names, last-move ring, legal-move glows.
//   4. Sound groups and the low-time beep; the clock's tenths.
//   5. "Confirm before forfeiting" off: one click concedes.
//   6. Blind mode: no stone is drawn, the board still plays, each change is
//      read out, P describes the position, and it can be turned off.
//   7. The old "Mute emotes" setting becomes "Show emotes" and "Offer the
//      emote picker" off.
//
//   (cd docs && python3 -m http.server 8765) &
//   node tools/browser/prefs-test.js http://localhost:8765 [screenshot-dir]
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';
const SHOTS = process.argv[3] || '';

let failures = 0;
function check(label, ok, detail) {
	console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
	if (!ok) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const FIREBASE = /firebaseio\.com|identitytoolkit|securetoken|firebaseinstallations|gstatic\.com\/firebasejs/;

async function newPage(browser, errors, opts = {}) {
	const ctx = await browser.createBrowserContext();
	const page = await ctx.newPage();
	await page.setRequestInterception(true);
	page.on('request', (r) => (FIREBASE.test(r.url()) ? r.abort() : r.continue()));
	page.on('pageerror', (e) => {
		// The Firebase SDK is blocked: the pages' own setup of it throws.
		if (/firebase is not defined|firebase\b/i.test(e.message)) return;
		errors.push(page.url().replace(BASE, '') + ': ' + e.message);
	});
	page.on('dialog', (d) => d.accept());
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
		whose: d.whoseTurn, actions: [...d.actionList], winner: d.winner,
		valid: Object.keys(d.validMoves).filter(k => d.validMoves[k]),
		red: Object.keys(d.nodes).filter(k => d.nodes[k] === 'red'),
		blue: Object.keys(d.nodes).filter(k => d.nodes[k] === 'blue'),
		forfeitArmed: d.forfeitArmed,
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

async function playMove(page) {
	const node = (await board(page)).valid[0];
	await page.click('#stone-node--' + node);
	await page.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).actionList.includes('pass'));
	return node;
}

const stoneImage = (page, node) => page.$eval('#stone-node--' + node, (el) => getComputedStyle(el).backgroundImage);

(async () => {
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	const errors = [];
	try {
		// ---- 1. The preferences page, as a guest ----
		let page = await newPage(browser, errors);
		await page.goto(`${BASE}/preferences.html`, { waitUntil: 'load' });
		const rows = await page.$$eval('#prefs-root [data-setting]', (els) => els.map((e) => e.getAttribute('data-setting')));
		const want = ['theme', 'artOnly', 'colourblind', 'nodeNames', 'lastMove', 'legalMoves', 'motion', 'muted', 'volume',
			'soundMoves', 'soundSpells', 'soundGame', 'soundLowTime', 'clockTenths', 'clockLow', 'confirmEndTurn',
			'confirmForfeit', 'blind', 'showEmotes', 'sendEmotes'];
		check('preferences.html shows every setting', want.every((k) => rows.includes(k)), rows);
		const headings = await page.$$eval('#prefs-root .settings-panel__heading', (els) => els.map((e) => e.textContent));
		check('in five sections', headings.join('|') === 'Board and stones|Sound|Clock|Play|Online games', headings);
		check('the account-only section stays hidden for a guest', await page.$eval('#account-prefs', (e) => e.hidden));
		check('every control has a label', await page.$$eval('#prefs-root [data-setting]', (els) => els.every((e) => e.closest('label') && e.closest('label').textContent.trim())));
		await page.select('#prefs-root [data-setting="theme"]', 'parchment');
		await page.click('#prefs-root [data-setting="blind"]');
		await page.click('#prefs-root [data-setting="nodeNames"]');
		await page.select('#prefs-root [data-setting="clockTenths"]', 'always');
		await page.select('#prefs-root [data-setting="clockLow"]', '30');
		await page.click('#prefs-root [data-setting="confirmForfeit"]');
		const stored = await page.evaluate(() => ({ s: JSON.parse(localStorage.getItem('sigil_settings')), theme: localStorage.getItem('sigil_theme'),
			attrs: ['data-blind', 'data-node-names'].map((a) => document.documentElement.hasAttribute(a)) }));
		check('changes are stored on this device and applied', stored.theme === 'parchment' && stored.s.blind === true && stored.s.nodeNames === true
			&& stored.s.clockTenths === 'always' && stored.s.clockLow === 30 && stored.s.confirmForfeit === false && stored.attrs.every(Boolean), stored);
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/preferences.png`, fullPage: true });
		await page.click('#prefs-reset');
		const reset = await page.evaluate(() => ({ s: JSON.parse(localStorage.getItem('sigil_settings')), theme: themeManager.current,
			blindBox: document.querySelector('#prefs-root [data-setting="blind"]').checked }));
		check('Reset to defaults', reset.theme === 'default' && reset.s.blind === false && reset.s.confirmForfeit === true && reset.s.clockLow === 10 && !reset.blindBox, reset);
		// 375 px: no horizontal scroll.
		await page.setViewport({ width: 375, height: 740 });
		await sleep(200);
		check('preferences.html at 375px: no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= 375));
		await page.close();

		// ---- 2. The in-game panel ----
		page = await newPage(browser, errors);
		await openGame(page);
		await page.click('.settings-toggle');
		const panel = await page.evaluate(() => {
			const p = document.getElementById('settings-panel');
			return {
				rows: [...p.querySelectorAll('[data-setting]')].map((e) => e.getAttribute('data-setting')),
				link: p.querySelector('a.settings-panel__link') && p.querySelector('a.settings-panel__link').getAttribute('href'),
				target: p.querySelector('a.settings-panel__link') && p.querySelector('a.settings-panel__link').target,
				first: document.activeElement.getAttribute('data-setting'),
			};
		});
		check('the game panel shows the game settings, not the online ones', ['nodeNames', 'clockTenths', 'confirmForfeit', 'blind', 'soundLowTime'].every((k) => panel.rows.includes(k))
			&& !panel.rows.includes('showEmotes'), panel.rows);
		check('it links to the full page in a new tab', panel.link === 'preferences.html' && panel.target === '_blank' && panel.first === 'theme', panel);
		await page.keyboard.press('Escape');

		// ---- 3. Board settings ----
		const first = await playMove(page);
		const ring = () => page.$eval('#stone-node--' + first, (el) => getComputedStyle(el).boxShadow);
		check('the last move has a ring', (await ring()) !== 'none');
		await page.evaluate(() => SigilSettings.set('lastMove', false));
		check('"Highlight the last move" off: no ring', (await ring()) === 'none');
		await page.evaluate(() => SigilSettings.set('lastMove', true));
		const nameLabel = () => page.$eval('#stone-node--' + first + ' .stone-node__name', (el) => ({ display: getComputedStyle(el).display, text: el.textContent }));
		check('node names hidden by default', (await nameLabel()).display === 'none');
		await page.evaluate(() => SigilSettings.set('nodeNames', true));
		const nl = await nameLabel();
		check('"Show node names": each node shows its name', nl.display === 'block' && nl.text === first, nl);
		const label = await page.$eval('#stone-node--' + first, (el) => el.getAttribute('aria-label'));
		check('the label does not change the node\'s accessible name', label === first + ', red stone, last play', label);
		await page.click('.action-button--end-turn');
		await page.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).whoseTurn === 'blue');
		const glowNode = (await board(page)).valid[0];
		const glow = () => page.$eval('#stone-node--' + glowNode, (el) => ({ shadow: getComputedStyle(el).boxShadow, after: getComputedStyle(el, '::after').content }));
		check('legal moves glow', (await glow()).shadow !== 'none');
		await page.evaluate(() => SigilSettings.set('legalMoves', false));
		const g = await glow();
		check('"Show legal moves" off: no glow', g.shadow === 'none' && g.after === 'none', g);
		await page.evaluate(() => { SigilSettings.set('legalMoves', true); SigilSettings.set('nodeNames', false); });

		// ---- 4. Sounds and the clock ----
		const sounds = await page.evaluate(() => {
			const played = [];
			for (const n of ['stonePlaced', 'spellCast', 'gameOver', 'lowTime']) soundManager['_snd_' + n] = () => played.push(n);
			soundManager.muted = false;
			soundManager.volume = 1;
			const run = () => { played.length = 0; for (const n of ['stonePlaced', 'spellCast', 'gameOver', 'lowTime']) soundManager.play(n); return played.join(); };
			const all = run();
			SigilSettings.set('soundMoves', false);
			SigilSettings.set('soundGame', false);
			const some = run();
			SigilSettings.set('soundMoves', true);
			SigilSettings.set('soundGame', true);
			// The low-time beep: once on crossing the mark, again after going back above it.
			const owner = {};
			played.length = 0;
			SigilSettings.lowTimeWarn(owner, 'red', 12000);
			SigilSettings.lowTimeWarn(owner, 'red', 9900);
			SigilSettings.lowTimeWarn(owner, 'red', 9000);
			const beeps1 = played.length;
			SigilSettings.lowTimeWarn(owner, 'red', 15000);
			SigilSettings.lowTimeWarn(owner, 'red', 9500);
			const beeps2 = played.length;
			SigilSettings.set('soundLowTime', false);
			SigilSettings.lowTimeWarn({}, 'red', 5000);
			const beeps3 = played.length;
			SigilSettings.set('soundLowTime', true);
			return { all, some, beeps1, beeps2, beeps3 };
		});
		check('each sound group plays until turned off', sounds.all === 'stonePlaced,spellCast,gameOver,lowTime' && sounds.some === 'spellCast,lowTime', sounds);
		check('the low-time beep plays once per crossing, and not when off', sounds.beeps1 === 1 && sounds.beeps2 === 2 && sounds.beeps3 === 2, sounds);
		const clock = await page.evaluate(() => {
			const t = (v, low, ms) => { SigilSettings.set('clockTenths', v); SigilSettings.set('clockLow', low); return SigilSettings.clockText(ms); };
			const out = [t('never', 10, 9450), t('low', 10, 9450), t('low', 10, 65000), t('always', 10, 65000), t('low', 0, 9450), t('low', 30, 25000)];
			// Under a 30 s mark 25 s is low; with no mark nothing is.
			const low = [SigilSettings.clockLow(25000), (SigilSettings.set('clockLow', 0), SigilSettings.clockLow(1000))];
			SigilSettings.set('clockTenths', 'low');
			SigilSettings.set('clockLow', 10);
			return { out, low };
		});
		check('clock text follows "Tenths of a second" and the low-time mark', clock.out.join() === '0:10,0:09.4,1:05,1:05.0,0:09.4,0:25.0'
			&& clock.low[0] === true && clock.low[1] === false, clock);
		await page.close();

		// A clocked game shows tenths under the mark.
		page = await newPage(browser, errors, { storage: { sigil_settings: JSON.stringify({ clockTenths: 'low', clockLow: 60 }) } });
		await openGame(page, '?clock=1%2B0');
		await sleep(1500);
		const clockText = await page.$eval('.game-clock__side--red', (e) => e.textContent.trim());
		check('a 1-minute game under a 60 s mark shows tenths', /^Red 0:5\d\.\d$/.test(clockText), clockText);

		// ---- 5. Forfeit in one click ----
		await page.evaluate(() => SigilSettings.set('confirmForfeit', false));
		await page.click('.action-button--forfeit');
		await page.waitForFunction(() => !!Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).winner, { timeout: 5000 }).catch(() => {});
		check('"Confirm before forfeiting" off: one click concedes', (await board(page)).winner === 'blue');
		await page.close();
		page = await newPage(browser, errors);
		await openGame(page);
		await page.click('.action-button--forfeit');
		await sleep(200);
		let b = await board(page);
		check('by default the first click only asks', !b.winner && b.forfeitArmed);
		await page.close();

		// ---- 6. Blind mode ----
		page = await newPage(browser, errors, { storage: { sigil_settings: JSON.stringify({ blind: true, colourblind: true }) } });
		await openGame(page);
		b = await board(page);
		const blindState = await page.evaluate(() => {
			const p = document.querySelector('.blind-panel');
			return { panel: !!p && !p.hidden, title: p && p.querySelector('h2').textContent, attr: document.documentElement.hasAttribute('data-blind') };
		});
		check('blind mode: the panel is shown above the board', blindState.panel && blindState.title === 'Blind mode' && blindState.attr, blindState);
		const img = await stoneImage(page, b.red[0]);
		const marker = await page.$eval('#stone-node--' + b.red[0], (el) => getComputedStyle(el, '::before').content);
		check('blind mode: stones are not drawn (no image, no colourblind marker)', img === 'none' && marker === 'none', { img, marker });
		const label0 = await page.$eval('#stone-node--' + b.red[0], (el) => el.getAttribute('aria-label'));
		check('nodes still tell a screen reader what is on them', /red stone/.test(label0), label0);
		const placed = await playMove(page);
		await sleep(600);
		const said = await page.evaluate(() => ({
			list: [...document.querySelectorAll('.blind-panel__moves li')].map((li) => li.textContent),
			live: document.querySelector('.blind-panel__live').textContent,
		}));
		check('blind mode: the move is read out by node name', said.list[0] === 'Red on ' + placed + '.' && said.live === said.list[0], said);
		check('the stone just played is not drawn either', (await stoneImage(page, placed)) === 'none');
		await page.click('.action-button--end-turn');
		await page.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).whoseTurn === 'blue');
		await page.keyboard.press('p');
		await sleep(300);
		const desc = await page.$eval('.blind-panel__position', (e) => e.textContent);
		b = await board(page);
		check('P describes the position: whose turn, every stone, the spells', /^Blue to move\./.test(desc)
			&& desc.includes('Red, ' + b.red.length + ' stones: ' + b.red.join(', ') + '.')
			&& desc.includes('Blue, ' + b.blue.length + ' stone') && /\((a2 a3 a4 a5 a6)\)/.test(desc) && /Spells cast: red 0, blue 0\./.test(desc), desc);
		const shortcuts = await page.evaluate(() => {
			SigilDialog.toggleShortcuts();
			const dd = [...document.querySelectorAll('#shortcuts-overlay dt')].find((d) => d.textContent === 'P');
			const shown = dd && getComputedStyle(dd).display !== 'none';
			SigilDialog.toggleShortcuts();
			return shown;
		});
		check('the shortcut list has P while blind mode is on', shortcuts);
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/blind-game.png` });
		await page.click('.blind-panel__off');
		await sleep(200);
		const off = await page.evaluate(() => ({ attr: document.documentElement.hasAttribute('data-blind'), panel: document.querySelector('.blind-panel').hidden }));
		check('"Show the stones" turns blind mode off', !off.attr && off.panel && (await stoneImage(page, b.red[0])) !== 'none', off);
		await page.close();

		// Blind mode on the puzzles page too; not on the analysis board.
		page = await newPage(browser, errors, { storage: { sigil_settings: JSON.stringify({ blind: true }) } });
		await page.goto(`${BASE}/analysis.html`, { waitUntil: 'load' });
		await sleep(1500);
		check('the analysis board ignores blind mode', !(await page.$('.blind-panel')) && !(await page.evaluate(() => document.body.classList.contains('blind-page'))));
		await page.close();

		// ---- 7. The old "Mute emotes" ----
		page = await newPage(browser, errors, { storage: { sigil_settings: JSON.stringify({ muteEmotes: true }) } });
		await page.goto(`${BASE}/preferences.html`, { waitUntil: 'load' });
		const mig = await page.evaluate(() => [SigilSettings.get('showEmotes'), SigilSettings.get('sendEmotes'),
			document.querySelector('[data-setting="showEmotes"]').checked]);
		check('"Mute emotes" carries over as both emote settings off', mig.join() === 'false,false,false', mig);
		await page.close();
	} finally {
		await browser.close();
	}
	check('no page errors', errors.length === 0, errors);
	console.log(failures ? `prefs FAILED: ${failures} check(s)` : 'prefs OK');
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
