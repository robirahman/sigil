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
	}

	async createRoom(spellNames) {
		const code = _generateRoomCode();
		this.roomCode = code;
		this.myColor = 'red';

		const roomData = {
			spellNames: spellNames,
			status: 'waiting',
			created: Date.now(),
			red: { connected: true },
			blue: { connected: false },
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

	async joinRoom(code) {
		this.roomCode = code;

		const roomRef = this.db.ref('rooms/' + code);
		this.roomRef = roomRef;

		const snap = await roomRef.once('value');
		const data = snap.val();
		if (!data) throw new Error('Room not found');

		if (data.status === 'waiting') {
			// Normal first join as blue
			this.myColor = 'blue';
			await roomRef.child('blue/connected').set(true);
			await roomRef.child('status').set('playing');
			roomRef.child('blue/connected').onDisconnect().set(false);

			roomRef.child('red/connected').on('value', (snap) => {
				if (snap.val() === false && this.onOpponentDisconnect) {
					this.onOpponentDisconnect();
				}
			});

			this._listenForTurns();
			return { spellNames: data.spellNames, myColor: 'blue' };
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
				throw new Error('Game already in progress');
			}

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
			return { spellNames: data.spellNames, myColor: this.myColor, sfn: data.currentSfn || null };
		}

		throw new Error('Room not found');
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
	 * @param {string[]} actions - ordered list of action strings for this turn
	 */
	async sendTurn(actions) {
		if (!this.roomRef) { console.error('[Sync] sendTurn: no roomRef!'); return; }
		console.log('[Sync] sendTurn:', this.myColor, actions);
		try {
			await this.roomRef.child('turns').push({
				color: this.myColor,
				actions: actions,
				timestamp: Date.now(),
			});
			console.log('[Sync] sendTurn succeeded');
		} catch (e) {
			console.error('[Sync] sendTurn FAILED:', e.code, e.message);
		}
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
		try {
			await this.db.ref('completed_games').push(gameRecord);
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
