/**
 * Firebase Realtime Database sync for online multiplayer.
 *
 * Game state flow:
 * 1. Player 1 creates a room (gets room code)
 * 2. Player 2 joins with room code
 * 3. Both connect to the same Firebase path
 * 4. Turns are written as actions to /rooms/{code}/actions
 * 5. Each player listens for opponent's actions and replays them locally
 */

class FirebaseSync {
	constructor(db) {
		this.db = db;
		this.roomCode = null;
		this.roomRef = null;
		this.myColor = null;
		this.onOpponentAction = null;
		this.onOpponentJoin = null;
		this.onOpponentDisconnect = null;
		this._actionIndex = 0;
	}

	/**
	 * Create a new game room. Returns the room code.
	 */
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

		// Listen for blue to join
		roomRef.child('blue/connected').on('value', (snap) => {
			if (snap.val() === true && this.onOpponentJoin) {
				this.onOpponentJoin();
			}
		});

		// Listen for actions from opponent
		this._listenForActions();

		// Set disconnect handler
		roomRef.child('red/connected').onDisconnect().set(false);

		return code;
	}

	/**
	 * Join an existing room. Returns the spell names.
	 */
	async joinRoom(code) {
		this.roomCode = code;
		this.myColor = 'blue';

		const roomRef = this.db.ref('rooms/' + code);
		this.roomRef = roomRef;

		const snap = await roomRef.once('value');
		const data = snap.val();
		if (!data) throw new Error('Room not found');
		if (data.status !== 'waiting') throw new Error('Game already in progress');

		// Mark blue as connected
		await roomRef.child('blue/connected').set(true);
		await roomRef.child('status').set('playing');

		// Set disconnect handler
		roomRef.child('blue/connected').onDisconnect().set(false);

		// Listen for disconnect of opponent
		roomRef.child('red/connected').on('value', (snap) => {
			if (snap.val() === false && this.onOpponentDisconnect) {
				this.onOpponentDisconnect();
			}
		});

		// Listen for actions
		this._listenForActions();

		return data.spellNames;
	}

	/**
	 * Send an action to the room.
	 */
	async sendAction(action) {
		if (!this.roomRef) return;
		const actionsRef = this.roomRef.child('actions');
		await actionsRef.push({
			color: this.myColor,
			action: action,
			timestamp: Date.now(),
		});
	}

	_listenForActions() {
		const actionsRef = this.roomRef.child('actions');
		actionsRef.on('child_added', (snap) => {
			const data = snap.val();
			if (data.color !== this.myColor && this.onOpponentAction) {
				this.onOpponentAction(data.action);
			}
		});
	}

	/**
	 * Save a completed game to /completed_games for training data.
	 * Only one player (red) writes this to avoid duplicates.
	 */
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
