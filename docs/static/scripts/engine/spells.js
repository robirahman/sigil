// Spell resolution functions for human-interactive play.
// Each spell's resolve is an async function that uses getInput() to prompt the player.
//
// getInput(payload) sends a message/event to the UI and returns a Promise
// that resolves with the player's response (a node name, etc.).

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
};

/**
 * Execute a push-enemy interaction. Claims the node for color,
 * does BFS to find push destinations, handles animation + player choice.
 */
async function doPushEnemy(board, nodeName, color, getInput, emit) {
	const enemy = board.enemy(color);
	board.stones[nodeName] = color;

	emit({ type: 'new_stone_animation', color, node: nodeName });
	board.lastPlay = nodeName;
	board.lastPlayer = color;
	board.update();
	emit(board.getBoardStatePayload());

	const { options, crushed } = findPushOptions(board, nodeName, color);

	if (crushed) {
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

	// Multiple options: player chooses
	while (true) {
		const pushingPayload = { type: 'pushingoptions' };
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
