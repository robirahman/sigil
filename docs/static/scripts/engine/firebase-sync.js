/**
 * Firebase Realtime Database sync for online multiplayer.
 *
 * Game state flow:
 * 1. Player 1 creates a room (gets room code)
 * 2. Player 2 joins with room code
 * 3. Both connect to the same Firebase path
 * 4. Turns are sent as batches to /rooms/{code}/turns
 * 5. Each player listens for opponent's turns and replays them locally
 */

class FirebaseSync {
	constructor(db) {
		this.db = db;
		this.roomCode = null;
		this.roomRef = null;
		this.myColor = null;
		this.onOpponentJoin = null;
		this.onOpponentDisconnect = null;

		// Queue of opponent actions received from Firebase, waiting to be consumed
		this._incomingQueue = [];
		// Resolver for the next getInput() call waiting for an opponent action
		this._waitingResolver = null;
		this._isReconnect = false;

		// User info for both players (populated during create/join)
		this.redUid = null;
		this.redDisplayName = null;
		this.blueUid = null;
		this.blueDisplayName = null;
		this.ranked = false;

		// Server time offset for clock synchronization
		this._serverTimeOffset = 0;
		db.ref('.info/serverTimeOffset').on('value', (snap) => {
			this._serverTimeOffset = snap.val() || 0;
		});

		// Time control config (set during createRoom/joinRoom)
		this.timeControl = null;

		// Game-rules variant ('standard' | 'competitive'), set during
		// createRoom / joinRoom and replicated to the joining peer
		// through the room metadata.
		this.variant = 'standard';
	}

	/** Get the current server time estimate. */
	serverNow() {
		return Date.now() + this._serverTimeOffset;
	}

	/**
	 * Create a new room.
	 * @param {string[]} spellNames
	 * @param {object} [userInfo] - { uid, displayName, elo, isAnonymous }
	 * @param {object} [timeControl] - { type, initialTime, increment, moveTimeout }
	 * @param {boolean} [allowSpectators] - whether spectators can watch (default true)
	 * @param {string} [variant] - 'standard' (default) or 'competitive'
	 */
	async createRoom(spellNames, userInfo, timeControl, allowSpectators, variant) {
		const code = _generateRoomCode();
		this.roomCode = code;
		this.myColor = 'red';

		this.redUid = userInfo?.uid || null;
		this.redDisplayName = userInfo?.displayName || 'Guest';
		this.timeControl = timeControl || { type: 'none' };
		this.allowSpectators = allowSpectators !== false;
		this.variant = variant === 'competitive' ? 'competitive' : 'standard';

		const roomData = {
			spellNames: spellNames,
			status: 'waiting',
			created: Date.now(),
			red: { connected: true, uid: this.redUid, displayName: this.redDisplayName },
			blue: { connected: false },
			ranked: false,
			timeControl: this.timeControl,
			allowSpectators: this.allowSpectators,
			variant: this.variant,
		};

		const roomRef = this.db.ref('rooms/' + code);
		await roomRef.set(roomData);
		this.roomRef = roomRef;

		this._writeActiveGameIndex('red');

		roomRef.child('blue/connected').on('value', (snap) => {
			if (snap.val() === true && this.onOpponentJoin) {
				this.onOpponentJoin();
			}
		});

		this._listenForTurns();
		roomRef.child('red/connected').onDisconnect().set(false);
		return code;
	}

