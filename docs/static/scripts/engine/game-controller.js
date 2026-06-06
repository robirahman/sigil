/**
 * GameController — replaces the Python server game loop for local play.
 *
 * Uses async/await with a Promise-based input mechanism.
 * The UI calls handlePlayerAction(message) which resolves the pending promise.
 */
class GameController {
	/**
	 * @param {Function} emitEvent - callback to send events to the UI
	 * @param {Object} [options]
	 * @param {string} [options.aiColor] - 'blue' if AI plays blue, null for local 2-player
	 * @param {Object} [options.ai] - AI player instance (GreedyAI or NeuralAI)
	 * @param {string[]} [options.spellNames] - 9-spell list to use instead of generating one (e.g. for "play again with same layout")
	 */
	constructor(emitEvent, options) {
		this.emit = emitEvent;
		this.board = null;
		this._inputResolve = null;
		this._resetRequested = false;
		this.aiColor = (options && options.aiColor) || null;
		this.ai = (options && options.ai) || null;
		this.spellNamesOverride = (options && Array.isArray(options.spellNames) && options.spellNames.length === 9)
			? options.spellNames.slice()
			: null;
		this.variant = normalizeVariant(options && options.variant);
		this._gameLog = [];
	}

	/** Called by UI when the player clicks a node, spell, dash, pass, or reset. */
	handlePlayerAction(message) {
		if (message === 'reset') {
			this._resetRequested = true;
			// Also resolve pending input so the async loop can unwind
			if (this._inputResolve) {
				this._inputResolve('__reset__');
				this._inputResolve = null;
			}
			return;
		}
		if (this._inputResolve) {
			const resolve = this._inputResolve;
			this._inputResolve = null;
			resolve(message);
		}
	}

	/** Returns a promise that resolves when the player acts. Sends the prompt payload to UI. */
	_waitForInput(payload) {
		this.emit(payload);
		return new Promise(resolve => {
			this._inputResolve = resolve;
		});
	}

	/** Convenience: get input and check for reset. Throws ResetError if reset requested. */
	async getInput(payload) {
		const resp = await this._waitForInput(payload);
		if (this._resetRequested) {
			throw new ResetError();
		}
		return resp;
	}

	async startGame(importSfn) {
		let spellNames = null;
		if (!importSfn) {
			if (this.spellNamesOverride) {
				spellNames = this.spellNamesOverride;
			} else {
				spellNames = generateSpellList(readStoredExpansions());
			}
		}
		this.board = new SigilBoard(spellNames, this.variant);

		if (importSfn) {
			this.board.loadFromSfn(importSfn);
			// loadFromSfn replays the imported state but doesn't change
			// `variant`. The imported SFN may carry its own variant
			// token; honor it when present.
			try {
				const imported = sfnToDict(importSfn);
				if (imported && imported.variant) this.board.variant = imported.variant;
			} catch (e) { /* tolerate non-strict imports */ }
		} else {
			this.board.setupInitial();
		}

		// Send spell setup
		const spellSetup = { type: 'spellsetup' };
		const spellTextSetup = { type: 'spelltextsetup' };
		const posNames = ['ritual1', 'ritual2', 'ritual3', 'sorcery1', 'sorcery2', 'sorcery3', 'charm1', 'charm2', 'charm3'];
		for (let i = 0; i < 9; i++) {
			const name = this.board.spellNames[i];
			spellSetup[posNames[i]] = name;
			spellTextSetup[posNames[i]] = {
				name: name.replace(/_/g, ' '),
				text: SPELL_TEXTS[name] || '',
			};
		}
		this.emit(spellSetup);
		this.emit(spellTextSetup);

		// Send initial board state
		this.board.update();
		this.emit(this.board.getBoardStatePayload());

		if (importSfn) {
			const nextTurn = this.board.turnCounter % 2 === 0 ? 'Red' : 'Blue';
			this.emit({ type: 'message', message: "Imported position \u2014 " + nextTurn + "'s turn.", awaiting: null });
		} else if (this.aiColor) {
			const humanColor = this.aiColor === 'red' ? 'Blue' : 'Red';
			this.emit({ type: 'message', message: "vs AI \u2014 You are " + humanColor + ". Red goes first.", awaiting: null });
		} else {
			this.emit({ type: 'message', message: "Local 1v1 \u2014 Red goes first.", awaiting: null });
		}

		// Send SFN
		this._emitSfn();

		// Small delay then start game loop
		await this._delay(500);
		this._runGameLoop();
	}

