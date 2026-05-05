/**
 * Spell resolution functions for the Cataclysm engine.
 * Adapted for multi-player: "enemy" means any non-self, non-teammate color.
 */

const CatSpellResolvers = {

	async soft_moves(board, color, spellName, getInput, emit) {
		const count = CORE_SPELLS[spellName].count;
		for (let i = 0; i < count; i++) {
			const targets = catGetSoftMoveTargets(board, color);
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

	async hard_moves(board, color, spellName, getInput, emit) {
		const count = CORE_SPELLS[spellName].count;
		for (let i = 0; i < count; i++) {
			const targets = catGetHardMoveTargets(board, color);
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
				if (!targets[resp]) continue;
				await catDoPushEnemy(board, resp, color, getInput, emit);
				board.update();
				emit(board.getBoardStatePayload());
				break;
			}
		}
	},

	async fireblast(board, color, spellName, getInput, emit) {
		const adj = board.mapDef.adjacency;
		for (const name of board.nodeOrder) {
			if (board.isEnemy(board.stones[name], color)) {
				for (const nb of adj[name]) {
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

	async hail_storm(board, color, spellName, getInput, emit) {
		const positions = board.mapDef.spellPositions;
		// Find which non-charm spell positions (1-6) have enemy stones
		const hailableSpells = [];
		for (let i = 1; i <= 6; i++) {
			const nodes = positions[i];
			if (!nodes) continue;
			for (const n of nodes) {
				if (board.isEnemy(board.stones[n], color)) {
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
			if (!board.isEnemy(board.stones[resp], color)) continue;

			for (let j = 0; j < hailableSpells.length; j++) {
				const spellIdx = hailableSpells[j];
				if (positions[spellIdx].includes(resp)) {
					board.stones[resp] = null;
					if (board.lastPlay === resp) {
						board.lastPlay = null;
						board.lastPlayer = null;
					}
					hailableSpells.splice(j, 1);
					board.update();
					emit(board.getBoardStatePayload());
					break;
				}
			}
		}
	},

	async bewitch(board, color, spellName, getInput, emit) {
		const adj = board.mapDef.adjacency;

		// Step 1: pick first enemy stone (must be adjacent to another enemy of the same color)
		let firstNode = null;
		while (true) {
			const options = {};
			for (const name of board.nodeOrder) {
				if (board.isEnemy(board.stones[name], color)) {
					const stoneColor = board.stones[name];
					let adjToSameEnemy = false;
					for (const nb of adj[name]) {
						if (board.stones[nb] === stoneColor) { adjToSameEnemy = true; break; }
					}
					if (adjToSameEnemy) options[name] = color;
				}
			}

			if (Object.keys(options).length === 0) return;

			const resp = await getInput({
				type: 'message',
				message: 'Choose 2 enemy stones to convert.',
				awaiting: 'node',
				moveoptions: options,
			});

			if (options[resp]) {
				firstNode = resp;
				const targetColor = board.stones[firstNode];
				board.stones[firstNode] = color;
				emit({ type: 'new_stone_animation', color, node: firstNode });
				board.update();
				emit(board.getBoardStatePayload());

				// Step 2: pick adjacent stone of the same enemy color
				while (true) {
					const secondOptions = {};
					for (const nb of adj[firstNode]) {
						if (board.stones[nb] === targetColor) {
							secondOptions[nb] = color;
						}
					}

					const resp2 = await getInput({
						type: 'message', message: '', awaiting: 'node',
						moveoptions: secondOptions,
					});

					if (secondOptions[resp2]) {
						board.stones[resp2] = color;
						emit({ type: 'new_stone_animation', color, node: resp2 });
						board.update();
						emit(board.getBoardStatePayload());
						return;
					}
				}
			}
		}
	},

	async starfall(board, color, spellName, getInput, emit) {
		const adj = board.mapDef.adjacency;

		// Step 1: pick first empty node (must be adjacent to another empty)
		let firstNode = null;
		while (true) {
			const options = {};
			for (const name of board.nodeOrder) {
				if (board.stones[name] === null) {
					let adjToEmpty = false;
					for (const nb of adj[name]) {
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
			for (const nb of adj[firstNode]) {
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
			...adj[firstNode],
			...adj[secondNode],
		]);
		for (const nb of neighborUnion) {
			if (board.isEnemy(board.stones[nb], color)) {
				board.stones[nb] = null;
			}
		}
		board.update();
		emit(board.getBoardStatePayload());
	},

	async meteor(board, color, spellName, getInput, emit) {
		const adj = board.mapDef.adjacency;

		// Step 1: blink move
		let landedNode = null;
		while (true) {
			const moveoptions = catGetBlinkTargets(board, color);
			const resp = await getInput({
				type: 'message', message: 'Make 1 blink move.',
				awaiting: 'node', moveoptions,
			});

			if (!moveoptions[resp]) continue;

			if (board.isEnemy(board.stones[resp], color)) {
				await catDoPushEnemy(board, resp, color, getInput, emit);
				landedNode = resp;
				break;
			} else if (board.stones[resp] === null) {
				board.stones[resp] = color;
				emit({ type: 'new_stone_animation', color, node: resp });
				board.update();
				emit(board.getBoardStatePayload());
				landedNode = resp;
				break;
			}
		}

		// Step 2: destroy 1 adjacent enemy
		const adjEnemies = adj[landedNode].filter(nb => board.isEnemy(board.stones[nb], color));
		if (adjEnemies.length === 0) return;
		if (adjEnemies.length === 1) {
			board.stones[adjEnemies[0]] = null;
			board.update();
			emit(board.getBoardStatePayload());
			return;
		}

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

	async comet(board, color, spellName, getInput, emit) {
		// Step 1: blink move
		while (true) {
			const moveoptions = catGetBlinkTargets(board, color);
			const resp = await getInput({
				type: 'message', message: 'Make 1 blink move.',
				awaiting: 'node', moveoptions,
			});
			if (!moveoptions[resp]) continue;

			if (board.stones[resp] === color) continue;
			if (board.isEnemy(board.stones[resp], color)) {
				await catDoPushEnemy(board, resp, color, getInput, emit);
				break;
			} else {
				board.stones[resp] = color;
				emit({ type: 'new_stone_animation', color, node: resp });
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

	async surge_move(board, color, spellName, getInput, emit) {
		const moveoptions = catGetAllMoveTargets(board, color);
		if (Object.keys(moveoptions).length === 0) return;

		while (true) {
			const resp = await getInput({
				type: 'message', message: 'Choose where to move.',
				awaiting: 'node', moveoptions,
			});
			if (!moveoptions[resp]) continue;

			if (board.stones[resp] === null) {
				board.stones[resp] = color;
				emit({ type: 'new_stone_animation', color, node: resp });
				board.lastPlay = resp;
				board.lastPlayer = color;
				board.update();
				emit(board.getBoardStatePayload());
				break;
			} else if (board.isEnemy(board.stones[resp], color)) {
				await catDoPushEnemy(board, resp, color, getInput, emit);
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
async function catDoPushEnemy(board, nodeName, color, getInput, emit) {
	const pushedColor = board.stones[nodeName];
	board.stones[nodeName] = color;

	emit({ type: 'new_stone_animation', color, node: nodeName });
	board.lastPlay = nodeName;
	board.lastPlayer = color;
	board.update();
	emit(board.getBoardStatePayload());

	const { options, crushed } = catFindPushOptions(board, nodeName, color);

	if (crushed) {
		emit({ type: 'crush_animation', crushed_color: pushedColor, node: nodeName });
		emit({ type: 'message', message: 'Enemy stone crushed!', awaiting: null });
		board.update();
		emit(board.getBoardStatePayload());
		return;
	}

	if (options.length === 1) {
		const dest = options[0];
		board.stones[dest] = pushedColor;
		emit({ type: 'push_animation', pushed_color: pushedColor, starting_node: nodeName, ending_node: dest });
		board.update();
		emit(board.getBoardStatePayload());
		return;
	}

	// Multiple options: player chooses
	while (true) {
		const pushingPayload = { type: 'pushingoptions' };
		for (const opt of options) {
			pushingPayload[opt] = pushedColor;
		}
		emit(pushingPayload);

		const resp = await getInput({
			type: 'message',
			message: 'Choose where to push the enemy stone.',
			awaiting: 'node',
			moveoptions: {},
		});

		if (options.includes(resp)) {
			board.stones[resp] = pushedColor;
			emit({ type: 'push_animation', pushed_color: pushedColor, starting_node: nodeName, ending_node: resp });
			board.update();
			emit(board.getBoardStatePayload());
			return;
		}
	}
}
