/**
 * MultiplayerController — game controller for online play via Firebase.
 *
 * Both players run the game engine locally. When it's your turn, your
 * clicks are sent as actions to Firebase. When it's the opponent's turn,
 * actions come from Firebase and are replayed locally.
 */
class MultiplayerController {
	constructor(emitEvent, sync, myColor, spellNames) {
		this.emit = emitEvent;
		this.sync = sync;
		this.myColor = myColor;
		this.board = null;
		this._inputResolve = null;
		this._resetRequested = false;
		this.spellNames = spellNames;
		this._gameLog = [];

		// Buffer for local player's actions during a turn (sent only when turn completes)
		this._turnBuffer = [];

		// Actions consumed during the current turn from any source (local or opponent),
		// captured for the gameLog so review/export can replay move-by-move.
		this._currentTurnActions = [];

		// Timer state
		this._timerInterval = null;
		this._timerState = { red: 0, blue: 0, activeColor: null, lastUpdated: 0 };
		this._timeControl = sync.timeControl || { type: 'none' };
		this._timedOut = false;

		sync.onOpponentDisconnect = () => {
			this.emit({ type: 'message', message: 'Opponent disconnected.', awaiting: null });
			this.emit({ type: 'opponent_disconnect' });
		};

		// Rematch handshake: subscribe once we know our color/room. The sync.roomRef
		// may not exist yet at construction time — defer until startGame().
		this._rematchUnsubscribe = null;
		this._rematchCreating = false;
	}

	_subscribeToRematch() {
		if (this._rematchUnsubscribe || !this.sync || typeof this.sync.onRematchStateChange !== 'function') return;
		this._rematchUnsubscribe = this.sync.onRematchStateChange((state) => {
			this.emit({ type: 'rematch_state_changed', rematch: state });
			if (state.newRoomCode) {
				this.emit({ type: 'rematch_room_ready', newRoomCode: state.newRoomCode });
				return;
			}
			// Designated rematch-room creator is the red player. When both colors have
			// offered, red generates a new room and publishes the code on the old room.
			if (
				this.myColor === 'red'
				&& state.red === 'offered'
				&& state.blue === 'offered'
				&& !this._rematchCreating
			) {
				this._rematchCreating = true;
				this._createRematchRoom().catch((e) => {
					console.error('[Controller] Rematch room creation failed:', e);
					this._rematchCreating = false;
				});
			}
		});
	}

	async _createRematchRoom() {
		const sync = this.sync;
		const code = await sync.createRematchRoom(
			this.board.spellNames,
			sync.timeControl,
			sync.allowSpectators,
			{ uid: sync.redUid, displayName: sync.redDisplayName },
			{ uid: sync.blueUid, displayName: sync.blueDisplayName },
			!!sync.ranked,
			sync.variant || 'standard'
		);
		await sync.setRematchNewRoomCode(code);
	}

	offerRematch() {
		this._subscribeToRematch();
		return this.sync.offerRematch();
	}

	cancelRematch() {
		return this.sync.cancelRematch();
	}

	handlePlayerAction(message) {
		if (message === 'reset') {
			this._resetRequested = true;
			// Clear buffered actions — they were never sent
			this._turnBuffer = [];
			if (this._inputResolve) {
				this._inputResolve('__reset__');
				this._inputResolve = null;
			}
			return;
		}

		// Buffer the action locally (don't send yet)
		if (this.board && this.board.whoseTurn === this.myColor) {
			this._turnBuffer.push(message);
		}

		if (this._inputResolve) {
			const resolve = this._inputResolve;
			this._inputResolve = null;
			resolve(message);
		}
	}

	/** Flush buffered actions to Firebase. Called when a turn completes successfully. */
	async _flushTurnBuffer() {
		console.log('[Controller] Flushing turn buffer:', this._turnBuffer);
		if (this._turnBuffer.length > 0) {
			const timerUpdate = this._computeTimerUpdate();
			await this.sync.sendTurn(this._turnBuffer, timerUpdate);
			this._turnBuffer = [];
		}
	}

