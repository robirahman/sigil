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

const _INVITE_EXPIRY_MS = typeof ROOM_INVITE_EXPIRY_MS !== 'undefined'
	? ROOM_INVITE_EXPIRY_MS
	: (72 * 60 * 60 * 1000);

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
		// A room from a position: the start SFN, its priced start
		// (position-rating.js) and the creator's seat (red otherwise).
		this.startSfn = null;
		this.startPos = null;
		this.creatorColor = 'red';

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
	 * @param {object} [fromPosition] - a room from a position: { startSfn,
	 *   startPos (position-rating.js; absent = unrated), creatorColor }. The
	 *   creator sits in creatorColor's slot; every other room is created by red.
	 */
	async createRoom(spellNames, userInfo, timeControl, allowSpectators, variant, fromPosition) {
		const code = _generateRoomCode();
		const me = (fromPosition && fromPosition.creatorColor === 'blue') ? 'blue' : 'red';
		const other = me === 'red' ? 'blue' : 'red';
		this.roomCode = code;
		this.myColor = me;
		this.creatorColor = me;
		this.created = Date.now();

		this[me + 'Uid'] = userInfo?.uid || null;
		this[me + 'DisplayName'] = userInfo?.displayName || 'Guest';
		this.timeControl = timeControl || { type: 'none' };
		this.allowSpectators = allowSpectators !== false;
		this.variant = normalizeVariant(variant);
		this.startSfn = (fromPosition && fromPosition.startSfn) || null;
		this.startPos = (fromPosition && fromPosition.startPos) || null;

		const roomData = {
			spellNames: spellNames,
			status: 'waiting',
			created: this.created,
			[me]: { connected: true, uid: this[me + 'Uid'], displayName: this[me + 'DisplayName'], anon: !!userInfo?.isAnonymous },
			[other]: { connected: false },
			ranked: false,
			timeControl: this.timeControl,
			allowSpectators: this.allowSpectators,
			variant: this.variant,
		};
		if (this.startSfn) {
			roomData.startSfn = this.startSfn;
			roomData.creatorColor = me;
			if (this.startPos) roomData.startPos = this.startPos;
		}

		const roomRef = this.db.ref('rooms/' + code);
		await roomRef.set(roomData);
		this.roomRef = roomRef;

		this._writeActiveGameIndex(me);

		roomRef.child(other + '/connected').on('value', (snap) => {
			if (snap.val() === true && this.onOpponentJoin) {
				this._refreshPlayers().then(() => this.onOpponentJoin && this.onOpponentJoin());
			}
		});

		this._listenForTurns();
		roomRef.child(me + '/connected').onDisconnect().set(false);
		return code;
	}

	/**
	 * The creator's copy of the joiner's seat and the room's ranked flag,
	 * which the joiner writes: red records the finished game, and when red
	 * is the creator its record needs them.
	 */
	async _refreshPlayers() {
		try {
			const data = (await this.roomRef.once('value')).val() || {};
			for (const c of ['red', 'blue']) {
				if (c !== this.myColor && data[c]) {
					this[c + 'Uid'] = data[c].uid || null;
					this[c + 'DisplayName'] = data[c].displayName || 'Guest';
				}
			}
			this.ranked = !!data.ranked;
		} catch (e) {
			console.warn('[Sync] could not read the joined room:', e);
		}
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
		if (data.status === 'expired') throw new Error('This game invite has expired');

		this.timeControl = data.timeControl || { type: 'none' };
		this.allowSpectators = data.allowSpectators !== false;
		// Variant is room-scoped: the joiner inherits whatever the
		// creator picked. Default 'standard' for older rooms whose
		// data was written before the field existed.
		this.variant = normalizeVariant(data.variant);
		this.created = data.created || Date.now();
		// A room from a position (createRoom's fromPosition).
		this.startSfn = data.startSfn || null;
		this.startPos = data.startPos || null;
		this.creatorColor = data.creatorColor === 'blue' ? 'blue' : 'red';
		const creator = this.creatorColor;
		const joiner = creator === 'red' ? 'blue' : 'red';

		// Store the creator's info from room data
		if (data[creator]) {
			this[creator + 'Uid'] = data[creator].uid || null;
			this[creator + 'DisplayName'] = data[creator].displayName || 'Guest';
		}

		if (data.status === 'waiting') {
			const created = data.created || 0;
			if (created && (Date.now() - created > _INVITE_EXPIRY_MS)) {
				roomRef.remove().catch(() => {});
				if (data[creator] && data[creator].uid) {
					this.db.ref('user_active_games/' + data[creator].uid + '/' + code).remove().catch(() => {});
				}
				throw new Error('This game invite has expired');
			}

			// Normal first join, into the seat the creator left open
			this.myColor = joiner;
			this[joiner + 'Uid'] = userInfo?.uid || null;
			this[joiner + 'DisplayName'] = userInfo?.displayName || 'Guest';

			// Ranked: both players signed in to real accounts, and a game the
			// shared rule (elo.js unratedReason) rates. The rating function
			// checks both again.
			const creatorAnon = !!(data[creator] && data[creator].anon);
			this.ranked = !!(this.redUid && this.blueUid && !userInfo?.isAnonymous && !creatorAnon
				&& !unratedReason(data.spellNames, data.variant, this.startSfn, this.startPos));

			// Seat, status and ranked in ONE write: the creator's join
			// listener then reads them together (_refreshPlayers).
			await roomRef.update({
				[joiner]: { connected: true, uid: this[joiner + 'Uid'], displayName: this[joiner + 'DisplayName'], anon: !!userInfo?.isAnonymous },
				status: 'playing',
				ranked: this.ranked,
			});
			roomRef.child(joiner + '/connected').onDisconnect().set(false);

			this._writeActiveGameIndex(joiner);

			roomRef.child(creator + '/connected').on('value', (snap) => {
				if (snap.val() === false && this.onOpponentDisconnect) {
					this.onOpponentDisconnect();
				}
			});

			this._listenForTurns();
			return {
				spellNames: normalizeSpellNames(data.spellNames),
				myColor: joiner,
				startSfn: this.startSfn,
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

			for (const c of ['red', 'blue']) {
				if (data[c]) {
					this[c + 'Uid'] = data[c].uid || null;
					this[c + 'DisplayName'] = data[c].displayName || 'Guest';
				}
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
				spellNames: normalizeSpellNames(data.spellNames),
				myColor: this.myColor,
				sfn: data.currentSfn || null,
				startSfn: this.startSfn,
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
		for (const c of ['red', 'blue']) {
			if (data[c]) {
				this[c + 'Uid'] = data[c].uid || null;
				this[c + 'DisplayName'] = data[c].displayName || 'Guest';
			}
		}

		// Register spectator presence
		const specRef = this.roomRef.child('spectators').push();
		specRef.set({ joined: firebase.database.ServerValue.TIMESTAMP });
		specRef.onDisconnect().remove();

		// Listen for ALL turns (both colors)
		this._listenForAllTurns(data);

		return {
			spellNames: normalizeSpellNames(data.spellNames),
			myColor: null,
			isSpectator: true,
			sfn: data.currentSfn || null,
			startSfn: this.startSfn,
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
			// A stale-cached opponent may still send pre-rename spell tokens.
			const actions = (data.actions || []).map(normalizeSpellName);
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
					timestamp: firebase.database.ServerValue.TIMESTAMP,
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
					timestamp: firebase.database.ServerValue.TIMESTAMP,
				});
			}
			console.log('[Sync] sendTurn succeeded');
		} catch (e) {
			console.error('[Sync] sendTurn FAILED:', e.code, e.message);
		}
	}

	/**
	 * Initialize timer state when game starts (called by red).
	 * @param {object} config - timeControl from room
	 * @param {string} [firstColor] - who moves first ('red' unless the room
	 *   starts from a position with blue to move)
	 */
	async initTimer(config, firstColor) {
		if (!this.roomRef || !config || config.type === 'none') return;
		const first = firstColor === 'blue' ? 'blue' : 'red';

		let timerData;
		if (config.type === 'realtime') {
			timerData = {
				red: config.initialTime,
				blue: config.initialTime,
				activeColor: first,
				lastUpdated: firebase.database.ServerValue.TIMESTAMP,
			};
		} else if (config.type === 'correspondence') {
			timerData = {
				red: 0, // Will be set to deadline on first turn
				blue: 0,
				activeColor: first,
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
	 * Announce a forfeit: `color` concedes and their opponent wins. The
	 * `forfeitedBy` field is what the opponent's client listens to; the
	 * status/winner writes mirror writeTimeout so the room finishes (and
	 * spectators get their game-finished signal) even if the opponent's tab
	 * is already gone.
	 * @param {string} color - the CONCEDING player, 'red' or 'blue'
	 */
	async sendForfeit(color) {
		if (!this.roomRef) return;
		try {
			// The result FIRST, so the opponent ends the game through the
			// forfeit path (with attribution) rather than the bare
			// status-finished signal, and so the room never reads finished
			// without a winner (the rules require one, and finishedBy).
			await this.roomRef.update({
				forfeitedBy: color,
				finishedBy: color,
				winner: color === 'red' ? 'blue' : 'red',
			});
			await this._closeRoom();
			this._removeActiveGameIndex();
		} catch (e) {
			console.error('[Sync] sendForfeit FAILED:', e.code, e.message);
		}
	}

	/**
	 * Listen for a forfeit by either player. Fires immediately on subscribe if
	 * one is already recorded (reconnect), and on the forfeiter's own client
	 * too — callers guard against re-entry.
	 * @param {function} callback - receives the conceding color
	 */
	listenForForfeit(callback) {
		if (!this.roomRef) return;
		this.roomRef.child('forfeitedBy').on('value', (snap) => {
			const c = snap.val();
			if (c === 'red' || c === 'blue') callback(c);
		});
	}

	/**
	 * Write a timeout result (game over due to clock).
	 * Uses a transaction to prevent double-writes.
	 * @param {string} winner - 'red' or 'blue'
	 */
	async writeTimeout(winner) {
		if (!this.roomRef) return false;
		let committed = false;
		try {
			// The result before the status, which the rules allow only while
			// the room is playing: a client that sees the flag late is refused
			// here and is a witness, like the one whose transaction loses.
			await this.roomRef.update({ finishedBy: this.myColor, winner: winner, endReason: 'time' });
			committed = await this._closeRoom();
		} catch (e) {
			console.error('[Sync] writeTimeout FAILED:', e.code, e.message);
		}
		this._removeActiveGameIndex();
		return committed;
	}

	/**
	 * Listen for the room finishing by any route (timeout, forfeit, or a
	 * natural end written by the other client). Fires with (winner, reason)
	 * where reason is 'forfeit', 'time' or 'finished'; fires immediately on
	 * subscribe if the room is already finished (reconnect).
	 */
	listenForFinish(callback) {
		if (!this.roomRef) return;
		this.roomRef.child('status').on('value', async (snap) => {
			if (snap.val() !== 'finished') return;
			try {
				const s = await this.roomRef.once('value');
				const d = s.val() || {};
				const reason = d.forfeitedBy ? 'forfeit' : (d.endReason || 'finished');
				callback(d.winner || null, reason);
			} catch (e) {
				console.error('[Sync] listenForFinish read failed:', e);
			}
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

			// Enqueue each action from the opponent's turn. A stale-cached
			// opponent may still send pre-rename spell tokens.
			const actions = (data.actions || []).map(normalizeSpellName);
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
	 * Re-establish the creator's side of a waiting room after a page reload
	 * (red, or the creatorColor of a room from a position). Caller must have
	 * already verified that userInfo.uid matches the creator's uid.
	 */
	async reconnectAsCreator(code, userInfo, roomData) {
		const me = roomData.creatorColor === 'blue' ? 'blue' : 'red';
		const other = me === 'red' ? 'blue' : 'red';
		const created = roomData.created || 0;
		if (roomData.status === 'expired' || (roomData.status === 'waiting' && created && (Date.now() - created > _INVITE_EXPIRY_MS))) {
			this.db.ref('rooms/' + code).remove().catch(() => {});
			if (roomData[me] && roomData[me].uid) {
				this.db.ref('user_active_games/' + roomData[me].uid + '/' + code).remove().catch(() => {});
			}
			throw new Error('This game invite has expired');
		}

		this.roomCode = code;
		this.myColor = me;
		this.creatorColor = me;
		this.created = roomData.created || Date.now();
		this[me + 'Uid'] = userInfo?.uid || null;
		this[me + 'DisplayName'] = userInfo?.displayName || (roomData[me] && roomData[me].displayName) || 'Guest';
		this.timeControl = roomData.timeControl || { type: 'none' };
		this.allowSpectators = roomData.allowSpectators !== false;
		this.variant = normalizeVariant(roomData.variant);
		this.startSfn = roomData.startSfn || null;
		this.startPos = roomData.startPos || null;

		const roomRef = this.db.ref('rooms/' + code);
		this.roomRef = roomRef;

		await roomRef.child(me + '/connected').set(true);
		roomRef.child(me + '/connected').onDisconnect().set(false);

		this._writeActiveGameIndex(me);

		roomRef.child(other + '/connected').on('value', (snap) => {
			if (snap.val() === true && this.onOpponentJoin) {
				this._refreshPlayers().then(() => this.onOpponentJoin && this.onOpponentJoin());
			}
		});

		this._listenForTurns();
	}

	/**
	 * Mark the room as finished and persist the gameLog so future visitors can
	 * load review mode. Called by either player when the game ends.
	 *
	 * The stored gameLog is SLIM (color/turnNumber/kind/actions per turn plus
	 * one finalSfn and optional setupSfn on the room) — the review page
	 * rebuilds per-ply positions by replaying the transcript. Pre-refactor
	 * rooms with fat per-turn SFNs still load via the legacy review branch.
	 * @param {string} winner - 'red' or 'blue'
	 * @param {Array} gameLog - in-memory (fat) turn entries
	 * @param {string} [finalSfn] - final board SFN (integrity check)
	 * @param {string} [setupSfn] - starting SFN for imported-position games
	 */
	async writeRoomFinalState(winner, gameLog, finalSfn, setupSfn) {
		if (!this.roomRef) return;
		const slim = slimGameLog(gameLog);
		try {
			// The record for review first: it may follow a forfeit or a flag
			// that already finished the room.
			await this.roomRef.update({
				gameLog: slim,
				finalSfn: finalSfn || null,
				setupSfn: setupSfn || null,
				finishedAt: Date.now(),
			});
		} catch (e) {
			console.error('Failed to write room final state:', e);
		}
		try {
			// A natural end, if no one has finished the room yet: the server
			// replays the moves to check the winner (functions/rating.js).
			const status = (await this.roomRef.child('status').once('value')).val();
			if (status === 'playing') {
				// endReason cleared: a natural end, whatever the other side
				// may have written before it.
				await this.roomRef.update({ finishedBy: this.myColor, winner: winner, status: 'finished',
					endReason: null, closedAt: firebase.database.ServerValue.TIMESTAMP });
			}
		} catch (e) {
			// The other client finished it first.
		}
		this._removeActiveGameIndex();
	}

	/**
	 * playing -> finished, once: true if this client closed the room. The
	 * caller has written finishedBy (and the winner) first. closedAt is the
	 * server's time of closing, which the rating function judges a flag or
	 * an abandonment by; the rules refuse the write once the room is closed.
	 */
	async _closeRoom() {
		try {
			await this.roomRef.update({ status: 'finished', closedAt: firebase.database.ServerValue.TIMESTAMP });
			return true;
		} catch (e) {
			return false; // the other client closed it first
		}
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
			created: this.created || Date.now(),
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
	async createRematchRoom(spellNames, timeControl, allowSpectators, redInfo, blueInfo, ranked, variant, fromPosition) {
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
			variant: normalizeVariant(variant),
			// The rules seat both players at once only for a rematch of
			// a room they both sat in.
			rematchOf: this.roomCode,
		};
		// A rematch of a room from a position replays the same start.
		if (fromPosition && fromPosition.startSfn) {
			roomData.startSfn = fromPosition.startSfn;
			if (fromPosition.startPos) roomData.startPos = fromPosition.startPos;
		}
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
 * Load the Rust engine's stored per-position evaluation of a recorded game
 * (`game_evals/<roomCode>`, written offline by engine/harness/eval_games.py;
 * clients cannot write it). Room codes are not unique across the whole
 * history, so callers must check the document's `finalSfn` against the game
 * they are showing before trusting it. Returns null if not present.
 */
async function loadGameEvals(db, roomCode) {
	if (!db || !roomCode) return null;
	const snap = await db.ref('game_evals/' + roomCode).once('value');
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
