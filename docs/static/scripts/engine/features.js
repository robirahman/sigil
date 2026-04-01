/**
 * Feature extraction for SigilNet inference in the browser.
 * Ported from ai/features.py.
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

const NUM_NODES = 39;
const NUM_SPELL_SLOTS = 9;
const RAW_FEATURE_DIM = 250;
const TURN_FEATURE_DIM = 64;

/**
 * Convert a SimBoard to raw feature array + spell ID array.
 * Returns { raw: Float32Array(250), spellIds: Int32Array(9) }
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

	// Spell IDs
	const spellIds = new Int32Array(NUM_SPELL_SLOTS);
	for (let i = 0; i < NUM_SPELL_SLOTS; i++) {
		spellIds[i] = SPELL_TO_ID[board.spellNames[i]] || 0;
	}

	return { raw: features, spellIds };
}

/**
 * Encode a SimTurn as a fixed-size feature vector.
 * Returns Float32Array(64)
 */
function encodeTurn(turn, board, color) {
	const enemy = color === 'red' ? 'blue' : 'red';
	const features = new Float32Array(TURN_FEATURE_DIM);
	let moveTarget = null;

	for (const action of turn.actions) {
		if (action.type === 'move' && action.node) {
			const idx = _NODE_TO_IDX[action.node];
			if (idx !== undefined && moveTarget === null) {
				features[idx] = 1;
				moveTarget = action.node;
			}
			features[59] += 1.0 / 39.0;
		} else if (action.type === 'hard_move' && action.node) {
			const idx = _NODE_TO_IDX[action.node];
			if (idx !== undefined && moveTarget === null) {
				features[idx] = 1;
				moveTarget = action.node;
			}
			features[39] = 1;
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
		} else if (action.type === 'cast') {
			features[42] = 1;
			const spellId = SPELL_TO_ID[action.spell] || 0;
			features[43 + spellId] = 1;
		}
	}

	features[58] = turn.actions.length / 5.0;
	if (turn.actions.length === 1 && turn.actions[0].type === 'pass') features[60] = 1;

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
