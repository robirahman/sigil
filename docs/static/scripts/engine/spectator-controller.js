/**
 * SpectatorController — read-only game controller for watching online games.
 *
 * Replays both players' turns from Firebase without any local input.
 * Reuses the same game engine logic as MultiplayerController but all
 * actions come from the Firebase turn stream.
 */
class SpectatorController {
	constructor(emitEvent, sync, spellNames) {
		this.emit = emitEvent;
		this.sync = sync;
		this.board = null;
		this.spellNames = spellNames;
		this._gameLog = [];
	}

	/** No-op — spectators cannot act. */
	handlePlayerAction() {}

	/**
	 * Get input — always reads from Firebase (both colors' actions).
	 */
	async getInput(payload) {
		this.emit(payload);
		return await this.sync.getNextOpponentAction();
	}

	async startGame(reconnectSfn) {
		this.board = new SigilBoard(this.spellNames);
		if (reconnectSfn) {
			this.board.loadFromSfn(reconnectSfn);
		} else {
			this.board.setupInitial();
		}

		// Send spell setup
		const posNames = ['ritual1', 'ritual2', 'ritual3', 'sorcery1', 'sorcery2', 'sorcery3', 'charm1', 'charm2', 'charm3'];
		const spellSetup = { type: 'spellsetup' };
		const spellTextSetup = { type: 'spelltextsetup' };
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

		this.board.update();
		this.emit(this.board.getBoardStatePayload());

		this.emit({ type: 'message', message: 'Spectating.', awaiting: null });

		this._emitSfn();
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

		while (true) {
			try {
				const loopCount = board.takeSnapshot();
				if (loopCount >= 5) {
					board.gameover = true;
					board.winner = 'blue';
					this.emit({ type: 'game_over', winner: 'blue' });
					return;
				}

				board.turnCounter++;
				board.whoseTurn = board.turnCounter % 2 === 1 ? 'red' : 'blue';
				const color = board.whoseTurn;

				let turnMsg;
				if (color === 'red') {
					turnMsg = 'Red Turn ' + (Math.floor(board.turnCounter / 2) + 1);
				} else {
					turnMsg = 'Blue Turn ' + Math.floor(board.turnCounter / 2);
				}
				this.emit({ type: 'whoseturndisplay', color, message: turnMsg });

				if (board.gameover) {
					this.emit({ type: 'game_over', winner: board.winner });
					return;
				}

				await this._takeTurn(color, true, true, true, true);

				this._gameLog.push({
					color: color,
					turnNumber: board.turnCounter,
					sfnAfter: boardToSfn(board),
				});

				this._eotTriggers(color);
				board.update();
				this.emit(board.getBoardStatePayload());
				this._emitSfn();

				if (board.gameover) {
					this.emit({ type: 'game_over', winner: board.winner });
					return;
				}
			} catch (e) {
				if (e && e.message === '__game_finished__') return;
				throw e;
			}
		}
	}

	async _takeTurn(color, canmove, candash, canspell, cansummer) {
		const board = this.board;
		board.update();
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
			if (Object.keys(moveoptions).length === 0) return;
		} else {
			if (candash && canspell && board.totalStones[color] > 2) {
				if (!board.chargedSpells[enemy].includes('Autumn')) actions.push('dash');
			}
			let summerActive = false;
			if (board.chargedSpells[color].includes('Seal_of_Summer') && cansummer) summerActive = true;
			if (canspell || (!canspell && summerActive)) {
				board.update();
				for (const spellName of board.chargedSpells[color]) {
					const info = CORE_SPELLS[spellName];
					if (!info || info.static) continue;
					if (info.ischarm) {
						if (board.chargedSpells[enemy].includes('Winter')) continue;
						if (spellName === 'Surge') { if (!candash) { actions.push(spellName); spellList.push(spellName); } continue; }
						if (canspell || (!canspell && summerActive)) { actions.push(spellName); spellList.push(spellName); }
					} else {
						if (board.lock[color] === spellName) {
							if (board.chargedSpells[color].includes('Spring') && board.springlock[color] !== spellName) { actions.push(spellName); spellList.push(spellName); }
						} else { actions.push(spellName); spellList.push(spellName); }
					}
				}
			}
			actions.push('pass');
		}

		const msg = canmove ? 'Waiting for move...' : String(actions);

		const action = await this.getInput({
			type: 'message', message: msg,
			awaiting: 'action',
			actionlist: [],
			moveoptions: {},
		});

		if (action === '__game_finished__') throw new Error('__game_finished__');

