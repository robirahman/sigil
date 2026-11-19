// Badges, the activity feed, private notes, bookmarks, site events, verified
// titles, streamers and Sigil TV on the Firebase emulators (no live database),
// with Alice (an admin, who follows Bob), Bob and a guest in separate browser
// contexts:
//   1. A user_games entry written as rateGame writes it fires socialGame: Bob's
//      win lands in activity/ and his First Win badge in badges/, which no
//      client can write; a daily puzzle solve fires socialPuzzle. Alice's
//      feed.html shows "Bob beat Carol".
//   2. Alice writes a private note on Bob's profile: Bob cannot read it. Bob's
//      profile shows his badge and his activity.
//   3. Alice stars Bob's game on his profile; her Saved tab lists it and the
//      note; the game's review page shows it bookmarked, and un-bookmarks it.
//   4. Alice posts an event on admin.html (Bob's post is refused); a guest sees
//      the banner on the menu, dismisses it for good, and finds the event on
//      events.html.
//   5. Alice grants Bob a verified title: his profile shows it.
//   6. Bob lists his channel on streamers.html (a non-channel URL is refused)
//      and marks himself live: the guest sees him first, LIVE.
//   7. Sigil TV shows the higher-rated of two live games, shows the result when
//      it ends, and switches to the other.
//
//   (cd docs && python3 -m http.server 8805) &
//   cd functions && firebase emulators:exec --only auth,database,functions --project demo-sigil \
//     'node ../tools/browser/social-lite-emulator-test.js http://localhost:8805'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8805';
const NS = 'sigil-js-default-rtdb';
// Emulator ports: the defaults, or a private config's (emulators:exec sets these).
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const DB = 'http://' + DB_HOST;
const OWNER = { Authorization: 'Bearer owner' };
const FUNCTIONS = path.join(__dirname, '..', '..', 'functions');
const { freshEngine } = require(path.join(FUNCTIONS, 'engine-loader'));
const ONLINE = require(path.join(FUNCTIONS, 'test', 'online-game.json'));

