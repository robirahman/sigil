/**
 * Preferences: every display, sound, clock and play setting in one store,
 * the controls that edit them, and their copy on the player's account.
 *
 * Loaded in <head> after theme-manager.js on every page, so the board
 * attributes on <html> are set before first paint:
 *   data-motion       the animation level
 *   data-colourblind  shape markers on red and blue
 *   data-zen          zen mode (pages with <body class="zen-page">)
 *   data-blind        blind mode (pages with <body class="blind-page">;
 *                     blind-mode.js reads the position out instead)
 *   data-node-names   each node labelled with its name
 *   data-no-last-move / data-no-legal-moves   those highlights off
 *
 * One stored value per setting, never two: settings that existed before
 * this store keep their own key and owner, so older pages stay in sync.
 *   theme    themeManager           localStorage 'sigil_theme'
 *   muted    soundManager           localStorage 'sigil_muted'
 *   artOnly  the game components    localStorage 'sigilArtOnlySpellCircles'
 * Everything else lives together in localStorage 'sigil_settings'.
 *
 * Signed-in players: the settings marked `sync` below are also kept at
 * users/<uid>/prefs (database.rules.json validates each one) and follow the
 * account to every device. On sign-in the account's copy wins; an account
 * with none yet takes this device's. A change is written through, one leaf
 * at a time, and a change made on another device arrives live. Volume, mute
 * and zen stay per device. Guests (anonymous or signed out) use this
 * device's copy only.
 *
 * Every change dispatches a 'sigil-settings' window event whose detail is
 * SigilSettings.snapshot().
 */
const SIGIL_SETTINGS_KEY = 'sigil_settings';

// key: default, allowed values (null = any of the default's type), synced
// to the account.
const SIGIL_PREF_DEFS = {
	theme: { def: 'default', sync: true },
	artOnly: { def: false, sync: true },
	colourblind: { def: false, sync: true },
	nodeNames: { def: false, sync: true },
	lastMove: { def: true, sync: true },
	legalMoves: { def: true, sync: true },
	// null: follow the system's prefers-reduced-motion ('system' in the account copy).
	motion: { def: null, values: [null, 'full', 'reduced', 'off'], sync: true },
	muted: { def: false, sync: false },
	volume: { def: 1, sync: false },
	soundMoves: { def: true, sync: true },
	soundSpells: { def: true, sync: true },
	soundGame: { def: true, sync: true },
	soundLowTime: { def: true, sync: true },
	// Tenths of a second on the clock: never, under the low-time mark, always.
	clockTenths: { def: 'low', values: ['never', 'low', 'always'], sync: true },
	// The low-time mark in seconds (0: no warning).
	clockLow: { def: 10, values: [0, 10, 20, 30, 60], sync: true },
	confirmEndTurn: { def: false, sync: true },
	confirmForfeit: { def: true, sync: true },
	blind: { def: false, sync: true },
	zen: { def: false, sync: false },
	// Online games: see the preset emotes; offer the picker.
	showEmotes: { def: true, sync: true },
	sendEmotes: { def: true, sync: true },
};

// Which setting gates each sound (sound-manager.js).
const SIGIL_SOUND_PREF = {
	stonePlaced: 'soundMoves', stonePushed: 'soundMoves', stoneCrushed: 'soundMoves',
	spellCast: 'soundSpells', gameStart: 'soundGame', gameOver: 'soundGame', lowTime: 'soundLowTime',
};

