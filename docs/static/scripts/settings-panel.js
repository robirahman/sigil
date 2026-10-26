/**
 * In-game settings panel, the keyboard-shortcut overlay and the dialog focus
 * handling shared by game.html and multiplayer.html.
 *
 * Loaded in <head> after theme-manager.js, so the animation level and the
 * colourblind markers apply before first paint (html[data-motion],
 * html[data-colourblind]).
 *
 * One stored value per setting, never two: settings that already exist
 * elsewhere keep their own key and owner, so index.html and multiplayer's
 * lobby stay in sync with the panel.
 *   theme    themeManager            localStorage 'sigil_theme'
 *   muted    soundManager            localStorage 'sigil_muted'
 *   artOnly  the game components     localStorage 'sigilArtOnlySpellCircles'
 * The settings new with this panel live together in localStorage
 * 'sigil_settings': volume (0..1), motion ('full' | 'reduced' | 'off', or
 * null to follow the system's prefers-reduced-motion), colourblind,
 * confirmEndTurn and muteEmotes (online games: hide preset emotes and the
 * picker; its row shows only on pages with body[data-emotes]).
 *
 * Every change dispatches a 'sigil-settings' window event whose detail is
 * SigilSettings.snapshot(); the game components listen for artOnly (and
 * online, muteEmotes), the mute button for muted.
 */
const SIGIL_SETTINGS_KEY = 'sigil_settings';

