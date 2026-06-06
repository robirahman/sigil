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
			for (const pd of _pushDestFragments(board, color, ranked[i], caps)) {
				const ovr = { hard_move_targets: [ranked[i]] };
				if (pd) ovr.push_dests = pd;
				out.push(ovr);
			}
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
				for (const pd of _pushDestFragments(board, color, targets[j], caps)) {
					const ovr = { fury_sacrifice: own[i], hard_move_targets: [targets[j]] };
					if (pd) ovr.push_dests = pd;
					out.push(ovr);
				}
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
				for (const pd of _pushDestFragments(board, color, hardTargets[j], caps)) {
					const ovr = { soft_move_targets: [softTargets[i]], hard_move_targets: [hardTargets[j]] };
					if (pd) ovr.push_dests = pd;
					out.push(ovr);
				}
			}
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

// ---------------------------------------------------------------------------
// Complete (caps.__full) cast enumeration.
//
// The capped path above emits one override DICT per choice point, branching
// only the FIRST sub-action of multi-step spells. For Caveman we need EVERY
// resolution. Two wrinkles make this non-trivial:
//   1. Multi-step spells (Carnage's 3 pushes, Fury, soft+hard chains, …): each
//      step's legal options depend on the prior steps, so we recurse on board
//      copies, applying one sub-action at a time via the engine's own
//      primitives (_doHardMove / _doSoftMove / _pushEnemy).
//   2. Resolution runs on the POST-cast board (position cleared + refilled), so
//      sequences must be enumerated on `_postCastBoard`, not the pre-cast board,
//      or the recorded targets won't replay. The refill keep-subset is itself a
//      real choice (the "keep-B2" Carnage trap), so we branch it too.
// Each branch's recorded override is replayed by a real `_castSpell`, keeping
// resolution in one place (sim-board.js) as the single source of truth.

function _combosK(arr, k) {
	const out = [];
	const rec = (start, pick) => {
		if (pick.length === k) { out.push(pick.slice()); return; }
		for (let i = start; i < arr.length; i++) { pick.push(arr[i]); rec(i + 1, pick); pick.pop(); }
	};
	rec(0, []);
	return out;
}

// Per-cast sequence budget for the FULL multi-step enumerators. A high-count
// push spell (Carnage = 4 pushes) branched per-step over every target × push
// destination is combinatorial (targets^count), and that cost multiplies
// against the move/dash phases — uncapped it exhausts memory. This is the
// documented "practical bound": each cast yields at most this many resolution
// sequences, and because targets are visited in RANKED order (crushes /
// cluster attacks first) the bound keeps the strongest lines. It only bites on
// positions with many simultaneously-pushable enemies; ordinary positions stay
// exhaustive. `_lastSeqBudgetHit` records when it triggered (surfaced by the
// arena / tests).
const _FULL_SEQ_BUDGET = 64;
let _lastSeqBudgetHit = false;

// Hard ceiling on turns generated for a single node. Complete enumeration is
// exponential — a position with Carnage charged and many pushable enemies,
// crossed with the move/dash phases, can exceed half a million turns, which
// can't even be held in memory, let alone searched. This is the OOM/​hang
// backstop (the move phase is generated first, so the kept turns are the
// non-dash lines). It only triggers in spell-saturated positions; ordinary
// positions stay fully exhaustive. `_lastTurnCeilingHit` is surfaced by the
// arena / tests so a truncated node is never silently mistaken for complete.
const _MAX_TURNS_PER_NODE = 20000;
let _lastTurnCeilingHit = false;

// All length-`count` hard-move sequences from `board`: each step branches every
// target (ranked) × every push destination, bounded by `budget`. Returns
// [{hard_move_targets, push_dests, board}].
function _hardMoveSeqs(board, color, count, budget) {
	if (count <= 0 || board._hardMoveable(color).length === 0) {
		if (budget.left <= 0) { _lastSeqBudgetHit = true; return []; }
		budget.left--;
		return [{ hard_move_targets: [], push_dests: [], board }];
	}
	const targets = _rankHardMoveTargets(board, color, board._hardMoveable(color));
	const out = [];
	for (const t of targets) {
		if (budget.left <= 0) { _lastSeqBudgetHit = true; break; }
		const dests = board._pushDestinations(t, color);
		const destChoices = dests.length > 1 ? dests : [null];
		for (const d of destChoices) {
			if (budget.left <= 0) { _lastSeqBudgetHit = true; break; }
			const b2 = board.copy();
			b2._doHardMove(color, t, d == null ? undefined : d);
			b2.update();
			for (const rest of _hardMoveSeqs(b2, color, count - 1, budget)) {
				out.push({
					hard_move_targets: [t, ...rest.hard_move_targets],
					push_dests: [d, ...rest.push_dests],
					board: rest.board,
				});
			}
		}
	}
	return out;
}

