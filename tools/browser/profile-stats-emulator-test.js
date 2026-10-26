// profile.html's Games / Stats / Insights tabs on the Firebase emulators
// (no live database), from seeded user_games, rooms and users: the per-mode
// tables, streaks, best win / worst loss, the insight charts, the game
// search filters, and the "Download all games" JSON-lines export.
//
//   (cd docs && python3 -m http.server 8807) &
//   cd functions && firebase emulators:exec --only database --project demo-sigil \
//     'node ../tools/browser/profile-stats-emulator-test.js http://localhost:8807'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8807';
// PROFILE_SHOTS=<dir>: also save screenshots of the tabs there.
const SHOTS = process.env.PROFILE_SHOTS || '';
const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }) : null);
const NS = 'sigil-js-default-rtdb';
const OWNER = { Authorization: 'Bearer owner' };
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const DB = 'http://' + DB_HOST;

function useEmulators(dbHost) {
	let fb;
	Object.defineProperty(window, 'firebase', {
		configurable: true,
		get() { return fb; },
		set(v) {
			fb = v;
			const init = v.initializeApp.bind(v);
			v.initializeApp = (...args) => {
				const app = init(...args);
				app.database().useEmulator(dbHost.split(':')[0], Number(dbHost.split(':')[1]));
				return app;
			};
		},
	});
	// Keep the export's blob instead of downloading it.
	window.__exports = [];
	const orig = URL.createObjectURL.bind(URL);
	URL.createObjectURL = (b) => { window.__exports.push(b); return orig(b); };
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

const ME = 'tester_uid', ALICE = 'alice_uid', BOB = 'bob_uid', AI = '__ai_hard__';
const T = (day) => Date.UTC(2026, 9, day, 12);
const sfn = (counter, spells) => 'x'.repeat(39) + '/' + spells.join(',') + ' r ' + counter + ' 0:0 -:- -:- b1';
const SPELLS_A = ['Flood', 'Bewitch', 'Sprout'];   // Flood is shown as Tsunami
const SPELLS_B = ['Bewitch', 'Charge', 'Splash'];
const LIVE5 = { type: 'realtime', initialTime: 300000, increment: 3000 };
const LIVE15 = { type: 'realtime', initialTime: 900000, increment: 0 };
const LIVE3 = { type: 'realtime', initialTime: 180000, increment: 2000 };
const CORR = { type: 'correspondence', moveTimeout: 86400000 };

// [id, day, opponent, oppUid, isAI, color, result, rated, change, extra, room]
const G = [
	['g1', 1, 'Alice', ALICE, false, 'red', 'win', true, 16, {}, { code: 'R1', tc: LIVE5, spells: SPELLS_A, end: 12, online: true }],
	['g2', 2, 'Alice', ALICE, false, 'blue', 'loss', true, -14, {}, { code: 'R2', tc: LIVE15, spells: SPELLS_A, end: 25, online: true }],
	['g3', 3, 'Hard AI', AI, true, 'red', 'win', true, 20, {}, { code: 'L3', tc: { type: 'none' }, spells: SPELLS_B, end: 33, online: false }],
	['g4', 4, 'Bob', BOB, false, 'blue', 'win', true, 10, {}, { code: 'R4', tc: CORR, spells: SPELLS_B, end: 8, online: true }],
	['g5', 5, 'Bob', BOB, false, 'red', 'loss', false, 0, { unratedReason: 'deathmatch' }, { code: 'R5', tc: { type: 'none' }, spells: SPELLS_B, end: 45, online: true, variant: 'deathmatch' }],
	['g6', 6, 'Hard AI', AI, true, 'blue', 'loss', false, 0, { unratedReason: 'unrated-pack' }, { code: 'GONE6', missing: true }],
	['g7', 7, 'Alice', ALICE, false, 'red', 'win', true, 8, { fromPosition: true }, { code: 'R7', tc: LIVE3, spells: SPELLS_A, end: 20, start: 10, online: true }],
];
const OPP_BEFORE = { g1: 1100, g2: 1084, g4: 900, g7: 1070 };

function seed() {
	const userGames = { [ME]: {}, [ALICE]: {}, [BOB]: {} };
	const rooms = {};
	let elo = 1000;
	for (const [id, day, opp, oppUid, isAI, color, result, rated, change, extra, room] of G) {
		const e = Object.assign({ timestamp: T(day), roomCode: room.code, gameId: id, opponent: opp, opponentUid: oppUid,
			opponentIsAI: isAI, color, result, fromPosition: !!extra.fromPosition, rated }, extra);
		if (rated) { Object.assign(e, { eloBefore: elo, eloAfter: elo + change, eloChange: change }); elo += change; }
		delete e.unratedReason;
		if (extra.unratedReason) e.unratedReason = extra.unratedReason;
		userGames[ME][id] = e;
		if (OPP_BEFORE[id]) {
			userGames[oppUid][id] = { timestamp: T(day), gameId: id, opponent: 'Tester', opponentUid: ME, color: color === 'red' ? 'blue' : 'red',
				result: result === 'win' ? 'loss' : 'win', rated: true, eloBefore: OPP_BEFORE[id], eloAfter: OPP_BEFORE[id] - change, eloChange: -change };
		}
		if (room.missing) continue;
		const winner = result === 'win' ? color : (color === 'red' ? 'blue' : 'red');
		const r = { status: 'finished', spellNames: room.spells, variant: room.variant || 'standard', timeControl: room.tc, winner,
			finalSfn: sfn(room.end, room.spells), ranked: rated,
			red: { uid: color === 'red' ? ME : oppUid, displayName: color === 'red' ? 'Tester' : opp },
			blue: { uid: color === 'blue' ? ME : oppUid, displayName: color === 'blue' ? 'Tester' : opp } };
		if (room.start) r.startSfn = sfn(room.start, room.spells);
		if (room.online) {
			r.turns = {
				'-a1': { color: 'red', actions: ['a11', 'pass'], timestamp: T(day) + 1000 },
				'-a2': { color: 'blue', actions: ['b3', 'dash', 'b4', 'pass'], timestamp: T(day) + 2000 },
			};
		} else {
			r.local = true;
			r.gameLog = [
				{ color: 'red', turnNumber: 1, kind: 'input', actions: ['a11', 'pass'] },
				{ color: 'blue', turnNumber: 2, kind: 'sim', actions: [{ type: 'move', node: 'b9' }] },
			];
		}
		rooms[room.code] = r;
	}
	return {
		users: {
			[ME]: { displayName: 'Tester', elo, gamesPlayed: 5, wins: 4, losses: 1, created: 1 },
			[ALICE]: { displayName: 'Alice', elo: 1050, gamesPlayed: 3, wins: 1, losses: 2, created: 1 },
			[BOB]: { displayName: 'Bob', elo: 890, gamesPlayed: 2, wins: 1, losses: 1, created: 1 },
			[AI]: { displayName: 'Hard AI', elo: 1600, gamesPlayed: 99, wins: 50, losses: 49, created: 1, isAI: true },
		},
		user_games: userGames,
		rooms,
	};
}

const P = '[x-data^="profilePage"]';
const val = (p, expr) => p.evaluate((s, x) => new Function('L', 'return ' + x)(document.querySelector(s)._x_dataStack[0]), P, expr);
const rowsText = (p, sel) => p.$$eval(sel + ' tbody tr', (trs) => trs.map((tr) => Array.from(tr.cells).map((c) => c.textContent.trim()).join('|')));

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());
	for (const [k, v] of Object.entries(seed())) {
		const r = await fetch(`${DB}/${k}.json?ns=${NS}`, { method: 'PATCH', headers: OWNER, body: JSON.stringify(v) });
		if (r.status !== 200) throw new Error('seed ' + k + ': ' + r.status);
	}

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	try {
		const p = await browser.newPage();
		await p.evaluateOnNewDocument(useEmulators, DB_HOST);
		await p.setBypassServiceWorker(true);
		await p.setRequestInterception(true);
		p.on('request', (req) => {
			const url = req.url();
			if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		p.on('pageerror', (e) => { console.log('pageerror:', e.message); ok = false; });
		await p.setViewport({ width: 900, height: 900 });
		await p.goto(`${BASE}/profile.html?uid=${ME}`, { waitUntil: 'load', timeout: 90000 });
		await p.waitForFunction((s) => { const el = document.querySelector(s); const d = el && el._x_dataStack && el._x_dataStack[0]; return d && !d.loading && d.user && !d.metaLoading && d.metaCovered === 7; }, { timeout: 60000 }, P);

		// Games tab and search
		check('7 games listed', (await p.$$('.games-table tbody tr')).length === 7);
		check('newest first', (await p.$eval('.games-table tbody tr', (tr) => tr.getAttribute('data-game'))) === 'g7');
		check('unrated reason as title', (await p.$eval('tr[data-game="g5"] .elo-change--unrated', (e) => e.title)) === 'Unrated: Deathmatch games do not affect rating.');
		const count = async () => (await p.$$('.games-table tbody tr')).length;
		await p.type('[data-filter="opponent"]', 'ali');
		check('opponent filter "ali" -> 3', (await count()) === 3);
		await p.select('[data-filter="result"]', 'loss');
		check('+ losses -> 1 (g2)', (await count()) === 1 && (await p.$eval('.games-table tbody tr', (tr) => tr.getAttribute('data-game'))) === 'g2');
		await p.evaluate(() => { const a = Array.from(document.querySelectorAll('.filter-summary a')).find((x) => /clear/.test(x.textContent)); a.click(); });
		await p.select('[data-filter="rated"]', 'unrated');
		check('unrated -> 2', (await count()) === 2);
		await p.select('[data-filter="rated"]', 'all');
		const spells = await p.$$eval('[data-filter="spell"] option', (os) => os.map((o) => o.value).filter(Boolean));
		check('spell options (Flood shown as Tsunami)', JSON.stringify(spells) === JSON.stringify(['Bewitch', 'Charge', 'Splash', 'Sprout', 'Tsunami']), spells);
		await p.select('[data-filter="spell"]', 'Tsunami');
		check('spell Tsunami -> 3 (g1 g2 g7)', (await count()) === 3);
		await p.select('[data-filter="spell"]', 'Bewitch');
		check('spell Bewitch -> 6 (room of g6 is gone)', (await count()) === 6);
		await p.select('[data-filter="spell"]', '');
		await p.$eval('[data-filter="from"]', (e) => { e.value = '2026-10-03'; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); });
		await p.$eval('[data-filter="to"]', (e) => { e.value = '2026-10-05'; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); });
		check('date 10-03..10-05 -> 3', (await count()) === 3, await p.$eval('.filter-count', (e) => e.textContent));
		await val(p, 'L.clearFilters()');
		check('cleared -> 7', (await count()) === 7);

		// Stats tab
		await p.click('#tab-stats');
		check('current streak 1 W', (await p.$eval('[data-stat="current-streak"] .stat-tile__value', (e) => e.textContent.trim())) === '1 W');
		check('longest win streak 2', (await p.$eval('[data-stat="longest-win"] .stat-tile__value', (e) => e.textContent.trim())) === '2');
		check('longest losing streak 2', (await p.$eval('[data-stat="longest-loss"] .stat-tile__value', (e) => e.textContent.trim())) === '2');
		const best = await p.$eval('[data-stat="best-win"]', (e) => e.textContent.replace(/\s+/g, ' ').trim());
		check('best win 1600 vs Hard AI', /1600/.test(best) && /vs Hard AI/.test(best), best);
		const worst = await p.$eval('[data-stat="worst-loss"]', (e) => e.textContent.replace(/\s+/g, ' ').trim());
		check('worst loss 1084 vs Alice (before-game rating)', /1084/.test(worst) && /vs Alice/.test(worst), worst);
		const kind = await rowsText(p, '[data-mode="byKind"]');
		check('by opponent', JSON.stringify(kind) === JSON.stringify(['vs players|5|3–2|60%|+20', 'vs AI|2|1–1|50%|+20']), kind);
		const tc = await rowsText(p, '[data-mode="byTc"]');
		check('by time control (room gone: not counted)', JSON.stringify(tc) === JSON.stringify([
			'Live, under 10 min|2|2–0|100%|+24', 'Live, 10 min or more|1|0–1|0%|−14', 'Correspondence|1|1–0|100%|+10', 'Untimed|2|1–1|50%|+20']), tc);
		const vr = await rowsText(p, '[data-mode="byVariant"]');
		check('by variant', JSON.stringify(vr) === JSON.stringify(['Standard|4|3–1|75%|+32', 'Deathmatch|1|0–1|0%|—', 'From a position|1|1–0|100%|+8']), vr);

		await shot(p, 'stats-900');
		// Insights tab
		await p.click('#tab-insights');
		await p.waitForFunction(() => document.querySelectorAll('[data-insight] svg.ins-chart').length === 3, { timeout: 10000 });
		await shot(p, 'insights-900');
		const tips = await p.$$eval('[data-insight="byColor"] [data-tip]', (gs) => gs.map((g) => g.getAttribute('data-tip')));
		check('colour chart', JSON.stringify(tips) === JSON.stringify(['Red: 75% won, 3–1 in 4 games', 'Blue: 33% won, 1–2 in 3 games']), tips);
		const len = await p.$$eval('[data-insight="byLength"] [data-tip]', (gs) => gs.map((g) => g.getAttribute('data-tip')));
		check('length chart', JSON.stringify(len) === JSON.stringify(['1–10 turns: 100% won, 2–0 in 2 games', '11–20 turns: 100% won, 1–0 in 1 game',
			'21–30 turns: 0% won, 0–1 in 1 game', '31–40 turns: 100% won, 1–0 in 1 game', '41+ turns: 0% won, 0–1 in 1 game']), len);
		const sp = await p.$$eval('[data-insight="bySpell"] [data-tip]', (gs) => gs.map((g) => g.getAttribute('data-tip')));
		check('spell chart: Bewitch first (6 games)', sp[0] === 'Bewitch: 67% won, 4–2 in 6 games' && sp.length === 5, sp);
		const bar = await p.$eval('[data-insight="byColor"] .ins-bar', (e) => getComputedStyle(e).fill);
		const accent = await p.evaluate(() => { const d = document.createElement('div'); d.style.color = 'var(--color-accent)'; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; });
		check('bars wear the theme accent', bar === accent, [bar, accent]);

		// Export
		await p.click('#tab-games');
		await p.click('#export-games');
		await p.waitForFunction(() => window.__exports.length === 1, { timeout: 20000 });
		const text = await p.evaluate(() => window.__exports[0].text());
		const lines = text.trim().split('\n').map((l) => JSON.parse(l));
		check('export: 7 JSON lines, newest first', lines.length === 7 && lines[0].gameId === 'g7', lines.map((l) => l.gameId));
		const l1 = lines.find((l) => l.gameId === 'g1');
		check('export keeps the stored entry', l1.eloBefore === 1000 && l1.eloChange === 16 && l1.opponent === 'Alice' && l1.rated === true);
		check('export: online transcript numbered from 1', JSON.stringify(l1.transcript) === JSON.stringify([
			{ color: 'red', turnNumber: 1, kind: 'input', actions: ['a11', 'pass'] }, { color: 'blue', turnNumber: 2, kind: 'input', actions: ['b3', 'dash', 'b4', 'pass'] }]), l1.transcript);
		check('export: SFNs and SGN-T', l1.finalSfn === sfn(12, SPELLS_A) && /\[Format "transcript-v1"\]/.test(l1.sgn) && /\nR1\. a11 pass\n/.test(l1.sgn) && /\[Red "Tester"\]/.test(l1.sgn), l1.sgn);
		const l7 = lines.find((l) => l.gameId === 'g7');
		check('export: from a position starts at turn 11', l7.startSfn === sfn(10, SPELLS_A) && l7.transcript[0].turnNumber === 11 && /\[Setup /.test(l7.sgn));
		const l3 = lines.find((l) => l.gameId === 'g3');
		check('export: AI archive gameLog (sim turn kept)', l3.transcript.length === 2 && l3.transcript[1].kind === 'sim' && /B2\* /.test(l3.sgn));
		const l6 = lines.find((l) => l.gameId === 'g6');
		check('export: missing room flagged', l6.transcript === null && l6.transcriptMissing === 'room-not-found' && l6.unratedReason === 'unrated-pack');
		check('export status', /7 games downloaded/.test(await p.$eval('.export-row .meta-note', (e) => e.textContent)));

		// Phone width: no horizontal page scroll on any tab.
		await p.setViewport({ width: 360, height: 800 });
		for (const t of ['games', 'stats', 'insights']) {
			await p.click('#tab-' + t);
			await new Promise((r) => setTimeout(r, 400));
			await shot(p, t + '-360');
			const sw = await p.evaluate(() => document.documentElement.scrollWidth);
			const wide = sw <= 360 ? [] : await p.evaluate(() => Array.from(document.querySelectorAll('body *'))
				.filter((e) => e.offsetParent !== null && e.getBoundingClientRect().right > 361)
				.slice(0, 5).map((e) => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)));
			check('360 px, ' + t + ': no horizontal scroll', sw <= 360, [sw, wide]);
		}
		// Cached room fields survive a reload; the light (parchment) theme's
		// accent paints the bars there.
		await p.evaluate(() => { localStorage.setItem('sigil_theme', 'parchment'); });
		await p.setViewport({ width: 900, height: 900 });
		await p.reload({ waitUntil: 'load' });
		await p.waitForFunction((s) => { const el = document.querySelector(s); const d = el && el._x_dataStack && el._x_dataStack[0]; return d && !d.loading && !d.metaLoading && d.metaCovered === 7; }, { timeout: 60000 }, P);
		const cached = await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('sigil_profile_meta_v1') || '{}')).length);
		check('room fields cached for the 6 rooms found', cached === 6, cached);
		await p.waitForFunction(() => document.querySelectorAll('[data-insight] svg.ins-chart').length === 3, { timeout: 10000 });
		const light = await p.$eval('[data-insight="byColor"] .ins-bar', (e) => getComputedStyle(e).fill);
		await shot(p, 'insights-parchment');
		check('parchment: bars wear its accent', light === 'rgb(106, 74, 26)', light);
	} catch (e) {
		console.log('FAIL exception', e && e.stack);
		ok = false;
	} finally {
		await browser.close();
	}
	console.log(ok ? 'TEST OK' : 'TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
