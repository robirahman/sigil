// Spell resolution functions for human-interactive play.
// Each spell's resolve is an async function that uses getInput() to prompt the player.
//
// getInput(payload) sends a message/event to the UI and returns a Promise
// that resolves with the player's response (a node name, etc.).

// Returns position indices (1..9) where `color` controls all but exactly `n` nodes.
// `opts.size`, if set, restricts to spells with that many nodes.
function spellsWhereControlAllButN(board, color, n, opts = {}) {
	const result = [];
	for (let i = 1; i <= 9; i++) {
		const nodes = POSITIONS[i];
		if (!nodes) continue;
		if (opts.size && nodes.length !== opts.size) continue;
		let uncontrolled = 0;
		for (const node of nodes) {
			if (board.stones[node] !== color) uncontrolled++;
		}
		if (uncontrolled === n) result.push(i);
	}
	return result;
}

// Returns the position index (1..9) that contains `nodeName`, or null.
function spellPositionOfNode(nodeName) {
	for (let i = 1; i <= 9; i++) {
		if (POSITIONS[i] && POSITIONS[i].includes(nodeName)) return i;
	}
	return null;
}

// Maps a 5-node ritual position to its "opposite" charm (1-node) and sorcery (3-node)
// positions, rotating zones A→B→C→A.
const SYZYGY_OPPOSITE = {
	1: { charm: 8, sorcery: 5 },
	2: { charm: 9, sorcery: 6 },
	3: { charm: 7, sorcery: 4 },
};

// BFS flood-fill: return contiguous groups of stones of `targetColor`.
// Each group is an array of node names.
function findStoneGroups(board, targetColor) {
	const groups = [];
	const visited = new Set();
	for (const start of NODE_ORDER) {
		if (visited.has(start)) continue;
		if (board.stones[start] !== targetColor) continue;
		const group = [];
		const queue = [start];
		visited.add(start);
		while (queue.length > 0) {
			const n = queue.shift();
			group.push(n);
			for (const nb of (ADJACENCY[n] || [])) {
				if (visited.has(nb)) continue;
				if (board.stones[nb] === targetColor) {
					visited.add(nb);
					queue.push(nb);
				}
			}
		}
		groups.push(group);
	}
	return groups;
}