	_emitSfn() {
		const sfn = boardToSfn(this.board);
		this.emit({ type: 'sfn_update', sfn });
	}

	_delay(ms) {
		return new Promise(r => setTimeout(r, ms));
	}

	async _runGameLoop() {
		const board = this.board;
		let resetThisTurn = false;

		while (true) {
			try {
				if (!resetThisTurn) {
					const loopCount = board.takeSnapshot();
					// Threefold repetition: Blue wins on the 3rd occurrence (per
					// the rulebook). Same rule in every mode — the only mode
					// difference lives inside takeSnapshot's position key.
					if (loopCount === 2) {
						this.emit({ type: 'message', message: 'Repeated position: this board state has occurred twice. If it repeats once more, Blue wins by threefold repetition — play a different move to avoid it.', awaiting: null });
					} else if (loopCount >= 3) {
						this.emit({ type: 'message', message: 'Threefold repetition — Blue wins.', awaiting: null });
						board.gameover = true;
						board.winner = 'blue';
						this.emit({ type: 'game_over', winner: 'blue', gameLog: this._gameLog });
						return;
					}
				}

				board.turnCounter++;
				if (board.turnCounter % 2 === 1) {
					board.whoseTurn = 'red';
				} else {
					board.whoseTurn = 'blue';
				}

				const color = board.whoseTurn;
				let turnMsg;
				if (color === 'red') {
					turnMsg = 'Red Turn ' + (Math.floor(board.turnCounter / 2) + 1);
				} else {
					turnMsg = 'Blue Turn ' + Math.floor(board.turnCounter / 2);
				}
				this.emit({ type: 'whoseturndisplay', color, message: turnMsg });

				// Pondering: while the human is on move and there's an AI
				// opponent, fire a background search to prime the shared TT.
				// No move prediction — the search runs as the side-to-move
				// (the human) and accumulates TT entries the AI's real
				// search will reuse when it later searches from the post-
				// human-move SFN.
				if (this.ai && color !== this.aiColor
				    && typeof this.ai.startPonder === 'function') {
					try { this.ai.startPonder(board); } catch (_) { /* non-fatal */ }
				}

				// BOT triggers (Inferno check)
				if (board.chargedSpells[color].includes('Inferno')) {
					this.emit({ type: 'message', message: 'DEATH BY INFERNO!', awaiting: null });
					board.gameover = true;
					board.winner = board.enemy(color);
					if (this.ai && typeof this.ai.cancelPonder === 'function') {
						try { this.ai.cancelPonder(); } catch (_) { /* non-fatal */ }
					}
					this.emit({ type: 'game_over', winner: board.winner, gameLog: this._gameLog });
					return;
				}

				if (board.gameover) {
					// Stop any background ponder so it doesn't burn CPU
					// after the game ends.
					if (this.ai && typeof this.ai.cancelPonder === 'function') {
						try { this.ai.cancelPonder(); } catch (_) { /* non-fatal */ }
					}
					this.emit({ type: 'game_over', winner: board.winner, gameLog: this._gameLog });
					return;
				}

				// Take turn
				this._resetRequested = false;
				board.crushedThisTurn = false;
				const turnSfn = boardToSfn(board);

				if (this.ai && color === this.aiColor) {
					await this._takeAITurn(color);
				} else {
					await this._takeTurn(color, true, true, true, true);
				}

				// EOT triggers
				this._eotTriggers(color);

				board.update();
				this.emit(board.getBoardStatePayload());
				this._emitSfn();

				// Record turn for game review
				const turnEntry = {
					color: color,
					turnNumber: board.turnCounter,
					sfnBefore: turnSfn,
					sfnAfter: boardToSfn(board),
				};
				this._gameLog.push(turnEntry);
				this.emit({ type: 'turn_complete', turn: turnEntry });

				resetThisTurn = false;

				if (board.gameover) {
					// Stop any background ponder so it doesn't burn CPU
					// after the game ends.
					if (this.ai && typeof this.ai.cancelPonder === 'function') {
						try { this.ai.cancelPonder(); } catch (_) { /* non-fatal */ }
					}
					this.emit({ type: 'game_over', winner: board.winner, gameLog: this._gameLog });
					return;
				}

			} catch (e) {
				if (e instanceof ResetError) {
					this.emit({ type: 'message', message: 'Resetting Turn', awaiting: null });
					board.restoreSnapshot();
					this.emit(board.getBoardStatePayload());
					this._emitSfn();
					resetThisTurn = true;
					continue;
				}
				throw e;
			}
		}
	}

