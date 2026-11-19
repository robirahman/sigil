/**
 * opening-explorer.js — the numbers behind openings.html: how often each
 * spell layout and each opening turn was played, and how each side did.
 *
 * Built two ways from the same code:
 *   - site-wide, by tools/gen-opening-explorer.js from a completed_games
 *     dump, into docs/static/data/opening-explorer.json (the live database
 *     is never read by the page for this);
 *   - for one player, in the page, from that player's user_games entries
 *     and the first turns of their (public) rooms.
 *
 * A turn is identified by the POSITION it leads to (stones, spell
 * counters, locks, springlocks, score: positionKey), never by the clicks
 * that made it, so different click orders -- and a rejected click left in
 * a transcript -- meet. Its label is the commonest way it was written in
 * the site's notation (a human turn's input tokens, as Export Game writes
 * them, without the closing "pass"; an engine turn's actions in the same
 * words), human turns preferred.
 *
 * Data shape (one "segment" = a set of games):
 *   { games, boards: { <layout id>: { n, r, tree } },
 *     layouts: [ { s: [spells in slot order], b: layout id, n, r, t?: tree } ],
 *     sets:    [ { s: [spells, sorted], b, n, r, a: arrangements } ] }
 *   tree node: { m: label, k: positionKey, n: games, r: red wins,
 *                p?: the focus player's wins, c: [children, most played first] }
 *   The root has no m/k. Games without a recorded winner are left out.
 *
 * Classic script (a global) and require()-able in node; needs
 * displaySpellName / baseSpellName (engine/constants.js) when present.
 */