const SigilSettings = {
	_cache: null,
	_warned: new WeakMap(),

	valid(name, v) {
		const d = SIGIL_PREF_DEFS[name];
		if (!d) return false;
		if (d.values) return d.values.includes(v);
		if (name === 'theme') return typeof v === 'string' && /^[a-z]{1,20}$/.test(v) && (typeof THEMES === 'undefined' || !!THEMES[v]);
		if (name === 'volume') return typeof v === 'number' && v >= 0 && v <= 1;
		return typeof v === typeof d.def;
	},

	_defaults() {
		const out = {};
		for (const k in SIGIL_PREF_DEFS) out[k] = SIGIL_PREF_DEFS[k].def;
		return out;
	},

	_load() {
		if (this._cache) return this._cache;
		let saved = null;
		try { saved = JSON.parse(localStorage.getItem(SIGIL_SETTINGS_KEY) || 'null'); } catch (e) { /* storage blocked or corrupt */ }
		if (!saved || typeof saved !== 'object') saved = {};
		// "Mute emotes" (before 2026-11) hid the emotes and the picker.
		if (saved.muteEmotes === true && saved.showEmotes === undefined) {
			saved.showEmotes = false;
			saved.sendEmotes = false;
		}
		const s = this._defaults();
		for (const k in saved) if (k in s && this.valid(k, saved[k])) s[k] = saved[k];
		this._cache = s;
		return s;
	},

	_store(s) {
		const out = {};
		for (const k in s) if (!(k in this._own)) out[k] = s[k];
		try { localStorage.setItem(SIGIL_SETTINGS_KEY, JSON.stringify(out)); } catch (e) { /* storage blocked */ }
	},

	// The settings with a key of their own.
	_own: { theme: 1, muted: 1, artOnly: 1 },

	_flag(key) {
		try { return localStorage.getItem(key) === 'true'; } catch (e) { return false; }
	},

	_setFlag(key, on) {
		try { localStorage.setItem(key, on ? 'true' : 'false'); } catch (e) { /* storage blocked */ }
	},

	_reducedQuery() {
		return window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
	},

	/** The animation level in force: the stored choice, else the system's. */
	motion() {
		const m = this._load().motion;
		if (m === 'full' || m === 'reduced' || m === 'off') return m;
		const q = this._reducedQuery();
		return q && q.matches ? 'reduced' : 'full';
	},

	get(name) {
		if (name === 'theme') return typeof themeManager !== 'undefined' ? themeManager.current : 'default';
		if (name === 'muted') return typeof soundManager !== 'undefined' ? soundManager.muted : this._flag('sigil_muted');
		if (name === 'artOnly') return this._flag('sigilArtOnlySpellCircles');
		if (name === 'motion') return this.motion();
		return this._load()[name];
	},

	/** The stored value: like get(), but motion is null while it follows the system. */
	stored(name) {
		return name === 'motion' ? this._load().motion : this.get(name);
	},

	// Write one setting on this device only (no event, no account write).
	_write(name, value) {
		if (name === 'theme') {
			if (typeof themeManager !== 'undefined') themeManager.apply(value);
			else try { localStorage.setItem('sigil_theme', value); } catch (e) { /* storage blocked */ }
		} else if (name === 'muted') {
			if (typeof soundManager !== 'undefined') soundManager.setMuted(!!value);
			else this._setFlag('sigil_muted', !!value);
		} else if (name === 'artOnly') {
			this._setFlag('sigilArtOnlySpellCircles', !!value);
		} else {
			const s = Object.assign({}, this._load());
			s[name] = value;
			this._cache = s;
			this._store(s);
		}
	},

	set(name, value) {
		if (!this.valid(name, value)) return;
		this._write(name, value);
		this.apply();
		if (SIGIL_PREF_DEFS[name].sync) SigilPrefsSync.push(name, value);
		this._changed();
	},

	_changed() {
		window.dispatchEvent(new CustomEvent('sigil-settings', { detail: this.snapshot() }));
	},

	snapshot() {
		const out = {};
		for (const k in SIGIL_PREF_DEFS) out[k] = this.get(k);
		return out;
	},

	/** The synced settings as the account stores them. */
	_accountCopy() {
		const out = {};
		for (const k in SIGIL_PREF_DEFS) {
			if (!SIGIL_PREF_DEFS[k].sync) continue;
			const v = this.stored(k);
			out[k] = k === 'motion' && v === null ? 'system' : v;
		}
		return out;
	},

	/** Take the account's copy (users/<uid>/prefs); only valid keys, only changes. */
	_adopt(remote) {
		let changed = false;
		for (const k in remote) {
			const d = SIGIL_PREF_DEFS[k];
			if (!d || !d.sync) continue;
			const v = k === 'motion' && remote[k] === 'system' ? null : remote[k];
			if (!this.valid(k, v) || this.stored(k) === v) continue;
			this._write(k, v);
			changed = true;
		}
		if (changed) {
			this.apply();
			this._changed();
		}
		return changed;
	},

	/** Reflect the settings on <html> and the sound manager. */
	apply() {
		const s = this._load();
		const root = document.documentElement;
		root.setAttribute('data-motion', this.motion());
		const attr = (name, on) => { if (on) root.setAttribute(name, ''); else root.removeAttribute(name); };
		attr('data-colourblind', s.colourblind);
		attr('data-zen', s.zen);
		attr('data-blind', s.blind);
		attr('data-node-names', s.nodeNames);
		attr('data-no-last-move', !s.lastMove);
		attr('data-no-legal-moves', !s.legalMoves);
		if (typeof soundManager !== 'undefined') soundManager.volume = s.volume;
	},

	/** Whether the sound `name` should play (its group is on). */
	soundOn(name) {
		const key = SIGIL_SOUND_PREF[name];
		return !key || this.get(key) !== false;
	},

	/** True when `ms` is under the low-time mark (never when it is off). */
	clockLow(ms) {
		const s = this.get('clockLow');
		return s > 0 && ms < s * 1000;
	},

	/** A running clock's text: m:ss, with tenths as the setting says. */
	clockText(ms) {
		ms = Math.max(0, Number(ms) || 0);
		const tenths = this.get('clockTenths');
		const mark = (this.get('clockLow') || 10) * 1000;
		if (tenths === 'always' || (tenths === 'low' && ms < mark)) {
			// Down, so it never shows more time than is left.
			const t = Math.floor(ms / 100);
			const sec = Math.floor(t / 10);
			return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') + '.' + (t % 10);
		}
		const total = Math.ceil(ms / 1000);
		return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
	},

	/**
	 * The low-time warning: one sound when `color`'s running clock crosses
	 * the mark, again only after it has gone back above it (an increment).
	 * `owner` is the game component, so two boards keep their own state.
	 */
	lowTimeWarn(owner, color, ms) {
		const mark = this.get('clockLow') * 1000;
		if (!(mark > 0) || !(ms > 0)) return;
		const st = this._warned.get(owner) || {};
		if (ms < mark) {
			if (!st[color] && typeof soundManager !== 'undefined') soundManager.play('lowTime');
			st[color] = true;
		} else if (ms > mark + 2000) {
			st[color] = false;
		}
		this._warned.set(owner, st);
	},
};

