/**
 * Browser-side exhaustive turn enumerator.
 *
 * Mirror of ai/enumerator.py with the same NARROW_CAPS — expand only
 * the high-impact choice points (Bewitch pair, Carnage/Slash hard-move
 * targets) so 3-ply minimax stays in budget. Other dash / spell
 * choices keep the engine's greedy default.
 */

const NARROW_ENUM_CAPS = {
	dash_sac: 1,
	dash_move: 1,
	bewitch: 6,
	starfall: 1,
	hard_moves: 3,
	meteor: 1,
	comet: 1,
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
	} else if (rt === 'hard_moves') {
		const targets = board._hardMoveable(color);
		for (let i = 0; i < targets.length && i < caps.hard_moves; i++) {
			out.push({ hard_move_targets: [targets[i]] });
		}
	}
	// Other spells: keep greedy (NARROW_CAPS would cap them at 1 anyway).
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

	// Dash: greedy in NARROW mode (cap=1), so we mirror the existing engine.
	if (canDash && canSpell && board.totalStones[color] > 2
	    && !(board.chargedSpells[enemy] || []).includes('Autumn')) {
		const own = NODE_ORDER.filter(n => board.stones[n] === color);
		const hasLightning = (board.chargedSpells[color] || []).includes('Seal_of_Lightning');
		// Single greedy variant per cap=1.
		const sacs = hasLightning
			? [own[own.length - 1]].filter(Boolean)
			: own.slice(-2);
		if (sacs.length === (hasLightning ? 1 : 2)) {
			const bd = board.copy();
			for (const s of sacs) bd.stones[s] = null;
			bd.update();
			const targets = bd._allMoveable(color);
			if (targets.length) {
				const chosen = targets[0];
				const moveAct = bd._doMove(color, chosen, false);
				if (moveAct) {
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
						castable = bd._getCastableSpells(color, false, canSummer);
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
	caps = caps || NARROW_ENUM_CAPS;
	board.update();
	const enemy = board._enemy(color);
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
