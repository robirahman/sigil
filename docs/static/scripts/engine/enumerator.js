/**
 * Browser-side exhaustive turn enumerator.
 *
 * Expand every high-impact choice point (Bewitch pair, Carnage/Slash
 * hard-move targets, Starfall pair, Meteor target, Comet target ×
 * sacrifice, Fireblast sacrifice, dash sacrifice combo × move target)
 * so a few-ply minimax actually sees the alternatives. Candidate lists
 * are smart-ordered (e.g. dead stones rank first as sacrifices), then
 * truncated to ENUM_CAPS — the top-K most-promising variants, not the
 * first-K in NODE_ORDER.
 */

// Single enumeration cap set used at every ply that requests exhaustive
// enumeration. Each cap bounds how many variants of that choice-point
// the minimax search expands at a node:
//   dash_sac × dash_move = number of dash variants
//   bewitch              = adjacent-enemy-pair choices
//   starfall             = adjacent-empty-pair choices
//   hard_moves           = Carnage/Slash push-target choices
//   meteor               = Meteor blink-target choices
//   comet                = Comet target × sacrifice pairings
//   fireblast            = Fireblast sacrifice-stone choices
// Ordering helpers (_rankSacCombos, _rankDashTargets,
// _adjacentEmptyPairsRanked) rank candidates first, so the cap selects
// the top-K *promising* variants, not the first-K in NODE_ORDER.
const ENUM_CAPS = {
	dash_sac: 8,
	dash_move: 4,
	// How many alternative push destinations to branch when a hard-move /
	// dash-move / hard-move-spell pushes an enemy stone with several legal
	// landing cells. Small: it multiplies the branching factor at every
	// push site. The live engine lets the player choose this cell
	// (spells.js doPushEnemy); without branching, the AI only ever sees
	// the default nearest-empty cell and misses tactics like pushing a
	// stone into a gap to merge two enemy groups (then Hurricane them).
	push_dest: 3,
	bewitch: 8,
	starfall: 6,
	hard_moves: 6,
	meteor: 4,
	comet: 4,
	fireblast: 4,
	corrupt: 4,
	// Expansion-pack caps. Brute-force (no heuristic ordering) per user
	// direction; tune later.
	fury_sac: 6,
	fury_target: 4,
	charge: 6,
	storm_front: 12,
	hurricane: 4,
	soft_hard_soft: 4,
	soft_hard_hard: 4,
	splash: 6,
	// Tectonic expansion caps.
	fissure: 6,
	// Panda expansion caps.
	shiver: 8,
	choke: 6,
	moth_plague: 6,
	itch: 6,
	residue_mixture: 6,
	stampede: 6,
};

function _adjacentEnemyPairs(board, color) {
	const enemy = board._enemy(color);
	const seen = new Set();
	const out = [];
	for (const n of NODE_ORDER) {
		if (board.stones[n] !== enemy) continue;
		for (const nb of (ADJACENCY[n] || [])) {
			if (board.stones[nb] !== enemy) continue;
			const a = n < nb ? n : nb;
			const b = n < nb ? nb : n;
			const key = a + '|' + b;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push([a, b]);
		}
	}
	return out;
}

/**
 * Unique adjacent empty-empty pairs, ranked by Starfall destruction
 * count: the spell resolves by destroying every enemy stone in
 * neighbors(a) ∪ neighbors(b), so that union's enemy count IS the kill
 * count. Mirrors ai/enumerator.py:_adjacent_empty_pairs_ranked.
 */
function _starfallPairsRanked(board, color) {
	const enemy = board._enemy(color);
	const seen = new Set();
	const cand = [];
	for (const n of NODE_ORDER) {
		if (board.stones[n] !== null) continue;
		for (const nb of (ADJACENCY[n] || [])) {
			if (board.stones[nb] !== null) continue;
			const a = n < nb ? n : nb;
			const b = n < nb ? nb : n;
			const key = a + '|' + b;
			if (seen.has(key)) continue;
			seen.add(key);
			const neighbors = new Set([
				...(ADJACENCY[a] || []),
				...(ADJACENCY[b] || []),
			]);
			let score = 0;
			for (const x of neighbors) if (board.stones[x] === enemy) score++;
			cand.push([score, [a, b]]);
		}
	}
	cand.sort((u, v) => v[0] - u[0]);
	return cand.map(c => c[1]);
}