const SigilSettings = {
	_defaults: { volume: 1, motion: null, colourblind: false, confirmEndTurn: false, muteEmotes: false },

	_load() {
		let saved = null;
		try { saved = JSON.parse(localStorage.getItem(SIGIL_SETTINGS_KEY) || 'null'); } catch (e) { /* storage blocked or corrupt */ }
		return Object.assign({}, this._defaults, saved && typeof saved === 'object' ? saved : {});
	},

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

	set(name, value) {
		if (name === 'theme') {
			if (typeof themeManager !== 'undefined') themeManager.apply(value);
		} else if (name === 'muted') {
			if (typeof soundManager !== 'undefined') soundManager.setMuted(!!value);
			else this._setFlag('sigil_muted', !!value);
		} else if (name === 'artOnly') {
			this._setFlag('sigilArtOnlySpellCircles', !!value);
		} else {
			const s = this._load();
			s[name] = value;
			try { localStorage.setItem(SIGIL_SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* storage blocked */ }
		}
		this.apply();
		window.dispatchEvent(new CustomEvent('sigil-settings', { detail: this.snapshot() }));
	},

	snapshot() {
		const s = this._load();
		return {
			theme: this.get('theme'),
			muted: this.get('muted'),
			volume: s.volume,
			motion: this.motion(),
			artOnly: this.get('artOnly'),
			colourblind: !!s.colourblind,
			confirmEndTurn: !!s.confirmEndTurn,
			muteEmotes: !!s.muteEmotes,
		};
	},

	/** Reflect the settings on <html> and the sound manager. */
	apply() {
		const s = this._load();
		const root = document.documentElement;
		root.setAttribute('data-motion', this.motion());
		if (s.colourblind) root.setAttribute('data-colourblind', '');
		else root.removeAttribute('data-colourblind');
		if (typeof soundManager !== 'undefined') soundManager.volume = s.volume;
	},
};

SigilSettings.apply();
(function () {
	// Following the system: track it live until the player picks a level.
	const q = SigilSettings._reducedQuery();
	if (q && q.addEventListener) q.addEventListener('change', () => SigilSettings.apply());
})();

/**
 * Modal dialogs: focus moves in on open and back to the opener on close, Tab
 * cycles inside, Escape or a click on the backdrop closes.
 */
const SigilDialog = {
	_stack: [],

	_focusables(el) {
		return Array.from(el.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
			.filter(f => !f.disabled && f.getClientRects().length);
	},

	isOpen() {
		return this._stack.length > 0;
	},

	open(el) {
		if (this._stack.some(d => d.el === el)) return;
		this._stack.push({ el, opener: document.activeElement });
		el.hidden = false;
		const first = this._focusables(el)[0];
		if (first) first.focus();
	},

	close(el) {
		const i = this._stack.findIndex(d => d.el === el);
		if (i < 0) return;
		const { opener } = this._stack.splice(i, 1)[0];
		el.hidden = true;
		if (opener && opener.isConnected && opener.focus) opener.focus();
	},

	closeTop() {
		const top = this._stack[this._stack.length - 1];
		if (top) this.close(top.el);
	},

	_trap(e) {
		const top = this._stack[this._stack.length - 1];
		if (!top) return;
		const items = this._focusables(top.el);
		if (!items.length) { e.preventDefault(); return; }
		const first = items[0], last = items[items.length - 1];
		const inside = top.el.contains(document.activeElement);
		if (e.shiftKey && (document.activeElement === first || !inside)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (document.activeElement === last || !inside)) {
			e.preventDefault();
			first.focus();
		}
	},
};

const SIGIL_SHORTCUTS = [
	['Enter', 'End turn (or Submit). Press twice when "Confirm before ending a turn" is on.'],
	['D', 'Dash'],
	['Escape', 'Close a tooltip, this list or the settings; cancel an armed End Turn or Forfeit'],
	['?', 'Show or hide this list'],
	['Tab', 'Move between board nodes, spells and buttons; Enter or Space activates the focused one'],
	['← →', 'Review: previous / next move'],
	['↑ ↓', 'Review: first / last move'],
];

function _sigilBuildDialogs() {
	const h = (tag, attrs, children) => {
		const el = document.createElement(tag);
		for (const k in attrs || {}) {
			if (k === 'text') el.textContent = attrs[k];
			else el.setAttribute(k, attrs[k]);
		}
		for (const c of children || []) el.appendChild(c);
		return el;
	};
	const row = (label, control, hint) => h('div', { class: 'settings-panel__row' }, [
		h('label', {}, control.type === 'checkbox'
			? [control, h('span', { text: label })]
			: [h('span', { text: label }), control]),
	].concat(hint ? [h('small', { class: 'settings-panel__hint', text: hint })] : []));

	const theme = h('select', { 'data-setting': 'theme' });
	if (typeof themeManager !== 'undefined') {
		for (const t of themeManager.getThemeList()) theme.appendChild(h('option', { value: t.id, text: t.name }));
	}
	const muted = h('input', { type: 'checkbox', 'data-setting': 'muted' });
	const volume = h('input', { type: 'range', min: '0', max: '100', step: '5', 'data-setting': 'volume' });
	const volumeOut = h('output', { class: 'settings-panel__value' });
	const motion = h('select', { 'data-setting': 'motion' }, [
		h('option', { value: 'full', text: 'Full' }),
		h('option', { value: 'reduced', text: 'Reduced' }),
		h('option', { value: 'off', text: 'Off' }),
	]);
	const artOnly = h('input', { type: 'checkbox', 'data-setting': 'artOnly' });
	const colourblind = h('input', { type: 'checkbox', 'data-setting': 'colourblind' });
	const confirmEnd = h('input', { type: 'checkbox', 'data-setting': 'confirmEndTurn' });
	const muteEmotes = h('input', { type: 'checkbox', 'data-setting': 'muteEmotes' });
	const hasEmotes = document.body.hasAttribute('data-emotes');
	const shortcutsBtn = h('button', { type: 'button', class: 'settings-panel__btn', text: 'Keyboard shortcuts (?)' });
	const closeBtn = h('button', { type: 'button', class: 'settings-panel__btn', text: 'Close' });

	const panel = h('div', { class: 'settings-panel', id: 'settings-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-panel-title', hidden: '' }, [
		h('div', { class: 'settings-panel__inner' }, [
			h('h2', { class: 'settings-panel__title', id: 'settings-panel-title', text: 'Settings' }),
			row('Theme', theme),
			row('Mute sound', muted),
			h('div', { class: 'settings-panel__row' }, [
				h('label', {}, [h('span', { text: 'Volume' }), volume, volumeOut]),
			]),
			row('Animations', motion, 'Follows your system’s reduce-motion setting until you choose.'),
			row('Art-only spell circles', artOnly, 'Hide spell names and descriptions on the board circles.'),
			row('Colourblind markers', colourblind, 'A diamond on red stones and a ring on blue ones, also on glows, locks and clocks.'),
			row('Confirm before ending a turn', confirmEnd, 'End Turn asks once more before passing.'),
		].concat(hasEmotes ? [
			row('Mute emotes', muteEmotes, 'Hide the preset emotes in online games.'),
		] : [], [
			h('div', { class: 'settings-panel__actions' }, [shortcutsBtn, closeBtn]),
		])),
	]);

	const list = h('dl', { class: 'shortcuts-overlay__list' });
	for (const [k, v] of SIGIL_SHORTCUTS) {
		list.appendChild(h('dt', {}, [h('kbd', { text: k })]));
		list.appendChild(h('dd', { text: v }));
	}
	const shortcutsClose = h('button', { type: 'button', class: 'settings-panel__btn', text: 'Close' });
	const overlay = h('div', { class: 'settings-panel shortcuts-overlay', id: 'shortcuts-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'shortcuts-overlay-title', hidden: '' }, [
		h('div', { class: 'settings-panel__inner' }, [
			h('h2', { class: 'settings-panel__title', id: 'shortcuts-overlay-title', text: 'Keyboard shortcuts' }),
			list,
			h('div', { class: 'settings-panel__actions' }, [shortcutsClose]),
		]),
	]);

	document.body.appendChild(panel);
	document.body.appendChild(overlay);

	const refresh = () => {
		const s = SigilSettings.snapshot();
		theme.value = s.theme;
		muted.checked = s.muted;
		volume.value = String(Math.round(s.volume * 100));
		volumeOut.textContent = volume.value + '%';
		motion.value = s.motion;
		artOnly.checked = s.artOnly;
		colourblind.checked = s.colourblind;
		confirmEnd.checked = s.confirmEndTurn;
		muteEmotes.checked = s.muteEmotes;
	};

	theme.addEventListener('change', () => SigilSettings.set('theme', theme.value));
	muted.addEventListener('change', () => SigilSettings.set('muted', muted.checked));
	volume.addEventListener('input', () => {
		volumeOut.textContent = volume.value + '%';
		SigilSettings.set('volume', Number(volume.value) / 100);
	});
	// A short blip at the new level, so the slider is heard as it is set.
	volume.addEventListener('change', () => {
		if (typeof soundManager !== 'undefined') soundManager.play('stonePlaced');
	});
	motion.addEventListener('change', () => SigilSettings.set('motion', motion.value));
	artOnly.addEventListener('change', () => SigilSettings.set('artOnly', artOnly.checked));
	colourblind.addEventListener('change', () => SigilSettings.set('colourblind', colourblind.checked));
	confirmEnd.addEventListener('change', () => SigilSettings.set('confirmEndTurn', confirmEnd.checked));
	muteEmotes.addEventListener('change', () => SigilSettings.set('muteEmotes', muteEmotes.checked));

	SigilDialog.openSettings = () => { refresh(); SigilDialog.open(panel); };
	SigilDialog.toggleShortcuts = () => {
		if (overlay.hidden) SigilDialog.open(overlay);
		else SigilDialog.close(overlay);
	};
	shortcutsBtn.addEventListener('click', () => SigilDialog.open(overlay));
	closeBtn.addEventListener('click', () => SigilDialog.close(panel));
	shortcutsClose.addEventListener('click', () => SigilDialog.close(overlay));
	for (const d of [panel, overlay]) {
		d.addEventListener('click', (e) => { if (e.target === d) SigilDialog.close(d); });
	}
	document.querySelectorAll('[data-settings-open]').forEach(b => {
		b.addEventListener('click', () => SigilDialog.openSettings());
	});
}

/**
 * The win modal (and the side picker, which shares its class) is shown by a
 * class toggle from Alpine. Move focus into it when it appears and give it
 * back when it goes, so keyboard and screen-reader users land on its buttons.
 */
function _sigilWatchWinModals() {
	const shown = new Map();
	const sync = (modal) => {
		const visible = modal.classList.contains('is-visible');
		if (visible && !shown.has(modal)) {
			shown.set(modal, document.activeElement);
			// Alpine updates x-show on the buttons in the same tick.
			setTimeout(() => {
				if (!modal.classList.contains('is-visible') || modal.contains(document.activeElement)) return;
				const first = SigilDialog._focusables(modal)[0];
				if (first) first.focus();
			}, 0);
		} else if (!visible && shown.has(modal)) {
			const opener = shown.get(modal);
			shown.delete(modal);
			const active = document.activeElement;
			if ((!active || active === document.body || modal.contains(active)) && opener && opener.isConnected && opener.focus) {
				opener.focus();
			}
		}
	};
	new MutationObserver((records) => {
		for (const r of records) {
			if (r.type === 'attributes' && r.target.classList && r.target.classList.contains('win-modal')) sync(r.target);
		}
	}).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
}

document.addEventListener('DOMContentLoaded', () => {
	_sigilBuildDialogs();
	_sigilWatchWinModals();
});

// Capture phase, so a dialog's Escape never also reaches the game's keys.
window.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && SigilDialog.isOpen()) {
		e.preventDefault();
		e.stopImmediatePropagation();
		SigilDialog.closeTop();
		return;
	}
	if (e.key === 'Tab' && SigilDialog.isOpen()) {
		SigilDialog._trap(e);
		return;
	}
	if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
		const tag = document.activeElement && document.activeElement.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
		if (!SigilDialog.toggleShortcuts) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		SigilDialog.toggleShortcuts();
	}
}, true);
