// Play On as Deathmatch, online, on the Firebase emulators (no live
// database), through the real lobby and game pages in Chrome:
//   1. Alice (Blue, 5+3) and Bob play; the game ends on the board (the
//      finished state is injected): Alice's game-over menu offers "Play On
//      (Deathmatch)", and not after a forfeit or timeout.
//   2. Pressing it creates a room straight away from the final position as
//      Deathmatch: Alice still Blue, same clock, unpriced, and offered to Bob
//      through the old room's rematch node (positionRoom.deathmatch).
//   3. Bob's menu shows "Opponent offers to play on as Deathmatch" (and no
//      Play On of his own); following it, the join offer says Deathmatch is
//      unrated, and both boards open on the position under Deathmatch rules.
//   4. Both players press Play On at once: one offer wins, the other player's
//      room is withdrawn and they land on the winner's join offer.
//
//   (cd docs && python3 -m http.server 8767) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/deathmatch-play-on-emulator-test.js http://localhost:8767'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8767';
const NS = 'sigil-js-default-rtdb';
// The emulators' addresses (firebase emulators:exec sets them), so a
// private emulator config with other ports works too.
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Evaluate-loop polling (background tabs get no animation frames).
async function until(p, fn, arg, timeoutMs) {
	const end = Date.now() + (timeoutMs || 30000);
	let last;
	while (Date.now() < end) {
		last = await p.evaluate(fn, arg).catch((e) => undefined);
		if (last) return last;
		await sleep(400);
	}
	return last;
}


