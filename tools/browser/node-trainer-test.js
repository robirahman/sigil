// The node trainer (nodes.html, node-trainer.js):
//   - every node button sits on the board, inside the board image, and no two
//     overlap; in "find" mode the buttons do not announce their names;
//   - "find": a right click scores, a wrong one does not and names both nodes;
//     the round ends on time and its score becomes this device's best, which
//     a lower score does not replace;
//   - "name": typed answers (b 1 2; a 1 then a pause) and the keypad score;
//   - a round with the names shown is not scored;
//   - phone width: no sideways scroll;
//   - on the Firebase emulators (when FIREBASE_DATABASE_EMULATOR_HOST is set):
//     a signed-in account's round lands in users/<uid>/nodeTrainer/<mode>
//     ({ best, runs, last, at }) and the page shows the account's best; an
//     anonymous guest's stays on the device.
//
//   (cd docs && python3 -m http.server 8765) &
//   node tools/browser/node-trainer-test.js http://localhost:8765
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/node-trainer-test.js http://localhost:8765'
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '';
const NS = 'sigil-js-default-rtdb';

let failed = 0;
const check = (ok, msg) => {
	console.log((ok ? 'ok   ' : 'FAIL ') + msg);
	if (!ok) failed++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
}

// gstatic downloads flake: serve the Firebase SDK from memory.
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

async function newPage(browser, emulate) {
	const p = await browser.newPage();
	await p.setViewport({ width: 1000, height: 1100 });
	p.errors = [];
	p.on('pageerror', e => p.errors.push('pageerror: ' + e.message));
	if (emulate) {
		await p.evaluateOnNewDocument(useEmulators, DB_HOST, AUTH_HOST);
		await p.setBypassServiceWorker(true);
		await p.setRequestInterception(true);
		p.on('request', (req) => {
			const url = req.url();
			if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
	}
	return p;
}

const st = (p) => p.evaluate(() => {
	const s = window.SIGIL_NODE_TRAINER;
	return { mode: s.mode, running: s.running, score: s.score, misses: s.misses, target: s.target, record: s.record, lastResult: s.lastResult,
		feedback: document.getElementById('trainer-feedback').textContent, result: document.getElementById('trainer-result').textContent,
		best: document.getElementById('trainer-best').textContent };
});

async function clickNode(p, n) {
	await p.$eval('#trainer-node--' + n, b => b.click());
	await sleep(30);
}
async function endRound(p) {
	await p.evaluate(() => { window.SIGIL_NODE_TRAINER.endsAt = Date.now(); });
	await p.waitForFunction(() => !window.SIGIL_NODE_TRAINER.running && window.SIGIL_NODE_TRAINER.lastResult, { timeout: 20000 });
}
async function startRound(p) {
	await p.evaluate(() => { window.SIGIL_NODE_TRAINER.lastResult = null; });
	await p.$eval('#trainer-start', b => b.click());
	await p.waitForFunction(() => window.SIGIL_NODE_TRAINER.running, { timeout: 5000 });
}

async function localChecks(browser) {
	const p = await newPage(browser, false);
	await p.goto(BASE + '/nodes.html', { waitUntil: 'networkidle2', timeout: 60000 });
	await p.evaluate(() => localStorage.removeItem('sigil_node_trainer'));
	await p.reload({ waitUntil: 'networkidle2' });

	// Geometry: every node on the board image, no overlaps.
	const geo = await p.evaluate(() => {
		const img = document.querySelector('img.game-board').getBoundingClientRect();
		const boxes = Array.from(document.querySelectorAll('.trainer-node')).map(b => ({ n: b.dataset.node, r: b.getBoundingClientRect(), label: b.getAttribute('aria-label') }));
		const inside = boxes.every(b => b.r.width > 5 && b.r.left >= img.left - 1 && b.r.right <= img.right + 1 && b.r.top >= img.top - 1 && b.r.bottom <= img.bottom + 1);
		let overlaps = 0;
		for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i].r, c = boxes[j].r;
			if (a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom) overlaps++;
		}
		return { n: boxes.length, inside, overlaps, labels: boxes.map(b => b.label) };
	});
	check(geo.n === 39 && geo.inside && geo.overlaps === 0, `39 node buttons on the board, none overlapping (${geo.n}, inside ${geo.inside}, overlaps ${geo.overlaps})`);
	check(geo.labels.every(l => l === 'Board node'), 'in "find" mode the buttons do not announce their names');

	// Find: right, wrong, end, best.
	await startRound(p);
	let s = await st(p);
	await clickNode(p, s.target);
	s = await st(p);
	check(s.score === 1 && /right/.test(s.feedback), 'a right click scores: ' + s.feedback);
	const target = s.target;
	const wrong = target === 'c13' ? 'a1' : 'c13';
	await clickNode(p, wrong);
	s = await st(p);
	check(s.score === 1 && s.misses === 1 && s.feedback.includes(wrong) && s.feedback.includes(target), 'a wrong click names both nodes: ' + s.feedback);
	for (let i = 0; i < 3; i++) { s = await st(p); await clickNode(p, s.target); }
	await endRound(p);
	s = await st(p);
	check(s.score === 4 && /New best/.test(s.result), 'the round ends with its score as the new best: ' + s.result);
	let local = await p.evaluate(() => readNodeTrainerLocal());
	check(local.find.best === 4 && local.find.runs === 1 && local.pending.length === 0, 'this device keeps the best (guest: no pending upload)');
	await startRound(p);
	s = await st(p);
	await clickNode(p, s.target);
	await endRound(p);
	s = await st(p);
	check(/Best: 4/.test(s.result) && /Best 4/.test(s.best), 'a lower score keeps the best: ' + s.result + ' / ' + s.best);

	// Name: typing and the keypad.
	await p.$eval('.trainer-modes button[data-mode="name"]', b => b.click());
	await startRound(p);
	let right = 0;
	for (let i = 0; i < 4; i++) {
		s = await st(p);
		const m = /^([abc])(\d+)$/.exec(s.target);
		await p.keyboard.press(m[1]);
		for (const ch of m[2]) await p.keyboard.press(ch);
		if (m[2] === '1') await sleep(900); else await sleep(50);
		const after = await st(p);
		if (after.score === right + 1) right++;
	}
	check(right === 4, 'typed answers score in "name" mode (' + right + '/4, incl. the wait after "1")');
	s = await st(p);
	const km = /^([abc])(\d+)$/.exec(s.target);
	await p.$eval(`#trainer-zones button[data-zone="${km[1]}"]`, b => b.click());
	await p.$eval(`#trainer-numbers button[data-number="${km[2]}"]`, b => b.click());
	s = await st(p);
	check(s.score === 5, 'the keypad answers too');
	const ringed = await p.$$eval('.trainer-node--target', els => els.length);
	check(ringed === 1, 'one node is ringed');
	await endRound(p);
	local = await p.evaluate(() => readNodeTrainerLocal());
	check(local.name.best === 5 && local.find.best === 4, 'the modes keep separate bests');

	// Names shown: not scored.
	await p.$eval('#trainer-labels', b => b.click());
	await startRound(p);
	s = await st(p);
	await p.keyboard.press('a'); await p.keyboard.press('2');
	await endRound(p);
	s = await st(p);
	check(/not scored/.test(s.result) && (await p.evaluate(() => readNodeTrainerLocal().name.runs)) === 1, 'a round with the names shown is not scored');
	await p.$eval('#trainer-labels', b => b.click());

	// Phone width.
	await p.setViewport({ width: 390, height: 844 });
	await p.reload({ waitUntil: 'networkidle2' });
	const wide = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	check(wide <= 0, 'fits a 390 px viewport (overflow ' + wide + 'px)');
	check(p.errors.length === 0, 'no page errors' + (p.errors.length ? ': ' + p.errors.join('; ') : ''));
	await p.close();
}