	/**
	 * Compute timer update for end-of-turn.
	 * Returns null if no timer, or { red, blue, activeColor } with updated values.
	 */
	_computeTimerUpdate() {
		if (this._timeControl.type === 'none') return null;

		const ts = this._timerState;
		const now = this.sync.serverNow();
		const elapsed = now - ts.lastUpdated;
		const opponent = this.myColor === 'red' ? 'blue' : 'red';

		if (this._timeControl.type === 'realtime') {
			const myRemaining = Math.max(0, ts[this.myColor] - elapsed + (this._timeControl.increment || 0));
			return {
				red: this.myColor === 'red' ? myRemaining : ts.red,
				blue: this.myColor === 'blue' ? myRemaining : ts.blue,
				activeColor: opponent,
			};
		}

		if (this._timeControl.type === 'correspondence') {
			// Set opponent's deadline to now + moveTimeout
			const deadline = now + this._timeControl.moveTimeout;
			return {
				red: opponent === 'red' ? deadline : ts.red,
				blue: opponent === 'blue' ? deadline : ts.blue,
				activeColor: opponent,
			};
		}

		return null;
	}

	/** Start the timer display interval and listen for timer updates. */
	_startTimer() {
		if (this._timeControl.type === 'none') return;

		this.sync.listenToTimer((data) => {
			this._timerState = data;
		});

		this._timerInterval = setInterval(() => {
			this._tickTimer();
		}, 250);
	}

	/** Called every 250ms to update the timer display and check for timeout. */
	_tickTimer() {
		const ts = this._timerState;
		if (!ts.activeColor || !ts.lastUpdated) return;

		const now = this.sync.serverNow();
		const elapsed = now - ts.lastUpdated;

		if (this._timeControl.type === 'realtime') {
			const activeRemaining = ts[ts.activeColor] - elapsed;
			const inactiveColor = ts.activeColor === 'red' ? 'blue' : 'red';

			this.emit({
				type: 'timer_tick',
				red: ts.activeColor === 'red' ? activeRemaining : ts.red,
				blue: ts.activeColor === 'blue' ? activeRemaining : ts.blue,
			});

			// Check timeout
			if (activeRemaining <= 0 && !this._timedOut) {
				this._timedOut = true;
				const winner = inactiveColor;
				this.emit({ type: 'game_over', winner, gameLog: this._gameLog });
				this.sync.writeTimeout(winner);
				if (this.myColor === 'red') {
					this.sync.writeRoomFinalState(winner, this._gameLog);
				}
				this._stopTimer();
			}
		} else if (this._timeControl.type === 'correspondence') {
			// Show deadlines as absolute timestamps
			this.emit({
				type: 'timer_tick',
				red: ts.red,
				blue: ts.blue,
			});

			// Check if active player's deadline has passed
			const deadline = ts[ts.activeColor];
			if (deadline > 0 && now > deadline && !this._timedOut) {
				this._timedOut = true;
				const winner = ts.activeColor === 'red' ? 'blue' : 'red';
				this.emit({ type: 'game_over', winner, gameLog: this._gameLog });
				this.sync.writeTimeout(winner);
				if (this.myColor === 'red') {
					this.sync.writeRoomFinalState(winner, this._gameLog);
				}
				this._stopTimer();
			}
		}
	}

	/** Stop the timer interval. */
	_stopTimer() {
		if (this._timerInterval) {
			clearInterval(this._timerInterval);
			this._timerInterval = null;
		}
	}

	_waitForInput(payload) {
		this.emit(payload);
		return new Promise(resolve => {
			this._inputResolve = resolve;
		});
	}