	/**
	 * Join an existing room.
	 * @param {string} code - room code
	 * @param {object} [userInfo] - { uid, displayName, elo, isAnonymous }
	 * @returns {{ spellNames, myColor, sfn?, isSpectator?, timeControl? }}
	 */
	async joinRoom(code, userInfo) {
		this.roomCode = code;

		const roomRef = this.db.ref('rooms/' + code);
		this.roomRef = roomRef;

		const snap = await roomRef.once('value');
		const data = snap.val();
		if (!data) throw new Error('Room not found');

		this.timeControl = data.timeControl || { type: 'none' };
		this.allowSpectators = data.allowSpectators !== false;
		// Variant is room-scoped: the joiner inherits whatever the
		// creator picked. Default 'standard' for older rooms whose
		// data was written before the field existed.
		this.variant = data.variant === 'competitive' ? 'competitive' : 'standard';

		// Store player info from room data
		if (data.red) {
			this.redUid = data.red.uid || null;
			this.redDisplayName = data.red.displayName || 'Guest';
		}

		if (data.status === 'waiting') {
			// Normal first join as blue
			this.myColor = 'blue';
			this.blueUid = userInfo?.uid || null;
			this.blueDisplayName = userInfo?.displayName || 'Guest';

			await roomRef.child('blue').set({
				connected: true,
				uid: this.blueUid,
				displayName: this.blueDisplayName,
			});
			await roomRef.child('status').set('playing');
			roomRef.child('blue/connected').onDisconnect().set(false);

			// Determine if ranked (both players authenticated)
			if (this.redUid && this.blueUid && !userInfo?.isAnonymous) {
				this.ranked = true;
				await roomRef.child('ranked').set(true);
			}

			this._writeActiveGameIndex('blue');

			roomRef.child('red/connected').on('value', (snap) => {
				if (snap.val() === false && this.onOpponentDisconnect) {
					this.onOpponentDisconnect();
				}
			});

			this._listenForTurns();
			return {
				spellNames: data.spellNames,
				myColor: 'blue',
				timeControl: this.timeControl,
				variant: this.variant,
				redDisplayName: this.redDisplayName,
				blueDisplayName: this.blueDisplayName,
			};
		}

		if (data.status === 'playing') {
			// Reconnection — figure out if this user is one of the players (by uid)
			const myUid = userInfo?.uid || null;
			const matchesRed = myUid && data.red && data.red.uid === myUid;
			const matchesBlue = myUid && data.blue && data.blue.uid === myUid;
			let blueDisconnected = data.blue && data.blue.connected === false;
			let redDisconnected = data.red && data.red.connected === false;

			let isRedPlayer = false;
			let isBluePlayer = false;

			if (matchesRed && matchesBlue) {
				// Same uid registered on both sides. Firebase Anonymous Auth
				// shares one uid across all tabs of a browser profile, so this
				// is the normal state when one tester opens both players in
				// the same browser. Uid alone can't tell us which slot to
				// reclaim — disambiguate by which side is currently
				// disconnected.
				if (!redDisconnected && !blueDisconnected) {
					// The closing tab's onDisconnect may not have propagated
					// yet. Wait briefly and re-snapshot.
					await new Promise((r) => setTimeout(r, 2500));
					const snap2 = await roomRef.once('value');
					const data2 = snap2.val() || {};
					redDisconnected = !!(data2.red && data2.red.connected === false);
					blueDisconnected = !!(data2.blue && data2.blue.connected === false);
				}
				if (redDisconnected && !blueDisconnected) isRedPlayer = true;
				else if (blueDisconnected && !redDisconnected) isBluePlayer = true;
				// else still ambiguous (both gone or both still here): fall
				// through to spectator path.
			} else {
				isRedPlayer = matchesRed;
				isBluePlayer = matchesBlue;
			}

			if (isRedPlayer) {
				this.myColor = 'red';
			} else if (isBluePlayer) {
				this.myColor = 'blue';
			} else if (blueDisconnected && (!data.blue || !data.blue.uid)) {
				// Anonymous reconnection slot
				this.myColor = 'blue';
			} else if (redDisconnected && (!data.red || !data.red.uid)) {
				this.myColor = 'red';
			} else {
				// Not a player — join as spectator if allowed
				if (data.allowSpectators === false) {
					throw new Error('Spectators are not allowed in this game');
				}
				return this._joinAsSpectator(data);
			}

			if (data.blue) {
				this.blueUid = data.blue.uid || null;
				this.blueDisplayName = data.blue.displayName || 'Guest';
			}
			this.ranked = data.ranked || false;

			await roomRef.child(this.myColor + '/connected').set(true);
			roomRef.child(this.myColor + '/connected').onDisconnect().set(false);

			this._writeActiveGameIndex(this.myColor);

			const opponentColor = this.myColor === 'red' ? 'blue' : 'red';
			roomRef.child(opponentColor + '/connected').on('value', (snap) => {
				if (snap.val() === false && this.onOpponentDisconnect) {
					this.onOpponentDisconnect();
				}
			});

			this._isReconnect = true;
			await this._listenForTurns();
			return {
				spellNames: data.spellNames,
				myColor: this.myColor,
				sfn: data.currentSfn || null,
				timeControl: this.timeControl,
				variant: this.variant,
				redDisplayName: this.redDisplayName,
				blueDisplayName: this.blueDisplayName,
			};
		}

		throw new Error('Room not found');
	}

