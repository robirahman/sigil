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
		this.myColor = 'blue';

		const roomRef = this.db.ref('rooms/' + code);
		this.roomRef = roomRef;

		const snap = await roomRef.once('value');
		const data = snap.val();
		if (!data) throw new Error('Room not found');
		if (data.status !== 'waiting') throw new Error('Game already in progress');

		await roomRef.child('blue/connected').set(true);
		await roomRef.child('status').set('playing');
		roomRef.child('blue/connected').onDisconnect().set(false);

		roomRef.child('red/connected').on('value', (snap) => {
			if (snap.val() === false && this.onOpponentDisconnect) {
				this.onOpponentDisconnect();
			}
		});

		this._listenForTurns();
		return data.spellNames;
	}

	/**
	 * Send a completed turn's actions as a batch.
	 * @param {string[]} actions - ordered list of action strings for this turn
	 */
	async sendTurn(actions) {
		if (!this.roomRef) return;
		await this.roomRef.child('turns').push({
			color: this.myColor,
			actions: actions,
			timestamp: Date.now(),
		});
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

	_listenForTurns() {
		const turnsRef = this.roomRef.child('turns');
		turnsRef.on('child_added', (snap) => {
			const data = snap.val();
			if (data.color === this.myColor) return; // ignore own turns

			// Enqueue each action from the opponent's turn
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
