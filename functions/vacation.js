'use strict';
/**
 * Correspondence vacation (index.js setVacation, and expireClocks for games
 * that start during one).
 *
 * A player's bank is VACATION_DAYS_PER_YEAR days a calendar year (UTC),
 * kept at vacations/{uid}: { used: {year: days}, from, until, days, prev }.
 * Only the server writes it (database.rules.json). Starting a vacation of N
 * days reserves N days, each from the bank of the year it begins in (a
 * vacation over New Year draws on both); ending it early refunds the days
 * not begun (a day begun counts as used).
 *
 * While a player is on vacation, each of their correspondence games carries
 * a pause, rooms/{code}/pauses/{uid_vacationFrom_color}: { color, from, to },
 * which the shared clock (room-clock.js) adds to that player's deadline.
 * Pauses are written here with admin rights, in a transaction on the room
 * that requires it still in play, and never backdated: `from` (and an early
 * `to`) is the time of the write, so a flag already due stays due, and the
 * rating function, which judges a flag as of closedAt, never sees a pause
 * the clients could not.
 */

// The bank's arithmetic is shared with account.html's days picker
// (docs/static/scripts/engine/vacation-bank.js).
const bank = require('./engine-loader').requireShared('vacation-bank.js');
const DAY_MS = bank.VACATION_DAY_MS;
const VACATION_DAYS_PER_YEAR = bank.VACATION_DAYS_PER_YEAR;
const daysLeft = bank.vacationDaysLeft;
const dayYears = bank.vacationDayYears;
const usedByYear = bank.vacationUsedByYear;

/** Is the record `v` a vacation that has not ended by `now` (begun or not)? */
function unexpired(v, now) {
	return !!(v && typeof v.until === 'number' && now < v.until);
}

/** Is the record `v` a vacation running at `now`? */
function onVacation(v, now) {
	return !!(v && typeof v.until === 'number' && typeof v.from === 'number' && v.from <= now && now < v.until);
}

/**
 * The record after starting a `days`-day vacation at `now`, or
 * { error } when the request is refused. Each day is charged to the bank
 * of the year it begins in, so a vacation over New Year draws on both.
 */
function startRecord(v, days, now) {
	if (!Number.isInteger(days) || days < 1) return { error: 'invalid-days' };
	// Any vacation not yet over, even one whose start is a moment after
	// `now` (an overlapping call, or another instance's clock).
	if (unexpired(v, now)) return { error: 'already-on-vacation' };
	const charged = bank.vacationCharge(v, days, now);
	if (!charged) return { error: 'not-enough-days' };
	const used = charged.used;
	// The last vacation's span stays, so the sweep can still end its pauses.
	const prev = v && typeof v.from === 'number' ? { from: v.from, until: v.until } : null;
	return { used, from: now, until: now + days * DAY_MS, days, prev };
}

/**
 * The record after ending the running vacation at `now`: the reserved days
 * not begun go back to the banks of the years they fall in.
 */
function endRecord(v, now) {
	if (!unexpired(v, now)) return { error: 'not-on-vacation' };
	const days = v.days || 0;
	const kept = Math.min(days, Math.max(1, Math.ceil((now - v.from) / DAY_MS)));
	const used = usedByYear(v);
	for (const y of dayYears(v.from, days).slice(kept)) used[y] = Math.max(0, (used[y] || 0) - 1);
	const next = Object.assign({}, v, { used, until: now, days: kept });
	delete next.year;
	delete next.usedDays;
	return next;
}

/** The colours `uid` sits at in `room` (both, in a game against oneself). */
function seatsOf(room, uid) {
	return ['red', 'blue'].filter((c) => room && room[c] && room[c].uid === uid);
}

/** A correspondence game in play: the only kind a vacation pauses. */
function pausable(room) {
	return !!(room && room.status === 'playing' && room.timeControl && room.timeControl.type === 'correspondence');
}

/**
 * The pauses a room still needs at `now`, for the players in `active`
 * ({uid: vacation record}) who are on vacation: [{ uid, color, to }].
 * A seat that already holds this vacation's pause (by key) needs none.
 */
function missingPauses(room, active, now) {
	if (!pausable(room)) return [];
	const out = [];
	for (const c of ['red', 'blue']) {
		const uid = room[c] && room[c].uid;
		const v = uid && active[uid];
		if (!onVacation(v, now)) continue;
		// This vacation's own pause (another, such as a stale one from an
		// earlier vacation, does not count).
		if (!(room.pauses && room.pauses[pauseKey(uid, v.from, c)])) out.push({ uid, color: c, to: v.until });
	}
	return out;
}

/** The playing correspondence rooms, as { code: room }. */
async function playingRooms(db) {
	const snap = await db.ref('rooms').orderByChild('status').equalTo('playing').once('value');
	const rooms = {};
	snap.forEach((child) => { if (pausable(child.val())) rooms[child.key] = child.val(); });
	return rooms;
}

/**
 * The key of the pause one vacation puts on one seat: the same for every
 * writer (setVacation, any number of overlapping sweeps), so a seat gets
 * one pause per vacation and ending it finds them all.
 */
function pauseKey(uid, vacationFrom, color) {
	return uid + '_' + vacationFrom + '_' + color;
}

/**
 * When a pause should have ended, if earlier than its `to`: the end of the
 * vacation it belongs to (by its key, among `recs` {uid: record}: the
 * current one or the one before), or `now` for an older vacation the record
 * no longer holds. Null when the pause is right as it is, belongs to a
 * vacation newer than the record, or the player is not in `recs` (a
 * deleted account's games are resigned by deleteUserData).
 */
