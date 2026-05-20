/**
 * offline-queue.js — local persistence for completed AI games when offline.
 *
 * When a single-player game ends, the caller stores everything needed to
 * reproduce the Firebase writes (rooms/{code}, completed_games push, Elo
 * processing) in localStorage. The queue is flushed automatically:
 *   - immediately after enqueue (no-op if offline)
 *   - on page load
 *   - on the browser's `online` event
 *   - on Firebase auth resolution
 *
 * Queue items are an opaque envelope:
 *   { id, queuedAt, roomCode, roomRecord, gameRecord, aiUid, aiName, difficulty }
 *
 * Each call to flushAll is sequential — entries are processed in queue order
 * so Elo updates compose correctly across multiple stacked offline games.
 */
(function () {
	const STORAGE_KEY = 'sigil_offline_games_v1';

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
		} catch (e) {
			console.error('[OfflineQueue] write failed:', e);
		}
	}

	function _genId() {
		return 'ofq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
	}

	// Flushes are chained, not deduped. Multiple triggers (auth change,
	// online event, post-game) can fire near-simultaneously; serializing
	// them keeps Elo updates ordered and avoids double-uploading the same
	// item, while still letting each call observe its own outcome — items
	// enqueued between the start and end of an earlier flush ride along on
	// the next link in the chain.
	let _flushChain = Promise.resolve({ uploaded: 0, failed: 0, results: [] });

	const OfflineGameQueue = {
		enqueue(item) {
			const items = _read();
			const entry = Object.assign({}, item);
			entry.id = entry.id || _genId();
			entry.queuedAt = entry.queuedAt || Date.now();
			items.push(entry);
			_write(items);
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
		 * Try to upload everything in the queue.
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

	async function _doFlush(db, processEloFn) {
		const items = _read();
		if (items.length === 0) {
			return { uploaded: 0, failed: 0, results: [] };
		}
		if (typeof navigator !== 'undefined' && navigator.onLine === false) {
			return {
				uploaded: 0,
				failed: items.length,
				results: items.map((it) => ({ id: it.id, ok: false, error: 'offline' })),
			};
		}
		const results = [];
		let uploaded = 0;
		let failed = 0;
		for (const item of items) {
			try {
				const eloResult = await _uploadOne(db, processEloFn, item);
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

	async function _uploadOne(db, processEloFn, item) {
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
		const ref = await db.ref('completed_games').push(item.gameRecord);
		if (item.gameRecord && item.gameRecord.ranked && typeof processEloFn === 'function') {
			return await processEloFn(db, ref.key, item.gameRecord);
		}
		return null;
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

	/**
	 * Wire up automatic flushing on this page. Safe to call multiple times;
	 * only the first call installs the listeners.
	 *
	 * @param {object} opts
	 * @param {function} [opts.onFlush] - notified with the flush result
	 *   ({ uploaded, failed }) when at least one item was processed.
	 */
	let _autoflushInstalled = false;
	OfflineGameQueue.installAutoflush = function installAutoflush(opts) {
		if (_autoflushInstalled) return;
		_autoflushInstalled = true;
		const onFlush = (opts && opts.onFlush) || null;

		async function _attempt() {
			if (typeof firebase === 'undefined' || !firebase.apps || firebase.apps.length === 0) return;
			if (typeof processEloClientSide !== 'function') return;
			if (OfflineGameQueue.count() === 0) return;
			const user = firebase.auth().currentUser;
			if (!user || user.isAnonymous) return;
			try {
				const db = firebase.database();
				const result = await OfflineGameQueue.flushAll(db, processEloClientSide);
				if (onFlush && (result.uploaded > 0 || result.failed > 0)) {
					try { onFlush(result); } catch (e) { /* swallow */ }
				}
			} catch (e) {
				console.warn('[OfflineQueue] autoflush failed:', e);
			}
		}

		if (typeof window !== 'undefined') {
			window.addEventListener('online', _attempt);
		}
		if (typeof firebase !== 'undefined' && firebase.auth) {
			firebase.auth().onAuthStateChanged(() => { _attempt(); });
		}
		// First attempt on next tick so callers can register an onFlush
		// callback before any results fire.
		setTimeout(_attempt, 0);
	};

	if (typeof window !== 'undefined') {
		window.OfflineGameQueue = OfflineGameQueue;
	}
})();
