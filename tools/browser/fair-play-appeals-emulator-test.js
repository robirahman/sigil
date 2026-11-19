// Automatic suspensions, appeals and the engine scan, on the Firebase emulators
// (no live database, no functions: user_flags is seeded as rateGame writes it):
//   1. A player suspended automatically sees the reason, the end, the games
//      behind it, and files an appeal from account.html (appeals/{uid}).
//   2. A player with one offense in the window sees where they stand.
//   3. An admin finds the appeal in admin.html's queue with the games, lifts
//      the suspension and forgives its games; the player sees the decision.
//   4. An admin's own suspension appealed and extended from its end.
//   5. The Engine scan tab shows the latest fairplay_reports/ report, and a
//      report file opened in the browser.
//
//   (cd docs && python3 -m http.server 8801) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/fair-play-appeals-emulator-test.js http://localhost:8801'
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8801';
const NS = 'sigil-js-default-rtdb';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const DB = 'http://' + DB_HOST;
const OWNER = { Authorization: 'Bearer owner' };
const DAY = 86400000;

// Point the page's Firebase at the emulators as soon as the app exists.
function useEmulators(dbHost, authHost) {
	let fb;
	Object.defineProperty(window, 'firebase', {
		configurable: true,
		get() { return fb; },
		set(v) {
			fb = v;
			const init = v.initializeApp.bind(v);
			v.initializeApp = (...args) => {
				const app = init(...args);
				app.auth().useEmulator('http://' + authHost, { disableWarnings: true });
				app.database().useEmulator(dbHost.split(':')[0], Number(dbHost.split(':')[1]));
				return app;
			};
		},
	});
	if (navigator.serviceWorker) navigator.serviceWorker.getRegistration = () => Promise.resolve(undefined);
}

// gstatic downloads flake here: serve the Firebase SDK from memory.
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