	async _takeTurn(color, canmove, candash, canspell, cansummer) {
		const board = this.board;
		board.update();

		// Competitive variant opening: this player has no stones yet —
		// their entire turn is a single free blink onto any empty node.
		if (canmove && variantHasCompetitive(board.variant) && board.totalStones[color] === 0) {
			const moveoptions = {};
			for (const n of NODE_ORDER) {
				if (board.stones[n] === null) moveoptions[n] = color;
			}
			const resp = await this.getInput({
				type: 'message',
				message: 'Place your first stone (Competitive opening).',
				awaiting: 'node',
				moveoptions,
			});
			if (moveoptions[resp]) {
				board.stones[resp] = color;
				board.lastPlay = resp;
				board.lastPlayer = color;
				board.update();
				this.emit({ type: 'new_stone_animation', color, node: resp });
				this.emit(board.getBoardStatePayload());
			}
			// Wait for an explicit end-turn so the player can hit Reset
			// before committing. AI players send 'pass' immediately via
			// _takeAITurn's competitive-opening path, so this awaits at
			// most a single click for humans and is invisible for AI.
			await this.getInput({
				type: 'message',
				message: 'Stone placed. End turn or reset.',
				awaiting: 'action',
				actionlist: ['pass'],
			});
			return;
		}

		const enemy = board.enemy(color);
		const actions = [];
		let spellList = [];
		let moveoptions = {};

		if (canmove) {
			actions.push('move');
			if (board.chargedSpells[color].includes('Seal_of_Wind')) {
				moveoptions = getBlinkTargets(board, color);
			} else {
				moveoptions = getAllMoveTargets(board, color);
			}
			// If no moves available, must pass
			if (Object.keys(moveoptions).length === 0) {
				return;
			}
		} else {
			// Post-move options
			if (candash && canspell && board.totalStones[color] > 2) {
				if (!board.chargedSpells[enemy].includes('Autumn')) {
					actions.push('dash');
				}
			}

			let summerActive = false;
			if (board.chargedSpells[color].includes('Seal_of_Summer') && cansummer) {
				summerActive = true;
			}

			if (canspell || (!canspell && summerActive)) {
				board.update();
				for (const spellName of board.chargedSpells[color]) {
					const info = CORE_SPELLS[spellName];
					if (!info || info.static) continue;

					if (info.ischarm) {
						if (board.chargedSpells[enemy].includes('Winter')) continue;
						if (spellName === 'Surge') {
							if (!candash) {
								actions.push(spellName);
								spellList.push(spellName);
							}
							continue;
						}
						if (spellName === 'Splash') {
							if (candash) {
								actions.push(spellName);
								spellList.push(spellName);
							}
							continue;
						}
						if (canspell || (!canspell && summerActive)) {
							actions.push(spellName);
							spellList.push(spellName);
						}
					} else {
						if (board.lock[color] === spellName) {
							if (board.chargedSpells[color].includes('Seal_of_Spring') && board.springlock[color] !== spellName) {
								actions.push(spellName);
								spellList.push(spellName);
							}
						} else {
							actions.push(spellName);
							spellList.push(spellName);
						}
					}
				}
			}

			actions.push('pass');
		}

		// Send action prompt
		const action = await this.getInput({
			type: 'message',
			message: canmove ? 'Choose where to move.' : String(actions),
			awaiting: 'action',
			actionlist: actions,
			moveoptions,
		});

		// Validate
		const nodeNames = Object.keys(board.stones);

		if (actions.includes('move') && nodeNames.includes(action)) {
			// Player clicked a node while 'move' was available (shortcut)
			await this._doMove(color, action, true);
			await this._takeTurn(color, false, candash, canspell, cansummer);
			return;
		}

		if (!actions.includes(action) && !nodeNames.includes(action)) {
			// Invalid — retry
			await this._takeTurn(color, canmove, candash, canspell, cansummer);
			return;
		}

		if (action === 'pass') {
			return;
		}

		if (action === 'dash') {
			const hasLightning = board.chargedSpells[color].includes('Seal_of_Lightning');
			await this._doDash(color, hasLightning);
			await this._takeTurn(color, canmove, false, canspell, cansummer);
			return;
		}

		if (spellList.includes(action)) {
			await this._castSpell(action, color);
			if (canspell) {
				await this._takeTurn(color, false, candash, false, cansummer);
			} else {
				await this._takeTurn(color, false, candash, false, false);
			}
			return;
		}
	}

