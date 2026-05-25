/**
 * Persist in-progress local games (single-player vs AI and local 1v1)
 * to localStorage so a tab reload returns to the same position.
 *
 * The id is an 8-hex random token minted on first visit and pinned to
 * the URL via history.replaceState. Schema is versioned via `v`; older
 * blobs are ignored. Saves expire after 30 days.
 */
(function () {
	'use strict';

	const KEY_PREFIX = 'sigil_local_save_';
	const SCHEMA_VERSION = 1;
	const TTL_MS = 30 * 24 * 60 * 60 * 1000;

	function _key(id) { return KEY_PREFIX + id; }

	function _storageAvailable() {
		try {
			const t = '__sigil_save_test__';
			localStorage.setItem(t, '1');
			localStorage.removeItem(t);
			return true;
		} catch (e) {
			return false;
		}
	}

	function mintId() {
		if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
			const buf = new Uint8Array(4);
			crypto.getRandomValues(buf);
			return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
		}
		return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
	}

	function get(id) {
		if (!id || !_storageAvailable()) return null;
		try {
			const raw = localStorage.getItem(_key(id));
			if (!raw) return null;
			const data = JSON.parse(raw);
			if (!data || data.v !== SCHEMA_VERSION) return null;
			if (data.finished) return null;
			if (typeof data.savedAt === 'number' && Date.now() - data.savedAt > TTL_MS) {
				localStorage.removeItem(_key(id));
				return null;
			}
			return data;
		} catch (e) {
			return null;
		}
	}

	function put(id, data) {
		if (!id || !_storageAvailable()) return;
		try {
			const payload = Object.assign(
				{ v: SCHEMA_VERSION, savedAt: Date.now(), finished: false },
				data || {},
			);
			localStorage.setItem(_key(id), JSON.stringify(payload));
		} catch (e) {
			// Quota or other storage failure; the user just loses persistence
			// for this session.
		}
	}

	function remove(id) {
		if (!id || !_storageAvailable()) return;
		try {
			localStorage.removeItem(_key(id));
		} catch (e) { /* ignore */ }
	}

	/**
	 * Best-effort cleanup of expired saves. Called once on page load.
	 */
	function purgeExpired() {
		if (!_storageAvailable()) return;
		try {
			const cutoff = Date.now() - TTL_MS;
			const toRemove = [];
			for (let i = 0; i < localStorage.length; i++) {
				const key = localStorage.key(i);
				if (!key || !key.startsWith(KEY_PREFIX)) continue;
				try {
					const data = JSON.parse(localStorage.getItem(key));
					if (!data || data.v !== SCHEMA_VERSION) {
						toRemove.push(key);
						continue;
					}
					if (data.finished || (typeof data.savedAt === 'number' && data.savedAt < cutoff)) {
						toRemove.push(key);
					}
				} catch (e) {
					toRemove.push(key);
				}
			}
			for (const key of toRemove) localStorage.removeItem(key);
		} catch (e) { /* ignore */ }
	}

	window.LocalSaveStore = { mintId, get, put, remove, purgeExpired };
})();
