/**
 * turn-notify.js — "Your move" across a signed-in player's online games, on
 * every page that loads auth-status.js (which loads this and room-clock.js).
 *
 *   - The "Your move (N)" badge in the header, linking to active-games.html.
 *   - An in-tab notification when it becomes your move: in a correspondence
 *     game whenever a site page is open, in any other game while this tab is
 *     hidden. Only once the player has allowed notifications (a button on
 *     active-games.html; never asked on load).
 *   - Web push (Firebase Cloud Messaging) for when no tab is open: the
 *     helpers behind the "Notify me when it's my move" toggle. The server
 *     side is functions/notify.js; docs/sw.js shows the push.
 *
 * Cheap: per game, its status and only the last turn (rooms/{id}/last in a
 * sequenced room, else an orderByChild('timestamp').limitToLast(1) query),
 * and whose move that makes it by
 * room-clock.js sideToMove, the rule the server uses.
 */
(function () {
	// The FCM web push key (public half; Firebase console → Project settings
	// → Cloud Messaging → Web Push certificates). Empty hides the push toggle.
	const FCM_VAPID_KEY = 'BKF7QWLVOz8iAhj4AmG5qJy6mhJ0x2ARw2mLDZ4pBXDLr9OttUnaigCBKlk3nk3orQ4pRTnTZhywo_dppt_Gud0';

	const PUSH_HASH_KEY = 'sigil-push-token-hash';
	const script = document.currentScript;
	// The site root, for pages in subfolders (packs/, spells/).
	const ROOT = script && script.src ? new URL('../../', script.src).href : '';

	if (typeof firebase === 'undefined' || typeof sideToMove !== 'function') return;

	const games = {};   // code -> { myColor, status, timeControl, startSfn, last, refs }
	const listeners = [];
	let uid = null;
	let indexRef = null;
	let count = 0;

	function isYourMove(g) {
		if (g.status !== 'playing' || !g.myColor) return false;
		const turns = g.last ? { [g.last.key]: g.last.turn } : null;
		return sideToMove({ turns, startSfn: g.startSfn }) === g.myColor;
	}

	function recount() {
		count = Object.keys(games).filter((c) => isYourMove(games[c])).length;
		renderBadge();
		listeners.forEach((fn) => { try { fn(count); } catch (e) { /* ignore */ } });
	}

	function renderBadge() {
		const el = document.getElementById('auth-status');
		if (!el) return;
		let a = el.querySelector('.auth-status__moves');
		if (!count || !uid) {
			if (a) a.remove();
			return;
		}
		if (!a) {
			a = document.createElement('a');
			a.className = 'auth-status__moves';
			a.href = ROOT + 'active-games.html';
			a.style.cssText = 'margin-left:12px;color:var(--color-success, #4caf50);font-weight:bold;text-decoration:none;white-space:nowrap';
			el.appendChild(a);
		}
		a.textContent = 'Your move (' + count + ')';
	}

	function watchRoom(db, code, entry) {
		const g = games[code] = { myColor: entry.myColor, status: null, timeControl: null, startSfn: null, last: undefined, refs: [] };
		const room = db.ref('rooms/' + code);
		const statusRef = room.child('status');
		statusRef.on('value', (s) => { g.status = s.val(); recount(); }, () => {});
		room.child('timeControl').once('value').then((s) => { g.timeControl = s.val(); }, () => {});
		room.child('startSfn').once('value').then((s) => { g.startSfn = s.val(); recount(); }, () => {});
		// The last turn: a sequenced room names it (rooms/{id}/last, which
		// each turn moves on in the same write); an older room's is the
		// latest by server time.
		const onLast = (last) => {
			const first = g.last === undefined;
			const changed = !first && last && (!g.last || g.last.key !== last.key);
			g.last = last;
			recount();
			if (changed && isYourMove(g)) notifyInTab(code, g);
		};
		room.child('seq').once('value').then((seqSnap) => {
			if (games[code] !== g) return;
			let lastRef;
			if (seqSnap.val() === true) {
				lastRef = room.child('last');
				lastRef.on('value', (s) => {
					const v = s.val();
					onLast(v && v.key ? { key: v.key, turn: { color: v.color } } : null);
				}, () => {});
			} else {
				lastRef = room.child('turns').orderByChild('timestamp').limitToLast(1);
				lastRef.on('value', (s) => {
					let last = null;
					s.forEach((c) => { last = { key: c.key, turn: c.val() || {} }; });
					onLast(last);
				}, () => {});
			}
			g.refs.push(lastRef);
		}, () => {});
		g.refs.push(statusRef);
	}

	function unwatchRoom(code) {
		const g = games[code];
		if (!g) return;
		g.refs.forEach((r) => r.off());
		delete games[code];
	}

	function stop() {
		if (indexRef) indexRef.off();
		indexRef = null;
		Object.keys(games).forEach(unwatchRoom);
		uid = null;
		recount();
	}

	function start(user) {
		const db = firebase.database();
		uid = user.uid;
		indexRef = db.ref('user_active_games/' + uid);
		indexRef.on('value', (snap) => {
			const entries = snap.val() || {};
			Object.keys(games).forEach((c) => { if (!entries[c]) unwatchRoom(c); });
			Object.keys(entries).forEach((c) => {
				const e = entries[c] || {};
				if (!games[c] && (e.myColor === 'red' || e.myColor === 'blue')) watchRoom(db, c, e);
			});
			recount();
		}, () => {});
	}

	firebase.auth().onAuthStateChanged((user) => {
		stop();
		if (user && !user.isAnonymous) start(user);
	});

	// ---- In-tab notifications ----

	function roomUrl(code) {
		return ROOT + 'multiplayer.html?id=' + encodeURIComponent(code);
	}

	function lookingAt(code) {
		if (document.hidden) return false;
		const p = new URLSearchParams(location.search);
		return /multiplayer\.html$/.test(location.pathname) && p.get('id') === code;
	}

	async function notifyInTab(code, g) {
		if (!('Notification' in window) || Notification.permission !== 'granted') return;
		const corr = g.timeControl && g.timeControl.type === 'correspondence';
		if (!corr && !document.hidden) return;
		if (lookingAt(code)) return;
		const title = 'Your move in Sigil';
		// Same tag as the push (functions/notify.js): one notice per game,
		// however many tabs or devices raise it.
		const opts = { body: 'Your opponent has moved (game ' + code + ').', tag: 'sigil-turn-' + code, data: { url: roomUrl(code) } };
		try {
			const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration(ROOT) : null;
			if (reg) return void await reg.showNotification(title, opts);
			const n = new Notification(title, opts);
			n.onclick = () => { window.focus(); location.href = opts.data.url; };
		} catch (e) { /* not allowed here */ }
	}

	// ---- Web push (FCM) ----

	function pushSupported() {
		return !!FCM_VAPID_KEY && 'serviceWorker' in navigator && 'PushManager' in window
			&& 'Notification' in window && typeof firebase.messaging === 'function'
			&& !!(window.crypto && crypto.subtle);
	}

	async function tokenHash(token) {
		const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
		return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
	}

	function savedHash() {
		try { return localStorage.getItem(PUSH_HASH_KEY); } catch (e) { return null; }
	}

	function saveHash(h) {
		try {
			if (h) localStorage.setItem(PUSH_HASH_KEY, h);
			else localStorage.removeItem(PUSH_HASH_KEY);
		} catch (e) { /* private mode: the toggle just reads off next time */ }
	}

	/** Is push on for this browser and this account? */
	async function pushEnabled() {
		if (!pushSupported() || !uid || Notification.permission !== 'granted') return false;
		const h = savedHash();
		if (!h) return false;
		try {
			return (await firebase.database().ref('push_tokens/' + uid + '/' + h).once('value')).exists();
		} catch (e) {
			return false;
		}
	}

	/**
	 * Turn push on: ask permission (call from a click), subscribe through the
	 * site's own service worker (docs/sw.js handles the push), and store the
	 * token where only this account and the server can read it.
	 */
	async function enablePush() {
		if (!pushSupported() || !uid) return false;
		if (await Notification.requestPermission() !== 'granted') return false;
		const reg = await navigator.serviceWorker.register(ROOT + 'sw.js');
		await navigator.serviceWorker.ready;
		const token = await firebase.messaging().getToken({ vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: reg });
		if (!token) return false;
		const h = await tokenHash(token);
		await firebase.database().ref('push_tokens/' + uid + '/' + h).set({
			token, created: firebase.database.ServerValue.TIMESTAMP,
		});
		saveHash(h);
		return true;
	}

	async function disablePush() {
		const h = savedHash();
		if (uid && h) await firebase.database().ref('push_tokens/' + uid + '/' + h).remove().catch(() => {});
		saveHash(null);
		try { await firebase.messaging().deleteToken(); } catch (e) { /* already gone */ }
	}

	window.SigilTurns = {
		get count() { return count; },
		get vapidKey() { return FCM_VAPID_KEY; },
		onChange(fn) { listeners.push(fn); fn(count); },
		renderBadge,
		pushSupported,
		pushEnabled,
		enablePush,
		disablePush,
		/** Ask for in-tab notifications (call from a click). */
		requestPermission() {
			return 'Notification' in window ? Notification.requestPermission() : Promise.resolve('denied');
		},
	};
})();