	/**
	 * Join a room as a spectator (read-only).
	 * @param {object} data - room snapshot data
	 */
	_joinAsSpectator(data) {
		if (data.allowSpectators === false) {
			throw new Error('Spectators are not allowed in this game');
		}
		this.myColor = null;
		if (data.blue) {
			this.blueUid = data.blue.uid || null;
			this.blueDisplayName = data.blue.displayName || 'Guest';
		}

		// Register spectator presence
		const specRef = this.roomRef.child('spectators').push();
		specRef.set({ joined: firebase.database.ServerValue.TIMESTAMP });
		specRef.onDisconnect().remove();

		// Listen for ALL turns (both colors)
		this._listenForAllTurns(data);

		return {
			spellNames: data.spellNames,
			myColor: null,
			isSpectator: true,
			sfn: data.currentSfn || null,
			timeControl: this.timeControl,
			variant: this.variant,
			redDisplayName: this.redDisplayName,
			blueDisplayName: this.blueDisplayName,
		};
	}

	/**
	 * Listen for turns from both colors (used by spectators).
	 * Enqueues all actions into _incomingQueue.
	 */
	_listenForAllTurns(roomData) {
		const turnsRef = this.roomRef.child('turns');

		// Count existing turns to skip on initial load
		let existingCount = 0;
		if (roomData.turns) {
			existingCount = Object.keys(roomData.turns).length;
		}

		let skipped = 0;
		turnsRef.on('child_added', (snap) => {
			if (skipped < existingCount) {
				skipped++;
				return;
			}

			const data = snap.val();
			const actions = data.actions || [];
			for (const action of actions) {
				if (this._waitingResolver) {
					const resolve = this._waitingResolver;
					this._waitingResolver = null;
					resolve(action);
				} else {
					this._incomingQueue.push(action);
				}
			}
		});

		// Listen for game over
		this.roomRef.child('status').on('value', (snap) => {
			if (snap.val() === 'finished') {
				// Signal to spectator controller
				if (this._waitingResolver) {
					const resolve = this._waitingResolver;
					this._waitingResolver = null;
					resolve('__game_finished__');
				}
			}
		});
	}

	async saveGameState(sfn) {
		if (!this.roomRef) return;
		try {
			await this.roomRef.child('currentSfn').set(sfn);
		} catch (e) {
			console.error('[Sync] saveGameState FAILED:', e);
		}
	}

