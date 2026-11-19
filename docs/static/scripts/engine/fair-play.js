/**
 * fair-play.js — automatic, escalating suspensions from rated play for
 * players who abandon or stall online games.
 *
 * One copy for the site and the server: account.html loads it as a classic
 * script to show a player where they stand, and functions/index.js (rateGame)
 * require()s it to record each upheld offense, so the page describes exactly
 * what the server does.
 *
 * An offense is one online game (counted once per room, in
 * user_flags/{uid}/offenses/{room}):
 *   - 'abandon': the opponent's claim that the player left was upheld
 *     (functions/rating.js abandoned: the seat gone for a minute, both having
 *     moved);
 *   - 'stall': a live game the player lost on time after sitting on their
 *     final turn without moving, from the turns' server timestamps
 *     (functions/rating.js stalled): at least FAIR_PLAY.STALL_MIN_MS left on
 *     their clock and at least FAIR_PLAY.STALL_FACTOR times their usual (median)
 *     time per turn earlier in that game. A long think in time trouble is
 *     not a stall; letting a healthy clock run out is.
 *
 * FAIR_PLAY.THRESHOLD offenses within FAIR_PLAY.WINDOW_MS suspend the player from
 * rated play, and every further one inside the window suspends them again.
 * The length rises by level, the level being one more than the automatic
 * suspensions in the last FAIR_PLAY.LEVEL_WINDOW_MS that were not overturned on
 * appeal: FAIR_PLAY.LEVELS_MS, the last repeating. A suspension never shortens one
 * already running (an admin's longer one stands).
 */

var FAIR_PLAY_DAY_MS = 24 * 60 * 60 * 1000;
var FAIR_PLAY = {
	WINDOW_MS: 30 * FAIR_PLAY_DAY_MS,
	THRESHOLD: 2,
	LEVEL_WINDOW_MS: 90 * FAIR_PLAY_DAY_MS,
	LEVELS_MS: [1 * FAIR_PLAY_DAY_MS, 3 * FAIR_PLAY_DAY_MS, 7 * FAIR_PLAY_DAY_MS, 30 * FAIR_PLAY_DAY_MS],
	STALL_MIN_MS: 2 * 60 * 1000,
	STALL_FACTOR: 5,
	// Earlier turns of the staller's in that game, for their usual pace.
	STALL_MIN_TURNS: 3,
};

/** The offenses of `flags` (user_flags/{uid}) since `now - FAIR_PLAY.WINDOW_MS`, oldest first, forgiven ones left out. */
function fairPlayRecentOffenses(flags, now) {
	const offenses = (flags && flags.offenses) || {};
	const out = [];
	for (const room of Object.keys(offenses)) {
		const o = offenses[room];
		if (!o || typeof o.at !== 'number' || o.forgiven === true) continue;
		if (o.at < now - FAIR_PLAY.WINDOW_MS || o.at > now) continue;
		out.push(Object.assign({ room }, o));
	}
	return out.sort((a, b) => a.at - b.at);
}

/** The level the next automatic suspension of `flags` would have at `now` (1 = first). */
function fairPlayNextLevel(flags, now) {
	const rs = (flags && flags.restrictions) || {};
	let n = 0;
	for (const k of Object.keys(rs)) {
		const r = rs[k];
		if (r && typeof r.at === 'number' && r.at >= now - FAIR_PLAY.LEVEL_WINDOW_MS && r.overturned !== true) n++;
	}
	return n + 1;
}

/** The length of a level-`level` suspension. */
function fairPlayLevelMs(level) {
	const ls = FAIR_PLAY.LEVELS_MS;
	return ls[Math.min(Math.max(1, level), ls.length) - 1];
}

/**
 * Where a player stands at `now`: { recent (fairPlayRecentOffenses), count,
 * left (offenses before the next one suspends: 0 means the next does),
 * nextLevel, nextMs (the suspension the offense that reaches the threshold
 * would bring) }.
 */
function fairPlayStanding(flags, now) {
	const recent = fairPlayRecentOffenses(flags, now);
	const nextLevel = fairPlayNextLevel(flags, now);
	return {
		recent,
		count: recent.length,
		left: Math.max(0, FAIR_PLAY.THRESHOLD - 1 - recent.length),
		nextLevel,
		nextMs: fairPlayLevelMs(nextLevel),
	};
}

/** "3 days", "1 day", "12 hours". */
function fairPlayDuration(ms) {
	const days = Math.round(ms / FAIR_PLAY_DAY_MS);
	if (days >= 1) return days + (days === 1 ? ' day' : ' days');
	const hours = Math.max(1, Math.round(ms / 3600000));
	return hours + (hours === 1 ? ' hour' : ' hours');
}

/**
 * Record one upheld offense on `flags` (user_flags/{uid} as read, may be
 * null) at server time `now`; pure, for rateGame's transaction.
 * `offense`: { room, kind: 'abandon' | 'stall', at (server ms the game
 * ended), evidence (optional numbers, kept for the admins and the player) }.
 * Returns { counted: false } for a room already counted, else
 * { counted: true, flags (the new value), restriction (null, or the
 * suspension it started: { key, at, until, level, kind, rooms }) }.
 */
function fairPlayApplyOffense(flags, offense, now) {
	const f = Object.assign({}, flags || {});
	const room = offense.room;
	if ((f.offenses && f.offenses[room]) || (f.abandonedGames && f.abandonedGames[room])) return { counted: false };
	const at = typeof offense.at === 'number' && offense.at <= now ? offense.at : now;
	const entry = Object.assign({}, offense.evidence || {}, { kind: offense.kind, at });
	f.offenses = Object.assign({}, f.offenses, { [room]: entry });
	if (offense.kind === 'abandon') {
		f.abandons = (typeof f.abandons === 'number' ? f.abandons : 0) + 1;
		f.abandonedGames = Object.assign({}, f.abandonedGames, { [room]: true });
	} else {
		f.stalls = (typeof f.stalls === 'number' ? f.stalls : 0) + 1;
	}
	const recent = fairPlayRecentOffenses(f, now);
	if (recent.length < FAIR_PLAY.THRESHOLD) return { counted: true, flags: f, restriction: null };
	const level = fairPlayNextLevel(f, now);
	const until = now + fairPlayLevelMs(level);
	const rooms = {};
	for (const o of recent) rooms[o.room] = o.kind;
	const restriction = { at: now, until, level, kind: offense.kind, rooms };
	f.restrictions = Object.assign({}, f.restrictions, { [room]: restriction });
	if (!(typeof f.banUntil === 'number' && f.banUntil >= until)) {
		const left = recent.filter((o) => o.kind === 'abandon').length;
		const stalled = recent.length - left;
		const what = [left ? left + ' left' : '', stalled ? stalled + ' stalled' : ''].filter(Boolean).join(', ');
		f.banUntil = until;
		f.reason = 'Automatic: ' + recent.length + ' online games abandoned or stalled in '
			+ Math.round(FAIR_PLAY.WINDOW_MS / FAIR_PLAY_DAY_MS) + ' days (' + what + '), suspension level ' + level + '.';
		f.auto = true;
		f.by = 'auto';
		f.at = now;
	}
	return { counted: true, flags: f, restriction: Object.assign({ key: room }, restriction) };
}

if (typeof module !== 'undefined' && module.exports) {
	module.exports = {
		FAIR_PLAY, FAIR_PLAY_DAY_MS, fairPlayRecentOffenses, fairPlayNextLevel, fairPlayLevelMs,
		fairPlayStanding, fairPlayDuration, fairPlayApplyOffense,
	};
}
