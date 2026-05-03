/**
 * AI player implementations for Sigil.
 *
 * GreedyAI: strategic evaluation (easy difficulty)
 * NeuralAI: uses SigilNet + MCTS (medium difficulty)
 */

class GreedyAI {
	pickTurn(board, color) {
		const simBoard = SimBoard.fromSigilBoard(board);
		const turns = [...simBoard.getLegalTurns(color)];
		if (!turns.length) return new SimTurn([new SimAction('pass')]);

		let bestTurn = turns[0];
		let bestScore = -Infinity;

		for (const turn of turns) {
			const score = this._scoreTurn(simBoard, turn, color);
			if (score > bestScore) {
				bestScore = score;
				bestTurn = turn;
			}
		}

		return bestTurn;
	}

	_scoreTurn(originalBoard, turn, color) {
		const enemy = color === 'red' ? 'blue' : 'red';
		let score = 0;
		// Work on a copy so scoring doesn't mutate the original
		const board = originalBoard.copy();

		for (const action of turn.actions) {
			if (action.type === 'move' || action.type === 'hard_move' || action.type === 'blink') {
				score += this._scoreMoveTarget(board, action.node, color, action.type === 'blink');
			} else if (action.type === 'dash' || action.type === 'dash_lightning') {
				score += this._scoreDash(board, color, action.type === 'dash_lightning');
			} else if (action.type === 'cast') {
				score += this._evaluateSpell(board, action.spell, color);
			}
			// Apply the action to the board copy so subsequent scoring sees updated state
			if (action.type === 'move') {
				board.stones[action.node] = color;
			} else if (action.type === 'hard_move' || action.type === 'blink') {
				if (board.stones[action.node] === enemy) {
					board._pushEnemy(action.node, color);
				} else {
					board.stones[action.node] = color;
				}
			} else if (action.type === 'dash' || action.type === 'dash_lightning') {
				if (action.sacrificed) {
					for (const sac of action.sacrificed) board.stones[sac] = null;
				}
			} else if (action.type === 'cast') {
				board._castSpell(action.spell, color);
			}
			board.update();
		}

		return score;
	}

	_stoneAdvantage(board, color) {
		if (color === 'red') {
			return board.totalStones.red - (board.totalStones.blue + 1);
		} else {
			return (board.totalStones.blue + 1) - board.totalStones.red;
		}
	}

	_scoreMoveTarget(board, nodeName, color, isBlink) {
		const enemy = color === 'red' ? 'blue' : 'red';
		let score = 0;

		// Mana nodes are very valuable
		if (nodeName === 'a1' || nodeName === 'b1' || nodeName === 'c1') {
			score += 10;
		}

		// Prefer soft moves over hard moves
		if (board.stones[nodeName] === null) {
			score += 3;
		} else {
			if (nodeName === 'a1' || nodeName === 'b1' || nodeName === 'c1') {
				score += 5;
			} else {
				score += 1;
			}
		}

		// Spell charging: prefer nodes that help complete a spell charge
		for (let i = 0; i < board.spellNames.length; i++) {
			const posNodes = POSITIONS[i + 1];
			if (!posNodes || !posNodes.includes(nodeName)) continue;
			const info = CORE_SPELLS[board.spellNames[i]];
			if (info && info.static) continue;
			const ownCount = posNodes.filter(n => board.stones[n] === color).length;
			const total = posNodes.length;
			if (ownCount === total - 1) {
				score += 6;
			} else if (ownCount >= total - 2) {
				score += 3;
			} else if (ownCount >= 1) {
				score += 1;
			}
		}

		// Connectivity: prefer moves adjacent to own stones
		const neighbors = ADJACENCY[nodeName];
		let ownNeighbors = 0;
		let enemyNeighbors = 0;
		for (const nb of neighbors) {
			if (board.stones[nb] === color) ownNeighbors++;
			else if (board.stones[nb] === enemy) enemyNeighbors++;
		}
		score += ownNeighbors;
		score += enemyNeighbors * 0.5;

		// Avoid placing into our own locked spell position
		const lockSpell = board.lock[color];
		if (lockSpell) {
			const lockIdx = board.spellNames.indexOf(lockSpell);
			if (lockIdx >= 0) {
				const lockNodes = POSITIONS[lockIdx + 1];
				if (lockNodes && lockNodes.includes(nodeName)) {
					score -= 4;
				}
			}
		}

		// Blink filter: require at least 2 non-enemy adjacent (like Python)
		if (isBlink) {
			let nonEnemyAdj = board.stones[nodeName] === null ? 1 : 0;
			for (const nb of neighbors) {
				if (board.stones[nb] !== enemy) nonEnemyAdj++;
			}
			if (nonEnemyAdj <= 1) {
				score -= 20;
			}
		}

		return score;
	}

