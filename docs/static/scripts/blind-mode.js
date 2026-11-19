/**
 * Blind mode (the "Blind mode" setting, prefs.js), like blindfold chess:
 * the stones are not drawn (styles.css, html[data-blind] on pages with
 * <body class="blind-page">), and a panel above the board reads the game
 * out instead:
 *   - every change to the board, in node names ("Red on c4; blue off b3"),
 *     shown and sent to a polite live region for screen readers;
 *   - "Describe position" (or P): whose turn it is, every stone and wall,
 *     and each spell's nodes with the stones on them and its locks.
 * The nodes stay buttons with their accessible names (nodeAriaLabel,
 * game-keys.js), so the game is played as usual: click or Tab to a node.
 *
 * The game components call SigilBlind.attach(this) from init(): the panel
 * follows the component's `nodes` (game-board-local.js on game.html and
 * puzzles.html, game-board-multiplayer.js on multiplayer.html).
 */
const SigilBlind = {
	// More changed nodes than this at once (a review jump, a new game) are
	// summarised rather than listed.
	MAX_LISTED: 8,
	KEEP: 6,

	_on() {
		return typeof SigilSettings !== 'undefined' && !!SigilSettings.get('blind') && document.body.classList.contains('blind-page');
	},

	_snapshot(nodes) {
		const out = {};
		for (const n in nodes || {}) out[n] = nodes[n] || null;
		return out;
	},

	_order(c) {
		const keys = Object.keys(c.nodes || {});
		if (typeof NODE_ORDER === 'undefined' || !NODE_ORDER.length) return keys;
		const idx = new Map(NODE_ORDER.map((n, i) => [n, i]));
		return keys.sort((a, b) => (idx.has(a) ? idx.get(a) : 1e9) - (idx.has(b) ? idx.get(b) : 1e9));
	},

	attach(c) {
		if (!document.body.classList.contains('blind-page') || c._blind) return;
		const st = { c, prev: this._snapshot(c.nodes), panel: null, timer: null };
		c._blind = st;
		c.$watch('nodes', () => {
			clearTimeout(st.timer);
			// One line per burst: a turn's placement, push and crush land together.
			st.timer = setTimeout(() => this._changed(st), 250);
		});
		window.addEventListener('sigil-settings', () => this._sync(st));
		document.addEventListener('keydown', (e) => {
			if (e.key !== 'p' && e.key !== 'P') return;
			if (e.ctrlKey || e.metaKey || e.altKey || !this._on()) return;
			if (typeof SigilDialog !== 'undefined' && SigilDialog.isOpen()) return;
			const tag = document.activeElement && document.activeElement.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
			e.preventDefault();
			this.describe(st);
		});
		c.$nextTick(() => this._sync(st));
	},

	_build(st) {
		const h = (tag, attrs, text) => {
			const el = document.createElement(tag);
			for (const k in attrs || {}) el.setAttribute(k, attrs[k]);
			if (text) el.textContent = text;
			return el;
		};
		const panel = h('section', { class: 'blind-panel', 'aria-labelledby': 'blind-panel-title' });
		panel.appendChild(h('h2', { class: 'blind-panel__title', id: 'blind-panel-title' }, 'Blind mode'));
		const actions = h('div', { class: 'blind-panel__actions' });
		const describe = h('button', { type: 'button', class: 'settings-panel__btn blind-panel__describe', 'aria-keyshortcuts': 'P' }, 'Describe position (P)');
		const off = h('button', { type: 'button', class: 'settings-panel__btn blind-panel__off' }, 'Show the stones');
		describe.addEventListener('click', () => this.describe(st));
		off.addEventListener('click', () => SigilSettings.set('blind', false));
		actions.append(describe, off);
		panel.appendChild(actions);
		st.position = h('p', { class: 'blind-panel__position', 'aria-live': 'polite' });
		panel.appendChild(st.position);
		st.moves = h('ul', { class: 'blind-panel__moves', 'aria-label': 'Latest board changes, newest first' });
		panel.appendChild(st.moves);
		st.live = h('div', { class: 'visually-hidden blind-panel__live', role: 'status', 'aria-live': 'polite' });
		panel.appendChild(st.live);
		return panel;
	},

	// Above the board, inside the component (the board may mount later).
	_place(st) {
		if (st.panel && st.panel.isConnected) return true;
		const board = st.c.$el && st.c.$el.querySelector('.game-board-container');
		const box = board && board.closest('.container');
		if (!box || !box.parentNode) return false;
		if (!st.panel) st.panel = this._build(st);
		box.parentNode.insertBefore(st.panel, box);
		return true;
	},

	_sync(st) {
		const on = this._on();
		if (on && !this._place(st)) {
			setTimeout(() => this._sync(st), 500);
			return;
		}
		if (st.panel) st.panel.hidden = !on;
		// Start from what is on the board now, not from before blind mode.
		if (on) st.prev = this._snapshot(st.c.nodes);
	},

	/** "Red on c4; blue off b3" for the changes since the last call. */
	_changed(st) {
		const now = this._snapshot(st.c.nodes);
		const prev = st.prev;
		st.prev = now;
		if (!this._on()) return;
		const groups = { red: { on: [], off: [] }, blue: { on: [], off: [] }, X: { on: [], off: [] } };
		let count = 0;
		for (const n of this._order(st.c)) {
			const a = prev[n] || null, b = now[n] || null;
			if (a === b) continue;
			count++;
			if (a && groups[a]) groups[a].off.push(n);
			if (b && groups[b]) groups[b].on.push(n);
		}
		if (!count) return;
		let line;
		if (count > this.MAX_LISTED) {
			line = 'The position changed (' + count + ' nodes). Press P to hear it.';
		} else {
			const parts = [];
			for (const [color, word] of [['red', 'Red'], ['blue', 'Blue']]) {
				const g = groups[color];
				if (g.on.length) parts.push(word + ' on ' + g.on.join(', '));
				if (g.off.length) parts.push(word.toLowerCase() + ' off ' + g.off.join(', '));
			}
			if (groups.X.on.length) parts.push('wall at ' + groups.X.on.join(', '));
			line = parts.join('; ');
			line = line.charAt(0).toUpperCase() + line.slice(1) + '.';
		}
		this._say(st, line);
	},

	_say(st, line) {
		if (!st.panel) return;
		const li = document.createElement('li');
		li.textContent = line;
		st.moves.insertBefore(li, st.moves.firstChild);
		while (st.moves.children.length > this.KEEP) st.moves.lastChild.remove();
		// Empty first, so the same line twice is still read out.
		st.live.textContent = '';
		setTimeout(() => { st.live.textContent = line; }, 50);
	},

	/** The whole position, as text. */
	text(c) {
		const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
		const order = this._order(c);
		const lines = [];
		if (c.winner) lines.push(cap(c.winner) + ' won.');
		else if (c.whoseTurn) lines.push(cap(c.whoseTurn) + ' to move.');
		for (const color of ['red', 'blue']) {
			const stones = order.filter((n) => c.nodes[n] === color);
			lines.push(cap(color) + ', ' + stones.length + (stones.length === 1 ? ' stone: ' : ' stones: ') + (stones.join(', ') || 'none') + '.');
		}
		const walls = order.filter((n) => c.nodes[n] === 'X');
		if (walls.length) lines.push('Walls: ' + walls.join(', ') + '.');
		if (typeof spellSlotNames === 'function' && typeof POSITIONS !== 'undefined' && c.spellDict) {
			spellSlotNames().forEach((slot, i) => {
				const spell = c.spellDict[slot];
				const nodes = POSITIONS[i + 1];
				if (!spell || !nodes) return;
				const name = (c.spells && c.spells.text && c.spells.text[slot] && c.spells.text[slot].name) || String(spell).replace(/_/g, ' ');
				const on = (color) => nodes.filter((n) => c.nodes[n] === color);
				const red = on('red'), blue = on('blue');
				const held = [red.length ? 'red ' + red.join(' ') : '', blue.length ? 'blue ' + blue.join(' ') : ''].filter(Boolean).join(', ') || 'empty';
				const locks = [c.redLock === spell ? 'red\'s lock' : '', c.blueLock === spell ? 'blue\'s lock' : ''].filter(Boolean);
				lines.push(name + ' (' + nodes.join(' ') + '): ' + held + (locks.length ? '; ' + locks.join(', ') : '') + '.');
			});
		}
		if (typeof c.redSpellCounter === 'number' && typeof c.blueSpellCounter === 'number' && !c.isDeathmatch) {
			lines.push('Spells cast: red ' + c.redSpellCounter + ', blue ' + c.blueSpellCounter + '.');
		}
		return lines.join('\n');
	},

	describe(st) {
		if (!this._place(st)) return;
		const text = this.text(st.c);
		st.position.textContent = '';
		setTimeout(() => { st.position.textContent = text; }, 50);
	},
};
