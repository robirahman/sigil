/**
 * Feature extraction for SigilNet inference in the browser.
 * Ported from ai/features.py — must produce identical output dim-for-dim
 * or the deployed model receives garbage. The cross-check at the end of
 * ai/test_feature_parity.py validates this on every commit.
 */

// Must mirror ai/config.py:SPELL_TO_ID exactly (every non-Panda spell).
// IDs 0-14 are fixed for backward-compatible checkpoint warm-starts.
const SPELL_TO_ID = {
	// Core
	Flourish: 0, Carnage: 1, Bewitch: 2, Starfall: 3,
	Seal_of_Lightning: 4, Grow: 5, Fireblast: 6, Hail_Storm: 7,
	Meteor: 8, Seal_of_Wind: 9, Sprout: 10, Slash: 11,
	Surge: 12, Comet: 13, Seal_of_Summer: 14,
	// Springtime
	Blossom: 15, Scatter: 16, Seal_of_Spring: 17,
	// Celestial
	Syzygy: 18, Eclipse: 19, Azimuth: 20,
	// Inferno
	Erupt: 21, Fury: 22, Charge: 23,
	// Tempest
	Hurricane: 24, Storm_Front: 25, Gust: 26,
	// Flood pack (Tsunami keeps id 27 from its pre-swap name "Flood" —
	// the id is an embedding index baked into every trained checkpoint)
	Tsunami: 27, Torrent: 28, Splash: 29,
	// Autumn
	Harvest: 30, Gather: 31, Seal_of_Autumn: 32,
	// Gloom
	Corrupt: 33, Decay: 34, Lurk: 35,
	// Covenant
	Seal_of_Destruction: 36, Seal_of_Stone: 37, Seal_of_Winter: 38,
	// Tectonic
	Fissure: 39, Rock_Slide: 40, Bulwark: 41,
	// Providence
	Dividend: 42, Annuity: 43, Endowment: 44,
	// Aftershock
	Ember: 45, Smolder: 46, Conflagration: 47,
	// Ambush
	Tripwire: 48, Deadfall: 49, Minefield: 50,
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
// Match ai/config.py — 250 base + 156 life + 18 fill + 18 threat
//                      + 6 mana_pressure + 8 tempo = 456
// 456 legacy features + 39 destroyed-node channel + 10 Providence pending
// dims + 10 Aftershock pending-burn dims + 78 Ambush snare channels (each
// block appended last in turn). Must equal ai/config.py:RAW_FEATURE_DIM.
const RAW_FEATURE_DIM = 593;
// Fixed offsets of the appended blocks — NOT relative to RAW_FEATURE_DIM,
// which keeps growing.
const _DESTROYED_CHANNEL_OFFSET = 456;
const _PENDING_BLOCK_OFFSET = 495;
const _BURN_BLOCK_OFFSET = 505;
const _SNARE_BLOCK_OFFSET = 515;
// BFS-distance ceiling used to normalize the mana-pressure block; matches
// _DISTANCE_NORM in ai/features.py.
const MANA_DISTANCE_NORM = 8;
// Per-turn encoding: 64 base + 16 tactical (v22) + 4 lookahead (v27)
// + 30 expansion-spell one-hot at [84:114] + 2 Providence scalars
// + 6 Aftershock/Ambush one-hot at [116:122] (IDs 45-50) + 2 pack scalars
// ([122] burns resolved /4, [123] snares placed /4) = 124.
// Must mirror ai/config.py:TURN_FEATURE_DIM.
const TURN_FEATURE_DIM = 124;

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

function _bfsDistance(sources, target) {
	// Shortest hop count from any node in `sources` to `target` over the
	// adjacency graph. Returns 0 if target is in sources, the number of
	// hops if reachable, or null if unreachable. Mirrors
	// ai/features.py:_bfs_distance.
	if (!sources || sources.size === 0) return null;
	if (sources.has(target)) return 0;
	const seen = new Set(sources);
	let frontier = Array.from(sources);
	let dist = 0;
	while (frontier.length) {
		dist++;
		const next = [];
		for (const node of frontier) {
			for (const nb of (ADJACENCY[node] || [])) {
				if (seen.has(nb)) continue;
				if (nb === target) return dist;
				seen.add(nb);
				next.push(nb);
			}
		}
		frontier = next;
	}
	return null;
}

function _mapControlDistances(stones, color) {
	// Multi-source BFS hop distances from all of `color`'s stones over the
	// adjacency graph. DESTROYED nodes are impassable (never enqueued);
	// stones of either color are passable. Returns {node: hops}; nodes
	// absent from the result are unreachable. Mirrors
	// ai/features.py:_map_control_distances.
	const dist = {};
	let frontier = [];
	for (const n of NODE_ORDER) {
		if (stones[n] === color) {
			dist[n] = 0;
			frontier.push(n);
		}
	}
	let d = 0;
	while (frontier.length) {
		d++;
		const next = [];
		for (const node of frontier) {
			for (const nb of ADJACENCY[node]) {
				if (nb in dist || stones[nb] === DESTROYED) continue;
				dist[nb] = d;
				next.push(nb);
			}
		}
		frontier = next;
	}
	return dist;
}

function mapControl(stones) {
	// Map control: how many nodes each side's stones are strictly closer
	// to. `stones` is any node -> 'red'|'blue'|null|DESTROYED map
	// (SigilBoard.stones, SimBoard.stones, or sfnToDict(...).stones —
	// values other than 'red'/'blue'/DESTROYED are treated as empty).
	// Destroyed nodes are impassable AND excluded from the tally, so
	// red + blue + contested = 39 - #destroyed. Equal distance — including
	// both-unreachable — counts as contested. diff = red - blue (red POV);
	// side-relative is (color === 'red' ? diff : -diff) at the call site.
	// The standard opening (red a1, blue b1) is 17/18/4, diff -1: the
	// board has rotational but not mirror symmetry, so the -1 is a real
	// property of the map, not a bug. Mirrors ai/features.py:map_control.
	const dr = _mapControlDistances(stones, 'red');
	const db = _mapControlDistances(stones, 'blue');
	let red = 0, blue = 0, contested = 0;
	for (const n of NODE_ORDER) {
		if (stones[n] === DESTROYED) continue;
		const a = (n in dr) ? dr[n] : Infinity;
		const b = (n in db) ? db[n] : Infinity;
		if (a < b) red++;
		else if (b < a) blue++;
		else contested++;
	}
	return { red, blue, contested, diff: red - blue };
}

// --- Fast map-control diff for the AI leaf eval -------------------------
// Exact-equal to mapControl(stones).diff, but int-indexed with
// module-level preallocated scratch (no per-call allocation). Safe
// because each JS realm (page, worker, arena worker_thread) is
// single-threaded and the leaf eval is not reentrant. Max hop distance
// on the 39-node board is 10, so Int8 with a 127 sentinel is ample.
const _MC_N = NODE_ORDER.length;
const _MC_ADJ = NODE_ORDER.map(n => ADJACENCY[n].map(m => NODE_ORDER.indexOf(m)));
const _MC_UNREACHED = 127;
const _MC_DR = new Int8Array(_MC_N);
const _MC_DB = new Int8Array(_MC_N);
const _MC_QUEUE = new Int8Array(_MC_N);

function _mcBfsFast(stones, color, dist) {
	dist.fill(_MC_UNREACHED);
	let head = 0, tail = 0;
	for (let i = 0; i < _MC_N; i++) {
		if (stones[NODE_ORDER[i]] === color) { dist[i] = 0; _MC_QUEUE[tail++] = i; }
	}
	while (head < tail) {
		const u = _MC_QUEUE[head++], du = dist[u] + 1, adj = _MC_ADJ[u];
		for (let a = 0; a < adj.length; a++) {
			const v = adj[a];
			if (dist[v] !== _MC_UNREACHED) continue;
			if (stones[NODE_ORDER[v]] === DESTROYED) continue;
			dist[v] = du; _MC_QUEUE[tail++] = v;
		}
	}
}

function mapControlDiff(stones) {
	_mcBfsFast(stones, 'red', _MC_DR);
	_mcBfsFast(stones, 'blue', _MC_DB);
	let diff = 0;
	for (let i = 0; i < _MC_N; i++) {
		if (stones[NODE_ORDER[i]] === DESTROYED) continue;
		const a = _MC_DR[i], b = _MC_DB[i];
		if (a < b) diff++; else if (b < a) diff--;
	}
	return diff;
}

function _manaPressureFeatures(board, sideToMove, enemy) {
	// 6-dim block: own and enemy adjacency-graph distance to each of the
	// three mana nodes (a1, b1, c1), normalized by MANA_DISTANCE_NORM.
	// Mirrors ai/features.py:_mana_pressure_features. Side with no stones
	// (or no path) contributes 1.0 (max pressure / impossible to claim).
	const ownStones = new Set();
	const enemyStones = new Set();
	for (const n of NODE_ORDER) {
		const s = board.stones[n];
		if (s === sideToMove) ownStones.add(n);
		else if (s === enemy) enemyStones.add(n);
	}
	const feats = new Float32Array(6);
	for (let i = 0; i < MANA_NODES.length; i++) {
		const mn = MANA_NODES[i];
		const ownD = _bfsDistance(ownStones, mn);
		const enmD = _bfsDistance(enemyStones, mn);
		feats[2 * i]     = ownD === null ? 1.0 : Math.min(ownD, MANA_DISTANCE_NORM) / MANA_DISTANCE_NORM;
		feats[2 * i + 1] = enmD === null ? 1.0 : Math.min(enmD, MANA_DISTANCE_NORM) / MANA_DISTANCE_NORM;
	}
	return feats;
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

	// Stone placement: 39 x 3 one-hot = 117. A 4th "destroyed" channel is
	// computed here but written into the LAST 39 slots (appended) so the
	// legacy column layout is preserved for warm-start migration.
	const stonesOwn = new Float32Array(NUM_NODES);
	const stonesEnemy = new Float32Array(NUM_NODES);
	const stonesDestroyed = new Float32Array(NUM_NODES);
	for (let i = 0; i < NUM_NODES; i++) {
		const s = board.stones[NODE_ORDER[i]];
		if (s === sideToMove) stonesOwn[i] = 1;
		else if (s === enemy) stonesEnemy[i] = 1;
		else if (s === null) features[fi + NUM_NODES * 2 + i] = 1; // empty
		else stonesDestroyed[i] = 1; // permanently destroyed node (wall)
	}
	features.set(stonesDestroyed, _DESTROYED_CHANNEL_OFFSET); // appended block
	features.set(stonesOwn, fi); fi += NUM_NODES;
	features.set(stonesEnemy, fi); fi += NUM_NODES;
	fi += NUM_NODES; // empty already set

	// Providence pending-move block (appended, mirrors ai/features.py):
	// own/enemy schedule slots 0-3 (min(x,3)/3), then own/enemy extras
	// granted this turn but not yet used.
	{
		let pi = _PENDING_BLOCK_OFFSET;
		for (const side of [sideToMove, enemy]) {
			const sched = (board.pendingMoves && board.pendingMoves[side]) || [];
			for (let i = 0; i < 4; i++) {
				features[pi++] = Math.min(i < sched.length ? sched[i] : 0, 3) / 3.0;
			}
		}
		const extra = Math.min(board.extraMovesThisTurn || 0, 3) / 3.0;
		features[pi++] = board.whoseTurn === sideToMove ? extra : 0.0;
		features[pi++] = board.whoseTurn === enemy ? extra : 0.0;
	}

	// Aftershock pending-burn block (appended, mirrors ai/features.py):
	// own/enemy burn-schedule slots 0-3 (min(x,3)/3), then own/enemy burns
	// granted this turn but not yet resolved.
	{
		let bi = _BURN_BLOCK_OFFSET;
		for (const side of [sideToMove, enemy]) {
			const sched = (board.pendingBurns && board.pendingBurns[side]) || [];
			for (let i = 0; i < 4; i++) {
				features[bi++] = Math.min(i < sched.length ? sched[i] : 0, 3) / 3.0;
			}
		}
		const bnow = Math.min(board.burnsThisTurn || 0, 3) / 3.0;
		features[bi++] = board.whoseTurn === sideToMove ? bnow : 0.0;
		features[bi++] = board.whoseTurn === enemy ? bnow : 0.0;
	}

	// Ambush snare channels (appended, mirrors ai/features.py): own snares
	// then enemy snares, 1.0 per snared node from the side to move's view.
	{
		let si = _SNARE_BLOCK_OFFSET;
		const snares = board.snares || {};
		for (const side of [sideToMove, enemy]) {
			for (let i = 0; i < NUM_NODES; i++) {
				features[si++] = snares[NODE_ORDER[i]] === side ? 1.0 : 0.0;
			}
		}
	}

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

	// Mana-pressure: 6 (own + enemy distance to each of 3 mana nodes).
	// Layout matches ai/features.py:_mana_pressure_features so the
	// exported PyTorch model's raw_proj column ordering applies cleanly.
	const manaPressure = _manaPressureFeatures(board, sideToMove, enemy);
	for (let i = 0; i < manaPressure.length; i++) features[fi++] = manaPressure[i];

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
			// Core spells one-hot at [43:58]; expansion spells (IDs 15-44)
			// at [84:114]; Aftershock/Ambush (IDs 45-50) at [116:122] —
			// mirrors ai/features.py:encode_turn.
			if (spellId < 15) features[43 + spellId] = 1;
			else if (spellId < 45) features[84 + (spellId - 15)] = 1;
			else features[116 + (spellId - 45)] = 1;
		} else if (action.type === 'schedule_moves') {
			features[115] = Math.min(action.turns || 0, 4) / 4.0;
		} else if (action.type === 'burn') {
			features[122] += 0.25;
		} else if (action.type === 'place_snares') {
			features[123] = Math.min((action.nodes || []).length, 4) / 4.0;
		}
	}

	features[58] = turn.actions.length / 5.0;
	features[122] = Math.min(features[122], 1.0);
	if (turn.actions.length === 1 && turn.actions[0].type === 'pass') features[60] = 1;

	// Providence: extra base moves used this turn (leading move-phase
	// actions beyond the ordinary first move).
	let baseMoves = 0;
	for (const action of turn.actions) {
		if (action.type === 'move' || action.type === 'hard_move' || action.type === 'blink') baseMoves++;
		else break;
	}
	features[114] = Math.min(Math.max(baseMoves - 1, 0), 3) / 3.0;

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