const OpeningExplorer = (() => {
	const DEFAULTS = {
		depth: 6,            // turns kept in each board's tree
		layoutDepth: 4,      // turns kept in a layout's own tree
		minGames: 2,         // a tree node needs this many games to be listed
		minLayoutGames: 1,   // a layout (or spell set) needs this many games
		maxLayouts: 400,     // most played layouts / sets listed
		layoutTrees: 40,     // most played layouts that get their own tree
	};

	const disp = (n) => (typeof displaySpellName === 'function' ? displaySpellName(n) : String(n || '').replace(/_/g, ' '));

	/** Position key of an SFN: no spell list, side token or turn counter, so
	 *  the same opening on different layouts meets; the Providence banks
	 *  (the 'pm:' token) are part of the position and kept. */
	function positionKey(sfn) {
		const p = String(sfn || '').trim().split(/\s+/);
		if (p.length < 7) return '';
		const key = [p[0].split('/')[0], p[3], p[4], p[5], p[6]];
		const pm = p.slice(7).find((t) => t.startsWith('pm:'));
		if (pm) key.push(pm);
		return key.join(' ');
	}

	/** An engine turn's SimActions in the notation's words. */
	function simTokens(actions) {
		const out = [];
		for (const a of actions || []) {
			if (!a || a.type === 'pass') continue;
			switch (a.type) {
				case 'move': case 'blink': out.push(a.node); break;
				case 'hard_move': out.push(a.node); if (a.pushed_to) out.push(a.pushed_to); break;
				case 'dash': case 'dash_lightning': out.push('dash', ...(a.sacrificed || [])); break;
				case 'cast': out.push(a.spell, ...(a.kept || [])); break;
				default:
					for (const k of ['node', 'node2']) if (a[k]) out.push(a[k]);
					for (const k of ['destroyed', 'converted', 'kept']) if (Array.isArray(a[k])) out.push(...a[k]);
			}
		}
		return out.filter(Boolean);
	}

	/** A recorded turn ({kind, actions}) as text in the site's notation. */
	function turnText(turn) {
		if (!turn) return '';
		const tokens = turn.kind === 'sim' ? simTokens(turn.actions)
			: (turn.tokens || turn.actions || []).filter((t) => typeof t === 'string' && t !== 'pass' && t !== 'submit');
		return tokens.map((t) => (/^[A-Z]/.test(t) ? disp(t) : t === 'skip_providence' ? 'skip' : t)).join(' ');
	}

	/** Is `sfn` (the first turn's position before it is played) the standard
	 *  opening: the two start stones, red to move on turn 1, no spells cast,
	 *  no locks, the opening score, empty Providence banks? */
	function standardStart(sfn, layout) {
		const p = String(sfn || '').trim().split(/\s+/);
		if (p.length < 7) return false;
		if (p[1] !== 'r' || p[2] !== '1' || p[3] !== '0:0' || p[4] !== '-:-' || p[5] !== '-:-' || p[6] !== 'b1') return false;
		if (p.slice(7).some((t) => t.startsWith('pm:'))) return false;
		const stones = p[0].split('/')[0];
		const order = typeof boardLayoutDef === 'function' ? boardLayoutDef(layout || 'core').nodeOrder : null;
		if (!order || order.length !== stones.length) return false;
		for (let i = 0; i < order.length; i++) {
			const want = order[i] === 'a1' ? 'r' : order[i] === 'b1' ? 'b' : '.';
			if (stones[i] !== want) return false;
		}
		return true;
	}

	/**
	 * One game as the explorer counts it, or null when it does not count
	 * (no winner, not from the standard start, no turns).
	 *   rec   - { spellNames, variant, winner, redUid, blueUid }
	 *   turns - the game's first turns with positions: [{ color, kind, actions,
	 *           sfnBefore, sfnAfter }] (reconstructGameLog / hydrateGameLog)
	 */
	function gameEntry(rec, turns, depth) {
		if (!rec || (rec.winner !== 'red' && rec.winner !== 'blue')) return null;
		if (!Array.isArray(turns) || !turns.length || !turns[0].sfnBefore) return null;
		// Plies are labelled red, blue, red... from the first.
		if (turns[0].color !== 'red' || turns[0].turnNumber !== 1) return null;
		let layout = 'core';
		try { layout = sfnToDict(turns[0].sfnBefore).layout || 'core'; } catch (e) {
			layout = typeof boardLayoutForSpellCount === 'function' ? boardLayoutForSpellCount((rec.spellNames || []).length) : 'core';
		}
		if (!standardStart(turns[0].sfnBefore, layout)) return null;
		const plies = [];
		for (const t of turns.slice(0, depth || DEFAULTS.depth)) {
			if (!t.sfnAfter || t.kind === 'snapshot') break;
			plies.push({ key: positionKey(t.sfnAfter), label: turnText(t), human: t.kind !== 'sim' });
		}
		const isAi = (uid) => typeof uid === 'string' && /^__ai_/.test(uid);
		return {
			board: layout,
			spells: (rec.spellNames || []).slice(),
			winner: rec.winner,
			pvp: !!(rec.redUid && rec.blueUid && !isAi(rec.redUid) && !isAi(rec.blueUid) && rec.redUid !== rec.blueUid),
			plies,
			player: rec.player || null,   // the focus player's colour, for per-player views
		};
	}

	function newNode() { return { n: 0, r: 0, p: 0, c: new Map(), labels: new Map() }; }

	function addPath(root, e, depth) {
		const red = e.winner === 'red' ? 1 : 0;
		const mine = e.player && e.player === e.winner ? 1 : 0;
		let node = root;
		node.n++; node.r += red; node.p += mine;
		for (const ply of e.plies.slice(0, depth)) {
			if (!ply.key) break;
			let child = node.c.get(ply.key);
			if (!child) { child = newNode(); node.c.set(ply.key, child); }
			child.n++; child.r += red; child.p += mine;
			if (ply.label) child.labels.set(ply.label, (child.labels.get(ply.label) || 0) + (ply.human ? 1000 : 1));
			node = child;
		}
	}

	function finish(node, key, minGames, withPlayer) {
		const out = { n: node.n, r: node.r };
		if (withPlayer) out.p = node.p;
		if (key !== null) {
			let best = '', bestW = -1;
			for (const [label, w] of node.labels) if (w > bestW || (w === bestW && label < best)) { best = label; bestW = w; }
			out.m = best;
			out.k = key;
		}
		const kids = [];
		for (const [k, child] of node.c) if (child.n >= minGames) kids.push(finish(child, k, minGames, withPlayer));
		kids.sort((a, b) => b.n - a.n || (a.m < b.m ? -1 : 1));
		out.c = kids;
		return out;
	}

	/**
	 * Count entries (gameEntry results) into one segment. opts: DEFAULTS
	 * overrides, plus withPlayer to keep the focus player's wins (p).
	 */
	function aggregate(entries, opts) {
		const o = Object.assign({}, DEFAULTS, opts || {});
		const boards = new Map();
		const layouts = new Map();
		const sets = new Map();
		let games = 0;
		for (const e of entries) {
			if (!e) continue;
			games++;
			const red = e.winner === 'red' ? 1 : 0;
			if (!boards.has(e.board)) boards.set(e.board, newNode());
			addPath(boards.get(e.board), e, o.depth);
			const lk = e.board + '|' + e.spells.join(',');
			let L = layouts.get(lk);
			if (!L) { L = { s: e.spells.slice(), b: e.board, n: 0, r: 0, tree: newNode() }; layouts.set(lk, L); }
			L.n++; L.r += red;
			addPath(L.tree, e, o.layoutDepth);
			const sk = e.board + '|' + e.spells.slice().sort().join(',');
			let S = sets.get(sk);
			if (!S) { S = { s: e.spells.slice().sort(), b: e.board, n: 0, r: 0, arr: new Set() }; sets.set(sk, S); }
			S.n++; S.r += red; S.arr.add(lk);
		}
		const byCount = (a, b) => b.n - a.n || (a.s.join(',') < b.s.join(',') ? -1 : 1);
		const layoutList = [...layouts.values()].filter((L) => L.n >= o.minLayoutGames).sort(byCount).slice(0, o.maxLayouts);
		const out = {
			games,
			boards: {},
			layouts: layoutList.map((L, i) => {
				const row = { s: L.s, b: L.b, n: L.n, r: L.r };
				if (i < o.layoutTrees && L.n >= o.minGames) row.t = finish(L.tree, null, o.minGames, o.withPlayer);
				return row;
			}),
			sets: [...sets.values()].filter((S) => S.n >= o.minLayoutGames).sort(byCount).slice(0, o.maxLayouts)
				.map((S) => ({ s: S.s, b: S.b, n: S.n, r: S.r, a: S.arr.size })),
		};
		for (const [b, root] of boards) out.boards[b] = { n: root.n, r: root.r, tree: finish(root, null, o.minGames, o.withPlayer) };
		return out;
	}

	/** The child reached by following `keys` from a tree root (or null). */
	function walk(tree, keys) {
		let node = tree;
		for (const k of keys || []) {
			node = node && (node.c || []).find((c) => c.k === k);
			if (!node) return null;
		}
		return node;
	}

	return { DEFAULTS, positionKey, simTokens, turnText, standardStart, gameEntry, aggregate, walk };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OpeningExplorer;
