/**
 * AI player implementations for Sigil.
 *
 * GreedyAI: picks a random legal turn (easy difficulty)
 * NeuralAI: uses SigilNet + MCTS (medium difficulty)
 */

class GreedyAI {
	pickTurn(board, color) {
		const simBoard = SimBoard.fromSigilBoard(board);
		const turns = [...simBoard.getLegalTurns(color)];
		if (!turns.length) return new SimTurn([new SimAction('pass')]);
		// Pick a random turn, slightly biased toward ones that include spells
		const spellTurns = turns.filter(t => t.actions.some(a => a.type === 'cast'));
		if (spellTurns.length > 0 && Math.random() < 0.7) {
			return spellTurns[Math.floor(Math.random() * spellTurns.length)];
		}
		return turns[Math.floor(Math.random() * turns.length)];
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