/**
 * The account copy, users/<uid>/prefs. Started once the page has set up
 * Firebase; pages without it (or without a signed-in account) skip it.
 */
const SigilPrefsSync = {
	_ref: null,
	_cb: null,
	_seeded: null,

	start() {
		try {
			if (typeof firebase === 'undefined' || !firebase.apps || !firebase.apps.length || !firebase.auth || !firebase.database) return;
			firebase.auth().onAuthStateChanged((u) => this._user(u));
		} catch (e) { /* no Firebase on this page */ }
	},

	_user(u) {
		try {
			if (this._ref && this._cb) this._ref.off('value', this._cb);
		} catch (e) { /* ignore */ }
		this._ref = null;
		this._cb = null;
		if (!u || u.isAnonymous) return;
		try {
			const ref = firebase.database().ref('users/' + u.uid + '/prefs');
			this._ref = ref;
			this._cb = (snap) => {
				const v = snap.val();
				if (v && typeof v === 'object') SigilSettings._adopt(v);
				else this._seed(u.uid);
			};
			ref.on('value', this._cb, () => { /* offline or refused: keep this device's */ });
		} catch (e) { /* ignore */ }
	},

	// An account without prefs takes this device's, once its profile exists
	// (the rules refuse prefs on an account with no profile yet: a sign-up
	// writes it just after signing in).
	_seed(uid) {
		if (this._seeded === uid || !this._ref) return;
		this._seeded = uid;
		const ref = this._ref;
		try {
			const nameRef = firebase.database().ref('users/' + uid + '/displayName');
			const cb = (named) => {
				if (!named.exists()) return;
				nameRef.off('value', cb);
				if (this._ref !== ref) return;
				ref.once('value').then((cur) => {
					if (!cur.exists() && this._ref === ref) return ref.update(SigilSettings._accountCopy());
				}).catch(() => { /* offline: the next page load tries again */ });
			};
			nameRef.on('value', cb, () => { this._seeded = null; });
		} catch (e) {
			this._seeded = null;
		}
	},

	push(name, value) {
		if (!this._ref) return;
		try {
			const p = this._ref.child(name).set(name === 'motion' && value === null ? 'system' : value);
			if (p && p.catch) p.catch(() => { /* no profile yet, or offline */ });
		} catch (e) { /* ignore */ }
	},
};

