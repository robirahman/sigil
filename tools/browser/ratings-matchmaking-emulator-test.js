// Glicko-2 pool ratings behind site_config/ratingDisplay, and the lobby's
// matchmaking pools, on the Firebase emulators with the functions (the
// matchmake function pairs the tickets), through the real pages in Chrome:
//   1. Two signed-in players queue for the same rated 5+0 game: the server
//      pairs them, the one who waited longer hosts an invite-only room, the
//      other joins, and the game starts rated; the tickets are gone.
//   2. Two guests queue for an untimed game: paired, casual.
//   3. Open games show the creator's pool rating with "?" and its 95% range
//      (the Elo without the flag).
//   4. The leaderboard by pool, the profile's pool ratings, and the game-over
//      line, with the flag on; the Elo pages with ?ratings=elo.
//
//   (cd docs && python3 -m http.server 8806) &
//   cd functions && firebase emulators:exec --only auth,database,functions --project demo-sigil \
//     'node ../tools/browser/ratings-matchmaking-emulator-test.js http://localhost:8806'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8806';
const NS = 'sigil-js-default-rtdb';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

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
async function until(p, fn, arg, timeoutMs) {
	const end = Date.now() + (timeoutMs || 30000);
	let last;
	while (Date.now() < end) {
		last = await p.evaluate(fn, arg).catch(() => undefined);
		if (last) return last;
		await sleep(400);
	}
	return last;
}

