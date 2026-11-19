// Studies (study.js on analysis.html, studies.html) on the Firebase emulators:
// several browsers on one study, under the real database rules.
//   1. An account creates a study on studies.html and lands on its board.
//   2. It invites a second account by name; a guest joins by the viewer link.
//   3. Turns, a reply, an annotation symbol, an arrow and a comment made on
//      one screen show on the others, live.
//   4. A viewer's own turn stays on their screen (not in the database) and
//      the viewer cannot annotate or delete shared turns.
//   5. Deleting a turn and adding a chapter reach the others.
//   6. A private study is closed to a stranger, open to its members.
//   7. The plain analysis board saves its tree as a new chapter.
//   8. studies.html lists the study (and, once public, under Public studies).
// The engine's wasm is not served, so no search runs.
//
//   (cd docs && python3 -m http.server 8810) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/studies-emulator-test.js http://localhost:8810'
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
	// Deleting needs a yes.
	window.confirm = () => true;
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

const ROOT = '#analysis-root';
// The study's state on a page (a JSON-safe projection).
function studyState() {
	const d = Alpine.$data(document.querySelector('#analysis-root'));
	return {
		status: d.studyStatus, role: d.studyRole, error: d.studyError, chapter: d.studyChapter,
		chapters: d.studyChapters.map((c) => c.title), cur: d.anaCur,
		tree: d.anaTree.map((n) => ({ id: n.id, key: n.key || null, parent: n.parent, sfn: n.sfn, deleted: n.deleted, glyph: n.glyph || '', local: !!n.local, notes: n.notes || 0, children: n.children.slice() })),
		awaiting: d.awaiting, validMoves: Object.keys(d.validMoves || {}), actionList: d.actionList.slice(),
		presence: d.studyPresence.map((p) => p.name), notes: JSON.parse(JSON.stringify(d.studyNotes)),
		marks: d.boardMarks ? d.boardMarks.list() : [],
	};
}

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const stamp = Date.now();
	const olgaMail = `olga${stamp}@example.com`, edMail = `ed${stamp}@example.com`, strangerMail = `sam${stamp}@example.com`;
	const olga = await signUp(olgaMail);
	const ed = await signUp(edMail);
	await signUp(strangerMail);
	const edName = 'Ed' + String(stamp).slice(-6);
	await rest('PATCH', '', {
		['users/' + olga + '/displayName']: 'Olga',
		['users/' + ed + '/displayName']: edName,
		['usernames/' + edName.toLowerCase()]: ed,
	});

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && !!cond; };
	const newPage = async () => {
		const ctx = await browser.createBrowserContext();
		const p = await ctx.newPage();
		await p.setViewport({ width: 1280, height: 1000 });
		await p.evaluateOnNewDocument(useEmulators, DB_HOST, AUTH_HOST);
		await p.setBypassServiceWorker(true);
		await p.setRequestInterception(true);
		p.on('request', (req) => {
			const url = req.url();
			// No engine: its wasm is not served.
			if (/\/static\/wasm|rust-worker\.js/.test(url)) return req.respond({ status: 404, body: '' });
			if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		p.on('pageerror', (e) => console.log('pageerror:', e.message));
		return p;
	};
	const waitState = async (p, pred, ms, what) => {
		const t0 = Date.now();
		let st = null;
		while (Date.now() - t0 < ms) {
			st = await p.evaluate(studyState).catch(() => null);
			if (st && pred(st)) return st;
			await sleep(250);
		}
		throw new Error('timed out waiting for ' + what + '; last ' + JSON.stringify(st && Object.assign({}, st, { tree: st.tree.length })));
	};
	const signIn = (p, email) => p.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123').then(() => true), email);
	// One turn for the side to move: a stone on the first legal node, then End Turn.
	const playTurn = async (p, pick) => {
		const st = await waitState(p, (s) => s.awaiting === 'action' && s.validMoves.length > 0, 20000, 'a move prompt');
		const node = pick ? pick(st.validMoves) : st.validMoves[0];
		await p.evaluate((n) => Alpine.$data(document.querySelector('#analysis-root')).handleNodeClick(n), node);
		await waitState(p, (s) => s.actionList.includes('pass'), 10000, 'the end-turn prompt');
		await p.click('.action-button--end-turn');
		return node;
	};
	const call = (p, fn, ...args) => p.evaluate((f, a) => Alpine.$data(document.querySelector('#analysis-root'))[f](...a), fn, args);

	try {
		// ---- 1. Create on studies.html.
		const pO = await newPage();
		await pO.goto(`${BASE}/studies.html`, { waitUntil: 'load', timeout: 90000 });
		await pO.waitForFunction(() => window.Alpine && window.firebase && firebase.apps.length, { timeout: 30000 });
		await signIn(pO, olgaMail);
		await pO.reload({ waitUntil: 'load' });
		await pO.waitForFunction(() => { const el = document.querySelector('[x-data="studiesPage()"]'); return el && Alpine.$data(el).signedIn; }, { timeout: 30000, polling: 250 });
		await pO.type('.new-study-title', 'Fireblast openings');
		await Promise.all([
			pO.waitForNavigation({ timeout: 30000 }),
			pO.click('.new-study-create'),
		]);
		const sid = new URL(pO.url()).searchParams.get('study');
		check('creating a study opens its board', !!sid, pO.url());
		let st = await waitState(pO, (s) => s.status === 'ready' && s.tree.length === 1, 30000, 'the study to load');
		check('the owner sees chapter 1 at its start', st.role === 'owner' && st.chapters[0] === 'Chapter 1', st.role);
		const meta = await rest('GET', 'studies/' + sid + '/meta');
		check('the study is stored, unlisted by default', meta && meta.title === 'Fireblast openings' && meta.visibility === 'unlisted' && meta.owner === olga, meta);

		// ---- 2. Invite Ed by name; a guest by the viewer link.
		await pO.evaluate((n) => { const d = Alpine.$data(document.querySelector('#analysis-root')); d.studyInvite.name = n; d.studyInvite.role = 'editor'; }, edName);
		await call(pO, 'studyInviteByName');
		const edMember = await rest('GET', 'studies/' + sid + '/members/' + ed);
		check('invite by name makes an editor', edMember && edMember.role === 'editor', edMember);
		check('the invitee gets the study on their list', !!(await rest('GET', 'user_studies/' + ed + '/' + sid)));
		await call(pO, 'studyLoadLinks', false);
		const links = await pO.evaluate(() => Object.assign({}, Alpine.$data(document.querySelector('#analysis-root')).studyLinks));
		check('the owner has editor and viewer links', /join=editor&token=/.test(links.editor) && /join=viewer&token=/.test(links.viewer), links);

		// ---- 3. Live edits.
		const firstNode = await playTurn(pO);
		st = await waitState(pO, (s) => s.tree.length === 2 && s.tree[1].key, 10000, 'the owner\'s turn in the tree');
		const k1 = st.tree[1].key;
		const stored1 = await rest('GET', 'studies/' + sid + '/chapters/' + st.chapter + '/nodes/' + k1);
		check('a turn is saved under the start', stored1 && stored1.p === 'root' && stored1.by === olga && /"actions"/.test(stored1.t), stored1);

		const pE = await newPage();
		await pE.goto(`${BASE}/analysis.html`, { waitUntil: 'load', timeout: 90000 });
		await pE.waitForFunction(() => window.firebase && firebase.apps.length, { timeout: 30000 });
		await signIn(pE, edMail);
		await pE.goto(`${BASE}/analysis.html?study=${sid}`, { waitUntil: 'load', timeout: 90000 });
		st = await waitState(pE, (s) => s.status === 'ready' && s.tree.length === 2, 30000, 'Ed to see the turn');
		check('the editor sees the study and its turn', st.role === 'editor' && st.tree[1].key === k1);
		await call(pE, 'anaGoto', 1);
		const reply = await playTurn(pE);
		st = await waitState(pO, (s) => s.tree.filter((n) => !n.deleted).length === 3, 15000, 'Ed\'s reply on Olga\'s screen');
		check('the editor\'s reply shows on the owner\'s screen', st.tree[2].parent === 1, { reply });
		const k2 = st.tree[2].key;

		await call(pO, 'anaGoto', 1);
		await pO.click('.ana-glyph[data-glyph="!?"]');
		st = await waitState(pE, (s) => s.tree[1].glyph === '!?', 10000, 'the symbol on Ed\'s screen');
		check('an annotation symbol reaches the editor', true);
		const rowText = await pE.evaluate(() => Array.from(document.querySelectorAll('.ana-tree__row')).map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
		check('the tree shows the symbol after the turn', rowText.some((t) => /!\?/.test(t)), rowText);

		// An arrow drawn with the right mouse button.
		const centre = async (p, n) => p.$eval('#stone-node--' + n, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
		await call(pE, 'anaGoto', 1);
		const a = await centre(pO, 'a1'), b = await centre(pO, 'a5');
		await pO.mouse.move(a.x, a.y);
		await pO.mouse.down({ button: 'right' });
		await pO.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
		await pO.mouse.move(b.x, b.y, { steps: 4 });
		await pO.mouse.up({ button: 'right' });
		const marks = await rest('GET', 'studies/' + sid + '/chapters/' + st.chapter + '/nodes/' + k1 + '/m');
		check('an arrow is saved on the turn', marks && marks['a1-a5'] === 'green', marks);
		st = await waitState(pE, (s) => s.marks.some((m) => m.from === 'a1' && m.to === 'a5'), 10000, 'the arrow on Ed\'s board');
		check('the arrow shows on the editor\'s board', true);

		await pE.evaluate(() => { const d = Alpine.$data(document.querySelector('#analysis-root')); d.studyNoteDraft = 'Why not a pass here?'; d.studyNoteEditing = true; });
		await call(pE, 'studySaveNote');
		st = await waitState(pO, (s) => (s.notes[k1] || []).some((n) => n.text === 'Why not a pass here?' && n.name === edName), 10000, 'Ed\'s comment on Olga\'s screen');
		check('a comment reaches the owner, with its author', st.tree[1].notes === 1);

		// ---- 4. A guest viewer by link.
		const pV = await newPage();
		await pV.goto(links.viewer, { waitUntil: 'load', timeout: 90000 });
		st = await waitState(pV, (s) => s.status === 'ready' && s.tree.filter((n) => !n.deleted).length === 3, 30000, 'the guest viewer to load');
		check('the viewer link makes the guest a viewer', st.role === 'viewer');
		check('the token leaves the address bar', !/token=/.test(pV.url()), pV.url());
		const glyphDisabled = await pV.$eval('.ana-glyph[data-glyph="!"]', (el) => el.disabled);
		const deleteDisabled = await (async () => { await call(pV, 'anaGoto', 1); return pV.$eval('.ana-delete', (el) => el.disabled); })();
		check('a viewer cannot annotate or delete shared turns', glyphDisabled && deleteDisabled);
		await call(pV, 'anaGoto', 2);
		await playTurn(pV);
		st = await waitState(pV, (s) => s.tree.some((n) => n.local && !n.deleted), 10000, 'the viewer\'s own turn');
		check('the viewer\'s turn is theirs only', st.tree.filter((n) => !n.deleted).length === 4);
		const nodesNow = await rest('GET', 'studies/' + sid + '/chapters/' + st.chapter + '/nodes');
		check('nothing of the viewer\'s is saved', Object.keys(nodesNow).length === 3, Object.keys(nodesNow));
		const pres = await waitState(pO, (s) => s.presence.length >= 3, 15000, 'three people present');
		check('the owner sees who is here', pres.presence.includes(edName) && pres.presence.includes('Guest'), pres.presence);

		// ---- 5. Delete a turn; a new chapter.
		await call(pO, 'anaGoto', 2);
		await pO.click('.ana-delete');
		st = await waitState(pE, (s) => s.tree.find((n) => n.key === k2) === undefined || s.tree.find((n) => n.key === k2).deleted, 10000, 'the deleted reply to leave Ed\'s tree');
		check('a deleted turn leaves the editor\'s tree (and the selection moves up)', !st.tree[st.cur].deleted);
		st = await waitState(pV, (s) => s.tree.every((n) => n.key !== k2 || n.deleted) && !s.tree.some((n) => n.local && !n.deleted), 10000, 'the viewer\'s turn under it to go too');
		check('the viewer\'s own turn under it goes with it', true);
		check('its comment-free node is gone from the database', !(await rest('GET', 'studies/' + sid + '/chapters/' + st.chapter + '/nodes/' + k2)));
		await call(pE, 'studyOpenNewChapter');
		await pE.evaluate(() => { const d = Alpine.$data(document.querySelector('#analysis-root')); d.studyNewChapter.title = 'Endings'; d.studyNewChapter.from = 'start'; });
		await call(pE, 'studyCreateChapter');
		st = await waitState(pO, (s) => s.chapters.length === 2 && s.chapters[1] === 'Endings', 10000, 'the new chapter on Olga\'s list');
		check('a chapter added by the editor shows on the owner\'s list', true);
		st = await waitState(pE, (s) => s.chapters.length === 2 && s.tree.length === 1 && s.status === 'ready', 10000, 'Ed in the new chapter');
		check('the new chapter opens at its start', st.tree[0].sfn.split(' ')[2] === '0');

		// ---- 6. Private.
		await pO.evaluate(() => { Alpine.$data(document.querySelector('#analysis-root')).studySettings.visibility = 'private'; });
		await call(pO, 'studySaveSettings');
		check('the owner makes it private', (await rest('GET', 'studies/' + sid + '/meta/visibility')) === 'private');
		const pS = await newPage();
		await pS.goto(`${BASE}/analysis.html`, { waitUntil: 'load', timeout: 90000 });
		await pS.waitForFunction(() => window.firebase && firebase.apps.length, { timeout: 30000 });
		await signIn(pS, strangerMail);
		await pS.goto(`${BASE}/analysis.html?study=${sid}`, { waitUntil: 'load', timeout: 90000 });
		st = await waitState(pS, (s) => s.status === 'denied', 20000, 'the stranger to be refused');
		check('a stranger cannot open a private study', st.tree.length === 0 || st.status === 'denied');
		await pV.reload({ waitUntil: 'load' });
		st = await waitState(pV, (s) => s.status === 'ready', 20000, 'the viewer to reopen it');
		check('a member viewer still reads the private study', st.role === 'viewer');

		// ---- 7. The plain board saves its tree to the study.
		const startSfn = (await rest('GET', 'studies/' + sid + '/chapters/' + (await pO.evaluate(studyState)).chapter + '/nodes/root/sfn'));
		await pO.goto(`${BASE}/analysis.html?sfn=${encodeURIComponent(startSfn)}`, { waitUntil: 'load', timeout: 90000 });
		await pO.waitForFunction(() => { const d = window.Alpine && Alpine.$data(document.querySelector('#analysis-root')); return d && d.anaTree.length === 1; }, { timeout: 30000, polling: 250 });
		await playTurn(pO);
		await playTurn(pO);
		await pO.waitForFunction(() => Alpine.$data(document.querySelector('#analysis-root')).anaTree.length === 3, { timeout: 15000, polling: 250 });
		await call(pO, 'studySaveOpen');
		await pO.waitForFunction(() => Alpine.$data(document.querySelector('#analysis-root')).studySave.loaded, { timeout: 15000, polling: 250 });
		const target = await pO.evaluate(() => Alpine.$data(document.querySelector('#analysis-root')).studySave.target);
		check('the save panel offers the owner\'s study', target === sid, target);
		await pO.evaluate(() => { Alpine.$data(document.querySelector('#analysis-root')).studySave.chapterTitle = 'From the board'; });
		await Promise.all([pO.waitForNavigation({ timeout: 30000 }), call(pO, 'studySaveTree')]);
		st = await waitState(pO, (s) => s.status === 'ready' && s.tree.length === 3, 30000, 'the saved chapter');
		check('the saved tree opens as a new chapter', st.chapters.length === 3 && st.chapters[2] === 'From the board', st.chapters);

		// ---- 8. studies.html lists it; public studies are listed for everyone.
		await pO.evaluate(() => { Alpine.$data(document.querySelector('#analysis-root')).studySettings.visibility = 'public'; });
		await call(pO, 'studySaveSettings');
		check('a public study is indexed', !!(await rest('GET', 'study_index/' + sid)));
		await pS.goto(`${BASE}/studies.html`, { waitUntil: 'load', timeout: 90000 });
		await pS.waitForFunction(() => { const el = document.querySelector('[x-data="studiesPage()"]'); return el && Alpine.$data(el).ready; }, { timeout: 30000, polling: 250 });
		const listed = await pS.$$eval('.public-studies .study-card', (els) => els.map((e) => e.dataset.study));
		check('studies.html lists the public study', listed.includes(sid), listed);
		await pE.goto(`${BASE}/studies.html`, { waitUntil: 'load', timeout: 90000 });
		await pE.waitForFunction(() => { const el = document.querySelector('[x-data="studiesPage()"]'); return el && Alpine.$data(el).ready; }, { timeout: 30000, polling: 250 });
		const mine = await pE.$$eval('.my-studies .study-card', (els) => els.map((e) => e.dataset.study + ':' + e.textContent.replace(/\s+/g, ' ').trim()));
		check('the editor\'s list holds the study', mine.some((m) => m.startsWith(sid + ':') && /editor/i.test(m)), mine);
		// Phone width: no sideways scroll on either page.
		await pE.setViewport({ width: 375, height: 800 });
		const wide = await pE.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
		check('studies.html fits a phone', !wide);
		void firstNode;
	} catch (e) {
		console.log('FAIL exception', e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'STUDIES EMULATOR TEST OK' : 'STUDIES EMULATOR TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