function pauseDueEnd(key, p, recs, now) {
	const m = /^(.+)_(\d+)_(red|blue)$/.exec(key);
	if (!m || !p || typeof p.from !== 'number' || typeof p.to !== 'number') return null;
	const rec = recs[m[1]];
	if (!rec) return null;
	const from = Number(m[2]);
	// A vacation newer than this record (started elsewhere since it was
	// read) is not this record's to end.
	if (!(typeof rec.from === 'number' && from <= rec.from)) return null;
	const vac = rec.from === from ? rec : rec.prev && rec.prev.from === from ? rec.prev : null;
	const end = vac && typeof vac.until === 'number' ? vac.until : now;
	return end < p.to ? Math.max(p.from, end) : null;
}

/**
 * Change room `code` by `fn(room)` (which returns false to leave it), in a
 * transaction on the room: a pause is added or ended only while the room is
 * still in play, so a result judged as of closedAt is never changed after
 * the fact. Resolves to whether it changed.
 */
async function changeOpenRoom(db, code, fn) {
	const res = await db.ref('rooms/' + code).transaction((room) => {
		// A transaction first runs on the local cache, empty here (null):
		// answer it unchanged, and the server reruns it on the real room.
		if (room === null) return null;
		if (!pausable(room)) return undefined;
		return fn(room) === false ? undefined : room;
	});
	return !!(res.committed && res.snapshot.exists());
}

/**
 * Pause `color` in room `code` for `uid`'s vacation `v`, from the time of
 * the write. Nothing when the seat already has this vacation's pause.
 */
function addPause(db, code, uid, color, v) {
	const key = pauseKey(uid, v.from, color);
	return changeOpenRoom(db, code, (room) => {
		if (!room[color] || room[color].uid !== uid) return false;
		const now = Date.now();
		if (room.pauses && room.pauses[key]) return false;
		if (!(now < v.until)) return false;
		room.pauses = Object.assign({}, room.pauses, { [key]: { color, from: now, to: v.until } });
		return true;
	});
}

/**
 * End the pauses in room `code` whose vacation has ended (or is no longer
 * on record): each at its vacation's end, in a transaction on the open room.
 */
function endPauses(db, code, recs) {
	return changeOpenRoom(db, code, (room) => {
		const now = Date.now();
		let changed = false;
		for (const k of Object.keys(room.pauses || {})) {
			const end = pauseDueEnd(k, room.pauses[k], recs, now);
			if (end !== null) { room.pauses[k].to = end; changed = true; }
		}
		return changed;
	});
}

/** Does room `room` hold a pause that should already have ended? */
function hasStalePause(room, recs, now) {
	return Object.keys((room && room.pauses) || {}).some((k) => pauseDueEnd(k, room.pauses[k], recs, now) !== null);
}

/**
 * Start (days) or end (days === 0) `uid`'s vacation at `now`. Resolves to
 * { ok, until, daysLeft, rooms } or throws an Error whose `code` says why.
 */
async function setVacation(db, uid, days, now) {
	const ref = db.ref('vacations/' + uid);
	let refused = null;
	const res = await ref.transaction((v) => {
		// A transaction first runs on the local cache, empty here (null):
		// answer an end unchanged, and the server reruns it on the record.
		if (v === null && days === 0) { refused = 'not-on-vacation'; return null; }
		const next = days === 0 ? endRecord(v, now) : startRecord(v, days, now);
		if (next.error) { refused = next.error; return undefined; }
		refused = null;
		return next;
	});
	if (refused || !res.committed) {
		const e = new Error(refused || 'conflict');
		e.code = refused || 'conflict';
		throw e;
	}
	const rec = res.snapshot.val();
	if (!rec) { const e = new Error('not-on-vacation'); e.code = 'not-on-vacation'; throw e; }
	// Every correspondence game the player is in, however many. A room that
	// finished meanwhile is left alone (changeOpenRoom).
	const rooms = await playingRooms(db);
	let count = 0;
	for (const code of Object.keys(rooms)) {
		const seats = seatsOf(rooms[code], uid);
		if (!seats.length) continue;
		if (days === 0) {
			// Each at the vacation's end. If this fails or races a sweep
			// holding the old record, the next sweep (pauseNewGames) ends
			// what is left, from the record.
			if (await endPauses(db, code, { [uid]: rec })) count++;
		} else {
			for (const color of seats) if (await addPause(db, code, uid, color, rec)) count++;
		}
	}
	return { ok: true, until: rec.until, daysLeft: daysLeft(rec, now), rooms: count };
}

/**
 * Bring every playing correspondence game in line with the vacation
 * records; run by expireClocks every minute. Pauses the games that started
 * (or were joined) while a player was already on vacation, and ends the
 * pauses of vacations that have ended (cleanup that setVacation missed, or
 * a pause a sweep added just after the end). Resolves to the number of
 * rooms changed.
 */
async function pauseNewGames(db, now) {
	// Only records still running or ended within the last day (cleanup of
	// a missed end is done by the next sweep, a minute later): never the
	// whole history.
	const recs = (await db.ref('vacations').orderByChild('until').startAt(now - DAY_MS).once('value')).val() || {};
	const active = {};
	for (const uid of Object.keys(recs)) if (onVacation(recs[uid], now)) active[uid] = recs[uid];
	const rooms = await playingRooms(db);
	let count = 0;
	for (const code of Object.keys(rooms)) {
		if (hasStalePause(rooms[code], recs, now) && await endPauses(db, code, recs)) count++;
		for (const m of missingPauses(rooms[code], active, now)) {
			if (await addPause(db, code, m.uid, m.color, active[m.uid])) count++;
		}
	}
	return count;
}

module.exports = {
	DAY_MS, VACATION_DAYS_PER_YEAR, daysLeft, onVacation, startRecord, endRecord, missingPauses,
	pauseKey, pauseDueEnd, setVacation, pauseNewGames,
};