const SpellResolvers = {

	// --- Soft move spells ---
	async soft_moves(board, color, spellName, getInput, emit) {
		const count = CORE_SPELLS[spellName].count;
		for (let i = 0; i < count; i++) {
			const targets = getSoftMoveTargets(board, color);
			if (Object.keys(targets).length === 0) {
				emit({ type: 'message', message: 'No legal soft moves.', awaiting: null });
				break;
			}
			while (true) {
				const resp = await getInput({
					type: 'message',
					message: 'Choose where to soft move.',
					awaiting: 'node',
					moveoptions: targets,
				});
				const node = resp;
				if (!targets[node]) continue;
				board.stones[node] = color;
				emit({ type: 'new_stone_animation', color, node });
				board.lastPlay = node;
				board.lastPlayer = color;
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	// --- Hard move spells ---
	async hard_moves(board, color, spellName, getInput, emit) {
		const count = CORE_SPELLS[spellName].count;
		for (let i = 0; i < count; i++) {
			const targets = getHardMoveTargets(board, color);
			if (Object.keys(targets).length === 0) {
				emit({ type: 'message', message: 'No legal hard moves.', awaiting: null });
				break;
			}
			while (true) {
				const resp = await getInput({
					type: 'message',
					message: 'Choose where to hard move.',
					awaiting: 'node',
					moveoptions: targets,
				});
				const node = resp;
				if (!targets[node]) continue;
				await doPushEnemy(board, node, color, getInput, emit);
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	// --- Fireblast ---
	async fireblast(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		for (const name of NODE_ORDER) {
			if (board.stones[name] === enemy) {
				for (const nb of ADJACENCY[name]) {
					if (board.stones[nb] === color) {
						board.stones[name] = null;
						if (board.lastPlay === name) {
							board.lastPlay = null;
							board.lastPlayer = null;
						}
						break;
					}
				}
			}
		}
		board.update();
		emit(board.getBoardStatePayload());

		// If destruction wiped out the opponent's last stone, the game
		// ends immediately (latest-edition rules) — no sacrifice prompt.
		if (board.gameover) return;

		// Sacrifice cost (latest-edition rules). If the caster has no
		// stones left, skip — they have already lost; the update() call
		// above would have flagged that.
		const hasOwn = NODE_ORDER.some(n => board.stones[n] === color);
		if (!hasOwn) return;

		while (true) {
			const resp = await getInput({
				type: 'message', message: 'Sacrifice a stone.',
				awaiting: 'node', moveoptions: {},
			});
			if (board.stones[resp] === color) {
				board.stones[resp] = null;
				if (board.lastPlay === resp) {
					board.lastPlay = null;
					board.lastPlayer = null;
				}
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	// --- Hail Storm ---
	async hail_storm(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		// Find which of the 6 non-charm spell positions have enemy stones
		const hailableSpells = [];
		for (let i = 1; i <= 6; i++) {
			const nodes = POSITIONS[i];
			for (const n of nodes) {
				if (board.stones[n] === enemy) {
					hailableSpells.push(i);
					break;
				}
			}
		}

		if (hailableSpells.length === 0) return;

		emit({ type: 'message', message: 'Select an enemy stone to destroy in each 3-node and 5-node spell.', awaiting: null });

		while (hailableSpells.length > 0) {
			const resp = await getInput({
				type: 'message', message: '', awaiting: 'node', moveoptions: {},
			});
			const nodeName = resp;
			if (!board.stones[nodeName] || board.stones[nodeName] !== enemy) continue;

			let found = false;
			for (let j = 0; j < hailableSpells.length; j++) {
				const spellIdx = hailableSpells[j];
				if (POSITIONS[spellIdx].includes(nodeName)) {
					board.stones[nodeName] = null;
					if (board.lastPlay === nodeName) {
						board.lastPlay = null;
						board.lastPlayer = null;
					}
					hailableSpells.splice(j, 1);
					board.update();
					emit(board.getBoardStatePayload());
					found = true;
					break;
				}
			}
		}
	},

	// --- Bewitch ---
	async bewitch(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);

		// Step 1: pick first enemy stone (must be adjacent to another enemy)
		let firstNode = null;
		while (true) {
			const convertOneOptions = {};
			for (const name of NODE_ORDER) {
				if (board.stones[name] === enemy) {
					let adjToEnemy = false;
					for (const nb of ADJACENCY[name]) {
						if (board.stones[nb] === enemy) { adjToEnemy = true; break; }
					}
					if (adjToEnemy) convertOneOptions[name] = color;
				}
			}

			if (Object.keys(convertOneOptions).length === 0) return;

			const resp = await getInput({
				type: 'message',
				message: 'Choose 2 enemy stones to convert.',
				awaiting: 'node',
				moveoptions: convertOneOptions,
			});

			if (convertOneOptions[resp]) {
				firstNode = resp;
				board.stones[firstNode] = color;
				emit({ type: 'new_stone_animation', color, node: firstNode });
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}

		// Step 2: pick adjacent enemy neighbor
		while (true) {
			const convertTwoOptions = {};
			for (const nb of ADJACENCY[firstNode]) {
				if (board.stones[nb] === enemy) {
					convertTwoOptions[nb] = color;
				}
			}

			const resp = await getInput({
				type: 'message', message: '', awaiting: 'node',
				moveoptions: convertTwoOptions,
			});

			if (convertTwoOptions[resp]) {
				board.stones[resp] = color;
				emit({ type: 'new_stone_animation', color, node: resp });
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	// --- Starfall ---
	async starfall(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);

		// Step 1: pick first empty node (must be adjacent to another empty)
		let firstNode = null;
		while (true) {
			const options = {};
			for (const name of NODE_ORDER) {
				if (board.stones[name] === null) {
					let adjToEmpty = false;
					for (const nb of ADJACENCY[name]) {
						if (board.stones[nb] === null) { adjToEmpty = true; break; }
					}
					if (adjToEmpty) options[name] = color;
				}
			}

			const resp = await getInput({
				type: 'message',
				message: 'Make 2 soft blink moves that touch each other.',
				awaiting: 'node',
				moveoptions: options,
			});

			if (options[resp]) {
				firstNode = resp;
				board.stones[firstNode] = color;
				emit({ type: 'new_stone_animation', color, node: firstNode });
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}

		// Step 2: pick adjacent empty neighbor
		let secondNode = null;
		while (true) {
			const options = {};
			for (const nb of ADJACENCY[firstNode]) {
				if (board.stones[nb] === null) options[nb] = color;
			}

			const resp = await getInput({
				type: 'message', message: '', awaiting: 'node',
				moveoptions: options,
			});

			if (options[resp]) {
				secondNode = resp;
				board.stones[secondNode] = color;
				emit({ type: 'new_stone_animation', color, node: secondNode });
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}

		// Destroy all adjacent enemies
		const neighborUnion = new Set([
			...ADJACENCY[firstNode],
			...ADJACENCY[secondNode],
		]);
		for (const nb of neighborUnion) {
			if (board.stones[nb] === enemy) {
				board.stones[nb] = null;
			}
		}
		board.update();
		emit(board.getBoardStatePayload());
	},

	// --- Meteor ---
	async meteor(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);

		// Step 1: blink move
		let landedNode = null;
		while (true) {
			const moveoptions = getBlinkTargets(board, color);
			const resp = await getInput({
				type: 'message', message: 'Make 1 blink move.',
				awaiting: 'node', moveoptions,
			});

			if (!moveoptions[resp]) continue;
			const node = resp;

			if (board.stones[node] === enemy) {
				await doPushEnemy(board, node, color, getInput, emit);
				landedNode = node;
				break;
			} else if (board.stones[node] === null) {
				board.stones[node] = color;
				emit({ type: 'new_stone_animation', color, node });
				board.update();
				emit(board.getBoardStatePayload());
				landedNode = node;
				break;
			}
		}

		// Step 2: destroy 1 adjacent enemy
		const adjEnemies = ADJACENCY[landedNode].filter(nb => board.stones[nb] === enemy);
		if (adjEnemies.length === 0) return;
		if (adjEnemies.length === 1) {
			board.stones[adjEnemies[0]] = null;
			board.update();
			emit(board.getBoardStatePayload());
			return;
		}

		// Multiple: player chooses
		while (true) {
			const resp = await getInput({
				type: 'message', message: 'Choose an enemy stone to destroy.',
				awaiting: 'node', moveoptions: {},
			});
			if (adjEnemies.includes(resp)) {
				board.stones[resp] = null;
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	// --- Comet ---
	async comet(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);

		// Step 1: blink move
		while (true) {
			const moveoptions = getBlinkTargets(board, color);
			const resp = await getInput({
				type: 'message', message: 'Make 1 blink move.',
				awaiting: 'node', moveoptions,
			});
			if (!moveoptions[resp]) continue;
			const node = resp;

			if (board.stones[node] === color) continue;
			if (board.stones[node] === enemy) {
				await doPushEnemy(board, node, color, getInput, emit);
				break;
			} else {
				board.stones[node] = color;
				emit({ type: 'new_stone_animation', color, node });
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}

		// Step 2: sacrifice a stone
		while (true) {
			const resp = await getInput({
				type: 'message', message: 'Sacrifice a stone.',
				awaiting: 'node', moveoptions: {},
			});
			if (board.stones[resp] === color) {
				board.stones[resp] = null;
				if (board.lastPlay === resp) {
					board.lastPlay = null;
					board.lastPlayer = null;
				}
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	// --- Azimuth (celestial charm) ---
	async azimuth(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		const qualifying = spellsWhereControlAllButN(board, color, 1);
		if (qualifying.length === 0) {
			emit({ type: 'message', message: 'No spell qualifies (need to control all but 1 node).', awaiting: null });
			return;
		}
		const allMoves = getAllMoveTargets(board, color);
		const targets = {};
		for (const node of Object.keys(allMoves)) {
			for (const idx of qualifying) {
				if (POSITIONS[idx].includes(node)) { targets[node] = color; break; }
			}
		}
		if (Object.keys(targets).length === 0) {
			emit({ type: 'message', message: 'No legal move into a qualifying spell.', awaiting: null });
			return;
		}
		while (true) {
			const resp = await getInput({
				type: 'message',
				message: 'Move into a spell where you control all but 1 node.',
				awaiting: 'node',
				moveoptions: targets,
			});
			if (!targets[resp]) continue;
			if (board.stones[resp] === enemy) {
				await doPushEnemy(board, resp, color, getInput, emit);
			} else {
				board.stones[resp] = color;
				emit({ type: 'new_stone_animation', color, node: resp });
				board.lastPlay = resp;
				board.lastPlayer = color;
				board.update();
				emit(board.getBoardStatePayload());
			}
			break;
		}
	},

	// --- Eclipse (celestial sorcery) ---
	async eclipse(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		const candidates = spellsWhereControlAllButN(board, color, 2);
		if (candidates.length === 0) {
			emit({ type: 'message', message: 'No spell qualifies (need to control all but 2 nodes).', awaiting: null });
			return;
		}

		// Move 1: target lies in any candidate spell
		const moves1 = getAllMoveTargets(board, color);
		const targets1 = {};
		for (const node of Object.keys(moves1)) {
			for (const idx of candidates) {
				if (POSITIONS[idx].includes(node)) { targets1[node] = color; break; }
			}
		}
		if (Object.keys(targets1).length === 0) {
			emit({ type: 'message', message: 'No legal move into a qualifying spell.', awaiting: null });
			return;
		}

		let chosenSpell = null;
		while (true) {
			const resp = await getInput({
				type: 'message',
				message: 'Make 2 moves into a spell where you control all but 2 nodes. Pick the first.',
				awaiting: 'node',
				moveoptions: targets1,
			});
			if (!targets1[resp]) continue;
			chosenSpell = spellPositionOfNode(resp);
			if (board.stones[resp] === enemy) {
				await doPushEnemy(board, resp, color, getInput, emit);
			} else {
				board.stones[resp] = color;
				emit({ type: 'new_stone_animation', color, node: resp });
				board.lastPlay = resp;
				board.lastPlayer = color;
				board.update();
				emit(board.getBoardStatePayload());
			}
			break;
		}

		// Move 2: must be in the chosen spell
		const moves2 = getAllMoveTargets(board, color);
		const targets2 = {};
		for (const n of POSITIONS[chosenSpell]) {
			if (moves2[n]) targets2[n] = color;
		}
		if (Object.keys(targets2).length === 0) {
			emit({ type: 'message', message: 'No legal second move; Eclipse ends early.', awaiting: null });
			return;
		}
		while (true) {
			const resp = await getInput({
				type: 'message',
				message: 'Make the second move into the same spell.',
				awaiting: 'node',
				moveoptions: targets2,
			});
			if (!targets2[resp]) continue;
			if (board.stones[resp] === enemy) {
				await doPushEnemy(board, resp, color, getInput, emit);
			} else {
				board.stones[resp] = color;
				emit({ type: 'new_stone_animation', color, node: resp });
				board.lastPlay = resp;
				board.lastPlayer = color;
				board.update();
				emit(board.getBoardStatePayload());
			}
			break;
		}
	},

	// --- Scatter (springtime sorcery) ---
	async scatter(board, color, spellName, getInput, emit) {
		const usedSpells = new Set();
		for (let move = 0; move < 2; move++) {
			const targets = {};
			for (let i = 1; i <= 9; i++) {
				if (usedSpells.has(i)) continue;
				for (const n of POSITIONS[i]) {
					if (board.stones[n] === null) targets[n] = color;
				}
			}
			if (Object.keys(targets).length === 0) {
				emit({ type: 'message', message: 'No remaining empty nodes; Scatter ends early.', awaiting: null });
				return;
			}
			while (true) {
				const resp = await getInput({
					type: 'message',
					message: `Soft blink into spell ${move + 1} of 2 (any empty node).`,
					awaiting: 'node',
					moveoptions: targets,
				});
				if (!targets[resp]) continue;
				const idx = spellPositionOfNode(resp);
				usedSpells.add(idx);
				board.stones[resp] = color;
				emit({ type: 'new_stone_animation', color, node: resp });
				board.lastPlay = resp;
				board.lastPlayer = color;
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	// --- Blossom (springtime ritual) ---
	async blossom(board, color, spellName, getInput, emit) {
		const selfIdx = board.spellNames.indexOf(spellName) + 1;
		const usedSpells = new Set([selfIdx]);
		// Target: each other 3-node and 5-node spell (positions 1..6 minus self)
		const required = [1, 2, 3, 4, 5, 6].filter(i => i !== selfIdx).length;
		for (let move = 0; move < required; move++) {
			const targets = {};
			for (let i = 1; i <= 6; i++) {
				if (usedSpells.has(i)) continue;
				for (const n of POSITIONS[i]) {
					if (board.stones[n] === null) targets[n] = color;
				}
			}
			if (Object.keys(targets).length === 0) {
				emit({ type: 'message', message: 'No remaining empty nodes; Blossom ends early.', awaiting: null });
				return;
			}
			while (true) {
				const resp = await getInput({
					type: 'message',
					message: `Soft blink into a remaining 3-node or 5-node spell (${move + 1}/${required}).`,
					awaiting: 'node',
					moveoptions: targets,
				});
				if (!targets[resp]) continue;
				const idx = spellPositionOfNode(resp);
				usedSpells.add(idx);
				board.stones[resp] = color;
				emit({ type: 'new_stone_animation', color, node: resp });
				board.lastPlay = resp;
				board.lastPlayer = color;
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	// --- Syzygy (celestial ritual) ---
	async syzygy(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		const spellIdx = board.spellNames.indexOf(spellName) + 1;
		const opp = SYZYGY_OPPOSITE[spellIdx];
		if (!opp) return;

		// Step 1: 1 blink move into the 1-node opposite spell
		const charmNode = POSITIONS[opp.charm][0];
		if (board.stones[charmNode] !== color) {
			const targets = { [charmNode]: color };
			while (true) {
				const resp = await getInput({
					type: 'message',
					message: 'Blink into the opposite 1-node spell.',
					awaiting: 'node',
					moveoptions: targets,
				});
				if (resp !== charmNode) continue;
				if (board.stones[charmNode] === enemy) {
					await doPushEnemy(board, charmNode, color, getInput, emit);
				} else {
					board.stones[charmNode] = color;
					emit({ type: 'new_stone_animation', color, node: charmNode });
					board.lastPlay = charmNode;
					board.lastPlayer = color;
					board.update();
					emit(board.getBoardStatePayload());
				}
				break;
			}
		}

		// Step 2: up to 3 blink moves into the opposite 3-node spell
		const sorceryNodes = POSITIONS[opp.sorcery];
		for (let move = 0; move < 3; move++) {
			const targets = {};
			for (const n of sorceryNodes) {
				if (board.stones[n] !== color) targets[n] = color;
			}
			if (Object.keys(targets).length === 0) {
				emit({ type: 'message', message: 'Opposite 3-node spell fully yours; Syzygy ends.', awaiting: null });
				return;
			}
			while (true) {
				const resp = await getInput({
					type: 'message',
					message: `Blink into the opposite 3-node spell (${move + 1}/3).`,
					awaiting: 'node',
					moveoptions: targets,
				});
				if (!targets[resp]) continue;
				if (board.stones[resp] === enemy) {
					await doPushEnemy(board, resp, color, getInput, emit);
				} else {
					board.stones[resp] = color;
					emit({ type: 'new_stone_animation', color, node: resp });
					board.lastPlay = resp;
					board.lastPlayer = color;
					board.update();
					emit(board.getBoardStatePayload());
				}
				break;
			}
		}
	},

	// --- Fury (sacrifice 1 stone, then 3 hard moves) ---
	async fury(board, color, spellName, getInput, emit) {
		// Sacrifice 1 stone first.
		const hasOwn = NODE_ORDER.some(n => board.stones[n] === color);
		if (hasOwn) {
			while (true) {
				const resp = await getInput({
					type: 'message', message: 'Sacrifice a stone.',
					awaiting: 'node', moveoptions: {},
				});
				if (board.stones[resp] === color) {
					board.stones[resp] = null;
					if (board.lastPlay === resp) {
						board.lastPlay = null;
						board.lastPlayer = null;
					}
					board.update();
					emit(board.getBoardStatePayload());
					break;
				}
			}
		}
		if (board.gameover) return;

		// Then 3 hard moves.
		for (let i = 0; i < 3; i++) {
			const targets = getHardMoveTargets(board, color);
			if (Object.keys(targets).length === 0) {
				emit({ type: 'message', message: 'No legal hard moves.', awaiting: null });
				break;
			}
			while (true) {
				const resp = await getInput({
					type: 'message', message: 'Choose where to hard move.',
					awaiting: 'node', moveoptions: targets,
				});
				if (!targets[resp]) continue;
				await doPushEnemy(board, resp, color, getInput, emit);
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	// --- Charge (inferno charm): 1 move into a 3- or 5-node spell ---
	async charge(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		// Any normal move (soft or hard) that lands in a 3- or 5-node spell
		// (positions 1..6). No "control all but N" constraint, unlike Azimuth.
		const allMoves = getAllMoveTargets(board, color);
		const targets = {};
		for (const node of Object.keys(allMoves)) {
			const idx = spellPositionOfNode(node);
			if (idx !== null && idx <= 6) targets[node] = color;
		}
		if (Object.keys(targets).length === 0) {
			emit({ type: 'message', message: 'No legal move into a 3- or 5-node spell.', awaiting: null });
			return;
		}
		while (true) {
			const resp = await getInput({
				type: 'message',
				message: 'Make 1 move into a 3- or 5-node spell.',
				awaiting: 'node',
				moveoptions: targets,
			});
			if (!targets[resp]) continue;
			if (board.stones[resp] === enemy) {
				await doPushEnemy(board, resp, color, getInput, emit);
			} else {
				board.stones[resp] = color;
				emit({ type: 'new_stone_animation', color, node: resp });
				board.lastPlay = resp;
				board.lastPlayer = color;
				board.update();
				emit(board.getBoardStatePayload());
			}
			break;
		}
	},

	// --- Erupt (inferno ritual): 1 move into each 3- and 5-node spell ---
	async erupt(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		// One non-blink move (place on an adjacent empty node, or push an
		// adjacent enemy) into each 3- and 5-node spell — positions 1..6,
		// INCLUDING Erupt's own slot. A spell is eligible only if you're
		// adjacent to one of its nodes that you don't already occupy.
		for (let i = 1; i <= 6; i++) {
			const moves = getAllMoveTargets(board, color);
			const targets = {};
			for (const n of POSITIONS[i]) {
				if (moves[n]) targets[n] = color;
			}
			if (Object.keys(targets).length === 0) continue; // can't reach this spell
			while (true) {
				const resp = await getInput({
					type: 'message',
					message: `Make 1 move into this 3- or 5-node spell (${i}/6).`,
					awaiting: 'node',
					moveoptions: targets,
				});
				if (!targets[resp]) continue;
				if (board.stones[resp] === enemy) {
					await doPushEnemy(board, resp, color, getInput, emit);
				} else {
					board.stones[resp] = color;
					emit({ type: 'new_stone_animation', color, node: resp });
					board.lastPlay = resp;
					board.lastPlayer = color;
					board.update();
					emit(board.getBoardStatePayload());
				}
				break;
			}
			if (board.gameover) return;
		}
	},

	// --- Thunder (relocate enemy stones touching you) ---
	async thunder(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		// Thunder's own position has already been cleared by _castSpell
		// before resolve runs. Pick up every enemy stone that touches a
		// surviving caster stone.
		const picked = [];
		for (const n of NODE_ORDER) {
			if (board.stones[n] !== enemy) continue;
			for (const nb of ADJACENCY[n]) {
				if (board.stones[nb] === color) { picked.push(n); break; }
			}
		}
		if (picked.length === 0) {
			emit({ type: 'message', message: 'No enemy stones touch you; Thunder fizzles.', awaiting: null });
			return;
		}
		for (const n of picked) {
			board.stones[n] = null;
			if (board.lastPlay === n) {
				board.lastPlay = null;
				board.lastPlayer = null;
			}
		}
		board.update();
		emit(board.getBoardStatePayload());

		// Place them one at a time onto any empty node (including ones
		// just vacated). Game might end mid-relocation if these were the
		// enemy's last stones — guard before each prompt.
		for (let i = 0; i < picked.length; i++) {
			if (board.gameover) return;
			const moveoptions = {};
			for (const n of NODE_ORDER) {
				if (board.stones[n] === null) moveoptions[n] = enemy;
			}
			if (Object.keys(moveoptions).length === 0) return;
			while (true) {
				const resp = await getInput({
					type: 'message',
					message: `Place enemy stone ${i + 1} of ${picked.length} on an empty node.`,
					awaiting: 'node',
					moveoptions,
				});
				if (board.stones[resp] === null) {
					board.stones[resp] = enemy;
					emit({ type: 'new_stone_animation', color: enemy, node: resp });
					board.update();
					emit(board.getBoardStatePayload());
					break;
				}
			}
		}
	},

	// --- Storm Front (destroy any 2 enemy stones) ---
	async storm_front(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		for (let i = 0; i < 2; i++) {
			const remaining = NODE_ORDER.some(n => board.stones[n] === enemy);
			if (!remaining) return;
			while (true) {
				const resp = await getInput({
					type: 'message',
					message: `Choose an enemy stone to destroy (${i + 1} of 2).`,
					awaiting: 'node', moveoptions: {},
				});
				if (board.stones[resp] === enemy) {
					board.stones[resp] = null;
					if (board.lastPlay === resp) {
						board.lastPlay = null;
						board.lastPlayer = null;
					}
					board.update();
					emit(board.getBoardStatePayload());
					break;
				}
			}
			if (board.gameover) return;
		}
	},

	// --- Hurricane (destroy smallest contiguous enemy group) ---
	async hurricane(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		const groups = findStoneGroups(board, enemy);
		if (groups.length === 0) return;

		const minSize = Math.min(...groups.map(g => g.length));
		const smallest = groups.filter(g => g.length === minSize);

		let chosen;
		if (smallest.length === 1) {
			chosen = smallest[0];
		} else {
			// Tie: caster picks any stone in one of the smallest groups.
			const moveoptions = {};
			for (const g of smallest) {
				for (const n of g) moveoptions[n] = enemy;
			}
			while (true) {
				const resp = await getInput({
					type: 'message',
					message: `Multiple smallest groups (${minSize} stones each). Click a stone in the group you want destroyed.`,
					awaiting: 'node', moveoptions,
				});
				const found = smallest.find(g => g.includes(resp));
				if (found) { chosen = found; break; }
			}
		}

		for (const n of chosen) {
			board.stones[n] = null;
			if (board.lastPlay === n) {
				board.lastPlay = null;
				board.lastPlayer = null;
			}
		}
		board.update();
		emit(board.getBoardStatePayload());
	},

	// --- Torrent / Flood (soft moves then hard moves) ---
	async soft_hard_chain(board, color, spellName, getInput, emit) {
		const info = CORE_SPELLS[spellName];
		const [softCount, hardCount] = info.counts;
		for (let i = 0; i < softCount; i++) {
			const targets = getSoftMoveTargets(board, color);
			if (Object.keys(targets).length === 0) {
				emit({ type: 'message', message: 'No legal soft moves.', awaiting: null });
				break;
			}
			while (true) {
				const resp = await getInput({
					type: 'message', message: 'Choose where to soft move.',
					awaiting: 'node', moveoptions: targets,
				});
				if (!targets[resp]) continue;
				board.stones[resp] = color;
				emit({ type: 'new_stone_animation', color, node: resp });
				board.lastPlay = resp; board.lastPlayer = color;
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
		for (let i = 0; i < hardCount; i++) {
			const targets = getHardMoveTargets(board, color);
			if (Object.keys(targets).length === 0) {
				emit({ type: 'message', message: 'No legal hard moves.', awaiting: null });
				break;
			}
			while (true) {
				const resp = await getInput({
					type: 'message', message: 'Choose where to hard move.',
					awaiting: 'node', moveoptions: targets,
				});
				if (!targets[resp]) continue;
				await doPushEnemy(board, resp, color, getInput, emit);
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	// --- Surge ---
	async surge_move(board, color, spellName, getInput, emit) {
		const moveoptions = getAllMoveTargets(board, color);
		if (Object.keys(moveoptions).length === 0) return;

		while (true) {
			const resp = await getInput({
				type: 'message', message: 'Choose where to move.',
				awaiting: 'node', moveoptions,
			});
			if (!moveoptions[resp]) continue;
			const node = resp;
			const enemy = board.enemy(color);

			if (board.stones[node] === null) {
				board.stones[node] = color;
				emit({ type: 'new_stone_animation', color, node });
				board.lastPlay = node;
				board.lastPlayer = color;
				board.update();
				emit(board.getBoardStatePayload());
				break;
			} else if (board.stones[node] === enemy) {
				await doPushEnemy(board, node, color, getInput, emit);
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	// --- Panda: Bear Trap (destroy enemy stones in the 1-node spells) ---
	async bear_trap(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		let any = false;
		for (const pos of [7, 8, 9]) {
			for (const n of POSITIONS[pos]) {
				if (board.stones[n] === enemy) {
					board.stones[n] = null;
					if (board.lastPlay === n) { board.lastPlay = null; board.lastPlayer = null; }
					emit({ type: 'crush_animation', crushed_color: enemy, node: n });
					any = true;
				}
			}
		}
		if (!any) emit({ type: 'message', message: 'No enemy stones in any 1-node spell.', awaiting: null });
		board.update();
		emit(board.getBoardStatePayload());
	},

	// --- Panda: Shiver (swap the positions of any two stones) ---
	async shiver(board, color, spellName, getInput, emit) {
		const occupied = () => NODE_ORDER.filter(n => board.stones[n] !== null);
		if (occupied().length < 2) {
			emit({ type: 'message', message: 'Need at least two stones to swap.', awaiting: null });
			return;
		}
		const pick = async (message, exclude) => {
			while (true) {
				const moveoptions = {};
				for (const n of NODE_ORDER) {
					if (board.stones[n] !== null && n !== exclude) moveoptions[n] = board.stones[n];
				}
				const resp = await getInput({ type: 'message', message, awaiting: 'node', moveoptions });
				if (moveoptions[resp]) return resp;
			}
		};
		const a = await pick('Choose the first stone to swap.', null);
		const b = await pick('Choose the second stone to swap.', a);
		const tmp = board.stones[a];
		board.stones[a] = board.stones[b];
		board.stones[b] = tmp;
		board.lastPlay = null;
		board.lastPlayer = null;
		board.update();
		emit(board.getBoardStatePayload());
	},

	// --- Panda: Blood Saplings (2 soft moves if you crushed a stone this turn) ---
	async blood_saplings(board, color, spellName, getInput, emit) {
		if (!board.crushedThisTurn) {
			emit({ type: 'message', message: 'You did not crush a stone this turn; Blood Saplings fizzles.', awaiting: null });
			return;
		}
		for (let i = 0; i < 2; i++) {
			const targets = getSoftMoveTargets(board, color);
			if (Object.keys(targets).length === 0) {
				emit({ type: 'message', message: 'No legal soft moves.', awaiting: null });
				break;
			}
			while (true) {
				const resp = await getInput({
					type: 'message', message: 'Choose where to soft move.',
					awaiting: 'node', moveoptions: targets,
				});
				if (!targets[resp]) continue;
				board.stones[resp] = color;
				emit({ type: 'new_stone_animation', color, node: resp });
				board.lastPlay = resp;
				board.lastPlayer = color;
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	// --- Panda: Itch (1 move, then advance the enemy lock by 1) ---
	async itch(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		const moveoptions = getAllMoveTargets(board, color);
		if (Object.keys(moveoptions).length > 0) {
			while (true) {
				const resp = await getInput({
					type: 'message', message: 'Choose where to move.',
					awaiting: 'node', moveoptions,
				});
				if (!moveoptions[resp]) continue;
				if (board.stones[resp] === enemy) {
					await doPushEnemy(board, resp, color, getInput, emit);
				} else {
					board.stones[resp] = color;
					emit({ type: 'new_stone_animation', color, node: resp });
					board.lastPlay = resp;
					board.lastPlayer = color;
				}
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		} else {
			emit({ type: 'message', message: 'No legal moves.', awaiting: null });
		}
		// Advance the enemy lock (spell counter). Safe to push to 6: the
		// counter-based loss only fires via checkGameOver(enemy) on the
		// enemy's own turn, never on the caster's.
		board.spellCounter[enemy] = Math.min(6, board.spellCounter[enemy] + 1);
		emit({ type: 'message', message: 'Enemy lock advanced by 1.', awaiting: null });
		board.update();
		emit(board.getBoardStatePayload());
	},

	// --- Panda: Free Spirit (1 soft move if your lock is 0 or 1) ---
	async free_spirit(board, color, spellName, getInput, emit) {
		if (board.spellCounter[color] > 1) {
			emit({ type: 'message', message: 'Your lock is too high; Free Spirit fizzles.', awaiting: null });
			return;
		}
		const targets = getSoftMoveTargets(board, color);
		if (Object.keys(targets).length === 0) {
			emit({ type: 'message', message: 'No legal soft moves.', awaiting: null });
			return;
		}
		while (true) {
			const resp = await getInput({
				type: 'message', message: 'Choose where to soft move.',
				awaiting: 'node', moveoptions: targets,
			});
			if (!targets[resp]) continue;
			board.stones[resp] = color;
			emit({ type: 'new_stone_animation', color, node: resp });
			board.lastPlay = resp;
			board.lastPlayer = color;
			board.update();
			emit(board.getBoardStatePayload());
			break;
		}
	},

	// --- Panda: Residue Mixture (if your lock is higher, convert 1 enemy stone + advance enemy lock) ---
	async residue_mixture(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		if (board.spellCounter[color] <= board.spellCounter[enemy]) {
			emit({ type: 'message', message: 'Your lock is not higher than the enemy lock; Residue Mixture fizzles.', awaiting: null });
			return;
		}
		const hasEnemy = NODE_ORDER.some(n => board.stones[n] === enemy);
		if (hasEnemy) {
			while (true) {
				const moveoptions = {};
				for (const n of NODE_ORDER) if (board.stones[n] === enemy) moveoptions[n] = enemy;
				const resp = await getInput({
					type: 'message', message: 'Choose an enemy stone to convert to your color.',
					awaiting: 'node', moveoptions,
				});
				if (board.stones[resp] === enemy) {
					board.stones[resp] = color;
					emit({ type: 'new_stone_animation', color, node: resp });
					board.update();
					emit(board.getBoardStatePayload());
					break;
				}
			}
		} else {
			emit({ type: 'message', message: 'No enemy stones to convert.', awaiting: null });
		}
		board.spellCounter[enemy] = Math.min(6, board.spellCounter[enemy] + 1);
		emit({ type: 'message', message: 'Enemy lock advanced by 1.', awaiting: null });
		board.update();
		emit(board.getBoardStatePayload());
	},

	// --- Panda: Stampede (hard moves equal to your lock value) ---
	async stampede(board, color, spellName, getInput, emit) {
		// Lock value = current spell counter (this sorcery's own increment
		// happens after resolution, so this reads the pre-cast value 0–5).
		const count = Math.min(5, board.spellCounter[color]);
		if (count === 0) {
			emit({ type: 'message', message: 'Your lock is 0; Stampede does nothing.', awaiting: null });
			return;
		}
		for (let i = 0; i < count; i++) {
			const targets = getHardMoveTargets(board, color);
			if (Object.keys(targets).length === 0) {
				emit({ type: 'message', message: 'No legal hard moves.', awaiting: null });
				break;
			}
			while (true) {
				const resp = await getInput({
					type: 'message', message: `Choose where to hard move (${i + 1} of ${count}).`,
					awaiting: 'node', moveoptions: targets,
				});
				if (!targets[resp]) continue;
				await doPushEnemy(board, resp, color, getInput, emit);
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
			if (board.gameover) return;
		}
	},

	// --- Panda: Choke (occupy every empty node adjacent to a chosen enemy stone) ---
	async choke(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		if (!NODE_ORDER.some(n => board.stones[n] === enemy)) {
			emit({ type: 'message', message: 'No enemy stones to choke.', awaiting: null });
			return;
		}
		let chosen = null;
		while (chosen === null) {
			const moveoptions = {};
			for (const n of NODE_ORDER) if (board.stones[n] === enemy) moveoptions[n] = enemy;
			const resp = await getInput({
				type: 'message', message: 'Choose an enemy stone to choke.',
				awaiting: 'node', moveoptions,
			});
			if (board.stones[resp] === enemy) chosen = resp;
		}
		for (const nb of ADJACENCY[chosen]) {
			if (board.stones[nb] === null) {
				board.stones[nb] = color;
				emit({ type: 'new_stone_animation', color, node: nb });
				board.lastPlay = nb;
				board.lastPlayer = color;
			}
		}
		board.update();
		emit(board.getBoardStatePayload());
	},

	// --- Panda: Perfect Heist (clear the mana nodes, then occupy all three) ---
	async perfect_heist(board, color, spellName, getInput, emit) {
		const enemy = board.enemy(color);
		for (const n of MANA_NODES) {
			if (board.stones[n] === enemy) {
				emit({ type: 'crush_animation', crushed_color: enemy, node: n });
			}
			board.stones[n] = color;
			emit({ type: 'new_stone_animation', color, node: n });
		}
		board.lastPlay = null;
		board.lastPlayer = null;
		board.update();
		emit(board.getBoardStatePayload());
	},

	// --- Panda: Moth Plague (3 hard blink moves — push any enemy stone) ---
	async moth_plague(board, color, spellName, getInput, emit) {
		for (let i = 0; i < 3; i++) {
			const enemy = board.enemy(color);
			if (!NODE_ORDER.some(n => board.stones[n] === enemy)) {
				emit({ type: 'message', message: 'No enemy stones remain.', awaiting: null });
				break;
			}
			let chosen = null;
			while (chosen === null) {
				const moveoptions = {};
				for (const n of NODE_ORDER) if (board.stones[n] === enemy) moveoptions[n] = enemy;
				const resp = await getInput({
					type: 'message', message: `Choose an enemy stone to push (${i + 1} of 3).`,
					awaiting: 'node', moveoptions,
				});
				if (board.stones[resp] === enemy) chosen = resp;
			}
			await doPushEnemy(board, chosen, color, getInput, emit);
			board.update();
			emit(board.getBoardStatePayload());
			if (board.gameover) return;
		}
	},

	// --- Panda: Ripples (apply two charged 1-node spells' effects twice) ---
	async ripples(board, color, spellName, getInput, emit) {
		const candidates = [];
		for (const pos of [7, 8, 9]) {
			const sn = board.spellNames[pos - 1];
			const info = CORE_SPELLS[sn];
			if (!info || info.static || !info.resolve) continue;
			if (board.stones[POSITIONS[pos][0]] !== color) continue;
			candidates.push(sn);
		}
		if (candidates.length === 0) {
			emit({ type: 'message', message: 'No charged 1-node spells to ripple.', awaiting: null });
			return;
		}
		const chosen = [];
		const pickCount = Math.min(2, candidates.length);
		for (let k = 0; k < pickCount; k++) {
			const remaining = candidates.filter(sn => !chosen.includes(sn));
			if (remaining.length === 0) break;
			if (remaining.length === 1) { chosen.push(remaining[0]); break; }
			while (true) {
				const moveoptions = {};
				for (const sn of remaining) moveoptions[POSITIONS[board.spellNames.indexOf(sn) + 1][0]] = color;
				const resp = await getInput({ type: 'message', message: `Choose 1-node spell ${k + 1} of ${pickCount} to apply twice.`, awaiting: 'node', moveoptions });
				const pos = spellPositionOfNode(resp);
				const sn = pos ? board.spellNames[pos - 1] : null;
				if (sn && remaining.includes(sn)) { chosen.push(sn); break; }
			}
		}
		for (const sn of chosen) {
			const info = CORE_SPELLS[sn];
			for (let rep = 0; rep < 2; rep++) {
				if (SpellResolvers[info.resolve]) {
					emit({ type: 'message', message: `Ripples: ${sn.replace(/_/g, ' ')} (${rep + 1} of 2).`, awaiting: null });
					await SpellResolvers[info.resolve](board, color, sn, getInput, emit);
					board.update();
					emit(board.getBoardStatePayload());
				}
			}
		}
	},
};

/**
 * Execute a push-enemy interaction. Claims the node for color,
 * does BFS to find push destinations, handles animation + player choice.
 */
async function doPushEnemy(board, nodeName, color, getInput, emit) {
	const enemy = board.enemy(color);

	// Resolve the push outcome BEFORE mutating the board, so the
	// intermediate state — where the enemy stone has been overwritten
	// but not yet pushed/crushed — never triggers update()'s
	// zero-stones immediate-loss rule. Without this, hard-moving the
	// enemy's only stone (e.g. on red's third turn of a competitive
	// game while blue has just one opening stone) briefly drops the
	// enemy count to 0 mid-animation; update() then ends the game
	// with a false "red wins" before the push destination is applied.
	// findPushOptions does not require fromNode to already be `color`
	// — it just adds fromNode to the visited set. So we can compute
	// the push outcome with the board still in its pre-move state.
	const { options, crushed } = findPushOptions(board, nodeName, color);

	// Atomic apply: do all stone mutations together, then a single
	// update() at the end. The new_stone_animation / push_animation
	// emits drive the UI's per-action visuals; getBoardStatePayload
	// is what feeds reactive state, and we hold that until after the
	// mutations are settled.
	board.stones[nodeName] = color;
	board.lastPlay = nodeName;
	board.lastPlayer = color;
	emit({ type: 'new_stone_animation', color, node: nodeName });

	if (crushed) {
		board.crushedThisTurn = true;
		emit({ type: 'crush_animation', crushed_color: enemy, node: nodeName });
		emit({ type: 'message', message: 'Enemy stone crushed!', awaiting: null });
		board.update();
		emit(board.getBoardStatePayload());
		return;
	}

	if (options.length === 1) {
		const dest = options[0];
		board.stones[dest] = enemy;
		emit({ type: 'push_animation', pushed_color: enemy, starting_node: nodeName, ending_node: dest });
		board.update();
		emit(board.getBoardStatePayload());
		return;
	}

	// Multiple options: player chooses. The enemy stone is currently
	// "in transit" (overwritten at fromNode, not yet at dest), so we
	// must defer update() until the choice lands.
	while (true) {
		const pushingPayload = { type: 'pushingoptions', sourceNode: nodeName };
		for (const opt of options) {
			pushingPayload[opt] = enemy;
		}
		emit(pushingPayload);

		const resp = await getInput({
			type: 'message',
			message: 'Choose where to push the enemy stone.',
			awaiting: 'node',
			moveoptions: {},
		});

		if (options.includes(resp)) {
			board.stones[resp] = enemy;
			emit({ type: 'push_animation', pushed_color: enemy, starting_node: nodeName, ending_node: resp });
			board.update();
			emit(board.getBoardStatePayload());
			return;
		}
	}
}