	async getInput(payload) {
		const isMyTurn = this.board && this.board.whoseTurn === this.myColor;

		let resp;
		if (isMyTurn) {
			// Local player: wait for UI click
			resp = await this._waitForInput(payload);
			if (this._resetRequested) {
				throw new ResetError();
			}
			this._resetRequested = false;
		} else {
			// Opponent's turn: get next action from Firebase queue
			this.emit(payload);
			resp = await this.sync.getNextOpponentAction();
		}
		this._currentTurnActions.push(resp);
		return resp;
	}

	async startGame(reconnectSfn) {
		// Variant is replicated via Firebase room metadata; sync.variant
		// is set during createRoom / joinRoom / reconnectAsCreator.
		const variant = normalizeVariant(this.sync && this.sync.variant);
		this.board = new SigilBoard(this.spellNames, variant);
		if (reconnectSfn) {
			this.board.loadFromSfn(reconnectSfn);
		} else {
			this.board.setupInitial();
		}

		this._subscribeToRematch();

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

		const colorName = this.myColor[0].toUpperCase() + this.myColor.slice(1);
		if (reconnectSfn) {
			this.emit({ type: 'message', message: 'Reconnected as ' + colorName + '.', awaiting: null });
		} else {
			this.emit({ type: 'message', message: 'You are ' + colorName + '. Red goes first.', awaiting: null });
		}

		// Initialize timer (room creator only, on fresh games)
		if (this.myColor === 'red' && !reconnectSfn) {
			await this.sync.initTimer(this._timeControl);
		}
		this._startTimer();

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
		let resetThisTurn = false;

		while (true) {
			try {
				if (!resetThisTurn) {
					const loopCount = board.takeSnapshot();
					// Threefold repetition → Blue wins on the 3rd occurrence.
					// Notify the log on the 2nd so players aren't caught unaware
					// and can deviate to avoid handing Blue the win.
					if (loopCount === 2) {
						this.emit({ type: 'message', message: 'Repeated position: this board state has occurred twice. If it repeats once more, Blue wins by threefold repetition — play a different move to avoid it.', awaiting: null });
					} else if (loopCount >= 3) {
						this.emit({ type: 'message', message: 'Threefold repetition — Blue wins.', awaiting: null });
						board.gameover = true;
						board.winner = 'blue';
						this.emit({ type: 'game_over', winner: 'blue', gameLog: this._gameLog });
						this._saveGameRecord('blue');
						this._stopTimer();
						return;
					}
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
					this.emit({ type: 'game_over', winner: board.winner, gameLog: this._gameLog });
					this._saveGameRecord(board.winner);
					this._stopTimer();
					return;
				}

				this._resetRequested = false;
				this._turnBuffer = [];
				this._currentTurnActions = [];
				board.crushedThisTurn = false;

				// Record position before the turn is taken
				const turnSfn = boardToSfn(board);

				await this._takeTurn(color, true, true, true, true);

				// Turn completed successfully — send buffered actions to opponent
				if (color === this.myColor) {
					await this._flushTurnBuffer();
				}

				this._eotTriggers(color);
				board.update();

				// Record the turn: SFN before/after plus the action sequence so
				// the gameLog is sufficient to drive an animated replay.
				const turnEntry = {
					color: color,
					turnNumber: board.turnCounter,
					sfnBefore: turnSfn,
					sfnAfter: boardToSfn(board),
					actions: this._currentTurnActions.slice(),
				};
				this._gameLog.push(turnEntry);
				this.emit({ type: 'turn_complete', turn: turnEntry });

				this.emit(board.getBoardStatePayload());
				this._emitSfn();
				this.sync.saveGameState(boardToSfn(board));
				resetThisTurn = false;

				if (board.gameover) {
					this.emit({ type: 'game_over', winner: board.winner, gameLog: this._gameLog });
					this._saveGameRecord(board.winner);
					this._stopTimer();
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

	// Reuse the same _takeTurn, _doMove, _doDash, _castSpell, _eotTriggers
	// from GameController — copy them here for independence
	async _takeTurn(color, canmove, candash, canspell, cansummer) {
		// This is identical to GameController._takeTurn
		const board = this.board;
		board.update();

		// Competitive variant opening: this player has no stones yet —
		// their entire turn is a single free blink onto any empty node.
		// Without this, the normal move-gen returns an empty options set
		// (you can only move from your own stones), `canmove` falls
		// through to a silent pass, and the immediate-loss check ends
		// the game once openingPass expires.
		if (canmove && variantHasCompetitive(board.variant) && board.totalStones[color] === 0) {
			const moveoptions = {};
			for (const n of NODE_ORDER) {
				if (board.stones[n] === null) moveoptions[n] = color;
			}
			const isMyTurn = color === this.myColor;
			const resp = await this.getInput({
				type: 'message',
				message: isMyTurn
					? 'Place your first stone (Competitive opening).'
					: 'Opponent is placing their first stone...',
				awaiting: 'node',
				moveoptions: isMyTurn ? moveoptions : {},
			});
			if (moveoptions[resp]) {
				board.stones[resp] = color;
				board.lastPlay = resp;
				board.lastPlayer = color;
				board.update();
				this.emit({ type: 'new_stone_animation', color, node: resp });
				this.emit(board.getBoardStatePayload());
			}
			await this.getInput({
				type: 'message',
				message: isMyTurn ? 'Stone placed. End turn or reset.' : 'Opponent placed their stone.',
				awaiting: 'action',
				actionlist: isMyTurn ? ['pass'] : [],
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
			if (Object.keys(moveoptions).length === 0) return;
		} else {
			// canDash() folds in Seal of Autumn: when the enemy holds it, only
			// stones outside the spell sigils may be sacrificed for a dash.
			if (candash && canspell && canDash(board, color)
			    && !board.chargedSpells[enemy].includes('Autumn')) {
				actions.push('dash');
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
						if (spellName === 'Splash') { if (candash) { actions.push(spellName); spellList.push(spellName); } continue; }
						if (canspell || (!canspell && summerActive)) { actions.push(spellName); spellList.push(spellName); }
					} else {
						if (board.lock[color] === spellName) {
							if (board.chargedSpells[color].includes('Seal_of_Spring') && board.springlock[color] !== spellName) { actions.push(spellName); spellList.push(spellName); }
						} else { actions.push(spellName); spellList.push(spellName); }
					}
				}
			}
			actions.push('pass');
		}

		const isMyTurn = color === this.myColor;
		const msg = canmove ? (isMyTurn ? 'Choose where to move.' : 'Opponent is choosing...') : String(actions);

		const action = await this.getInput({
			type: 'message', message: msg,
			awaiting: isMyTurn ? 'action' : 'action',
			actionlist: isMyTurn ? actions : [],
			moveoptions: isMyTurn ? moveoptions : {},
		});

		const nodeNames = Object.keys(board.stones);
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
			if (canspell) await this._takeTurn(color, false, candash, false, cansummer);
			else await this._takeTurn(color, false, candash, false, false);
			return;
		}
	}

	_saveGameRecord(winner) {
		if (!this.sync) return;
		const record = {
			spellNames: this.board.spellNames,
			winner: winner,
			turns: this._gameLog,
			roomCode: this.sync.roomCode,
			timestamp: Date.now(),
			// Variant the live board actually played under. Falls back
			// to sync.variant (creator's choice persisted in the room
			// metadata) when board.variant is missing for any reason.
			variant: normalizeVariant((this.board && this.board.variant) || (this.sync && this.sync.variant)),
		};
		this.sync.saveCompletedGame(record);
		// Mark the room finished so the same `?id=CODE` URL serves review mode.
		// Either player calls this — it's an idempotent update.
		if (this.myColor === 'red') {
			this.sync.writeRoomFinalState(winner, this._gameLog);
		}
	}

	/** Annotate the opponent's most recent turn (or clear an existing annotation). */
	setAnnotation(turnNumber, value) {
		if (!this.sync) return;
		return this.sync.setAnnotation(turnNumber, value);
	}

	/**
	 * Annotate the post-turn position evaluation ('red' | 'blue' | 'even').
	 * Independent of setAnnotation — a turn can have neither, either, or
	 * both kinds of annotation attached.
	 */
	setEvalAnnotation(turnNumber, value) {
		if (!this.sync) return;
		return this.sync.setEvalAnnotation(turnNumber, value);
	}

	// These methods are identical to GameController's — just reuse the logic
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
		const isMyTurn = color === this.myColor;
		let moveoptions;
		if (standardMove && board.chargedSpells[color].includes('Seal_of_Wind')) moveoptions = getBlinkTargets(board, color);
		else moveoptions = getAllMoveTargets(board, color);
		const resp = await this.getInput({
			type: 'message', message: isMyTurn ? 'Choose where to move.' : '',
			awaiting: 'node', moveoptions: isMyTurn ? moveoptions : {},
		});
		await this._doMove(color, resp, standardMove);
	}

	async _doDash(color, lightning) {
		const board = this.board;
		const enemy = board.enemy(color);
		this.emit({ type: 'message', message: color === this.myColor ? 'Dashing!' : 'Opponent dashes!', awaiting: null });

		// Seal of Autumn (held by the enemy) bars sacrificing stones on a spell
		// sigil; highlight only eligible stones when restricted.
		const restricted = board.chargedSpells[enemy].includes('Seal_of_Autumn');
		const eligible = new Set(dashSacrificeOptions(board, color));
		const sacOptions = () => {
			if (!restricted) return {};
			const mo = {};
			for (const n of eligible) if (board.stones[n] === color) mo[n] = color;
			return mo;
		};
		const count = lightning ? 1 : 2;
		const firstMsg = lightning ? 'Choose a stone to sacrifice.' : 'Sacrifice two stones.';

		for (let i = 0; i < count; i++) {
			while (true) {
				const resp = await this.getInput({ type: 'message', message: i === 0 ? firstMsg : '', awaiting: 'node', moveoptions: sacOptions() });
				if (board.stones[resp] === color && eligible.has(resp)) {
					board.stones[resp] = null;
					if (board.lastPlay === resp) { board.lastPlay = null; board.lastPlayer = null; }
					board.update(); this.emit(board.getBoardStatePayload()); break;
				}
			}
		}
		await this._promptMove(color, false);
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
			// Lifesap (static): casting a 5-node spell grants a 2-stone refill.
			if (positionNodes.length === 5 && board.chargedSpells[color].includes('Lifesap')) {
				refills = Math.max(refills, 2);
			}
			if (refills > 0) {
				const emptyNodes = positionNodes.filter(n => board.stones[n] === null);
				if (refills >= emptyNodes.length) {
					for (const n of emptyNodes) { board.stones[n] = color; }
					board.update();
					this.emit(board.getBoardStatePayload());
					this.emit({ type: 'donerefilling', playercolor: color });
				} else {
					while (refills > 0) {
						const refillPayload = { type: 'chooserefills', playercolor: color };
						for (const n of positionNodes) { if (board.stones[n] === null) refillPayload[n] = 'True'; }
						this.emit(refillPayload);
						const resp = await this.getInput({ type: 'message', message: 'Select a stone to keep:', awaiting: 'node', moveoptions: {} });
						if (!positionNodes.includes(resp) || board.stones[resp] !== null) continue;
						board.stones[resp] = color; refills--;
						board.update(); this.emit(board.getBoardStatePayload());
					}
					this.emit({ type: 'donerefilling', playercolor: color });
				}
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
			if (!variantHasDeathmatch(board.variant)) board.spellCounter[color]++; // Deathmatch removes the counter
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
