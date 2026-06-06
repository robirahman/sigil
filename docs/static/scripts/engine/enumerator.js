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
	bewitch: 8,
	starfall: 6,
	hard_moves: 6,
	meteor: 4,
	comet: 4,
	fireblast: 4,
	// Expansion-pack caps. Brute-force (no heuristic ordering) per user
	// direction; tune later.
	fury_sac: 6,
	fury_target: 4,
	charge: 6,
	storm_front: 12,
	hurricane: 4,
	soft_hard_soft: 4,
	soft_hard_hard: 4,
	gush: 6,
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
	const own = NODE_ORDER.filter(n => board.stones[n] === color);
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
		const ranked = _rankHardMoveTargets(board, color, board._hardMoveable(color));
		for (let i = 0; i < ranked.length && i < caps.hard_moves; i++) {
			out.push({ hard_move_targets: [ranked[i]] });
		}
	} else if (rt === 'meteor') {
		const targets = board._blinkable(color);
		for (let i = 0; i < targets.length && i < caps.meteor; i++) {
			out.push({ meteor_target: targets[i] });
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
	} else if (rt === 'fury') {
		// (sacrifice choice) × (first hard-move target). Subsequent two
		// hard moves resolve greedily in the sim. No ranking — user
		// explicitly deferred heuristics.
		const own = NODE_ORDER.filter(n => board.stones[n] === color);
		const targets = board._hardMoveable(color);
		const sacCap = Math.min(own.length, caps.fury_sac);
		const tgtCap = Math.min(targets.length, caps.fury_target);
		for (let i = 0; i < sacCap; i++) {
			for (let j = 0; j < tgtCap; j++) {
				out.push({ fury_sacrifice: own[i], hard_move_targets: [targets[j]] });
			}
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
				out.push({ soft_move_targets: [softTargets[i]], hard_move_targets: [hardTargets[j]] });
			}
		}
	} else if (rt === 'surge_move' && spellName === 'Gush') {
		// Gush enumerates each possible move destination. (Surge — the
		// other surge_move user — only runs post-dash and is currently
		// excluded by sim-board's _getCastableSpells, so this branch is
		// Gush-specific.)
		const targets = board._allMoveable(color);
		for (let i = 0; i < targets.length && i < caps.gush; i++) {
			out.push({ surge_target: targets[i] });
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
			out.push({ hard_move_targets: [ranked[i]] });
		}
	}
	// soft_moves, hail_storm, thunder, blossom, erupt: greedy is fine.
	// Thunder's pickup is forced and placement combinatorics blow up — defer
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
	if (canDash && canSpell && board.totalStones[color] > 2
	    && !(board.chargedSpells[enemy] || []).includes('Autumn')) {
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
				const bd = bd0.copy();
				const moveAct = bd._doMove(color, chosen, false);
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
	if (board.variant === 'competitive' && board.turnCounter <= 2) {
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
	let moveTargets;
	if (hasSeal) moveTargets = board._blinkable(color);
	else moveTargets = board._allMoveable(color);
	if (!moveTargets.length) return [new SimTurn([new SimAction('pass')])];
	const out = [];
	for (const moveTarget of moveTargets) {
		const ba = board.copy();
		const isBlink = hasSeal && !ADJACENCY[moveTarget].some(nb => ba.stones[nb] === color);
		const moveAct = ba._doMove(color, moveTarget, isBlink);
		if (!moveAct) continue;
		ba.update();
		_enumeratePostMoveExhaustive(ba, color, [moveAct], caps, true, true, true, out);
	}
	return out;
}
