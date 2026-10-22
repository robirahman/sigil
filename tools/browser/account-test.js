// Headless check of docs/account.html's account features with the Firebase
// SDK stubbed out (no network calls to Firebase, nothing written anywhere):
// password reset, guest -> full account upgrade by linking, and account
// deletion (typed confirmation, the deleteUserData callable, re-authentication).
//   node tools/browser/account-test.js <docs dir> [port]
// The gstatic Firebase scripts are answered with an empty body and a fake
// `firebase` global is installed with evaluateOnNewDocument before any page
// script runs. Every SDK call is recorded in window.__calls.
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');

const DOCS = process.argv[2] || 'docs';
const PORT = Number(process.argv[3] || 8791);

function waitPort(port, ms) {
	return new Promise((res, rej) => {
		const t0 = Date.now();
		(function tick() {
			http.get({ host: '127.0.0.1', port, path: '/' }, r => { r.resume(); res(); })
				.on('error', () => Date.now() - t0 > ms ? rej(new Error('server not up')) : setTimeout(tick, 200));
		})();
	});
}

// Runs in the page before any script. `cfg` picks the starting user and
// which calls fail.
function installFakeFirebase(cfg) {
	const calls = window.__calls = [];
	const rec = (name, ...args) => calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
	const err = (code) => { const e = new Error(code); e.code = code; return e; };

	// --- database: a plain in-memory tree ---
	const tree = JSON.parse(JSON.stringify(cfg.db || {}));
	const get = (path) => path.split('/').filter(Boolean).reduce((n, k) => (n && typeof n === 'object') ? n[k] : undefined, tree);
	const put = (path, val) => {
		const ks = path.split('/').filter(Boolean);
		let n = tree;
		for (const k of ks.slice(0, -1)) n = n[k] = (n[k] && typeof n[k] === 'object') ? n[k] : {};
		if (val === null) delete n[ks[ks.length - 1]]; else n[ks[ks.length - 1]] = val;
	};
	const snap = (path) => {
		const v = get(path);
		return {
			key: path.split('/').pop(),
			exists: () => v !== undefined && v !== null,
			val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))),
			forEach: (fn) => { if (v && typeof v === 'object') for (const k of Object.keys(v)) fn(snap(path + '/' + k)); },
		};
	};
	const ref = (path) => {
		path = path || '';
		return {
			child: (c) => ref(path + '/' + c),
			once: async () => {
				rec('db.once', path);
				if (cfg.failReads) throw err('PERMISSION_DENIED');
				return snap(path);
			},
			set: async (v) => {
				rec('db.set', path, v);
				if (cfg.failSets > 0 && (!cfg.failSetPrefix || path.startsWith(cfg.failSetPrefix))) { cfg.failSets--; throw err('PERMISSION_DENIED'); }
				put(path, v);
			},
			remove: async () => { rec('db.remove', path); put(path, null); },
			update: async (u) => {
				rec('db.update', path, u);
				if (cfg.denyUpdate) throw err('PERMISSION_DENIED');
				for (const [k, v] of Object.entries(u)) put((path ? path + '/' : '') + k, v);
			},
			orderByChild: () => ref(path),
		};
	};
	window.__dbTree = tree;

	// --- auth ---
	const listeners = [];
	let current = null;
	const makeUser = (u) => ({
		uid: u.uid, isAnonymous: !!u.isAnonymous, email: u.email || null,
		displayName: u.displayName || null,
		providerData: (u.providers || []).map(p => ({ providerId: p, displayName: u.googleName || null })),
		async updateProfile(p) {
			rec('user.updateProfile', p);
			if (cfg.failUpdateProfile) throw err('auth/network-request-failed');
			Object.assign(this, p);
		},
		async linkWithCredential(c) {
			rec('user.linkWithCredential', c);
			if (cfg.linkError) throw err(cfg.linkError);
			this.isAnonymous = false; this.email = c.email; this.providerData.push({ providerId: 'password' });
			return { user: this };
		},
		async linkWithPopup(p) {
			rec('user.linkWithPopup', p.providerId);
			if (cfg.linkError) { const e = err(cfg.linkError); e.credential = { providerId: 'google.com', token: 'fake' }; throw e; }
			this.isAnonymous = false; this.email = 'g@example.com';
			this.providerData.push({ providerId: 'google.com', displayName: 'GoogleGuy' });
			return { user: this };
		},
		async getIdTokenResult() {
			rec('user.getIdTokenResult');
			return { authTime: new Date(Date.now() - (cfg.authAgeMs || 0)).toUTCString() };
		},
		async reauthenticateWithCredential(c) { rec('user.reauthenticateWithCredential', c); cfg.authAgeMs = 0; },
		async reauthenticateWithPopup(p) { rec('user.reauthenticateWithPopup', p.providerId); cfg.authAgeMs = 0; },
		async delete() {
			rec('user.delete');
			setUser(null);
		},
	});
	const setUser = (u) => {
		current = u;
		auth.currentUser = u;
		for (const l of listeners) setTimeout(() => l(u), 0);
	};
	const auth = {
		currentUser: null,
		onAuthStateChanged(fn) { listeners.push(fn); setTimeout(() => fn(current), 0); return () => {}; },
		async sendPasswordResetEmail(email) { rec('auth.sendPasswordResetEmail', email); if (cfg.resetError) throw err(cfg.resetError); },
		async createUserWithEmailAndPassword(e, p) {
			rec('auth.createUserWithEmailAndPassword', e);
			const u = makeUser({ uid: 'new-uid', email: e, providers: ['password'] });
			setUser(u);
			return { user: u };
		},
		async signInWithEmailAndPassword(e) { rec('auth.signInWithEmailAndPassword', e); throw err('auth/invalid-credential'); },
		async signInWithPopup(p) { rec('auth.signInWithPopup', p.providerId); throw err('auth/popup-closed-by-user'); },
		async signInWithCredential(c) {
			rec('auth.signInWithCredential', c);
			const u = makeUser({ uid: 'google-existing', email: 'g@example.com', displayName: 'Existing', providers: ['google.com'] });
			setUser(u);
			return { user: u };
		},
		async signInAnonymously() { rec('auth.signInAnonymously'); },
		async signOut() { rec('auth.signOut'); setUser(null); },
	};
	if (cfg.user) { current = makeUser(cfg.user); auth.currentUser = current; }

	const authFn = () => auth;
	authFn.EmailAuthProvider = { credential: (email, password) => ({ providerId: 'password', email, password }) };
	authFn.GoogleAuthProvider = function () { this.providerId = 'google.com'; };
	window.firebase = {
		initializeApp: () => ({}),
		auth: authFn,
		database: () => ({ ref }),
		functions: () => ({
			httpsCallable: (name) => async (data) => {
				rec('functions.call', name);
				if (cfg.callableFailures > 0) {
					cfg.callableFailures--;
					// What the compat SDK throws for HttpsError('failed-precondition', ...).
					const e = err('functions/failed-precondition'); e.message = 'requires-recent-login'; throw e;
				}
				if (cfg.callableError) { const e = err('functions/' + cfg.callableError); e.message = 'internal'; throw e; }
				// The server deleted the data and the Auth user.
				return { data: { ok: true } };
			},
		}),
	};
	// Keep the SW out of the way.
	try { Object.defineProperty(navigator, 'serviceWorker', { value: { register: () => Promise.resolve() } }); } catch (e) { /* ignore */ }
}

