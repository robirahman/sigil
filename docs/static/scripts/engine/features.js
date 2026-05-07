/**
 * Feature extraction for SigilNet inference in the browser.
 * Ported from ai/features.py — must produce identical output dim-for-dim
 * or the deployed model receives garbage. The cross-check at the end of
 * ai/test_feature_parity.py validates this on every commit.
 */

const SPELL_TO_ID = {
	Flourish: 0, Carnage: 1, Bewitch: 2, Starfall: 3,
	Seal_of_Lightning: 4, Grow: 5, Fireblast: 6, Hail_Storm: 7,
	Meteor: 8, Seal_of_Wind: 9, Sprout: 10, Slash: 11,
	Surge: 12, Comet: 13, Seal_of_Summer: 14,
};

const _NODE_TO_IDX = {};
NODE_ORDER.forEach((n, i) => _NODE_TO_IDX[n] = i);

const _NEIGHBOR_INDICES = NODE_ORDER.map(name =>
	(ADJACENCY[name] || []).map(nb => _NODE_TO_IDX[nb])
);

const _SPELL_POSITION_NODES = [];
for (let i = 0; i < 9; i++) _SPELL_POSITION_NODES.push(POSITIONS[i + 1] || []);

const NUM_NODES = 39;
const NUM_SPELL_SLOTS = 9;
const ESCAPE_MAX = 6;
// Match ai/config.py — 250 base + 156 life + 18 fill + 18 threat + 8 tempo = 450
const RAW_FEATURE_DIM = 450;
// Per-turn encoding: 64 base + 16 tactical (v22) + 4 lookahead (v27) = 84
const TURN_FEATURE_DIM = 84;

/**
 * Per-stone life-status block: 4 channels × 39 = 156 dims.
 * Channels: own_escape, enemy_escape, own_crushable_now, enemy_crushable_now.
 */
function _lifeStatusFeatures(board, sideToMove, enemy) {
	const ownEscape = new Float32Array(NUM_NODES);
	const enemyEscape = new Float32Array(NUM_NODES);
	const ownCrush = new Float32Array(NUM_NODES);
	const enemyCrush = new Float32Array(NUM_NODES);
	for (let i = 0; i < NUM_NODES; i++) {
		const name = NODE_ORDER[i];
		const s = board.stones[name];
		if (s === sideToMove) {
			const d = board.escapeDistance(name, sideToMove, ESCAPE_MAX);
			ownEscape[i] = d / ESCAPE_MAX;
			let hasAttacker = false;
			for (const nb of (ADJACENCY[name] || [])) {
				if (board.stones[nb] === enemy) { hasAttacker = true; break; }
			}
			if (hasAttacker && board.isCrushable(name, enemy)) ownCrush[i] = 1.0;
		} else if (s === enemy) {
			const d = board.escapeDistance(name, enemy, ESCAPE_MAX);
			enemyEscape[i] = d / ESCAPE_MAX;
			let hasOurs = false;
			for (const nb of (ADJACENCY[name] || [])) {
				if (board.stones[nb] === sideToMove) { hasOurs = true; break; }
			}
			if (hasOurs && board.isCrushable(name, sideToMove)) enemyCrush[i] = 1.0;
		}
	}
	return { ownEscape, enemyEscape, ownCrush, enemyCrush };
}

function _spellFillFeatures(board, sideToMove, enemy) {
	const own = new Float32Array(NUM_SPELL_SLOTS);
	const enm = new Float32Array(NUM_SPELL_SLOTS);
	for (let i = 0; i < NUM_SPELL_SLOTS; i++) {
		const nodes = _SPELL_POSITION_NODES[i];
		if (!nodes || !nodes.length) continue;
		let nOwn = 0, nEnm = 0;
		for (const n of nodes) {
			if (board.stones[n] === sideToMove) nOwn++;
			else if (board.stones[n] === enemy) nEnm++;
		}
		own[i] = nOwn / nodes.length;
		enm[i] = nEnm / nodes.length;
	}
	return { own, enm };
}

