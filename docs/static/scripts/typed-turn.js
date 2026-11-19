/**
 * typed-turn.js — play a turn by typing it, on game.html and analysis.html.
 *
 * The notation is the site's own: a turn is the list of inputs a player
 * gives, in order, as Export Game writes them (SGN-T, engine/notation.js)
 * and as online games send them, e.g.
 *
 *     a6                         place a stone on a6 (then End Turn yourself)
 *     a6 pass                    place on a6 and end the turn
 *     a11 dash a1 a2 c10 Bewitch b6 b2 pass
 *
 * Words: a node (a1..c13, d/e on Cataclysm boards), `dash`, a spell on the
 * board (any case; spaces, `_` and `-` alike, "Rock Slide" = Rock_Slide; a
 * duplicate as Fireblast~2), `pass` (also `end`, `done`), `submit`, `skip`
 * (no Providence placement). A leading turn label from a game record
 * ("R12.", "B3.") is ignored.
 *
 * Each word is handed to the game exactly as the matching click would be
 * (the component's sendEvent -> GameController.handlePlayerAction), one
 * prompt at a time. Before a word is sent it is checked against the prompt
 * it answers (the legal moves the controller offered, its action list);
 * after it is sent, a word the controller silently re-asked for (same board,
 * same prompt) counts as refused. Typing stops at the first word that is not
 * legal, with what is legal instead; the words before it stay played, as
 * clicks would (Reset Turn undoes them).
 *
 * Pure parts (tokenize, resolveWord) are require()-able in node for tests.
 */

