/**
 * friends.js — follows, blocks, challenges and who is online, on every page
 * that loads auth-status.js (which loads this after turn-notify.js).
 *
 *   follows/{uid}/{target}: true      both written by uid in one update
 *   followers/{target}/{uid}: true    (database.rules.json checks the pair)
 *   blocks/{uid}/{target}: true       read by uid, and by target for its own key
 *   challenges/{target}/{room}: {from, at, tc, variant}
 *                                     by the creator of a waiting room that
 *                                     invites target (rooms/{room}/invite)
 *   presence/{uid}/{conn}: time       one entry per open tab, removed by the
 *                                     server when that connection drops (the
 *                                     same per-connection scheme as a room
 *                                     seat's conns)
 *
 * Signed-in players only: guests can't follow, block or be challenged.
 *
 * The challenge banner: each open challenge to this player shows at the foot
 * of the page with Accept (opens the room, which joins it) and Decline. The
 * push for it is functions/notify.js notifyChallenge.
 */
(function () {
	const script = document.currentScript;
	const ROOT = script && script.src ? new URL('../../', script.src).href : '';

	if (typeof firebase === 'undefined') return;

	let uid = null;
	let connId = null;
	let presenceRef = null;
	let connectedRef = null;
	let challengesRef = null;
	const challenges = {};   // room -> { from, name, tcLabel, variantLabel }
	const blockCache = {};   // uid -> Promise<boolean> (blocked either way)
	const listeners = [];

	const db = () => firebase.database();
	const signedIn = () => !!uid;

	function emit() {
		listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
	}

	// ---- Presence ----

	function goOnline() {
		if (!uid) return;
		if (!connId) connId = db().ref('presence/' + uid).push().key;
		const ref = db().ref('presence/' + uid + '/' + connId);
		presenceRef = ref;
		ref.onDisconnect().remove()
			.then(() => ref.set(firebase.database.ServerValue.TIMESTAMP))
			.catch(() => {});
	}

	function goOffline() {
		if (presenceRef) {
			presenceRef.onDisconnect().cancel().catch(() => {});
			presenceRef.remove().catch(() => {});
		}
		presenceRef = null;
		connId = null;
	}

	// ---- Follows and blocks ----

	function requireSignedIn() {
		if (!uid) throw Object.assign(new Error('Sign in to an account first.'), { code: 'signed-out' });
	}

	async function isFollowing(target) {
		if (!uid || !target) return false;
		return (await db().ref('follows/' + uid + '/' + target).once('value')).val() === true;
	}

	function follow(target) {
		requireSignedIn();
		return db().ref().update({ ['follows/' + uid + '/' + target]: true, ['followers/' + target + '/' + uid]: true });
	}

	function unfollow(target) {
		requireSignedIn();
		return db().ref().update({ ['follows/' + uid + '/' + target]: null, ['followers/' + target + '/' + uid]: null });
	}

	async function isBlocked(target) {
		if (!uid || !target) return false;
		return (await db().ref('blocks/' + uid + '/' + target).once('value')).val() === true;
	}

	/** Block: also stops following them. */
	async function block(target) {
		requireSignedIn();
		delete blockCache[target];
		await db().ref().update({
			['blocks/' + uid + '/' + target]: true,
			['follows/' + uid + '/' + target]: null,
			['followers/' + target + '/' + uid]: null,
		});
	}

	async function unblock(target) {
		requireSignedIn();
		delete blockCache[target];
		await db().ref('blocks/' + uid + '/' + target).remove();
	}

	/**
	 * Has either of us blocked the other? The lobby hides such players' open
	 * games (the rules refuse the seat anyway). Cached per page.
	 */
	function blockedEither(other) {
		if (!uid || !other || other === uid) return Promise.resolve(false);
		if (!blockCache[other]) {
			blockCache[other] = Promise.all([
				db().ref('blocks/' + uid + '/' + other).once('value').then((s) => s.val() === true, () => false),
				db().ref('blocks/' + other + '/' + uid).once('value').then((s) => s.val() === true, () => false),
			]).then(([a, b]) => a || b);
		}
		return blockCache[other];
	}

	/**
	 * The players this one follows, with their names and whether they have a
	 * tab open: callback([{ uid, displayName, online }]), sorted online first.
	 * Returns a function that stops watching.
	 */
	function watchFriends(callback) {
		if (!uid) { callback([]); return () => {}; }
		const me = uid;
		const people = {};   // uid -> { uid, displayName, online, ref }
		const render = () => callback(Object.values(people).map((p) => ({ uid: p.uid, displayName: p.displayName, online: p.online }))
			.sort((a, b) => (b.online - a.online) || a.displayName.localeCompare(b.displayName)));
		const listRef = db().ref('follows/' + me);
		listRef.on('value', (snap) => {
			const keys = Object.keys(snap.val() || {});
			Object.keys(people).forEach((k) => {
				if (!keys.includes(k)) { people[k].ref.off(); delete people[k]; }
			});
			keys.forEach((k) => {
				if (people[k]) return;
				const p = people[k] = { uid: k, displayName: '…', online: false, ref: db().ref('presence/' + k) };
				p.ref.on('value', (s) => { p.online = s.exists(); render(); }, () => {});
				db().ref('users/' + k + '/displayName').once('value')
					.then((s) => { p.displayName = s.val() || 'Player'; render(); }, () => {});
			});
			render();
		}, () => callback([]));
		return () => {
			listRef.off();
			Object.values(people).forEach((p) => p.ref.off());
		};
	}

	// ---- Challenges ----

	function tcLabel(tc) {
		if (!tc || !tc.type || tc.type === 'none') return 'Unlimited';
		if (tc.type === 'realtime') return Math.round((tc.initialTime || 0) / 6000) / 10 + '+' + Math.round((tc.increment || 0) / 1000);
		if (tc.type === 'correspondence') {
			const ms = tc.moveTimeout || 0;
			return ms >= 86400000 ? Math.round(ms / 86400000) + 'd/move' : Math.round(ms / 3600000) + 'h/move';
		}
		return '';
	}

	function variantLabel(v) {
		if (!v || v === 'standard') return 'Standard';
		const names = { competitive: 'Competitive', deathmatch: 'Deathmatch', scramble: 'Scramble', duplicates: 'Duplicates', pentagon: 'Cataclysm' };
		return String(v).split('_').map((t) => names[t] || t).join(' + ');
	}

	/** Check a challenge against its room; stale ones are removed. */
	async function admit(room, c) {
		const me = uid;
		try {
			const r = (await db().ref('rooms/' + room).once('value')).val();
			const creator = r && r.creatorColor === 'blue' ? 'blue' : 'red';
			const open = r && r.status === 'waiting' && r.invite === me && r[creator] && r[creator].uid === c.from;
			if (!open) {
				db().ref('challenges/' + me + '/' + room).remove().catch(() => {});
				return;
			}
			const name = (await db().ref('users/' + c.from + '/displayName').once('value')).val() || (r[creator].displayName) || 'A player';
			if (uid !== me) return;
			challenges[room] = { room, from: c.from, name, tcLabel: tcLabel(r.timeControl), variantLabel: r.startSfn ? 'From a position' : variantLabel(r.variant) };
			renderBanner();
			emit();
		} catch (e) { /* unreadable room: no banner */ }
	}

	function watchChallenges() {
		challengesRef = db().ref('challenges/' + uid);
		challengesRef.on('value', (snap) => {
			const all = snap.val() || {};
			Object.keys(challenges).forEach((room) => { if (!all[room]) delete challenges[room]; });
			Object.keys(all).forEach((room) => {
				const c = all[room];
				if (!challenges[room] && c && typeof c.from === 'string') admit(room, c);
			});
			renderBanner();
			emit();
		}, () => {});
	}

	async function accept(room) {
		if (uid) await db().ref('challenges/' + uid + '/' + room).remove().catch(() => {});
		location.href = ROOT + 'multiplayer.html?id=' + encodeURIComponent(room);
	}

	async function decline(room) {
		delete challenges[room];
		renderBanner();
		emit();
		if (uid) await db().ref('challenges/' + uid + '/' + room).remove().catch(() => {});
	}

	function lookingAt(room) {
		const p = new URLSearchParams(location.search);
		return /multiplayer\.html$/.test(location.pathname) && p.get('id') === room;
	}

	function injectStyle() {
		if (document.getElementById('challenge-banner-style')) return;
		const st = document.createElement('style');
		st.id = 'challenge-banner-style';
		st.textContent = [
			'.challenge-banner{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9998;display:flex;flex-direction:column;gap:8px;width:min(520px,calc(100% - 32px));}',
			'.challenge-banner__item{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 14px;border-radius:8px;background:var(--color-surface-raised,#2b2b2b);border:1px solid var(--color-accent,#c9a227);color:var(--color-text-warm,#eee);font-family:\'Overlock\',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);}',
			'.challenge-banner__text{flex:1 1 220px;}',
			'.challenge-banner__text b{color:var(--color-text-bright,#fff);}',
			'.challenge-banner button{padding:6px 12px;border-radius:6px;border:1px solid var(--color-border,#555);background:var(--color-surface,#333);color:inherit;font-family:inherit;cursor:pointer;}',
			'.challenge-banner .challenge-banner__accept{background:var(--color-success,#4caf50);border-color:var(--color-success,#4caf50);color:#fff;font-weight:bold;}',
		].join('\n');
		document.head.appendChild(st);
	}

	function renderBanner() {
		if (!document.body) {
			document.addEventListener('DOMContentLoaded', renderBanner, { once: true });
			return;
		}
		let box = document.getElementById('challenge-banner');
		const rooms = Object.keys(challenges).filter((r) => !lookingAt(r));
		if (!rooms.length || !uid) {
			if (box) box.remove();
			return;
		}
		injectStyle();
		if (!box) {
			box = document.createElement('div');
			box.id = 'challenge-banner';
			box.className = 'challenge-banner';
			box.setAttribute('role', 'status');
			document.body.appendChild(box);
		}
		box.textContent = '';
		rooms.forEach((room) => {
			const c = challenges[room];
			const item = document.createElement('div');
			item.className = 'challenge-banner__item';
			item.dataset.room = room;
			const text = document.createElement('span');
			text.className = 'challenge-banner__text';
			const who = document.createElement('b');
			who.textContent = c.name;
			text.append(who, ' challenges you: ' + c.tcLabel + ' · ' + c.variantLabel);
			const yes = document.createElement('button');
			yes.type = 'button';
			yes.className = 'challenge-banner__accept';
			yes.textContent = 'Accept';
			yes.addEventListener('click', () => accept(room));
			const no = document.createElement('button');
			no.type = 'button';
			no.className = 'challenge-banner__decline';
			no.textContent = 'Decline';
			no.addEventListener('click', () => decline(room));
			item.append(text, yes, no);
			box.appendChild(item);
		});
	}

	// ---- Sign-in ----

	function stop() {
		goOffline();
		if (connectedRef) connectedRef.off();
		connectedRef = null;
		if (challengesRef) challengesRef.off();
		challengesRef = null;
		Object.keys(challenges).forEach((r) => delete challenges[r]);
		Object.keys(blockCache).forEach((k) => delete blockCache[k]);
		uid = null;
		renderBanner();
		emit();
	}

	function start(user) {
		uid = user.uid;
		// Re-announce after a dropped connection (the server ran our
		// onDisconnect while we were gone).
		connectedRef = db().ref('.info/connected');
		connectedRef.on('value', (s) => { if (s.val() === true) goOnline(); });
		watchChallenges();
		emit();
	}

	firebase.auth().onAuthStateChanged((user) => {
		stop();
		if (user && !user.isAnonymous) start(user);
	});
	// A guest who links an account keeps the uid (auth-status.js).
	window.addEventListener('sigil-auth-refresh', () => {
		const user = firebase.auth().currentUser;
		if (user && !user.isAnonymous && uid !== user.uid) { stop(); start(user); }
	});

	window.SigilFriends = {
		get uid() { return uid; },
		get signedIn() { return signedIn(); },
		get challenges() { return Object.values(challenges); },
		onChange(fn) { listeners.push(fn); fn(); },
		follow,
		unfollow,
		isFollowing,
		block,
		unblock,
		isBlocked,
		blockedEither,
		watchFriends,
		accept,
		decline,
		tcLabel,
		variantLabel,
	};
})();