function _netStoneDeltaIfCast(board, spellName, color) {
	const enemy = color === 'red' ? 'blue' : 'red';
	const ownBefore = board.totalStones[color];
	const enmBefore = board.totalStones[enemy];
	let sim;
	try {
		sim = board.copy();
		sim._castSpell(spellName, color);
		sim.update();
	} catch (e) {
		return 0.0;
	}
	const ownAfter = sim.totalStones[color];
	const enmAfter = sim.totalStones[enemy];
	return ((ownAfter - ownBefore) - (enmAfter - enmBefore)) / NUM_NODES;
}

function _threatOfActivationFeatures(board, sideToMove, enemy) {
	const own = new Float32Array(NUM_SPELL_SLOTS);
	const enm = new Float32Array(NUM_SPELL_SLOTS);
	const ownCharged = new Set(board.chargedSpells[sideToMove] || []);
	const enmCharged = new Set(board.chargedSpells[enemy] || []);
	for (let i = 0; i < NUM_SPELL_SLOTS; i++) {
		const sn = board.spellNames[i];
		if (ownCharged.has(sn)) own[i] = _netStoneDeltaIfCast(board, sn, sideToMove);
		if (enmCharged.has(sn)) enm[i] = _netStoneDeltaIfCast(board, sn, enemy);
	}
	return { own, enm };
}

function _tempoScalarFeatures(board, sideToMove, enemy,
                              ownEscape, enemyEscape, ownFill, enmFill,
                              ownThreat, enmThreat) {
	let ownCanCast = 0, enmCanCast = 0;
	let ownEscapeSum = 0, enemyEscapeSum = 0;
	let ownThreatMax = 0, enmThreatMax = 0;
	let raceAhead = 0;
	for (let i = 0; i < NUM_SPELL_SLOTS; i++) {
		if (ownFill[i] >= 0.999) ownCanCast++;
		if (enmFill[i] >= 0.999) enmCanCast++;
		if (ownThreat[i] > ownThreatMax) ownThreatMax = ownThreat[i];
		if (enmThreat[i] > enmThreatMax) enmThreatMax = enmThreat[i];
		if (ownFill[i] > enmFill[i]) raceAhead++;
	}
	for (let i = 0; i < NUM_NODES; i++) {
		ownEscapeSum += ownEscape[i];
		enemyEscapeSum += enemyEscape[i];
	}
	return new Float32Array([
		ownCanCast / NUM_SPELL_SLOTS,
		enmCanCast / NUM_SPELL_SLOTS,
		(board.mana[sideToMove] - board.mana[enemy]) / 3.0,
		ownEscapeSum / NUM_NODES,
		enemyEscapeSum / NUM_NODES,
		ownThreatMax,
		enmThreatMax,
		raceAhead / NUM_SPELL_SLOTS,
	]);
}

/**
 * Convert a SimBoard to raw feature array + spell ID array.
 * Returns { raw: Float32Array(450), spellIds: Int32Array(9) }
 */