	/**
	 * Send a completed turn's actions as a batch.
	 * Optionally includes an atomic timer update.
	 * @param {string[]} actions - ordered list of action strings for this turn
	 * @param {object} [timerUpdate] - { red, blue, activeColor } remaining ms values
	 */
	async sendTurn(actions, timerUpdate) {
		if (!this.roomRef) { console.error('[Sync] sendTurn: no roomRef!'); return; }
		console.log('[Sync] sendTurn:', this.myColor, actions);
		try {
			if (timerUpdate) {
				// Atomic multi-path update: turn + timer in one write
				const turnKey = this.roomRef.child('turns').push().key;
				const updates = {};
				updates['turns/' + turnKey] = {
					color: this.myColor,
					actions: actions,
					timestamp: Date.now(),
				};
				updates['timer/red'] = timerUpdate.red;
				updates['timer/blue'] = timerUpdate.blue;
				updates['timer/activeColor'] = timerUpdate.activeColor;
				updates['timer/lastUpdated'] = firebase.database.ServerValue.TIMESTAMP;
				await this.roomRef.update(updates);
			} else {
				await this.roomRef.child('turns').push({
					color: this.myColor,
					actions: actions,
					timestamp: Date.now(),
				});
			}
			console.log('[Sync] sendTurn succeeded');
		} catch (e) {
			console.error('[Sync] sendTurn FAILED:', e.code, e.message);
		}
	}

	/**
	 * Initialize timer state when game starts (called by room creator).
	 * @param {object} config - timeControl from room
	 */
	async initTimer(config) {
		if (!this.roomRef || !config || config.type === 'none') return;

		let timerData;
		if (config.type === 'realtime') {
			timerData = {
				red: config.initialTime,
				blue: config.initialTime,
				activeColor: 'red', // Red goes first
				lastUpdated: firebase.database.ServerValue.TIMESTAMP,
			};
		} else if (config.type === 'correspondence') {
			timerData = {
				red: 0, // Will be set to deadline on first turn
				blue: 0,
				activeColor: 'red',
				lastUpdated: firebase.database.ServerValue.TIMESTAMP,
			};
		}

		if (timerData) {
			await this.roomRef.child('timer').set(timerData);
		}
	}

	/**
	 * Listen for timer state changes.
	 * @param {function} callback - receives { red, blue, activeColor, lastUpdated }
	 */
	listenToTimer(callback) {
		if (!this.roomRef) return;
		this.roomRef.child('timer').on('value', (snap) => {
			const data = snap.val();
			if (data) callback(data);
		});
	}

	/**
	 * Write a timeout result (game over due to clock).
	 * Uses a transaction to prevent double-writes.
	 * @param {string} winner - 'red' or 'blue'
	 */
	async writeTimeout(winner) {
		if (!this.roomRef) return;
		await this.roomRef.child('status').transaction((current) => {
			if (current === 'playing') return 'finished';
			return; // abort if already finished
		});
		await this.roomRef.child('winner').set(winner);
		this._removeActiveGameIndex();
	}

	/**
	 * Get the next opponent action. Returns a Promise that resolves with the
	 * action string. If actions are already queued, resolves immediately.
	 */
	getNextOpponentAction() {
		if (this._incomingQueue.length > 0) {
			return Promise.resolve(this._incomingQueue.shift());
		}
		return new Promise(resolve => {
			this._waitingResolver = resolve;
		});
	}

	async _listenForTurns() {
		const turnsRef = this.roomRef.child('turns');
		console.log('[Sync] Listening for turns at', turnsRef.toString());

		// Count existing turns so we can skip them on reconnection
		let existingCount = 0;
		if (this._isReconnect) {
			const existingSnap = await turnsRef.once('value');
			if (existingSnap.val()) {
				existingCount = Object.keys(existingSnap.val()).length;
			}
			console.log('[Sync] Reconnecting, skipping', existingCount, 'existing turns');
		}

		let skipped = 0;
		turnsRef.on('child_added', (snap) => {
			if (skipped < existingCount) {
				skipped++;
				return;
			}

			const data = snap.val();
			console.log('[Sync] Turn received:', data.color, data.actions, 'myColor:', this.myColor);
			if (data.color === this.myColor) return; // ignore own turns

			// Enqueue each action from the opponent's turn
			const actions = data.actions || [];
			console.log('[Sync] Processing', actions.length, 'actions, waitingResolver:', !!this._waitingResolver);
			for (const action of actions) {
				if (this._waitingResolver) {
					const resolve = this._waitingResolver;
					this._waitingResolver = null;
					resolve(action);
				} else {
					this._incomingQueue.push(action);
				}
			}
		});
	}

