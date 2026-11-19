'use strict';
/**
 * Rate limits of the HTTP API (api.js): a fixed one-minute window per caller,
 * counted in the database (api_rate/{key}: { w: window start, n: calls },
 * server-only) so every instance of the function counts against the same
 * total. An instance also remembers the windows it has seen go over, and
 * refuses the rest of such a window without a database round trip.
 *
 * Callers are keyed by token id (a token's calls, wherever they come from)
 * or, without a token, by a hash of the IP address. Old windows are swept
 * by index.js expireClocks (sweepRateLimits).
 */

const crypto = require('crypto');

const WINDOW_MS = 60 * 1000;
const LIMITS = {
	// Calls a minute.
	anonymous: 60,
	token: 300,
	// Opening an event stream, per token (each stays open for minutes).
	stream: 20,
	// Challenges a bot sends.
	challenge: 10,
	// Turns a bot submits (each is a replay of its game): a turn a second
	// across all its games, with room for bursts.
	turn: 120,
};
// Windows ended this long ago are deleted.
const KEEP_MS = 10 * 60 * 1000;

const over = new Map();

/** The key of an anonymous caller: a hash of the IP, never the IP itself. */
function ipKey(ip) {
	return 'ip_' + crypto.createHash('sha256').update('sigil-api:' + String(ip || 'unknown')).digest('hex').slice(0, 32);
}

/**
 * Count one call of `key` against `limit` a minute: { ok, limit, remaining,
 * reset (ms epoch the window ends) }.
 */
async function hit(db, key, limit, now) {
	const w = now - (now % WINDOW_MS);
	const reset = w + WINDOW_MS;
	const seen = over.get(key);
	if (seen === w) return { ok: false, limit, remaining: 0, reset };
	if (over.size > 10000) over.clear();
	let count = 0;
	const res = await db.ref('api_rate/' + key).transaction((cur) => {
		const n = cur && cur.w === w ? (cur.n || 0) + 1 : 1;
		count = n;
		if (n > limit) return; // abort: over the limit
		return { w, n };
	});
	if (!res.committed) {
		over.set(key, w);
		return { ok: false, limit, remaining: 0, reset };
	}
	return { ok: true, limit, remaining: Math.max(0, limit - count), reset };
}

/** Delete windows that ended KEEP_MS ago, a batch at a time; resolves to how many. */
async function sweepRateLimits(db, now) {
	const snap = await db.ref('api_rate').orderByChild('w').endAt(now - KEEP_MS).limitToFirst(500).once('value');
	const updates = {};
	snap.forEach((c) => { updates['api_rate/' + c.key] = null; });
	const n = Object.keys(updates).length;
	if (n) await db.ref().update(updates);
	return n;
}

module.exports = { hit, ipKey, sweepRateLimits, LIMITS, WINDOW_MS, _over: over };