SigilSettings.apply();
(function () {
	// Following the system: track it live until the player picks a level.
	const q = SigilSettings._reducedQuery();
	if (q && q.addEventListener) q.addEventListener('change', () => SigilSettings.apply());
	// Another tab changed a setting.
	window.addEventListener('storage', (e) => {
		if (e.key !== SIGIL_SETTINGS_KEY && e.key !== 'sigil_theme' && e.key !== 'sigil_muted' && e.key !== 'sigilArtOnlySpellCircles') return;
		SigilSettings._cache = null;
		if (e.key === 'sigil_theme' && typeof themeManager !== 'undefined' && e.newValue && e.newValue !== themeManager.current) themeManager.apply(e.newValue);
		if (e.key === 'sigil_muted' && typeof soundManager !== 'undefined') soundManager.muted = e.newValue === 'true';
		SigilSettings.apply();
		SigilSettings._changed();
	});
	document.addEventListener('DOMContentLoaded', () => SigilPrefsSync.start());
})();

/**
 * The controls: SigilPrefsUI.render(container, { sections, emotes }) fills
 * `container` with one row per setting (data-setting="<name>") and keeps
 * them current. The in-game settings dialog (settings-panel.js) and
 * preferences.html both use it.
 */
const SIGIL_PREF_SECTIONS = [
	{ id: 'board', title: 'Board and stones', rows: [
		['theme', 'Theme'],
		['artOnly', 'Art-only spell circles', 'Hide spell names and descriptions on the board circles.'],
		['colourblind', 'Colourblind markers', 'A diamond on red stones and a ring on blue ones, also on glows, locks and clocks.'],
		['nodeNames', 'Show node names', 'Label every node with its name (a1 to c13), as the game log and blind mode name them.'],
		['lastMove', 'Highlight the last move', 'A ring around the stone played last.'],
		['legalMoves', 'Show legal moves', 'A glow on the nodes you can play. Off: click any node; an illegal one does nothing.'],
		['motion', 'Animations', 'Follows your system’s reduce-motion setting until you choose.'],
	] },
	{ id: 'sound', title: 'Sound', rows: [
		['muted', 'Mute sound'],
		['volume', 'Volume', 'Mute and volume are kept on this device.'],
		['soundMoves', 'Stone sounds', 'Placing, pushing and crushing stones.'],
		['soundSpells', 'Spell sounds'],
		['soundGame', 'Game start and end'],
		['soundLowTime', 'Low-time warning sound', 'A beep when your clock passes the low-time mark.'],
	] },
	{ id: 'clock', title: 'Clock', rows: [
		['clockTenths', 'Tenths of a second'],
		['clockLow', 'Low-time mark', 'The clock turns urgent below it, and the warning sound plays.'],
	] },
	{ id: 'play', title: 'Play', rows: [
		['confirmEndTurn', 'Confirm before ending a turn', 'End Turn asks once more before passing.'],
		['confirmForfeit', 'Confirm before forfeiting', 'Forfeit asks once more before conceding.'],
		['blind', 'Blind mode', 'Play without seeing the stones: the board shows only the nodes, each move is read out, and P describes the position.'],
		['zen', 'Zen mode', 'Hide everything but the board, the clocks and the turn buttons. Z toggles it.'],
	] },
	{ id: 'online', title: 'Online games', rows: [
		['showEmotes', 'Show emotes', 'The preset emotes players send. Off hides them, your opponent’s and your own.'],
		['sendEmotes', 'Offer the emote picker', 'Off removes the button for sending emotes.'],
	] },
];

const SIGIL_PREF_CHOICES = {
	motion: [['full', 'Full'], ['reduced', 'Reduced'], ['off', 'Off']],
	clockTenths: [['never', 'Never'], ['low', 'Under the low-time mark'], ['always', 'Always']],
	clockLow: [[0, 'Off'], [10, '10 seconds'], [20, '20 seconds'], [30, '30 seconds'], [60, '1 minute']],
};

