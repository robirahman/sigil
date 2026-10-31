/**
 * Analysis board and board editor (docs/analysis.html).
 *
 * analysisMixin() is spread into the gameBoard component (game-board-local.js)
 * when the page creates it with { analysis: true }, so the board, the spell
 * art and every turn prompt are the game page's own. Two modes:
 *
 *   edit     -- click a node to cycle empty / red / blue / wall, pick the
 *               spells, side to move, counters, locks and banks; the SFN is
 *               rebuilt and validated (loaded into a SigilBoard) on every
 *               change, and handed to game.html / multiplayer.html to play.
 *   analyse  -- a move tree. Turns are played on the real board by the
 *               game's GameController in local 1v1 mode, restarted at the
 *               selected node (gameBoard's _analysisStart); a turn played
 *               from a node that already has children adds a variation. The
 *               Rust wasm engine evaluates the selected node in growing
 *               slices, and its best turn can be played on the board.
 *
 * Node SFNs are LOADABLE SFNs: the form Export Position and after-turn
 * records use, which the controller advances to the side to move. The engine
 * searches positionTurnSfn(sfn) (position-rating.js), the side-to-move form.
 */

// Search slices per node (ms). Each slice reports an eval and a best turn;
// the table carries over, so later slices start where the last one stopped.
const ANALYSIS_EVAL_STEPS_MS = [500, 2000, 6000, 15000, 30000];
const ANALYSIS_TT_BITS = 20;

const ANALYSIS_AI_TIERS = [
	{ key: 'rust_easy', label: 'Easy' },
	{ key: 'rust_medium', label: 'Medium' },
	{ key: 'rust_hard', label: 'Hard' },
	{ key: 'rust_very_hard', label: 'Very Hard' },
];

/** 'red' | 'blue': who moves next from a loadable SFN (the controller hands
 *  the move out by the parity of the advanced turn counter). */
function analysisSideToMove(sfn) {
	const tc = parseInt(String(sfn).trim().split(/\s+/)[2], 10) || 0;
	return (tc + 1) % 2 === 1 ? 'red' : 'blue';
}

/** "Red 3": the review's turn label for a turn's color and turn counter. */
function analysisTurnLabel(color, turnNumber) {
	const n = color === 'red' ? Math.floor(turnNumber / 2) + 1 : Math.floor(turnNumber / 2);
	return (color === 'red' ? 'Red' : 'Blue') + ' ' + n;
}

/** A recorded turn as text: an engine turn's SimActions, or a human turn's
 *  input tokens in the order they were played. */
function analysisTurnText(turn) {
	if (!turn || !Array.isArray(turn.actions)) return '';
	if (turn.kind === 'sim') {
		return typeof describePuzzleActions === 'function' ? describePuzzleActions(turn.actions) : '';
	}
	return turn.actions
		.filter(t => typeof t === 'string' && t !== 'pass' && t !== 'submit')
		.map(t => (t === 'skip_providence' ? 'no providence' : (CORE_SPELLS[t] ? displaySpellName(t) : t)))
		.join(' ');
}

/** Who is silenced in the position after `turn`: casting Silence (an
 *  Experimental charm) silences the enemy for their next turn. SFN does not
 *  record it, so a restarted board needs it from the turn. Input turns list
 *  cast spells by name, sim turns as { type: 'cast', spell }. */
function analysisSilencedAfter(turn) {
	const out = { red: false, blue: false };
	if (!turn || !Array.isArray(turn.actions) || (turn.color !== 'red' && turn.color !== 'blue')) return out;
	const isSilence = (n) => typeof n === 'string' && CORE_SPELLS[n] && CORE_SPELLS[n].resolve === 'silence';
	const cast = turn.actions.some(a => isSilence(a) || (a && a.type === 'cast' && isSilence(a.spell)));
	if (cast) out[turn.color === 'red' ? 'blue' : 'red'] = true;
	return out;
}

/** True when someone is silenced in this node's position (state an SFN,
 *  and so a hand-off link, cannot carry). */
function analysisNodeSilenced(node) {
	return !!(node && node.silenced && (node.silenced.red || node.silenced.blue));
}

/** A SigilBoard holding a loadable SFN (its own spells and variant). */
function analysisBoardFromSfn(sfn) {
	const d = sfnToDict(sfn);
	const b = new SigilBoard(d.spell_names, normalizeVariant(d.variant));
	b.loadFromSfn(sfn);
	b.variant = normalizeVariant(d.variant);
	return b;
}

/** The winner when a loadable SFN is already decided (no stones, a winning
 *  lead or the spell target, as judged at the end of the last turn), else null. */
function analysisDecidedWinner(sfn) {
	const b = analysisBoardFromSfn(sfn);
	if (!b.gameover) {
		const tc = b.turnCounter;
		if (tc > 0) b.checkGameOver(tc % 2 === 1 ? 'red' : 'blue');
	}
	return b.gameover ? (b.winner || null) : null;
}

/** Why the Rust engine cannot evaluate this position, or null when it can. */
function analysisEngineBlocker(sfn) {
	let d;
	try { d = sfnToDict(sfn); } catch (e) { return 'the position could not be read'; }
	if (variantHasPentagon(d.variant)) return 'the engine does not play the Cataclysm board';
	if (variantHasDuplicates(d.variant)) return 'the engine does not play the Allow Duplicates variant';
	if (variantHasScramble(d.variant)) return 'the engine does not play the Scramble variant';
	if ((d.spell_names || []).some(n => isUnratedSpell(n))) return 'the engine does not play the Panda or Experimental spells';
	if (typeof rustReviewAvailable === 'function' && !rustReviewAvailable()) return 'this browser cannot run the engine';
	return null;
}