/**
 * Fireblast destruction is independent of sacrifice choice — it removes
 * every enemy adjacent to ANY own stone before the sacrifice resolves.
 * So the choice only affects WHICH own stone is lost. Rank candidates
 * by escape-distance descending so dead/trapped stones sacrifice first.
 */
function _rankFireblastSacs(board, color, candidates) {
	const scored = candidates.map(n => [board.escapeDistance(n, color, 6), n]);
	scored.sort((a, b) => b[0] - a[0]);
	return scored.map(s => s[1]);
}

/**
 * Order sacrifice combos by escape-distance descending. Dead stones
 * rank first — they're about to be captured, so sacrificing them is
 * "free." For pairs, score = sum of distances. BFS is capped at 6 hops
 * since for ordering we only need to distinguish alive (1-5) from
 * dead-or-near-dead (6); exact distance doesn't matter.
 */
function _rankSacCombos(board, color, hasLightning, cap) {
	// Seal of Autumn (held by the enemy) bars sacrificing stones on a spell
	// sigil; with too few eligible stones the returned combos come up empty
	// and the dash branch is skipped entirely.
	const enemy = board._enemy(color);
	const restricted = (board.chargedSpells[enemy] || []).includes('Seal_of_Autumn');
	const own = NODE_ORDER.filter(n => board.stones[n] === color && (!restricted || !isSpellNode(n)));
	const dist = new Map();
	for (const n of own) dist.set(n, board.escapeDistance(n, color, 6));
	if (hasLightning) {
		const scored = own.map(n => [dist.get(n), n]);
		scored.sort((a, b) => b[0] - a[0]);
		return scored.slice(0, cap).map(s => [s[1]]);
	}
	const scored = [];
	for (let i = 0; i < own.length; i++) {
		for (let j = i + 1; j < own.length; j++) {
			scored.push([dist.get(own[i]) + dist.get(own[j]), [own[i], own[j]]]);
		}
	}
	scored.sort((a, b) => b[0] - a[0]);
	return scored.slice(0, cap).map(s => s[1]);
}

/**
 * Order dash destinations by enemy-adjacency count descending — dash
 * toward impact rather than in NODE_ORDER. Cheap proxy for "this move
 * matters tactically."
 */
function _rankDashTargets(board, color, targets) {
	const enemy = board._enemy(color);
	const scored = targets.map(n => {
		let s = 0;
		for (const nb of (ADJACENCY[n] || [])) if (board.stones[nb] === enemy) s++;
		return [s, n];
	});
	scored.sort((a, b) => b[0] - a[0]);
	return scored.map(s => s[1]);
}

/**
 * Order Carnage / Slash hard-move targets by tactical value: crushable
 * enemies first (immediate kill — escapeDistance ≥ 39 means no escape
 * from the push), then by adjacent-enemy count (pushing a stone inside
 * the enemy cluster cascades because adjacent enemies block its own
 * escape and push-chains in turn). The user-observed pathology
 * (Carnage pushing enemies in circles) is the symptom of picking
 * peripheral enemies in NODE_ORDER instead of attacking the cluster.
 */
function _rankHardMoveTargets(board, color, targets) {
	const enemy = board._enemy(color);
	const scored = targets.map((n, i) => {
		const crush = board.isCrushable(n, color) ? 1 : 0;
		let adjEnemies = 0;
		for (const nb of (ADJACENCY[n] || [])) {
			if (board.stones[nb] === enemy) adjEnemies++;
		}
		return [crush, adjEnemies, i, n];
	});
	scored.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]) || (a[2] - b[2]));
	return scored.map(s => s[3]);
}

/**
 * Push-destination variants for a hard-move onto `target`. Returns a list
 * of `push_dests` fragments to merge into a spell override: each fragment
 * is a one-element array naming the cell the pushed stone lands on, capped
 * at caps.push_dest. When the push has 0–1 legal destinations there's
 * nothing to choose, so returns [null] — a single variant carrying no
 * override (the resolver falls back to the default nearest-empty cell).
 * Destinations are computed on the current board; the resolver re-validates
 * each against the live options at push time, so an override invalidated by
 * an intervening sacrifice/soft-move simply reverts to the default.
 */
