/**
 * Move helper functions for the Cataclysm engine.
 * These operate on a CataclysmBoard instance, using the map's adjacency graph.
 */

function catGetSoftMoveTargets(board, color) {
	const adj = board.mapDef.adjacency;
	const result = {};
	for (const name of board.nodeOrder) {
		if (board.stones[name] === null) {
			for (const nb of adj[name]) {
				if (board.stones[nb] === color) {
					result[name] = color;
					break;
				}
			}
		}
	}
	return result;
}

function catGetHardMoveTargets(board, color) {
	const adj = board.mapDef.adjacency;
	const result = {};
	for (const name of board.nodeOrder) {
		if (board.isEnemy(board.stones[name], color)) {
			for (const nb of adj[name]) {
				if (board.stones[nb] === color) {
					result[name] = color;
					break;
				}
			}
		}
	}
	return result;
}

function catGetAllMoveTargets(board, color) {
	const adj = board.mapDef.adjacency;
	const result = {};
	for (const name of board.nodeOrder) {
		if (board.stones[name] !== color && !board.isAlly(board.stones[name] || '', color)) {
			for (const nb of adj[name]) {
				if (board.stones[nb] === color) {
					result[name] = color;
					break;
				}
			}
		}
	}
	return result;
}

function catGetBlinkTargets(board, color) {
	const result = {};
	for (const name of board.nodeOrder) {
		if (board.stones[name] !== color && !board.isAlly(board.stones[name] || '', color)) {
			result[name] = color;
		}
	}
	return result;
}

/**
 * BFS to find push destinations. Returns { options: [node_names], crushed: boolean }.
 * The pushed stone could be any enemy color. All non-pusher stones are obstacles.
 */
function catFindPushOptions(board, fromNode, color) {
	const adj = board.mapDef.adjacency;
	const queue = [];
	for (const nb of adj[fromNode]) {
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
		if (stone === color || board.isAlly(stone || '', color)) {
			// Friendly stone blocks
			continue;
		} else if (stone !== null) {
			// Enemy stone — push through
			for (const nb of adj[nextNode]) {
				if (!visited.has(nb)) {
					queue.push([nb, dist + 1]);
				}
			}
		} else {
			// Empty — valid push destination
			options.push(nextNode);
			shortestDist = dist;
		}
	}

	const unique = [...new Set(options)];
	return { options: unique, crushed: unique.length === 0 };
}