const TypedTurn = (() => {
	const PASS_WORDS = { pass: 'pass', end: 'pass', endturn: 'pass', done: 'pass' };
	const OTHER_WORDS = { dash: 'dash', submit: 'submit', skip: 'skip_providence', skip_providence: 'skip_providence', noprovidence: 'skip_providence' };

	/** Words of a typed turn (a leading "R12." / "B3." label dropped). */
	function tokenize(text) {
		const words = String(text || '').replace(/[,;]+/g, ' ').trim().split(/\s+/).filter(Boolean);
		// "R12." / "B3." (never a bare "b2": that is a node).
		if (words.length && /^[RB]\d+[.*=]$/i.test(words[0])) words.shift();
		return words;
	}

	const squash = (s) => String(s).toLowerCase().replace(/[\s_\-'’]+/g, '');

	/**
	 * The input token for words[i..] at a prompt, or an error.
	 * ctx = { nodes: [node names], spells: [spell names on the board] }.
	 * Returns { token, used, kind: 'node'|'spell'|'word' } or { error }.
	 */
	function resolveWord(words, i, ctx) {
		const w = words[i];
		const lower = w.toLowerCase();
		if (/^[a-z]\d{1,2}$/.test(lower)) {
			if ((ctx.nodes || []).includes(lower)) return { token: lower, used: 1, kind: 'node' };
			return { error: '"' + w + '" is not a node on this board.' };
		}
		const flat = squash(w);
		if (PASS_WORDS[flat]) return { token: 'pass', used: 1, kind: 'word' };
		if (OTHER_WORDS[flat]) return { token: OTHER_WORDS[flat], used: 1, kind: 'word' };
		// Spells, longest match first ("Seal of Spring" is three words).
		const spells = ctx.spells || [];
		for (let n = Math.min(4, words.length - i); n >= 1; n--) {
			const phrase = squash(words.slice(i, i + n).join(''));
			const hits = spells.filter((s) => squash(s) === phrase || squash(s.replace('~', '')) === phrase);
			if (hits.length === 1) return { token: hits[0], used: n, kind: 'spell' };
			// A bare name of a duplicated spell: whichever copy is meant must be named.
			const base = spells.filter((s) => squash(s.split('~')[0]) === phrase);
			if (base.length === 1) return { token: base[0], used: n, kind: 'spell' };
			if (base.length > 1) return { error: '"' + words.slice(i, i + n).join(' ') + '" is on the board twice: write ' + base.join(' or ') + '.' };
		}
		return { error: '"' + w + '" is not a node, a spell on this board, dash or pass.' };
	}

	/** The words a prompt accepts, for hints and errors. */
	function legalWords(prompt, spellsOnBoard) {
		if (!prompt || !prompt.awaiting) return [];
		const out = [];
		const moves = Object.keys(prompt.moveoptions || {});
		const list = prompt.actionlist || [];
		if (prompt.awaiting === 'node') return moves;
		if (list.includes('move') || list.includes('providence')) out.push(...moves);
		for (const a of list) {
			if (a === 'move' || a === 'providence') continue;
			out.push(a === 'skip_providence' ? 'skip' : a);
		}
		return out;
	}

	/** Display form of a word list ("Rock_Slide" -> "Rock Slide"). */
	function show(words) {
		return words.map((w) => (typeof displaySpellName === 'function' && /[A-Z]/.test(w[0]) ? displaySpellName(w) : w)).join(' ');
	}

	return { tokenize, resolveWord, legalWords, show };
})();

/**
 * Alpine mixin for game-board-local.js (game.html, analysis.html). Needs the
 * component's _engine (the GameController), sendEvent and the prompt record
 * (_lastPrompt / _promptSeq) its message handler keeps.
 */
function typedTurnMixin() {
	return {
		typedTurnText: '',
		typedTurnError: '',
		typedTurnBusy: false,
		// The last input prompt the controller sent, and a count of them
		// (kept by game-board-local.js's message handler).
		_lastPrompt: null,
		_promptSeq: 0,

		/** A human prompt is waiting for input on a live board. */
		canTypeTurn() {
			return !!(this._engine && !this.reviewMode && !this.winner && !this.aiThinking
				&& (this.awaiting === 'action' || this.awaiting === 'node') && this._lastPrompt);
		},

		_typedSpells() {
			return Object.values(this.spellDict || {}).filter(Boolean);
		},

		/** "Legal now: a2 a6 · dash · Fireblast · pass" for the prompt shown. */
		typedTurnHint() {
			if (!this.canTypeTurn()) return '';
			const words = TypedTurn.legalWords(this._lastPrompt, this._typedSpells());
			if (!words.length) return this.awaiting === 'node' ? 'Type the node the board asks for.' : '';
			return 'Legal now: ' + TypedTurn.show(words);
		},

		// Board + prompt, to tell a refused word (the controller asks again)
		// from an accepted one.
		_typedSnapshot() {
			const p = this._lastPrompt || {};
			let board = '';
			try { board = this._engine && this._engine.board ? boardToSfn(this._engine.board) : ''; } catch (e) { board = ''; }
			return board + '|' + (p.awaiting || '') + '|' + (p.message || '') + '|' + (p.actionlist || []).join(',')
				+ '|' + Object.keys(p.moveoptions || {}).sort().join(',') + '|' + (this._promptSeq || 0);
		},

		/** Resolves once the controller waits for this side's input again, or the
		 *  turn has passed to the other side / the game is over. */
		async _typedWait(color, seq, timeoutMs) {
			const t0 = Date.now();
			for (;;) {
				if (this.winner) return 'over';
				if (this.whoseTurn && color && this.whoseTurn !== color) return 'passed';
				if ((this._promptSeq || 0) > seq && this._engine && this._engine._inputResolve
					&& (this.awaiting === 'action' || this.awaiting === 'node')) return 'prompt';
				if (Date.now() - t0 > (timeoutMs || 10000)) return 'timeout';
				await new Promise((r) => setTimeout(r, 25));
			}
		},

		async submitTypedTurn() {
			if (this.typedTurnBusy) return;
			const words = TypedTurn.tokenize(this.typedTurnText);
			this.typedTurnError = '';
			if (!words.length) return;
			if (!this.canTypeTurn()) {
				this.typedTurnError = 'It is not your turn to play.';
				return;
			}
			this.typedTurnBusy = true;
			const color = this.whoseTurn;
			let i = 0;
			let error = '';
			try {
				while (i < words.length) {
					if (!this.canTypeTurn()) {
						error = 'The turn ended before "' + words.slice(i).join(' ') + '".';
						break;
					}
					const prompt = this._lastPrompt;
					const r = TypedTurn.resolveWord(words, i, { nodes: NODE_ORDER.slice(), spells: this._typedSpells() });
					if (r.error) { error = r.error; break; }
					const legal = TypedTurn.legalWords(prompt, this._typedSpells());
					const moves = prompt.moveoptions || {};
					const list = prompt.actionlist || [];
					let ok;
					if (r.kind === 'node') {
						ok = prompt.awaiting === 'node'
							? (Object.keys(moves).length ? !!moves[r.token] : true)
							: ((list.includes('move') || list.includes('providence')) && !!moves[r.token]);
					} else {
						ok = prompt.awaiting === 'action' && list.includes(r.token);
					}
					if (!ok) {
						error = '"' + words.slice(i, i + r.used).join(' ') + '" is not legal here'
							+ (legal.length ? '. Legal now: ' + TypedTurn.show(legal) : (prompt.message ? ' (' + prompt.message + ')' : '')) + '.';
						break;
					}
					const before = this._typedSnapshot();
					const seq = this._promptSeq || 0;
					// The click path: what handleNodeClick / handleDash / the spell
					// and End Turn buttons send. handleNodeClick marks the mover first,
					// so the placement counts as ours (Reset Turn appears).
					this.currentPlayer = this.whoseTurn;
					this.endTurnArmed = false;
					this.sendEvent(r.token);
					if (r.token === 'dash' || r.token === 'pass' || r.token === 'submit' || r.token === 'skip_providence') this.actionList = [];
					i += r.used;
					const how = await this._typedWait(color, seq);
					if (how === 'over' || how === 'passed') {
						if (i < words.length) error = 'The turn ended at "' + words[i - 1] + '"; "' + words.slice(i).join(' ') + '" was not played.';
						break;
					}
					if (how === 'timeout') { error = 'The game did not answer "' + words[i - r.used] + '".'; break; }
					// Asked the same thing again, nothing changed: refused.
					const after = this._typedSnapshot();
					if (after.replace(/\|\d+$/, '') === before.replace(/\|\d+$/, '')) {
						i -= r.used;
						error = '"' + words.slice(i, i + r.used).join(' ') + '" was not accepted'
							+ (legal.length ? '. Legal now: ' + TypedTurn.show(legal) : '') + '.';
						break;
					}
				}
			} finally {
				this.typedTurnBusy = false;
			}
			this.typedTurnError = error;
			// Keep what was not played, so it can be corrected.
			this.typedTurnText = error ? words.slice(i).join(' ') : '';
		},
	};
}

if (typeof module !== 'undefined' && module.exports) module.exports = { TypedTurn, typedTurnMixin };
