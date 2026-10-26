'use strict';
/**
 * Correspondence vacation (index.js setVacation, and expireClocks for games
 * that start during one).
 *
 * A player's bank is VACATION_DAYS_PER_YEAR days a calendar year (UTC),
 * kept at vacations/{uid}: { year, usedDays, from, until, days, rooms }.
 * Only the server writes it (database.rules.json). Starting a vacation of N
 * days reserves N days; ending it early refunds the days not begun (a day
 * begun counts as used).
 *
 * While a player is on vacation, each of their correspondence games carries
 * a pause, rooms/{code}/pauses/{push}: { color, from, to }, which the shared
 * clock (room-clock.js) adds to that player's deadline. Pauses are written
 * here with admin rights and never backdated: `from` is the time of the
 * write, so a flag already due stays due, and the rating function, which
 * judges a flag as of closedAt, never sees a pause the clients could not.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const VACATION_DAYS_PER_YEAR = 14;

const yearOf = (ms) => new Date(ms).getUTCFullYear();

/** Days left in the bank at `now` for the stored record `v` (may be null). */
function daysLeft(v, now) {
	if (!v || v.year !== yearOf(now)) return VACATION_DAYS_PER_YEAR;
	return Math.max(0, VACATION_DAYS_PER_YEAR - (v.usedDays || 0));
}

/** Is the record `v` a vacation running at `now`? */
function onVacation(v, now) {
	return !!(v && typeof v.until === 'number' && typeof v.from === 'number' && v.from <= now && now < v.until);
}

/**
 * The record after starting a `days`-day vacation at `now`, or
 * { error } when the request is refused.
 */
function startRecord(v, days, now) {
	if (!Number.isInteger(days) || days < 1) return { error: 'invalid-days' };
	if (onVacation(v, now)) return { error: 'already-on-vacation' };
	const left = daysLeft(v, now);
	if (days > left) return { error: 'not-enough-days' };
	const year = yearOf(now);
	const used = v && v.year === year ? (v.usedDays || 0) : 0;
	return { year, usedDays: used + days, from: now, until: now + days * DAY_MS, days, rooms: null };
}

/**
 * The record after ending the running vacation at `now`: the reserved days
 * not begun go back to the bank (of the year the vacation started in).
 */
function endRecord(v, now) {
	if (!onVacation(v, now)) return { error: 'not-on-vacation' };
	const used = Math.min(v.days || 0, Math.max(1, Math.ceil((now - v.from) / DAY_MS)));
	const refund = Math.max(0, (v.days || 0) - used);
	return Object.assign({}, v, { usedDays: Math.max(0, (v.usedDays || 0) - refund), until: now, days: used, rooms: null });
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
 * A colour that already has a pause running needs none.
 */
function missingPauses(room, active, now) {
	if (!pausable(room)) return [];
	const out = [];
	for (const c of ['red', 'blue']) {
		const uid = room[c] && room[c].uid;
		const v = uid && active[uid];
		if (!onVacation(v, now)) continue;
		const pauses = room.pauses || {};
		const running = Object.keys(pauses).some((k) => {
			const p = pauses[k];
			return p && p.color === c && typeof p.from === 'number' && typeof p.to === 'number' && p.from <= now && now < p.to;
		});
		if (!running) out.push({ uid, color: c, to: v.until });
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

/** The updates that pause `color` in room `code` until `to`, recorded for `uid`. */
function pauseUpdates(db, uid, code, color, now, to) {
	const key = db.ref('rooms/' + code + '/pauses').push().key;
	return {
		['rooms/' + code + '/pauses/' + key]: { color, from: now, to },
		['vacations/' + uid + '/rooms/' + code + '/' + color]: key,
	};
}

/**
 * Start (days) or end (days === 0) `uid`'s vacation at `now`. Resolves to
 * { ok, until, daysLeft, rooms } or throws an Error whose `code` says why.
 */
async function setVacation(db, uid, days, now) {
	const ref = db.ref('vacations/' + uid);
	let refused = null;
	let before = null;
	const res = await ref.transaction((v) => {
		before = v;
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
	const updates = {};
	let count = 0;
	if (days === 0) {
		// Every pause this vacation wrote ends now (a room since finished is
		// left alone: its result is judged as of its closedAt).
		const rooms = (before && before.rooms) || {};
		for (const code of Object.keys(rooms)) {
			const room = (await db.ref('rooms/' + code).once('value')).val();
			if (!pausable(room)) continue;
			for (const color of Object.keys(rooms[code] || {})) {
				const key = rooms[code][color];
				const p = room.pauses && room.pauses[key];
				if (p && p.to > now) { updates['rooms/' + code + '/pauses/' + key + '/to'] = now; count++; }
			}
		}
	} else {
		// Every correspondence game the player is in, however many.
		const rooms = await playingRooms(db);
		for (const code of Object.keys(rooms)) {
			for (const color of seatsOf(rooms[code], uid)) {
				Object.assign(updates, pauseUpdates(db, uid, code, color, now, rec.until));
				count++;
			}
		}
	}
	if (count) await db.ref().update(updates);
	return { ok: true, until: rec.until, daysLeft: daysLeft(rec, now), rooms: count };
}

/**
 * Pause the games that started (or were joined) while a player was already
 * on vacation; run by expireClocks every minute. Resolves to the number of
 * pauses written.
 */
async function pauseNewGames(db, now) {
	const snap = await db.ref('vacations').orderByChild('until').startAt(now + 1).once('value');
	const active = {};
	snap.forEach((child) => { if (onVacation(child.val(), now)) active[child.key] = child.val(); });
	if (!Object.keys(active).length) return 0;
	const rooms = await playingRooms(db);
	const updates = {};
	let count = 0;
	for (const code of Object.keys(rooms)) {
		for (const m of missingPauses(rooms[code], active, now)) {
			Object.assign(updates, pauseUpdates(db, m.uid, code, m.color, now, m.to));
			count++;
		}
	}
	if (count) await db.ref().update(updates);
	return count;
}

module.exports = {
	DAY_MS, VACATION_DAYS_PER_YEAR, daysLeft, onVacation, startRecord, endRecord, missingPauses,
	setVacation, pauseNewGames,
};
