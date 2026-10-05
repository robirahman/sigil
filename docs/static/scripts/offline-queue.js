/**
 * offline-queue.js — local persistence for completed local games (vs AI and
 * local 1v1) until Firebase is reachable.
 *
 * When a game ends, the caller stores everything needed to reproduce the
 * Firebase writes (rooms/{code}, completed_games/{gameId}, Elo processing) in
 * localStorage BEFORE touching the network, so a game finished offline (or a
 * tab closed mid-upload) is never lost. The queue is flushed automatically:
 *   - immediately after enqueue (no-op if Firebase is unreachable)
 *   - on page load
 *   - whenever the Realtime Database connection comes up (.info/connected)
 *   - on the browser's `online` event
 *   - on Firebase auth resolution
 *
 * Queue items are an opaque envelope:
 *   { id, queuedAt, gameId, uid, roomCode, roomRecord, gameRecord,
 *     aiUid?, aiName?, difficulty? }
 * `gameId` is the completed_games key, fixed at enqueue time so a retry after
 * a half-finished upload rewrites the same record instead of duplicating it.
 * `uid` is the signed-in player the game belongs to; an item is only uploaded
 * while that player is signed in.
 *
 * Each flush is sequential — entries are processed in queue order so Elo
 * updates compose correctly across multiple stacked offline games.
 */