	_scoreDash(board, color, isLightning) {
		const enemy = color === 'red' ? 'blue' : 'red';
		const adv = this._stoneAdvantage(board, color);

		if (isLightning) {
			return adv >= 2 ? 3 : -100;
		} else {
			return (adv >= 3 && board.totalStones[color] > 4) ? 3 : -100;
		}
	}

	_evaluateSpell(board, spellName, color) {
		const enemy = color === 'red' ? 'blue' : 'red';
		const info = CORE_SPELLS[spellName];

		// For non-charm spells, consider stone cost
		if (info && !info.ischarm) {
			const idx = board.spellNames.indexOf(spellName);
			const posNodes = POSITIONS[idx + 1];
			if (posNodes) {
				const stonesInPosition = posNodes.filter(n => board.stones[n] === color).length;
				const refills = board.mana[color];
				const netCost = stonesInPosition - refills;
				if (netCost > 1 && this._stoneAdvantage(board, color) < 2) {
					return -1;
				}
			}
		}

		if (spellName === 'Carnage') {
			const targets = this._countHardMoveTargets(board, color, spellName);
			if (targets >= 2) return 8;
			if (targets >= 1) return 4;
			return -1;
		}
		if (spellName === 'Starfall') {
			return this._starfallTargetExists(board, color) ? 7 : -1;
		}
		if (spellName === 'Bewitch') {
			return this._bewitchTargetExists(board, color) ? 6 : -1;
		}
		if (spellName === 'Flourish') return 5;
		if (spellName === 'Fireblast') {
			const targets = this._countHardMoveTargets(board, color, spellName);
			return targets >= 2 ? 5 : -1;
		}
		if (spellName === 'Hail_Storm') {
			const count = this._hailableSpellCount(board, color);
			return count >= 2 ? count * 2 : -1;
		}
		if (spellName === 'Meteor') return 4;
		if (spellName === 'Grow') return 3;
		if (spellName === 'Comet') {
			return this._cometTargetExists(board, color) ? 3 : -1;
		}
		if (spellName === 'Surge') return 2;
		if (spellName === 'Slash') {
			const targets = this._countHardMoveTargets(board, color, spellName);
			return targets >= 1 ? 2 : -1;
		}
		if (spellName === 'Sprout') return 2;
		return 1;
	}

	_countHardMoveTargets(board, color, spellName) {
		const enemy = color === 'red' ? 'blue' : 'red';
		// Get spell position nodes to exclude as adjacency sources (like Python)
		const idx = board.spellNames.indexOf(spellName);
		const spellPosNodes = idx >= 0 ? (POSITIONS[idx + 1] || []) : [];

		let count = 0;
		for (const name of NODE_ORDER) {
			if (board.stones[name] === enemy) {
				let adjacent = false;
				for (const nb of ADJACENCY[name]) {
					if (!spellPosNodes.includes(nb) && board.stones[nb] === color) {
						adjacent = true;
						break;
					}
				}
				if (adjacent) count++;
			}
		}
		return count;
	}

	_hailableSpellCount(board, color) {
		const enemy = color === 'red' ? 'blue' : 'red';
		let count = 0;
		for (let i = 1; i <= 6; i++) {
			const nodes = POSITIONS[i];
			for (const n of nodes) {
				if (board.stones[n] === enemy) { count++; break; }
			}
		}
		return count;
	}

