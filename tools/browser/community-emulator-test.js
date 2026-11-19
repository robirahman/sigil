// Messages, the inbox, forums, blogs, teams and their moderation on the
// Firebase emulators (rules and functions; no live database), with three
// signed-in players in separate browser contexts (Carol is an admin):
//   1. Alice messages Bob from his profile; Bob's header shows "Inbox (1)",
//      he reads it (as text: an <img onerror> stays text) and replies; he
//      reports a message and Carol reads that conversation, and only that,
//      on admin-community.html.
//   2. Bob follows Alice: her inbox lists it (functions: inboxFollow).
//   3. Alice starts a forum thread in Markdown with script and javascript:
//      links in it: bold renders, nothing runs, no script link. Bob replies,
//      edits and removes his post; the reply count and Alice's inbox entry
//      come from the server; Carol locks the thread and Bob's reply box goes.
//   4. Alice blogs; Bob comments; Alice is told.
//   5. Alice founds a closed team; Bob asks to join; Alice admits him; the
//      member count comes from the server. A seeded team battle shows its
//      standings. Alice disbands the team (callable).
//   6. A guest sees the forum and the blog but no reply box or inbox.
//
//   (served from docs/ on BASE)
//   cd functions && firebase emulators:exec --only auth,database,functions --project demo-sigil \
//     'node ../tools/browser/community-emulator-test.js http://localhost:8808'
// A private emulator config: FN_PORT=<functions port> as well.
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8808';
const NS = 'sigil-js-default-rtdb';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const EMU = { db: DB_HOST, auth: AUTH_HOST, fn: Number(process.env.FN_PORT || 5001), project: process.env.GCLOUD_PROJECT || 'demo-sigil' };
const DB = 'http://' + DB_HOST;
const OWNER = { Authorization: 'Bearer owner' };

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
const XSS_IMG = '<img src=x onerror="window.__xss=1">';
const XSS_POST = 'Hello **world**\n\n<script>window.__xss=1</script>\n\n[click me](javascript:window.__xss=1) and [safe](https://example.com)\n\n' + XSS_IMG;

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: OWNER, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const stamp = Date.now();
	const emails = { alice: `ca${stamp}@example.com`, bob: `cb${stamp}@example.com`, carol: `cc${stamp}@example.com` };
	const alice = await signUp(emails.alice);
	const bob = await signUp(emails.bob);
	const carol = await signUp(emails.carol);
	const prof = (name) => ({ displayName: name, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: stamp });
	await rest('PATCH', '', {
		['users/' + alice]: prof('Alice'), ['users/' + bob]: prof('Bob'), ['users/' + carol]: prof('Carol'),
		['admins/' + carol]: true,
	});

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && !!cond; };
	const until = async (fn, ms) => {
		let v;
		for (let t = 0; t < (ms || 20000); t += 250) {
			v = await fn();
			if (v) return v;
			await sleep(250);
		}
		return v;
	};
	const pageErrors = [];
	try {
		const newPage = async (who) => {
			const ctx = await browser.createBrowserContext();
			const p = await ctx.newPage();
			await p.evaluateOnNewDocument(useEmulators, EMU);
			await p.setBypassServiceWorker(true);
			await p.setRequestInterception(true);
			p.on('request', (req) => {
				const url = req.url();
				if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
				sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
			});
			p.on('pageerror', (e) => { pageErrors.push(who + ': ' + e.message); console.log('pageerror (' + who + '):', e.message); });
			p.on('console', (m) => { if (m.type() === 'error') console.log('console.error (' + who + '):', m.text()); });
			p.on('dialog', (d) => d.accept());
			return p;
		};
		const signIn = async (p, email) => {
			await p.waitForFunction(() => typeof firebase !== 'undefined' && firebase.apps.length > 0, { timeout: 30000, polling: 250 });
			await p.evaluate((e) => firebase.auth().signInWithEmailAndPassword(e, 'password123'), email);
			await p.waitForFunction(() => firebase.auth().currentUser && !firebase.auth().currentUser.isAnonymous, { timeout: 30000, polling: 250 });
		};
		const go = async (p, url) => { await p.goto(BASE + '/' + url, { waitUntil: 'load', timeout: 90000 }); };
		const text = (p, sel) => p.evaluate((s) => Array.from(document.querySelectorAll(s)).map((e) => e.textContent.replace(/\s+/g, ' ').trim()), sel);
		const type = async (p, sel, value) => {
			await p.waitForSelector(sel, { visible: true, timeout: 20000 });
			await p.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
		};
		const click = async (p, sel) => {
			await p.waitForSelector(sel, { visible: true, timeout: 20000 });
			await p.$eval(sel, (el) => el.click());
		};

		const pageA = await newPage('alice');
		const pageB = await newPage('bob');
		const pageC = await newPage('carol');
		const pageG = await newPage('guest');

		// ---- 1. Messages ----
		await go(pageA, 'profile.html?uid=' + bob);
		await signIn(pageA, emails.alice);
		await pageA.waitForSelector('.profile__message', { visible: true, timeout: 30000 });
		const href = await pageA.$eval('.profile__message', (a) => a.getAttribute('href'));
		check('the profile has Message', href === 'inbox.html?tab=messages&to=' + bob, href);
		await go(pageA, href);
		await pageA.waitForSelector('[data-testid="compose"]', { visible: true, timeout: 30000 });
		await type(pageA, '[data-testid="compose"]', 'Hi Bob! ' + XSS_IMG);
		await click(pageA, '[data-testid="send"]');
		const cid = alice < bob ? alice + '_' + bob : bob + '_' + alice;
		const sent = await until(async () => {
			const m = await rest('GET', 'dm_messages/' + cid);
			return m && Object.keys(m).length ? m : null;
		});
		check('the first message is stored with its conversation', !!sent && !!(await rest('GET', 'dm_convos/' + cid)), sent);
		check('Alice sees her message', !!(await until(async () => (await text(pageA, '[data-testid="message"]')).some((t) => t.includes('Hi Bob!')))));

		await go(pageB, 'index.html');
		await signIn(pageB, emails.bob);
		const badge = await until(() => pageB.evaluate(() => { const a = document.querySelector('.auth-status__inbox'); return a ? a.textContent : null; }), 30000);
		check('Bob\'s header shows the unread message', badge === 'Inbox (1)', badge);
		await go(pageB, 'inbox.html?tab=messages');
		await pageB.waitForSelector('[data-testid="convo"]', { visible: true, timeout: 30000 });
		check('the conversation is unread', await pageB.$eval('[data-testid="convo"]', (b) => b.classList.contains('dm__item--unread')));
		await click(pageB, '[data-testid="convo"]');
		const bobSees = await until(async () => (await text(pageB, '[data-testid="message"]')).find((t) => t.includes('Hi Bob!')));
		check('Bob reads it, the <img> as text', !!bobSees && bobSees.includes('<img src=x'), bobSees);
		check('nothing ran', await pageB.evaluate(() => window.__xss === undefined && !document.querySelector('.dm__msgs img')));
		check('opening it marks it read', !!(await until(async () => {
			const e = await rest('GET', 'dm_index/' + bob + '/' + cid);
			return e && e.read >= e.last;
		})));
		await type(pageB, '[data-testid="compose"]', 'Hello Alice');
		await click(pageB, '[data-testid="send"]');
		check('Alice gets the reply live', !!(await until(async () => (await text(pageA, '[data-testid="message"]')).some((t) => t.includes('Hello Alice')))));
		// Bob reports Alice's message.
		await pageB.evaluate(() => {
			const msg = Array.from(document.querySelectorAll('[data-testid="message"]')).find((m) => m.textContent.includes('Hi Bob!'));
			msg.querySelector('button').click();
		});
		await pageB.waitForSelector('[data-testid="content-report"].is-visible', { timeout: 10000 });
		await pageB.select('#content-report-reason', 'abuse');
		await click(pageB, '[data-testid="content-report"] .report-dialog__btn--send');
		const reports = await until(async () => rest('GET', 'content_reports'));
		const rep = reports && Object.values(reports)[0];
		check('the report names the message and its sender', !!rep && rep.kind === 'dm' && rep.target === alice && rep.conv === cid && rep.reason === 'abuse', rep);
		check('and flags the conversation for the admins', !!(await rest('GET', 'dm_flags/' + cid)));

		await go(pageC, 'admin-community.html');
		await signIn(pageC, emails.carol);
		await pageC.waitForSelector('[data-testid="content-report-card"]', { visible: true, timeout: 30000 });
		await click(pageC, '[data-testid="show-conversation"]');
		const convo = await until(async () => (await text(pageC, '[data-testid="conversation"]')).join(' '));
		check('the admin reads the reported conversation', !!convo && convo.includes('Hi Bob!') && convo.includes('Hello Alice'), convo);
		const peek = await pageC.evaluate(async () => {
			try { await firebase.database().ref('dm_messages/nobody_else').once('value'); return 'read'; } catch (e) { return 'refused'; }
		});
		check('but no other conversation', peek === 'refused', peek);
		await click(pageC, '[data-testid="mute"]');
		const mute = await until(async () => rest('GET', 'community_mutes/' + alice));
		check('muting the writer resolves the report', !!mute && mute.until > Date.now() && mute.by === carol, mute);
		await rest('DELETE', 'community_mutes/' + alice);

		// ---- 2. A follow reaches the inbox (server) ----
		await pageB.evaluate((a) => SigilFriends.follow(a), alice);
		await go(pageA, 'inbox.html');
		const followNote = await until(async () => (await text(pageA, '[data-testid="note"]')).find((t) => t.includes('started following you') && t.includes('Bob')), 45000);
		check('Alice\'s inbox lists the new follower', !!followNote && followNote.includes('Bob'), followNote);

		// ---- 3. Forums ----
		await go(pageA, 'forum.html?c=general');
		await click(pageA, '[data-testid="new-thread"]');
		await type(pageA, '[data-testid="thread-title"]', 'Best opening?');
		await type(pageA, '[data-testid="thread-body"]', XSS_POST);
		await click(pageA, '[data-testid="post-thread"]');
		await pageA.waitForFunction(() => /[?&]t=/.test(location.search), { timeout: 30000 });
		const tid = new URL(pageA.url()).searchParams.get('t');
		await pageA.waitForSelector('[data-testid="post-body"]', { visible: true, timeout: 30000 });
		const body = await pageA.$eval('[data-testid="post-body"]', (el) => ({
			strong: el.querySelector('strong') && el.querySelector('strong').textContent,
			scripts: el.querySelectorAll('script, img, iframe').length,
			hrefs: Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href')),
			text: el.textContent,
		}));
		check('the post renders its Markdown', body.strong === 'world', body);
		check('script and img stay text; no javascript: link', body.scripts === 0 && body.text.includes('<script>') && body.hrefs.every((h) => /^https:/.test(h)), body);
		check('nothing ran in the forum', await pageA.evaluate(() => window.__xss === undefined));

		// The server has seen the first post (replies: 0) before the reply
		// comes: the emulator starts a worker per event in flight, and on a
		// busy machine a second cold start can fail.
		check('the server counts no replies yet', (await until(async () => (await rest('GET', 'forum_threads/general/' + tid + '/replies')) === 0 ? 'zero' : null, 60000)) === 'zero');
		await go(pageB, 'forum.html?c=general&t=' + tid);
		await type(pageB, '[data-testid="reply-body"]', 'I like *Sprout*.');
		await click(pageB, '[data-testid="post-reply"]');
		check('the reply shows', !!(await until(async () => (await text(pageB, '[data-testid="post-body"]')).some((t) => t.includes('I like Sprout')))));
		check('the server counts the reply', (await until(async () => rest('GET', 'forum_threads/general/' + tid + '/replies'), 45000)) === 1);
		await go(pageA, 'inbox.html');
		const replyNote = await until(async () => (await text(pageA, '[data-testid="note"]')).find((t) => t.includes('replied in') && t.includes('Bob')), 45000);
		check('Alice is told of the reply', !!replyNote && replyNote.includes('Bob') && replyNote.includes('Best opening?'), replyNote);
		// Bob edits, then removes, his post.
		await pageB.evaluate(() => {
			const posts = Array.from(document.querySelectorAll('[data-testid="post"]'));
			posts[1].querySelector('[data-testid="edit"]').click();
		});
		await type(pageB, '[data-testid="edit-body"]', 'I like **Sprout** and Charge.');
		await click(pageB, '[data-testid="save-edit"]');
		check('an edit shows, marked edited', !!(await until(async () => (await text(pageB, '[data-testid="post"]')).some((t) => t.includes('Sprout and Charge') && t.includes('edited')))));
		await pageB.evaluate(() => Array.from(document.querySelectorAll('[data-testid="post"]'))[1].querySelector('[data-testid="remove"]').click());
		check('a removed post keeps its place, without its text', !!(await until(async () => (await text(pageB, '[data-testid="post"]')).some((t) => t.includes('Removed by its author')))));
		// The admin locks the thread; Bob can no longer reply.
		await go(pageC, 'forum.html?c=general&t=' + tid);
		await click(pageC, '[data-testid="lock"]');
		check('the lock is stored', (await until(async () => rest('GET', 'forum_threads/general/' + tid + '/locked'))) === true);
		check('Bob\'s reply box goes', !!(await until(() => pageB.evaluate(() => !document.querySelector('[data-testid="reply-body"]')))));

		// ---- 4. Blogs ----
		await go(pageA, 'blog.html?new=1');
		await type(pageA, '[data-testid="draft-title"]', 'My first Sigil tournament');
		await type(pageA, '[data-testid="draft-body"]', '## Round one\n\nI won with **Fireblast**.\n\n' + XSS_IMG);
		check('a player cannot post on the site blog', await pageA.evaluate(() => getComputedStyle(document.querySelector('[data-testid="draft-site"]').closest('label')).display === 'none'));
		await click(pageA, '[data-testid="publish"]');
		await pageA.waitForFunction(() => /[?&]p=/.test(location.search), { timeout: 30000 });
		const pid = new URL(pageA.url()).searchParams.get('p');
		await pageA.waitForSelector('[data-testid="post-body"] h4', { timeout: 30000 });
		const blogBody = await pageA.$eval('[data-testid="post-body"]', (el) => ({ h: el.querySelector('h4').textContent, imgs: el.querySelectorAll('img').length, text: el.textContent }));
		check('the blog post renders, its <img> as text', blogBody.h === 'Round one' && blogBody.imgs === 0 && blogBody.text.includes('<img'), blogBody);
		await go(pageB, 'blog.html?p=' + pid);
		await type(pageB, '[data-testid="comment-body"]', 'Congratulations!');
		await click(pageB, '[data-testid="add-comment"]');
		check('the comment shows', !!(await until(async () => (await text(pageB, '[data-testid="comment-text"]')).includes('Congratulations!'))));
		await go(pageA, 'inbox.html');
		const blogNote = await until(async () => (await text(pageA, '[data-testid="note"]')).find((t) => t.includes('commented on') && t.includes('Bob')), 45000);
		check('Alice is told of the comment', !!blogNote && blogNote.includes('My first Sigil tournament'), blogNote);
		await go(pageG, 'blog.html');
		await pageG.waitForFunction(() => typeof firebase !== 'undefined' && firebase.apps.length > 0, { timeout: 30000, polling: 250 });
		await pageG.evaluate(() => firebase.auth().signInAnonymously());
		const listed = await until(async () => (await text(pageG, '[data-testid="user-post"]')).find((t) => t.includes('My first Sigil tournament')));
		check('guests read the blog', !!listed, listed);
		check('guests get no Write button', await pageG.evaluate(() => getComputedStyle(document.querySelector('[data-testid="write-post"]')).display === 'none'));
		await go(pageG, 'forum.html?c=general&t=' + tid);
		await pageG.waitForSelector('[data-testid="post-body"]', { timeout: 30000 });
		check('guests read the forum but get no reply box', await pageG.evaluate(() => !document.querySelector('[data-testid="reply-body"]')));
		await go(pageG, 'inbox.html');
		await pageG.waitForFunction(() => typeof firebase !== 'undefined' && firebase.apps.length > 0, { timeout: 30000, polling: 250 });
		await pageG.evaluate(() => firebase.auth().signInAnonymously());
		check('a guest has no inbox', !!(await until(() => pageG.evaluate(() => getComputedStyle(document.querySelector('[data-testid="inbox-signed-out"]')).display !== 'none'))));

		// ---- 5. Teams ----
		await go(pageA, 'teams.html');
		await click(pageA, '[data-testid="create-team"]');
		await type(pageA, '[data-testid="team-name"]', 'Red Stones');
		check('the address follows the name', (await pageA.$eval('[data-testid="team-id"]', (e) => e.value)) === 'red-stones');
		await pageA.evaluate(() => { const box = Array.from(document.querySelectorAll('.cm-check input')).find((i) => /Anyone may join/.test(i.closest('label').textContent)); if (box.checked) box.click(); });
		await click(pageA, '[data-testid="save-team"]');
		await pageA.waitForFunction(() => /[?&]id=red-stones/.test(location.search), { timeout: 30000 });
		await pageA.waitForSelector('[data-testid="team-heading"]', { timeout: 30000 });
		const team = await rest('GET', 'teams/red-stones');
		check('the team is founded, closed, with Alice its leader', !!team && team.leader === alice && team.open === false, team);
		await go(pageB, 'teams.html?id=red-stones');
		await click(pageB, '[data-testid="ask"]');
		await click(pageB, '[data-testid="send-ask"]');
		check('Bob\'s request is stored', !!(await until(async () => rest('GET', 'team_requests/red-stones/' + bob))));
		await go(pageA, 'teams.html?id=red-stones#requests');
		await click(pageA, '[data-testid="admit"]');
		check('admitted: both halves of the membership', !!(await until(async () => (await rest('GET', 'team_members/red-stones/' + bob)) && (await rest('GET', 'user_teams/' + bob + '/red-stones')))));
		check('the server counts the members', (await until(async () => (await rest('GET', 'teams/red-stones/memberCount')) === 2 ? 2 : null, 45000)) === 2);
		check('Bob is told he is in', !!(await until(async () => {
			const n = await rest('GET', 'notifications/' + bob + '/team-red-stones');
			return n && n.event === 'accepted';
		}, 45000)));
		// A battle in progress, scored by the server earlier.
		const now = Date.now();
		await rest('PATCH', '', {
			'teams/blue-moons': { name: 'Blue Moons', leader: carol, created: now, open: true },
			['team_members/blue-moons/' + carol]: { role: 'leader', joined: now, by: carol },
			['user_teams/' + carol + '/blue-moons']: true,
			'team_battles/tb1': { name: 'Stones vs Moons', host: 'red-stones', by: alice, created: now - 60000, start: now - 60000, end: now + 3600000, topN: 3, teams: { 'red-stones': 'accepted', 'blue-moons': 'accepted' } },
			'team_battle_scores/tb1/players': { [alice]: { team: 'red-stones', points: 2, games: 3 }, [bob]: { team: 'red-stones', points: 1, games: 1 }, [carol]: { team: 'blue-moons', points: 4, games: 4 } },
		});
		await go(pageG, 'teams.html?battle=tb1');
		await pageG.waitForSelector('[data-testid="standing"]', { timeout: 30000 });
		const standings = await until(async () => {
			const rows = await text(pageG, '[data-testid="standing"]');
			return rows.length === 2 && rows[0].includes('Blue Moons') && rows[1].includes('Red Stones') && rows[1].includes('Alice') ? rows : null;
		});
		check('the battle standings show, best first', !!standings, standings || await text(pageG, '[data-testid="standing"]'));
		check('the battle is running', /on now/.test((await text(pageG, '[data-testid="battle-state"]'))[0] || ''));
		// Disband (the callable).
		await go(pageA, 'teams.html?id=red-stones');
		await pageA.waitForSelector('[data-testid="team-heading"]', { timeout: 30000 });
		await pageA.evaluate(() => Array.from(document.querySelectorAll('.mod-bar button')).find((b) => b.textContent.trim() === 'Disband').click());
		check('disbanding removes the team and its members', !!(await until(async () => !(await rest('GET', 'teams/red-stones')) && !(await rest('GET', 'user_teams/' + bob + '/red-stones')), 45000)));
	} catch (e) {
		console.log('FAIL exception', e.stack || e.message);
		ok = false;
	}
	check('no page errors', pageErrors.length === 0, pageErrors);
	await browser.close();
	console.log(ok ? 'COMMUNITY TEST OK' : 'COMMUNITY TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