	async _doMove(color, nodeName, standardMove) {
		const board = this.board;
		const node = nodeName;
		const enemy = board.enemy(color);
		const hasWind = standardMove && board.chargedSpells[color].includes('Seal_of_Wind');

		// Check adjacency
		let adjacent = false;
		for (const nb of ADJACENCY[node]) {
			if (board.stones[nb] === color) { adjacent = true; break; }
		}

		if (board.stones[node] === color) {
			// Invalid - own stone
			return this._promptMove(color, standardMove);
		}

		if (!adjacent && !hasWind) {
			return this._promptMove(color, standardMove);
		}

		if (!adjacent && hasWind) {
			// Blink move
			if (board.stones[node] === null) {
				board.stones[node] = color;
				this.emit({ type: 'new_stone_animation', color, node });
				board.lastPlay = node;
				board.lastPlayer = color;
				board.update();
				this.emit(board.getBoardStatePayload());
			} else if (board.stones[node] === enemy) {
				await doPushEnemy(board, node, color, this.getInput.bind(this), this.emit);
			}
			return;
		}

		if (board.stones[node] === null) {
			board.stones[node] = color;
			this.emit({ type: 'new_stone_animation', color, node });
			board.lastPlay = node;
			board.lastPlayer = color;
			board.update();
			this.emit(board.getBoardStatePayload());
		} else if (board.stones[node] === enemy) {
			await doPushEnemy(board, node, color, this.getInput.bind(this), this.emit);
		}
	}

	async _promptMove(color, standardMove) {
		const board = this.board;
		let moveoptions;
		if (standardMove && board.chargedSpells[color].includes('Seal_of_Wind')) {
			moveoptions = getBlinkTargets(board, color);
		} else {
			moveoptions = getAllMoveTargets(board, color);
		}

		const resp = await this.getInput({
			type: 'message', message: 'Choose where to move.',
			awaiting: 'node', moveoptions,
		});
		await this._doMove(color, resp, standardMove);
	}

	async _doDash(color, lightning) {
		const board = this.board;
		const enemy = board.enemy(color);

		this.emit({ type: 'message', message: 'Opponent dashes!', awaiting: null });

		if (lightning) {
			// Sacrifice 1 stone
			while (true) {
				const resp = await this.getInput({
					type: 'message', message: 'Choose a stone to sacrifice.',
					awaiting: 'node', moveoptions: {},
				});
				if (board.stones[resp] === color) {
					board.stones[resp] = null;
					if (board.lastPlay === resp) {
						board.lastPlay = null;
						board.lastPlayer = null;
					}
					board.update();
					this.emit(board.getBoardStatePayload());
					break;
				}
			}
		} else {
			// Sacrifice 2 stones
			for (let i = 0; i < 2; i++) {
				while (true) {
					const msg = i === 0 ? 'Sacrifice two stones.' : '';
					const resp = await this.getInput({
						type: 'message', message: msg,
						awaiting: 'node', moveoptions: {},
					});
					if (board.stones[resp] === color) {
						board.stones[resp] = null;
						if (board.lastPlay === resp) {
							board.lastPlay = null;
							board.lastPlayer = null;
						}
						board.update();
						this.emit(board.getBoardStatePayload());
						break;
					}
				}
			}
		}

		// Move after dash
		await this._promptMove(color, false);
		board.update();
		this.emit(board.getBoardStatePayload());
	}