// All length-`count` soft-move sequences (every empty target adjacent to own,
// including position nodes), bounded by `budget`. Returns [{soft_move_targets, board}].
function _softMoveSeqs(board, color, count, budget) {
	if (count <= 0 || board._softMoveable(color).length === 0) {
		if (budget.left <= 0) { _lastSeqBudgetHit = true; return []; }
		budget.left--;
		return [{ soft_move_targets: [], board }];
	}
	const targets = board._softMoveable(color);
	const out = [];
	for (const t of targets) {
		if (budget.left <= 0) { _lastSeqBudgetHit = true; break; }
		const b2 = board.copy();
		b2._doSoftMove(color, t);
		b2.update();
		for (const rest of _softMoveSeqs(b2, color, count - 1, budget)) {
			out.push({ soft_move_targets: [t, ...rest.soft_move_targets], board: rest.board });
		}
	}
	return out;
}

// All length-`count` enemy-push sequences for Moth Plague: each step branches
// every enemy stone × every push destination, bounded by `budget`.
function _mothSeqs(board, color, count, budget) {
	const enemy = board._enemy(color);
	const foes0 = NODE_ORDER.filter(n => board.stones[n] === enemy);
	if (count <= 0 || foes0.length === 0) {
		if (budget.left <= 0) { _lastSeqBudgetHit = true; return []; }
		budget.left--;
		return [{ moth_targets: [], push_dests: [], board }];
	}
	const out = [];
	for (const f of foes0) {
		if (budget.left <= 0) { _lastSeqBudgetHit = true; break; }
		const dests = board._pushDestinations(f, color);
		const destChoices = dests.length > 1 ? dests : [null];
		for (const d of destChoices) {
			if (budget.left <= 0) { _lastSeqBudgetHit = true; break; }
			const b2 = board.copy();
			b2._pushEnemy(f, color, d == null ? undefined : d);
			b2.update();
			for (const rest of _mothSeqs(b2, color, count - 1, budget)) {
				out.push({ moth_targets: [f, ...rest.moth_targets], push_dests: [d, ...rest.push_dests], board: rest.board });
			}
		}
	}
	return out;
}

// Refill keep-subset variants for a cast. Charm → [null] (no refill). Ritual →
// every size-`r` subset of the position nodes (r = mana-driven refill count).
function _refillKeepVariants(board, color, spellName) {
	const info = CORE_SPELLS[spellName];
	if (!info || info.ischarm) return [null];
	const idx = board.spellNames.indexOf(spellName);
	const posNodes = POSITIONS[idx + 1] || [];
	const r = board._refillCount(spellName, color);
	if (r <= 0) return [[]];
	if (r >= posNodes.length) return [posNodes.slice()];
	return _combosK(posNodes, r);
}

// Every resolve-only override for `spellName` on the post-cast board `bc`.
// Multi-step move spells get full sub-action sequences; everything else uses
// the (now-uncapped) single-step override list.
function _enumerateResolveOverrides(bc, color, spellName, caps) {
	const info = CORE_SPELLS[spellName];
	const rt = info ? info.resolve : null;
	if (rt === 'hard_moves') {
		return _hardMoveSeqs(bc, color, info.count || 1, { left: _FULL_SEQ_BUDGET })
			.map(s => ({ hard_move_targets: s.hard_move_targets, push_dests: s.push_dests }));
	}
	if (rt === 'stampede') {
		return _hardMoveSeqs(bc, color, Math.min(5, bc.spellCounter[color]), { left: _FULL_SEQ_BUDGET })
			.map(s => ({ hard_move_targets: s.hard_move_targets, push_dests: s.push_dests }));
	}
	if (rt === 'fury') {
		const own = NODE_ORDER.filter(n => bc.stones[n] === color);
		const budget = { left: _FULL_SEQ_BUDGET };
		const out = [];
		for (const sac of own) {
			if (budget.left <= 0) break;
			const b1 = bc.copy(); b1.stones[sac] = null; b1.update();
			for (const s of _hardMoveSeqs(b1, color, 3, budget)) {
				out.push({ fury_sacrifice: sac, hard_move_targets: s.hard_move_targets, push_dests: s.push_dests });
			}
		}
		return out.length ? out : [{}];
	}
	if (rt === 'soft_moves') {
		return _softMoveSeqs(bc, color, info.count || 1, { left: _FULL_SEQ_BUDGET })
			.map(s => ({ soft_move_targets: s.soft_move_targets }));
	}
	if (rt === 'soft_hard_chain') {
		const [softCount, hardCount] = info.counts;
		const budget = { left: _FULL_SEQ_BUDGET };
		const out = [];
		for (const ss of _softMoveSeqs(bc, color, softCount, budget)) {
			if (budget.left <= 0) break;
			for (const hs of _hardMoveSeqs(ss.board, color, hardCount, budget)) {
				out.push({
					soft_move_targets: ss.soft_move_targets,
					hard_move_targets: hs.hard_move_targets,
					push_dests: hs.push_dests,
				});
			}
		}
		return out.length ? out : [{}];
	}
	if (rt === 'moth_plague') {
		return _mothSeqs(bc, color, 3, { left: _FULL_SEQ_BUDGET })
			.map(s => ({ moth_targets: s.moth_targets, push_dests: s.push_dests }));
	}
	// Single-step (and the deterministic/forced/rare spells that aren't yet
	// sequence-enumerated — scatter, blossom, erupt, gust, syzygy, …): the
	// uncapped override list on the post-cast board. These have one or zero
	// real choices; gust's placement permutations are the documented bound.
	return _spellOverrides(bc, color, spellName, caps);
}

