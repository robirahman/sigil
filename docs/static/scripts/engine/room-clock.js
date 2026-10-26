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
 */

/**
 * A room's turn keys in the order played. A sequenced room (rooms/{id}/seq)
 * chains its turns: each names the one before it (`after`, which the rules
 * hold to the room's last turn), so the chain from the one turn without a
 * predecessor here gives the order, ties in time included. Otherwise, or
 * if the turns given do not form one chain, by server timestamp, push key
 * breaking a tie (the order of an RTDB orderByChild('timestamp') query).
 * @param {object} turns - key -> { after, timestamp }
 * @param {boolean} seq - the room's `seq`
 */
function orderTurnKeys(turns, seq) {
	const keys = Object.keys(turns || {});
	const byTime = keys.slice().sort((a, b) => ((turns[a].timestamp || 0) - (turns[b].timestamp || 0)) || (a < b ? -1 : a > b ? 1 : 0));
	if (seq !== true || keys.length < 2) return byTime;
	const next = {};
	const roots = [];
	for (const k of keys) {
		const a = turns[k] && turns[k].after;
		if (typeof a === 'string' && Object.prototype.hasOwnProperty.call(turns, a)) {
			if (next[a] !== undefined) return byTime;
			next[a] = k;
		} else {
			roots.push(k);
		}
	}
	if (roots.length !== 1) return byTime;
	const out = [];
	for (let k = roots[0]; k !== undefined && out.length <= keys.length; k = next[k]) out.push(k);
	return out.length === keys.length ? out : byTime;
}

/** A room's turns in the order they were played: [{color, actions, timestamp}] (orderTurnKeys). */
function roomTurns(room) {
	const turns = (room && room.turns) || {};
	return orderTurnKeys(turns, room && room.seq).map((k) => turns[k]);
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
 * + moveTimeout.
 * Realtime: initialTime, plus the increment and minus the time used on each
 * of `color`'s turns (the first from startedAt).
 */
function roomTimeLeft(room, color, now) {
	const tc = (room && room.timeControl) || {};
	const turns = roomTurns(room);
	if (!turns.length) {
		if (typeof room.startedAt !== 'number') return null;
		const running = sideToMove(room) === color;
		if (tc.type === 'correspondence') {
			if (!running || typeof tc.moveTimeout !== 'number') return null;
			return room.startedAt + tc.moveTimeout - now;
		}
		if (tc.type !== 'realtime' || typeof tc.initialTime !== 'number') return null;
		return running ? tc.initialTime - (now - room.startedAt) : tc.initialTime;
	}
	const last = turns[turns.length - 1];
	if (typeof last.timestamp !== 'number') return null;
	const running = last.color !== color;
	if (tc.type === 'correspondence') {
		if (!running || typeof tc.moveTimeout !== 'number') return null;
		return last.timestamp + tc.moveTimeout - now;
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
	return running ? remaining - (now - last.timestamp) : remaining;
}

if (typeof module !== 'undefined' && module.exports) {
	module.exports = { orderTurnKeys, roomTurns, sideToMove, roomTimeLeft };
}