async function signUp(email) {
	const res = await (await fetch('http://' + AUTH_HOST + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }),
	})).json();
	if (!res.localId) throw new Error('sign-up failed: ' + JSON.stringify(res));
	return res.localId;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const stamp = Date.now();
	const who = ['bob', 'carol', 'dave', 'root'];
	const emails = Object.fromEntries(who.map((k) => [k, `fpp${k}${stamp}@example.com`]));
	const uid = {};
	for (const k of who) uid[k] = await signUp(emails[k]);
	const profile = (name) => ({ displayName: name, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: stamp });
	const now = Date.now();
	const banAt = now - 3600000;
	// Bob: suspended automatically after an abandonment and a stall (as
	// fair-play.js fairPlayApplyOffense writes it).
	const bobFlags = {
		banUntil: banAt + DAY, reason: 'Automatic: 2 online games abandoned or stalled in 30 days (1 left, 1 stalled), suspension level 1.',
		auto: true, by: 'auto', at: banAt, abandons: 1, abandonedGames: { FPR001: true }, stalls: 1,
		offenses: { FPR001: { kind: 'abandon', at: now - 3 * DAY }, FPR002: { kind: 'stall', at: banAt - 1000, satMs: 301000, leftMs: 300000, medianMs: 12000, turns: 7 } },
		restrictions: { FPR002: { at: banAt, until: banAt + DAY, level: 1, kind: 'stall', rooms: { FPR001: 'abandon', FPR002: 'stall' } } },
	};
	await rest('PATCH', '', {
		['users/' + uid.bob]: profile('Bob'),
		['users/' + uid.carol]: profile('Carol'),
		['users/' + uid.dave]: profile('Dave'),
		['users/' + uid.root]: profile('Root'),
		['admins/' + uid.root]: true,
		['user_flags/' + uid.bob]: bobFlags,
		// Carol: one abandonment this week, no suspension.
		['user_flags/' + uid.carol]: { abandons: 1, abandonedGames: { FPR003: true }, offenses: { FPR003: { kind: 'abandon', at: now - 2 * DAY } } },
		// Dave: an admin's 7-day suspension.
		['user_flags/' + uid.dave]: { banUntil: now + 7 * DAY, reason: 'Abusive chat', by: uid.root, at: now - 60000 },
	});

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	const errors = [];

	async function openAs(name, url) {
		const ctx = await browser.createBrowserContext();
		const page = await ctx.newPage();
		await page.setViewport({ width: 412, height: 860 });
		await page.evaluateOnNewDocument(useEmulators, DB_HOST, AUTH_HOST);
		await page.setBypassServiceWorker(true);
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const u = req.url();
			if (!u.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(u).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		page.on('pageerror', (e) => { errors.push(name + ': ' + e.message); console.log('pageerror (' + name + '):', e.message); });
		await page.goto(`${BASE}/${url}`, { waitUntil: 'load', timeout: 90000 });
		await page.waitForFunction(() => !!window.Alpine && !!window.firebase && firebase.apps.length > 0, { timeout: 30000, polling: 250 });
		await page.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), emails[name]);
		return page;
	}
	const visible = (page, sel) => waitIn(page, (s) => { const n = document.querySelector(s); return n && n.offsetParent !== null; }, sel);
	const text = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent.replace(/\s+/g, ' ').trim(), sel);
	const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
	// FP_SHOTS=<dir>: full-page screenshots of each step, to look at.
	const shot = async (page, name) => { if (process.env.FP_SHOTS) await page.screenshot({ path: path.join(process.env.FP_SHOTS, name + '.png'), fullPage: true }); };
	const poll = async (fn) => { let v; for (let i = 0; i < 40; i++) { v = await fn(); if (v) return v; await wait(250); } return v; };

	try {
		// 1. Bob sees the automatic suspension and its games, and appeals.
		const pb = await openAs('bob', 'account.html');
		await visible(pb, '[data-testid="ban-notice"]');
		const notice = await text(pb, '[data-testid="ban-notice"]');
		check('the suspended player sees the reason and the end', /suspended from rated play/.test(notice) && /Automatic: 2 online games/.test(notice) && /until /.test(notice), notice);
		const games = await pb.evaluate(() => [...document.querySelectorAll('[data-testid="ban-games"] li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
		check('... and the games behind it, with the stall\'s clock', games.length === 2 && games.some((g) => /^FPR001: left the game/.test(g))
			&& games.some((g) => /^FPR002: clock run out \(5 min left, 12 s a turn before\)/.test(g)), games);
		await pb.click('[data-testid="appeal-open"]');
		await visible(pb, '#appeal-text');
		await pb.type('#appeal-text', 'My router failed in FPR001 and I was away from the screen in FPR002.');
		await shot(pb, 'account-suspended');
		await pb.click('[data-testid="appeal-send"]');
		await visible(pb, '[data-testid="appeal-status"]');
		check('the appeal is acknowledged', /You appealed on .* An admin will review it\./.test(await text(pb, '[data-testid="appeal-status"]')));
		const filed = await rest('GET', 'appeals/' + uid.bob);
		check('the appeal is filed for this suspension', filed && filed.banAt === banAt && filed.status === 'open' && /router/.test(filed.text) && typeof filed.at === 'number', filed);
		await shot(pb, 'account-appealed');
		check('account page fits a phone', await noHScroll(pb));

		// 2. Carol: one game in the window, and what the next would bring.
		const pc = await openAs('carol', 'account.html');
		await visible(pc, '[data-testid="fair-play-standing"]');
		const standing = await text(pc, '[data-testid="fair-play-standing"]');
		check('a player with one offense sees where they stand', /1 online game in the last 30 days/.test(standing)
			&& /One more within 30 days suspends you from rated play for 1 day/.test(standing) && /FPR003/.test(standing), standing);
		await shot(pc, 'account-standing');
		check('... and no suspension notice', !(await pc.evaluate(() => document.querySelector('[data-testid="ban-notice"]').offsetParent)));

		// 3. The admin lifts Bob's suspension on appeal and forgives its games.
		const pr = await openAs('root', 'admin.html');
		await waitIn(pr, () => /Appeals \(1\)/.test((document.querySelector('[data-testid="tab-appeals"]') || {}).textContent || ''));
		await pr.click('[data-testid="tab-appeals"]');
		await waitIn(pr, () => document.querySelectorAll('[data-testid="appeal-card"]').length === 1);
		const card = await text(pr, '[data-testid="appeal-card"]');
		check('the admin sees the appeal, the suspension and its games', /Bob/.test(card) && /router failed/.test(card) && /\(automatic\)/.test(card)
			&& /FPR001: abandoned/.test(card) && /FPR002: stalled \(sat 301 s with 300 s left; median turn 12 s over 7 turns\)/.test(card), card);
		await shot(pr, 'admin-appeal');
		check('admin page fits a phone', await noHScroll(pr));
		await pr.type('[data-testid="appeal-note"]', 'Network trouble; lifted.');
		await pr.click('[data-testid="appeal-lift"]');
		const flags = await poll(async () => { const f = await rest('GET', 'user_flags/' + uid.bob); return f && f.banUntil === 0 ? f : null; });
		check('lifted: not automatic any more, overturned, its games forgiven', flags && flags.auto === undefined && flags.reason === undefined
			&& flags.restrictions.FPR002.overturned === true && flags.restrictions.FPR002.overturnedBy === uid.root
			&& flags.offenses.FPR001.forgiven === true && flags.offenses.FPR002.forgiven === true && flags.offenses.FPR002.leftMs === 300000, flags);
		const decided = await rest('GET', 'appeals/' + uid.bob);
		check('the appeal is decided with the note', decided.status === 'lifted' && decided.adminNote === 'Network trouble; lifted.'
			&& decided.resolvedBy === uid.root && decided.until === 0 && /router/.test(decided.text), decided);
		await pb.reload({ waitUntil: 'load' });
		await visible(pb, '[data-testid="appeal-result"]');
		check('the player sees the decision and the note', /Your appeal was upheld and the suspension lifted\. Admin's note: Network trouble; lifted\./.test(await text(pb, '[data-testid="appeal-result"]')));
		await shot(pb, 'account-lifted');
		check('... no suspension, and forgiven games no longer count', await pb.evaluate(() =>
			!document.querySelector('[data-testid="ban-notice"]').offsetParent && !document.querySelector('[data-testid="fair-play-standing"]').offsetParent));

		// 4. Dave appeals an admin's suspension; it is extended by 7 days from its end.
		const pd = await openAs('dave', 'account.html');
		await visible(pd, '[data-testid="appeal-open"]');
		await pd.click('[data-testid="appeal-open"]');
		await pd.type('#appeal-text', 'It was a joke.');
		await pd.click('[data-testid="appeal-send"]');
		await visible(pd, '[data-testid="appeal-status"]');
		await pr.reload({ waitUntil: 'load' });
		await waitIn(pr, () => /Appeals \(1\)/.test((document.querySelector('[data-testid="tab-appeals"]') || {}).textContent || ''));
		await pr.click('[data-testid="tab-appeals"]');
		await waitIn(pr, () => [...document.querySelectorAll('[data-testid="appeal-card"]')].some((c) => /It was a joke/.test(c.textContent) && c.querySelector('[data-testid="appeal-extend"]')));
		const before = (await rest('GET', 'user_flags/' + uid.dave)).banUntil;
		await pr.evaluate(() => {
			const c = [...document.querySelectorAll('[data-testid="appeal-card"]')].find((x) => /It was a joke/.test(x.textContent));
			c.querySelector('[data-testid="appeal-extend"]').click();
		});
		const dflags = await poll(async () => { const f = await rest('GET', 'user_flags/' + uid.dave); return f && f.banUntil > before ? f : null; });
		check('extended by 7 days from its end, still the same suspension', dflags && dflags.banUntil === before + 7 * DAY && dflags.at === now - 60000 && dflags.reason === 'Abusive chat', dflags);
		const dAppeal = await rest('GET', 'appeals/' + uid.dave);
		check('the appeal records the new end', dAppeal.status === 'extended' && dAppeal.until === before + 7 * DAY, dAppeal);
		await pd.reload({ waitUntil: 'load' });
		await visible(pd, '[data-testid="appeal-status"]');
		check('the player sees the extension', /refused and the suspension extended until/.test(await text(pd, '[data-testid="appeal-status"]')));
		check('... and cannot appeal it again', await pd.evaluate(() => !document.querySelector('[data-testid="appeal-open"]')));

		// 5. The engine scan: the latest published report, then a file.
		const report = (run, flag) => ({
			version: 1, generatedAt: now, run, engine: 'rust-v35@test', depth: 4, evalName: 'nnue_mt256',
			params: {}, source: { games: 40, rows: 900, lines: 'fp_lines.json' }, note: 'Flags are for human review only.',
			players: [
				{ uid: uid.bob, rating: 1210.5, games: 12, turns: 180, flag, why: ['Engine match 81% [74%, 87%]: the whole interval is above the 95th percentile of 9 players within 150 rating (52%).'],
					t1: { est: 0.81, lo: 0.74, hi: 0.87 }, acpl: { est: 6.2, lo: 3.9, hi: 8.8 }, close: { est: 0.9, lo: 0.85, hi: 0.94 },
					peers: { n: 9, band: 150, t1: { mean: 0.41, sd: 0.07, p95: 0.52 }, acpl: { mean: 41.5, sd: 9.1, p05: 27.3 }, close: { mean: 0.5, sd: 0.1, p95: 0.6 } },
					z: { t1: 5.71, acpl: -3.88, close: 4 },
					gameList: [{ gameId: 'g1', roomCode: 'FPR010', timestamp: now - DAY, color: 'red', opponentUid: uid.carol, rating: 1200, turns: 15, t1: 0.8, acpl: 5.1 }] },
				{ uid: uid.carol, rating: 1190, games: 10, turns: 150, flag: 'none', why: [], t1: { est: 0.4, lo: 0.33, hi: 0.47 }, acpl: { est: 40, lo: 33, hi: 48 },
					close: { est: 0.5, lo: 0.4, hi: 0.6 }, peers: null, z: null, gameList: [] },
			],
			anchors: [{ uid: '__ai_rust_hard__', rating: 1600, games: 8, turns: 120, flag: 'anchor', why: [], t1: { est: 0.9, lo: 0.85, hi: 0.94 }, acpl: { est: 2, lo: 1, hi: 3 }, close: { est: 0.95, lo: 0.9, hi: 0.98 }, gameList: [] }],
		});
		await rest('PUT', 'fairplay_reports/20261118T000000Z', report('20261118T000000Z', 'review'));
		await rest('PUT', 'fairplay_reports/20261119T000000Z', report('20261119T000000Z', 'strong'));
		await pr.click('[data-testid="tab-scan"]');
		await waitIn(pr, () => document.querySelectorAll('[data-testid="scan-card"]').length === 1);
		const scan = await text(pr, '[data-testid="scan-report"]');
		check('the latest scan report, flagged players only, with the interval and the peers', /Report 20261119T000000Z \(database\)/.test(scan)
			&& /strong Bob/.test(scan) && /Engine match 81% \[74%, 87%\] · peers \(9 within 150\): mean 41%, 95th pct 52% · z 5.71/.test(scan)
			&& /Average loss 6\.2 \[3\.9, 8\.8\] centistones/.test(scan) && !/Carol rating/.test(scan) && /FPR010/.test(scan), scan);
		await shot(pr, 'admin-scan');
		check('scan view fits a phone', await noHScroll(pr));
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-')), 'fp_report.json');
		fs.writeFileSync(file, JSON.stringify(report('20261120T000000Z', 'review')));
		const input = await pr.$('[data-testid="scan-file"]');
		await input.uploadFile(file);
		await waitIn(pr, () => /fp_report\.json/.test((document.querySelector('[data-testid="scan-report"]') || {}).textContent || ''));
		check('a report file opens in the browser', /Report 20261120T000000Z \(fp_report\.json\)/.test(await text(pr, '[data-testid="scan-report"]')));
		check('no page errors', errors.length === 0, errors);
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'FAIR PLAY APPEALS TEST OK' : 'FAIR PLAY APPEALS TEST FAILED');
	process.exit(ok ? 0 : 1);
})();

function waitIn(page, fn, ...args) {
	return page.waitForFunction(fn, { timeout: 30000, polling: 250 }, ...args);
}