	_bewitchTargetExists(board, color) {
		const enemy = color === 'red' ? 'blue' : 'red';
		for (const name of NODE_ORDER) {
			if (board.stones[name] === enemy) {
				for (const nb of ADJACENCY[name]) {
					if (board.stones[nb] === enemy) return true;
				}
			}
		}
		return false;
	}

	_cometTargetExists(board, color) {
		const enemy = color === 'red' ? 'blue' : 'red';
		for (const mn of MANA_NODES) {
			let alreadyTouching = false;
			let adjEnemyCount = 0;
			if (board.stones[mn] === color) {
				alreadyTouching = true;
			} else {
				if (board.stones[mn] === enemy) adjEnemyCount++;
				for (const nb of ADJACENCY[mn]) {
					if (board.stones[nb] === color) alreadyTouching = true;
					else if (board.stones[nb] === enemy) adjEnemyCount++;
				}
			}
			if (!alreadyTouching && adjEnemyCount < 2) return true;
		}
		return false;
	}

	_starfallTargetExists(board, color) {
		const enemy = color === 'red' ? 'blue' : 'red';
		for (const name of NODE_ORDER) {
			if (board.stones[name] !== null) continue;
			let adjToEmpty = false;
			let adjEnemyCount = 0;
			for (const nb of ADJACENCY[name]) {
				if (board.stones[nb] === null) adjToEmpty = true;
				else if (board.stones[nb] === enemy) adjEnemyCount++;
			}
			if (adjToEmpty && adjEnemyCount > 1) return true;
		}
		return false;
	}
}

class NeuralAI {
	constructor(model, numSimulations) {
		this.model = model;
		this.numSimulations = numSimulations || MCTS_DEFAULT_SIMS;
	}

	pickTurn(board, color) {
		const simBoard = SimBoard.fromSigilBoard(board);
		const { turn } = mctsSearch(simBoard, color, this.model, this.numSimulations);
		return turn;
	}
}

/**
 * Apply a SimTurn to a real SigilBoard with UI events.
 * This replays the AI's chosen actions with proper animations.
 */
