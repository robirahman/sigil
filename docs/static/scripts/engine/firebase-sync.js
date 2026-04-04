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
	 */
	async createRoom(spellNames, userInfo, timeControl) {
		const code = _generateRoomCode();
		this.roomCode = code;
		this.myColor = 'red';

		this.redUid = userInfo?.uid || null;
		this.redDisplayName = userInfo?.displayName || 'Guest';
		this.timeControl = timeControl || { type: 'none' };

		const roomData = {
			spellNames: spellNames,
			status: 'waiting',
			created: Date.now(),
			red: { connected: true, uid: this.redUid, displayName: this.redDisplayName },
			blue: { connected: false },
			ranked: false,
			timeControl: this.timeControl,
		};

		const roomRef = this.db.ref('rooms/' + code);
		await roomRef.set(roomData);
		this.roomRef = roomRef;

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
				redDisplayName: this.redDisplayName,
				blueDisplayName: this.blueDisplayName,
			};
		}

		if (data.status === 'playing') {
			// Reconnection — figure out which color is disconnected
			const blueDisconnected = data.blue && data.blue.connected === false;
			const redDisconnected = data.red && data.red.connected === false;

			if (blueDisconnected) {
				this.myColor = 'blue';
			} else if (redDisconnected) {
				this.myColor = 'red';
			} else {
				// Both players connected — join as spectator
				return this._joinAsSpectator(data);
			}

			if (data.blue) {
				this.blueUid = data.blue.uid || null;
				this.blueDisplayName = data.blue.displayName || 'Guest';
			}
			this.ranked = data.ranked || false;

			await roomRef.child(this.myColor + '/connected').set(true);
			roomRef.child(this.myColor + '/connected').onDisconnect().set(false);

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

	async saveCompletedGame(gameRecord) {
		if (!this.db || this.myColor !== 'red') return;
		// Enrich with auth info
		gameRecord.redUid = this.redUid || null;
		gameRecord.blueUid = this.blueUid || null;
		gameRecord.ranked = this.ranked || false;
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

	destroy() {
		if (this.roomRef) {
			this.roomRef.off();
			if (this.myColor) {
				this.roomRef.child(this.myColor + '/connected').set(false);
			}
		}
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
