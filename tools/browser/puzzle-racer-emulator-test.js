// Puzzle Racer on the Firebase emulators (auth, database and functions: the
// puzzleRace callable runs for real), with three scripted browser racers --
// a signed-in host and two guests -- and a spectator:
//   1. The host opens a public race from the Racer lobby; a guest finds it
//      under Open races and joins; another opens its link and is joined.
//      Names come from the server ("Guest XXXX"); only the host may start.
//   2. Nothing can be written early: no progress, no peek at the puzzles,
//      no race fields, no lobby rows.
//   3. The start: a countdown on every page, then the SAME first puzzle on
//      every board, by the server's clock. Racers solve on the board
//      (clicks) or through the page's result hook, skip, and every page's
//      track follows everyone's cars. Forged progress (two at once, someone
//      else's car, a score with no puzzle) is refused.
//   4. The clock runs out for everyone at once: no writes after, the same
//      results on every page, the winner first; a rematch opens a new race
//      that the others join from the results.
//   5. Leaving and closing the tab (onDisconnect sets `gone`), a private
//      race stays off the lobby list, and the sweep clears stale lobbies
//      and old races (the page then says the race is gone).
//
//   cd functions && SIGIL_RACER_MS=90000 SIGIL_RACER_COUNTDOWN_MS=5000 SIGIL_RACER_POOL=/tmp/racer-pool.json \
//     firebase emulators:exec --only auth,database,functions --project demo-sigil \
//     'node ../tools/browser/puzzle-racer-emulator-test.js ../docs 8811'
// SIGIL_RACER_MS / SIGIL_RACER_COUNTDOWN_MS shorten the race (emulator only);
// SIGIL_RACER_POOL, when set, is written here with click-solvable mate-in-1
// puzzles for the race to pick from. Other emulator ports: RACER_FUNCTIONS_PORT.
// RACER_SHOTS=<dir> saves phone-width screenshots. Exits 1 on any failure.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const DOCS = path.resolve(process.argv[2] || 'docs');
const PORT = Number(process.argv[3] || 8811);
const BASE = `http://127.0.0.1:${PORT}`;
const NS = 'sigil-js-default-rtdb';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const EMU = { db: DB_HOST, auth: AUTH_HOST, fn: Number(process.env.RACER_FUNCTIONS_PORT || process.env.FUNCTIONS_EMULATOR_PORT || 5001),
	project: process.env.GCLOUD_PROJECT || 'demo-sigil' };
const DB = 'http://' + DB_HOST;
const OWNER = { Authorization: 'Bearer owner' };
const SHOTS = process.env.RACER_SHOTS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra) => {
	console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra === undefined || cond ? '' : ' ' + JSON.stringify(extra).slice(0, 400)));
	if (!cond) failures++;
};
async function until(fn, ms) {
	const t0 = Date.now();
	let v;
	while (Date.now() - t0 < (ms || 30000)) {
		v = await fn();
		if (v) return v;
		await sleep(250);
	}
	return v;
}
async function rest(method, p, body) {
	const r = await fetch(`${DB}/${p}.json?ns=${NS}`, { method, headers: OWNER, body: body === undefined ? undefined : JSON.stringify(body) });
	if (!r.ok) throw new Error(method + ' ' + p + ': ' + r.status + ' ' + await r.text());
	return r.json();
}

