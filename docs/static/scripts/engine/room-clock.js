/**
 * room-clock.js — whose move it is in an online room, and how long they have,
 * from the turns' server timestamps (database.rules.json makes each turn's
 * `timestamp` its write time).
 *
 * One copy of the rule for the site and the server: the active-games list and
 * the "Your move" badge (turn-notify.js) load it as a classic script, and the
 * Cloud Functions require() it (functions/rating.js flags, expireClocks,
 * notifyTurn), so a game the list shows as yours is the game the server
 * would flag you on.
 *
 * Two kinds of record change a clock, both counted only as of `now` (the
 * server judges a flag as of closedAt, so nothing recorded later counts):
 *   - pauses/{push}: {color, from, to}, a player's vacation (correspondence
 *     only). Written by the setVacation function alone, never by a client.
 *   - gifts/{push}: {to, ms, at}, time one player gave the other (realtime
 *     only). The rules let a seat give only to the other seat.
 */

// The one gift size a client may write, and how many gifts each seat may
// give in a game (database.rules.json, giftAt/{seat}/n). `var`: a page may
// load this file twice (auth-status.js adds it when it is missing).
var ROOM_GIFT_MS = 15000;
var ROOM_GIFT_MAX = 20;

/**
 * Milliseconds of `color`'s pauses inside [from, to] (overlapping pauses
 * count once). Pauses are server times; a malformed one counts nothing.
 */
function roomPausedMs(room, color, from, to) {
	const pauses = (room && room.pauses) || {};
	const spans = [];
	for (const k of Object.keys(pauses)) {
		const p = pauses[k];
		if (!p || p.color !== color || typeof p.from !== 'number' || typeof p.to !== 'number') continue;
		const a = Math.max(p.from, from), b = Math.min(p.to, to);
		if (b > a) spans.push([a, b]);
	}
	spans.sort((x, y) => x[0] - y[0]);
	let total = 0, end = -Infinity;
	for (const [a, b] of spans) {
		if (b <= end) continue;
		total += b - Math.max(a, end);
		end = b;
	}
	return total;
}

/** The end of `color`'s pause running at `now`, or null when none is. */
function roomPausedUntil(room, color, now) {
	const tc = (room && room.timeControl) || {};
	if (tc.type !== 'correspondence') return null;
	const pauses = (room && room.pauses) || {};
	let until = null;
	for (const k of Object.keys(pauses)) {
		const p = pauses[k];
		if (!p || p.color !== color || typeof p.from !== 'number' || typeof p.to !== 'number') continue;
		if (p.from <= now && now < p.to && (until === null || p.to > until)) until = p.to;
	}
	return until;
}

/** Milliseconds given to `color` by `now` (realtime rooms): at most ROOM_GIFT_MAX gifts. */
function roomGiftMs(room, color, now) {
	const gifts = (room && room.gifts) || {};
	let count = 0;
	for (const k of Object.keys(gifts)) {
		const g = gifts[k];
		if (!g || g.to !== color || g.ms !== ROOM_GIFT_MS || typeof g.at !== 'number' || g.at > now) continue;
		count++;
	}
	return Math.min(count, ROOM_GIFT_MAX) * ROOM_GIFT_MS;
}

/** A room's turns in the order they were played: [{color, actions, timestamp}]. */
function roomTurns(room) {
	const turns = (room && room.turns) || {};
	// By the server timestamp; push ids carry each client's own clock, so
	// between two clients they can tie. Same order as an RTDB
	// orderByChild('timestamp') query, so its last entry is the last turn.
	return Object.keys(turns)
		.sort((a, b) => ((turns[a].timestamp || 0) - (turns[b].timestamp || 0)) || (a < b ? -1 : a > b ? 1 : 0))
		.map((k) => turns[k]);
}

/**
 * The side to move: after the last turn, or the first mover. Needs only the
 * last turn and `startSfn`, so a room with just its last turn loaded answers
 * the same. A room's startSfn is the position before the first turn: the
 * game loop advances its counter and gives the move by parity (odd = red).
 */
