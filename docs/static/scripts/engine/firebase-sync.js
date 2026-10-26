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
		// Connection and unsent writes, for the "reconnecting" banner:
		// called with { connected, pending, error }.
		this.onSyncStatus = null;
		this._connected = true;
		this._pending = 0;
		this._writeError = null;
		this._presenceColor = null;

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
		// Why the room is unrated (roomUnratedReason), null when rated.
		this.unratedWhy = null;
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

		// The database connection: re-announce our seat after a drop (the
		// server ran our onDisconnect while we were gone).
		db.ref('.info/connected').on('value', (snap) => {
			this._connected = snap.val() === true;
			if (this._connected && this._presenceColor) this._goOnline(this._presenceColor).catch(() => {});
			this._syncStatus();
		});

		// Time control config (set during createRoom/joinRoom)
		this.timeControl = null;

		// Game-rules variant ('standard' | 'competitive'), set during
		// createRoom / joinRoom and replicated to the joining peer
		// through the room metadata.
		this.variant = 'standard';
	}

	/**
	 * Mark our seat present. Each connection (tab) holds its own entry in
	 * the seat's `conns`, removed by the server when that connection drops,
	 * which also stamps `disconnectedAt` with the server's clock: the seat is
	 * gone only when no connection is left, and the opponent's grace period
	 * counts from the last drop (functions/rating.js abandoned).
	 */
	async _goOnline(color) {
		if (!this.roomRef) return;
		this._presenceColor = color;
		const seat = this.roomRef.child(color);
		if (!this._connId) this._connId = seat.child('conns').push().key;
		const conn = seat.child('conns/' + this._connId);
		const ts = firebase.database.ServerValue.TIMESTAMP;
		try {
			await conn.onDisconnect().remove();
			await seat.child('disconnectedAt').onDisconnect().set(ts);
			await seat.child('connected').onDisconnect().set(false);
			await conn.set(ts);
			await seat.update({ connected: true, disconnectedAt: null });
		} catch (e) {
			// A finished room's seats are frozen (the rating judges an
			// abandonment by them): nothing to announce.
		}
	}

	/**
	 * Watch the opponent's seat: callback({ connected, disconnectedAt }).
	 * Fires at once with the current state.
	 */
	listenToOpponentPresence(callback) {
		if (!this.roomRef || !this.myColor) return;
		const opp = this.myColor === 'red' ? 'blue' : 'red';
		this.roomRef.child(opp).on('value', (snap) => {
			const s = snap.val() || {};
			// Seats of older clients have no conns: their flag decides.
			const connected = s.conns ? Object.keys(s.conns).length > 0 : s.connected !== false;
			callback({ connected, disconnectedAt: connected ? null : (typeof s.disconnectedAt === 'number' ? s.disconnectedAt : null) });
		});
	}

	/** Count a write until the server acknowledges it. */
	async _track(promise) {
		this._pending++;
		this._syncStatus();
		try {
			// A refused write stays reported until the page resyncs: a later
			// accepted write does not mean the refused move arrived.
			return await promise;
		} catch (e) {
			this._writeError = (e && (e.code || e.message)) || 'error';
			throw e;
		} finally {
			this._pending--;
			this._syncStatus();
		}
	}

	_syncStatus() {
		if (this.onSyncStatus) {
			this.onSyncStatus({ connected: this._connected, pending: this._pending, error: this._writeError });
		}
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
	 *   startPos (position-rating.js; absent = unrated) }
	 * @param {object} [opts] - { creatorColor: 'red' | 'blue' | 'random' (the
	 *   creator's seat, resolved here; default red), public (listed in the
	 *   lobby's open games), casual (never rated: the joiner writes
	 *   ranked:false and the rules hold it there) }. All three are fixed at
	 *   creation. A fromPosition.creatorColor is still honoured.
	 */
	async createRoom(spellNames, userInfo, timeControl, allowSpectators, variant, fromPosition, opts) {
		const code = _generateRoomCode();
		let pick = (opts && opts.creatorColor) || (fromPosition && fromPosition.creatorColor) || 'red';
		if (pick === 'random') pick = Math.random() < 0.5 ? 'red' : 'blue';
		const me = pick === 'blue' ? 'blue' : 'red';
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
			// The joiner takes the other seat (joinRoom).
			creatorColor: me,
		};
		this.isPublic = !!(opts && opts.public);
		this.casual = !!(opts && opts.casual);
		if (this.isPublic) roomData.public = true;
		if (this.casual) roomData.casual = true;
		if (this.startSfn) {
			roomData.startSfn = this.startSfn;
			if (this.startPos) roomData.startPos = this.startPos;
		}

		const roomRef = this.db.ref('rooms/' + code);
		await roomRef.set(roomData);
		this.roomRef = roomRef;
		// rooms/ is not listable: a public room is announced in open_rooms/
		// (the rules check it against the room). Best-effort: a missing
		// entry only keeps the room off the lobby list.
		if (this.isPublic) this.db.ref('open_rooms/' + code).set(true).catch((e) => console.warn('[Sync] open_rooms:', e));

		this._writeActiveGameIndex(me);

		roomRef.child(other + '/connected').on('value', (snap) => {
			if (snap.val() === true) this._opponentArrived();
		});

		this._listenForTurns();
		await this._goOnline(me);
		return code;
	}

	/**
	 * The opponent's seat came online. A public room can be joined before
	 * the lobby has installed onOpponentJoin (createRoom is still running):
	 * the arrival is kept and delivered when the handler is set.
	 */
	_opponentArrived() {
		if (!this._onOpponentJoin) { this._arrivalPending = true; return; }
		this._refreshPlayers().then(() => this._onOpponentJoin && this._onOpponentJoin());
	}

	get onOpponentJoin() { return this._onOpponentJoin || null; }

	set onOpponentJoin(fn) {
		this._onOpponentJoin = fn;
		if (fn && this._arrivalPending) {
			this._arrivalPending = false;
			this._opponentArrived();
		}
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
			this.unratedWhy = this.ranked ? null : roomUnratedReason(data);
		} catch (e) {
			console.warn('[Sync] could not read the joined room:', e);
		}
	}

	/**
	 * Join an existing room.
	 * @param {string} code - room code
	 * @param {object} [userInfo] - { uid, displayName, elo, isAnonymous }
	 * @param {object} [opts] - { seatOnly: only take the open seat of a
	 *   waiting room; never reconnect or spectate. A room someone else
	 *   joined first (or its creator withdrew) throws an Error with code
	 *   'seat-taken'. The lobby's open games and quick pair use it. }
	 * @returns {{ spellNames, myColor, sfn?, isSpectator?, timeControl? }}
	 */
	async joinRoom(code, userInfo, opts) {
		const seatOnly = !!(opts && opts.seatOnly);
		const taken = () => Object.assign(new Error('Someone else joined first.'), { code: 'seat-taken' });
		this.roomCode = code;

		const roomRef = this.db.ref('rooms/' + code);
		this.roomRef = roomRef;

		const snap = await roomRef.once('value');
		const data = snap.val();
		if (seatOnly && (!data || data.status !== 'waiting')) throw taken();
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
			// A casual room (the creator's choice) is never rated.
			this.casual = data.casual === true;
			this.isPublic = data.public === true;
			this.unratedWhy = roomUnratedReason(data, userInfo);
			this.ranked = !this.unratedWhy;

			// Seat, status and ranked in ONE write: the creator's join
			// listener then reads them together (_refreshPlayers). The rules
			// give the seat to the first claim only: a second joiner, or a
			// join after the creator withdrew, is refused.
			try {
				await roomRef.update({
					[joiner]: { connected: true, uid: this[joiner + 'Uid'], displayName: this[joiner + 'DisplayName'], anon: !!userInfo?.isAnonymous },
					status: 'playing',
					ranked: this.ranked,
					// The server's time the game began: the first mover's clock
					// (functions/rating.js flagged) runs from it.
					startedAt: firebase.database.ServerValue.TIMESTAMP,
				});
			} catch (e) {
				const now = (await roomRef.once('value').catch(() => null));
				const v = now && now.val();
				if (!v || v.status !== 'waiting' || (v[joiner] && v[joiner].uid)) throw taken();
				throw e;
			}
			// Off the open-games list, and on Watch Live if spectators may watch.
			this.db.ref('open_rooms/' + code).remove().catch(() => {});
			if (data.allowSpectators !== false) this.db.ref('live_rooms/' + code).set(true).catch(() => {});
			await this._goOnline(joiner);

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
			this.unratedWhy = this.ranked ? null : roomUnratedReason(data);

			await this._goOnline(this.myColor);

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
		this.ranked = !!data.ranked;
		this.unratedWhy = this.ranked ? null : roomUnratedReason(data);

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

		// Listen for game over (or an abort, which ends the stream too)
		this.roomRef.child('status').on('value', (snap) => {
			if (snap.val() === 'finished' || snap.val() === 'aborted') {
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
			await this._track(this.roomRef.child('currentSfn').set(sfn));
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
			// One write: the turn, the timer, and the end of any takeback
			// request. `after` names the turn this one follows; the rules
			// refuse it if a takeback has removed that turn, and an accepted
			// takeback can no longer remove turns once the request is gone,
			// so a move and an acceptance can never both land.
			const turnKey = this.roomRef.child('turns').push().key;
			const keys = this._turnKeys || [];
			const turn = {
				color: this.myColor,
				actions: actions,
				timestamp: firebase.database.ServerValue.TIMESTAMP,
			};
			if (keys.length) turn.after = keys[keys.length - 1];
			const updates = { ['turns/' + turnKey]: turn, takeback: null };
			if (timerUpdate) {
				updates['timer/red'] = timerUpdate.red;
				updates['timer/blue'] = timerUpdate.blue;
				updates['timer/activeColor'] = timerUpdate.activeColor;
				updates['timer/lastUpdated'] = firebase.database.ServerValue.TIMESTAMP;
			}
			await this._track(this.roomRef.update(updates));
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
			await this._track(this.roomRef.update({
				forfeitedBy: color,
				finishedBy: color,
				winner: color === 'red' ? 'blue' : 'red',
			}));
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
			if (snap.val() === 'aborted') {
				callback(null, 'aborted');
				return;
			}
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
	 * Follow the number of spectators watching this room.
	 * @param {function} callback - receives the count
	 */
	listenToSpectators(callback) {
		if (!this.roomRef) return;
		this.roomRef.child('spectators').on('value', (snap) => callback(snap.numChildren()));
	}

	/**
	 * Wait for the completed_games key of this finished room, which the
	 * server writes to rooms/{code}/gameId when it records the game.
	 * Resolves with the key, or null when it did not arrive in time.
	 */
	awaitGameId(timeoutMs) {
		if (!this.roomRef) return Promise.resolve(null);
		const ref = this.roomRef.child('gameId');
		return new Promise((resolve) => {
			let timer = null;
			const done = (v) => {
				clearTimeout(timer);
				ref.off('value', onValue);
				resolve(v);
			};
			const onValue = (snap) => {
				if (typeof snap.val() === 'string') done(snap.val());
			};
			timer = setTimeout(() => done(null), timeoutMs || 60000);
			ref.on('value', onValue, () => done(null));
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
		// Every turn in the room, including those before a reload (the
		// controller's log holds only the turns since).
		this._turnKeys = [];
		// A takeback both players agreed to removes turns: start over from
		// the room (the reconnect path rebuilds from currentSfn).
		turnsRef.on('child_removed', () => {
			if (this.onTurnsRemoved) this.onTurnsRemoved();
		});
		turnsRef.on('child_added', (snap) => {
			this._turnKeys.push(snap.key);
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

	/**
	 * Withdraw our own waiting room (the lobby's Cancel, or quick pair
	 * moving to an older seek): waiting -> expired in a transaction, so a
	 * joiner who got in first keeps the game, then the room is removed.
	 * Returns true if the room was withdrawn, false if someone joined it.
	 */
	async withdrawRoom(code) {
		const roomRef = this.db.ref('rooms/' + code);
		const statusRef = roomRef.child('status');
		// A transaction starts from the local cache: listen first so it
		// sees the server's status, not null.
		const keep = () => {};
		statusRef.on('value', keep);
		let res;
		try {
			await statusRef.once('value');
			res = await statusRef.transaction((current) => {
				if (current === 'waiting') return 'expired';
				return; // joined (or gone): leave it
			});
		} finally {
			statusRef.off('value', keep);
		}
		if (!res || !res.committed) return false;
		this._unlistRoom(code);
		if (this.roomRef && this.roomCode === code) {
			if (this.myColor) this.roomRef.child(this.myColor).onDisconnect().cancel().catch(() => {});
			this.roomRef.off();
			this.roomRef = null;
			this.roomCode = null;
			this._presenceColor = null;
			this.onOpponentJoin = null;
		}
		const uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
		if (uid) this.db.ref('user_active_games/' + uid + '/' + code).remove().catch(() => {});
		await roomRef.remove().catch(() => {});
		return true;
	}

	/**
	 * The lobby's rooms: 'waiting' = public open games (open_rooms/), and
	 * 'playing' = games spectators may watch (live_rooms/). rooms/ itself is
	 * not listable (private invites and no-spectator games stay unlisted),
	 * so these read the public index and then each room by its code. An
	 * entry whose room no longer qualifies is skipped and, best-effort,
	 * removed (the rules allow anyone to drop a stale entry).
	 */
	_lobbyIndex(status) {
		return status === 'waiting' ? 'open_rooms' : 'live_rooms';
	}

	_lobbyRoomOk(status, room) {
		if (!room || room.status !== status) return false;
		return status === 'waiting' ? room.public === true : room.allowSpectators !== false && room.local !== true;
	}

	/**
	 * callback(rooms) gets [{ code, ...room }] each time the set or one of
	 * its rooms changes. Returns an unsubscribe function.
	 */
	watchRoomsByStatus(status, callback) {
		const idx = this._lobbyIndex(status);
		const indexRef = this.db.ref(idx);
		const subs = new Map(); // code -> { ref, handler, room }
		const emit = () => {
			const out = [];
			for (const [code, sub] of subs) {
				if (this._lobbyRoomOk(status, sub.room)) out.push(Object.assign({ code }, sub.room));
			}
			callback(out);
		};
		const onIndex = (snap) => {
			const codes = new Set(Object.keys(snap.val() || {}));
			for (const [code, sub] of subs) {
				if (!codes.has(code)) { sub.ref.off('value', sub.handler); subs.delete(code); }
			}
			for (const code of codes) {
				if (subs.has(code)) continue;
				const ref = this.db.ref('rooms/' + code);
				const sub = { ref, room: null, handler: null };
				sub.handler = (rs) => {
					sub.room = rs.val();
					if (!this._lobbyRoomOk(status, sub.room)) this.db.ref(idx + '/' + code).remove().catch(() => {});
					emit();
				};
				subs.set(code, sub);
				ref.on('value', sub.handler, () => { subs.delete(code); emit(); });
			}
			emit();
		};
		indexRef.on('value', onIndex, (e) => { console.warn('[Sync] lobby index failed:', e); callback([]); });
		return () => {
			indexRef.off('value', onIndex);
			for (const sub of subs.values()) sub.ref.off('value', sub.handler);
			subs.clear();
		};
	}

	/** The listed rooms with this status, once: [{ code, ...room }]. */
	async listRoomsByStatus(status) {
		const idx = this._lobbyIndex(status);
		const codes = Object.keys((await this.db.ref(idx).once('value')).val() || {});
		const rooms = await Promise.all(codes.map((code) =>
			this.db.ref('rooms/' + code).once('value').then((rs) => rs.val(), () => null)));
		const out = [];
		codes.forEach((code, i) => {
			if (this._lobbyRoomOk(status, rooms[i])) out.push(Object.assign({ code }, rooms[i]));
			else this.db.ref(idx + '/' + code).remove().catch(() => {});
		});
		return out;
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

		await this._goOnline(me);

		this._writeActiveGameIndex(me);

		roomRef.child(other + '/connected').on('value', (snap) => {
			if (snap.val() === true) this._opponentArrived();
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
		this._unlistRoom();
		this._removeActiveGameIndex();
	}

	/**
	 * Claim the game because the opponent left: allowed once their seat has
	 * been gone for ABANDON_GRACE_MS and both players have moved (the
	 * rating function checks both). Returns true if this client closed it.
	 */
	async claimAbandoned(winner) {
		if (!this.roomRef) return false;
		try {
			// One write: the claim and the close together, so the opponent's
			// seat is frozen exactly as it was when the claim was judged
			// (a reconnect in between would otherwise slip in).
			await this.roomRef.update({ finishedBy: this.myColor, winner: winner, endReason: 'abandon',
				status: 'finished', closedAt: firebase.database.ServerValue.TIMESTAMP });
			this._removeActiveGameIndex();
			return true;
		} catch (e) {
			console.error('[Sync] claimAbandoned FAILED:', e.code, e.message);
			return false;
		}
	}

	/**
	 * Abort the game: no result, no rating. Offered before both players
	 * have moved; later the server counts it as a forfeit (functions/
	 * index.js settleAbort).
	 */
	async abortGame() {
		if (!this.roomRef) return;
		try {
			await this.roomRef.update({ abortedBy: this.myColor, status: 'aborted' });
			this._unlistRoom();
			this._removeActiveGameIndex();
		} catch (e) {
			console.error('[Sync] abortGame FAILED:', e.code, e.message);
		}
	}

	/* ----- Takebacks by agreement ----- */

	/**
	 * Ask to take back our last turn, and the opponent's reply if they have
	 * moved since: rooms/{code}/takeback names the turns to remove. Only the
	 * opponent can remove them (database.rules.json), by accepting.
	 */
	async requestTakeback() {
		if (!this.roomRef || !this._turnKeys || !this._turnKeys.length) return false;
		const turns = (await this.roomRef.child('turns').once('value')).val() || {};
		const keys = this._turnKeys.filter((k) => turns[k]);
		const lastMine = keys.length && turns[keys[keys.length - 1]].color === this.myColor;
		const undo = keys.slice(lastMine ? -1 : -2);
		if (!undo.length || turns[undo[0]].color !== this.myColor) return false;
		// The server's clocks run from the turns' timestamps (room-clock.js):
		// a correspondence deadline would not restart, and a timed game with
		// no turn left would lose its anchor. Those takebacks are not offered.
		const tc = this.timeControl || {};
		if (tc.type === 'correspondence') return false;
		if (tc.type === 'realtime' && undo.length >= keys.length) return false;
		const map = {};
		for (const k of undo) map[k] = true;
		try {
			await this.roomRef.child('takeback').set({ by: this.myColor, keys: map, at: firebase.database.ServerValue.TIMESTAMP });
			return true;
		} catch (e) {
			console.error('[Sync] requestTakeback FAILED:', e.code, e.message);
			return false;
		}
	}

	/** Watch the takeback request: callback(request or null). */
	listenForTakeback(callback) {
		if (!this.roomRef) return;
		this.roomRef.child('takeback').on('value', (snap) => {
			this._takeback = snap.val();
			callback(this._takeback);
		});
	}

	/** Withdraw our request, or decline the opponent's. */
	async clearTakeback() {
		if (!this.roomRef) return;
		try { await this.roomRef.child('takeback').remove(); } catch (e) { /* already gone */ }
	}

	/** The room as the server holds it now (not the local cache). */
	async readRoom() {
		if (!this.roomRef) return null;
		const snap = typeof this.roomRef.get === 'function' ? await this.roomRef.get() : await this.roomRef.once('value');
		return snap.val();
	}

	/**
	 * Follow the room's records that move a clock (room-clock.js): pauses
	 * (a player's vacation, written by the server) and gifts of time.
	 * @param {function} callback - receives { pauses, gifts, startedAt, ready }
	 *   (ready once all three have loaded)
	 */
	listenToClockRecords(callback) {
		if (!this.roomRef) return;
		const rec = { pauses: null, gifts: null, startedAt: null, ready: false };
		const keys = ['pauses', 'gifts', 'startedAt'];
		const seen = new Set();
		for (const k of keys) {
			this.roomRef.child(k).on('value', (snap) => {
				rec[k] = snap.val();
				seen.add(k);
				rec.ready = seen.size === keys.length;
				callback(Object.assign({}, rec));
			});
		}
	}

	/**
	 * Give the opponent ROOM_GIFT_MS (realtime games). The rules accept a
	 * gift only to the other seat, stamped with the server's time, at most
	 * once a second per seat: giftAt/{seat} names the one gift each write
	 * may add.
	 */
	async giveTime() {
		if (!this.roomRef || (this.myColor !== 'red' && this.myColor !== 'blue')) return false;
		const to = this.myColor === 'red' ? 'blue' : 'red';
		const key = this.roomRef.child('gifts').push().key;
		const ts = firebase.database.ServerValue.TIMESTAMP;
		try {
			// Not _track: a gift refused (too soon after the last) is no
			// lost move.
			await this.roomRef.update({
				['gifts/' + key]: { to, ms: ROOM_GIFT_MS, at: ts },
				['giftAt/' + this.myColor]: { key, at: ts },
			});
			return true;
		} catch (e) {
			console.error('[Sync] giveTime FAILED:', e.code, e.message);
			return false;
		}
	}

	/**
	 * Accept the opponent's request: remove its turns (they must be the
	 * last ones played) and set the position before them, in one write.
	 * @param {object} req - the takeback request
	 * @param {string|null} sfn - the position after the last turn kept
	 *   (null: back to the start)
	 */
	async acceptTakeback(req, sfn) {
		if (!this.roomRef || !req || !req.keys) return false;
		const undo = Object.keys(req.keys);
		const tail = (this._turnKeys || []).slice(-undo.length);
		if (undo.some((k) => !tail.includes(k))) {
			await this.clearTakeback();
			return false;
		}
		const updates = { takeback: null, currentSfn: sfn || null };
		for (const k of undo) updates['turns/' + k] = null;
		// The requester is to move again: their clock runs (a correspondence
		// deadline restarts from now).
		const timer = (await this.roomRef.child('timer').once('value')).val();
		if (timer && this.timeControl && this.timeControl.type !== 'none') {
			updates['timer/activeColor'] = req.by;
			updates['timer/lastUpdated'] = firebase.database.ServerValue.TIMESTAMP;
			if (this.timeControl.type === 'correspondence' && this.timeControl.moveTimeout) {
				updates['timer/' + req.by] = this.serverNow() + this.timeControl.moveTimeout;
			}
		}
		try {
			await this._track(this.roomRef.update(updates));
			return true;
		} catch (e) {
			console.error('[Sync] acceptTakeback FAILED:', e.code, e.message);
			return false;
		}
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
			this._unlistRoom();
			return true;
		} catch (e) {
			return false; // the other client closed it first
		}
	}

	/** Drop this room from the lobby indexes (open_rooms, live_rooms); best-effort. */
	_unlistRoom(code) {
		const c = code || this.roomCode;
		if (!c) return;
		this.db.ref('open_rooms/' + c).remove().catch(() => {});
		this.db.ref('live_rooms/' + c).remove().catch(() => {});
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
				this._presenceColor = null;
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
			startedAt: firebase.database.ServerValue.TIMESTAMP,
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
		if (roomData.allowSpectators) this.db.ref('live_rooms/' + code).set(true).catch(() => {});
		return code;
	}

	/** Publish the rematch room code on the OLD room so both clients can navigate to it. */
	async setRematchNewRoomCode(code) {
		if (!this.roomRef) return;
		await this.roomRef.child('rematch/newRoomCode').set(code);
	}
}

/**
 * Why a room is (or would be) unrated, or null when it is rated: both seats
 * need full (non-anonymous) accounts, and the game must pass the shared rule
 * (elo.js unratedReason). `joiner` ({ uid, isAnonymous }, as userInfo) fills
 * the open seat of a room not yet joined; omit it for a joined room.
 * @returns {null|string} 'guest-account' or an unratedReason code
 */
function roomUnratedReason(data, joiner) {
	// The creator chose a casual game (lobby).
	if (data.casual === true) return 'casual';
	const creator = data.creatorColor === 'blue' ? 'blue' : 'red';
	const seats = { red: data.red || {}, blue: data.blue || {} };
	if (joiner !== undefined) {
		seats[creator === 'red' ? 'blue' : 'red'] = { uid: (joiner && joiner.uid) || null, anon: !!(joiner && joiner.isAnonymous) };
	}
	if (!seats.red.uid || !seats.blue.uid || seats.red.anon || seats.blue.anon) return 'guest-account';
	return unratedReason(data.spellNames, data.variant, data.startSfn || null, data.startPos || null);
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
