/**
 * social.js — private notes, bookmarks, badges, the activity feed and
 * streamer links, for profile.html, feed.html, streamers.html and the game
 * pages' Bookmark button. Needs engine/badges.js (the badge catalog) and the
 * Firebase SDKs.
 *
 *   notes/{owner}/{target}: { text, at }       read and written by owner only
 *   bookmarks/{owner}/{room}: { title, at, note }  the same
 *   badges/{uid}/{id}, activity/{uid}/{key}    public, server-only (functions/social.js)
 *   titles/{uid}: { title, by, at }            public, admins only (admin.html)
 *   streamers/{uid}: { url, about, at, liveUntil }  public, by the streamer
 *
 * Notes and bookmarks need an account (guests' anonymous uids do not last).
 */
(function () {
	if (typeof firebase === 'undefined') return;
	const db = () => firebase.database();
	const TS = () => firebase.database.ServerValue.TIMESTAMP;

	function me() {
		const u = firebase.auth().currentUser;
		return u && !u.isAnonymous ? u.uid : null;
	}

	function need() {
		const uid = me();
		if (!uid) throw Object.assign(new Error('Sign in to an account first.'), { code: 'signed-out' });
		return uid;
	}

	// ---- Private notes ----

	async function getNote(target) {
		const uid = me();
		if (!uid || !target) return null;
		return (await db().ref('notes/' + uid + '/' + target).once('value')).val();
	}

	/** Save (or, with empty text, delete) the note on `target`. */
	function setNote(target, text) {
		const uid = need();
		const t = String(text || '').trim().slice(0, 1000);
		const ref = db().ref('notes/' + uid + '/' + target);
		return t ? ref.set({ text: t, at: TS() }) : ref.remove();
	}

	/** All the viewer's notes: [{ uid, text, at }], newest first. */
	async function listNotes() {
		const uid = me();
		if (!uid) return [];
		const all = (await db().ref('notes/' + uid).once('value')).val() || {};
		return Object.keys(all).map((k) => Object.assign({ uid: k }, all[k])).sort((a, b) => (b.at || 0) - (a.at || 0));
	}

	// ---- Bookmarks ----

	async function isBookmarked(room) {
		const uid = me();
		if (!uid || !room) return false;
		return (await db().ref('bookmarks/' + uid + '/' + room).once('value')).exists();
	}

	function addBookmark(room, title) {
		const uid = need();
		return db().ref('bookmarks/' + uid + '/' + room).set({ title: String(title || room).slice(0, 120) || room, at: TS() });
	}

	function removeBookmark(room) {
		return db().ref('bookmarks/' + need() + '/' + room).remove();
	}

	function setBookmarkNote(room, note) {
		const n = String(note || '').trim().slice(0, 500);
		return db().ref('bookmarks/' + need() + '/' + room + '/note').set(n || null);
	}

	/** All the viewer's bookmarks: [{ room, title, at, note }], newest first. */
	async function listBookmarks() {
		const uid = me();
		if (!uid) return [];
		const all = (await db().ref('bookmarks/' + uid).once('value')).val() || {};
		return Object.keys(all).map((k) => Object.assign({ room: k }, all[k])).sort((a, b) => (b.at || 0) - (a.at || 0));
	}

	// ---- Streamer links ----

	/**
	 * A channel link as typed, in the one form the rules accept (https, www,
	 * no trailing slash or query): { url, platform, channel } or null.
	 * Twitch: twitch.tv/<name>. YouTube: youtube.com/@handle or /channel/UC….
	 */
	function normalizeStreamUrl(input) {
		let s = String(input || '').trim();
		if (!s) return null;
		if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
		let u;
		try { u = new URL(s); } catch (e) { return null; }
		if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
		if (u.username || u.password || u.port) return null;
		const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
		const path = u.pathname.replace(/\/+$/, '');
		let m;
		if (host === 'twitch.tv' && (m = /^\/([A-Za-z0-9_]{4,25})$/.exec(path))) {
			return { url: 'https://www.twitch.tv/' + m[1], platform: 'Twitch', channel: m[1] };
		}
		if (host === 'youtube.com') {
			if ((m = /^\/(@[A-Za-z0-9._-]{3,30})$/.exec(path))) return { url: 'https://www.youtube.com/' + m[1], platform: 'YouTube', channel: m[1] };
			if ((m = /^\/channel\/(UC[A-Za-z0-9_-]{22})$/.exec(path))) return { url: 'https://www.youtube.com/channel/' + m[1], platform: 'YouTube', channel: m[1] };
		}
		return null;
	}

	/** The stored listing, described for display: { url, platform, channel, about, live } or null. */
	function describeStreamer(v, now) {
		if (!v || typeof v.url !== 'string') return null;
		const n = normalizeStreamUrl(v.url);
		if (!n || n.url !== v.url) return null;
		return Object.assign(n, { about: typeof v.about === 'string' ? v.about : '', live: typeof v.liveUntil === 'number' && v.liveUntil > (now || Date.now()) });
	}

	// ---- Badges ----

	function badgeChip(id, info) {
		const b = typeof sigilBadge === 'function' ? sigilBadge(id) : null;
		if (!b) return null;
		const el = document.createElement('span');
		el.className = 'badge-chip badge-chip--' + b.group.toLowerCase();
		el.dataset.badge = id;
		const mark = document.createElement('span');
		mark.className = 'badge-chip__mark';
		mark.setAttribute('aria-hidden', 'true');
		mark.textContent = b.mark;
		const name = document.createElement('span');
		name.className = 'badge-chip__name';
		name.textContent = b.name;
		el.append(mark, name);
		el.title = b.desc + (info && info.at ? ' (' + new Date(info.at).toLocaleDateString() + ')' : '');
		return el;
	}

	/** Earned badges of a player, in catalog order: [{ id, at, ...badge }]. */
	async function loadBadges(uid) {
		const got = (await db().ref('badges/' + uid).once('value')).val() || {};
		const list = typeof SIGIL_BADGES !== 'undefined' ? SIGIL_BADGES : [];
		return list.filter((b) => got[b.id]).map((b) => Object.assign({}, b, got[b.id]));
	}

	// ---- Activity ----

	function when(ts) {
		if (!ts) return '';
		const diff = Date.now() - ts;
		const day = 86400000;
		if (diff < 60000) return 'just now';
		if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
		if (diff < day) return Math.floor(diff / 3600000) + 'h ago';
		if (diff < 7 * day) return Math.floor(diff / day) + 'd ago';
		return new Date(ts).toLocaleDateString();
	}

	function link(href, text, cls) {
		const a = document.createElement('a');
		a.href = href;
		a.textContent = text;
		if (cls) a.className = cls;
		return a;
	}

	/**
	 * One feed line as DOM: `actor` = { uid, name }, `e` the activity entry.
	 * Everything is set as text: names and tournament titles are user data.
	 */
	function activityNode(actor, e) {
		const li = document.createElement('li');
		li.className = 'activity-item activity-item--' + String(e.t || 'other').replace(/[^a-z-]/g, '');
		const who = link('profile.html?uid=' + encodeURIComponent(actor.uid), actor.name || 'A player', 'activity-item__who');
		const body = document.createElement('span');
		body.className = 'activity-item__text';
		body.appendChild(who);
		const add = (x) => body.append(x);
		switch (e.t) {
			case 'win': {
				add(' beat ');
				const opp = e.oppName || (e.oppAI ? 'the AI' : 'a player');
				add(e.opp ? link('profile.html?uid=' + encodeURIComponent(e.opp), opp) : opp);
				if (e.rated && typeof e.change === 'number') add(' (' + (e.change >= 0 ? '+' : '') + e.change + (typeof e.elo === 'number' ? ', now ' + e.elo : '') + ')');
				else if (!e.rated) add(' in an unrated game');
				if (e.game) { add(' · '); add(link('multiplayer.html?id=' + encodeURIComponent(e.game), 'review', 'activity-item__review')); }
				break;
			}
			case 'rating':
				add(' reached a rating of ' + e.elo);
				break;
			case 'puzzle-streak':
				add(' solved the ');
				add(link('puzzles.html', 'daily puzzle'));
				add(' ' + e.n + ' days in a row');
				break;
			case 'badge': {
				add(' earned a badge: ');
				const chip = badgeChip(e.badge, e);
				if (chip) add(chip); else add(String(e.badge));
				break;
			}
			case 'tournament-join':
				add(' joined ' + (e.tname || 'a tournament'));
				break;
			case 'tournament-win':
				add(' won ' + (e.tname || 'a tournament'));
				break;
			default:
				return null;
		}
		const t = document.createElement('time');
		t.className = 'activity-item__when';
		t.dateTime = new Date(e.at || 0).toISOString();
		t.title = new Date(e.at || 0).toLocaleString();
		t.textContent = when(e.at);
		li.append(body, t);
		return li;
	}

	/** The newest `n` activity entries of one player: [{ key, ...entry }], newest first. */
	async function loadActivity(uid, n) {
		const snap = await db().ref('activity/' + uid).orderByChild('at').limitToLast(n || 20).once('value');
		const out = [];
		snap.forEach((c) => { out.push(Object.assign({ key: c.key }, c.val())); });
		return out.sort((a, b) => (b.at || 0) - (a.at || 0));
	}

	/**
	 * The feed for the players `uids`: each one's newest `perUser` entries,
	 * merged newest first, at most `limit`. [{ uid, name, entry }]
	 */
	async function loadFeed(uids, perUser, limit) {
		const rows = [];
		await Promise.all(uids.map(async (uid) => {
			try {
				const [list, name] = await Promise.all([
					loadActivity(uid, perUser || 15),
					db().ref('users/' + uid + '/displayName').once('value').then((s) => s.val()),
				]);
				for (const e of list) rows.push({ uid, name: name || 'A player', entry: e });
			} catch (e) { /* that player's entries are skipped */ }
		}));
		rows.sort((a, b) => (b.entry.at || 0) - (a.entry.at || 0));
		return rows.slice(0, limit || 60);
	}

	function injectStyle() {
		if (document.getElementById('social-style')) return;
		const st = document.createElement('style');
		st.id = 'social-style';
		st.textContent = [
			'.badge-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 10px 2px 2px;border-radius:999px;background:var(--color-surface-raised,#2b2b2b);border:1px solid var(--color-border,#555);font-family:\'Overlock\',sans-serif;font-size:.9em;color:var(--color-text-warm,#eee);vertical-align:middle;}',
			'.badge-chip__mark{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:24px;padding:0 4px;box-sizing:border-box;border-radius:999px;background:var(--color-accent,#c9a227);color:#1b1b1b;font-family:\'Arvo\',serif;font-size:.75em;font-weight:bold;}',
			'.badge-chip--rating .badge-chip__mark{background:#7fb2e5;}',
			'.badge-chip--puzzles .badge-chip__mark{background:#8fd18f;}',
			'.badge-chip--tournaments .badge-chip__mark{background:#e5a07f;}',
			'.badge-chip--locked{opacity:.45;}',
			'.title-chip{display:inline-block;margin-left:.4em;padding:1px 8px;border-radius:4px;border:1px solid var(--color-accent,#c9a227);color:var(--color-accent,#c9a227);font-family:\'Overlock\',sans-serif;font-size:.55em;letter-spacing:.04em;vertical-align:middle;}',
			'.activity-list{list-style:none;margin:0;padding:0;}',
			'.activity-item{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;padding:8px 10px;border-bottom:1px solid var(--color-bg-mid,#333);font-family:\'Overlock\',sans-serif;color:var(--color-text-warm,#eee);}',
			'.activity-item a{color:var(--color-accent,#c9a227);text-decoration:none;}',
			'.activity-item a:hover{text-decoration:underline;}',
			'.activity-item__who{font-weight:bold;}',
			'.activity-item__when{color:var(--color-text-dim,#999);font-size:.85em;white-space:nowrap;}',
		].join('\n');
		document.head.appendChild(st);
	}
	if (document.head) injectStyle(); else document.addEventListener('DOMContentLoaded', injectStyle);

	window.SigilSocial = {
		me,
		getNote, setNote, listNotes,
		isBookmarked, addBookmark, removeBookmark, setBookmarkNote, listBookmarks,
		normalizeStreamUrl, describeStreamer,
		badgeChip, loadBadges,
		activityNode, loadActivity, loadFeed, when,
	};
})();