function sideToMove(room) {
	const turns = roomTurns(room);
	if (turns.length) return turns[turns.length - 1].color === 'red' ? 'blue' : 'red';
	const c = room && room.startSfn ? parseInt(String(room.startSfn).split(' ')[2], 10) || 0 : 0;
	return (c + 1) % 2 === 1 ? 'red' : 'blue';
}

/**
 * Milliseconds left on `color`'s clock at `now` (may be negative), or null
 * when no clock counts for it: an untimed room, a room not yet started, or,
 * under correspondence, when it is not `color`'s move. A realtime clock
 * that is not running gives its banked time.
 *
 * Before the first move, the first mover's clock runs from the start of the
 * game (startedAt, server time, written with the join).
 * Correspondence: the deadline is the last turn's timestamp (or startedAt)
 * + moveTimeout, + the time `color` has been paused since.
 * Realtime: initialTime, plus the increment and minus the time used on each
 * of `color`'s turns (the first from startedAt), plus the time given to
 * `color`.
 */
function roomTimeLeft(room, color, now) {
	const tc = (room && room.timeControl) || {};
	const turns = roomTurns(room);
	if (!turns.length) {
		if (typeof room.startedAt !== 'number') return null;
		const running = sideToMove(room) === color;
		if (tc.type === 'correspondence') {
			if (!running || typeof tc.moveTimeout !== 'number') return null;
			return room.startedAt + tc.moveTimeout + roomPausedMs(room, color, room.startedAt, now) - now;
		}
		if (tc.type !== 'realtime' || typeof tc.initialTime !== 'number') return null;
		const gift = roomGiftMs(room, color, now);
		return (running ? tc.initialTime - (now - room.startedAt) : tc.initialTime) + gift;
	}
	const last = turns[turns.length - 1];
	if (typeof last.timestamp !== 'number') return null;
	const running = last.color !== color;
	if (tc.type === 'correspondence') {
		if (!running || typeof tc.moveTimeout !== 'number') return null;
		return last.timestamp + tc.moveTimeout + roomPausedMs(room, color, last.timestamp, now) - now;
	}
	if (tc.type !== 'realtime' || typeof tc.initialTime !== 'number') return null;
	const inc = tc.increment || 0;
	let remaining = tc.initialTime;
	let prevTs = null;
	for (const t of turns) {
		if (typeof t.timestamp !== 'number') return null;
		if (t.color === color && prevTs !== null) remaining += inc - (t.timestamp - prevTs);
		prevTs = t.timestamp;
	}
	remaining += roomGiftMs(room, color, now);
	return running ? remaining - (now - last.timestamp) : remaining;
}

/**
 * The clocks a game page shows, from the players' `timer` node
 * ({red, blue, activeColor, lastUpdated}: realtime banked ms, or
 * correspondence deadlines) plus the room's pauses and gifts, which that
 * node leaves out. `out` names the side whose clock has run out (the page
 * claims the flag), `paused` each side's vacation end (or null).
 */
function roomTimerView(ts, room, now) {
	const tc = (room && room.timeControl) || {};
	const active = ts.activeColor;
	const view = { red: ts.red, blue: ts.blue, out: null,
		paused: { red: roomPausedUntil(room, 'red', now), blue: roomPausedUntil(room, 'blue', now) } };
	if (tc.type === 'realtime') {
		for (const c of ['red', 'blue']) {
			view[c] = (c === active ? ts[c] - (now - ts.lastUpdated) : ts[c]) + roomGiftMs(room, c, now);
		}
		if (view[active] <= 0) view.out = active;
	} else if (tc.type === 'correspondence' && ts[active] > 0) {
		// The deadline moves on by the time paused since the last move; it
		// shows as if the running vacation is taken in full.
		const until = view.paused[active];
		view[active] = ts[active] + roomPausedMs(room, active, ts.lastUpdated, until ? Math.max(now, until) : now);
		if (now > ts[active] + roomPausedMs(room, active, ts.lastUpdated, now)) view.out = active;
	}
	return view;
}

if (typeof module !== 'undefined' && module.exports) {
	module.exports = { roomTurns, sideToMove, roomTimeLeft, roomPausedMs, roomPausedUntil, roomGiftMs, roomTimerView, ROOM_GIFT_MS, ROOM_GIFT_MAX };
}