async function applyAITurn(board, turn, color, emit) {
	const enemy = board.enemy(color);

	for (const action of turn.actions) {
		if (action.type === 'pass') {
			continue;
		}

		if (action.type === 'move') {
			board.stones[action.node] = color;
			emit({ type: 'new_stone_animation', color, node: action.node });
			board.lastPlay = action.node;
			board.lastPlayer = color;
			board.update();
			emit(board.getBoardStatePayload());
			await _aiDelay(400);
		}

		else if (action.type === 'hard_move' || (action.type === 'blink' && board.stones[action.node] === enemy)) {
			// Push enemy
			board.stones[action.node] = color;
			emit({ type: 'new_stone_animation', color, node: action.node });
			board.lastPlay = action.node;
			board.lastPlayer = color;
			board.update();
			emit(board.getBoardStatePayload());

			// Find where enemy goes using BFS (same as engine)
			const pushResult = findPushOptions(board, action.node, color);
			if (pushResult.crushed) {
				emit({ type: 'crush_animation', crushed_color: enemy, node: action.node });
			} else if (pushResult.options.length > 0) {
				const dest = pushResult.options[0];
				board.stones[dest] = enemy;
				emit({ type: 'push_animation', pushed_color: enemy, starting_node: action.node, ending_node: dest });
			}
			board.update();
			emit(board.getBoardStatePayload());
			await _aiDelay(600);
		}

		else if (action.type === 'blink') {
			board.stones[action.node] = color;
			emit({ type: 'new_stone_animation', color, node: action.node });
			board.lastPlay = action.node;
			board.lastPlayer = color;
			board.update();
			emit(board.getBoardStatePayload());
			await _aiDelay(400);
		}

		else if (action.type === 'dash' || action.type === 'dash_lightning') {
			if (action.sacrificed) {
				for (const sac of action.sacrificed) {
					board.stones[sac] = null;
					if (board.lastPlay === sac) { board.lastPlay = null; board.lastPlayer = null; }
				}
				board.update();
				emit(board.getBoardStatePayload());
				emit({ type: 'message', message: 'Opponent dashes!', awaiting: null });
				await _aiDelay(500);
			}
		}

		else if (action.type === 'cast') {
			const spellName = action.spell;
			const info = CORE_SPELLS[spellName];
			const spellIdx = board.spellNames.indexOf(spellName);
			const posNodes = POSITIONS[spellIdx + 1];

			const pname = color[0].toUpperCase() + color.slice(1);
			emit({ type: 'message', message: pname + ' casts ' + spellName.replace(/_/g, ' '), awaiting: null });

			// Sacrifice stones in position
			for (const n of posNodes) {
				board.stones[n] = null;
				if (board.lastPlay === n) { board.lastPlay = null; board.lastPlayer = null; }
			}
			board.update();
			emit(board.getBoardStatePayload());
			await _aiDelay(500);

			// Refill (non-charms)
			if (!info.ischarm && action.kept && action.kept.length > 0) {
				for (const n of action.kept) {
					board.stones[n] = color;
				}
				board.update();
				emit(board.getBoardStatePayload());
				await _aiDelay(400);
			}

			// Lock management
			if (!info.ischarm) {
				if (board.lock[color] === spellName) {
					board.springlock[color] = spellName;
					emit({ type: 'message', message: spellName.replace(/_/g, ' ') + ' is Springlocked for ' + pname, awaiting: null });
				} else {
					board.lock[color] = spellName;
					board.springlock[color] = null;
				}
				board.spellCounter[color]++;
			}
			board.update();
			emit(board.getBoardStatePayload());
		}

		// Spell-specific resolution actions
		else if (action.type === 'fireblast') {
			if (action.destroyed) {
				for (const n of action.destroyed) board.stones[n] = null;
				board.update();
				emit(board.getBoardStatePayload());
				await _aiDelay(400);
			}
		}

		else if (action.type === 'hail_storm') {
			if (action.destroyed) {
				for (const n of action.destroyed) {
					board.stones[n] = null;
					board.update();
					emit(board.getBoardStatePayload());
					await _aiDelay(300);
				}
			}
		}

		else if (action.type === 'bewitch') {
			if (action.node) {
				board.stones[action.node] = color;
				emit({ type: 'new_stone_animation', color, node: action.node });
				board.update();
				emit(board.getBoardStatePayload());
				await _aiDelay(400);
			}
			if (action.node2) {
				board.stones[action.node2] = color;
				emit({ type: 'new_stone_animation', color, node: action.node2 });
				board.update();
				emit(board.getBoardStatePayload());
				await _aiDelay(400);
			}
		}

		else if (action.type === 'starfall') {
			if (action.node) {
				board.stones[action.node] = color;
				emit({ type: 'new_stone_animation', color, node: action.node });
				board.update();
				emit(board.getBoardStatePayload());
				await _aiDelay(300);
			}
			if (action.node2) {
				board.stones[action.node2] = color;
				emit({ type: 'new_stone_animation', color, node: action.node2 });
				board.update();
				emit(board.getBoardStatePayload());
				await _aiDelay(300);
			}
			if (action.destroyed) {
				for (const n of action.destroyed) board.stones[n] = null;
				board.update();
				emit(board.getBoardStatePayload());
				await _aiDelay(400);
			}
		}

		else if (action.type === 'meteor_destroy') {
			if (action.node) {
				board.stones[action.node] = null;
				board.update();
				emit(board.getBoardStatePayload());
				await _aiDelay(400);
			}
		}

		else if (action.type === 'sacrifice') {
			if (action.node) {
				board.stones[action.node] = null;
				if (board.lastPlay === action.node) { board.lastPlay = null; board.lastPlayer = null; }
				board.update();
				emit(board.getBoardStatePayload());
				await _aiDelay(400);
			}
		}
	}
}

function _aiDelay(ms) {
	return new Promise(r => setTimeout(r, ms));
}