/**
 * The Bookmark button on the game pages, as an Alpine component nested in the
 * board's: x-data="sigilBookmarkButton()" with
 * x-effect="bmWatch(<room code>)" and x-on:click="bmToggle(<room>, <title>)".
 * Shown to signed-in accounts only.
 */
function sigilBookmarkButton() {
	// Not reactive: x-effect re-runs bmWatch only when the room code changes.
	const seen = { room: null, user: undefined, auth: false };
	return {
		bm: { can: false, on: false, busy: false },
		bmWatch(room) {
			const r = room || '';
			const user = window.SigilSocial ? SigilSocial.me() : null;
			if (r === seen.room && user === seen.user) return;
			seen.room = r;
			seen.user = user;
			if (!seen.auth && typeof firebase !== 'undefined') {
				seen.auth = true;
				firebase.auth().onAuthStateChanged(() => this.bmWatch(seen.room));
			}
			this.bm.can = !!(user && r);
			this.bm.on = false;
			if (!this.bm.can) return;
			SigilSocial.isBookmarked(r).then((on) => { if (seen.room === r) this.bm.on = on; }, () => {});
		},
		async bmToggle(room, title) {
			if (!room || this.bm.busy || !window.SigilSocial) return;
			this.bm.busy = true;
			try {
				if (this.bm.on) await SigilSocial.removeBookmark(room);
				else await SigilSocial.addBookmark(room, title);
				this.bm.on = !this.bm.on;
			} catch (e) {
				console.warn('[Bookmark]', e);
			}
			this.bm.busy = false;
		},
	};
}