	/** Get a snapshot of a room without joining. Used by `?id=CODE` URL handler. */
	async getRoomSnapshot(code) {
		const snap = await this.db.ref('rooms/' + code).once('value');
		return snap.val();
	}

	/**
	 * Re-establish the creator (red) side of a waiting room after a page reload.
	 * Caller must have already verified that userInfo.uid matches data.red.uid.
	 */
	async reconnectAsCreator(code, userInfo, roomData) {
		this.roomCode = code;
		this.myColor = 'red';
		this.redUid = userInfo?.uid || null;
		this.redDisplayName = userInfo?.displayName || (roomData.red && roomData.red.displayName) || 'Guest';
		this.timeControl = roomData.timeControl || { type: 'none' };
		this.allowSpectators = roomData.allowSpectators !== false;
		this.variant = roomData.variant === 'competitive' ? 'competitive' : 'standard';

		const roomRef = this.db.ref('rooms/' + code);
		this.roomRef = roomRef;

		await roomRef.child('red/connected').set(true);
		roomRef.child('red/connected').onDisconnect().set(false);

		this._writeActiveGameIndex('red');

		roomRef.child('blue/connected').on('value', (snap) => {
			if (snap.val() === true && this.onOpponentJoin) {
				this.onOpponentJoin();
			}
		});

		this._listenForTurns();
	}

	/**
	 * Mark the room as finished and persist the gameLog so future visitors can
	 * load review mode. Called by either player when the game ends.
	 * @param {string} winner - 'red' or 'blue'
	 * @param {Array} gameLog - turn-by-turn SFNs
	 */
	async writeRoomFinalState(winner, gameLog) {
		if (!this.roomRef) return;
		try {
			await this.roomRef.update({
				status: 'finished',
				winner: winner,
				gameLog: gameLog,
				finishedAt: Date.now(),
			});
		} catch (e) {
			console.error('Failed to write room final state:', e);
		}
		this._removeActiveGameIndex();
	}

	/**
	 * Write a /user_active_games/{uid}/{roomCode} entry for the local player so
	 * they can find this game on the active-games page.
	 */
	_writeActiveGameIndex(myColor) {
		if (!this.roomCode || !this.db) return;
		const myUid = myColor === 'red' ? this.redUid : this.blueUid;
		if (!myUid) return; // anonymous players aren't indexed
		const opponentColor = myColor === 'red' ? 'blue' : 'red';
		const opponentUid = myColor === 'red' ? this.blueUid : this.redUid;
		const opponentName = myColor === 'red' ? this.blueDisplayName : this.redDisplayName;
		const entry = {
			roomCode: this.roomCode,
			myColor: myColor,
			opponentColor: opponentColor,
			opponentUid: opponentUid || null,
			opponentDisplayName: opponentName || null,
			timeControlType: (this.timeControl && this.timeControl.type) || 'none',
			created: Date.now(),
		};
		this.db.ref('user_active_games/' + myUid + '/' + this.roomCode).set(entry).catch((e) => {
			console.warn('Failed to write user_active_games entry:', e);
		});
	}

	/**
	 * Remove /user_active_games entries for this room.
	 * Removes the local player's entry and, when known, the opponent's too.
	 */
	_removeActiveGameIndex() {
		if (!this.roomCode || !this.db) return;
		const updates = {};
		if (this.redUid) updates['user_active_games/' + this.redUid + '/' + this.roomCode] = null;
		if (this.blueUid) updates['user_active_games/' + this.blueUid + '/' + this.roomCode] = null;
		if (Object.keys(updates).length === 0) return;
		this.db.ref().update(updates).catch((e) => {
			console.warn('Failed to remove user_active_games entries:', e);
		});
	}