function _pushDestFragments(board, color, target, caps) {
	if (board.stones[target] !== board._enemy(color)) return [null];
	const dests = board._pushDestinations(target, color);
	if (dests.length <= 1) return [null];
	return dests.slice(0, caps.push_dest).map(d => [d]);
}

// How many distinct first-push candidates a Carnage/Fury variant branches
// on. Each variant is a *priority list* — first push fixed, the rest follow
// rank order — so this is the count of multi-push lines the search sees per
// cast. Generous (covers every hard-moveable enemy in practice) because the
// lists are built from a single ranking with no per-push simulation, so the
// cost is independent of this number.
const _HARD_MOVE_FIRST_N = 12;

// How many sacrifice candidates Fury tries (deadest-first). Each adds a full
// set of first-push variants, so this and _HARD_MOVE_FIRST_N together set
// Fury's variant count; sacrificing a doomed stone is nearly always right.
const _HARD_MOVE_FURY_SACS = 6;

/**
 * Enemy stones ordered by how many of `color`'s stones they touch
 * (descending) — a cheap, BFS-free proxy for "most pressured / most likely
 * to become hard-moveable". Used as a fallback tail so multi-push spells
 * never hit the resolver's arbitrary targets[0] even on pushes that act on
 * stones made hard-moveable by an earlier push.
 */
function _enemiesByAdjacency(board, color) {
	const enemy = board._enemy(color);
	const scored = [];
	for (const n of NODE_ORDER) {
		if (board.stones[n] !== enemy) continue;
		let adj = 0;
		for (const nb of (ADJACENCY[n] || [])) if (board.stones[nb] === color) adj++;
		scored.push([adj, n]);
	}
	scored.sort((a, b) => b[0] - a[0]);
	return scored.map(s => s[1]);
}

/**
 * Build push-priority lists from one ranked target set — no per-push board
 * simulation. Each list fixes a distinct first push (one of the top
 * `firstN` ranked targets), follows rank order for the rest, then ends with
 * `tail` (every other enemy, adjacency-ordered). The hard_moves / fury
 * resolvers consume the list with `.shift()`, validating each entry against
 * the live board after every push and skipping any an earlier push
 * invalidated; because the list spans every enemy the resolver never
 * exhausts it and so never falls back to its arbitrary `targets[0]` choice
 * — the old single-target overrides left pushes 2..N to that fallback,
 * which is the "push enemies in circles" pathology.
 *
 * For count-1 spells (Slash) only the first entry is used, so the variants
 * reduce to "push each candidate", matching the old single-target behavior.
 */
function _pushPriorityLists(ranked, tail, firstN) {
	if (!ranked.length) return [];
	const out = [];
	const lim = Math.min(firstN, ranked.length);
	for (let i = 0; i < lim; i++) {
		const list = [ranked[i]];
		for (let j = 0; j < ranked.length; j++) if (j !== i) list.push(ranked[j]);
		for (const t of tail) list.push(t);
		out.push(list);
	}
	return out;
}

/**
 * Return list of `targetOverrides` dicts to try for `spellName`.
 * Always includes `{}` (greedy) so we don't lose the engine's default.
 */