const owner = { Authorization: 'Bearer owner' };
const dbPut = async (p, v) => {
	const r = await fetch(`http://${DB_HOST}/${p}.json?ns=${NS}`, { method: 'PUT', headers: owner, body: JSON.stringify(v) });
	if (r.status !== 200) throw new Error('put ' + p + ': ' + r.status + ' ' + await r.text());
};
const dbGet = async (p) => (await fetch(`http://${DB_HOST}/${p}.json?ns=${NS}`, { headers: owner })).json();

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`http://${DB_HOST}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: owner, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());
	await fetch(`http://${DB_HOST}/.json?ns=${NS}`, { method: 'DELETE', headers: owner });
	await dbPut('site_config', { ratingDisplay: 'glicko', matchmaking: true });

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	let pageErrors = 0;
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
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		p.on('pageerror', (e) => { console.log('pageerror:', e.message, (e.stack || '').split('\n').slice(1, 3).join(' | ')); pageErrors++; });
		return p;
	};
	const L = '[x-data^="multiplayerLobby"]';
	const openLobby = async (p, qs) => {
		await p.goto(`${BASE}/multiplayer.html${qs || ''}`, { waitUntil: 'load', timeout: 90000 });
		const ready = await until(p, (sel) => !!(window.Alpine && document.querySelector(sel)._x_dataStack), L, 30000);
		if (!ready) throw new Error('lobby did not load');
	};
	// A full account, its Elo set by the "server" (the owner).
	const account = async (name, elo, played) => {
		const p = await newPage();
		await openLobby(p);
		const uid = await p.evaluate(async (n) => {
			const c = await firebase.auth().createUserWithEmailAndPassword(n.toLowerCase() + '@example.test', 'secret123');
			await firebase.database().ref('users/' + c.user.uid).set({ displayName: n, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: Date.now() });
			return c.user.uid;
		}, name);
		await dbPut('users/' + uid + '/elo', elo);
		await dbPut('users/' + uid + '/gamesPlayed', played);
		await openLobby(p);
		const named = await until(p, (a) => { const l = Alpine.$data(document.querySelector(a[0])); return l.authDisplayName === a[1] && l.authElo === a[2]; }, [L, name, elo], 20000);
		if (!named) throw new Error(name + ' not signed in');
		p._uid = uid;
		return p;
	};
	const guest = async () => { const p = await newPage(); await openLobby(p); return p; };
	const lobby = (p) => p.evaluate((sel) => {
		const l = Alpine.$data(document.querySelector(sel));
		return { phase: l.phase, roomCode: l.roomCode, err: l.lobbyError, notice: l.lobbyNotice, mm: l.mm && { status: l.mm.status, bucket: l.mm.bucket },
			mmText: l.mmStatusText, auth: l.authRatingText, open: l.openGames, mode: l.ratingMode, mmOn: l.matchmakingOn };
	}, L);
	const setForm = (p, f) => p.evaluate((a) => { Object.assign(Alpine.$data(document.querySelector(a[0])), a[1]); }, [L, f]);
	const call = (p, m) => p.evaluate((a) => { Alpine.$data(document.querySelector(a[0]))[a[1]](); }, [L, m]);
	const phaseIs = (p, ph, ms) => until(p, (a) => Alpine.$data(document.querySelector(a[0])).phase === a[1], [L, ph], ms || 60000);

	try {
		// ---- 1. Rated matchmaking between two accounts.
		const alice = await account('Alice', 1500, 20);
		const bob = await account('Bob', 1450, 5);
		const st = await lobby(alice);
		check('the flag is read: pool ratings and matchmaking on', st.mode === 'glicko' && st.mmOn === true, { mode: st.mode, mm: st.mmOn });
		check('the matchmaking section shows', await alice.evaluate(() => {
			const el = document.querySelector('.matchmaking');
			return !!el && getComputedStyle(el).display !== 'none' && !!document.querySelector('.lobby-button--matchmaking');
		}));
		await setForm(alice, { tcType: 'realtime', tcPreset: '5+0', casualGame: false });
		await setForm(bob, { tcType: 'realtime', tcPreset: '5+0', casualGame: false });
		const authText = await until(alice, (sel) => Alpine.$data(document.querySelector(sel)).authRatingText === 'Blitz 1500?', L, 5000);
		check('the lobby shows the form\'s pool rating, seeded from the Elo', !!authText, (await lobby(alice)).auth);
		await call(alice, 'findMatch');
		const queued = await until(alice, (sel) => { const l = Alpine.$data(document.querySelector(sel)); return l.mm && l.mm.status === 'queue'; }, L, 15000);
		const qa = await lobby(alice);
		check('Alice waits in the 5+0 rated pool', queued && qa.mm.bucket === 'rt-300-0~standard~r', qa.mm);
		check('her status shows her rating window', /rated 1150–1850 \(5\+0, Standard, Rated\)/.test(qa.mmText), qa.mmText);
		let ticket = null;
		for (let i = 0; i < 20 && !ticket; i++) { ticket = await dbGet('mm_tickets/' + alice._uid); if (!ticket) await sleep(300); }
		check('her ticket is on the server', ticket && ticket.bucket === 'rt-300-0~standard~r' && typeof ticket.at === 'number', ticket);
		await sleep(300);
		await call(bob, 'findMatch');
		const [pa, pb] = await Promise.all([phaseIs(alice, 'playing', 90000), phaseIs(bob, 'playing', 90000)]);
		const la = await lobby(alice);
		const lb = await lobby(bob);
		check('the server paired them and the game started for both', pa && pb && la.roomCode === lb.roomCode, { a: la.phase, b: lb.phase, err: [la.err, lb.err] });
		const room = la.roomCode ? await dbGet('rooms/' + la.roomCode) : null;
		const creator = (room && (room.creatorColor === 'blue' ? room.blue : room.red)) || {};
		check('Alice (waited longer) hosts an invite room for Bob', room && creator.uid === alice._uid && room.invite === bob._uid && room.public !== true, room && { creator: creator.uid, invite: room.invite });
		check('the room is the pool\'s game, rated', room && room.ranked === true && room.casual !== true && room.variant === 'standard'
			&& room.timeControl.type === 'realtime' && room.timeControl.initialTime === 300000 && room.timeControl.increment === 0,
			room && { ranked: room.ranked, tc: room.timeControl, variant: room.variant });
		const left = await until(alice, async () => true, null, 1000) && (await dbGet('mm_tickets'));
		check('both tickets are gone once the game starts', !left || (!left[alice._uid] && !left[bob._uid]), left);
		const matches = await dbGet('mm_matches');
		const m = matches && Object.values(matches)[0];
		check('the match names the room', m && m.room === la.roomCode && m.host === alice._uid && m.guest === bob._uid, m);

		// ---- 2. Two guests, casual and untimed.
		const g1 = await guest();
		const g2 = await guest();
		for (const g of [g1, g2]) await setForm(g, { tcType: 'none', casualGame: false });
		const gl = await lobby(g1);
		check('a guest\'s matchmaking is casual', /Unlimited, Standard, Casual/.test(await g1.evaluate((sel) => Alpine.$data(document.querySelector(sel)).mmLabel, L)), gl.auth);
		await call(g1, 'findMatch');
		await sleep(300);
		await call(g2, 'findMatch');
		const [q1, q2] = await Promise.all([phaseIs(g1, 'playing', 90000), phaseIs(g2, 'playing', 90000)]);
		const r1 = await lobby(g1);
		const groom = q1 && q2 && r1.roomCode ? await dbGet('rooms/' + r1.roomCode) : null;
		check('two guests are paired into a casual game', groom && groom.casual === true && groom.ranked === false, groom && { casual: groom.casual, ranked: groom.ranked });

		// ---- 3. Open games: the creator's pool rating, provisional, with its range.
		const erin = await account('Erin', 1500, 5);
		await setForm(erin, { tcType: 'realtime', tcPreset: '5+0', casualGame: false, listPublic: true });
		await erin.evaluate((sel) => Alpine.$data(document.querySelector(sel)).createRoom(), L);
		await phaseIs(erin, 'waiting', 30000);
		const frank = await guest();
		const row = await until(frank, (sel) => {
			const g = Alpine.$data(document.querySelector(sel)).openGames.find((x) => x.creatorName === 'Erin');
			return g && g.creatorRating ? { creatorRating: g.creatorRating, creatorRange: g.creatorRange } : null;
		}, L, 20000);
		check('an open game shows the creator\'s Blitz rating, "?" and its 95% range', row && row.creatorRating === '1500?' && row.creatorRange === '1000–2000', row);
		const shown = await frank.evaluate(() => [...document.querySelectorAll('.lobby-list--open .lobby-game__who')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
		check('the list shows it', shown.some((t) => t.includes('Erin (1500?)') && t.includes('1000–2000')), shown);
		const eloPage = await newPage();
		await openLobby(eloPage, '?ratings=elo');
		const eloRow = await until(eloPage, (sel) => {
			const l = Alpine.$data(document.querySelector(sel));
			const g = l.openGames.find((x) => x.creatorName === 'Erin');
			return l.ratingMode === 'elo' && g && g.creatorRating !== null ? { creatorRating: g.creatorRating, creatorRange: g.creatorRange } : null;
		}, L, 20000);
		check('with ?ratings=elo the list shows the Elo, no range', eloRow && eloRow.creatorRating === 1500 && !eloRow.creatorRange, eloRow);

		// ---- 4. Leaderboard, profile and the game-over line.
		const now = Date.now();
		await dbPut('ratings/' + alice._uid + '/blitz', { r: 1612.4, rd: 60, vol: 0.06, n: 30, w: 18, l: 12, at: now });
		await dbPut('ratings/' + alice._uid + '/rapid', { r: 1540, rd: 140, vol: 0.06, n: 3, w: 2, l: 1, at: now });
		await dbPut('ratings/' + bob._uid + '/blitz', { r: 1450, rd: 200, vol: 0.06, n: 4, w: 1, l: 3, at: now });
		await dbPut('pool_leaderboard/blitz', {
			[alice._uid]: { displayName: 'Alice', r: 1612.4, rd: 60, n: 30, at: now },
			[bob._uid]: { displayName: 'Bob', r: 1450, rd: 200, n: 4, at: now },
		});
		await dbPut('pool_leaderboard/rapid', { [alice._uid]: { displayName: 'Alice', r: 1540, rd: 140, n: 3, at: now } });
		await dbPut('leaderboard/' + alice._uid, { displayName: 'Alice', elo: 1500, gamesPlayed: 20 });
		const lbPage = await newPage();
		await lbPage.goto(`${BASE}/leaderboard.html`, { waitUntil: 'load', timeout: 90000 });
		const lbState = await until(lbPage, () => {
			const d = Alpine.$data(document.querySelector('[x-data^="leaderboardPage"]'));
			return !d.loading && d.allPlayers.length ? { pool: d.pool, tabs: d.poolTabs.map((t) => t.id), rows: d.allPlayers.map((p) => [p.displayName, p.elo, p.provisional, p.gamesPlayed]) } : null;
		}, null, 30000);
		check('the leaderboard shows the pools with players, Blitz first', lbState && lbState.pool === 'blitz' && lbState.tabs.join() === 'blitz,rapid', lbState);
		check('Blitz: Alice 1612 settled, Bob 1450 provisional', lbState && JSON.stringify(lbState.rows) === JSON.stringify([['Alice', 1612, false, 30], ['Bob', 1450, true, 4]]), lbState && lbState.rows);
		const marks = await lbPage.evaluate(() => [...document.querySelectorAll('.leaderboard-table tbody tr')].map((tr) => tr.querySelector('.elo').textContent.trim()));
		check('the table marks the provisional rating', marks.join('|') === '1612|1450?', marks);
		await lbPage.evaluate(() => Alpine.$data(document.querySelector('[x-data^="leaderboardPage"]')).setPool('rapid'));
		const rapid = await until(lbPage, () => {
			const d = Alpine.$data(document.querySelector('[x-data^="leaderboardPage"]'));
			return !d.loading && d.pool === 'rapid' && d.allPlayers.length ? d.allPlayers.map((p) => [p.displayName, p.elo, p.provisional]) : null;
		}, null, 20000);
		check('switching to Rapid', rapid && JSON.stringify(rapid) === JSON.stringify([['Alice', 1540, true]]), rapid);
		const lbElo = await newPage();
		await lbElo.goto(`${BASE}/leaderboard.html?ratings=elo`, { waitUntil: 'load', timeout: 90000 });
		const eloRows = await until(lbElo, () => {
			const d = Alpine.$data(document.querySelector('[x-data^="leaderboardPage"]'));
			return !d.loading && d.ratingMode === 'elo' && d.allPlayers.length ? d.allPlayers.map((p) => [p.displayName, p.elo]) : null;
		}, null, 30000);
		check('with ?ratings=elo the leaderboard is the Elo one', eloRows && eloRows.some((r) => r[0] === 'Alice' && r[1] === 1500), eloRows);

		// Two rated games: one rated in its pool, one from before the pools (no
		// backfill): the table shows a dash for it and the stats leave its Elo out.
		await dbPut('user_games/' + alice._uid, {
			gOld: { timestamp: now - 2000, gameId: 'gOld', opponent: 'Bob', opponentUid: bob._uid, color: 'red', result: 'win', rated: true,
				eloBefore: 1490, eloAfter: 1500, eloChange: 10, opponentEloBefore: 1460 },
			gNew: { timestamp: now - 1000, gameId: 'gNew', opponent: 'Bob', opponentUid: bob._uid, color: 'blue', result: 'win', rated: true,
				eloBefore: 1500, eloAfter: 1512, eloChange: 12, opponentEloBefore: 1450,
				glicko: { pool: 'blitz', before: 1597, rdBefore: 61, after: 1612.4, rdAfter: 60, change: 15.4, opponentBefore: 1450, opponentRd: 200 } },
		});
		const prof = await newPage();
		await prof.goto(`${BASE}/profile.html?uid=${alice._uid}`, { waitUntil: 'load', timeout: 90000 });
		const cells = await until(prof, () => {
			const rows = [...document.querySelectorAll('.games-table tbody tr')];
			return rows.length === 2 ? rows.map((r) => r.lastElementChild.textContent.replace(/\s+/g, ' ').trim()) : null;
		}, null, 30000);
		check('the games table shows pool ratings, a dash before the pools', cells && cells.join('|') === '1612 (+15)|\u2014', cells);
		const stats = await until(prof, () => {
			const d = Alpine.$data(document.querySelector('[x-data^="profilePage"]'));
			if (!d.stats) return null;
			const row = d.stats.byKind.find((r) => r.label === 'vs players');
			return { games: row.games, rated: row.rated, net: row.net, best: d.stats.bests.bestWin && d.stats.bests.bestWin.oppElo };
		}, null, 20000);
		check('stats: both games counted, only the pool game\'s rating', stats && stats.games === 2 && stats.rated === 1 && stats.net === 15 && stats.best === 1450, stats);
		const pools = await until(prof, () => {
			const el = document.querySelector('[data-testid="pool-ratings"]');
			return el && el.querySelectorAll('.profile__pool').length ? [...el.querySelectorAll('.profile__pool')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()) : null;
		}, null, 30000);
		check('the profile lists the pool ratings, most played first', pools && pools.join('|') === 'Blitz 1612|Rapid 1540?', pools);

		const line = await alice.evaluate(() => describeGameRating({ rated: true, eloChange: 12, eloBefore: 1500, eloAfter: 1512,
			glicko: { pool: 'blitz', before: 1500, rdBefore: 250, after: 1515.4, rdAfter: 230, change: 15.4 } }));
		check('the game-over line is the pool\'s', line === 'Blitz rating: +15 (1500? → 1515?)', line);
		const eloLine = await eloPage.evaluate(() => describeGameRating({ rated: true, eloChange: 12, eloBefore: 1500, eloAfter: 1512,
			glicko: { pool: 'blitz', before: 1500, rdBefore: 250, after: 1515.4, rdAfter: 230 } }));
		check('and the Elo one without the flag', eloLine === 'Rating: +12 (1500 → 1512)', eloLine);
	} catch (e) {
		console.log('FAIL exception', e && e.stack || e);
		ok = false;
	}
	check('no page errors', pageErrors === 0, pageErrors);
	await browser.close();
	console.log(ok ? 'ALL OK' : 'SOME CHECKS FAILED');
	process.exit(ok ? 0 : 1);
})();