	async saveCompletedGame(gameRecord) {
		if (!this.db || this.myColor !== 'red') return;
		// Enrich with auth info
		gameRecord.redUid = this.redUid || null;
		gameRecord.blueUid = this.blueUid || null;
		gameRecord.ranked = this.ranked || false;
		// Backfill the variant if the caller didn't set it (older builds
		// / edge paths). Treats the room metadata as the source of truth.
		if (gameRecord.variant !== 'competitive' && gameRecord.variant !== 'standard') {
			gameRecord.variant = this.variant === 'competitive' ? 'competitive' : 'standard';
		}
		// Merge any room-level annotations (written live by either player) into
		// the game record before pushing.
		try {
			const annotSnap = await this.roomRef.child('annotations').once('value');
			const roomAnnotations = annotSnap.val();
			if (roomAnnotations) {
				gameRecord.annotations = Object.assign(
					{}, gameRecord.annotations || {}, roomAnnotations);
			}
		} catch (e) {
			console.error('Failed to read room annotations:', e);
		}
		// Mirror the merge for the position-evaluation annotations
		// ('red' | 'blue' | 'even') so both signals end up on the
		// completed_games record.
		try {
			const evalSnap = await this.roomRef.child('eval_annotations').once('value');
			const roomEvalAnnotations = evalSnap.val();
			if (roomEvalAnnotations) {
				gameRecord.eval_annotations = Object.assign(
					{}, gameRecord.eval_annotations || {}, roomEvalAnnotations);
			}
		} catch (e) {
			console.error('Failed to read room eval_annotations:', e);
		}
		try {
			const ref = await this.db.ref('completed_games').push(gameRecord);
			// Process Elo client-side for ranked games
			if (gameRecord.ranked && typeof processEloClientSide === 'function') {
				try {
					await processEloClientSide(this.db, ref.key, gameRecord);
				} catch (eloErr) {
					console.error('Failed to process Elo:', eloErr);
				}
			}
		} catch (e) {
			console.error('Failed to save completed game:', e);
		}
	}

	/** Write a single annotation to the shared room path. Either player can call. */
	async setAnnotation(turnNumber, value) {
		if (!this.roomRef) return;
		const ref = this.roomRef.child('annotations').child(String(turnNumber));
		try {
			if (value === 'good' || value === 'bad') {
				await ref.set(value);
			} else {
				await ref.remove();
			}
		} catch (e) {
			console.error('Failed to write annotation:', e);
		}
	}

	/**
	 * Write a single position-eval annotation ('red' | 'blue' | 'even') to
	 * the shared room path, or clear it. Mirrors setAnnotation but for the
	 * "who's winning" labels added in the eval-annotations feature.
	 */
	async setEvalAnnotation(turnNumber, value) {
		if (!this.roomRef) return;
		const ref = this.roomRef.child('eval_annotations').child(String(turnNumber));
		try {
			if (value === 'red' || value === 'blue' || value === 'even') {
				await ref.set(value);
			} else {
				await ref.remove();
			}
		} catch (e) {
			console.error('Failed to write eval annotation:', e);
		}
	}

	destroy() {
		if (this.roomRef) {
			this.roomRef.off();
			if (this.myColor) {
				this.roomRef.child(this.myColor + '/connected').set(false);
			}
		}
	}

	/* ----- Rematch handshake ----- */

	/** Mark this color as having offered a rematch on the current room. */
	async offerRematch() {
		if (!this.roomRef || !this.myColor) return;
		await this.roomRef.child('rematch/' + this.myColor).set('offered');
	}

	/** Withdraw a rematch offer from this color. */
	async cancelRematch() {
		if (!this.roomRef || !this.myColor) return;
		await this.roomRef.child('rematch/' + this.myColor).set(null);
	}