// Point the page's Firebase at the emulators as soon as the app exists.
function useEmulators(emu) {
	let fb;
	Object.defineProperty(window, 'firebase', {
		configurable: true,
		get() { return fb; },
		set(v) {
			fb = v;
			const init = v.initializeApp.bind(v);
			v.initializeApp = (cfg, ...rest) => {
				const app = init(Object.assign({}, cfg, { projectId: emu.project }), ...rest);
				const [dbHost, dbPort] = emu.db.split(':');
				app.auth().useEmulator('http://' + emu.auth, { disableWarnings: true });
				app.database().useEmulator(dbHost, Number(dbPort));
				if (typeof app.functions === 'function') app.functions().useEmulator('127.0.0.1', emu.fn);
				return app;
			};
		},
	});
	if (navigator.serviceWorker) navigator.serviceWorker.getRegistration = () => Promise.resolve(undefined);
}
const _sdk = new Map();
async function sdk(url) {
	for (let i = 0; !_sdk.has(url) && i < 5; i++) {
		try { const r = await fetch(url); if (r.ok) _sdk.set(url, await r.text()); } catch (e) { /* retry */ }
	}
	if (!_sdk.has(url)) throw new Error('could not fetch ' + url);
	return _sdk.get(url);
}

// Click-solvable puzzles: mate in 1 with one plain move (as puzzle-storm-test.js).
const SET = JSON.parse(fs.readFileSync(path.join(DOCS, 'static/puzzles/mate_puzzles.json'), 'utf8'));
const BY_ID = Object.fromEntries(SET.puzzles.map((p) => [p.id, p]));
const plain = (a) => a && (a.type === 'move' || a.type === 'blink' || (a.type === 'hard_move' && !a.pushed_to));
const clickable = (p) => p && p.mate === 1 && p.solutions.length
	&& p.solutions[0].actions.filter((a) => a.type !== 'pass').length === 1 && plain(p.solutions[0].actions[0]);
if (process.env.SIGIL_RACER_POOL) {
	const pool = SET.puzzles.filter(clickable).map((p) => ({ id: p.id, rating: p.rating || 1500 }));
	fs.writeFileSync(process.env.SIGIL_RACER_POOL, JSON.stringify(pool));
	console.log('race pool: ' + pool.length + ' click-solvable puzzles');
}

