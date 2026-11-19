/**
 * In-game settings panel, the keyboard-shortcut overlay and the dialog focus
 * handling shared by game.html, multiplayer.html and puzzles.html.
 *
 * The settings themselves (SigilSettings, their account copy and the
 * controls, SigilPrefsUI) are in prefs.js, loaded in <head> before this
 * file; preferences.html shows the same controls as a page. The panel shows
 * every setting a game uses, the online-games rows only on pages with
 * <body data-emotes>, and links to the full page.
 */
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
	['I', 'On a focused spell: open its tooltip and move to its "More about this spell" link (Escape goes back)'],
	['Escape', 'Close a tooltip, this list or the settings; cancel an armed End Turn or Forfeit; clear arrows and circles'],
	['Z', 'Zen mode: only the board, the clocks and the turn buttons', 'zen'],
	['P', 'Blind mode: describe the position (the stones, the spells and whose turn it is)', 'blind'],
	['Right-drag', 'Draw an arrow between two nodes; right-click draws a circle. Again removes it. Shift red, Alt blue, Ctrl yellow. On a touch screen use the pencil on the board'],
	['?', 'Show or hide this list'],
	['Tab', 'Move between board nodes, spells and buttons; Enter or Space activates the focused one'],
	['← →', 'Review: previous / next move'],
	['↑ ↓', 'Review: first / last move'],
];

function _sigilBuildDialogs() {
	if (typeof SigilPrefsUI === 'undefined') return;
	const h = SigilPrefsUI._h.bind(SigilPrefsUI);
	const shortcutsBtn = h('button', { type: 'button', class: 'settings-panel__btn', text: 'Keyboard shortcuts (?)' });
	const closeBtn = h('button', { type: 'button', class: 'settings-panel__btn', text: 'Close' });
	// The full page opens in a new tab, so the game stays where it is.
	const allLink = h('a', { class: 'settings-panel__link', href: 'preferences.html', target: '_blank', rel: 'noopener', text: 'All preferences' });
	const body = h('div', { class: 'settings-panel__body' });
	const panel = h('div', { class: 'settings-panel', id: 'settings-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-panel-title', hidden: '' }, [
		h('div', { class: 'settings-panel__inner' }, [
			h('h2', { class: 'settings-panel__title', id: 'settings-panel-title', text: 'Settings' }),
			body,
			h('div', { class: 'settings-panel__actions' }, [allLink, shortcutsBtn, closeBtn]),
		]),
	]);
	const refresh = SigilPrefsUI.render(body);

	const list = h('dl', { class: 'shortcuts-overlay__list' });
	for (const [k, v, only] of SIGIL_SHORTCUTS) {
		const cls = only ? { class: only + '-only' } : {};
		list.appendChild(h('dt', cls, [h('kbd', { text: k })]));
		list.appendChild(h('dd', Object.assign({ text: v }, cls)));
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

	// Zen hides the header; this is the way back that stays on screen.
	const zenExit = h('button', { type: 'button', class: 'zen-exit', text: 'Exit zen (Z)' });
	zenExit.addEventListener('click', () => SigilSettings.set('zen', false));
	document.body.appendChild(zenExit);

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
