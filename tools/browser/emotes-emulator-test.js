// Preset emotes in online games, on the Firebase emulators (no live
// database): two guest pages create and join a room through the real lobby,
// and a third page watches.
//   1. The seated players get the picker; the spectator does not, and the
//      rules refuse its write.
//   2. Red's emote shows as a bubble under Red's name, with live-region
//      text, for Blue and for the spectator; the spectator follows its
//      system's reduced motion, so the bubble does not animate.
//   3. A second emote within 3 s is refused by the rules (server time).
//   4. Blue mutes emotes in the settings panel: the next one is not shown
//      and Blue's picker goes; game.html has no such row.
//   5. After the game ends only "Well played" and "Thanks" are offered, and
//      they reach the opponent.
//
//   (cd docs && python3 -m http.server 8806) &
//   cd functions && firebase emulators:exec --only auth,database --project demo-sigil \
//     'node ../tools/browser/emotes-emulator-test.js http://localhost:8806'
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = process.argv[2] || 'http://localhost:8806';
const NS = 'sigil-js-default-rtdb';
// A private emulator config can move the ports.
const DB_PORT = Number(process.env.EMU_DB_PORT || 9000);
const AUTH_PORT = Number(process.env.EMU_AUTH_PORT || 9099);

// Point the page's Firebase at the emulators as soon as the app exists.
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