const SigilPrefsUI = {
	_h(tag, attrs, children) {
		const el = document.createElement(tag);
		for (const k in attrs || {}) {
			if (k === 'text') el.textContent = attrs[k];
			else el.setAttribute(k, attrs[k]);
		}
		for (const c of children || []) el.appendChild(c);
		return el;
	},

	_control(name) {
		const h = this._h.bind(this);
		const d = SIGIL_PREF_DEFS[name];
		if (name === 'theme') {
			const sel = h('select', { 'data-setting': 'theme' });
			const list = typeof themeManager !== 'undefined' ? themeManager.getThemeList() : [{ id: 'default', name: 'Arcane' }];
			for (const t of list) sel.appendChild(h('option', { value: t.id, text: t.name }));
			sel.addEventListener('change', () => SigilSettings.set('theme', sel.value));
			return { el: sel, refresh: () => { sel.value = SigilSettings.get('theme'); } };
		}
		if (name === 'volume') {
			const range = h('input', { type: 'range', min: '0', max: '100', step: '5', 'data-setting': 'volume' });
			const out = h('output', { class: 'settings-panel__value' });
			range.addEventListener('input', () => {
				out.textContent = range.value + '%';
				SigilSettings.set('volume', Number(range.value) / 100);
			});
			// A short blip at the new level, so the slider is heard as it is set.
			range.addEventListener('change', () => {
				if (typeof soundManager !== 'undefined') soundManager.play('stonePlaced');
			});
			return { el: range, extra: out, refresh: () => {
				range.value = String(Math.round(SigilSettings.get('volume') * 100));
				out.textContent = range.value + '%';
			} };
		}
		if (SIGIL_PREF_CHOICES[name]) {
			const sel = h('select', { 'data-setting': name });
			for (const [v, label] of SIGIL_PREF_CHOICES[name]) sel.appendChild(h('option', { value: String(v), text: label }));
			const num = typeof d.def === 'number';
			sel.addEventListener('change', () => SigilSettings.set(name, num ? Number(sel.value) : sel.value));
			return { el: sel, refresh: () => { sel.value = String(SigilSettings.get(name)); } };
		}
		const box = h('input', { type: 'checkbox', 'data-setting': name });
		box.addEventListener('change', () => SigilSettings.set(name, box.checked));
		return { el: box, refresh: () => { box.checked = !!SigilSettings.get(name); } };
	},

	/**
	 * opts.sections: section ids to show (default all); opts.emotes: show the
	 * online-games section (default: the page has <body data-emotes>);
	 * opts.headings: section headings (default true). Returns refresh().
	 */
	render(container, opts) {
		opts = opts || {};
		const h = this._h.bind(this);
		const refreshers = [];
		const emotes = opts.emotes !== undefined ? opts.emotes : document.body.hasAttribute('data-emotes');
		for (const sec of SIGIL_PREF_SECTIONS) {
			if (opts.sections && !opts.sections.includes(sec.id)) continue;
			if (sec.id === 'online' && !emotes) continue;
			const group = h('div', { class: 'settings-panel__section', 'data-section': sec.id });
			if (opts.headings !== false) group.appendChild(h('h3', { class: 'settings-panel__heading', text: sec.title }));
			for (const [name, label, hint] of sec.rows) {
				const c = this._control(name);
				const isBox = c.el.type === 'checkbox';
				const row = h('div', { class: 'settings-panel__row' }, [
					h('label', {}, isBox ? [c.el, h('span', { text: label })] : [h('span', { text: label }), c.el].concat(c.extra ? [c.extra] : [])),
				].concat(hint ? [h('small', { class: 'settings-panel__hint', text: hint })] : []));
				// Zen shows only while the page offers it (body.zen-page).
				if (name === 'zen') row.classList.add('zen-only');
				group.appendChild(row);
				refreshers.push(c.refresh);
			}
			container.appendChild(group);
		}
		const refresh = () => { for (const r of refreshers) r(); };
		refresh();
		window.addEventListener('sigil-settings', refresh);
		return refresh;
	},
};