async function emulatorChecks(browser) {
	const email = 'trainer' + Date.now() + '@example.com';
	const r = await fetch('http://' + AUTH_HOST + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo',
		{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }) });
	const uid = (await r.json()).localId;
	const p = await newPage(browser, true);
	await p.goto(BASE + '/nodes.html', { waitUntil: 'load', timeout: 90000 });
	await p.evaluate(() => localStorage.removeItem('sigil_node_trainer'));
	await p.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), email);
	await p.waitForFunction((u) => window.SIGIL_NODE_TRAINER.user && window.SIGIL_NODE_TRAINER.user.uid === u
		&& window.SIGIL_NODE_TRAINER.record && window.SIGIL_NODE_TRAINER.record.signedIn, { timeout: 30000 }, uid);
	await startRound(p);
	for (let i = 0; i < 3; i++) { const s = await st(p); await clickNode(p, s.target); }
	await endRound(p);
	let s = await st(p);
	check(s.lastResult && s.lastResult.signedIn && !s.lastResult.queued && s.lastResult.best === 3, 'a signed-in round is saved to the account: ' + JSON.stringify(s.lastResult));
	const rec = await (await fetch(`http://${DB_HOST}/users/${uid}/nodeTrainer.json?ns=${NS}`, { headers: { Authorization: 'Bearer owner' } })).json();
	check(rec && rec.find && rec.find.best === 3 && rec.find.runs === 1 && rec.find.last === 3 && rec.find.at > 0, 'users/<uid>/nodeTrainer/find holds { best, runs, last, at }: ' + JSON.stringify(rec));
	await p.waitForFunction(() => /your account/.test(document.getElementById('trainer-best').textContent), { timeout: 10000 });
	check(true, 'the page shows the account\'s best');
	const pending = await p.evaluate(() => readNodeTrainerLocal().pending.length);
	check(pending === 0, 'nothing left pending on the device');

	// An anonymous guest: on the device only.
	await p.evaluate(() => firebase.auth().signOut().then(() => firebase.auth().signInAnonymously()));
	await p.waitForFunction(() => window.SIGIL_NODE_TRAINER.user && window.SIGIL_NODE_TRAINER.user.isAnonymous, { timeout: 30000 });
	const anonUid = await p.evaluate(() => window.SIGIL_NODE_TRAINER.user.uid);
	await startRound(p);
	s = await st(p); await clickNode(p, s.target);
	await endRound(p);
	s = await st(p);
	check(s.lastResult && s.lastResult.signedIn === false, 'a guest round stays on the device');
	const anonRec = await (await fetch(`http://${DB_HOST}/users/${anonUid}/nodeTrainer.json?ns=${NS}`, { headers: { Authorization: 'Bearer owner' } })).json();
	check(anonRec === null, 'nothing written for the guest');
	check(p.errors.length === 0, 'no page errors (emulator)' + (p.errors.length ? ': ' + p.errors.join('; ') : ''));
	await p.close();
}

(async () => {
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
	try {
		await localChecks(browser);
		if (DB_HOST && AUTH_HOST) await emulatorChecks(browser);
		else console.log('(no emulators: account checks skipped)');
	} finally {
		await browser.close();
	}
	if (failed) {
		console.error(failed + ' check(s) failed');
		process.exit(1);
	}
	console.log('all checks passed');
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