function boardToTensor(board, sideToMove) {
	if (!sideToMove) sideToMove = board.whoseTurn;
	const enemy = sideToMove === 'red' ? 'blue' : 'red';
	const features = new Float32Array(RAW_FEATURE_DIM);
	let fi = 0;

	// Stone placement: 39 x 3 one-hot = 117
	const stonesOwn = new Float32Array(NUM_NODES);
	const stonesEnemy = new Float32Array(NUM_NODES);
	for (let i = 0; i < NUM_NODES; i++) {
		const s = board.stones[NODE_ORDER[i]];
		if (s === sideToMove) stonesOwn[i] = 1;
		else if (s === enemy) stonesEnemy[i] = 1;
		else features[fi + NUM_NODES * 2 + i] = 1; // empty
	}
	features.set(stonesOwn, fi); fi += NUM_NODES;
	features.set(stonesEnemy, fi); fi += NUM_NODES;
	fi += NUM_NODES; // empty already set

	// Neighborhood features: 39 x 2 = 78
	for (let i = 0; i < NUM_NODES; i++) {
		const nbs = _NEIGHBOR_INDICES[i];
		const nNbs = nbs.length || 1;
		let ownFrac = 0, enemyFrac = 0;
		for (const j of nbs) {
			ownFrac += stonesOwn[j];
			enemyFrac += stonesEnemy[j];
		}
		features[fi++] = ownFrac / nNbs;
		features[fi++] = enemyFrac / nNbs;
	}

	// Spell charges: 9 x 3 = 27
	for (let i = 0; i < NUM_SPELL_SLOTS; i++) {
		const sn = board.spellNames[i];
		const oc = board.chargedSpells[sideToMove].includes(sn);
		const ec = board.chargedSpells[enemy].includes(sn);
		features[fi++] = oc ? 1 : 0;
		features[fi++] = ec ? 1 : 0;
		features[fi++] = (!oc && !ec) ? 1 : 0;
	}

	// Mana: 3
	for (const mn of MANA_NODES) {
		const s = board.stones[mn];
		features[fi++] = s === sideToMove ? 1 : (s === enemy ? -1 : 0);
	}

	// Spell counters: 2
	features[fi++] = board.spellCounter[sideToMove] / 6.0;
	features[fi++] = board.spellCounter[enemy] / 6.0;

	// Lock status: 9 x 2 = 18
	const ownLock = board.lock[sideToMove];
	const enemyLock = board.lock[enemy];
	for (let i = 0; i < NUM_SPELL_SLOTS; i++) {
		const sn = board.spellNames[i];
		features[fi++] = (ownLock === sn) ? 1 : 0;
		features[fi++] = (enemyLock === sn) ? 1 : 0;
	}

	// Stone differential: 1
	const ownStones = board.totalStones[sideToMove];
	const enemyStones = board.totalStones[enemy];
	features[fi++] = (ownStones - enemyStones) / 39.0;

	// Total stone counts: 2
	features[fi++] = ownStones / 39.0;
	features[fi++] = enemyStones / 39.0;

	// Turn progress: 2
	features[fi++] = board.turnCounter / 200.0;
	features[fi++] = board.turnCounter > 100 ? 1 : 0;

	// === Tactical blocks (v22 onward) ===
	// Life-status: 4 x 39 = 156
	const life = _lifeStatusFeatures(board, sideToMove, enemy);
	for (let i = 0; i < NUM_NODES; i++) features[fi++] = life.ownEscape[i];
	for (let i = 0; i < NUM_NODES; i++) features[fi++] = life.enemyEscape[i];
	for (let i = 0; i < NUM_NODES; i++) features[fi++] = life.ownCrush[i];
	for (let i = 0; i < NUM_NODES; i++) features[fi++] = life.enemyCrush[i];

	// Spell-position fill: 9 x 2 = 18
	const fill = _spellFillFeatures(board, sideToMove, enemy);
	for (let i = 0; i < NUM_SPELL_SLOTS; i++) features[fi++] = fill.own[i];
	for (let i = 0; i < NUM_SPELL_SLOTS; i++) features[fi++] = fill.enm[i];

	// Threat-of-activation: 9 x 2 = 18
	const threat = _threatOfActivationFeatures(board, sideToMove, enemy);
	for (let i = 0; i < NUM_SPELL_SLOTS; i++) features[fi++] = threat.own[i];
	for (let i = 0; i < NUM_SPELL_SLOTS; i++) features[fi++] = threat.enm[i];

	// Tempo scalars: 8
	const tempo = _tempoScalarFeatures(
		board, sideToMove, enemy,
		life.ownEscape, life.enemyEscape, fill.own, fill.enm,
		threat.own, threat.enm,
	);
	for (let i = 0; i < tempo.length; i++) features[fi++] = tempo[i];

	// Spell IDs
	const spellIds = new Int32Array(NUM_SPELL_SLOTS);
	for (let i = 0; i < NUM_SPELL_SLOTS; i++) {
		spellIds[i] = SPELL_TO_ID[board.spellNames[i]] || 0;
	}

	return { raw: features, spellIds };
}

/**
 * Count mana-pair chains owned by `color`. Mirror of ai/features.py:_chain_count.
 * A chain is a path of `color` stones (including any of {a1,b1,c1} when held
 * by `color`) connecting two distinct mana nodes via ADJACENCY.
 */
