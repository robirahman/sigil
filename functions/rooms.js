'use strict';
/**
 * Rooms the server finishes itself (index.js expireClocks, settleAbort).
 * Kept apart from index.js so the emulator tests can call them directly.
 */

const { flagged, sideToMove, CLOCK_GRACE_MS } = require('./rating');

/**
 * End a room the server decided (a flag nobody's tab saw, an abort after
 * both players moved): the result, the status and closedAt in one
 * transaction on the room, so it is never half finished. recordRoom
 * records it from there.
 */
async function finishRoom(db, code, from, result) {
	const ref = db.ref('rooms/' + code);
	const now = Date.now();
	// A transaction first runs on the local cache, empty here (null): answer
	// it unchanged, and the server reruns it on the real room.
	const res = await ref.transaction((room) => {
		if (room === null) return null;
		if (room.status !== from) return undefined;
		return Object.assign(room, result, { status: 'finished', closedAt: now, finishedAt: now });
	});
	return !!(res.committed && res.snapshot.val() && res.snapshot.val().closedAt === now);
}

/**
 * End every playing room whose clock has run out by `now`; resolves to how
 * many this call ended. Without the clients' slack: only a clock that is
 * truly out.
 */
async function expireRooms(db, now) {
	const snap = await db.ref('rooms').orderByChild('status').equalTo('playing').once('value');
	const jobs = [];
	snap.forEach((child) => {
		const room = child.val();
		const tc = room && room.timeControl;
		if (!tc || (tc.type !== 'realtime' && tc.type !== 'correspondence')) return;
		const loser = sideToMove(room);
		if (!flagged(room, loser, now - CLOCK_GRACE_MS)) return;
		jobs.push(finishRoom(db, child.key, 'playing', { winner: loser === 'red' ? 'blue' : 'red', endReason: 'time' }));
	});
	return (await Promise.all(jobs)).filter(Boolean).length;
}

module.exports = { finishRoom, expireRooms };