(async () => {
	const rules = fs.readFileSync(path.join(DOCS, '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());
	const srv = spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS], { stdio: 'ignore' });
	await new Promise((res, rej) => { const t0 = Date.now(); (function tick() {
		http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (r) => { r.resume(); res(); })
			.on('error', () => (Date.now() - t0 > 15000 ? rej(new Error('server')) : setTimeout(tick, 200))); })(); });
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	const errors = [];
	if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
	const shot = async (pg, name) => { if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); };
	const newPage = async (label, sameAs) => {
		const ctx = sameAs ? sameAs.browserContext() : await browser.createBrowserContext();
		const p = await ctx.newPage();
		await p.setViewport({ width: 412, height: 915 });
		await p.evaluateOnNewDocument(useEmulators, EMU);
		await p.setBypassServiceWorker(true);
		await p.setRequestInterception(true);
		p.on('request', (req) => {
			const url = req.url();
			if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		p.on('pageerror', (e) => errors.push(label + ': ' + e.message));
		p.label = label;
		return p;
	};
	const open = async (p, q) => {
		await p.goto(`${BASE}/puzzles.html${q}`, { waitUntil: 'load', timeout: 90000 });
		await p.waitForFunction(() => !!window.SIGIL_RACER, { timeout: 60000, polling: 250 });
	};
	const text = (p) => p.evaluate(() => document.getElementById('racer-root').innerText);
	const R = (p) => p.evaluate(() => {
		const r = window.SIGIL_RACER;
		const run = r.run;
		return { id: r.id, uid: r.uid, phase: r.phase, msg: r.msg, cur: run && run.current && run.current.id, i: run ? run.i : null,
			score: run ? run.score : null, over: run ? run.over : null, resolved: run ? run.resolved : null };
	});
	const noHScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
	const clickRacer = (p, action) => p.evaluate((a) => { const b = document.querySelector('[data-racer="' + a + '"]'); if (!b) return false; b.click(); return true; }, action);
	const race = (id) => rest('GET', 'puzzle_races/' + id);
	// A forged write from the page's own client (its signed-in uid).
	const tryWrite = (p, pathName, value) => p.evaluate((pp, v) => firebase.database().ref(pp).set(v).then(() => 'ok', (e) => 'denied'), pathName, value);
	const tryRead = (p, pathName) => p.evaluate((pp) => firebase.database().ref(pp).once('value').then((s) => 'ok', (e) => 'denied'), pathName);

	try {
		// ---- 1. Opening and joining ----
		const email = `racer${Date.now()}@example.com`;
		const su = await (await fetch('http://' + AUTH_HOST + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }),
		})).json();
		const aliceUid = su.localId;
		if (!aliceUid) throw new Error('sign-up failed: ' + JSON.stringify(su));
		await rest('PUT', 'users/' + aliceUid, { displayName: 'Alice', elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: 1 });
		const pa = await newPage('alice');
		await open(pa, '?tab=racer');
		await pa.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), email);
		await open(pa, '?tab=racer');
		let t = await text(pa);
		check('the Racer lobby explains the race and offers both kinds', /Puzzle Racer/.test(t) && /Open a public race/.test(t) && /Private race/.test(t) && /Open races/.test(t), t.slice(0, 300));
		check('a signed-in racer is not told to sign in', !/race as a guest/.test(t));
		const tabActive = await pa.evaluate(() => document.querySelector('#puzzle-tabs a.is-active').textContent);
		check('the Puzzle Racer tab is active', tabActive === 'Puzzle Racer', tabActive);
		await shot(pa, '1-lobby');
		await clickRacer(pa, 'create-public');
		await pa.waitForFunction(() => /[?&]race=/.test(location.search), { timeout: 30000 });
		await pa.waitForFunction(() => window.SIGIL_RACER && window.SIGIL_RACER.phase === 'lobby', { timeout: 30000, polling: 250 });
		const id = (await R(pa)).id;
		let r = await race(id);
		check('the race is the server\'s: host, public, in its lobby, Alice by her account name',
			r && r.host === aliceUid && r.public === true && r.status === 'lobby' && r.players[aliceUid].name === 'Alice' && !r.startAt, r);
		const lobbyRow = await rest('GET', 'puzzle_race_lobby/' + id);
		check('it is listed under Open races', lobbyRow && lobbyRow.hostName === 'Alice' && lobbyRow.n === 1, lobbyRow);
		t = await text(pa);
		check('the host sees the link and waits for a second racer', /Invite others/.test(t) && /Waiting for at least one more racer/.test(t) && !/Start the race/.test(t), t);

		// A guest finds it in the list.
		const pb = await newPage('guest-b');
		await open(pb, '?tab=racer');
		t = await text(pb);
		check('a guest is told they race as a guest', /race as a guest/.test(t), t.slice(0, 300));
		await pb.waitForFunction((rid) => !!document.querySelector('.racer-race[data-race="' + rid + '"] a'), { timeout: 20000, polling: 250 }, id);
		t = await text(pb);
		check('the open race shows its host and racers', /Alice’s race/.test(t) && /1 of 10 racers/.test(t), t);
		await shot(pb, '2-open-races');
		await pb.click('.racer-race[data-race="' + id + '"] a');
		await pb.waitForFunction(() => window.SIGIL_RACER && window.SIGIL_RACER.phase === 'lobby' && window.SIGIL_RACER.uid, { timeout: 30000, polling: 250 });
		const bUid = (await R(pb)).uid;
		r = await until(async () => { const x = await race(id); return x && x.players && x.players[bUid] ? x : null; }, 20000);
		check('opening a race joins it, as "Guest XXXX"', r && /^Guest [A-Z0-9]{4}$/.test(r.players[bUid].name) && r.players[bUid].guest === true, r && r.players);
		// Another guest opens the link.
		const pc = await newPage('guest-c');
		await open(pc, '?tab=racer&race=' + encodeURIComponent(id));
		const cUid = (await until(async () => { const s = await R(pc); return s.uid ? s : null; }, 20000)).uid;
		r = await until(async () => { const x = await race(id); return x && x.players && x.players[cUid] ? x : null; }, 20000);
		check('the link joins a third racer', r && Object.keys(r.players).length === 3, r && r.players);
		check('the lobby row counts them', (await until(async () => { const x = await rest('GET', 'puzzle_race_lobby/' + id); return x && x.n === 3 ? x : null; }, 10000)) !== null);
		await pa.waitForFunction(() => /Start the race/.test(document.getElementById('racer-root').innerText), { timeout: 15000, polling: 250 }).catch(() => {});
		t = await text(pa);
		check('the host now can start; everyone is listed', /Start the race/.test(t) && /3 of 10 racers/.test(t) && /Guest /.test(t), t);
		t = await text(pb);
		check('a guest waits for the host', /Waiting for Alice to start the race/.test(t) && !/Start the race/.test(t), t);
		check('race lobby: no horizontal scroll at phone width', await noHScroll(pb));
		await shot(pb, '3-race-lobby');
		const notHost = await pb.evaluate((rid) => firebase.functions().httpsCallable('puzzleRace')({ action: 'start', id: rid }).then(() => 'started', (e) => e.message), id);
		check('only the host starts the race', notHost === 'not-host', notHost);

		// ---- 2. Nothing early ----
		check('no progress before the start', await tryWrite(pb, `puzzle_races/${id}/players/${bUid}/p`, { n: 1, score: 1, at: { '.sv': 'timestamp' }, st: { '.sv': 'timestamp' } }) === 'denied');
		check('no race fields from a client', await tryWrite(pb, `puzzle_races/${id}/status`, 'racing') === 'denied'
			&& await tryWrite(pb, `puzzle_races/${id}/players/${bUid}/name`, 'Alice') === 'denied');
		check('no sequence or lobby rows from a client', await tryWrite(pb, `puzzle_race_seq/${id}`, ['x']) === 'denied'
			&& await tryWrite(pb, `puzzle_race_lobby/fake`, { hostName: 'x', n: 1, max: 10, createdAt: 1 }) === 'denied');

		// ---- 3. The race ----
		const watcher = await newPage('spectator');
		await clickRacer(pa, 'start');
		r = await until(async () => { const x = await race(id); return x && x.status === 'racing' ? x : null; }, 30000);
		check('the start is the server\'s: a countdown, the clock, the length', r && r.startAt > Date.now() - 2000 && r.endAt > r.startAt && r.len === 60, r && { startAt: r.startAt, endAt: r.endAt, len: r.len });
		check('it is off the lobby list', (await rest('GET', 'puzzle_race_lobby/' + id)) === null);
		await pb.waitForFunction(() => window.SIGIL_RACER.phase === 'countdown', { timeout: 10000, polling: 100 }).catch(() => {});
		t = await text(pb);
		check('every racer sees the countdown', /The race starts in \d/.test(t), t);
		check('the puzzles stay hidden during the countdown', Date.now() < r.startAt - 500 ? await tryRead(pb, 'puzzle_race_seq/' + id) === 'denied' : true);
		await shot(pb, '4-countdown');
		await pb.waitForFunction(() => window.SIGIL_RACER.phase !== 'countdown' || !!window.SIGIL_PUZZLE_BOARD, { timeout: 20000, polling: 100 }).catch(() => {});
		const warm = await pb.evaluate(() => ({ phase: window.SIGIL_RACER.phase, board: !!window.SIGIL_PUZZLE_BOARD,
			hidden: getComputedStyle(document.getElementById('puzzle-root')).visibility === 'hidden' }));
		check('the board starts up out of sight during the countdown', warm.phase !== 'countdown' || (warm.board && warm.hidden), warm);
		await open(watcher, '?tab=racer&race=' + encodeURIComponent(id));
		const racers = [pa, pb, pc];
		for (const p of racers) {
			await p.waitForFunction(() => { const r = window.SIGIL_RACER; return r.phase === 'racing' && r.run && r.run.current && window.SIGIL_PUZZLE_BOARD; },
				{ timeout: 60000, polling: 250 }).catch(() => {});
		}
		const since = () => ((Date.now() - r.startAt) / 1000).toFixed(1) + ' s into the race';
		console.log('  boards up ' + since());
		const firsts = await Promise.all(racers.map(async (p) => (await R(p)).cur));
		const seq = await rest('GET', 'puzzle_race_seq/' + id);
		check('every board opens on the same first puzzle, the sequence\'s', firsts[0] && firsts.every((f) => f === firsts[0]) && seq && seq[0] === firsts[0], { firsts, seq0: seq && seq[0] });
		check('the puzzles are readable from the start', await tryRead(pb, 'puzzle_race_seq/' + id) === 'ok');
		const tw = await text(watcher);
		check('someone who is not in the race watches it', /Race in progress/.test(tw) && /You are watching/.test(tw), tw);

		const boardState = (p) => p.evaluate(() => {
			const d = window.Alpine.$data(document.querySelector('#puzzle-root [x-data]'));
			const run = window.SIGIL_RACER.run;
			return { id: d.puzzle.id, cur: run.current && run.current.id, status: d.puzzleStatus, valid: Object.keys(d.validMoves || {}),
				actions: Object.values(d.actionList || {}), score: run.score, i: run.i, resolved: run.resolved };
		});
		const waitBoard = async (p, pred, ms) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await boardState(p); if (pred(s)) return s; await sleep(250); } return s; };
		// Alice solves two on the board (clicks), or through the hook when a puzzle is not a one-click mate.
		let clicked = 0;
		for (let k = 0; k < 2; k++) {
			let s = await waitBoard(pa, (x) => x.id === x.cur && x.status === 'playing' && x.valid.length > 0 && !x.resolved, 30000);
			const pz = BY_ID[s.cur];
			if (clickable(pz)) {
				await pa.click(`#stone-node--${pz.solutions[0].actions[0].node}`);
				await sleep(500);
				s = await boardState(pa);
				if (s.actions.includes('pass')) await pa.click('.action-button--end-turn');
				clicked += 1;
			} else {
				await pa.evaluate(() => window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_RACER.run.current, 'solved'));
			}
			s = await waitBoard(pa, (x) => x.score === k + 1, 30000);
			check(`Alice solves puzzle ${k + 1} on the board (${s.cur}, ${since()})`, s.score === k + 1, Object.assign(s, { phase: (await R(pa)).phase }));
		}
		check('the solves were board clicks', clicked === 2 || !process.env.SIGIL_RACER_POOL, clicked);
		// B solves one and skips one; C solves three.
		const hookSolve = async (p) => {
			await waitBoard(p, (x) => x.id === x.cur && !x.resolved, 20000);
			await p.evaluate(() => window.SIGIL_PUZZLE_ON_RESULT(window.SIGIL_RACER.run.current, 'solved'));
			await sleep(800);
		};
		await hookSolve(pb);
		await waitBoard(pb, (x) => x.id === x.cur && !x.resolved && x.i === 1, 20000);
		await pb.click('#storm-skip');
		for (let k = 0; k < 3; k++) await hookSolve(pc);
		console.log('  solves done ' + since());
		const prog = await until(async () => {
			const x = await race(id);
			const p = (u) => x.players[u].p;
			return p(aliceUid).score === 2 && p(bUid).n === 2 && p(bUid).score === 1 && p(cUid).score === 3 ? x : null;
		}, 20000);
		check('the progress is on the server: Alice 2/2, B 1/2, C 3/3', !!prog, prog && Object.values(prog.players).map((v) => v.p));
		// Everyone's track follows everyone.
		const lanes = (p) => p.evaluate(() => Array.from(document.querySelectorAll('#racer-track .racer-lane')).map((l) => ({
			uid: l.dataset.uid, me: l.classList.contains('is-me'), car: l.querySelector('.racer-car').textContent, left: l.querySelector('.racer-car').style.left })));
		const want = { [aliceUid]: '2', [bUid]: '1', [cUid]: '3' };
		for (const p of [pa, pb, pc, watcher]) {
			const ls = await until(async () => { const x = await lanes(p); return x.length === 3 && x.every((l) => want[l.uid] === l.car) ? x : null; }, 15000);
			check(`${p.label}'s track shows every car where it is`, !!ls, await lanes(p));
		}
		const la = await lanes(pa);
		check('the lanes keep the join order and mark the viewer', la[0].uid === aliceUid && la[0].me && !la[1].me && parseFloat(la[2].left) > parseFloat(la[0].left), la);
		const bar = await pa.evaluate(() => ({ time: document.getElementById('storm-time').textContent, score: document.getElementById('storm-score').textContent,
			place: document.getElementById('storm-combo').textContent, end: getComputedStyle(document.getElementById('storm-end')).display }));
		check('the bar: the race clock, my score and place, no "End run"', /^\d:\d\d$/.test(bar.time) && bar.score === '2' && /^2nd of 3/.test(bar.place) && bar.end === 'none', bar);
		check('racing: no horizontal scroll at phone width', await noHScroll(pa));
		await shot(pa, '5-racing');
		// Forged progress.
		const bp = (await race(id)).players[bUid].p;
		await sleep(600);
		check('two puzzles in one write are refused', await tryWrite(pb, `puzzle_races/${id}/players/${bUid}/p`, { n: bp.n + 2, score: bp.score + 2, at: { '.sv': 'timestamp' }, st: { '.sv': 'timestamp' } }) === 'denied');
		check('a point without a puzzle is refused', await tryWrite(pb, `puzzle_races/${id}/players/${bUid}/p`, { n: bp.n, score: bp.score + 1, at: { '.sv': 'timestamp' }, st: { '.sv': 'timestamp' } }) === 'denied');
		check('someone else\'s car is refused', await tryWrite(pb, `puzzle_races/${id}/players/${cUid}/p`, { n: 4, score: 4, at: { '.sv': 'timestamp' }, st: { '.sv': 'timestamp' } }) === 'denied');
		check('a back-dated write is refused', await tryWrite(pb, `puzzle_races/${id}/players/${bUid}/p`, { n: bp.n + 1, score: bp.score + 1, at: 5, st: 5 }) === 'denied');
		check('the watcher has no car to move', await tryWrite(watcher, `puzzle_races/${id}/players/x/p`, { n: 1, score: 1, at: { '.sv': 'timestamp' }, st: { '.sv': 'timestamp' } }) === 'denied');

		// ---- 4. The end ----
		const endAt = (await race(id)).endAt;
		await sleep(Math.max(0, endAt - Date.now() + 500));
		for (const p of [...racers, watcher]) await p.waitForFunction(() => window.SIGIL_RACER.phase === 'done', { timeout: 15000, polling: 250 }).catch(() => {});
		const late = await tryWrite(pc, `puzzle_races/${id}/players/${cUid}/p`, { n: 4, score: 4, at: { '.sv': 'timestamp' }, st: { '.sv': 'timestamp' } });
		await sleep(3500);
		const late2 = await tryWrite(pc, `puzzle_races/${id}/players/${cUid}/p`, { n: 4, score: 4, at: { '.sv': 'timestamp' }, st: { '.sv': 'timestamp' } });
		check('no progress after the clock (and its 3 s grace)', late2 === 'denied', { late, late2 });
		r = await race(id);
		const fin = (u) => r.players[u].p;
		check('the final scores stand', fin(cUid).score === (late === 'ok' ? 4 : 3) && fin(aliceUid).score === 2 && fin(bUid).score === 1, Object.values(r.players).map((v) => v.p));
		for (const p of [...racers, watcher]) await p.waitForFunction(() => /Solved/.test(document.getElementById('racer-root').innerText) && !/still coming in/.test(document.getElementById('racer-root').innerText), { timeout: 15000, polling: 250 }).catch(() => {});
		const tc = await text(pc), ta = await text(pa), tb = await text(pb), tv = await text(watcher);
		check('C won', /You finished 1st of 3/.test(tc), tc.slice(0, 200));
		check('Alice is second, B third', /You finished 2nd of 3/.test(ta) && /You finished 3rd of 3/.test(tb), [ta.slice(0, 60), tb.slice(0, 60)]);
		const order = (s) => s.split('\n').filter((l) => /^\d\t/.test(l)).map((l) => l.split('\t')[1]);
		check('every page ranks the same', JSON.stringify(order(ta)) === JSON.stringify(order(tc)) && JSON.stringify(order(tv)) === JSON.stringify(order(ta)) && order(ta)[1] === 'Alice', [order(ta), order(tv)]);
		check('the watcher sees the result without a place', /Race over/.test(tv) && !/Rematch/.test(tv), tv.slice(0, 200));
		const logLinks = await pa.evaluate(() => Array.from(document.querySelectorAll('#racer-root .storm-log a')).map((a) => a.className));
		check('each racer can review their puzzles', logLinks.length === 2 && logLinks.every((c) => c === 'is-ok'), logLinks);
		const boardHidden = await pa.evaluate(() => document.getElementById('puzzle-root').style.display === 'none' && !document.body.classList.contains('storm-mode')
			&& !document.getElementById('puzzle-root').classList.contains('racer-warmup'));
		check('the board is put away', boardHidden);
		check('results: no horizontal scroll at phone width', await noHScroll(pa));
		await shot(pa, '6-results');
		const ratingKeys = await pa.evaluate(() => [localStorage.getItem('sigil_puzzle_rating'), localStorage.getItem('sigil_puzzles_solved'), localStorage.getItem('sigil_puzzle_results')]);
		check('Racer leaves the puzzle rating, solved list and result log alone', ratingKeys.every((v) => v === null), ratingKeys);

		// The rematch: B asks first, the others join from their results.
		await clickRacer(pb, 'rematch');
		await pb.waitForFunction((old) => window.SIGIL_RACER && window.SIGIL_RACER.id !== old && window.SIGIL_RACER.phase === 'lobby', { timeout: 30000, polling: 250 }, id);
		const id2 = (await R(pb)).id;
		r = await race(id);
		check('the old race links the rematch', r.next === id2, r.next);
		await pa.waitForFunction(() => !!document.querySelector('[data-racer="join-next"]'), { timeout: 15000, polling: 250 }).catch(() => {});
		check('the others are offered it', /A rematch is open/.test(await text(pa)));
		await clickRacer(pa, 'join-next');
		await pa.waitForFunction((rid) => window.SIGIL_RACER && window.SIGIL_RACER.id === rid && window.SIGIL_RACER.phase === 'lobby', { timeout: 30000, polling: 250 }, id2);
		r = await until(async () => { const x = await race(id2); return x && x.players && x.players[aliceUid] ? x : null; }, 20000);
		check('the rematch: B hosts, Alice is in, public like the first', r && r.host === bUid && r.public === true && r.status === 'lobby', r);
		// C asks for a rematch too: joined to B's, not a third race.
		const cr = await pc.evaluate((rid) => firebase.functions().httpsCallable('puzzleRace')({ action: 'rematch', id: rid }).then((x) => x.data.id, (e) => e.message), id);
		check('a second rematch request joins the first', cr === id2, cr);

		// ---- 5. Leaving, closing the tab, private races, the sweep ----
		await clickRacer(pa, 'leave');
		await pa.waitForFunction(() => !/race=/.test(location.search), { timeout: 20000 }).catch(() => {});
		r = await until(async () => { const x = await race(id2); return x && !x.players[aliceUid] ? x : null; }, 15000);
		check('Leave takes the racer out of the lobby', !!r, r && Object.keys(r.players));
		await pc.goto(`${BASE}/puzzles.html?tab=racer&race=${encodeURIComponent(id2)}`, { waitUntil: 'load' });
		await until(async () => { const x = await race(id2); return x.players[cUid] && x.players[cUid].gone === false ? x : null; }, 15000);
		await pc.close();
		r = await until(async () => { const x = await race(id2); return x.players[cUid] && x.players[cUid].gone === true ? x : null; }, 20000);
		check('closing the tab marks the racer gone (onDisconnect)', !!r, r && r.players);
		// The same account in a second tab: closing that tab does not make it gone.
		const pb2 = await newPage('guest-b-tab2', pb);
		await open(pb2, '?tab=racer&race=' + encodeURIComponent(id2));
		await pb2.waitForFunction(() => window.SIGIL_RACER.phase === 'lobby', { timeout: 20000, polling: 250 });
		check('a second tab is the same racer', (await R(pb2)).uid === bUid);
		await pb2.close();
		await sleep(3000);
		r = await until(async () => { const x = await race(id2); return x.players[bUid] && x.players[bUid].gone === false ? x : null; }, 15000);
		check('closing one of two tabs leaves the racer present', !!r, (await race(id2)).players[bUid]);
		await pb.waitForFunction(() => /is-gone/.test(document.querySelector('.racer-players').innerHTML), { timeout: 15000, polling: 250 }).catch(() => {});
		t = await text(pb);
		check('the host sees who is still there', /1 of 10 racers/.test(t) && /Waiting for at least one more racer/.test(t), t);
		const priv = await pa.evaluate(() => firebase.functions().httpsCallable('puzzleRace')({ action: 'create', public: false }).then((x) => x.data.id, (e) => e.message));
		const privRace = await race(priv);
		check('a private race is not listed', privRace && privRace.public === false && (await rest('GET', 'puzzle_race_lobby/' + priv)) === null, privRace);

		// The sweep, as the scheduled function runs it, at later times.
		const fnRequire = require('module').createRequire(path.join(DOCS, '..', 'functions', 'index.js'));
		const admin = fnRequire('firebase-admin/app');
		const { getDatabaseWithUrl } = fnRequire('firebase-admin/database');
		const app = admin.initializeApp({ projectId: EMU.project }, 'sweep');
		const adb = getDatabaseWithUrl('https://' + NS + '.firebaseio.com', app);
		const racerMod = require(path.join(DOCS, '..', 'functions', 'racer.js'));
		await racerMod.sweepRaces(adb, Date.now() + 31 * 60000);
		check('a lobby nobody started goes after half an hour', (await race(id2)) === null && (await race(priv)) === null && (await rest('GET', 'puzzle_race_lobby/' + id2)) === null);
		check('a finished race stays for its results and rematch link', (await race(id)) !== null);
		await racerMod.sweepRaces(adb, Date.now() + 3 * 3600000);
		check('… and goes after two hours, with its sequence', (await race(id)) === null && (await rest('GET', 'puzzle_race_seq/' + id)) === null);
		await pb.waitForFunction(() => window.SIGIL_RACER.phase === 'missing', { timeout: 15000, polling: 250 }).catch(() => {});
		t = await text(pb);
		check('the page says a swept race is gone', /does not exist any more/.test(t), t);
		await admin.deleteApp(app);
		check('no page errors', errors.length === 0, errors);
	} catch (e) {
		check('exception: ' + (e && e.stack || e), false);
	} finally {
		await browser.close();
		srv.kill();
	}
	console.log(failures ? failures + ' FAILED' : 'ALL OK');
	process.exit(failures ? 1 : 0);
})();
