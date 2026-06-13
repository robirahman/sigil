/**
 * CataclysmController — game loop for the Cataclysm expansion.
 * Supports N-player round-robin turns with configurable win conditions.
 */
class CataclysmController {
	constructor(emitEvent) {
		this.emit = emitEvent;
		this.board = null;
		this._inputResolve = null;
		this._resetRequested = false;
		this._gameLog = [];
	}

	handlePlayerAction(message) {
		if (message === 'reset') {
			this._resetRequested = true;
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

	_waitForInput(payload) {
		this.emit(payload);
		return new Promise(resolve => {
			this._inputResolve = resolve;
		});
	}

	async getInput(payload) {
		const resp = await this._waitForInput(payload);
		if (this._resetRequested) {
			throw new CatResetError();
		}
		return resp;
	}

	async startGame(mapDef) {
		this.board = new CataclysmBoard(mapDef);
		this.board.setupInitial();

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

		// Send map info for renderer
		this.emit({ type: 'mapinfo', mapDef });

		const playerNames = this.board.players.map(c => c[0].toUpperCase() + c.slice(1));
		const modeLabel = mapDef.players.length === 2
			? playerNames[0] + ' vs ' + playerNames[1]
			: playerNames.join(', ');
		this.emit({
			type: 'message',
			message: mapDef.name + ' — ' + modeLabel + '. ' + playerNames[0] + ' goes first.',
			awaiting: null,
		});

		await this._delay(500);
		this._runGameLoop();
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
					if (loopCount >= 5) {
						board.gameover = true;
						// In loop, player with most stones wins
						let bestColor = board.players[0];
						let bestCount = 0;
						for (const c of board.players) {
							if (board.totalStones[c] > bestCount) {
								bestColor = c;
								bestCount = board.totalStones[c];
							}
						}
						board.winner = bestColor;
						this.emit({ type: 'game_over', winner: bestColor, gameLog: this._gameLog });
						return;
					} else if (loopCount >= 3) {
						const remaining = 5 - loopCount;
						this.emit({
							type: 'message',
							message: 'Loop detected. If this state repeats ' + remaining + ' more time(s), the game ends.',
							awaiting: null,
						});
					}
				}

				// Advance to next player (skip eliminated)
				do {
					board.currentPlayerIndex = (board.currentPlayerIndex + 1) % board.players.length;
				} while (board.eliminated.has(board.players[board.currentPlayerIndex]));

				board.turnCounter++;
				const color = board.players[board.currentPlayerIndex];
				board.whoseTurn = color;
				board.dashed = false;

				const colorName = color[0].toUpperCase() + color.slice(1);
				const roundNum = Math.floor(board.turnCounter / board.players.length) + 1;
				this.emit({
					type: 'whoseturndisplay',
					color,
					message: colorName + ' — Round ' + roundNum,
				});

				// Beginning-of-turn trigger: holding the Seal of the Eschaton
				// eliminates that player.
				board.update();
				if (board.chargedSpells[color].includes('Seal_of_the_Eschaton')) {
					this.emit({ type: 'message', message: 'THE ESCHATON CLAIMS ' + colorName + '!', awaiting: null });
					board.eliminated.add(color);
					board.update();
					board.checkGameOver(color);
					if (board.gameover) {
						this.emit({ type: 'game_over', winner: board.winner, gameLog: this._gameLog });
						return;
					}
					resetThisTurn = false;
					continue;
				}

				if (board.gameover) {
					this.emit({ type: 'game_over', winner: board.winner, gameLog: this._gameLog });
					return;
				}

				this._resetRequested = false;
				const turnSfn = board.turnCounter; // simple turn ID for logging

				await this._takeTurn(color, true, true, true, true);

				// EOT triggers
				this._eotTriggers(color);

				board.update();
				this.emit(board.getBoardStatePayload());

				this._gameLog.push({
					color,
					turnNumber: board.turnCounter,
				});

				resetThisTurn = false;

				if (board.gameover) {
					this.emit({ type: 'game_over', winner: board.winner, gameLog: this._gameLog });
					return;
				}
			} catch (e) {
				if (e instanceof CatResetError) {
					this.emit({ type: 'message', message: 'Resetting Turn', awaiting: null });
					board.restoreSnapshot();
					this.emit(board.getBoardStatePayload());
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

		const actions = [];
		let spellList = [];
		let moveoptions = {};

		if (canmove) {
			actions.push('move');
			let stoneActiveMove = false;
			for (const enemy of board.enemies(color)) {
				if (board.chargedSpells[enemy].includes('Seal_of_Stone')) { stoneActiveMove = true; break; }
			}
			if (stoneActiveMove) {
				// Seal of Stone (enemy-held): your opening move must be soft.
				moveoptions = catGetSoftMoveTargets(board, color);
			} else if (board.chargedSpells[color].includes('Seal_of_Wind')) {
				moveoptions = catGetBlinkTargets(board, color);
			} else {
				moveoptions = catGetAllMoveTargets(board, color);
			}
			if (Object.keys(moveoptions).length === 0) {
				return;
			}
		} else {
			// Post-move options
			if (candash && canspell && board.totalStones[color] > 2) {
				let autumnBlocked = false;
				for (const enemy of board.enemies(color)) {
					if (board.chargedSpells[enemy].includes('Autumn')) {
						autumnBlocked = true;
						break;
					}
				}
				if (!autumnBlocked) {
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
						// Check if any enemy has Winter
						let winterBlocked = false;
						for (const enemy of board.enemies(color)) {
							if (board.chargedSpells[enemy].includes('Seal_of_Winter')) {
								winterBlocked = true;
								break;
							}
						}
						if (winterBlocked) continue;

						if (spellName === 'Surge') {
							if (board.dashed) {
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

		const action = await this.getInput({
			type: 'message',
			message: canmove ? 'Choose where to move.' : String(actions),
			awaiting: 'action',
			actionlist: actions,
			moveoptions,
		});

		const nodeNames = board.nodeOrder;

		if (actions.includes('move') && nodeNames.includes(action)) {
			await this._doMove(color, action, true);
			await this._takeTurn(color, false, candash, canspell, cansummer);
			return;
		}

		if (!actions.includes(action) && !nodeNames.includes(action)) {
			await this._takeTurn(color, canmove, candash, canspell, cansummer);
			return;
		}

		if (action === 'pass') return;

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
		const adj = board.mapDef.adjacency;
		const hasWind = standardMove && board.chargedSpells[color].includes('Seal_of_Wind');

		let adjacent = false;
		for (const nb of adj[nodeName]) {
			if (board.stones[nb] === color) { adjacent = true; break; }
		}

		if (board.stones[nodeName] === color || board.isAlly(board.stones[nodeName] || '', color)) {
			return this._promptMove(color, standardMove);
		}

		// Seal of Stone (enemy-held): the opening move must be soft (empty + adjacent).
		if (standardMove) {
			let stoneActive = false;
			for (const enemy of board.enemies(color)) {
				if (board.chargedSpells[enemy].includes('Seal_of_Stone')) { stoneActive = true; break; }
			}
			if (stoneActive && (board.stones[nodeName] !== null || !adjacent)) {
				return this._promptMove(color, standardMove);
			}
		}

		if (!adjacent && !hasWind) {
			return this._promptMove(color, standardMove);
		}

		if (board.stones[nodeName] === null) {
			board.stones[nodeName] = color;
			this.emit({ type: 'new_stone_animation', color, node: nodeName });
			board.lastPlay = nodeName;
			board.lastPlayer = color;
			board.update();
			this.emit(board.getBoardStatePayload());
		} else if (board.isEnemy(board.stones[nodeName], color)) {
			await catDoPushEnemy(board, nodeName, color, this.getInput.bind(this), this.emit);
		}
	}

	async _promptMove(color, standardMove) {
		const board = this.board;
		let moveoptions;
		let stoneActivePrompt = false;
		if (standardMove) {
			for (const enemy of board.enemies(color)) {
				if (board.chargedSpells[enemy].includes('Seal_of_Stone')) { stoneActivePrompt = true; break; }
			}
		}
		if (stoneActivePrompt) {
			moveoptions = catGetSoftMoveTargets(board, color);
		} else if (standardMove && board.chargedSpells[color].includes('Seal_of_Wind')) {
			moveoptions = catGetBlinkTargets(board, color);
		} else {
			moveoptions = catGetAllMoveTargets(board, color);
		}

		const resp = await this.getInput({
			type: 'message', message: 'Choose where to move.',
			awaiting: 'node', moveoptions,
		});
		await this._doMove(color, resp, standardMove);
	}

	async _doDash(color, lightning) {
		const board = this.board;

		this.emit({ type: 'message', message: 'Dash!', awaiting: null });

		const sacrificeCount = lightning ? 1 : 2;
		for (let i = 0; i < sacrificeCount; i++) {
			while (true) {
				const msg = i === 0 && !lightning ? 'Sacrifice two stones.' : (i === 0 ? 'Choose a stone to sacrifice.' : '');
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

		board.dashed = true;
		await this._promptMove(color, false);
		board.update();
		this.emit(board.getBoardStatePayload());
	}

	async _castSpell(spellName, color) {
		const board = this.board;
		const info = CORE_SPELLS[spellName];
		const spellIdx = board.spellNames.indexOf(spellName);
		const posIdx = spellIdx + 1;
		const positionNodes = board.mapDef.spellPositions[posIdx];

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
			if (refills > 0) {
				const msg = refills === 1
					? 'You get to keep 1 stone in ' + spellName.replace(/_/g, ' ') + '.'
					: 'You get to keep ' + refills + ' stones in ' + spellName.replace(/_/g, ' ') + '.';
				this.emit({ type: 'message', message: msg, awaiting: null });

				while (refills > 0) {
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

		board.update();
		this.emit(board.getBoardStatePayload());

		// Resolve spell effect
		const resolveType = info.resolve;
		if (resolveType && CatSpellResolvers[resolveType]) {
			await CatSpellResolvers[resolveType](board, color, spellName, this.getInput.bind(this), this.emit);
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
			board.spellCounter[color]++;
		}

		board.update();
		this.emit(board.getBoardStatePayload());
	}

	_eotTriggers(color) {
		const board = this.board;

		// Inferno EOT effect
		if (board.chargedSpells[color].includes('Seal_of_the_Eschaton')) {
			this.emit({ type: 'message', message: 'THE ESCHATON BURNS!', awaiting: null });
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
		}

		// Check win conditions
		board.update();
		board.checkGameOver(color);
	}
}

class CatResetError extends Error {
	constructor() { super('reset'); }
}
