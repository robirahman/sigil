// The open-games lobby, quick pair and the live-games list, on the Firebase
// emulators (no live database), through the real lobby in Chrome:
//   1. Alice lists a public casual game as Blue; Bob sees it in Open Games
//      with the right labels and joins: he is Red and the room is unrated,
//      although both are signed in.
//   2. Two players click the same open game: one gets the seat, the other
//      is told someone else joined first.
//   3. Quick pair joins a waiting seek at the same time control; a seek
//      shows as "your game" with Cancel, and Cancel withdraws it.
//   4. Two quick pairs at once with nothing open still end up paired.
//   5. Watch Live lists the games being played, and a guest can spectate one.
//
//   (cd docs && python3 -m http.server 8766) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/lobby-emulator-test.js http://localhost:8766'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8766';
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

const L = () => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]'));

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`http://${DB_HOST}/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());
	// A clean database: earlier runs' rooms would show in the lists.
	await fetch(`http://${DB_HOST}/.json?ns=${NS}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && !!cond; };
	const newPage = async () => {
		const ctx = await browser.createBrowserContext();
		const p = await ctx.newPage();
		await p.evaluateOnNewDocument(useEmulators, DB_HOST, AUTH_HOST);
		// The service worker's cached CDN scripts race the emulator hook,
		// and gstatic downloads flake here: serve the SDK from memory.
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
	const openLobby = async (p) => {
		await p.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		const ready = await until(p, () => !!(window.Alpine && document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack), null, 30000);
		if (!ready) throw new Error('lobby did not load');
	};
	// A full account with a profile (so games between two of them are rated).
	const account = async (name) => {
		const p = await newPage();
		await openLobby(p);
		await p.evaluate(async (n) => {
			const c = await firebase.auth().createUserWithEmailAndPassword(n.toLowerCase() + '@example.test', 'secret123');
			await firebase.database().ref('users/' + c.user.uid).set({ displayName: n, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: Date.now() });
		}, name);
		await openLobby(p);
		const named = await until(p, (n) => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).authDisplayName === n, name, 20000);
		if (!named) throw new Error(name + ' not signed in');
		return p;
	};
	const guest = async () => { const p = await newPage(); await openLobby(p); return p; };
	const lobby = (p) => p.evaluate(() => {
		const l = Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]'));
		return { phase: l.phase, roomCode: l.roomCode, err: l.lobbyError, notice: l.lobbyNotice, open: l.openGames, live: l.liveGames, spectator: l.isSpectator };
	});
	const room = (p, c) => p.evaluate(async (code) => (await firebase.database().ref('rooms/' + code).once('value')).val(), c);
	const uidOf = (p) => p.evaluate(() => firebase.auth().currentUser && firebase.auth().currentUser.uid);
	const setForm = (p, f) => p.evaluate((form) => { Object.assign(Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')), form); }, f);
	const phaseIs = (p, ph) => until(p, (x) => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).phase === x, ph, 30000);

	try {
		// ---- 1. A public casual game as Blue, joined from the list.
		const pageA = await account('Alice');
		const pageB = await account('Bob');
		await setForm(pageA, { listPublic: true, casualGame: true, creatorSide: 'blue' });
		await pageA.evaluate(async () => { await Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).createRoom(); });
		await phaseIs(pageA, 'waiting');
		const codeA = (await lobby(pageA)).roomCode;
		const rA = await room(pageA, codeA);
		check('Alice\'s room: public, casual, Alice in blue', rA.public === true && rA.casual === true && rA.creatorColor === 'blue'
			&& rA.blue.uid === await uidOf(pageA) && !rA.red.uid, { public: rA.public, casual: rA.casual, creatorColor: rA.creatorColor });
		check('the waiting screen says so', /You play Blue .*Casual .*open-games lobby/.test(await pageA.evaluate(() => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).waitingInfo)));

		const row = await until(pageB, (c) => {
			const l = Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]'));
			const g = l.openGames.find((x) => x.code === c);
			return g && g.creatorElo !== null ? JSON.parse(JSON.stringify(g)) : null;
		}, codeA, 20000);
		check('Bob sees it in Open Games with its labels', row && row.creatorName === 'Alice' && row.creatorElo === 1000
			&& row.ratedLabel === 'Casual' && row.youPlay === 'Red' && row.tcLabel === 'Unlimited' && row.variantLabel === 'Standard' && !row.mine, row);
		const shown = await pageB.evaluate((c) => {
			const el = document.querySelector('.lobby-list--open [data-code="' + c + '"]');
			return el ? el.textContent.replace(/\s+/g, ' ') : '';
		}, codeA);
		check('the row is rendered', /Alice \(1000\).*Unlimited · Standard · Casual · you play Red/.test(shown), shown);
		await pageB.evaluate((c) => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).joinOpenGame(c), codeA);
		await phaseIs(pageB, 'playing');
		const jA = await until(pageB, (c) => firebase.database().ref('rooms/' + c).once('value').then((s) => s.val().status === 'playing' && s.val()), codeA);
		check('Bob joins as Red, unrated although both signed in', jA && jA.red.uid === await uidOf(pageB) && jA.ranked === false
			&& jA.red.anon === false && jA.blue.anon === false, jA && { red: jA.red, ranked: jA.ranked });
		check('Alice\'s screen starts the game as Blue', !!(await until(pageA, () => {
			const l = Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]'));
			return l.phase === 'playing' && window._multiplayerState && window._multiplayerState.myColor === 'blue';
		}, null, 20000)));
		check('a joined game leaves the open list', !!(await until(pageB, (c) => {
			return !Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).openGames.some((g) => g.code === c);
		}, codeA, 10000)));

		// ---- 2. Two players click the same open game.
		const pageG = await account('Gina');
		const pageC = await account('Carl');
		const pageD = await account('Dora');
		await setForm(pageG, { listPublic: true, tcType: 'realtime', tcPreset: '5+0', creatorSide: 'red' });
		await pageG.evaluate(async () => { await Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).createRoom(); });
		await phaseIs(pageG, 'waiting');
		const codeG = (await lobby(pageG)).roomCode;
		for (const p of [pageC, pageD]) {
			await until(p, (c) => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).openGames.some((g) => g.code === c && g.ratedLabel === 'Rated' && g.tcLabel === '5+0'), codeG, 20000);
		}
		await Promise.all([pageC, pageD].map((p) => p.evaluate((c) => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).joinOpenGame(c), codeG)));
		await sleep(1500);
		const [sC, sD] = [await lobby(pageC), await lobby(pageD)];
		const winner = sC.phase === 'playing' ? pageC : pageD;
		const loserState = winner === pageC ? sD : sC;
		const loser = winner === pageC ? pageD : pageC;
		check('one of two joiners gets the seat', (sC.phase === 'playing') !== (sD.phase === 'playing'), { C: sC.phase, D: sD.phase });
		check('the other is told someone else joined first', loserState.phase === 'lobby' && loserState.err === 'Someone else joined first.', loserState.err);
		const rG = await room(pageG, codeG);
		check('Gina\'s room is rated, with the winner in blue', rG.status === 'playing' && rG.ranked === true && rG.blue.uid === await uidOf(winner), { status: rG.status, ranked: rG.ranked });

		// ---- 3. Quick pair: the loser seeks 5+0 (nothing open: it lists one).
		await setForm(loser, { tcType: 'realtime', tcPreset: '5+0' });
		await loser.evaluate(() => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).quickPair());
		await phaseIs(loser, 'waiting');
		const codeS = (await lobby(loser)).roomCode;
		const rS = await room(loser, codeS);
		check('quick pair with nothing open lists a public game', rS.public === true && rS.status === 'waiting' && rS.timeControl.type === 'realtime' && rS.timeControl.initialTime === 300000);
		const mineRow = await until(loser, (c) => {
			const g = Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).openGames.find((x) => x.code === c);
			return g ? JSON.parse(JSON.stringify(g)) : null;
		}, codeS, 10000);
		check('the seeker\'s own row says it waits, with Cancel', mineRow && mineRow.mine === true);
		const pageE = await account('Eve');
		const ownRow = await pageE.evaluate(() => {
			const el = document.querySelector('.lobby-list--open .lobby-game');
			return el ? el.textContent.replace(/\s+/g, ' ') : '';
		});
		check('others see a Join button', /Join/.test(ownRow), ownRow);
		// A 3+0 seek from Eve does not match: she lists her own.
		await setForm(pageE, { tcType: 'realtime', tcPreset: '3+0' });
		await pageE.evaluate(() => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).quickPair());
		await phaseIs(pageE, 'waiting');
		const codeE = (await lobby(pageE)).roomCode;
		check('a different time control is not paired', codeE !== codeS && (await room(pageE, codeS)).status === 'waiting');
		const ownE = await until(pageE, (c) => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).openGames.some((g) => g.code === c && g.mine), codeE, 10000);
		check('own waiting game listed as mine', !!ownE);
		await pageE.evaluate(() => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).cancelWaiting());
		await phaseIs(pageE, 'lobby');
		check('Cancel withdraws the seek', (await room(pageE, codeE)) === null);
		await setForm(pageE, { tcType: 'realtime', tcPreset: '5+0' });
		await pageE.evaluate(() => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).quickPair());
		await phaseIs(pageE, 'playing');
		const rS2 = await until(pageE, (c) => firebase.database().ref('rooms/' + c).once('value').then((s) => s.val() && s.val().status === 'playing' && s.val()), codeS);
		check('quick pair joins the waiting 5+0 seek', rS2 && [rS2.red.uid, rS2.blue.uid].includes(await uidOf(pageE)) && rS2.ranked === true);
		check('the seeker\'s game starts', !!(await phaseIs(loser, 'playing')));

		// ---- 4. Two guests quick-pair at once with nothing open.
		const pageH = await guest();
		const pageI = await guest();
		for (const p of [pageH, pageI]) await setForm(p, { tcType: 'realtime', tcPreset: '3+2', casualGame: true });
		await Promise.all([pageH, pageI].map((p) => p.evaluate(() => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).quickPair())));
		const paired = await until(pageH, () => window._multiplayerState && window._multiplayerState.roomCode, null, 30000);
		const pairedI = await until(pageI, () => window._multiplayerState && window._multiplayerState.roomCode, null, 30000);
		check('simultaneous quick pairs end up in one game', paired && paired === pairedI, { H: paired, I: pairedI, h: await lobby(pageH).then((s) => s.phase), i: await lobby(pageI).then((s) => s.phase) });
		const left = (await room(pageH, paired)) || {};
		check('their game is casual', left.casual === true && left.ranked === false && left.status === 'playing');

		// ---- 5. Watch Live: the guest spectator sees the games and watches one.
		const pageF = await guest();
		const live = await until(pageF, (codes) => {
			const l = Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]'));
			const have = l.liveGames.map((g) => g.code);
			return codes.every((c) => have.includes(c)) ? JSON.parse(JSON.stringify(l.liveGames)) : null;
		}, [codeA, codeG, codeS, paired], 20000);
		check('Watch Live lists the four games', !!live, live && live.map((g) => g.code));
		const aRow = live && live.find((g) => g.code === codeA);
		check('with players and labels', aRow && aRow.redName === 'Bob' && aRow.blueName === 'Alice' && aRow.ratedLabel === 'Casual'
			&& live.find((g) => g.code === codeG).ratedLabel === 'Rated', aRow);
		await pageF.evaluate((c) => Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]')).watchGame(c), codeA);
		const watching = await until(pageF, () => {
			const l = Alpine.$data(document.querySelector('[x-data^="multiplayerLobby"]'));
			return l.phase === 'playing' && l.isSpectator && window._multiplayerState && window._multiplayerState.isSpectator;
		}, null, 20000);
		check('a guest spectates from the list', !!watching);
		const seats = await room(pageF, codeA);
		check('the spectator took no seat', seats.red.uid === await uidOf(pageB) && seats.blue.uid === await uidOf(pageA));
	} catch (e) {
		console.log('FAIL exception', e.stack || e.message);
		ok = false;
	}
	await browser.close();
	console.log(ok ? 'LOBBY EMULATOR TEST OK' : 'LOBBY EMULATOR TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