// All complete (actions, resultingBoard) outcomes of casting `spellName`.
// Capped mode keeps the cheap override path; full mode branches refill × resolve.
function _enumerateCast(board, color, spellName, caps) {
	const out = [];
	if (!caps || !caps.__full) {
		for (const ovr of _spellOverrides(board, color, spellName, caps)) {
			const bs = board.copy();
			let actions;
			try { actions = bs._castSpell(spellName, color, ovr); } catch (e) { continue; }
			bs.update();
			out.push({ actions, board: bs });
		}
		return out;
	}
	for (const keep of _refillKeepVariants(board, color, spellName)) {
		let bc;
		try { bc = board._postCastBoard(spellName, color, keep); } catch (e) { continue; }
		for (const rov of _enumerateResolveOverrides(bc, color, spellName, caps)) {
			const bs = board.copy();
			const ovr = (keep == null) ? rov : Object.assign({ refill_keep: keep }, rov);
			let actions;
			try { actions = bs._castSpell(spellName, color, ovr); } catch (e) { continue; }
			bs.update();
			out.push({ actions, board: bs });
		}
	}
	return out;
}

function _enumeratePostMoveExhaustive(board, color, prefix, caps, canDash, canSpell, canSummer, out) {
	if (out.length >= _MAX_TURNS_PER_NODE) { _lastTurnCeilingHit = true; return; }
	const enemy = board._enemy(color);
	out.push(new SimTurn(prefix.concat([new SimAction('pass')])));

	if (canSpell) {
		let castable;
		try {
			castable = board._getCastableSpells(color, canSpell, canSummer);
		} catch (e) { castable = []; }
		for (const spellName of castable) {
			if (out.length >= _MAX_TURNS_PER_NODE) { _lastTurnCeilingHit = true; break; }
			for (const { actions, board: bs } of _enumerateCast(board, color, spellName, caps)) {
				_enumeratePostMoveExhaustive(
					bs, color, prefix.concat(actions), caps,
					canDash, false, canSummer, out,
				);
				if (out.length >= _MAX_TURNS_PER_NODE) { _lastTurnCeilingHit = true; break; }
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
			if (out.length >= _MAX_TURNS_PER_NODE) { _lastTurnCeilingHit = true; break; }
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
						if (out.length >= _MAX_TURNS_PER_NODE) { _lastTurnCeilingHit = true; break; }
						for (const { actions } of _enumerateCast(bd, color, spellName, caps)) {
							out.push(new SimTurn(
								prefix.concat(dashActions, actions, [new SimAction('pass')])
							));
						}
					}
					if (out.length >= _MAX_TURNS_PER_NODE) { _lastTurnCeilingHit = true; break; }
				}
				if (out.length >= _MAX_TURNS_PER_NODE) { _lastTurnCeilingHit = true; break; }
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
	let moveTargets;
	if (hasSeal) moveTargets = board._blinkable(color);
	else moveTargets = board._allMoveable(color);
	if (!moveTargets.length) return [new SimTurn([new SimAction('pass')])];
	const out = [];
	if (caps && caps.__full) _lastTurnCeilingHit = false;
	for (const moveTarget of moveTargets) {
		if (out.length >= _MAX_TURNS_PER_NODE) { _lastTurnCeilingHit = true; break; }
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