function _chainCount(board, color) {
	const visited = new Set();
	const components = [];
	for (const n of NODE_ORDER) {
		if (visited.has(n) || board.stones[n] !== color) continue;
		const comp = new Set();
		const stack = [n];
		while (stack.length) {
			const cur = stack.pop();
			if (comp.has(cur)) continue;
			comp.add(cur);
			for (const nb of (ADJACENCY[cur] || [])) {
				if (!comp.has(nb) && board.stones[nb] === color) stack.push(nb);
			}
		}
		for (const x of comp) visited.add(x);
		components.push(comp);
	}
	const pairs = [['a1', 'b1'], ['a1', 'c1'], ['b1', 'c1']];
	let chains = 0;
	for (const [x, y] of pairs) {
		for (const comp of components) {
			if (comp.has(x) && comp.has(y)) { chains++; break; }
		}
	}
	return chains;
}

function _countCrushable(board, defender, attacker) {
	let n = 0;
	for (let i = 0; i < NUM_NODES; i++) {
		const name = NODE_ORDER[i];
		if (board.stones[name] !== defender) continue;
		let hasAttacker = false;
		for (const nb of (ADJACENCY[name] || [])) {
			if (board.stones[nb] === attacker) { hasAttacker = true; break; }
		}
		if (hasAttacker && board.isCrushable(name, attacker)) n++;
	}
	return n;
}

function _simulateTurn(board, turn, color) {
	try {
		const sim = board.copy();
		applySimTurn(sim, turn, color);
		sim.update();
		return sim;
	} catch (e) {
		return null;
	}
}

function _hasCastableSpell(board, color) {
	for (let i = 0; i < NUM_SPELL_SLOTS; i++) {
		const sn = board.spellNames[i];
		const info = CORE_SPELLS[sn];
		if (!info || info.static || info.ischarm) continue;
		const nodes = _SPELL_POSITION_NODES[i];
		if (!nodes || !nodes.length) continue;
		let allOwn = true;
		for (const n of nodes) {
			if (board.stones[n] !== color) { allOwn = false; break; }
		}
		if (allOwn) return true;
	}
	return false;
}

function _maxThreatOfActivation(board, color, enemy) {
	const t = _threatOfActivationFeatures(board, color, enemy);
	let m = 0;
	for (let i = 0; i < t.own.length; i++) if (t.own[i] > m) m = t.own[i];
	let n = 0;
	for (let i = 0; i < t.enm.length; i++) if (t.enm[i] > n) n = t.enm[i];
	return { ownMax: m, enmMax: n };
}

/**
 * Encode a SimTurn as a fixed-size feature vector.
 * Returns Float32Array(84). Layout matches ai/features.py:encode_turn.
 */