	async _castSpell(spellName, color) {
		const board = this.board;
		const info = CORE_SPELLS[spellName];
		const spellIdx = board.spellNames.indexOf(spellName);
		const posIdx = spellIdx + 1;
		const positionNodes = POSITIONS[posIdx];

		const pname = color[0].toUpperCase() + color.slice(1);
		this.emit({ type: 'message', message: pname + ' casts ' + spellName.replace(/_/g, ' '), awaiting: null });

		// Sacrifice all stones in spell position
		for (const n of positionNodes) {
			board.stones[n] = null;
			if (board.lastPlay === n) {
				board.lastPlay = null;
				board.lastPlayer = null;
			}
		}

		// Refill (non-charms only)
		if (!info.ischarm) {
			let refills = board.mana[color];
			// Lifesap (static): casting a 5-node spell grants a 2-stone refill.
			if (positionNodes.length === 5 && board.chargedSpells[color].includes('Lifesap')) {
				refills = Math.max(refills, 2);
			}
			if (refills > 0) {
				const emptyNodes = positionNodes.filter(n => board.stones[n] === null);
				if (refills >= emptyNodes.length) {
					// No degrees of freedom: fill every empty spell node and skip the prompt.
					for (const n of emptyNodes) { board.stones[n] = color; }
					board.update();
					this.emit(board.getBoardStatePayload());
					this.emit({ type: 'donerefilling', playercolor: color });
				} else {
					const msg = refills === 1
						? 'You get to keep 1 stone in ' + spellName.replace(/_/g, ' ') + '.'
						: 'You get to keep ' + refills + ' stones in ' + spellName.replace(/_/g, ' ') + '.';
					this.emit({ type: 'message', message: msg, awaiting: null });

					while (refills > 0) {
						// Send chooserefills event
						const refillPayload = { type: 'chooserefills', playercolor: color };
						for (const n of positionNodes) {
							if (board.stones[n] === null) {
								refillPayload[n] = 'True';
							}
						}
						this.emit(refillPayload);

						const resp = await this.getInput({
							type: 'message', message: 'Select a stone to keep:',
							awaiting: 'node', moveoptions: {},
						});

						if (!positionNodes.includes(resp)) {
							this.emit({ type: 'message', message: "That's not a node in your spell!", awaiting: null });
							continue;
						}
						if (board.stones[resp] !== null) {
							this.emit({ type: 'message', message: 'You already kept that stone!', awaiting: null });
							continue;
						}

						board.stones[resp] = color;
						refills--;
						board.update();
						this.emit(board.getBoardStatePayload());
					}

					this.emit({ type: 'donerefilling', playercolor: color });
				}
			}
		}

		board.update();
		this.emit(board.getBoardStatePayload());

		// Resolve spell effect
		const resolveType = info.resolve;
		if (resolveType && SpellResolvers[resolveType]) {
			await SpellResolvers[resolveType](board, color, spellName, this.getInput.bind(this), this.emit);
		}

		board.update();
		this.emit(board.getBoardStatePayload());

		// Lock management (non-charms only)
		if (!info.ischarm) {
			if (board.lock[color] === spellName) {
				board.springlock[color] = spellName;
				this.emit({ type: 'message', message: spellName.replace(/_/g, ' ') + ' is Springlocked for ' + pname, awaiting: null });
			} else {
				board.lock[color] = spellName;
				board.springlock[color] = null;
			}
			if (!variantHasDeathmatch(board.variant)) board.spellCounter[color]++; // Deathmatch removes the counter
		}

		board.update();
		this.emit(board.getBoardStatePayload());
	}

	async _takeAITurn(color) {
		const board = this.board;
		// Free the worker for the real search. Ponder (if it was running)
		// exits at its next iterative-deepening boundary; its TT entries
		// remain in the shared MinimaxTT and are reused below.
		if (typeof this.ai.cancelPonder === 'function') {
			this.ai.cancelPonder();
		}
		this.emit({ type: 'ai_thinking_start', color });
		this.emit({ type: 'message', message: 'AI is thinking...', awaiting: null });
		await this._delay(300);

		const onProgress = (info) => {
			// info: { depth, score, timeMs, nodes, ttSize }
			this.emit({ type: 'ai_thinking_progress', color, ...info });
		};

		const turn = await this.ai.pickTurn(board, color, onProgress);
		this.emit({ type: 'ai_thinking_end', color });
		if (this.ai.lastMeta) {
			this.emit({ type: 'ai_think_report', color, ...this.ai.lastMeta });
		}
		await applyAITurn(board, turn, color, this.emit);
	}

	_eotTriggers(color) {
		const board = this.board;
		const enemy = board.enemy(color);

		// Inferno EOT effect
		if (board.chargedSpells[color].includes('Inferno')) {
			this.emit({ type: 'message', message: 'INFERNO TRIGGER!', awaiting: null });
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
		}

		// Check win conditions
		board.update();
		board.checkGameOver(color);
	}
}

class ResetError extends Error {
	constructor() { super('reset'); }
}