function _spellOverrides(board, color, spellName, caps) {
	const info = CORE_SPELLS[spellName];
	if (!info) return [{}];
	const rt = info.resolve;
	const out = [{}];
	if (rt === 'bewitch') {
		const pairs = _adjacentEnemyPairs(board, color);
		for (let i = 0; i < pairs.length && i < caps.bewitch; i++) {
			out.push({ bewitch_pair: pairs[i] });
		}
	} else if (rt === 'starfall') {
		const pairs = _starfallPairsRanked(board, color);
		for (let i = 0; i < pairs.length && i < caps.starfall; i++) {
			out.push({ starfall_pair: pairs[i] });
		}
	} else if (rt === 'hard_moves') {
		// Carnage (count 4) / Slash (count 1): branch the first push across
		// every hard-moveable enemy, each followed by a full ranked priority
		// list for pushes 2..count (so the resolver never falls back to its
		// arbitrary targets[0]). Ranking is on the post-cast board (positions
		// cleared + mana refill) so the targets match what the resolver sees.
		const bc = board.copy();
		bc._castClearAndRefill(spellName, color);
		const ranked = _rankHardMoveTargets(bc, color, bc._hardMoveable(color));
		const rankedSet = new Set(ranked);
		const tail = _enemiesByAdjacency(bc, color).filter(n => !rankedSet.has(n));
		for (const list of _pushPriorityLists(ranked, tail, _HARD_MOVE_FIRST_N)) {
			out.push({ hard_move_targets: list });
		}
	} else if (rt === 'meteor') {
		const targets = board._blinkable(color);
		for (let i = 0; i < targets.length && i < caps.meteor; i++) {
			for (const pd of _pushDestFragments(board, color, targets[i], caps)) {
				const ovr = { meteor_target: targets[i] };
				if (pd) ovr.push_dests = pd;
				out.push(ovr);
			}
		}
	} else if (rt === 'comet') {
		const blinkable = board._blinkable(color);
		const own = NODE_ORDER.filter(n => board.stones[n] === color);
		let added = 0;
		for (const target of blinkable) {
			if (added >= caps.comet) break;
			for (const sac of own) {
				if (sac !== target) {
					out.push({ comet_target: target, comet_sacrifice: sac });
					added++;
					break;
				}
			}
		}
	} else if (rt === 'fireblast') {
		// Sacrifices outside the spell's own position nodes — those still
		// exist when the resolver runs, so they're valid candidates.
		let spellPos = new Set();
		const idx = board.spellNames ? board.spellNames.indexOf(spellName) : -1;
		if (idx >= 0 && POSITIONS[idx + 1]) {
			spellPos = new Set(POSITIONS[idx + 1]);
		}
		const own = NODE_ORDER.filter(
			n => board.stones[n] === color && !spellPos.has(n),
		);
		const ranked = _rankFireblastSacs(board, color, own);
		for (let i = 0; i < ranked.length && i < caps.fireblast; i++) {
			out.push({ fireblast_sacrifice: ranked[i] });
		}
	} else if (rt === 'corrupt') {
		// Branch over which own stone is sacrificed (same spell-position caveat
		// as fireblast). Conversion stays greedy — converting more enemy stones
		// is ~always good, so the greedy first-3 covers it.
		let spellPos = new Set();
		const idx = board.spellNames ? board.spellNames.indexOf(spellName) : -1;
		if (idx >= 0 && POSITIONS[idx + 1]) {
			spellPos = new Set(POSITIONS[idx + 1]);
		}
		const own = NODE_ORDER.filter(
			n => board.stones[n] === color && !spellPos.has(n),
		);
		for (let i = 0; i < own.length && i < caps.corrupt; i++) {
			out.push({ corrupt_sacrifice: own[i] });
		}
	} else if (rt === 'fury') {
		// Sacrifice 1 + 3 hard moves. Mirror the resolver order exactly: cast
		// preamble (clear positions + mana refill), then remove the sacrifice
		// (update()), then rank the 3-push targets off that post-sacrifice
		// board. Branch sacrifice across the deadest-first candidates and, for
		// each, the first push across every hard-moveable enemy with a full
		// ranked priority list for the remaining pushes. No per-push board
		// simulation — one ranking per sacrifice.
		const bc = board.copy();
		bc._castClearAndRefill(spellName, color);
		const sacs = _rankFireblastSacs(bc, color, NODE_ORDER.filter(n => bc.stones[n] === color))
			.slice(0, _HARD_MOVE_FURY_SACS);
		for (const sac of sacs) {
			const bs = bc.copy();
			bs.stones[sac] = null;
			bs.update();
			if (bs.gameover) { out.push({ fury_sacrifice: sac }); continue; }
			const ranked = _rankHardMoveTargets(bs, color, bs._hardMoveable(color));
			const rankedSet = new Set(ranked);
			const tail = _enemiesByAdjacency(bs, color).filter(n => !rankedSet.has(n));
			const lists = _pushPriorityLists(ranked, tail, _HARD_MOVE_FIRST_N);
			if (!lists.length) { out.push({ fury_sacrifice: sac }); continue; }
			for (const list of lists) out.push({ fury_sacrifice: sac, hard_move_targets: list });
		}
	} else if (rt === 'charge') {
		// Each all-moveable target that lands in a 3- or 5-node spell
		// (positions 1..6). Greedy ordering — defer heuristics.
		const inSmallSpell = (n) => {
			for (let i = 1; i <= 6; i++) if (POSITIONS[i].includes(n)) return true;
			return false;
		};
		const targets = board._allMoveable(color).filter(inSmallSpell);
		for (let i = 0; i < targets.length && i < caps.charge; i++) {
			out.push({ charge_target: targets[i] });
		}
	} else if (rt === 'storm_front') {
		const enemy = board._enemy(color);
		const enemies = NODE_ORDER.filter(n => board.stones[n] === enemy);
		let added = 0;
		outer: for (let i = 0; i < enemies.length; i++) {
			for (let j = i + 1; j < enemies.length; j++) {
				if (added >= caps.storm_front) break outer;
				out.push({ storm_front_pair: [enemies[i], enemies[j]] });
				added++;
			}
		}
	} else if (rt === 'hurricane') {
		const enemy = board._enemy(color);
		const visited = new Set();
		const groups = [];
		for (const start of NODE_ORDER) {
			if (visited.has(start) || board.stones[start] !== enemy) continue;
			const group = [];
			const queue = [start];
			visited.add(start);
			while (queue.length > 0) {
				const n = queue.shift();
				group.push(n);
				for (const nb of (ADJACENCY[n] || [])) {
					if (!visited.has(nb) && board.stones[nb] === enemy) {
						visited.add(nb);
						queue.push(nb);
					}
				}
			}
			groups.push(group);
		}
		if (groups.length) {
			const minSize = Math.min(...groups.map(g => g.length));
			const smallest = groups.filter(g => g.length === minSize);
			for (let i = 0; i < smallest.length && i < caps.hurricane; i++) {
				out.push({ hurricane_group: smallest[i].slice() });
			}
		}
	} else if (rt === 'soft_hard_chain') {
		const softTargets = board._softMoveable(color);
		const hardTargets = board._hardMoveable(color);
		const softCap = Math.min(softTargets.length, caps.soft_hard_soft);
		const hardCap = Math.min(hardTargets.length, caps.soft_hard_hard);
		for (let i = 0; i < softCap; i++) {
			for (let j = 0; j < hardCap; j++) {
				for (const pd of _pushDestFragments(board, color, hardTargets[j], caps)) {
					const ovr = { soft_move_targets: [softTargets[i]], hard_move_targets: [hardTargets[j]] };
					if (pd) ovr.push_dests = pd;
					out.push(ovr);
				}
			}
		}
	} else if (rt === 'fissure') {
		// Branch over which node to permanently destroy, scored by net
		// stone-count advantage so the strongest walls are explored first:
		//   target term: +1 enemy / 0 empty / -1 own
		//   blast term:  +1 per adjacent enemy stone (also destroyed)
		const enemy = board._enemy(color);
		const scored = [];
		for (const node of NODE_ORDER) {
			let score = board.stones[node] === enemy ? 1
				: (board.stones[node] === color ? -1 : 0);
			for (const nb of (ADJACENCY[node] || [])) {
				if (board.stones[nb] === enemy) score++;
			}
			scored.push([score, node]);
		}
		scored.sort((a, b) => b[0] - a[0]);
		for (let i = 0; i < scored.length && i < caps.fissure; i++) {
			out.push({ fissure_target: scored[i][1] });
		}
	} else if (rt === 'surge_move' && spellName === 'Splash') {
		// Splash enumerates each possible move destination. (Surge — the
		// other surge_move user — only runs post-dash and is currently
		// excluded by sim-board's _getCastableSpells, so this branch is
		// Splash-specific.)
		const targets = board._allMoveable(color);
		for (let i = 0; i < targets.length && i < caps.splash; i++) {
			out.push({ surge_target: targets[i] });
		}
	} else if (rt === 'restricted_move') {
		// Lurk: each moveable node that is NOT part of a 3- or 5-node spell.
		const targets = board._allMoveable(color).filter(n => !isBigSpellNode(n));
		for (let i = 0; i < targets.length && i < caps.splash; i++) {
			out.push({ restricted_target: targets[i] });
		}
	} else if (rt === 'shiver') {
		// Enumerate own↔enemy swaps (the impactful ones).
		const enemy = board._enemy(color);
		const own = NODE_ORDER.filter(n => board.stones[n] === color);
		const foe = NODE_ORDER.filter(n => board.stones[n] === enemy);
		let added = 0;
		outer: for (const o of own) {
			for (const f of foe) {
				if (added >= caps.shiver) break outer;
				out.push({ shiver_pair: [o, f] });
				added++;
			}
		}
	} else if (rt === 'choke') {
		const enemy = board._enemy(color);
		const foe = NODE_ORDER.filter(n => board.stones[n] === enemy);
		for (let i = 0; i < foe.length && i < caps.choke; i++) {
			out.push({ choke_target: foe[i] });
		}
	} else if (rt === 'moth_plague') {
		const enemy = board._enemy(color);
		const foe = NODE_ORDER.filter(n => board.stones[n] === enemy);
		for (let i = 0; i < foe.length && i < caps.moth_plague; i++) {
			out.push({ moth_targets: [foe[i]] });
		}
	} else if (rt === 'itch') {
		const targets = board._allMoveable(color);
		for (let i = 0; i < targets.length && i < caps.itch; i++) {
			out.push({ itch_target: targets[i] });
		}
	} else if (rt === 'residue_mixture') {
		const enemy = board._enemy(color);
		const foe = NODE_ORDER.filter(n => board.stones[n] === enemy);
		for (let i = 0; i < foe.length && i < caps.residue_mixture; i++) {
			out.push({ residue_target: foe[i] });
		}
	} else if (rt === 'stampede') {
		const ranked = _rankHardMoveTargets(board, color, board._hardMoveable(color));
		for (let i = 0; i < ranked.length && i < caps.stampede; i++) {
			for (const pd of _pushDestFragments(board, color, ranked[i], caps)) {
				const ovr = { hard_move_targets: [ranked[i]] };
				if (pd) ovr.push_dests = pd;
				out.push(ovr);
			}
		}
	}
	// soft_moves, hail_storm, gust, blossom, erupt: greedy is fine.
	// Gust's pickup is forced and placement combinatorics blow up — defer
	// to follow-up.
	return out;
}