		const nodeNames = Object.keys(board.stones);
		if (actions.includes('move') && nodeNames.includes(action)) {
			await this._doMove(color, action, true);
			await this._takeTurn(color, false, candash, canspell, cansummer);
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
			if (canspell) await this._takeTurn(color, false, candash, false, cansummer);
			else await this._takeTurn(color, false, candash, false, false);
			return;
		}
	}

	async _doMove(color, nodeName, standardMove) {
		const board = this.board;
		const enemy = board.enemy(color);
		const hasWind = standardMove && board.chargedSpells[color].includes('Seal_of_Wind');
		let adjacent = false;
		for (const nb of ADJACENCY[nodeName]) { if (board.stones[nb] === color) { adjacent = true; break; } }
		if (board.stones[nodeName] === color) return this._promptMove(color, standardMove);
		if (!adjacent && !hasWind) return this._promptMove(color, standardMove);
		if (!adjacent && hasWind) {
			if (board.stones[nodeName] === null) {
				board.stones[nodeName] = color;
				this.emit({ type: 'new_stone_animation', color, node: nodeName });
				board.lastPlay = nodeName; board.lastPlayer = color;
				board.update(); this.emit(board.getBoardStatePayload());
			} else if (board.stones[nodeName] === enemy) {
				await doPushEnemy(board, nodeName, color, this.getInput.bind(this), this.emit);
			}
			return;
		}
		if (board.stones[nodeName] === null) {
			board.stones[nodeName] = color;
			this.emit({ type: 'new_stone_animation', color, node: nodeName });
			board.lastPlay = nodeName; board.lastPlayer = color;
			board.update(); this.emit(board.getBoardStatePayload());
		} else if (board.stones[nodeName] === enemy) {
			await doPushEnemy(board, nodeName, color, this.getInput.bind(this), this.emit);
		}
	}

	async _promptMove(color, standardMove) {
		const board = this.board;
		const resp = await this.getInput({
			type: 'message', message: 'Waiting for move...',
			awaiting: 'node', moveoptions: {},
		});
		if (resp === '__game_finished__') throw new Error('__game_finished__');
		await this._doMove(color, resp, standardMove);
	}

	async _doDash(color, lightning) {
		const board = this.board;
		this.emit({ type: 'message', message: (color === 'red' ? 'Red' : 'Blue') + ' dashes!', awaiting: null });
		if (lightning) {
			const resp = await this.getInput({ type: 'message', message: '', awaiting: 'node', moveoptions: {} });
			if (resp === '__game_finished__') throw new Error('__game_finished__');
			if (board.stones[resp] === color) {
				board.stones[resp] = null;
				if (board.lastPlay === resp) { board.lastPlay = null; board.lastPlayer = null; }
				board.update(); this.emit(board.getBoardStatePayload());
			}
		} else {
			for (let i = 0; i < 2; i++) {
				const resp = await this.getInput({ type: 'message', message: '', awaiting: 'node', moveoptions: {} });
				if (resp === '__game_finished__') throw new Error('__game_finished__');
				if (board.stones[resp] === color) {
					board.stones[resp] = null;
					if (board.lastPlay === resp) { board.lastPlay = null; board.lastPlayer = null; }
					board.update(); this.emit(board.getBoardStatePayload());
				}
			}
		}
		// Next action from stream is the move target
		const moveResp = await this.getInput({ type: 'message', message: '', awaiting: 'node', moveoptions: {} });
		if (moveResp === '__game_finished__') throw new Error('__game_finished__');
		await this._doMove(color, moveResp, false);
		board.update(); this.emit(board.getBoardStatePayload());
	}

	async _castSpell(spellName, color) {
		const board = this.board;
		const info = CORE_SPELLS[spellName];
		const spellIdx = board.spellNames.indexOf(spellName);
		const positionNodes = POSITIONS[spellIdx + 1];
		const pname = color[0].toUpperCase() + color.slice(1);
		this.emit({ type: 'message', message: pname + ' casts ' + spellName.replace(/_/g, ' '), awaiting: null });
		for (const n of positionNodes) { board.stones[n] = null; if (board.lastPlay === n) { board.lastPlay = null; board.lastPlayer = null; } }
		if (!info.ischarm) {
			let refills = board.mana[color];
			if (refills > 0) {
				while (refills > 0) {
					const refillPayload = { type: 'chooserefills', playercolor: color };
					for (const n of positionNodes) { if (board.stones[n] === null) refillPayload[n] = 'True'; }
					this.emit(refillPayload);
					const resp = await this.getInput({ type: 'message', message: '', awaiting: 'node', moveoptions: {} });
					if (resp === '__game_finished__') throw new Error('__game_finished__');
					if (!positionNodes.includes(resp) || board.stones[resp] !== null) continue;
					board.stones[resp] = color; refills--;
					board.update(); this.emit(board.getBoardStatePayload());
				}
				this.emit({ type: 'donerefilling', playercolor: color });
			}
		}
		board.update(); this.emit(board.getBoardStatePayload());
		const resolveType = info.resolve;
		if (resolveType && SpellResolvers[resolveType]) {
			await SpellResolvers[resolveType](board, color, spellName, this.getInput.bind(this), this.emit);
		}
		board.update(); this.emit(board.getBoardStatePayload());
		if (!info.ischarm) {
			if (board.lock[color] === spellName) { board.springlock[color] = spellName; }
			else { board.lock[color] = spellName; board.springlock[color] = null; }
			board.spellCounter[color]++;
		}
		board.update(); this.emit(board.getBoardStatePayload());
	}

	_eotTriggers(color) {
		const board = this.board;
		const enemy = board.enemy(color);
		if (board.chargedSpells[color].includes('Inferno')) {
			for (const name of NODE_ORDER) {
				if (board.stones[name] === enemy) {
					for (const nb of ADJACENCY[name]) {
						if (board.stones[nb] === color) { board.stones[name] = null; break; }
					}
				}
			}
			board.update();
		}
		board.update();
		board.checkGameOver(color);
	}
}
