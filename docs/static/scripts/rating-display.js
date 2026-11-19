/**
 * rating-display.js — which rating the site shows, by one flag.
 *
 * The rating function writes both the Elo (users/{uid}/elo, leaderboard/) and
 * the Glicko-2 pool ratings (ratings/{uid}/{pool}, pool_leaderboard/,
 * engine/glicko.js). The pages show the Elo until site_config/ratingDisplay is
 * 'glicko' (set in the Firebase console; the rules make site_config read-only
 * to clients), and the pool ratings from then on: the leaderboard by pool, the
 * profile's ratings and games, the lobby's open games and the game-over
 * rating line. Setting it back to anything else (or removing it) shows the
 * Elo again; nothing else changes.
 *
 * site_config/matchmaking === true shows the lobby's matchmaking (the
 * matchmake function must be deployed first).
 *
 * Previews, for one tab: ?ratings=glicko or ?ratings=elo, and ?mm=1 (kept in
 * sessionStorage until the tab closes).
 *
 *   SigilRatings.ready()  resolves with the mode once site_config is read
 *   SigilRatings.mode     'elo' | 'glicko' ('elo' until then)
 *   SigilRatings.glicko   mode === 'glicko'
 * A 'sigil-ratings' window event fires when the mode is known.
 */
(function () {
	'use strict';
	if (window.SigilRatings) return;
	const KEY = 'sigil_rating_display';
	const MM_KEY = 'sigil_matchmaking_preview';
	let override = null;
	let mmPreview = false;
	try {
		const q = new URLSearchParams(location.search);
		const v = q.get('ratings');
		if (v === 'glicko' || v === 'elo') sessionStorage.setItem(KEY, v);
		if (q.get('mm') === '1') sessionStorage.setItem(MM_KEY, '1');
		if (q.get('mm') === '0') sessionStorage.removeItem(MM_KEY);
		override = sessionStorage.getItem(KEY);
		mmPreview = sessionStorage.getItem(MM_KEY) === '1';
	} catch (e) { /* storage blocked: no preview */ }

	const G = () => (typeof SigilGlicko !== 'undefined' ? SigilGlicko : null);
	const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

	const api = {
		mode: override === 'glicko' ? 'glicko' : 'elo',
		matchmaking: mmPreview,
		known: false,
		_ready: null,

		get glicko() { return this.mode === 'glicko'; },

		ready() {
			if (this._ready) return this._ready;
			this._ready = (async () => {
				try {
					if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
						const snap = await withTimeout(firebase.database().ref('site_config').once('value'), 6000);
						const cfg = (snap && snap.val()) || {};
						if (!override) this.mode = cfg.ratingDisplay === 'glicko' ? 'glicko' : 'elo';
						this.matchmaking = mmPreview || cfg.matchmaking === true;
					}
				} catch (e) { /* offline or refused: the Elo */ }
				this.known = true;
				try { window.dispatchEvent(new CustomEvent('sigil-ratings', { detail: { mode: this.mode, matchmaking: this.matchmaking } })); } catch (e) {}
				return this.mode;
			})();
			return this._ready;
		},

		/** A player's pool records ({ pool: record }), as stored. */
		async loadPools(uid) {
			if (!uid || typeof firebase === 'undefined') return {};
			try {
				const v = (await firebase.database().ref('ratings/' + uid).once('value')).val() || {};
				const out = {};
				for (const [p, rec] of Object.entries(v)) {
					const n = G() ? G().normalize(rec) : null;
					if (n) out[p] = n;
				}
				return out;
			} catch (e) {
				return {};
			}
		},

		/** The pool of a room or game record. */
		poolOf(room) {
			if (!G() || !room) return null;
			const v = typeof normalizeVariant === 'function' ? normalizeVariant(room.variant) : (room.variant || 'standard');
			return G().poolOf(v, room.timeControl);
		},

		label(pool) { return G() ? G().poolLabel(pool) : String(pool || ''); },

		/** "1480?" — a record as of now (its deviation grown by time away). */
		format(rec) {
			if (!G() || !rec) return '';
			return G().format(Object.assign({}, rec, { rd: G().currentRd(rec, Date.now()) }));
		},

		/** "1240–1720", the 95% range of a record as of now. */
		range(rec) {
			if (!G() || !rec) return '';
			return G().formatRange(Object.assign({}, rec, { rd: G().currentRd(rec, Date.now()) }));
		},

		/** What a seat's pool rating would be before its first game there: its Elo, provisional. */
		seedFromElo(elo, gamesPlayed) {
			return G() ? G().seed(typeof elo === 'number' ? elo : null, gamesPlayed || 0, Date.now()) : null;
		},

		/**
		 * The game-over line for a user_games entry's glicko:
		 * "Blitz rating: +15 (1456? → 1471)".
		 */
		describeChange(g) {
			if (!g || typeof g.after !== 'number' || typeof g.before !== 'number' || !G()) return '';
			const C = G().C;
			const fmt = (r, rd) => String(Math.round(r)) + (rd > C.PROVISIONAL_RD ? '?' : '');
			const d = Math.round(g.after) - Math.round(g.before);
			const sign = d >= 0 ? '+' : '−';
			return this.label(g.pool) + ' rating: ' + sign + Math.abs(d) + ' (' + fmt(g.before, g.rdBefore) + ' → ' + fmt(g.after, g.rdAfter) + ')';
		},
	};
	window.SigilRatings = api;
	// Pages load this after their Firebase app: read the flag straight away.
	const start = () => { if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) api.ready(); };
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();
})();