/** Every spell of one type ('ritual' | 'sorcery' | 'charm') across the
 *  packs, core first: [{ name, label }]. */
function analysisSpellPool(type) {
	const field = type === 'ritual' ? 'rituals' : (type === 'sorcery' ? 'sorceries' : 'charms');
	const out = [];
	const seen = new Set();
	for (const key of ['core', ...EXPANSION_KEYS]) {
		const pack = EXPANSIONS[key];
		for (const name of (pack && pack[field]) || []) {
			if (seen.has(name)) continue;
			seen.add(name);
			out.push({ name, label: displaySpellName(name) + (key === 'core' ? '' : ' (' + pack.name + ')') });
		}
	}
	return out;
}

/**
 * Check a loadable SFN. Returns { errors, warnings, board }: errors make the
 * position unplayable (it does not parse, does not round-trip through a
 * SigilBoard, breaks the spell rules, or is already decided).
 */
function analysisValidateSfn(sfn) {
	const errors = [];
	const warnings = [];
	const parts = String(sfn).trim().split(/\s+/);
	if (parts.length < 7 || parts[0].indexOf('/') === -1) {
		return { errors: ['Not an SFN string: it needs at least 7 fields (stones/spells, side, turn, counters, locks, springlocks, score).'], warnings, board: null };
	}
	let d;
	try { d = sfnToDict(parts.join(' ')); } catch (e) { return { errors: ['Not an SFN string: ' + (e.message || e)], warnings, board: null }; }
	const layout = boardLayoutDef(d.layout);
	const stoneField = parts[0].split('/')[0];
	if (stoneField.length !== layout.nodeOrder.length) {
		errors.push('The stone field has ' + stoneField.length + ' nodes; the ' + layout.name + ' board has ' + layout.nodeOrder.length + '.');
	}
	if (/[^rbx.]/.test(stoneField)) errors.push('Stones are r, b, x (wall) or . (empty).');
	if (!/^\d+$/.test(parts[2])) errors.push('The turn counter must be a whole number.');
	if (!/^\d+:\d+$/.test(parts[3])) errors.push('The spell counters must read red:blue, e.g. 2:1.');
	const spells = d.spell_names || [];
	if (spells.length !== layout.positionCount) {
		errors.push('The ' + layout.name + ' board takes ' + layout.positionCount + ' spells; this lists ' + spells.length + '.');
	}
	// The slot types: rituals, then sorceries, then charms (spellTypeAtPosition).
	const pools = { ritual: analysisSpellPool('ritual'), sorcery: analysisSpellPool('sorcery'), charm: analysisSpellPool('charm') };
	const seen = new Set();
	const seenBase = new Set();
	spells.forEach((name, i) => {
		const type = i < layout.perType ? 'ritual' : (i < 2 * layout.perType ? 'sorcery' : 'charm');
		const base = baseSpellName(name);
		if (!pools[type].some(s => s.name === base)) {
			errors.push('Spell ' + (i + 1) + ' (' + (name || 'empty') + ') is not a ' + type + '.');
		}
		if (seen.has(name)) errors.push(displaySpellName(name) + ' is on the board twice.');
		seen.add(name);
		// Aliases (Flourish~2) and repeated spells only exist in Allow
		// Duplicates games; the engine reads no alias otherwise.
		if (!variantHasDuplicates(d.variant)) {
			if (name !== base) errors.push(displaySpellName(name) + ' is a duplicate alias, which needs the Allow Duplicates variant.');
			else if (seenBase.has(base)) errors.push(displaySpellName(base) + ' is on the board twice.');
		}
		seenBase.add(base);
	});
	if (errors.length) return { errors, warnings, board: null };

	const deathmatch = variantHasDeathmatch(d.variant);
	const target = boardLayoutDef(d.layout).spellTarget;
	for (const c of ['red', 'blue']) {
		const C = c === 'red' ? 'Red' : 'Blue';
		const count = d[c + '_spellcounter'];
		const lock = d[c + '_lock'];
		const spring = d[c + '_springlock'];
		// Exactly the target is a finished game (judged below as decided);
		// more than that cannot happen.
		if (!deathmatch && count > target) errors.push(C + ' has cast ' + count + ' spells; casting ' + target + ' ends the game.');
		if (lock) {
			if (!spells.includes(lock)) errors.push(C + '\'s lock (' + displaySpellName(lock) + ') is not on the board.');
			else if (CORE_SPELLS[lock] && CORE_SPELLS[lock].ischarm) errors.push(C + '\'s lock is a charm; only 3- and 5-node spells lock.');
			else if (!deathmatch && count === 0) warnings.push(C + ' has a lock but no spells cast.');
		}
		if (spring && spring !== lock) errors.push(C + '\'s springlock must be the spell ' + C + ' has locked.');
		if (d[c + '_bank'] && !spells.some(n => isProvidenceSpell(n))) warnings.push(C + ' has banked stones but no Providence spell is on the board.');
	}
	// The target ends the game on the caster's own turn, so only the side
	// that just moved (odd turn counter: red) can be sitting on it.
	if (!deathmatch && /^\d+$/.test(parts[2])) {
		const tc = Number(parts[2]);
		const mover = tc === 0 ? null : (tc % 2 === 1 ? 'red' : 'blue');
		for (const c of ['red', 'blue']) {
			if (d[c + '_spellcounter'] === target && c !== mover) {
				errors.push((c === 'red' ? 'Red' : 'Blue') + ' has cast ' + target + ' spells but did not just move; the game would have ended on that turn.');
			}
		}
	}
	if (errors.length) return { errors, warnings, board: null };

	let board;
	try {
		board = analysisBoardFromSfn(sfn);
	} catch (e) {
		return { errors: ['The board could not load this position: ' + (e.message || e)], warnings, board: null };
	}
	const again = boardToSfn(board);
	if (normalizeSfnString(again) !== normalizeSfnString(String(sfn).trim().split(/\s+/).join(' '))
		&& !analysisSameButToken(again, sfn)) {
		errors.push('The position does not survive a load: the board reads it back as ' + again);
	}
	let winner = null;
	try { winner = analysisDecidedWinner(sfn); } catch (e) { /* reported above */ }
	if (winner) errors.push('This position is already decided: ' + (winner === 'red' ? 'Red' : 'Blue') + ' has won.');
	const blocker = analysisEngineBlocker(sfn);
	if (blocker) warnings.push('No engine evaluation: ' + blocker + '.');
	return { errors, warnings, board };
}