function encodeTurn(turn, board, color) {
	const enemy = color === 'red' ? 'blue' : 'red';
	const features = new Float32Array(TURN_FEATURE_DIM);
	let moveTarget = null;
	let softCount = 0, hardCount = 0;
	let spellPosDelta = 0;
	let claimedMana = false;

	const crushableOwnBefore = _countCrushable(board, color, enemy);
	const crushableEnmBefore = _countCrushable(board, enemy, color);
	const preThreats = _maxThreatOfActivation(board, color, enemy);
	const preEnemyChains = _chainCount(board, enemy);
	const simAfter = _simulateTurn(board, turn, color);

	for (const action of turn.actions) {
		if (action.type === 'move' && action.node) {
			const idx = _NODE_TO_IDX[action.node];
			if (idx !== undefined && moveTarget === null) {
				features[idx] = 1;
				moveTarget = action.node;
			}
			features[59] += 1.0 / 39.0;
			softCount++;
			if (MANA_NODES.includes(action.node) && board.stones[action.node] === null) {
				claimedMana = true;
			}
			for (let sp = 0; sp < NUM_SPELL_SLOTS; sp++) {
				const nodes = _SPELL_POSITION_NODES[sp];
				if (nodes && nodes.includes(action.node)) { spellPosDelta++; break; }
			}
		} else if (action.type === 'hard_move' && action.node) {
			const idx = _NODE_TO_IDX[action.node];
			if (idx !== undefined && moveTarget === null) {
				features[idx] = 1;
				moveTarget = action.node;
			}
			features[39] = 1;
			hardCount++;
		} else if (action.type === 'blink' && action.node) {
			const idx = _NODE_TO_IDX[action.node];
			if (idx !== undefined && moveTarget === null) {
				features[idx] = 1;
				moveTarget = action.node;
			}
			features[40] = 1;
			if (board.stones[action.node] !== enemy) features[59] += 1.0 / 39.0;
		} else if (action.type === 'dash' || action.type === 'dash_lightning') {
			features[41] = 1;
			const sacCount = action.sacrificed ? action.sacrificed.length : 0;
			features[59] -= sacCount / 39.0;
			features[66] = 1;
		} else if (action.type === 'cast') {
			features[42] = 1;
			const spellId = SPELL_TO_ID[action.spell] || 0;
			features[43 + spellId] = 1;
		}
	}

	features[58] = turn.actions.length / 5.0;
	if (turn.actions.length === 1 && turn.actions[0].type === 'pass') features[60] = 1;

	if (simAfter !== null) {
		const ownBefore = board.totalStones[color];
		const ownAfter = simAfter.totalStones[color];
		const enmBefore = board.totalStones[enemy];
		const enmAfter = simAfter.totalStones[enemy];
		const enemyCrushed = Math.max(0, enmBefore - enmAfter);
		const ownLost = Math.max(0, ownBefore - ownAfter);
		features[64] = Math.min(enemyCrushed, 3) / 3.0;
		features[65] = Math.min(ownLost, 3) / 3.0;
		if (features[41] > 0) {
			features[67] = (enemyCrushed >= 1 || claimedMana) ? 1.0 : 0.0;
		}
		const crushableOwnAfter = _countCrushable(simAfter, color, enemy);
		const crushableEnmAfter = _countCrushable(simAfter, enemy, color);
		const newThreats = Math.max(0, crushableOwnAfter - crushableOwnBefore);
		const clearedThreats = Math.max(0, crushableEnmBefore - crushableEnmAfter);
		features[68] = Math.min(newThreats, 3) / 3.0;
		features[69] = Math.min(clearedThreats, 3) / 3.0;
		features[70] = _hasCastableSpell(simAfter, color) ? 1.0 : 0.0;

		// --- v27: per-turn lookahead features (75–78) ---
		const net = (ownAfter - ownBefore) - (enmAfter - enmBefore);
		features[75] = Math.max(-3, Math.min(3, net)) / 3.0;

		const postThreats = _maxThreatOfActivation(simAfter, color, enemy);
		const enemyGrowth = Math.max(0.0, postThreats.enmMax - preThreats.enmMax);
		const ownGrowth = Math.max(0.0, postThreats.ownMax - preThreats.ownMax);
		features[76] = Math.min(enemyGrowth, 1.0);
		features[77] = Math.min(ownGrowth, 1.0);

		const postEnemyChains = _chainCount(simAfter, enemy);
		const chainsBroken = Math.max(0, preEnemyChains - postEnemyChains);
		features[78] = Math.min(chainsBroken, 3) / 3.0;
	}

	features[71] = claimedMana ? 1.0 : 0.0;
	features[72] = Math.min(softCount, 3) / 3.0;
	features[73] = Math.min(hardCount, 3) / 3.0;
	features[74] = Math.min(Math.max(spellPosDelta, -3), 3) / 3.0;

	// v28: tempo-waste flag for re-filling our own locked spell.
	const ownLock = board.lock[color];
	if (ownLock !== null && ownLock !== undefined && simAfter !== null) {
		const lockIdx = board.spellNames.indexOf(ownLock);
		const lockNodes = lockIdx >= 0 ? _SPELL_POSITION_NODES[lockIdx] : null;
		if (lockNodes && lockNodes.length) {
			let wasted = 0;
			for (const n of lockNodes) {
				if (simAfter.stones[n] === color && board.stones[n] !== color) {
					wasted++;
				}
			}
			features[79] = Math.min(wasted, 3) / 3.0;
		}
	}

	return features;
}

/**
 * Encode all legal turns into a 2D array.
 * Returns Float32Array(N * TURN_FEATURE_DIM) with N rows.
 */
function encodeAllTurns(turns, board, color) {
	const N = turns.length;
	const result = new Float32Array(N * TURN_FEATURE_DIM);
	for (let i = 0; i < N; i++) {
		const enc = encodeTurn(turns[i], board, color);
		result.set(enc, i * TURN_FEATURE_DIM);
	}
	return result;
}
