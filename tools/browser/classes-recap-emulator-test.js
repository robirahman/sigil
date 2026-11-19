// Classes (classes.html) and the year recap (recap.html) on the Firebase
// emulators, under the real database rules.
//   Classes: a teacher creates a class and three kinds of assignment; two
//   students join by code after the consent page; a student sees the
//   assignments with their own progress and marks one done; students cannot
//   read each other or the roster; the teacher's table shows each student's
//   rating, games, puzzle rating, solves and assignment status; a removed
//   student's page says the class is closed to them.
//   Recap: a student's year from seeded user_games, rooms and puzzle records:
//   the counts, the rating tile and chart, the best win, the most cast spell,
//   puzzles, the share text, and the year switcher.
//
//   (cd docs && python3 -m http.server 8810) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/classes-recap-emulator-test.js http://localhost:8810'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8810';
const NS = 'sigil-js-default-rtdb';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const DB = 'http://' + DB_HOST;
const OWNER = { Authorization: 'Bearer owner' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
	window.confirm = () => true;
	// navigator.share would open a sheet: the page falls back to copying.
	try { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); } catch (e) { /* ignore */ }
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

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const stamp = Date.now();
	const mail = (n) => `${n}${stamp}@example.com`;
	const tess = await signUp(mail('tess'));
	const sam = await signUp(mail('sam'));
	const sue = await signUp(mail('sue'));

	// Seed the players' public records.
	const now = Date.now();
	const year = new Date().getFullYear();
	const DAY = 86400000;
	const inYear = (k) => Math.max(new Date(year, 0, 1).getTime() + 3600000, now - k * DAY);
	const P1 = '-OpR7rVvVhnRGqacO-p9-t16', P2 = 'p-two', P3 = 'p-three';
	const spells = ['Fireblast', 'Flourish', 'Carnage', 'Hail_Storm', 'Meteor', 'Seal_of_Lightning', 'Seal_of_Summer', 'Sprout', 'Slash'];
	const g = (k, opts) => Object.assign({ timestamp: inYear(k), color: 'red', result: 'win', rated: true, opponent: 'Ann', opponentUid: 'ann_uid' }, opts);
	const samGames = {
		g1: g(40, { roomCode: 'RECAP1', eloBefore: 1000, eloAfter: 1016, eloChange: 16, opponentEloBefore: 1100 }),
		g2: g(20, { roomCode: 'RECAP2', result: 'loss', color: 'blue', eloBefore: 1016, eloAfter: 1001, eloChange: -15, opponentEloBefore: 1050 }),
		g3: g(5, { roomCode: 'RECAP3', eloBefore: 1001, eloAfter: 1030, eloChange: 29, opponentEloBefore: 1450, opponent: 'Zed', opponentUid: 'zed_uid' }),
		g0: { timestamp: new Date(year - 1, 5, 1).getTime(), color: 'red', result: 'win', rated: true, opponent: 'Old', eloBefore: 990, eloAfter: 1000, roomCode: 'RECAP0' },
	};
	const recent = Object.values(samGames).filter((x) => x.timestamp >= now - 30 * DAY).length;
	const room = (turns) => ({ status: 'finished', spellNames: spells, turns, variant: 'standard' });
	await rest('PATCH', '', {
		['users/' + tess]: { displayName: 'Tess', elo: 1200, gamesPlayed: 50, wins: 25, losses: 25, created: 1 },
		['users/' + sam]: {
			displayName: 'Sam', elo: 1030, gamesPlayed: 4, wins: 3, losses: 1, created: 1,
			puzzle: { rating: 1540, plays: 2, last: P1 },
			puzzleAttempts: { [P1]: { solved: true, at: inYear(10), delta: 25 }, [P3]: { solved: false, at: inYear(9), delta: -10 } },
			puzzleProgress: { solved: { [P1]: inYear(10) }, results: { [P1]: { r: 's', at: inYear(10) }, [P3]: { r: 'f', at: inYear(9) } } },
		},
		['users/' + sue]: { displayName: 'Sue', elo: 1111, gamesPlayed: 0, wins: 0, losses: 0, created: 1 },
		['user_games/' + sam]: samGames,
		'rooms/RECAP1': room({ t1: { color: 'red', actions: ['a2', 'Fireblast', 'pass'], timestamp: 1 }, t2: { color: 'blue', actions: ['b2', 'pass'], timestamp: 2 } }),
		// Sam is blue here: red's cast is not his.
		'rooms/RECAP2': room({ t1: { color: 'red', actions: ['a2', 'Fireblast', 'pass'], timestamp: 1 }, t2: { color: 'blue', actions: ['b2', 'pass'], timestamp: 2 } }),
		'rooms/RECAP3': room({ t1: { color: 'red', actions: ['a2', 'Sprout', 'pass'], timestamp: 1 } }),
	});

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && !!cond; };
	const newPage = async () => {
		const ctx = await browser.createBrowserContext();
		const p = await ctx.newPage();
		await p.setViewport({ width: 1200, height: 900 });
		await p.evaluateOnNewDocument(useEmulators, DB_HOST, AUTH_HOST);
		await p.setBypassServiceWorker(true);
		await p.setRequestInterception(true);
		p.on('request', (req) => {
			const url = req.url();
			if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		p.on('pageerror', (e) => console.log('pageerror:', e.message));
		return p;
	};
	const SEL = '[x-data="classesPage()"]';
	const data = (p, expr) => p.evaluate((sel, e) => { const d = Alpine.$data(document.querySelector(sel)); return (new Function('d', 'return ' + e))(d); }, SEL, expr);
	const waitData = async (p, expr, ms, what) => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			if (await data(p, expr).catch(() => false)) return;
			await sleep(250);
		}
		throw new Error('timed out waiting for ' + what);
	};
	// The elements wider than the window (for a failed fit check).
	const overflow = (p) => p.evaluate(() => Array.from(document.querySelectorAll('body *'))
		.filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest('.table-wrap'))
		.slice(0, 6).map((el) => el.tagName + '.' + el.className + ' ' + Math.round(el.getBoundingClientRect().right)));
	const open = async (p, url, email) => {
		await p.goto(`${BASE}/classes.html`, { waitUntil: 'load', timeout: 90000 });
		await p.waitForFunction(() => window.firebase && firebase.apps.length && window.Alpine, { timeout: 30000 });
		if (email) await p.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), email);
		await p.goto(`${BASE}/${url}`, { waitUntil: 'load', timeout: 90000 });
		await waitData(p, 'd.ready', 30000, url + ' to load');
	};

	try {
		// ---- The teacher creates a class and assignments.
		const pT = await newPage();
		await open(pT, 'classes.html', mail('tess'));
		await pT.type('.new-class-name', 'Tuesday club');
		await Promise.all([pT.waitForNavigation({ timeout: 30000 }), pT.click('.new-class-create')]);
		const cid = new URL(pT.url()).searchParams.get('id');
		await waitData(pT, 'd.ready && d.isTeacher && d.code', 30000, 'the class page');
		const code = await data(pT, 'd.code');
		check('the teacher creates a class with a join code', !!cid && /^[A-Z0-9]{6}$/.test(code), { cid, code });
		const addAssignment = async (fields) => {
			await pT.evaluate((sel, f) => { const d = Alpine.$data(document.querySelector(sel)); Object.assign(d.draft, f); }, SEL, fields);
			await data(pT, 'd.createAssignment()');
			await sleep(300);
			return data(pT, 'd.draftError');
		};
		check('a puzzles assignment from pasted links', (await addAssignment({ kind: 'puzzles', title: 'Mates', puzzleText: `puzzles.html?id=${P1}\n${P2}` })) === '');
		check('a page of the site', (await addAssignment({ kind: 'link', title: 'Tutorial', linkText: 'tutorial.html' })) === '');
		check('a study by its link', (await addAssignment({ kind: 'study', title: 'Read the study', studyText: 'https://example.org/analysis.html?study=-Pstudy1' })) === '');
		check('an outside link is refused', /page of this site/.test(await addAssignment({ kind: 'link', title: 'Off', linkText: 'https://evil.example/x.html' })));
		const stored = await rest('GET', 'classes/' + cid + '/assignments');
		check('three assignments stored', Object.keys(stored).length === 3, Object.values(stored).map((a) => a.kind));

		// ---- Students join with the code, after the consent page.
		const pS = await newPage();
		await open(pS, 'classes.html?join=' + code, mail('sam'));
		const consent = await pS.$eval('.consent', (el) => el.textContent.replace(/\s+/g, ' '));
		check('the join page names the class and what the teacher will see', /Tuesday club/.test(consent) && /Tess/.test(consent) && /puzzle/.test(consent) && /Other students cannot see you/.test(consent));
		await Promise.all([pS.waitForNavigation({ timeout: 30000 }), pS.click('.join-confirm')]);
		await waitData(pS, 'd.ready && d.info && !d.isTeacher', 30000, 'Sam\'s class page');
		const sStat = await data(pS, 'd.assignments.map((a) => a.kind + ":" + d.myStatus(a).text)');
		check('the student sees the assignments with their own progress', sStat.includes('puzzles:1/2') && sStat.includes('link:—'), sStat);
		const link = await pS.$$eval('.assignment[data-assignment] .puzzle-links a', (els) => els.map((a) => a.getAttribute('href') + (a.classList.contains('solved') ? ' solved' : '')));
		check('puzzle links open each puzzle, solved ones marked', link[0] === 'puzzles.html?id=' + encodeURIComponent(P1) + ' solved' && link[1] === 'puzzles.html?id=' + P2, link);
		await pS.evaluate((sel) => { const d = Alpine.$data(document.querySelector(sel)); return d.markDone(d.assignments.find((a) => a.kind === 'link')); }, SEL);
		check('marking a page done is stored', typeof (await rest('GET', 'classes/' + cid + '/done/' + Object.keys(stored).find((k) => stored[k].kind === 'link') + '/' + sam)) === 'number');

		const pU = await newPage();
		await open(pU, 'classes.html?join=' + code, mail('sue'));
		await Promise.all([pU.waitForNavigation({ timeout: 30000 }), pU.click('.join-confirm')]);
		await waitData(pU, 'd.ready && d.info', 30000, 'Sue\'s class page');
		const peek = await pU.evaluate(async (c, s) => {
			const out = {};
			for (const [k, p] of Object.entries({ roster: 'classes/' + c + '/members', sam: 'classes/' + c + '/members/' + s, code: 'classes/' + c + '/code', samDone: 'classes/' + c + '/done' })) {
				try { await firebase.database().ref(p).once('value'); out[k] = 'read'; } catch (e) { out[k] = 'denied'; }
			}
			return out;
		}, cid, sam);
		check('a student cannot read the roster, another student, the code or the marks', Object.values(peek).every((v) => v === 'denied'), peek);
		const sueList = await pU.evaluate(async () => (await firebase.database().ref('user_classes/' + firebase.auth().currentUser.uid).once('value')).val());
		check('the class is on the student\'s list', sueList && sueList[cid] && sueList[cid].role === 'student');

		// ---- The teacher's table.
		await pT.reload({ waitUntil: 'load' });
		await waitData(pT, 'd.ready && d.students.length === 2 && d.students.every((s) => s.recent !== null)', 30000, 'the roster with progress');
		const rows = await pT.$$eval('table.progress tbody tr', (trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())));
		const samRow = rows.find((r) => r[0] === 'Sam');
		check('the teacher sees Sam\'s rating, games, recent games, puzzle rating and solves', samRow && samRow[1] === '1030' && samRow[2] === '4'
			&& samRow[3] === String(recent) && samRow[4] === '1540' && samRow[5] === '1', samRow);
		const heads = await pT.$$eval('table.progress thead th', (ths) => ths.map((t) => t.textContent.trim()));
		const col = (title) => heads.indexOf(title);
		check('and his assignment statuses', samRow[col('Mates')] === '1/2' && samRow[col('Tutorial')] === 'Done' && samRow[col('Read the study')] === '—', { heads, samRow });
		await pT.evaluate((sel) => { const d = Alpine.$data(document.querySelector(sel)); return d.removeStudent(d.students.find((s) => s.name === 'Sue')); }, SEL);
		check('the teacher removes a student', !(await rest('GET', 'classes/' + cid + '/members/' + sue)));
		await pU.reload({ waitUntil: 'load' });
		await waitData(pU, 'd.ready && d.gone', 20000, 'Sue to see the class closed to her');
		check('the removed student is told, and the class leaves her list', !(await rest('GET', 'user_classes/' + sue + '/' + cid)));
		await pT.setViewport({ width: 375, height: 800 });
		check('the teacher page fits a phone (the table scrolls in its box)', !(await pT.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), await overflow(pT));

		// ---- The recap.
		await pS.goto(`${BASE}/recap.html`, { waitUntil: 'load', timeout: 90000 });
		const RSEL = '[x-data="recapPage()"]';
		await pS.waitForFunction((sel) => { const el = document.querySelector(sel); const d = el && Alpine.$data(el); return d && d.status === 'ready' && !d.metaLoading && d.r.mostCast.length; }, { timeout: 30000, polling: 250 }, RSEL);
		const r = await pS.evaluate((sel) => JSON.parse(JSON.stringify(Alpine.$data(document.querySelector(sel)).r)), RSEL);
		check('the recap counts the year\'s games only', r.games === 3 && r.wins === 2 && r.winRate === 67, { games: r.games, wins: r.wins });
		check('the rating line runs from the year\'s first rated game', r.rating && r.rating.start === 1000 && r.rating.end === 1030 && r.rating.peak === 1030, r.rating);
		check('the best win is over the highest-rated opponent', r.bestWin && r.bestWin.opponent === 'Zed' && r.bestWin.oppElo === 1450, r.bestWin);
		check('casts are Sam\'s own', r.mostCast[0].name === 'Fireblast' && r.mostCast[0].casts === 1 && r.mostCast.some((s) => s.name === 'Sprout'), r.mostCast);
		check('puzzles of the year', r.puzzles.solved === 1 && r.puzzles.tried === 2 && r.puzzles.firstTry === 1 && r.puzzles.ratingEnd === 1540 && r.puzzles.ratingStart === 1525, r.puzzles);
		const title = await pS.$eval('.recap h2', (el) => el.textContent);
		check('the page is titled for the player and year', title === 'Sam\'s ' + year + ' in Sigil', title);
		check('the rating chart is drawn', await pS.$eval('.recap-chart polyline', (el) => el.getAttribute('points').split(' ').length === 4).catch(() => false));
		await pS.click('.recap-share');
		const text = await pS.$eval('.share-text', (el) => el.value || el.textContent);
		check('the share text sums it up with a link', /3 games, 2 wins \(67%\)/.test(text) && /Rating 1000 → 1030/.test(text) && /recap\.html\?uid=/.test(text), text);
		const years = await pS.$$eval('.recap__years a', (els) => els.map((a) => a.textContent));
		check('earlier years can be opened', years.includes(String(year - 1)), years);
		await pS.goto(`${BASE}/recap.html?uid=${sam}&year=${year - 1}`, { waitUntil: 'load', timeout: 90000 });
		await pS.waitForFunction((sel) => { const d = Alpine.$data(document.querySelector(sel)); return d && d.status === 'ready'; }, { timeout: 30000, polling: 250 }, RSEL);
		check('last year holds last year\'s game', await pS.evaluate((sel) => Alpine.$data(document.querySelector(sel)).r.games === 1, RSEL));
		await pS.setViewport({ width: 375, height: 800 });
		check('the recap fits a phone', !(await pS.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), await overflow(pS));
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'CLASSES RECAP EMULATOR TEST OK' : 'CLASSES RECAP EMULATOR TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