function _enumeratePostMoveExhaustive(board, color, prefix, caps, canDash, canSpell, canSummer, out) {
	const enemy = board._enemy(color);
	out.push(new SimTurn(prefix.concat([new SimAction('pass')])));

	if (canSpell) {
		let castable;
		try {
			castable = board._getCastableSpells(color, canSpell, canSummer);
		} catch (e) { castable = []; }
		for (const spellName of castable) {
			const overrides = _spellOverrides(board, color, spellName, caps);
			for (const ovr of overrides) {
				const bs = board.copy();
				let spellActions;
				try {
					spellActions = bs._castSpell(spellName, color, ovr);
				} catch (e) { continue; }
				bs.update();
				_enumeratePostMoveExhaustive(
					bs, color, prefix.concat(spellActions), caps,
					canDash, false, canSummer, out,
				);
			}
		}
	}

	// Dash: enumerate sacrifice combos × top-K move targets, both
	// smart-ordered. Sacrifices ranked by escape-distance (dead stones
	// first); destinations ranked by enemy-adjacency (impact first).
	if (canDash && canSpell && board.totalStones[color] > 2) {
		const hasLightning = (board.chargedSpells[color] || []).includes('Seal_of_Lightning');
		// With Lightning, dash sacrifices are single stones and destinations
		// are at most ~6 per stone — total ~60 combos. Cheap enough to
		// enumerate exhaustively; pruning here would discard real options.
		const dashSacCap = hasLightning ? Infinity : caps.dash_sac;
		const dashMoveCap = hasLightning ? Infinity : caps.dash_move;
		const sacCombos = _rankSacCombos(board, color, hasLightning, dashSacCap);
		for (const sacs of sacCombos) {
			const bd0 = board.copy();
			for (const s of sacs) bd0.stones[s] = null;
			bd0.update();
			const targets = _rankDashTargets(bd0, color, bd0._allMoveable(color));
			for (let ti = 0; ti < targets.length && ti < dashMoveCap; ti++) {
				const chosen = targets[ti];
				// Branch the dash move's push destination when it lands on an
				// enemy stone with several escape cells — the maneuver that
				// pushes a stone into a gap to merge enemy groups lives here.
				const pushVariants = (bd0.stones[chosen] === enemy)
					? bd0._pushDestinations(chosen, color).slice(0, caps.push_dest)
					: [undefined];
				if (pushVariants.length === 0) pushVariants.push(undefined);
				for (const pushDest of pushVariants) {
					const bd = bd0.copy();
					const moveAct = bd._doMove(color, chosen, false, pushDest);
					if (!moveAct) continue;
					bd.update();
					const dashType = hasLightning ? 'dash_lightning' : 'dash';
					const dashActions = [
						new SimAction(dashType, { sacrificed: sacs.slice(), node: chosen }),
						moveAct,
					];
					out.push(new SimTurn(prefix.concat(dashActions, [new SimAction('pass')])));
					// Cast after dash
					let castable;
					try {
						castable = bd._getCastableSpells(color, false, canSummer, true);
					} catch (e) { castable = []; }
					for (const spellName of castable) {
						const overrides = _spellOverrides(bd, color, spellName, caps);
						for (const ovr of overrides) {
							const bs = bd.copy();
							let spellActions;
							try { spellActions = bs._castSpell(spellName, color, ovr); }
							catch (e) { continue; }
							bs.update();
							out.push(new SimTurn(
								prefix.concat(dashActions, spellActions, [new SimAction('pass')])
							));
						}
					}
				}
			}
		}
	}
}

