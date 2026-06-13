// Move helper functions for the Sigil game engine.
// These operate on a SigilBoard instance.

function getSoftMoveTargets(board, color) {
	// Returns dict of empty nodes adjacent to color's stones => color
	const result = {};
	for (const name of NODE_ORDER) {
		if (board.stones[name] === null) {
			for (const nb of ADJACENCY[name]) {
				if (board.stones[nb] === color) {
					result[name] = color;
					break;
				}
			}
		}
	}
	return result;
}

function getHardMoveTargets(board, color) {
	// Returns dict of enemy nodes adjacent to color's stones => color
	const enemy = board.enemy(color);
	const result = {};
	for (const name of NODE_ORDER) {
		if (board.stones[name] === enemy) {
			for (const nb of ADJACENCY[name]) {
				if (board.stones[nb] === color) {
					result[name] = color;
					break;
				}
			}
		}
	}
	return result;
}

function getAllMoveTargets(board, color) {
	// Returns dict of all nodes (empty or enemy) adjacent to color's stones => color
	const result = {};
	for (const name of NODE_ORDER) {
		if (board.stones[name] !== color) {
			for (const nb of ADJACENCY[name]) {
				if (board.stones[nb] === color) {
					result[name] = color;
					break;
				}
			}
		}
	}
	return result;
}

function getBlinkTargets(board, color) {
	// Returns dict of all nodes not occupied by color => color
	const result = {};
	for (const name of NODE_ORDER) {
		if (board.stones[name] !== color) {
			result[name] = color;
		}
	}
	return result;
}

/**
 * Push enemy stone via BFS. Returns { options: [node_names], crushed: boolean }.
 * Does NOT mutate board - caller decides what to do.
 * The `fromNode` has already been claimed by `color` before calling this.
 */
function findPushOptions(board, fromNode, color) {
	const enemy = board.enemy(color);
	const queue = [];
	for (const nb of ADJACENCY[fromNode]) {
		queue.push([nb, 1]);
	}

	const visited = new Set([fromNode]);
	const options = [];
	let shortestDist = null;

	while (queue.length > 0) {
		const [nextNode, dist] = queue.shift();
		if (visited.has(nextNode)) continue;
		visited.add(nextNode);

		if (shortestDist !== null && dist > shortestDist) break;

		const stone = board.stones[nextNode];
		if (stone === color) {
			continue;
		} else if (stone === enemy) {
			for (const nb of ADJACENCY[nextNode]) {
				if (!visited.has(nb)) {
					queue.push([nb, dist + 1]);
				}
			}
		} else {
			// empty
			options.push(nextNode);
			shortestDist = dist;
		}
	}

	// Deduplicate
	const unique = [...new Set(options)];
	return { options: unique, crushed: unique.length === 0 };
}

// --- Dash sacrifice helpers (shared by the interactive controllers) ---
// Seal of Autumn (held by the enemy) forbids `color` from sacrificing stones
// that sit on a spell sigil when dashing. Centralizing the rule here keeps the
// dash action and its sacrifice prompt in sync across the controllers.

// Stones cost to pay for a dash: 1 with Seal of Lightning, otherwise 2.
function dashCost(board, color) {
	return board.chargedSpells[color].includes('Seal_of_Lightning') ? 1 : 2;
}

// Node names `color` may legally sacrifice to dash, honoring Seal of Autumn.
function dashSacrificeOptions(board, color) {
	const enemy = board.enemy(color);
	const restricted = board.chargedSpells[enemy].includes('Seal_of_Autumn');
	const opts = [];
	for (const name of NODE_ORDER) {
		if (board.stones[name] !== color) continue;
		if (restricted && isSpellNode(name)) continue;
		opts.push(name);
	}
	return opts;
}

// Whether `color` can dash: more than 2 stones total (so at least one survives)
// and enough eligible stones to pay the sacrifice cost.
function canDash(board, color) {
	if (board.totalStones[color] <= 2) return false;
	return dashSacrificeOptions(board, color).length >= dashCost(board, color);
}
