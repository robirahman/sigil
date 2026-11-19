/**
 * match-pools.js — matchmaking pools: which players the server pairs.
 *
 * One copy for the site and the server: the lobby (multiplayer.html) builds
 * its ticket's bucket and shows its rating window from here, and the
 * matchmake function (functions/matchmaking.js) pairs by it.
 *
 * A player waiting for a game holds one ticket, mm_tickets/{uid} = { bucket,
 * at, ping } (database.rules.json). The bucket is the exact game: time
 * control, variant (Standard or Competitive) and rated or casual, e.g.
 * 'rt-300-0~standard~r' (5+0, Standard, rated), 'cr-24~competitive~c' (24 h a
 * move, Competitive, casual), 'none~standard~r' (no clock). Only tickets in
 * one bucket are paired, by the players' Glicko-2 ratings in the bucket's
 * pool (glicko.js): each accepts opponents within a window of their rating
 * that starts at 100 points plus their deviation and widens by 5 points a
 * second while they wait, and two tickets pair when each is inside the
 * other's window. Guests (casual buckets only) count as a new rating, 1000
 * with a deviation of 350.
 */
var SigilMatch = (function () {
	'use strict';

	const C = {
		// A waiting tab re-stamps its ticket this often; each stamp makes the
		// server pair the bucket again, with the windows as wide as by then.
		PING_MS: 10000,
		// A ticket not stamped for this long is dropped (a hidden tab's timers
		// may run only once a minute).
		STALE_MS: 120000,
		// A match whose room never got both players is dropped.
		MATCH_TTL_MS: 120000,
		// How long the paired players wait for each other: the guest for the
		// host's room, the host for the guest to sit down.
		GUEST_WAIT_MS: 30000,
		HOST_WAIT_MS: 45000,
		BASE_WINDOW: 100,
		WIDEN_PER_S: 5,
		// After this long, any rating will do.
		ANY_AFTER_MS: 180000,
	};

	const BUCKET_RE = /^(none|rt-[0-9]{1,5}-[0-9]{1,3}|cr-[0-9]{1,3})~(standard|competitive)~[rc]$/;
	const HOUR_MS = 3600000;

	/**
	 * The bucket of a game the lobby form describes, or null when matchmaking
	 * does not pair it (another variant, a fractional time).
	 * @param {object} s - { timeControl, variant (normalized), rated }
	 */
	function bucketOf(s) {
		const tc = (s && s.timeControl) || { type: 'none' };
		let t;
		if (tc.type === 'realtime') {
			const init = (Number(tc.initialTime) || 0) / 1000;
			const inc = (Number(tc.increment) || 0) / 1000;
			if (!(init > 0) || init % 1 || inc % 1 || inc < 0) return null;
			t = 'rt-' + init + '-' + inc;
		} else if (tc.type === 'correspondence') {
			const h = (Number(tc.moveTimeout) || 0) / HOUR_MS;
			if (!(h > 0) || h % 1) return null;
			t = 'cr-' + h;
		} else {
			t = 'none';
		}
		const v = s && s.variant;
		if (v !== 'standard' && v !== 'competitive') return null;
		const b = t + '~' + v + '~' + (s.rated ? 'r' : 'c');
		return BUCKET_RE.test(b) ? b : null;
	}

	/** { timeControl, variant, rated } of a bucket, or null. */
	function parseBucket(b) {
		if (typeof b !== 'string' || !BUCKET_RE.test(b)) return null;
		const [t, variant, rc] = b.split('~');
		let timeControl;
		if (t === 'none') {
			timeControl = { type: 'none' };
		} else if (t.startsWith('rt-')) {
			const [, init, inc] = t.split('-').map(Number);
			timeControl = { type: 'realtime', initialTime: init * 1000, increment: inc * 1000 };
		} else {
			timeControl = { type: 'correspondence', moveTimeout: Number(t.slice(3)) * HOUR_MS };
		}
		return { timeControl, variant, rated: rc === 'r' };
	}

	/**
	 * The rating window, in points either side, of a ticket with deviation
	 * `rd` that has waited `waitedMs`; Infinity once any rating will do.
	 */
	function windowFor(rd, waitedMs) {
		const w = Math.max(0, waitedMs || 0);
		if (w >= C.ANY_AFTER_MS) return Infinity;
		return C.BASE_WINDOW + (typeof rd === 'number' ? rd : 350) + C.WIDEN_PER_S * w / 1000;
	}

	/**
	 * Pair the tickets of one bucket. Oldest first, each ticket takes the
	 * closest-rated ticket still free whose window and its own both hold the
	 * gap (the older on a tie), skipping players who block each other.
	 * @param {Array<{uid, at, r, rd, blocks?}>} tickets - `blocks`: uids
	 *   this player blocked (either direction keeps two apart)
	 * @param {number} now - server ms
	 * @returns {Array<[object, object]>} pairs, the older ticket first (the host)
	 */
	function pairTickets(tickets, now) {
		const list = tickets.slice().sort((x, y) => (x.at - y.at) || (x.uid < y.uid ? -1 : x.uid > y.uid ? 1 : 0));
		const blocks = (x, y) => Array.isArray(x.blocks) && x.blocks.indexOf(y.uid) !== -1;
		const taken = new Set();
		const pairs = [];
		for (const a of list) {
			if (taken.has(a.uid)) continue;
			const wa = windowFor(a.rd, now - a.at);
			let best = null;
			let bestGap = Infinity;
			for (const b of list) {
				if (b === a || b.uid === a.uid || taken.has(b.uid) || blocks(a, b) || blocks(b, a)) continue;
				const gap = Math.abs(a.r - b.r);
				if (gap > wa || gap > windowFor(b.rd, now - b.at)) continue;
				if (gap < bestGap) { best = b; bestGap = gap; }
			}
			if (best) {
				taken.add(a.uid);
				taken.add(best.uid);
				pairs.push([a, best]);
			}
		}
		return pairs;
	}

	return { C, BUCKET_RE, bucketOf, parseBucket, windowFor, pairTickets };
})();

if (typeof module !== 'undefined' && module.exports) {
	module.exports = SigilMatch;
}
