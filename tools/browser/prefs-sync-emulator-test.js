// Preferences on the account (prefs.js, users/{uid}/prefs) and the name
// filter on account.html, on the Firebase emulators (no live database):
//   1. A new account takes this device's settings once its profile exists;
//      volume, mute and zen stay off the account.
//   2. A change is written through; another browser signed in to the same
//      account takes the account's settings, and a change made elsewhere
//      reaches an open game page live.
//   3. The account-only AI options on preferences.html write users/{uid}.
//   4. A guest (anonymous) writes nothing.
//   5. account.html refuses an offensive name at sign-up and at rename.
//
//   (cd docs && python3 -m http.server 8812) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/prefs-sync-emulator-test.js http://localhost:8812'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8812';
const NS = 'sigil-js-default-rtdb';
const DB_PORT = Number(process.env.EMU_DB_PORT || 9000);
const AUTH_PORT = Number(process.env.EMU_AUTH_PORT || 9099);
// SigilNameFilter.MESSAGE
const SIGIL_MSG = 'That name is not allowed. Please choose another.';

function useEmulators(dbPort, authPort) {
	let fb;
	Object.defineProperty(window, 'firebase', {
		configurable: true,
		get() { return fb; },
		set(v) {
			fb = v;
			const init = v.initializeApp.bind(v);
			v.initializeApp = (...args) => {
				const app = init(...args);
				app.auth().useEmulator('http://127.0.0.1:' + authPort, { disableWarnings: true });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbGet = async (p) => (await fetch(`http://127.0.0.1:${DB_PORT}/${p}.json?ns=${NS}`, { headers: { Authorization: 'Bearer owner' } })).json();
async function until(fn, ms = 15000) {
	const t = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t > ms) return v;
		await sleep(300);
	}
}

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`http://127.0.0.1:${DB_PORT}/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && !!cond; };
	const newPage = async (storage) => {
		const ctx = await browser.createBrowserContext();
		const p = await ctx.newPage();
		await p.evaluateOnNewDocument(useEmulators, DB_PORT, AUTH_PORT);
		if (storage) {
			await p.evaluateOnNewDocument((s) => {
				if (sessionStorage.getItem('__seeded')) return;
				sessionStorage.setItem('__seeded', '1');
				for (const k in s) localStorage.setItem(k, s[k]);
			}, storage);
		}
		await p.setBypassServiceWorker(true);
		await p.setRequestInterception(true);
		p.on('request', (req) => {
			const url = req.url();
			if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
			sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }), () => req.continue());
		});
		p.on('pageerror', (e) => console.log('pageerror:', e.message));
		p.on('dialog', (d) => d.accept());
		return p;
	};
	const email = 'prefs' + Date.now() + '@example.com';
	try {
		// ---- 1. A new account takes the device's settings ----
		const a = await newPage({ sigil_theme: 'forest', sigil_settings: JSON.stringify({ blind: true, volume: 0.3, zen: true, clockLow: 20 }) });
		await a.goto(`${BASE}/preferences.html`, { waitUntil: 'load', timeout: 90000 });
		await a.waitForFunction(() => window.firebase && firebase.apps.length, { timeout: 30000 });
		const uid = await a.evaluate(async (email) => {
			const cred = await firebase.auth().createUserWithEmailAndPassword(email, 'password123');
			// What auth-manager.js ensureUserProfile writes, a moment after sign-in.
			await new Promise((r) => setTimeout(r, 1000));
			await firebase.database().ref('users/' + cred.user.uid).set({ displayName: 'Prefy', elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: Date.now() });
			return cred.user.uid;
		}, email);
		const seeded = await until(async () => { const v = await dbGet(`users/${uid}/prefs`); return v && v.theme ? v : null; });
		check('a new account takes the device\'s settings once its profile exists', seeded && seeded.theme === 'forest' && seeded.blind === true
			&& seeded.clockLow === 20 && seeded.motion === 'system', seeded);
		check('volume, mute and zen stay on the device', seeded && !('volume' in seeded) && !('muted' in seeded) && !('zen' in seeded), seeded && Object.keys(seeded));

		// ---- 2. Write-through, a second browser, live updates ----
		await a.evaluate(() => SigilSettings.set('confirmForfeit', false));
		check('a change is written through', await until(async () => (await dbGet(`users/${uid}/prefs/confirmForfeit`)) === false));
		const b = await newPage({ sigil_settings: JSON.stringify({ volume: 0.8 }) });
		await b.goto(`${BASE}/game.html`, { waitUntil: 'load', timeout: 90000 });
		await b.waitForFunction(() => window.firebase && firebase.apps.length && window.Alpine, { timeout: 30000 });
		await b.evaluate((email) => firebase.auth().signInWithEmailAndPassword(email, 'password123'), email);
		const adopted = await until(() => b.evaluate(() => {
			const s = { theme: themeManager.current, blind: SigilSettings.get('blind'), forfeit: SigilSettings.get('confirmForfeit'),
				volume: SigilSettings.get('volume'), attr: document.documentElement.hasAttribute('data-blind') };
			return s.theme === 'forest' && s.blind && s.forfeit === false ? s : null;
		}));
		check('another browser takes the account\'s settings on sign-in', !!adopted, adopted);
		check('...but keeps its own volume', adopted && adopted.volume === 0.8 && adopted.attr, adopted);
		await a.evaluate(() => SigilSettings.set('colourblind', true));
		const live = await until(() => b.evaluate(() => document.documentElement.hasAttribute('data-colourblind')));
		check('a change on one device reaches an open game page live', live);

		// ---- 3. Account-only options ----
		await a.reload({ waitUntil: 'load' });
		await a.waitForFunction(() => !document.getElementById('account-prefs').hidden, { timeout: 20000 }).catch(() => {});
		check('signed in: the account section shows', await a.evaluate(() => !document.getElementById('account-prefs').hidden));
		check('and the status says the settings follow the account', /follow your account/.test(await a.$eval('#prefs-status', (e) => e.textContent)));
		await a.click('[data-account-setting="showAiThinkReport"]');
		check('an account-only option writes users/{uid}', await until(async () => (await dbGet(`users/${uid}/showAiThinkReport`)) === true));

		// ---- 4. A guest writes nothing ----
		const g = await newPage({ sigil_settings: JSON.stringify({ blind: true }) });
		await g.goto(`${BASE}/preferences.html`, { waitUntil: 'load', timeout: 90000 });
		await g.waitForFunction(() => window.firebase && firebase.apps.length, { timeout: 30000 });
		const guid = await g.evaluate(async () => (await firebase.auth().signInAnonymously()).user.uid);
		await g.evaluate(() => SigilSettings.set('nodeNames', true));
		await sleep(2000);
		check('a guest keeps settings on the device only', (await dbGet(`users/${guid}`)) === null
			&& await g.evaluate(() => JSON.parse(localStorage.getItem('sigil_settings')).nodeNames === true));
		check('a guest sees no account section', await g.evaluate(() => document.getElementById('account-prefs').hidden));

		// ---- 5. account.html: the name filter ----
		const s = await newPage();
		await s.goto(`${BASE}/account.html`, { waitUntil: 'load', timeout: 90000 });
		await s.waitForFunction(() => window.Alpine && document.querySelector('[x-data]') && !Alpine.$data(document.querySelector('[x-data]')).loading, { timeout: 30000 });
		const signup = await s.evaluate(async (email) => {
			const d = Alpine.$data(document.querySelector('[x-data]'));
			d.tab = 'signup';
			d.signupName = 'FuckFace';
			d.signupEmail = 'x' + email;
			d.signupPassword = 'password123';
			await d.signUp();
			return { error: d.error, user: !!firebase.auth().currentUser && !firebase.auth().currentUser.isAnonymous };
		}, email);
		check('sign-up refuses an offensive name before creating anything', signup.error === SIGIL_MSG && !signup.user, signup);
		await s.evaluate((email) => firebase.auth().signInWithEmailAndPassword(email, 'password123'), email);
		await s.waitForFunction(() => !!Alpine.$data(document.querySelector('[x-data]')).profile, { timeout: 20000 });
		const rename = await s.evaluate(async () => {
			const d = Alpine.$data(document.querySelector('[x-data]'));
			d.renameName = 'sh1t';
			await d.renameUser();
			return d.error;
		});
		check('rename refuses an offensive name', rename === SIGIL_MSG, rename);
		check('the profile keeps its name', (await dbGet(`users/${uid}/displayName`)) === 'Prefy');
		// A name from before the filter: the account page asks for a new one.
		await fetch(`http://127.0.0.1:${DB_PORT}/users/${uid}/displayName.json?ns=${NS}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: '"Bitch"' });
		await s.reload({ waitUntil: 'load' });
		const prompt = await until(() => s.evaluate(() => {
			const c = document.querySelector('[data-testid="rename-card"]');
			return c && c.offsetParent !== null ? c.textContent.replace(/\s+/g, ' ') : null;
		}), 20000);
		check('an existing offensive name brings up the rename prompt', prompt && /not allowed/.test(prompt), prompt);
		check('the account page links to the preferences', await s.$eval('#prefs-link-card a', (e) => e.getAttribute('href')) === 'preferences.html');
	} catch (e) {
		console.log('FAIL exception', e && e.stack || e);
		ok = false;
	} finally {
		await browser.close();
	}
	console.log(ok ? 'TEST OK' : 'TEST FAILED');
	process.exit(ok ? 0 : 1);
})();