function useEmulators(dbPort, authHost) {
	// Sigil TV switches after this long here (8 s on the site).
	window.__TV_RESULT_MS = 1500;
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
				app.database().useEmulator('127.0.0.1', dbPort);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
	let v;
	for (let t = 0; t < (ms || 20000); t += 250) {
		v = await fn();
		if (v) return v;
		await sleep(250);
	}
	return v;
};

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const stamp = Date.now();
	const emailA = `sa${stamp}@example.com`, emailB = `sb${stamp}@example.com`;
	const alice = await signUp(emailA);
	const bob = await signUp(emailB);
	const carol = 'carol_' + stamp;
	const prof = (name, elo) => ({ displayName: name, elo, gamesPlayed: 1, wins: 1, losses: 0, created: stamp });
	const FIN = 'FIN' + String(stamp).slice(-5);
	const TVA = 'TVA' + String(stamp).slice(-5);
	const TVB = 'TVB' + String(stamp).slice(-5);
	const engine = freshEngine();
	const log = await engine.reconstructGameLog(ONLINE.spellNames, 'standard', null, ONLINE.turns);
	const live = (red, blue) => ({
		status: 'playing', created: stamp - 600000, startedAt: stamp - 600000, ranked: true, variant: 'standard', seq: true,
		spellNames: ONLINE.spellNames, allowSpectators: true, timeControl: { type: 'none' }, red, blue,
	});
	await rest('PATCH', '', {
		['users/' + alice]: prof('Alice', 1500),
		['users/' + bob]: prof('Bob', 1400),
		['users/' + carol]: prof('Carol', 1200),
		['admins/' + alice]: true,
		['follows/' + alice + '/' + bob]: true,
		['followers/' + bob + '/' + alice]: true,
		// Bob (red) beat Carol: the finished room, reviewable.
		['rooms/' + FIN]: {
			status: 'finished', created: stamp - 3600000, finishedAt: stamp - 60000, ranked: true, variant: 'standard',
			spellNames: ONLINE.spellNames, allowSpectators: true, timeControl: { type: 'none' },
			red: { uid: bob, displayName: 'Bob', connected: false }, blue: { uid: carol, displayName: 'Carol', connected: false },
			gameLog: ONLINE.turns, winner: ONLINE.winner, finalSfn: log[log.length - 1].sfnAfter, gameId: 'G1',
		},
		// Recorded and rated already, so the emulated recordRoom and rateGame
		// leave these rooms alone (they would rate the seeded games again).
		['completed_games/G1']: { winner: 'red', timestamp: stamp - 60000, eloProcessed: true },
		['completed_games/GA']: { winner: 'red', timestamp: stamp, eloProcessed: true },
		// Two live games: Alice v Bob (1450 on average) and Carol v a guest.
		['rooms/' + TVA]: Object.assign(live({ uid: alice, displayName: 'Alice', connected: true }, { uid: bob, displayName: 'Bob', connected: true }), { gameId: 'GA' }),
		['rooms/' + TVB]: live({ uid: carol, displayName: 'Carol', connected: true }, { uid: 'guest_' + stamp, displayName: 'Guest', anon: true, connected: true }),
		['live_rooms/' + TVA]: true,
		['live_rooms/' + TVB]: true,
	});
	if (ONLINE.winner !== 'red') throw new Error('fixture: expected a red win');

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const errors = [];
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && !!cond; };
	try {
		const newPage = async (name) => {
			const ctx = await browser.createBrowserContext();
			const p = await ctx.newPage();
			await p.evaluateOnNewDocument(useEmulators, Number(DB_HOST.split(':')[1]), AUTH_HOST);
			await p.setBypassServiceWorker(true);
			await p.setRequestInterception(true);
			p.on('request', (req) => {
				const url = req.url();
				if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
				sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
			});
			p.on('pageerror', (e) => { errors.push(name + ': ' + e.message); console.log('pageerror (' + name + '):', e.message); });
			p.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warn' && /\[(Profile|Bookmark|TV)\]/.test(m.text()))) console.log('console.' + m.type() + ' (' + name + '):', m.text().slice(0, 300)); });
			p.on('dialog', (d) => d.accept());
			return p;
		};
		const signIn = async (p, email) => {
			await p.waitForFunction(() => typeof firebase !== 'undefined' && firebase.apps.length > 0, { timeout: 30000, polling: 250 });
			await p.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), email);
			await p.waitForFunction(() => window.SigilFriends && SigilFriends.uid, { timeout: 30000, polling: 250 });
		};
		const signedIn = (p) => p.waitForFunction(() => window.SigilFriends && SigilFriends.uid, { timeout: 30000, polling: 250 });
		const attempt = (p, code) => p.evaluate(new Function('return (' + code + ').then(() => "ok", (e) => String(e && (e.code || e.message)))'));
		const pageA = await newPage('alice');
		const pageB = await newPage('bob');
		const pageG = await newPage('guest');

		// ---- 1. The server writes the feed and the badges
		await rest('PUT', 'user_games/' + bob + '/G1', {
			timestamp: stamp - 60000, roomCode: FIN, gameId: 'G1', opponent: 'Carol', opponentUid: carol, opponentIsAI: false,
			color: 'red', result: 'win', fromPosition: false, rated: true, eloBefore: 1384, eloAfter: 1400, eloChange: 16, opponentEloBefore: 1216,
		});
		const win = await until(() => rest('GET', 'activity/' + bob + '/w_G1'), 90000);
		check('socialGame posts Bob\'s win', win && win.t === 'win' && win.oppName === 'Carol' && win.game === FIN && win.change === 16, win);
		const badge = await until(() => rest('GET', 'badges/' + bob + '/first-win'), 20000);
		check('and awards First Win', badge && typeof badge.at === 'number', badge);
		const today = new Date().toISOString().slice(0, 10);
		await rest('PUT', 'users/' + bob + '/puzzleProgress/daily/' + today, 'solved');
		const streak = await until(() => rest('GET', 'achievements/' + bob + '/puzzleStreak'), 30000);
		check('socialPuzzle counts the daily puzzle', streak && streak.n === 1 && streak.day === today, streak);

		await pageB.goto(`${BASE}/feed.html`, { waitUntil: 'load', timeout: 90000 });
		await signIn(pageB, emailB);
		const forged = await attempt(pageB, `firebase.database().ref('activity/${bob}/w_X').set({ t: 'win', at: Date.now(), oppName: 'Magnus' })`);
		const forgedBadge = await attempt(pageB, `firebase.database().ref('badges/${bob}/tournament-win').set({ at: Date.now() })`);
		check('a client cannot post activity or award itself a badge', forged !== 'ok' && forgedBadge !== 'ok', { forged, forgedBadge });

		await pageA.goto(`${BASE}/feed.html`, { waitUntil: 'load', timeout: 90000 });
		await signIn(pageA, emailA);
		const feedText = await until(() => pageA.evaluate(() => {
			const li = [...document.querySelectorAll('[data-testid="feed-list"] li')].find((x) => / beat /.test(x.textContent));
			return li ? li.textContent.replace(/\s+/g, ' ').trim() : '';
		}), 20000);
		check('Alice\'s feed shows Bob\'s win', /^Bob beat Carol \(\+16, now 1400\) · review/.test(feedText), feedText);
		const guestFeed = await (async () => {
			await pageG.goto(`${BASE}/feed.html`, { waitUntil: 'load', timeout: 90000 });
			return until(() => pageG.evaluate(() => {
				const el = document.querySelector('[data-testid="feed-signed-out"]');
				return el && getComputedStyle(el).display !== 'none';
			}), 15000);
		})();
		check('a guest is asked to sign in for a feed', guestFeed);

		// ---- 2. A private note; Bob's badge and activity
		await pageA.goto(`${BASE}/profile.html?uid=${bob}`, { waitUntil: 'load', timeout: 90000 });
		await signedIn(pageA);
		await pageA.waitForSelector('[data-testid="private-note"] textarea', { visible: true, timeout: 30000 });
		await pageA.type('[data-testid="private-note"] textarea', 'Opens with Meteor. Rematches gladly.');
		await pageA.click('[data-testid="save-note"]');
		const note = await until(() => rest('GET', 'notes/' + alice + '/' + bob), 15000);
		check('the note is saved under Alice\'s notes', note && note.text === 'Opens with Meteor. Rematches gladly.' && typeof note.at === 'number', note);
		const peek = await attempt(pageB, `firebase.database().ref('notes/${alice}/${bob}').once('value')`);
		const peekAll = await attempt(pageB, `firebase.database().ref('notes/${alice}').once('value')`);
		check('Bob cannot read Alice\'s note on him', peek !== 'ok' && peekAll !== 'ok', { peek, peekAll });
		const prof1 = await until(() => pageA.evaluate(() => {
			const chip = document.querySelector('[data-testid="profile-badges"] [data-badge="first-win"]');
			return chip ? { chip: chip.textContent.trim() } : null;
		}), 15000);
		check('Bob\'s profile shows his badge', prof1 && /First Win/.test(prof1.chip), prof1);
		await pageA.click('#tab-activity');
		const act = await until(() => pageA.evaluate(() => {
			const li = document.querySelector('[data-testid="profile-activity"] li');
			return li && li.offsetParent ? li.textContent.replace(/\s+/g, ' ').trim() : '';
		}), 10000);
		check('and his recent activity', /Bob (beat Carol|earned a badge)/.test(act), act);

		// ---- 3. Bookmarks
		await pageA.click('#tab-games');
		await pageA.waitForSelector(`.bookmark-star[data-room="${FIN}"]`, { visible: true, timeout: 15000 });
		await pageA.click(`.bookmark-star[data-room="${FIN}"]`);
		const bm = await until(() => rest('GET', 'bookmarks/' + alice + '/' + FIN), 15000);
		check('the star bookmarks the game', bm && bm.title === 'Bob vs Carol', { bm, url: pageA.url() });
		const star = await until(() => pageA.evaluate((r) => { const el = document.querySelector(`.bookmark-star[data-room="${r}"]`); return !!el && el.textContent === '★'; }, FIN), 5000);
		check('and the star fills', star);
		const peekBm = await attempt(pageB, `firebase.database().ref('bookmarks/${alice}').once('value')`);
		check('Bob cannot read Alice\'s bookmarks', peekBm !== 'ok', peekBm);
		await pageA.goto(`${BASE}/profile.html?uid=${alice}#saved`, { waitUntil: 'load', timeout: 90000 });
		await signedIn(pageA);
		const saved = await until(() => pageA.evaluate((r, b) => {
			const tab = document.querySelector('[data-testid="saved-tab"]');
			const row = document.querySelector(`[data-bookmark="${r}"]`);
			const n = document.querySelector(`[data-note="${b}"]`);
			return tab && row && n && getComputedStyle(tab).display !== 'none'
				? { bm: row.querySelector('a').textContent, note: n.querySelector('textarea').value, name: n.querySelector('a').textContent } : null;
		}, FIN, bob), 20000);
		check('Alice\'s Saved tab lists the bookmark and the note', saved && saved.bm === 'Bob vs Carol' && saved.name === 'Bob' && /Meteor/.test(saved.note), saved);
		const otherSaved = await pageA.evaluate(() => !!document.querySelector('#tab-saved'));
		check('the Saved tab is on her own profile', otherSaved);
		await pageA.goto(`${BASE}/multiplayer.html?id=${FIN}`, { waitUntil: 'load', timeout: 90000 });
		await signedIn(pageA);
		const reviewBtn = await until(() => pageA.evaluate(() => {
			const b = document.querySelector('.review-bar .bookmark-btn');
			return b && b.offsetParent && b.textContent.trim() === '★' ? b.getAttribute('aria-pressed') : null;
		}), 30000);
		check('the review page shows the game bookmarked', reviewBtn === 'true', reviewBtn);
		await pageA.click('.review-bar .bookmark-btn');
		const gone = await until(async () => (await rest('GET', 'bookmarks/' + alice + '/' + FIN)) === null, 10000);
		const unstar = await pageA.evaluate(() => document.querySelector('.review-bar .bookmark-btn').textContent.trim());
		check('and its Bookmark button removes it', gone && unstar === '☆', unstar);

		// ---- 4. Events and announcements
		await pageA.goto(`${BASE}/admin.html`, { waitUntil: 'load', timeout: 90000 });
		await signedIn(pageA);
		await pageA.waitForSelector('[data-testid="admin-events-tab"]', { visible: true, timeout: 30000 });
		await pageA.click('[data-testid="admin-events-tab"]');
		await pageA.waitForSelector('[data-testid="event-title"]', { visible: true, timeout: 10000 });
		await pageA.type('[data-testid="event-title"]', 'Friday Blitz Arena ' + stamp);
		await pageA.click('[data-testid="event-post"]');
		const posted = await until(async () => {
			const all = (await rest('GET', 'site_events')) || {};
			return Object.entries(all).find(([, v]) => v.title === 'Friday Blitz Arena ' + stamp);
		}, 15000);
		check('an admin posts an event', posted && posted[1].kind === 'event' && posted[1].by === alice && posted[1].endsAt > posted[1].startsAt, posted && posted[1]);
		const evId = posted && posted[0];
		const refused = await attempt(pageB, `firebase.database().ref('site_events').push({ kind: 'announcement', title: 'Free Elo', startsAt: Date.now(), endsAt: Date.now() + 86400000, by: '${bob}', at: firebase.database.ServerValue.TIMESTAMP })`);
		check('a player cannot post one', refused !== 'ok', refused);
		await pageG.goto(`${BASE}/index.html`, { waitUntil: 'load', timeout: 90000 });
		const banner = await until(() => pageG.evaluate(() => {
			const b = document.getElementById('site-event-banner');
			return b ? b.textContent : '';
		}), 20000);
		check('a guest sees the banner on the menu', banner.includes('Friday Blitz Arena ' + stamp) && /Starts in/.test(banner), banner);
		await pageG.click('#site-event-banner .site-event-banner__close');
		const closed = await pageG.evaluate(() => !document.getElementById('site-event-banner'));
		await pageG.reload({ waitUntil: 'load', timeout: 90000 });
		await sleep(3000);
		const stillClosed = await pageG.evaluate(() => !document.getElementById('site-event-banner'));
		check('a dismissed banner stays dismissed', closed && stillClosed);
		await pageG.goto(`${BASE}/events.html#${evId}`, { waitUntil: 'load', timeout: 90000 });
		const listed = await until(() => pageG.evaluate((id) => {
			const card = document.querySelector(`[data-section="upcoming"] [data-event="${id}"]`);
			return card ? card.textContent.replace(/\s+/g, ' ') : '';
		}, evId), 20000);
		check('events.html lists the event as coming up', listed.includes('Friday Blitz Arena') && /Add to calendar/.test(listed), listed);

		// ---- 5. A verified title
		// (Still on admin.html: a goto to #titles would only change the hash.)
		await pageA.click('[data-testid="admin-titles-tab"]');
		await pageA.waitForSelector('[data-testid="title-who"]', { visible: true, timeout: 30000 });
		await pageA.type('[data-testid="title-who"]', bob);
		await pageA.type('[data-testid="title-text"]', 'Site Champion');
		await pageA.click('[data-testid="title-grant"]');
		const title = await until(() => rest('GET', 'titles/' + bob), 15000);
		check('an admin grants a title', title && title.title === 'Site Champion' && title.by === alice, title);
		const selfTitle = await attempt(pageB, `firebase.database().ref('titles/${bob}').set({ title: 'Grandmaster', by: '${bob}', at: firebase.database.ServerValue.TIMESTAMP })`);
		check('a player cannot title themselves', selfTitle !== 'ok', selfTitle);
		await pageG.goto(`${BASE}/profile.html?uid=${bob}`, { waitUntil: 'load', timeout: 90000 });
		const shown = await until(() => pageG.evaluate(() => {
			const t = document.querySelector('[data-testid="profile-title"]');
			return t && t.offsetParent ? t.textContent.trim() : '';
		}), 20000);
		check('the title shows on the profile', shown === 'Site Champion', shown);
		const guestNote = await pageG.evaluate(() => {
			const n = document.querySelector('[data-testid="private-note"]');
			return !n || getComputedStyle(n).display === 'none';
		});
		check('a guest gets no note box', guestNote);

		// ---- 6. Streamers
		await pageB.goto(`${BASE}/streamers.html`, { waitUntil: 'load', timeout: 90000 });
		await signedIn(pageB);
		await pageB.waitForSelector('[data-testid="streamer-url"]', { visible: true, timeout: 30000 });
		await pageB.type('[data-testid="streamer-url"]', 'https://example.com/twitch.tv/bob_plays');
		await pageB.click('[data-testid="streamer-save"]');
		await sleep(500);
		const badUrl = await pageB.evaluate(() => document.querySelector('.streamers-form__error').textContent);
		check('a non-channel URL is refused', /Twitch channel/.test(badUrl) && (await rest('GET', 'streamers/' + bob)) === null, badUrl);
		await pageB.evaluate(() => { document.querySelector('[data-testid="streamer-url"]').value = ''; });
		await pageB.type('[data-testid="streamer-url"]', 'twitch.tv/bob_plays/');
		await pageB.click('[data-testid="streamer-save"]');
		const listing = await until(() => rest('GET', 'streamers/' + bob), 15000);
		check('a channel is stored in its canonical form', listing && listing.url === 'https://www.twitch.tv/bob_plays', listing);
		await pageB.waitForSelector('[data-testid="streamer-live"]', { visible: true, timeout: 10000 });
		await pageB.click('[data-testid="streamer-live"]');
		const liveUntil = await until(async () => { const v = await rest('GET', 'streamers/' + bob + '/liveUntil'); return typeof v === 'number' ? v : null; }, 10000);
		check('"I\'m live now" sets a live marker that expires', liveUntil > Date.now() && liveUntil <= Date.now() + 12 * 3600000, liveUntil);
		const rawBad = await attempt(pageB, `firebase.database().ref('streamers/${bob}/url').set('https://evil.example/x')`);
		check('the rules refuse a non-channel URL too', rawBad !== 'ok', rawBad);
		await pageG.goto(`${BASE}/streamers.html`, { waitUntil: 'load', timeout: 90000 });
		const row = await until(() => pageG.evaluate((b) => {
			const first = document.querySelector('.streamer');
			if (!first || first.dataset.uid !== b) return null;
			const liveEl = first.querySelector('.streamer__live');
			return { live: !!liveEl && getComputedStyle(liveEl).display !== 'none', href: first.querySelector('.streamer__channel').href,
				rel: first.querySelector('.streamer__channel').rel, name: first.querySelector('.streamer__name').textContent, title: first.querySelector('.title-chip').textContent };
		}, bob), 20000);
		check('the guest sees Bob first, live, with his channel', row && row.live && row.href === 'https://www.twitch.tv/bob_plays' && /noopener/.test(row.rel) && row.name === 'Bob' && row.title === 'Site Champion', row);
		await pageG.goto(`${BASE}/profile.html?uid=${bob}`, { waitUntil: 'load', timeout: 90000 });
		const streamLink = await until(() => pageG.evaluate(() => {
			const el = document.querySelector('[data-testid="profile-streamer"] a');
			return el ? el.href : '';
		}), 15000);
		check('and on his profile', streamLink === 'https://www.twitch.tv/bob_plays', streamLink);

		// ---- 7. Sigil TV
		await pageG.goto(`${BASE}/tv.html`, { waitUntil: 'load', timeout: 90000 });
		const frameSrc = () => pageG.evaluate(() => {
			const f = document.querySelector('[data-testid="tv-frame"]');
			return f ? f.getAttribute('src') || '' : '';
		});
		const first = await until(async () => (await frameSrc()).includes(TVA), 30000);
		const match = await pageG.evaluate(() => document.querySelector('[data-testid="tv-match"]').textContent.replace(/\s+/g, ' ').trim());
		check('TV shows the top-rated live game', first && /Alice \(1500\) vs Bob \(1400\)/.test(match), { src: await frameSrc(), match });
		const also = await until(() => pageG.evaluate((c) => !!document.querySelector(`.tv-list__row[data-code="${c}"]`), TVB), 10000);
		check('with the other game under "Also live"', also);
		const embedded = await until(async () => {
			const f = pageG.frames().find((fr) => fr.url().includes('tv=1'));
			if (!f) return null;
			return f.evaluate(() => {
				const h = document.querySelector('body > header');
				return document.documentElement.classList.contains('tv-embed') && (!h || getComputedStyle(h).display === 'none') ? 'embedded' : null;
			}).catch(() => null);
		}, 30000);
		check('the game is framed without the site header', embedded === 'embedded', embedded);
		await rest('PATCH', 'rooms/' + TVA, { status: 'finished', winner: 'red', endReason: 'forfeit', forfeitedBy: 'blue' });
		const overlay = await until(() => pageG.evaluate(() => {
			const o = document.querySelector('[data-testid="tv-overlay"]');
			return o && getComputedStyle(o).display !== 'none' ? o.textContent.replace(/\s+/g, ' ').trim() : '';
		}), 15000);
		check('when it ends, the result shows', /Red wins: Alice/.test(overlay), overlay);
		const next = await until(async () => (await frameSrc()).includes(TVB), 20000);
		check('and TV switches to the next game', next, await frameSrc());

		check('no page errors', errors.length === 0, errors);
	} catch (e) {
		console.log('FAIL exception', e && e.stack || e);
		ok = false;
	} finally {
		await browser.close();
	}
	console.log(ok ? 'PASS' : 'FAILED');
	process.exit(ok ? 0 : 1);
})();