(function () {
	const STORAGE_KEY = 'sigil_offline_games_v1';
	// How long a flush waits for the database connection before giving up
	// (the next .info/connected transition retries).
	const CONNECT_TIMEOUT_MS = 8000;

	function _read() {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return [];
			const arr = JSON.parse(raw);
			return Array.isArray(arr) ? arr : [];
		} catch (e) {
			console.warn('[OfflineQueue] read failed:', e);
			return [];
		}
	}

	function _write(items) {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
			return true;
		} catch (e) {
			console.error('[OfflineQueue] write failed:', e);
			return false;
		}
	}

	function _genId() {
		return 'ofq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
	}

	// completed_games key minted locally: Firebase push ids are generated
	// client-side, so this works with no connection. Falls back to a random
	// key if the SDK is unavailable (it never reaches Firebase without it).
	function _mintGameId() {
		try {
			if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
				return firebase.database().ref('completed_games').push().key;
			}
		} catch (e) { /* fall through */ }
		return 'ofl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
	}

	// The player the item belongs to: explicit `uid`, else (items queued
	// before `uid` existed) the non-AI side of the record.
	function _ownerUid(item) {
		if (item.uid) return item.uid;
		const g = item.gameRecord || {};
		if (g.redUid && g.redUid !== item.aiUid) return g.redUid;
		if (g.blueUid && g.blueUid !== item.aiUid) return g.blueUid;
		return null;
	}

	// Flushes are chained, not deduped. Multiple triggers (auth change,
	// reconnect, post-game) can fire near-simultaneously; serializing them
	// keeps Elo updates ordered and avoids double-uploading the same item,
	// while still letting each call observe its own outcome — items enqueued
	// between the start and end of an earlier flush ride along on the next
	// link in the chain.
	let _flushChain = Promise.resolve({ uploaded: 0, failed: 0, results: [] });

	const OfflineGameQueue = {
		/** Store a finished game. Returns the queue id, or null if storage failed. */
		enqueue(item) {
			const items = _read();
			const entry = Object.assign({}, item);
			entry.id = entry.id || _genId();
			entry.queuedAt = entry.queuedAt || Date.now();
			entry.gameId = entry.gameId || _mintGameId();
			items.push(entry);
			if (!_write(items)) return null;
			if (_autoflushInstalled) _watchConnection();
			return entry.id;
		},

		count() {
			return _read().length;
		},

		peek() {
			return _read();
		},

		remove(id) {
			_write(_read().filter((it) => it.id !== id));
		},

		clear() {
			_write([]);
		},

		/**
		 * Try to upload every queued game owned by the signed-in player.
		 *
		 * @param {firebase.database.Database} db
		 * @param {function} processEloFn - processEloClientSide
		 * @returns {Promise<{uploaded, failed, results}>}
		 */
		flushAll(db, processEloFn) {
			const link = _flushChain.then(
				() => _doFlush(db, processEloFn),
				() => _doFlush(db, processEloFn),
			);
			_flushChain = link.catch(() => {});
			return link;
		},
	};

	/**
	 * Resolve true once the Realtime Database reports a live connection,
	 * false after `timeoutMs`. Firebase reads/writes issued while
	 * disconnected never settle, so the flush checks this first instead of
	 * hanging on a dead network (navigator.onLine is often wrong).
	 */
	function _waitConnected(db, timeoutMs) {
		return new Promise((resolve) => {
			let ref;
			try {
				ref = db.ref('.info/connected');
			} catch (e) {
				resolve(false);
				return;
			}
			let done = false;
			const finish = (v) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				ref.off('value', onValue);
				resolve(v);
			};
			const onValue = (snap) => { if (snap.val() === true) finish(true); };
			const timer = setTimeout(() => finish(false), timeoutMs);
			ref.on('value', onValue);
		});
	}

	async function _doFlush(db, processEloFn) {
		const user = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
		const uid = user && !user.isAnonymous ? user.uid : null;
		const items = _read().filter((it) => uid && _ownerUid(it) === uid);
		if (items.length === 0) {
			return { uploaded: 0, failed: 0, results: [] };
		}
		const offlineResult = (error) => ({
			uploaded: 0,
			failed: items.length,
			results: items.map((it) => ({ id: it.id, ok: false, error: error })),
		});
		if (typeof navigator !== 'undefined' && navigator.onLine === false) {
			return offlineResult('offline');
		}
		if (!(await _waitConnected(db, CONNECT_TIMEOUT_MS))) {
			return offlineResult('unreachable');
		}
		const results = [];
		let uploaded = 0;
		let failed = 0;
		for (const item of items) {
			try {
				const eloResult = await _uploadOne(db, processEloFn, item, user);
				OfflineGameQueue.remove(item.id);
				uploaded++;
				results.push({ id: item.id, ok: true, eloResult: eloResult });
			} catch (e) {
				failed++;
				results.push({ id: item.id, ok: false, error: (e && e.message) || String(e) });
				// Stop on first failure: the network may have dropped mid-flush.
				// Remaining items stay queued for the next attempt.
				break;
			}
		}
		return { uploaded, failed, results };
	}

	async function _uploadOne(db, processEloFn, item, user) {
		// Items queued before gameId existed get one now, persisted before
		// any write so every retry targets the same key.
		if (!item.gameId) {
			item.gameId = db.ref('completed_games').push().key;
			_write(_read().map((it) => (it.id === item.id ? Object.assign({}, it, { gameId: item.gameId }) : it)));
		}
		const gameId = item.gameId;
		const record = item.gameRecord || {};
		const ranked = !!(record.ranked && typeof processEloFn === 'function');

		// A ranked upload that already finished (Elo writes user_games
		// atomically, last) but whose removal from the queue was lost — e.g.
		// the tab closed — must not be rated twice.
		if (ranked) {
			const done = await db.ref('user_games/' + user.uid + '/' + gameId).once('value');
			if (done.exists()) return null;
		}

		await _ensureHumanProfile(db, user);
		if (item.roomCode && item.roomRecord) {
			try {
				await db.ref('rooms/' + item.roomCode).set(item.roomRecord);
			} catch (e) {
				console.warn('[OfflineQueue] room record write failed:', e.message);
			}
		}
		if (item.aiUid && item.aiName) {
			await _ensureAiUser(db, item.aiUid, item.aiName);
		}
		await db.ref('completed_games/' + gameId).set(record);
		if (ranked) {
			return await processEloFn(db, gameId, record);
		}
		return null;
	}

	// Create the player's /users and /leaderboard entries if this is their
	// first rated game (formerly done at game end, which needs the network).
	async function _ensureHumanProfile(db, user) {
		if (typeof AuthManager === 'undefined') return;
		try {
			await AuthManager.prototype.ensureUserProfile.call(
				{ currentUser: user, userProfile: null }, db);
		} catch (e) {
			console.warn('[OfflineQueue] profile bootstrap failed:', e.message);
		}
	}

	async function _ensureAiUser(db, aiUid, aiName) {
		const ref = db.ref('users/' + aiUid);
		const snap = await ref.once('value');
		if (snap.exists()) return;
		await ref.set({
			displayName: aiName,
			elo: 1000,
			gamesPlayed: 0,
			wins: 0,
			losses: 0,
			created: Date.now(),
			isAI: true,
		});
		try {
			await db.ref('leaderboard/' + aiUid).set({
				displayName: aiName,
				elo: 1000,
				gamesPlayed: 0,
				isAI: true,
			});
		} catch (e) { /* non-fatal */ }
	}

	let _autoflushInstalled = false;
	let _onFlush = null;
	let _watchingConnection = false;

	async function _attempt() {
		if (typeof firebase === 'undefined' || !firebase.apps || firebase.apps.length === 0) return;
		if (typeof processEloClientSide !== 'function') return;
		if (OfflineGameQueue.count() === 0) return;
		const user = firebase.auth().currentUser;
		if (!user || user.isAnonymous) return;
		try {
			const db = firebase.database();
			const result = await OfflineGameQueue.flushAll(db, processEloClientSide);
			if (_onFlush && result.uploaded > 0) {
				try { _onFlush(result); } catch (e) { /* swallow */ }
			}
		} catch (e) {
			console.warn('[OfflineQueue] autoflush failed:', e);
		}
	}

	// Upload the moment the site becomes reachable again: the Realtime
	// Database reports each (re)connection on .info/connected. Only opened
	// while something is queued, so idle pages don't hold a connection.
	function _watchConnection() {
		if (_watchingConnection) return;
		if (typeof firebase === 'undefined' || !firebase.apps || firebase.apps.length === 0) return;
		_watchingConnection = true;
		firebase.database().ref('.info/connected').on('value', (snap) => {
			if (snap.val() === true) _attempt();
		});
	}

	/**
	 * Wire up automatic flushing on this page. Safe to call multiple times;
	 * only the first call installs the listeners.
	 *
	 * @param {object} opts
	 * @param {function} [opts.onFlush] - notified with the flush result
	 *   ({ uploaded, failed, results }) when at least one item was uploaded.
	 */
	OfflineGameQueue.installAutoflush = function installAutoflush(opts) {
		if (_autoflushInstalled) return;
		_autoflushInstalled = true;
		_onFlush = (opts && opts.onFlush) || null;

		if (typeof window !== 'undefined') {
			window.addEventListener('online', _attempt);
		}
		if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
			firebase.auth().onAuthStateChanged(() => { _attempt(); });
		}
		if (OfflineGameQueue.count() > 0) _watchConnection();
		// First attempt on next tick so callers can register an onFlush
		// callback before any results fire.
		setTimeout(_attempt, 0);
	};

	if (typeof window !== 'undefined') {
		window.OfflineGameQueue = OfflineGameQueue;
	}
})();