// The side token and score are recomputed on load (the score from the stones,
// the token from the turn parity), so a pasted SFN may differ in just those.
function analysisSameButToken(a, b) {
	const pa = normalizeSfnString(a).split(' ');
	const pb = normalizeSfnString(String(b).trim().split(/\s+/).join(' ')).split(' ');
	if (pa.length !== pb.length) return false;
	return pa.every((x, i) => i === 1 || i === 6 || x === pb[i]);
}

function analysisMixin() {
	return {
		anaMode: 'analyse',            // 'analyse' | 'edit'
		// The move tree: nodes by id (index); 0 is the root. A node is
		// { id, parent, sfn, label, text, turn, children: [ids], lastChild,
		//   winner, deleted }.
		anaTree: [],
		anaCur: 0,
		// The engine's view of the selected node.
		anaEval: { status: 'idle', text: '', depth: 0, liveDepth: 0, timeMs: 0, best: null, bestText: '', expected: '', note: '', sfn: '' },
		anaCopied: false,
		anaAiTier: 'rust_hard',
		anaAiTiers: ANALYSIS_AI_TIERS,
		_anaCtl: null,
		_anaGen: 0,
		_anaSearching: false,
		_anaEvalTimer: null,

		// Editor state. stones: node -> null | 'red' | 'blue' | 'X'.
		ed: {
			layout: 'core', end: 'standard', competitive: false, duplicates: false,
			stones: {}, spells: [], toMove: 'red', turnNo: 1,
			redSc: 0, blueSc: 0, redLock: '', blueLock: '', redSpring: false, blueSpring: false,
			redBank: 0, blueBank: 0,
		},
		edSfn: '',
		edErrors: [],
		edWarnings: [],
		edImport: '',
		edImportError: '',

		// ---------------- page start ----------------

		/** Called by gameBoard.init with the controller hooks. */
		_analysisInit(ctl) {
			this._anaCtl = ctl;
			// On a phone the board is wider than the screen: centre it once.
			setTimeout(() => {
				const el = this.$refs.gameBoardContainer;
				const sc = el && el.parentElement;
				if (sc && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2;
			}, 300);
			const params = new URLSearchParams(window.location.search);
			const sfn = (params.get('sfn') || '').trim();
			if (params.get('mode') === 'edit' || !sfn) {
				this.anaMode = 'edit';
				this.edFromSfn(sfn || null);
				return;
			}
			const check = analysisValidateSfn(sfn);
			// A decided position still opens (its eval reads "won"); anything
			// that does not load goes to the editor, which shows why.
			const fatal = check.errors.filter(e => !/already decided/.test(e));
			if (fatal.length) {
				this.anaMode = 'edit';
				this.edFromSfn(null);
				this.edImport = sfn;
				this.edImportError = fatal.join(' ');
				return;
			}
			let line = null;
			if (params.get('line') === 'session') {
				try { line = JSON.parse(sessionStorage.getItem('sigil_analysis_line') || 'null'); } catch (e) { line = null; }
			}
			const at = line && Array.isArray(line.sfns) ? line.sfns.indexOf(sfn) : -1;
			if (at >= 0) this.anaSetLine(line.sfns, line.turns, at);
			else this.anaSetLine([sfn], null, 0);
		},

		// ---------------- the move tree ----------------

		/** Replace the tree with one line: positions `sfns` (loadable),
		 *  `turns` (the turns between them, or null) and select `at`. */
		anaSetLine(sfns, turns, at) {
			const tree = [];
			sfns.forEach((sfn, k) => {
				const turn = (k > 0 && turns && turns[k - 1]) ? turns[k - 1] : null;
				tree.push({
					id: k, parent: k > 0 ? k - 1 : null, sfn,
					label: k === 0 ? 'Start' : (turn ? analysisTurnLabel(turn.color, turn.turnNumber) : 'Turn ' + k),
					text: turn ? analysisTurnText(turn) : '',
					turn: turn,
					children: k + 1 < sfns.length ? [k + 1] : [],
					lastChild: k + 1 < sfns.length ? k + 1 : null,
					winner: null, deleted: false,
					silenced: analysisSilencedAfter(turn),
				});
			});
			for (const n of tree) {
				try { n.winner = analysisDecidedWinner(n.sfn); } catch (e) { n.winner = null; }
			}
			this.anaTree = tree;
			// A new tree reuses node ids: drop the old tree's arrows.
			if (this.boardMarks) this.boardMarks.clearAll();
			this.anaGoto(Math.max(0, Math.min(at || 0, tree.length - 1)));
		},

		_anaNode(id) {
			return this.anaTree[id === undefined ? this.anaCur : id] || null;
		},

		/** Root-to-node path (ids), the node included. */
		_anaPath(id) {
			const out = [];
			for (let n = this._anaNode(id); n; n = n.parent === null ? null : this.anaTree[n.parent]) out.unshift(n.id);
			return out;
		},

		/** Select a node: restart the board there and evaluate it. */
		anaGoto(id) {
			const node = this._anaNode(id);
			if (!node || node.deleted || !this._anaCtl) return;
			this.anaCur = node.id;
			if (node.parent !== null) this.anaTree[node.parent].lastChild = node.id;
			this._anaLoadBoard(node);
			this._anaSyncUrl();
			this.anaStartEval();
		},

		_anaLoadBoard(node, turn) {
			if (node.winner) {
				// Nothing to play: show the position as it stands.
				this._anaCtl.stop();
				this._anaShowStatic(node.sfn);
				this.messageHistory = [(node.winner === 'red' ? 'Red' : 'Blue') + ' has won this position.'];
				return;
			}
			const path = this._anaPath(node.id);
			const history = path.slice(0, -1).map(i => this.anaTree[i].sfn);
			// Silence is part of the repetition key, so the ancestors need it too.
			const historySilenced = path.slice(0, -1).map(i => this.anaTree[i].silenced || null);
			this._anaCtl.start(node.sfn, { history, historySilenced, turn: turn || null, silenced: node.silenced || null });
		},

		/** Render a loadable SFN without a controller (editor, decided nodes). */
		_anaShowStatic(sfn) {
			let b;
			try { b = analysisBoardFromSfn(sfn); } catch (e) { return; }
			this._anaRenderBoard(b);
		},

		_anaRenderBoard(b) {
			if (this.boardLayout !== BOARD.id) this.applyBoardLayout(BOARD.id);
			for (const n of NODE_ORDER) this.nodes[n] = b.stones[n] || null;
			const slots = spellSlotNames();
			const dict = {}, images = {}, text = {};
			slots.forEach((slot, i) => {
				const name = b.spellNames[i];
				if (!name) return;
				dict[slot] = name;
				images[slot] = 'static/images/spells/' + baseSpellName(name) + '.png';
				text[slot] = { name: displaySpellName(name), text: SPELL_TEXTS[name] || '' };
			});
			this.spellDict = dict;
			this.spells.images = images;
			this.spells.text = text;
			// The help popover's "This game's rules" (help.js): this position's.
			if (typeof sigilPublishGameRules === 'function') sigilPublishGameRules(b.variant, b.spellNames);
			this.redLock = b.lock.red || '';
			this.blueLock = b.lock.blue || '';
			this.redSpellCounter = b.spellCounter.red || 0;
			this.blueSpellCounter = b.spellCounter.blue || 0;
			this.redBank = b.providenceBank.red || 0;
			this.blueBank = b.providenceBank.blue || 0;
			this.score = b.score || 'unset';
			this.isDeathmatch = variantHasDeathmatch(b.variant);
			this.lastPlay = '';
			this.winner = '';
		},

		/** gameBoard: a turn finished on the board. Adds it under the
		 *  selected node (or selects the existing child it reproduces). */
		_analysisOnTurn(turn, board, planned) {
			if (!turn || !turn.sfnAfter) return;
			const parent = this._anaNode();
			if (!parent) return;
			const slim = { color: turn.color, turnNumber: turn.turnNumber, kind: turn.kind, actions: turn.actions };
			// The mover's own flag is cleared at the end of its turn; the
			// enemy's (a Silence cast this turn) carries over.
			const silenced = (board && board.silenced)
				? { red: turn.color === 'blue' && !!board.silenced.red, blue: turn.color === 'red' && !!board.silenced.blue }
				: analysisSilencedAfter(slim);
			// Silence is not in the SFN (a charm cast leaves the spell
			// counter alone), so the same SFN with and without it are
			// different positions: match the flags too.
			const sameSilence = (a, b) => !!(a && a.red) === !!(b && b.red) && !!(a && a.blue) === !!(b && b.blue);
			let child = parent.children.map(i => this.anaTree[i])
				.find(c => c.sfn === turn.sfnAfter && sameSilence(c.silenced, silenced));
			if (!child) {
				child = {
					id: this.anaTree.length, parent: parent.id, sfn: turn.sfnAfter,
					label: analysisTurnLabel(turn.color, turn.turnNumber),
					text: analysisTurnText(slim), turn: slim,
					children: [], lastChild: null,
					winner: (board && board.gameover) ? (board.winner || null) : null,
					deleted: false,
					silenced,
				};
				this.anaTree.push(child);
				parent.children.push(child.id);
			}
			parent.lastChild = child.id;
			this.anaCur = child.id;
			if (planned || child.winner) {
				// An engine turn ran on a one-turn AI seat, and a decided
				// node has nothing to play: restart there as a plain board.
				this._anaLoadBoard(child);
			}
			this._anaSyncUrl();
			this.anaStartEval();
		},

		/** gameBoard: the game ended without a turn (threefold repetition, the
		 *  Seal of Destruction at the start of a turn). */
		_analysisOnGameOver(ev) {
			const node = this._anaNode();
			if (!node || !ev || node.winner) return;
			node.winner = ev.winner || null;
			this.anaStartEval();
		},

		anaBack() {
			const node = this._anaNode();
			if (node && node.parent !== null) this.anaGoto(node.parent);
		},

		anaForward() {
			const node = this._anaNode();
			if (!node || !node.children.length) return;
			const next = node.children.includes(node.lastChild) ? node.lastChild : node.children[0];
			this.anaGoto(next);
		},

		/** Up/down: the previous / next variation at this point (the
		 *  selected node's siblings). */
		anaVariation(dir) {
			const node = this._anaNode();
			if (!node || node.parent === null) return;
			const sibs = this.anaTree[node.parent].children;
			const k = sibs.indexOf(node.id) + dir;
			if (k >= 0 && k < sibs.length) this.anaGoto(sibs[k]);
		},

		anaEnd() {
			let node = this._anaNode();
			while (node && node.children.length) {
				node = this.anaTree[node.children.includes(node.lastChild) ? node.lastChild : node.children[0]];
			}
			if (node) this.anaGoto(node.id);
		},

		/** Delete the selected node and everything after it. */
		anaDelete() {
			const node = this._anaNode();
			if (!node || node.parent === null) return;
			const parent = this.anaTree[node.parent];
			parent.children = parent.children.filter(i => i !== node.id);
			if (parent.lastChild === node.id) parent.lastChild = parent.children[0] === undefined ? null : parent.children[0];
			const drop = (n) => { n.deleted = true; n.children.forEach(i => drop(this.anaTree[i])); };
			drop(node);
			this.anaGoto(parent.id);
		},

		anaKey(event) {
			if (this.anaMode !== 'analyse') return;
			const tag = event.target && event.target.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
			switch (event.key) {
				case 'ArrowLeft': event.preventDefault(); this.anaBack(); break;
				case 'ArrowRight': event.preventDefault(); this.anaForward(); break;
				case 'ArrowUp': event.preventDefault(); this.anaVariation(-1); break;
				case 'ArrowDown': event.preventDefault(); this.anaVariation(1); break;
				case 'Home': event.preventDefault(); this.anaGoto(0); break;
				case 'End': event.preventDefault(); this.anaEnd(); break;
			}
		},

		/** The tree as rows: each line's main continuation in order, its
		 *  alternatives indented under the move they replace. */
		anaRows() {
			const T = this.anaTree;
			if (!T.length) return [];
			const row = (id, indent, alt) => {
				const n = T[id];
				return { id, indent, alt, label: n.label, text: n.text, cur: id === this.anaCur,
					winner: n.winner, color: n.turn ? n.turn.color : '' };
			};
			const out = [row(0, 0, false)];
			const line = (id, indent) => {
				let n = T[id];
				while (n && n.children.length) {
					const [main, ...alts] = n.children;
					out.push(row(main, indent, false));
					for (const a of alts) {
						out.push(row(a, indent + 1, true));
						line(a, indent + 1);
					}
					n = T[main];
				}
			};
			line(0, 0);
			return out;
		},

		_anaSyncUrl() {
			const node = this._anaNode();
			try {
				const u = new URL(window.location.href);
				u.searchParams.delete('mode');
				if (node) u.searchParams.set('sfn', node.sfn);
				history.replaceState(null, '', u.toString());
			} catch (e) { /* ignore */ }
		},

		anaCurrentSfn() {
			const node = this._anaNode();
			return node ? node.sfn : '';
		},

		anaCopySfn() {
			const sfn = this.anaMode === 'edit' ? this.edSfn : this.anaCurrentSfn();
			if (!sfn || !navigator.clipboard) return;
			navigator.clipboard.writeText(sfn).then(() => {
				this.anaCopied = true;
				setTimeout(() => { this.anaCopied = false; }, 2000);
			}).catch(() => {});
		},

		// ---------------- the engine ----------------

		/** (Re)start the evaluation of the selected node; any search for an
		 *  earlier node is dropped (and the worker stopped when it is mid-search). */
		anaStartEval() {
			const gen = ++this._anaGen;
			clearTimeout(this._anaEvalTimer);
			const node = this._anaNode();
			const sfn = node ? node.sfn : '';
			this.anaEval = { status: 'idle', text: '', depth: 0, liveDepth: 0, timeMs: 0, best: null, bestText: '', expected: '', note: '', sfn };
			if (!node || this.anaMode !== 'analyse') { this._anaCancelSearch(); return; }
			if (node.winner) {
				this._anaCancelSearch();
				this.anaEval.status = 'decided';
				this.anaEval.text = (node.winner === 'red' ? 'Red' : 'Blue') + ' won';
				return;
			}
			const blocker = analysisEngineBlocker(sfn);
			if (blocker) {
				this._anaCancelSearch();
				this.anaEval.status = 'unavailable';
				this.anaEval.note = 'No engine evaluation: ' + blocker + '.';
				return;
			}
			this.anaEval.status = 'searching';
			// A short pause, so stepping through a line does not start (and
			// kill) a search per keypress.
			this._anaEvalTimer = setTimeout(() => {
				this._anaRunEval(gen).catch(e => {
					if (gen !== this._anaGen) return;
					this.anaEval.status = 'error';
					this.anaEval.note = 'The engine failed: ' + ((e && e.message) || e);
				});
			}, 150);
		},

		_anaStopEval() {
			++this._anaGen;
			clearTimeout(this._anaEvalTimer);
			this._anaCancelSearch();
		},

		/** Stop the worker when a search (for any node) is still running: the
		 *  generation bump only drops its result, the slice would run on. */
		_anaCancelSearch() {
			if (this._anaSearching && typeof getRustEngineWorker === 'function') {
				const w = getRustEngineWorker();
				if (typeof w.cancel === 'function') w.cancel();
				this._anaSearching = false;
			}
		},

		async _anaRunEval(gen) {
			const node = this._anaNode();
			if (!node || gen !== this._anaGen) return;
			const worker = getRustEngineWorker();
			// A search for an earlier node cannot be interrupted inside the
			// wasm call: stop its worker instead (rebuilt on the next search).
			if (this._anaSearching && typeof worker.cancel === 'function') worker.cancel();
			const searchSfn = positionTurnSfn(node.sfn);
			const mover = String(searchSfn).split(' ')[1] === 'r' ? 'red' : 'blue';
			// Threefold repetition: the line's earlier positions count, and the
			// position itself is one occurrence (as RustAI sends it).
			const history = this._anaPath(node.id).map(i => positionTurnSfn(this.anaTree[i].sfn)).slice(-64);
			const t0 = Date.now();
			this._anaShowStoredEval(gen, searchSfn, mover, history.slice(0, -1), node.sfn);
			for (let k = 0; k < ANALYSIS_EVAL_STEPS_MS.length; k++) {
				this._anaSearching = true;
				let res;
				try {
					res = await worker.search(Object.assign({
						sfn: searchSfn, timeMs: ANALYSIS_EVAL_STEPS_MS[k], ttBits: ANALYSIS_TT_BITS,
						historySfns: history,
						threads: typeof rustThreadCount === 'function' ? rustThreadCount() : 1,
					}, RUST_REVIEW_SEARCH), (msg) => {
						if (gen === this._anaGen && typeof msg.depth === 'number') this.anaEval.liveDepth = msg.depth;
					});
				} catch (e) {
					if (gen !== this._anaGen) return;   // cancelled for a newer node
					this._anaSearching = false;
					throw e;
				}
				if (gen !== this._anaGen) return;
				this._anaSearching = false;
				if (!res || res.ok === false) throw new Error((res && res.error) || 'no result');
				if (typeof res.stones !== 'number' && typeof res.mate_in !== 'number') continue;
				// Mover's view -> red's view, the form describePositionEval reads.
				const sign = mover === 'red' ? 1 : -1;
				const info = {
					depth: res.depth || 0,
					stones: typeof res.stones === 'number' ? res.stones * sign : null,
					mateIn: (typeof res.mate_in === 'number' && res.mate_in !== 0) ? res.mate_in * sign : null,
					proven: res.mate_in == null ? true : !!res.mate_proven,
				};
				const last = k === ANALYSIS_EVAL_STEPS_MS.length - 1 || (info.mateIn && info.proven);
				this.anaEval = {
					status: last ? 'done' : 'searching',
					text: describePositionEval(info),
					depth: info.depth, liveDepth: info.depth,
					timeMs: Date.now() - t0,
					best: Array.isArray(res.actions) && res.actions.length ? res.actions : null,
					bestText: Array.isArray(res.actions) ? describePuzzleActions(res.actions) : '',
					expected: res.expected_sfn || '',
					mover,
					note: '', sfn: node.sfn,
				};
				if (last) return;
			}
			if (gen === this._anaGen && this.anaEval.status === 'searching') {
				this.anaEval.status = this.anaEval.text ? 'done' : 'error';
				if (!this.anaEval.text) this.anaEval.note = 'The engine completed no depth.';
			}
		},

		/**
		 * The server's stored Quick search of the position (position_evals,
		 * written by functions/analysis.js), shown until the live search
		 * reports its first depth. Only for a position the line has not
		 * visited before: the stored search had no history.
		 */
		_anaShowStoredEval(gen, searchSfn, mover, earlier, sfn) {
			if (typeof loadPositionEvals !== 'function' || typeof firebase === 'undefined'
				|| !firebase.apps || !firebase.apps.length || positionRepeats(searchSfn, earlier)) return;
			loadPositionEvals(firebase.database(), [searchSfn]).then((stored) => {
				const res = stored.get(searchSfn);
				if (!res || gen !== this._anaGen || this.anaEval.text || this.anaEval.status !== 'searching') return;
				const sign = mover === 'red' ? 1 : -1;
				const info = {
					depth: res.depth || 0,
					stones: typeof res.stones === 'number' ? res.stones * sign : null,
					mateIn: (typeof res.mate_in === 'number' && res.mate_in !== 0) ? res.mate_in * sign : null,
					proven: res.mate_in == null ? true : !!res.mate_proven,
				};
				Object.assign(this.anaEval, {
					text: describePositionEval(info),
					depth: info.depth,
					best: Array.isArray(res.actions) && res.actions.length ? res.actions : null,
					bestText: Array.isArray(res.actions) ? describePuzzleActions(res.actions) : '',
					expected: res.expected_sfn || '',
					mover,
					note: 'Stored evaluation (depth ' + info.depth + '); searching deeper…',
					sfn,
				});
			}).catch(() => { /* no stored evaluation */ });
		},

		/** "depth 9, 8.4 s" or the live depth while a slice runs. */
		anaEvalDetail() {
			const e = this.anaEval;
			if (e.status === 'searching') {
				return e.depth ? ('depth ' + e.depth + ', searching deeper…') : 'searching…';
			}
			if (e.status === 'done') return 'depth ' + e.depth + ', ' + (e.timeMs / 1000).toFixed(1) + ' s';
			return '';
		},

		anaEvalSide() {
			const t = this.anaEval.text || '';
			if (/^Red|^\+/.test(t)) return 'red';
			if (/^Blue|^-/.test(t)) return 'blue';
			return '';
		},

		/** Play the engine's best turn on the board (animated, through the
		 *  controller's AI path); it joins the tree like any other turn. */
		async anaPlayBest() {
			const node = this._anaNode();
			const e = this.anaEval;
			if (!node || !e.best || e.sfn !== node.sfn || node.winner) return;
			let turn;
			try {
				const sim = sfnToSimBoard(positionTurnSfn(node.sfn));
				turn = await rustActionsToTurn(sim, e.mover, e.best, e.expected);
			} catch (err) {
				this.anaEval.note = 'Could not play the engine\'s turn: ' + ((err && err.message) || err);
				return;
			}
			if (this.anaCur !== node.id) return;
			this._anaStopEval();
			this._anaLoadBoard(node, { color: e.mover, turn });
		},

		/** Hand-offs to the game pages ('ai' | 'local' | 'online'). */
		anaPlayHref(kind) {
			const sfn = this.anaMode === 'edit' ? this.edSfn : this.anaCurrentSfn();
			// No link where the SFN would drop state (Silence): null removes href.
			if (!sfn || !this.anaCanPlay()) return null;
			const q = 'sfn=' + encodeURIComponent(sfn);
			if (kind === 'online') return 'multiplayer.html?' + q;
			if (kind === 'ai') return 'game.html?' + q + '&ai=' + encodeURIComponent(this.anaAiTier);
			return 'game.html?' + q;
		},

		anaCanPlay() {
			if (this.anaMode === 'edit') return !!this.edSfn && this.edErrors.length === 0;
			const node = this._anaNode();
			return !!(node && !node.winner && !analysisNodeSilenced(node));
		},

		/** Why the hand-offs are off for the selected node, or ''. */
		anaPlayNote() {
			if (this.anaMode === 'edit') return '';
			const node = this._anaNode();
			return node && !node.winner && analysisNodeSilenced(node)
				? 'A player is silenced here, which a shared position cannot carry; play on from the next turn.'
				: '';
		},

		/** Switch to the editor on the selected node's position. */
		anaEdit() {
			this._anaStopEval();
			const node = this._anaNode();
			this.anaMode = 'edit';
			this.edFromSfn(node ? node.sfn : null);
		},

		// ---------------- the editor ----------------

		/** Fill the editor from a loadable SFN (null: the standard start on
		 *  the core board with a random core draw). */
		edFromSfn(sfn) {
			if (this._anaCtl) this._anaCtl.stop();
			this.messageHistory = [];
			let d = null;
			if (sfn) {
				try { d = sfnToDict(sfn); } catch (e) { d = null; }
			}
			const ed = this.ed;
			if (!d) {
				this.applyBoardLayout('core');
				ed.layout = 'core';
				ed.end = 'standard';
				ed.competitive = false;
				ed.duplicates = false;
				ed.spells = generateSpellList(['core']);
				ed.stones = {};
				for (const n of NODE_ORDER) ed.stones[n] = null;
				ed.stones[BOARD.startStones.red] = 'red';
				ed.stones[BOARD.startStones.blue] = 'blue';
				ed.toMove = 'red';
				ed.turnNo = 1;
				ed.redSc = 0; ed.blueSc = 0;
				ed.redLock = ''; ed.blueLock = '';
				ed.redSpring = false; ed.blueSpring = false;
				ed.redBank = 0; ed.blueBank = 0;
			} else {
				const v = normalizeVariant(d.variant);
				ed.layout = d.layout;
				this.applyBoardLayout(d.layout);
				ed.end = variantHasDeathmatch(v) ? 'deathmatch' : (variantHasScramble(v) ? 'scramble' : 'standard');
				ed.competitive = variantHasCompetitive(v);
				// Not editable, but kept: the spell list may hold aliases
				// (Spell~2) and the engine blocker reads the variant.
				ed.duplicates = variantHasDuplicates(v);
				ed.spells = (d.spell_names || []).slice(0, BOARD.positionCount);
				while (ed.spells.length < BOARD.positionCount) ed.spells.push('');
				const stones = {};
				for (const n of NODE_ORDER) stones[n] = d.stones[n] || null;
				ed.stones = stones;
				const next = (d.turncounter || 0) + 1;
				ed.toMove = next % 2 === 1 ? 'red' : 'blue';
				ed.turnNo = ed.toMove === 'red' ? Math.floor(next / 2) + 1 : Math.floor(next / 2);
				ed.redSc = d.red_spellcounter || 0;
				ed.blueSc = d.blue_spellcounter || 0;
				ed.redLock = d.red_lock || '';
				ed.blueLock = d.blue_lock || '';
				ed.redSpring = !!d.red_springlock;
				ed.blueSpring = !!d.blue_springlock;
				ed.redBank = d.red_bank || 0;
				ed.blueBank = d.blue_bank || 0;
			}
			this.edSync();
		},

		edVariant() {
			const ed = this.ed;
			return composeVariant(ed.competitive, ed.end === 'deathmatch', !!ed.duplicates, ed.end === 'scramble', ed.layout === 'pentagon');
		},

		/** The editor's loadable turn counter: red's Nth turn is turn counter
		 *  2N-1 once the controller advances it, blue's Nth is 2N. */
		edTurnCounter() {
			const n = Math.max(1, Math.floor(Number(this.ed.turnNo) || 1));
			return this.ed.toMove === 'red' ? 2 * n - 2 : 2 * n - 1;
		},

		/** Rebuild the SFN from the editor, validate it and redraw the board. */
		edSync() {
			const ed = this.ed;
			// A new board layout: fresh spells and the start stones on it.
			if (ed.layout !== BOARD.id) {
				this.applyBoardLayout(ed.layout);
				// The editor's arrows belong to the old board's nodes.
				if (this.boardMarks) this.boardMarks.clear();
				ed.spells = generateSpellList(['core']);
				const stones = {};
				for (const n of NODE_ORDER) stones[n] = null;
				stones[BOARD.startStones.red] = 'red';
				stones[BOARD.startStones.blue] = 'blue';
				ed.stones = stones;
				ed.redLock = ''; ed.blueLock = '';
			}
			// A lock must be a 3- or 5-node spell on the board; a springlock is
			// the locked spell cast a second time (Seal of Spring).
			for (const c of ['red', 'blue']) {
				if (ed[c + 'Lock'] && !this.edLockOptions().some(o => o.name === ed[c + 'Lock'])) ed[c + 'Lock'] = '';
				if (!ed[c + 'Lock']) ed[c + 'Spring'] = false;
			}
			const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || 0)));
			const variant = this.edVariant();
			let sfn = '';
			let board = null;
			try {
				board = new SigilBoard(ed.spells.slice(), variant);
				for (const n of NODE_ORDER) board.stones[n] = ed.stones[n] || null;
				const tc = this.edTurnCounter();
				board.turnCounter = tc;
				// The token of an after-turn SFN names the side that just
				// moved (red at the very start, as a new game exports it).
				board.whoseTurn = (tc === 0 || tc % 2 === 1) ? 'red' : 'blue';
				board.spellCounter = { red: int(ed.redSc, 0, 99), blue: int(ed.blueSc, 0, 99) };
				board.lock = { red: ed.redLock || null, blue: ed.blueLock || null };
				board.springlock = { red: ed.redSpring ? ed.redLock : null, blue: ed.blueSpring ? ed.blueLock : null };
				board.providenceBank = { red: int(ed.redBank, 0, 99), blue: int(ed.blueBank, 0, 99) };
				board.update();
				sfn = boardToSfn(board);
			} catch (e) {
				this.edSfn = '';
				this.edErrors = ['Could not build the position: ' + (e.message || e)];
				this.edWarnings = [];
				return;
			}
			this.edSfn = sfn;
			const check = analysisValidateSfn(sfn);
			this.edErrors = check.errors;
			this.edWarnings = check.warnings;
			this._anaRenderBoard(board);
			try {
				const u = new URL(window.location.href);
				u.searchParams.set('mode', 'edit');
				u.searchParams.set('sfn', sfn);
				u.searchParams.delete('line');
				history.replaceState(null, '', u.toString());
			} catch (e) { /* ignore */ }
		},

		/** Click a node in the editor: empty -> red -> blue -> wall -> empty. */
		edCycle(node) {
			const order = [null, 'red', 'blue', 'X'];
			const cur = this.ed.stones[node] || null;
			this.ed.stones[node] = order[(order.indexOf(cur) + 1) % order.length];
			this.edSync();
		},

		edClear() {
			for (const n of NODE_ORDER) this.ed.stones[n] = null;
			this.edSync();
		},

		edStartPosition() {
			for (const n of NODE_ORDER) this.ed.stones[n] = null;
			this.ed.stones[BOARD.startStones.red] = 'red';
			this.ed.stones[BOARD.startStones.blue] = 'blue';
			this.edSync();
		},

		edRandomSpells() {
			this.ed.spells = generateSpellList(['core', ...EXPANSION_KEYS.filter(k => k !== 'panda' && k !== 'experimental')]);
			this.edSync();
		},

		/** Spell slots in position order: [{ i, type, label }]. */
		edSlots() {
			const out = [];
			for (let i = 0; i < BOARD.positionCount; i++) {
				const type = spellTypeAtPosition(i + 1);
				const k = i % BOARD.perType;
				out.push({ i, type, label: type[0].toUpperCase() + type.slice(1) + ' ' + 'ABCDEFGH'[k] });
			}
			return out;
		},

		edSpellOptions(type) {
			return analysisSpellPool(type);
		},

		/** The spells on the board that can be locked (3- and 5-node). */
		edLockOptions() {
			return (this.ed.spells || []).filter(n => n && CORE_SPELLS[n] && !CORE_SPELLS[n].ischarm)
				.map(n => ({ name: n, label: displaySpellName(n) }));
		},

		/** Load the SFN pasted into the editor's box. */
		edLoadImport() {
			const sfn = (this.edImport || '').trim();
			this.edImportError = '';
			if (!sfn) return;
			const check = analysisValidateSfn(sfn);
			const fatal = check.errors.filter(e => !/already decided|does not survive/.test(e));
			if (fatal.length) {
				this.edImportError = fatal.join(' ');
				return;
			}
			this.edFromSfn(sfn);
		},

		/** Analyse the edited position (a new tree). */
		edAnalyse() {
			if (!this.edSfn || this.edErrors.length) return;
			this.anaMode = 'analyse';
			this.anaSetLine([this.edSfn], null, 0);
		},

		// The editor's board clicks; otherwise the game's own handler.
		handleNodeClick(node) {
			if (this.anaMode === 'edit') {
				this.edCycle(node);
				return;
			}
			this.currentPlayer = this.whoseTurn;
			if (this.awaiting === 'node') {
				this.sendEvent(node);
			} else if (this.awaiting === 'action') {
				if (this.actionList.includes('move') || this.actionList.includes('providence')) {
					this.sendEvent(node);
				}
			}
		},
	};
}