	/**
	 * Subscribe to rooms/{room}/rematch updates. callback receives the rematch
	 * object: { red, blue, newRoomCode } (any of which may be null/undefined).
	 * Returns an unsubscribe function.
	 */
	onRematchStateChange(callback) {
		if (!this.roomRef) return () => {};
		const ref = this.roomRef.child('rematch');
		const handler = (snap) => callback(snap.val() || {});
		ref.on('value', handler);
		return () => ref.off('value', handler);
	}

	/**
	 * Create a rematch room with both players already pre-joined (status: 'playing').
	 * Skips the lobby join step so both clients can navigate straight in.
	 * Returns the new 6-char room code.
	 */
	async createRematchRoom(spellNames, timeControl, allowSpectators, redInfo, blueInfo, ranked, variant) {
		const code = _generateRoomCode();
		const roomData = {
			spellNames: spellNames,
			status: 'playing',
			created: Date.now(),
			red: { connected: false, uid: redInfo?.uid || null, displayName: redInfo?.displayName || 'Guest' },
			blue: { connected: false, uid: blueInfo?.uid || null, displayName: blueInfo?.displayName || 'Guest' },
			ranked: !!ranked,
			timeControl: timeControl || { type: 'none' },
			allowSpectators: allowSpectators !== false,
			variant: variant === 'competitive' ? 'competitive' : 'standard',
		};
		await this.db.ref('rooms/' + code).set(roomData);
		return code;
	}

	/** Publish the rematch room code on the OLD room so both clients can navigate to it. */
	async setRematchNewRoomCode(code) {
		if (!this.roomRef) return;
		await this.roomRef.child('rematch/newRoomCode').set(code);
	}
}

function _generateRoomCode() {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code = '';
	for (let i = 0; i < 6; i++) {
		code += chars[Math.floor(Math.random() * chars.length)];
	}
	return code;
}

/**
 * Save an AI game-review to RTDB. The `aiTrainingExempt: true` flag must be
 * present so any future training-data export filters these out.
 */
async function saveGameReview(db, gameId, review) {
	if (!db || !gameId || !review) return;
	if (!review.aiTrainingExempt) {
		throw new Error('saveGameReview refuses to write a review without aiTrainingExempt: true');
	}
	await db.ref('game_reviews/' + gameId).set(review);
}

/** Load a previously-saved AI review by gameId. Returns null if not present. */
async function loadGameReview(db, gameId) {
	if (!db || !gameId) return null;
	const snap = await db.ref('game_reviews/' + gameId).once('value');
	return snap.exists() ? snap.val() : null;
}

/**
 * Write a single community annotation under
 * /community_annotations/{gameId}/{turnNumber}/{kind}/{uid}. This keeps the
 * post-hoc contributions separate from the game-owner's live-game marks
 * so they never overwrite each other.
 *
 * @param kind 'move' (good/bad) or 'eval' (red/even/blue/null)
 * @param value annotation value or null to clear
 */
async function saveCommunityAnnotation(db, gameId, turnNumber, uid, kind, value) {
	if (!db || !gameId || !uid || turnNumber === null) return;
	const path = 'community_annotations/' + gameId + '/' + turnNumber + '/' + kind + '/' + uid;
	if (value === null || value === undefined) {
		await db.ref(path).remove();
	} else {
		await db.ref(path).set({ value: value, ts: Date.now() });
	}
}

/** Sample a recent finished game for the puzzle page. Returns null on failure. */
async function sampleRecentCompletedGame(db, limit) {
	if (!db) return null;
	const snap = await db.ref('completed_games')
		.orderByChild('timestamp')
		.limitToLast(limit || 50)
		.once('value');
	const games = snap.val();
	if (!games) return null;
	const ids = Object.keys(games);
	if (ids.length === 0) return null;
	const pickId = ids[Math.floor(Math.random() * ids.length)];
	return { gameId: pickId, game: games[pickId] };
}