(async () => {
	const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const put = await fetch(`http://127.0.0.1:${DB_PORT}/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	if (put.status !== 200) throw new Error('rules upload: ' + put.status + ' ' + await put.text());

	const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
	let ok = true;
	const check = (label, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + label, extra === undefined ? '' : JSON.stringify(extra)); ok = ok && cond; };
	try {
		const pages = [];
		for (let i = 0; i < 4; i++) {
			const ctx = await browser.createBrowserContext();
			const p = await ctx.newPage();
			await p.evaluateOnNewDocument(useEmulators, DB_PORT, AUTH_PORT);
			await p.setBypassServiceWorker(true);
			await p.setRequestInterception(true);
			p.on('request', (req) => {
				const url = req.url();
				if (!url.startsWith('https://www.gstatic.com/firebasejs/')) return req.continue();
				sdk(url).then((body) => req.respond({ status: 200, contentType: 'text/javascript', body }),
					() => req.continue());
			});
			p.on('pageerror', (e) => console.log('pageerror:', e.message));
			pages.push(p);
		}
		const [pageA, pageB, pageC, pageG] = pages;
		// The spectator's system asks for reduced motion.
		await pageC.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);

		await pageA.goto(`${BASE}/multiplayer.html`, { waitUntil: 'load', timeout: 90000 });
		await pageA.waitForFunction(() => !!document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack, { timeout: 30000, polling: 500 });
		await pageA.evaluate(async () => { await document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].createRoom(); });
		await pageA.waitForFunction(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].phase === 'waiting', { timeout: 30000, polling: 500 });
		const code = await pageA.evaluate(() => document.querySelector('[x-data^="multiplayerLobby"]')._x_dataStack[0].roomCode);
		await pageB.goto(`${BASE}/multiplayer.html?id=${code}`, { waitUntil: 'load', timeout: 90000 });

		const ready = async (p) => {
			for (let i = 0; i < 120; i++) {
				const r = await p.evaluate(() => {
					const el = document.querySelector('[x-data^="gameBoard"]');
					if (!el || !window.Alpine) return false;
					const g = Alpine.$data(el);
					return !!g._engine && (g.isSpectator || !!g.whoseTurn);
				}).catch(() => false);
				if (r) return;
				await sleep(500);
			}
			throw new Error('game screen not ready');
		};
		await ready(pageA);
		await ready(pageB);
		const roomOf = () => pageA.evaluate(async (c) => (await firebase.database().ref('rooms/' + c).once('value')).val(), code);
		const st = await roomOf();
		const uidOf = (p) => p.evaluate(() => firebase.auth().currentUser && firebase.auth().currentUser.uid);
		const redP = st.red.uid === await uidOf(pageA) ? pageA : pageB;
		const blueP = redP === pageA ? pageB : pageA;

		// A spectator joins by the link.
		await pageC.goto(`${BASE}/multiplayer.html?id=${code}`, { waitUntil: 'load', timeout: 90000 });
		await ready(pageC);
		const g = () => Alpine.$data(document.querySelector('[x-data^="gameBoard"]'));
		const view = (p) => p.evaluate(() => {
			const b = (c) => document.querySelector('.emote-bubble--' + c);
			const picker = document.querySelector('.emote-picker');
			const live = document.querySelector('.emote-live');
			return {
				red: b('red') && b('red').offsetParent !== null ? b('red').textContent : '',
				blue: b('blue') && b('blue').offsetParent !== null ? b('blue').textContent : '',
				picker: !!picker && picker.offsetParent !== null,
				live: live ? live.textContent : null,
				anim: b('red') ? getComputedStyle(b('red')).animationName : null,
			};
		});
		check('the spectator is spectating', await pageC.evaluate(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).isSpectator));
		check('seated players see the picker', (await view(redP)).picker && (await view(blueP)).picker);
		check('the spectator has no picker', !(await view(pageC)).picker);
		const specWrite = await pageC.evaluate(async (c) => {
			const ref = firebase.database().ref('rooms/' + c);
			const key = ref.child('emotes').push().key;
			const ts = firebase.database.ServerValue.TIMESTAMP;
			try { await ref.update({ ['emotes/' + key]: { color: 'red', e: 'hello', at: ts }, 'lastEmote/red': { at: ts, key } }); return 'ok'; } catch (e) { return e.code || e.message; }
		}, code);
		check('the rules refuse a spectator\'s emote', specWrite !== 'ok', specWrite);

		// Red sends "Good luck!" through the picker.
		await redP.click('.emote-picker__toggle');
		await redP.waitForSelector('.emote-picker__item[data-emote="glhf"]', { visible: true, timeout: 10000 });
		await redP.click('.emote-picker__item[data-emote="glhf"]');
		check('the picker cools down after sending', await redP.evaluate(() => document.querySelector('.emote-picker__toggle').disabled));
		// Within 3 s the rules refuse another, even when sent directly.
		const again = await redP.evaluate(() => window._multiplayerState.sync.sendEmote('red', 'nice'));
		check('a second emote within 3 s is refused', again === false);
		for (const [name, p] of [['blue', blueP], ['the spectator', pageC]]) {
			await p.waitForFunction(() => {
				const b = document.querySelector('.emote-bubble--red');
				return b && b.offsetParent !== null && b.textContent === 'Good luck!';
			}, { timeout: 15000, polling: 200 })
				.then(() => check(name + ' sees Red\'s bubble', true), () => check(name + ' sees Red\'s bubble', false));
		}
		const vb = await view(blueP);
		check('the bubble has live-region text', /\(Red\): Good luck!/.test(vb.live || ''), vb);
		const vc = await view(pageC);
		check('reduced motion: the bubble does not animate', vc.anim === 'none', vc);
		check('full motion: the bubble pops in', (await view(blueP)).anim === 'emote-pop');

		// The bubble goes after 3 s.
		await blueP.waitForFunction(() => {
			const b = document.querySelector('.emote-bubble--red');
			return !b || b.offsetParent === null;
		}, { timeout: 8000, polling: 200 })
			.then(() => check('the bubble goes after 3 s', true), () => check('the bubble goes after 3 s', false));

		// Blue mutes emotes in the settings panel.
		await blueP.evaluate(() => SigilDialog.openSettings());
		await blueP.click('#settings-panel [data-setting="muteEmotes"]');
		check('the mute setting is stored', await blueP.evaluate(() => JSON.parse(localStorage.getItem('sigil_settings')).muteEmotes === true));
		await blueP.evaluate(() => SigilDialog.closeTop());
		await sleep(500);
		check('muted: Blue\'s picker goes', !(await view(blueP)).picker);
		await sleep(3200);
		const sent = await redP.evaluate(() => window._multiplayerState.sync.sendEmote('red', 'nice'));
		check('after 3 s Red may send again', sent === true);
		await pageC.waitForFunction(() => {
			const b = document.querySelector('.emote-bubble--red');
			return b && b.offsetParent !== null && b.textContent === 'Nice move!';
		}, { timeout: 15000, polling: 200 })
			.then(() => check('the spectator sees the second emote', true), () => check('the spectator sees the second emote', false));
		const vm = await view(blueP);
		check('muted: Blue sees no bubble and hears nothing', !vm.red && !/Nice move/.test(vm.live || ''), vm);
		const emotes = (await roomOf()).emotes || {};
		check('the room holds both emotes', Object.values(emotes).map((e) => e.e).sort().join() === 'glhf,nice', emotes);

		// game.html (no online emotes) has no mute row.
		await pageG.goto(`${BASE}/game.html`, { waitUntil: 'load', timeout: 90000 });
		await pageG.waitForSelector('#settings-panel', { timeout: 30000 });
		check('game.html has no mute-emotes row', !(await pageG.$('#settings-panel [data-setting="muteEmotes"]')));

		// Red resigns; Blue unmutes and says "Well played".
		await redP.evaluate(() => { const b = Alpine.$data(document.querySelector('[x-data^="gameBoard"]')); b.handleForfeit(); b.handleForfeit(); });
		await blueP.waitForFunction(() => Alpine.$data(document.querySelector('[x-data^="gameBoard"]')).winner === 'blue', { timeout: 30000, polling: 500 });
		await blueP.evaluate(() => SigilSettings.set('muteEmotes', false));
		await blueP.waitForSelector('.emote-picker__toggle', { visible: true, timeout: 10000 });
		await blueP.click('.emote-picker__toggle');
		const offered = await blueP.$$eval('.emote-picker__item', (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.dataset.emote).sort().join());
		check('after the game only "Well played" and "Thanks"', offered === 'gg,thanks', offered);
		await blueP.click('.emote-picker__item[data-emote="gg"]');
		await redP.waitForFunction(() => {
			const b = document.querySelector('.emote-bubble--blue');
			return b && b.offsetParent !== null && b.textContent === 'Well played!';
		}, { timeout: 15000, polling: 200 })
			.then(() => check('Red sees "Well played!" after the game', true), () => check('Red sees "Well played!" after the game', false));
		const late = await redP.evaluate(async () => {
			await new Promise((r) => setTimeout(r, 3300));
			return window._multiplayerState.sync.sendEmote('red', 'hello');
		});
		check('after the game "Hello" is refused', late === false);
	} catch (e) {
		console.log('FAIL exception', e && e.stack || e);
		ok = false;
	} finally {
		await browser.close();
	}
	console.log(ok ? 'TEST OK' : 'TEST FAILED');
	process.exit(ok ? 0 : 1);
})();
