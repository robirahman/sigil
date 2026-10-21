// An online room from a position (two browser pages, live Firebase, guests):
//   1. A opens multiplayer.html?sfn=<S>: the lobby prices the position, A picks
//      Blue and creates the room (startSfn, startPos, creatorColor 'blue').
//   2. B opens the room link: B sees the confirmation with B's side (Red) and
//      the odds before joining; joining seats B as Red and A stays Blue.
//   3. The creator's sync holds the joiner's uid and the ranked flag (red
//      records the finished game, so a red creator needs them).
//   4. Both boards open on the start position; the side to move is the one the
//      start SFN's next turn gives.
// The test room is deleted at the end.
//
//   (cd docs && python3 -m http.server 8765) &
//   node tools/browser/position-room-test.js http://localhost:8765
'use strict';
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8765';
const SFN = 'r.........r..bbbbbbb.......rr.....rr..r/Bewitch,Seal_of_Lightning,Starfall,Meteor,Grow,Hail_Storm,Slash,Surge,Sprout r 13 0:0 -:- -:- b1';

const lobby = () => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0];

(async () => {
	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true, code = null, pageA = null;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	try {
		const ctxA = await browser.createBrowserContext();
		const ctxB = await browser.createBrowserContext();
		pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();
		for (const p of [pageA, pageB]) p.on('pageerror', (e) => console.log('pageerror:', e.message));

		await pageA.goto(`${BASE}/multiplayer.html?sfn=${encodeURIComponent(SFN)}`, { waitUntil: 'load', timeout: 90000 });
		await pageA.waitForFunction(() => {
			const l = document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0];
			return l.positionOffer && !l.positionOffer.loading;
		}, { timeout: 120000 });
		const offer = await pageA.evaluate(() => JSON.parse(JSON.stringify(document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].positionOffer)));
		check('lobby prices the position', !!offer.startPos && /^Engine: /.test(offer.evalText), offer);
		await pageA.evaluate(async () => {
			const l = document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0];
			l.positionSide = 'blue';
			await l.createRoom();
		});
		await pageA.waitForFunction(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].phase === 'waiting', { timeout: 30000 });
		code = await pageA.evaluate(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].roomCode);
		const room = await pageA.evaluate(async (c) => (await firebase.database().ref('rooms/' + c).once('value')).val(), code);
		check('room records the start', room.startSfn === SFN && room.creatorColor === 'blue' && !!room.startPos
			&& room.blue && room.blue.connected === true, { creatorColor: room.creatorColor, startPos: room.startPos });

		await pageB.goto(`${BASE}/multiplayer.html?id=${code}`, { waitUntil: 'load', timeout: 90000 });
		await pageB.waitForFunction(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].phase === 'confirmJoin', { timeout: 60000 });
		const jo = await pageB.evaluate(() => JSON.parse(JSON.stringify(document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].joinOffer)));
		check('joiner sees side and odds', jo.side === 'red' && /wins|forced win/.test(jo.oddsText), jo);
		await pageB.evaluate(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].confirmJoin());
		// The board component's state (the controller is not on the Alpine proxy).
		const boardOf = (p) => p.waitForFunction(() => {
			const g = document.querySelector('[x-data^="gameBoard"]');
			const c = g && g._x_dataStack && g._x_dataStack[0];
			return c && c.currentSfn && (c.messageHistory || []).some((m) => /Turn \d/.test(m));
		}, { timeout: 60000 }).then(() => p.evaluate(() => {
			const c = document.querySelector('[x-data^="gameBoard"]')._x_dataStack[0];
			return { myColor: c.myColor, stones: c.currentSfn.split('/')[0], msgs: c.messageHistory.slice(-3) };
		}));
		const [a, b] = await Promise.all([boardOf(pageA), boardOf(pageB)]);
		check('seats: A Blue, B Red', a.myColor === 'blue' && b.myColor === 'red', { a, b });
		check('both boards on the start stones', a.stones === SFN.split('/')[0] && b.stones === SFN.split('/')[0], { a: a.stones, b: b.stones });
		// SFN counter 13: the next turn is 14, Blue's.
		check('Blue moves first', [a, b].every((x) => x.msgs.some((m) => m === 'Blue Turn 7')
			&& x.msgs.some((m) => /Blue moves first/.test(m))), { a: a.msgs, b: b.msgs });
		const st = await pageA.evaluate(async (c) => (await firebase.database().ref('rooms/' + c).once('value')).val(), code);
		// The creator (Blue here; Red records the game, but a Red creator must) holds the joiner's seat.
		const seen = await pageA.evaluate(() => ({ redUid: _firebaseSync.redUid, ranked: _firebaseSync.ranked }));
		check('creator learned the joiner\'s seat', seen.redUid === ((st.red && st.red.uid) || null) && seen.ranked === !!st.ranked, { seen, red: st.red });
		check('room playing, unrated (guests)', st.status === 'playing' && st.ranked === false);
	} catch (e) {
		console.log('ERROR', e.message);
		ok = false;
	} finally {
		if (code && pageA) {
			await pageA.evaluate(async (c) => { await firebase.database().ref('rooms/' + c).remove(); }, code).catch(() => {});
		}
		await browser.close();
	}
	console.log(ok ? 'position-room-test: PASS' : 'position-room-test: FAIL');
	process.exit(ok ? 0 : 1);
})();