/**
 * Yield the full set of CompleteTurn variants — like board.getLegalTurns()
 * but with Bewitch pair / Carnage hard-move target choices expanded.
 *
 * Returns an array (no generators in our JS port). Mid-game positions
 * with charged Bewitch typically grow from ~25 to ~30–45 variants.
 */
function getLegalTurnsExhaustive(board, color, caps) {
	caps = caps || ENUM_CAPS;
	board.update();
	// Turn-local crush tracking (for Blood Saplings) starts fresh each turn.
	board.crushedThisTurn = false;
	const enemy = board._enemy(color);

	// Competitive variant opening: blink to any empty node, no spells.
	// Mirrors the guard in board.getLegalTurns() and ai/enumerator.py;
	// without it, MinimaxAI's depth-1 enumeration sees zero moves
	// (board has no own stones to move from) and falls back to pass,
	// which causes hard/very_hard to forfeit their opening turn.
	if (variantHasCompetitive(board.variant) && board.turnCounter <= 2) {
		const out = [];
		for (const n of NODE_ORDER) {
			if (board.stones[n] !== null) continue;
			out.push(new SimTurn([
				new SimAction('blink', { node: n }),
				new SimAction('pass'),
			]));
		}
		return out;
	}

	const hasSeal = (board.chargedSpells[color] || []).includes('Seal_of_Wind');
	// Seal of Stone (enemy-held): this color's opening move must be soft.
	const enemyHasStone = (board.chargedSpells[enemy] || []).includes('Seal_of_Stone');
	let moveTargets;
	if (enemyHasStone) moveTargets = board._softMoveable(color);
	else if (hasSeal) moveTargets = board._blinkable(color);
	else moveTargets = board._allMoveable(color);
	if (!moveTargets.length) return [new SimTurn([new SimAction('pass')])];
	const out = [];
	for (const moveTarget of moveTargets) {
		// A move/blink onto an enemy stone pushes it; branch the landing
		// cell when several are legal so the search can aim the push.
		const pushVariants = (board.stones[moveTarget] === enemy)
			? board._pushDestinations(moveTarget, color).slice(0, caps.push_dest)
			: [undefined];
		if (pushVariants.length === 0) pushVariants.push(undefined);
		for (const pushDest of pushVariants) {
			const ba = board.copy();
			const isBlink = hasSeal && !ADJACENCY[moveTarget].some(nb => ba.stones[nb] === color);
			const moveAct = ba._doMove(color, moveTarget, isBlink, pushDest);
			if (!moveAct) continue;
			ba.update();
			_enumeratePostMoveExhaustive(ba, color, [moveAct], caps, true, true, true, out);
		}
	}
	return out;
}