const SPELLS = 'Bewitch,Seal_of_Lightning,Starfall,Meteor,Grow,Hail_Storm,Slash,Surge,Sprout';
const START = 'r.........r..bbbbbbb.......rr.....rr..r/' + SPELLS + ' r 13 0:0 -:- -:- b1';
const FINAL = 'r.r.r.rr..r..bbbbbbb.......rr.....rr..r/' + SPELLS + ' r 13 6:3 Meteor:- -:- r1';
const PLAYON = 'r.r.r.rr..r..bbbbbbb.......rr.....rr..r/' + SPELLS + ' r 13 0:0 Meteor:- -:- r1 deathmatch';
const LOBBY = '[x-data^="multiplayerLobby"]';
const BOARD = '[x-data^="gameBoard"]';

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`http://${DB_HOST}/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());
	await fetch(`http://${DB_HOST}/.json?ns=${NS}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && !!cond; };
	const newPage = async () => {
		const ctx = await browser.createBrowserContext();
		const p = await ctx.newPage();
		await p.evaluateOnNewDocument(useEmulators, DB_HOST, AUTH_HOST);
		await p.setBypassServiceWorker(true);
		await p.setRequestInterception(true);
		p.on('request', (req) => {
			const url = req.url();
			if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }),
				() => req.continue());
		});
		p.on('pageerror', (e) => console.log('pageerror:', e.message));
		return p;
	};
	const openLobby = async (p, qs) => {
		await p.goto(`${BASE}/multiplayer.html${qs || ''}`, { waitUntil: 'load', timeout: 90000 });
		const ready = await until(p, (s) => !!(window.Alpine && document.querySelector(s)._x_dataStack), LOBBY, 30000);
		if (!ready) throw new Error('lobby did not load');
	};
	const account = async (name) => {
		const p = await newPage();
		await openLobby(p);
		await p.evaluate(async (n) => {
			const c = await firebase.auth().createUserWithEmailAndPassword(n.toLowerCase() + '@example.test', 'secret123');
			await firebase.database().ref('users/' + c.user.uid).set({ displayName: n, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: Date.now() });
		}, name);
		await openLobby(p);
		const named = await until(p, (a) => Alpine.$data(document.querySelector(a[0])).authDisplayName === a[1], [LOBBY, name], 20000);
		if (!named) throw new Error(name + ' not signed in');
		return p;
	};
	const lobby = (p) => p.evaluate((s) => {
		const l = Alpine.$data(document.querySelector(s));
		return { phase: l.phase, roomCode: l.roomCode, err: l.lobbyError, waitingInfo: l.waitingInfo, joinOffer: l.joinOffer && JSON.parse(JSON.stringify(l.joinOffer)) };
	}, LOBBY);
	const room = (p, c) => p.evaluate(async (code) => (await firebase.database().ref('rooms/' + code).once('value')).val(), c);
	const uidOf = (p) => p.evaluate(() => firebase.auth().currentUser && firebase.auth().currentUser.uid);
	const phaseIs = (p, ph) => until(p, (a) => Alpine.$data(document.querySelector(a[0])).phase === a[1], [LOBBY, ph], 30000);
	const btn = (p, text) => p.evaluate((t) => [...document.querySelectorAll('.win-modal__btn')]
		.some((b) => b.textContent.trim() === t && b.offsetParent !== null), text);
	// The game ends on the board: the finished state the game_over handler sets.
	const finish = (p, reason) => p.evaluate((a) => {
		const c = Alpine.$data(document.querySelector(a.s));
		c._lastEndReason = a.reason;
		c.reviewSfns = [a.start, a.fin];
		c.winner = 'red';
	}, { s: BOARD, reason, start: START, fin: FINAL });

	try {
		// ---- 1. Alice (Blue, 5+3) and Bob play.
		const pageA = await account('Alice');
		const pageB = await account('Bob');
		await pageA.evaluate((s) => Object.assign(Alpine.$data(document.querySelector(s)),
			{ creatorSide: 'blue', tcType: 'realtime', tcPreset: '5+3' }), LOBBY);
		await pageA.evaluate(async (s) => { await Alpine.$data(document.querySelector(s)).createRoom(); }, LOBBY);
		await phaseIs(pageA, 'waiting');
		const code1 = (await lobby(pageA)).roomCode;
		await pageB.evaluate((a) => { const l = Alpine.$data(document.querySelector(a[0])); l.joinCode = a[1]; l.joinRoom(true); }, [LOBBY, code1]);
		await phaseIs(pageB, 'playing');
		for (const p of [pageA, pageB]) {
			await until(p, (s) => { const el = document.querySelector(s); return el && el._x_dataStack && Alpine.$data(el)._roomCodeForReview; }, BOARD, 30000);
		}
		await finish(pageA, 'forfeit');
		await sleep(300);
		check('no Play On after a forfeit', !(await btn(pageA, 'Play On (Deathmatch)')));
		await finish(pageA, 'time');
		await sleep(300);
		check('no Play On after a timeout', !(await btn(pageA, 'Play On (Deathmatch)')));
		await finish(pageA, null);
		await finish(pageB, null);
		await sleep(300);
		check('Play On offered after a regular ending', await btn(pageA, 'Play On (Deathmatch)'));

		// ---- 2. Alice plays on.
		await Promise.all([
			pageA.waitForNavigation({ waitUntil: 'load', timeout: 90000 }),
			pageA.evaluate(() => [...document.querySelectorAll('.win-modal__btn')]
				.find((b) => b.textContent.trim() === 'Play On (Deathmatch)').click()),
		]);
		await phaseIs(pageA, 'waiting');
		const sA = await lobby(pageA);
		const code2 = sA.roomCode;
		const r2 = await room(pageA, code2);
		check('room created straight away from the Deathmatch position', r2 && r2.status === 'waiting' && r2.startSfn === PLAYON
			&& r2.variant === 'deathmatch' && !r2.startPos, r2 && { startSfn: r2.startSfn, variant: r2.variant, startPos: r2.startPos });
		check('Alice keeps Blue and the 5+3 clock', r2 && r2.creatorColor === 'blue' && r2.blue.uid === await uidOf(pageA)
			&& r2.timeControl.type === 'realtime' && r2.timeControl.initialTime === 300000 && r2.timeControl.increment === 3000,
			r2 && { creatorColor: r2.creatorColor, tc: r2.timeControl });
		const r1 = await until(pageA, (c) => firebase.database().ref('rooms/' + c + '/rematch/positionRoom').once('value').then((s) => s.val()), code1, 10000);
		check('offered to Bob through the old room', r1 && r1.code === code2 && r1.by === 'blue' && r1.deathmatch === true, r1);

		// ---- 2b. Alice cancels: the offer is taken back and Bob gets his own
		// Play On again; then Alice offers again (as the button would).
		await until(pageB, () => [...document.querySelectorAll('.win-modal__btn')].some((b) => b.offsetParent !== null && /Opponent offers/.test(b.textContent)), null, 15000);
		await pageA.evaluate((s) => Alpine.$data(document.querySelector(s)).cancelWaiting(), LOBBY);
		await phaseIs(pageA, 'lobby');
		const gone = await until(pageA, (c) => firebase.database().ref('rooms/' + c + '/rematch/positionRoom').once('value').then((x) => x.val() === null), code1, 10000);
		check('cancelling takes the offer back', gone);
		const back = await until(pageB, () => {
			const vis = (re) => [...document.querySelectorAll('.win-modal__btn')].some((b) => b.offsetParent !== null && re.test(b.textContent));
			return !vis(/Opponent offers/) && vis(/^Play On \(Deathmatch\)$/);
		}, null, 15000);
		check('Bob\'s offer link goes and his Play On returns', back);
		// A stale offer (a room no longer waiting) does not hide Play On either.
		await pageA.evaluate((a) => firebase.database().ref('rooms/' + a[0] + '/rematch/positionRoom')
			.set({ code: a[1], by: 'blue', deathmatch: true }), [code1, code2]);
		await sleep(1500);
		check('a withdrawn room is not offered', await pageB.evaluate(() => {
			const vis = (re) => [...document.querySelectorAll('.win-modal__btn')].some((b) => b.offsetParent !== null && re.test(b.textContent));
			return !vis(/Opponent offers/) && vis(/^Play On \(Deathmatch\)$/);
		}));
		// Bob's stale offer: Alice's new offer must not defer to it.
		await pageA.evaluate((a) => firebase.database().ref('rooms/' + a[0] + '/rematch/positionRoom')
			.set({ code: a[1], by: 'red', deathmatch: true }), [code1, code2]);
		await pageA.evaluate((a) => {
			sessionStorage.setItem('sigil_playon', JSON.stringify({ sfn: a.sfn, side: 'blue', timeControl: { type: 'realtime', initialTime: 300000, increment: 3000 } }));
			sessionStorage.setItem('sigil_position_from_room', JSON.stringify({ code: a.code, color: 'blue', deathmatch: true }));
		}, { sfn: PLAYON, code: code1 });
		await openLobby(pageA, '?sfn=' + encodeURIComponent(PLAYON));
		await phaseIs(pageA, 'waiting');
		const code2b = (await lobby(pageA)).roomCode;
		const re = await until(pageA, (a) => firebase.database().ref('rooms/' + a[0] + '/rematch/positionRoom').once('value')
			.then((x) => x.val() && x.val().code === a[1]), [code1, code2b], 10000);
		check('the opponent\'s stale offer is replaced, not joined', re && code2b !== code2);
		const code2final = code2b;

		// ---- 3. Bob follows the offer.
		const label = await until(pageB, () => {
			const a = [...document.querySelectorAll('.win-modal__btn')].find((b) => b.offsetParent !== null && /Opponent offers/.test(b.textContent));
			return a && a.textContent.trim();
		}, null, 15000);
		check('Bob sees the Deathmatch offer', label === 'Opponent offers to play on as Deathmatch', label);
		check('and no Play On of his own', !(await btn(pageB, 'Play On (Deathmatch)')));
		await openLobby(pageB, '?id=' + code2final);
		await phaseIs(pageB, 'confirmJoin');
		const jo = (await lobby(pageB)).joinOffer;
		check('join offer: Bob plays Red, unrated Deathmatch', jo && jo.side === 'red' && /Deathmatch games do not affect rating/.test(jo.note), jo);
		await pageB.evaluate((s) => { Alpine.$data(document.querySelector(s)).confirmJoin(); }, LOBBY);
		await phaseIs(pageB, 'playing');
		for (const [p, who, color] of [[pageA, 'Alice', 'blue'], [pageB, 'Bob', 'red']]) {
			const st = await until(p, (s) => {
				const el = document.querySelector(s);
				const c = el && el._x_dataStack && Alpine.$data(el);
				return c && c.currentSfn && { dm: c.isDeathmatch, me: c.myColor, sfn: c.currentSfn, winner: c.winner };
			}, BOARD, 30000);
			check(who + '\'s board: Deathmatch, ' + color + ', on the final position', st && st.dm && st.me === color && !st.winner
				&& st.sfn.split(' ')[0] === PLAYON.split(' ')[0] && / 0:0 /.test(st.sfn), st);
		}

		// ---- 4. Both press Play On at once (the new game, ended again).
		for (const p of [pageA, pageB]) {
			await until(p, (a) => { const el = document.querySelector(a[0]); return el && el._x_dataStack && Alpine.$data(el)._roomCodeForReview === a[1]; }, [BOARD, code2final], 30000);
		}
		await finish(pageA, null);
		await finish(pageB, null);
		await sleep(300);
		check('both are offered Play On', await btn(pageA, 'Play On (Deathmatch)') && await btn(pageB, 'Play On (Deathmatch)'));
		await Promise.all([pageA, pageB].map((p) => Promise.all([
			p.waitForNavigation({ waitUntil: 'load', timeout: 90000 }),
			p.evaluate(() => [...document.querySelectorAll('.win-modal__btn')]
				.find((b) => b.textContent.trim() === 'Play On (Deathmatch)').click()),
		])));
		const settled = await until(pageA, async (c) => {
			const pr = (await firebase.database().ref('rooms/' + c + '/rematch/positionRoom').once('value')).val();
			return pr && pr.code ? pr : null;
		}, code2final, 20000);
		const winnerPage = settled && settled.by === 'blue' ? pageA : pageB;
		const loserPage = winnerPage === pageA ? pageB : pageA;
		await phaseIs(winnerPage, 'waiting');
		const wl = await lobby(winnerPage);
		check('one offer stands, from the winner\'s waiting room', settled && wl.roomCode === settled.code, { settled, room: wl.roomCode });
		const landed = await until(loserPage, (a) => {
			const l = Alpine.$data(document.querySelector(a[0]));
			return new URLSearchParams(location.search).get('id') === a[1] && l.phase === 'confirmJoin' && l.joinOffer && l.joinOffer.code;
		}, [LOBBY, settled && settled.code], 30000);
		check('the other player lands on its join offer', landed === (settled && settled.code), landed);
		const all = await fetch(`http://${DB_HOST}/rooms.json?ns=${NS}`, { headers: { Authorization: 'Bearer owner' } }).then((r) => r.json());
		const rooms = Object.keys(all || {}).filter((k) => all[k].status === 'waiting');
		check('only one waiting room is left', rooms && rooms.length === 1 && rooms[0] === (settled && settled.code), rooms);
	} catch (e) {
		console.log('ERROR', e.stack || e.message);
		ok = false;
	} finally {
		await browser.close();
	}
	console.log(ok ? 'deathmatch-play-on-emulator-test: PASS' : 'deathmatch-play-on-emulator-test: FAIL');
	process.exit(ok ? 0 : 1);
})();
