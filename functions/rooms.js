'use strict';
/**
 * Rooms the server finishes itself (index.js expireClocks, settleAbort).
 * Kept apart from index.js so the emulator tests can call them directly.
 */

const { flagged, sideToMove, CLOCK_GRACE_MS } = require('./rating');

/**
 * End a room the server decided (a flag nobody's tab saw, an abort after
 * both players moved): the result, then the status, as the clients do
 * (firebase-sync.js). recordRoom records it from there.
 */
async function finishRoom(db, code, from, result) {
	const ref = db.ref('rooms/' + code);
	// A transaction first runs on the local cache, empty here (null): answer
	// it too, and the server reruns it on the real status.
	const res = await ref.child('status').transaction((cur) => (cur === from || cur === null ? 'finishing' : undefined));
	if (res.snapshot.val() !== 'finishing') return false;
	if (!res.committed) return false;
	await ref.update(Object.assign({ finishedAt: Date.now() }, result));
	// 'finishing' is never a client state: a client write in between is
	// refused (status rules), and recordRoom fires on this last write.
	await ref.child('status').set('finished');
	return true;
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