let failures = 0;
function check(name, ok, detail) {
	console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  ' + JSON.stringify(detail)));
	if (!ok) failures++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function openPage(browser, cfg) {
	const ctx = await browser.createBrowserContext();
	const page = await ctx.newPage();
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.setRequestInterception(true);
	page.on('request', r => {
		const u = r.url();
		if (u.includes('gstatic.com/firebasejs')) r.respond({ status: 200, contentType: 'text/javascript', body: '/* stubbed */' });
		else if (u.includes('typekit') || u.includes('fonts.g')) r.abort();
		else r.continue();
	});
	await page.evaluateOnNewDocument(installFakeFirebase, cfg);
	await page.goto(`http://127.0.0.1:${PORT}/account.html`, { waitUntil: 'networkidle2', timeout: 60000 });
	await page.waitForFunction(() => window.Alpine && !Alpine.$data(document.querySelector('[x-data]')).loading, { timeout: 20000 });
	await sleep(200);
	page.__ctx = ctx;
	page.__errors = errors;
	return page;
}
const calls = (page) => page.evaluate(() => window.__calls);
const state = (page) => page.evaluate(() => {
	const d = Alpine.$data(document.querySelector('[x-data]'));
	return { user: d.user && d.user.uid, guest: d.guest, error: d.error, successMsg: d.successMsg, deleteError: d.deleteError,
		reauthNeeded: d.reauthNeeded, reauthMethod: d.reauthMethod, linkConflict: d.linkConflict,
		profile: d.profile ? JSON.parse(JSON.stringify(d.profile)) : null,
		name: (document.querySelector('.profile-card__name') || {}).textContent };
});
const named = (cs, n) => cs.filter(c => c.name === n);
async function clickText(page, sel, text) {
	await page.evaluate((sel, text) => {
		const b = [...document.querySelectorAll(sel)].find(el => el.textContent.trim() === text && el.offsetParent !== null);
		if (!b) throw new Error('no visible ' + sel + ' "' + text + '"');
		b.click();
	}, sel, text);
	await sleep(300);
}
async function typeInto(page, sel, text) {
	await page.click(sel, { clickCount: 3 });
	await page.type(sel, text);
}

(async () => {
	const srv = spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS], { stdio: 'ignore' });
	let browser;
	try {
		await waitPort(PORT, 15000);
		browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });

		// 1. Password reset.
		{
			const page = await openPage(browser, {});
			await clickText(page, 'button', 'Forgot password?');
			let cs = await calls(page);
			let st = await state(page);
			check('reset: empty email asks for one, no call', named(cs, 'auth.sendPasswordResetEmail').length === 0 && /Enter your email/.test(st.error), st);
			await typeInto(page, '#login-email', 'reset@example.com');
			await clickText(page, 'button', 'Forgot password?');
			cs = await calls(page);
			st = await state(page);
			const r = named(cs, 'auth.sendPasswordResetEmail');
			check('reset: sendPasswordResetEmail called with typed address', r.length === 1 && r[0].args[0] === 'reset@example.com', r);
			check('reset: success message is non-committal', /If an account exists for reset@example\.com/.test(st.successMsg) && !st.error, st);
			check('reset: no page errors', page.__errors.length === 0, page.__errors);
			await page.__ctx.close();
		}
		{
			const page = await openPage(browser, { resetError: 'auth/user-not-found' });
			await typeInto(page, '#login-email', 'nobody@example.com');
			await clickText(page, 'button', 'Forgot password?');
			const st = await state(page);
			check('reset: user-not-found gets the same answer', /If an account exists/.test(st.successMsg) && !st.error, st);
			await page.__ctx.close();
		}
		{
			const page = await openPage(browser, { resetError: 'auth/invalid-email' });
			await typeInto(page, '#login-email', 'bad');
			await clickText(page, 'button', 'Forgot password?');
			const st = await state(page);
			check('reset: invalid-email shows an error', st.error === 'Invalid email address.' && !st.successMsg, st);
			await page.__ctx.close();
		}

		// 2. Guest upgrade by email: links, does not create a new user.
		{
			const page = await openPage(browser, { user: { uid: 'anon-1', isAnonymous: true } });
			let st = await state(page);
			check('guest: logged-out view with guest note', st.guest === true && st.user === null
				&& await page.$eval('[data-testid=guest-note]', el => el.offsetParent !== null), st);
			await clickText(page, '.tab-bar__tab', 'Sign Up');
			await typeInto(page, '#signup-name', 'Upgraded');
			await typeInto(page, '#signup-email', 'up@example.com');
			await typeInto(page, '#signup-password', 'secret123');
			await clickText(page, 'button', 'Create Account');
			await sleep(300);
			const cs = await calls(page);
			st = await state(page);
			const link = named(cs, 'user.linkWithCredential');
			check('guest: linkWithCredential called with the typed email', link.length === 1 && link[0].args[0].email === 'up@example.com', link);
			check('guest: createUserWithEmailAndPassword not called', named(cs, 'auth.createUserWithEmailAndPassword').length === 0);
			const tree = await page.evaluate(() => window.__dbTree);
			check('guest: profile bootstrapped under the same uid', tree.users && tree.users['anon-1'] && tree.users['anon-1'].displayName === 'Upgraded'
				&& tree.leaderboard && tree.leaderboard['anon-1'] && tree.leaderboard['anon-1'].elo === 1000, tree);
			check('guest: page switches to the profile view', st.user === 'anon-1' && st.guest === false && st.profile && st.profile.displayName === 'Upgraded', st);
			const hdr = await page.$eval('#auth-status', el => el.textContent.trim());
			check('guest: header shows the new name, not "Sign in"', hdr === 'Upgraded', hdr);
			check('guest: no page errors', page.__errors.length === 0, page.__errors);
			await page.__ctx.close();
		}
		{
			const page = await openPage(browser, { user: { uid: 'anon-2', isAnonymous: true }, linkError: 'auth/email-already-in-use' });
			await clickText(page, '.tab-bar__tab', 'Sign Up');
			await typeInto(page, '#signup-name', 'Taken');
			await typeInto(page, '#signup-email', 'taken@example.com');
			await typeInto(page, '#signup-password', 'secret123');
			await clickText(page, 'button', 'Create Account');
			const st = await state(page);
			const cs = await calls(page);
			check('guest: email-already-in-use explains and offers sign-in', st.linkConflict === 'email' && /already has a Sigil account/.test(st.error)
				&& named(cs, 'auth.createUserWithEmailAndPassword').length === 0, st);
			await clickText(page, 'button', 'Sign in with that email');
			const tab = await page.evaluate(() => Alpine.$data(document.querySelector('[x-data]')).tab);
			const email = await page.$eval('#login-email', el => el.value);
			check('guest: conflict button opens sign-in with the email filled', tab === 'login' && email === 'taken@example.com', { tab, email });
			await page.__ctx.close();
		}

		// 2a. The link succeeds but the profile write fails: the page must not
		// stay in guest mode (a retry would then create a second account).
		{
			const page = await openPage(browser, { user: { uid: 'anon-5', isAnonymous: true }, failSets: 99 });
			await clickText(page, '.tab-bar__tab', 'Sign Up');
			await typeInto(page, '#signup-name', 'Halfway');
			await typeInto(page, '#signup-email', 'half@example.com');
			await typeInto(page, '#signup-password', 'secret123');
			await clickText(page, 'button', 'Create Account');
			await sleep(300);
			const st = await state(page);
			const hdr = await page.$eval('#auth-status', el => el.textContent.trim());
			check('link then failed profile write: signed-in view, not guest', st.user === 'anon-5' && st.guest === false, st);
			check('link then failed profile write: says the account exists', /account was created/.test(st.error || ''), st.error);
			check('link then failed profile write: header is not "Sign in"', hdr !== 'Sign in' && hdr !== '', hdr);
			await page.__ctx.close();
		}
		{
			// One failed write: the page's bootstrap retry creates the profile
			// with the typed name.
			const page = await openPage(browser, { user: { uid: 'anon-6', isAnonymous: true }, failSets: 1 });
			await clickText(page, '.tab-bar__tab', 'Sign Up');
			await typeInto(page, '#signup-name', 'Retried');
			await typeInto(page, '#signup-email', 'retry@example.com');
			await typeInto(page, '#signup-password', 'secret123');
			await clickText(page, 'button', 'Create Account');
			await sleep(300);
			const st = await state(page);
			const cs = await calls(page);
			check('transient profile failure: profile bootstrapped with the typed name, no error',
				st.user === 'anon-6' && st.profile && st.profile.displayName === 'Retried' && !st.error, st);
			check('transient profile failure: linked once, no new account', named(cs, 'user.linkWithCredential').length === 1
				&& named(cs, 'auth.createUserWithEmailAndPassword').length === 0);
			await page.__ctx.close();
		}
		{
			const page = await openPage(browser, { user: { uid: 'anon-7', isAnonymous: true }, failSets: 99 });
			await clickText(page, 'button', 'Continue with Google');
			await sleep(300);
			const st = await state(page);
			check('google link then failed profile write: signed-in view with an explanation',
				st.user === 'anon-7' && st.guest === false && /account was created/.test(st.error || ''), st);
			await page.__ctx.close();
		}

		{
			// The database stays down after the link: the recovery attempt
			// fails too, and the page must still settle (not stuck busy).
			const page = await openPage(browser, { user: { uid: 'anon-8', isAnonymous: true }, failReads: true });
			await clickText(page, '.tab-bar__tab', 'Sign Up');
			await typeInto(page, '#signup-name', 'Down');
			await typeInto(page, '#signup-email', 'down@example.com');
			await typeInto(page, '#signup-password', 'secret123');
			await clickText(page, 'button', 'Create Account');
			await sleep(300);
			const st = await state(page);
			const busy = await page.evaluate(() => { const d = Alpine.$data(document.querySelector('[x-data]')); return { busy: d.busy, authBusy: d._authBusy }; });
			check('recovery also fails: not stuck busy, signed-in view, explanation',
				!busy.busy && !busy.authBusy && st.user === 'anon-8' && st.guest === false && /account was created/.test(st.error || ''), { st, busy });
			check('recovery also fails: no page errors', page.__errors.length === 0, page.__errors);
			await page.__ctx.close();
		}

		// Only the leaderboard write fails: recovery must retry it.
		{
			const page = await openPage(browser, { user: { uid: 'anon-9', isAnonymous: true }, failSets: 1, failSetPrefix: 'leaderboard' });
			await clickText(page, '.tab-bar__tab', 'Sign Up');
			await typeInto(page, '#signup-name', 'Board');
			await typeInto(page, '#signup-email', 'board@example.com');
			await typeInto(page, '#signup-password', 'secret123');
			await clickText(page, 'button', 'Create Account');
			await sleep(300);
			const st = await state(page);
			const tree = await page.evaluate(() => window.__dbTree);
			check('leaderboard write failed once: recovery creates the entry, no error',
				tree.leaderboard && tree.leaderboard['anon-9'] && tree.leaderboard['anon-9'].displayName === 'Board' && !st.error, { tree, st });
			await page.__ctx.close();
		}
		{
			const page = await openPage(browser, { user: { uid: 'anon-10', isAnonymous: true }, failSets: 99, failSetPrefix: 'leaderboard' });
			await clickText(page, '.tab-bar__tab', 'Sign Up');
			await typeInto(page, '#signup-name', 'NoBoard');
			await typeInto(page, '#signup-email', 'noboard@example.com');
			await typeInto(page, '#signup-password', 'secret123');
			await clickText(page, 'button', 'Create Account');
			await sleep(300);
			const st = await state(page);
			check('leaderboard write keeps failing: explained though the profile exists',
				st.profile && st.profile.displayName === 'NoBoard' && /account was created/.test(st.error || ''), st);
			await page.__ctx.close();
		}
		// Google link whose updateProfile fails: the Google name, not 'Player'.
		{
			const page = await openPage(browser, { user: { uid: 'anon-11', isAnonymous: true }, failUpdateProfile: true });
			await clickText(page, 'button', 'Continue with Google');
			await sleep(300);
			const st = await state(page);
			const tree = await page.evaluate(() => window.__dbTree);
			check('google updateProfile failed: profile and leaderboard use the Google name',
				tree.users && tree.users['anon-11'] && tree.users['anon-11'].displayName === 'GoogleGuy'
				&& tree.leaderboard && tree.leaderboard['anon-11'] && tree.leaderboard['anon-11'].displayName === 'GoogleGuy'
				&& st.user === 'anon-11', { tree, st });
			await page.__ctx.close();
		}

		// 2c. Ordinary sign-up (no guest): the auth callback that fires
		// mid-flow must not bootstrap a 'Player' profile or leaderboard entry.
		{
			const page = await openPage(browser, {});
			await clickText(page, '.tab-bar__tab', 'Sign Up');
			await typeInto(page, '#signup-name', 'Fresh');
			await typeInto(page, '#signup-email', 'fresh@example.com');
			await typeInto(page, '#signup-password', 'secret123');
			await clickText(page, 'button', 'Create Account');
			await sleep(300);
			const st = await state(page);
			const tree = await page.evaluate(() => window.__dbTree);
			check('signup: profile and leaderboard carry the typed name',
				tree.users && tree.users['new-uid'] && tree.users['new-uid'].displayName === 'Fresh'
				&& tree.leaderboard && tree.leaderboard['new-uid'] && tree.leaderboard['new-uid'].displayName === 'Fresh', tree);
			check('signup: page shows the new profile', st.user === 'new-uid' && st.profile && st.profile.displayName === 'Fresh', st);
			await page.__ctx.close();
		}

		// 2b. Guest upgrade by Google.
		{
			const page = await openPage(browser, { user: { uid: 'anon-3', isAnonymous: true } });
			await clickText(page, 'button', 'Continue with Google');
			await sleep(300);
			const cs = await calls(page);
			const st = await state(page);
			check('guest google: linkWithPopup called, not signInWithPopup', named(cs, 'user.linkWithPopup').length === 1 && named(cs, 'auth.signInWithPopup').length === 0, cs.map(c => c.name));
			const tree = await page.evaluate(() => window.__dbTree);
			check('guest google: profile created with the Google name', tree.users && tree.users['anon-3'] && tree.users['anon-3'].displayName === 'GoogleGuy' && st.user === 'anon-3', { tree, st });
			const hdr = await page.$eval('#auth-status', el => el.textContent.trim());
			check('guest google: header shows the Google name, not "Sign in"', hdr === 'GoogleGuy', hdr);
			await page.__ctx.close();
		}
		{
			const page = await openPage(browser, { user: { uid: 'anon-4', isAnonymous: true }, linkError: 'auth/credential-already-in-use' });
			await clickText(page, 'button', 'Continue with Google');
			let st = await state(page);
			check('guest google: credential-already-in-use offers sign-in', st.linkConflict === 'google' && /already has a Sigil account/.test(st.error), st);
			await clickText(page, 'button', 'Sign in to that Google account');
			await sleep(300);
			const cs = await calls(page);
			st = await state(page);
			check('guest google: signs in with the returned credential, no second popup', named(cs, 'auth.signInWithCredential').length === 1
				&& named(cs, 'auth.signInWithPopup').length === 0 && st.user === 'google-existing', { st, calls: cs.map(c => c.name) });
			await page.__ctx.close();
		}

		// 3. Delete account: deleteUserData callable, no client-side deletes.
		const db = {
			users: { u1: { displayName: 'Deleter', elo: 1100, gamesPlayed: 3 } },
			leaderboard: { u1: { displayName: 'Deleter', elo: 1100 } },
		};
		const emailUser = { uid: 'u1', email: 'del@example.com', displayName: 'Deleter', providers: ['password'] };
		const noClientDeletes = (cs) => named(cs, 'db.update').length === 0 && named(cs, 'db.remove').length === 0
			&& named(cs, 'db.set').length === 0 && named(cs, 'user.delete').length === 0;
		{
			const page = await openPage(browser, { user: emailUser, db });
			await page.click('#delete-open');
			await sleep(200);
			const disabled = () => page.$eval('#delete-submit', b => b.disabled);
			check('delete: button disabled before typing', await disabled());
			await typeInto(page, '#delete-confirm', 'delete');
			check('delete: wrong confirmation keeps it disabled', await disabled());
			// Call the handler anyway: it must refuse too.
			await page.evaluate(() => Alpine.$data(document.querySelector('[x-data]')).deleteAccount());
			let cs = await calls(page);
			check('delete: handler refuses without DELETE', named(cs, 'functions.call').length === 0);
			await typeInto(page, '#delete-confirm', 'DELETE');
			check('delete: typed DELETE enables the button', !(await disabled()));
			await page.click('#delete-submit');
			await sleep(500);
			cs = await calls(page);
			const fc = named(cs, 'functions.call');
			check('delete: deleteUserData called once', fc.length === 1 && fc[0].args[0] === 'deleteUserData', fc);
			check('delete: no client-side data deletes or user.delete()', noClientDeletes(cs), cs.map(c => c.name));
			const iCall = cs.findIndex(c => c.name === 'functions.call');
			const iOut = cs.findIndex(c => c.name === 'auth.signOut');
			check('delete: signs out locally after the call', iCall >= 0 && iOut > iCall, { iCall, iOut });
			const st = await state(page);
			check('delete: page shows signed-out with confirmation', st.user === null && /deleted/.test(st.successMsg), st);
			check('delete: no page errors', page.__errors.length === 0, page.__errors);
			await page.__ctx.close();
		}
		// 3b. Stale sign-in: re-auth before calling the function.
		{
			const page = await openPage(browser, { user: emailUser, db, authAgeMs: 30 * 60 * 1000 });
			await page.click('#delete-open');
			await typeInto(page, '#delete-confirm', 'DELETE');
			await page.click('#delete-submit');
			await sleep(400);
			let cs = await calls(page);
			let st = await state(page);
			check('stale: re-auth prompt, function not called yet', st.reauthNeeded && st.reauthMethod === 'password'
				&& named(cs, 'functions.call').length === 0, st);
			await typeInto(page, '#reauth-password', 'pw-123');
			await page.click('#delete-submit');
			await sleep(500);
			cs = await calls(page);
			const re = named(cs, 'user.reauthenticateWithCredential');
			check('stale: reauthenticateWithCredential with the email and typed password', re.length === 1 && re[0].args[0].email === 'del@example.com' && re[0].args[0].password === 'pw-123', re);
			const iRe = cs.findIndex(c => c.name === 'user.reauthenticateWithCredential');
			const iCall = cs.findIndex(c => c.name === 'functions.call');
			check('stale: then deleteUserData called once', named(cs, 'functions.call').length === 1 && iCall > iRe, cs.map(c => c.name));
			await page.__ctx.close();
		}
		// 3c. The function itself says requires-recent-login (Google account): re-auth, retry once.
		{
			const page = await openPage(browser, { user: { uid: 'u1', email: 'g@example.com', displayName: 'Deleter', providers: ['google.com'] }, db, callableFailures: 1 });
			await page.click('#delete-open');
			await typeInto(page, '#delete-confirm', 'DELETE');
			await page.click('#delete-submit');
			await sleep(400);
			let st = await state(page);
			let cs = await calls(page);
			check('recent-login: failed-precondition triggers the re-auth prompt', st.reauthNeeded && st.reauthMethod === 'google'
				&& named(cs, 'functions.call').length === 1 && named(cs, 'auth.signOut').length === 0 && st.user === 'u1', st);
			const label = await page.$eval('#delete-submit', b => b.textContent.trim());
			check('recent-login: button offers Google confirmation', label === 'Confirm with Google and delete', label);
			await page.click('#delete-submit');
			await sleep(500);
			cs = await calls(page);
			st = await state(page);
			check('recent-login: reauthenticateWithPopup then the retry succeeds', named(cs, 'user.reauthenticateWithPopup').length === 1
				&& named(cs, 'functions.call').length === 2 && st.user === null && noClientDeletes(cs), { st, calls: cs.map(c => c.name) });
			await page.__ctx.close();
		}
		// 3d. Still refused after re-auth: only one retry, then an error.
		{
			const page = await openPage(browser, { user: emailUser, db, callableFailures: 5 });
			await page.click('#delete-open');
			await typeInto(page, '#delete-confirm', 'DELETE');
			await page.click('#delete-submit');
			await sleep(400);
			await typeInto(page, '#reauth-password', 'pw');
			await page.click('#delete-submit');
			await sleep(500);
			const cs = await calls(page);
			const st = await state(page);
			check('retry-once: second refusal shows an error, no third call', named(cs, 'functions.call').length === 2
				&& /could not be deleted/.test(st.deleteError) && st.user === 'u1', { st, calls: cs.map(c => c.name) });
			await page.__ctx.close();
		}
		// 3e. Function error: the account stays signed in and intact.
		{
			const page = await openPage(browser, { user: emailUser, db, callableError: 'internal' });
			await page.click('#delete-open');
			await typeInto(page, '#delete-confirm', 'DELETE');
			await page.click('#delete-submit');
			await sleep(400);
			const cs = await calls(page);
			const st = await state(page);
			const tree = await page.evaluate(() => window.__dbTree);
			check('error: account left intact and signed in', st.user === 'u1' && /could not be deleted/.test(st.deleteError)
				&& named(cs, 'auth.signOut').length === 0 && noClientDeletes(cs) && tree.users.u1 && tree.leaderboard.u1, { st, calls: cs.map(c => c.name) });
			await page.__ctx.close();
		}
	} catch (e) {
		console.log('FAIL exception: ' + (e.stack || e));
		failures++;
	} finally {
		if (browser) await browser.close();
		srv.kill();
	}
	console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
	process.exit(failures ? 1 : 0);
})();
