'use strict';
/**
 * Cloud Functions for Sigil Online (Firebase Blaze plan).
 *
 *   recordRoom     - writes the completed_games record of each online room
 *                    that finishes, and its id to rooms/{code}/gameId.
 *   rateGame       - checks and rates every new completed_games record
 *                    (rating.js); the only writer of Elo, the game counters
 *                    and user_games.
 *   deleteUserData - removes a player's own records and their sign-in, for
 *                    "Delete account" on account.html.
 *   expireClocks   - every minute, ends games whose clock ran out while no
 *                    player's tab was open to see it.
 *   settleAbort    - an abort after both players have moved is a forfeit
 *                    (on the status change to 'aborted').
 *   notifyTurn     - a web push to the player whose move it now is, in
 *                    correspondence games (and realtime ones they left).
 *
 * Deploy: `firebase deploy --only functions` from the repo root (firebase.json
 * copies the engine into functions/engine/ first). Deploy together with
 * database.rules.json, which takes those writes away from the clients.
 */

const { onValueCreated, onValueWritten } = require('firebase-functions/v2/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabaseWithUrl, ServerValue } = require('firebase-admin/database');
const { AI_UID, judgeGame, ratingUpdates, recordFromRoom, freshEngine, roomTurns } = require('./rating');
const { finishRoom, expireRooms } = require('./rooms');
const { priceStart } = require('./pricing');
const { notifyTurn } = require('./notify');
const crypto = require('crypto');

initializeApp();

const DB_INSTANCE = 'sigil-js-default-rtdb';
const REGION = 'us-central1';
// By URL rather than the default, which follows the project id: the
// emulator tests run under a demo project with this instance name.
const database = () => getDatabaseWithUrl('https://' + DB_INSTANCE + '.firebaseio.com');

async function isFullAccount(uid) {
	try {
		const user = await getAuth().getUser(uid);
		// Anonymous accounts have no sign-in provider.
		return !user.disabled && user.providerData.length > 0;
	} catch (e) {
		return false;
	}
}

// How long recordRoom waits after a room finishes for the clients' review
// fields (gameLog, finalSfn), which may follow a forfeit or a flag.
const RECORD_DELAY_MS = 5000;

exports.recordRoom = onValueWritten({
	ref: '/rooms/{code}/status',
	instance: DB_INSTANCE,
	region: REGION,
	// Retried on failure: every step below is safe to repeat.
	retry: true,
}, async (event) => {
	if (event.data.after.val() !== 'finished' || event.data.before.val() === 'finished') return;
	const db = event.data.after.ref.root.database;
	const code = event.params.code;
	await new Promise((r) => setTimeout(r, RECORD_DELAY_MS));
	const roomRef = db.ref('rooms/' + code);
	const room = (await roomRef.once('value')).val();
	if (!room || room.local === true) return;
	// Claim the room first, so a retried event cannot record it twice; a
	// retry after the claim (the record not yet written) writes it.
	const newKey = db.ref('completed_games').push().key;
	const claim = await roomRef.child('gameId').transaction((cur) => (cur ? undefined : newKey));
	const gameId = claim.committed ? newKey : claim.snapshot.val();
	if (!gameId) return;
	const gameRef = db.ref('completed_games/' + gameId);
	if ((await gameRef.child('winner').once('value')).exists()) return;
	await gameRef.set(recordFromRoom(room, code, Date.now()));
});

exports.rateGame = onValueCreated({
	ref: '/completed_games/{gameId}',
	instance: DB_INSTANCE,
	region: REGION,
	// One game at a time, site-wide: each rating reads both players'
	// current Elo, so two games of one player must not interleave.
	concurrency: 1,
	maxInstances: 1,
	// The wasm engine prices start positions (pricing.js): up to ~65 s.
	memory: '1GiB',
	timeoutSeconds: 300,
	// Retried on failure: the claim below is resumable and the final write
	// (which sets eloProcessed) is one atomic update, so a retry either
	// finds the game rated or rates it once.
	retry: true,
}, async (event) => {
	const gameId = event.params.gameId;
	const record = event.data.val();
	// The database the record was written to.
	const db = event.data.ref.root.database;
	if (!record || record.eloProcessed) return;

	const room = record.roomCode
		? (await db.ref('rooms/' + record.roomCode).once('value')).val() : null;
	// Position prices are cached: a position is priced once.
	const cachedPrice = async (sfn) => {
		const ref = db.ref('position_prices/' + crypto.createHash('sha256').update(sfn).digest('hex').slice(0, 40));
		const hit = (await ref.once('value')).val();
		if (hit && hit.sfn === sfn) return hit.redWinProb;
		const p = await priceStart(sfn);
		if (typeof p === 'number') await ref.set({ sfn, redWinProb: p, at: Date.now() });
		return p;
	};
	// A suspension running now (user_flags/{uid}/banUntil, set by an admin).
	const isSuspended = async (uid) => {
		const until = (await db.ref('user_flags/' + uid + '/banUntil').once('value')).val();
		return typeof until === 'number' && until > Date.now();
	};
	const verdict = await judgeGame(record, { room, isFullAccount, isSuspended, priceStart: cachedPrice, now: Date.now() });
	if (verdict.skip) return;

	// One rating per game, however many records claim it (both clients of
	// an online game may record it, and a retried upload re-creates one).
	if (verdict.rated) {
		// A claim this record already holds (a retry) counts as its own.
		const claim = await db.ref('rating_claims/' + verdict.claimKey).transaction(
			(cur) => (cur && cur !== gameId ? undefined : gameId));
		if (!claim.committed) {
			Object.assign(verdict, { rated: false, reason: 'duplicate' });
		}
	}

	// A player who deleted their account while this game was on its way:
	// nothing is written under their uid, and the record forgets it.
	const deleted = {};
	for (const c of ['red', 'blue']) {
		const u = c === 'red' ? record.redUid : record.blueUid;
		deleted[c] = u === 'deleted' || (typeof u === 'string' && u.length > 0
			&& (await db.ref('deleted_users/' + u).once('value')).exists());
	}
	if (deleted.red || deleted.blue) Object.assign(verdict, { rated: false, reason: 'deleted-account' });
	const uids = { red: record.redUid, blue: record.blueUid };
	const [redSnap, blueSnap, redLb, blueLb] = await Promise.all([
		db.ref('users/' + uids.red).once('value'),
		db.ref('users/' + uids.blue).once('value'),
		db.ref('leaderboard/' + uids.red + '/displayName').once('value'),
		db.ref('leaderboard/' + uids.blue + '/displayName').once('value'),
	]);
	// A result the room does not support was the finisher's resignation:
	// the room shows the corrected result.
	if (verdict.overturned && record.roomCode) {
		await db.ref('rooms/' + record.roomCode).update({
			winner: verdict.winner,
			forfeitedBy: verdict.winner === 'red' ? 'blue' : 'red',
			endReason: 'forfeit',
		});
	}
	const updates = ratingUpdates(gameId, record, verdict,
		{ red: redSnap.val(), blue: blueSnap.val() },
		{ red: redLb.exists(), blue: blueLb.exists() },
		freshEngine());
	for (const c of ['red', 'blue']) {
		if (!deleted[c]) continue;
		for (const k of Object.keys(updates)) if (k.startsWith('user_games/' + uids[c] + '/')) delete updates[k];
		updates['completed_games/' + gameId + '/' + c + 'Uid'] = 'deleted';
	}
	// Deletion may have begun since the check above: look again just before
	// writing (deleteUserData marks deleted_users first).
	for (const c of ['red', 'blue']) {
		const u = uids[c];
		if (!deleted[c] && typeof u === 'string' && u && (await db.ref('deleted_users/' + u).once('value')).exists()) {
			return; // the deletion's own scrub runs after; this game stays unrated and unindexed
		}
	}
	// An upheld abandonment claim adds to the player's record, rated game or
	// not, which only admins (admin.html) and the player see; a ban stays an
	// admin's call. Counted once per room (abandonedGames/{room}), however
	// often this runs or however many records the room has.
	const quitter = verdict.abandonedBy;
	const quitterUid = quitter && uids[quitter];
	if (quitter && record.roomCode && !deleted[quitter] && typeof quitterUid === 'string' && !AI_UID.test(quitterUid)
		&& (await isFullAccount(quitterUid))) {
		await db.ref('user_flags/' + quitterUid).transaction((cur) => {
			const f = cur || {};
			if (f.abandonedGames && f.abandonedGames[record.roomCode]) return; // counted already
			return Object.assign({}, f, {
				abandons: (typeof f.abandons === 'number' ? f.abandons : 0) + 1,
				abandonedGames: Object.assign({}, f.abandonedGames, { [record.roomCode]: true }),
			});
		});
	}
	// The room may be deleted by its players only once it is rated: until
	// then it is the evidence (database.rules.json).
	if (room && room.local !== true && record.roomCode) updates['rooms/' + record.roomCode + '/ratedAt'] = Date.now();
	await db.ref().update(updates);
	logger.info('rateGame', { gameId, kind: verdict.kind, rated: verdict.rated, reason: verdict.reason || null,
		eloChange: updates['completed_games/' + gameId + '/eloChange'] });
});

// How recently the caller must have signed in to delete their account.
const RECENT_LOGIN_S = 5 * 60;

exports.deleteUserData = onCall({ region: REGION }, async (request) => {
	const auth = request.auth;
	if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
	const uid = auth.uid;
	const authTime = auth.token && auth.token.auth_time;
	if (!authTime || Date.now() / 1000 - authTime > RECENT_LOGIN_S) {
		throw new HttpsError('failed-precondition', 'requires-recent-login');
	}
	const db = database();
	const [games, active, profile] = await Promise.all([
		db.ref('user_games/' + uid).once('value'),
		db.ref('user_active_games/' + uid).once('value'),
		db.ref('users/' + uid).once('value'),
	]);
	// First, so a game rated after this point writes nothing for the uid
	// (rateGame checks deleted_users).
	await db.ref('deleted_users/' + uid).set(Date.now());
	const updates = {
		['users/' + uid]: null,
		['leaderboard/' + uid]: null,
		['user_games/' + uid]: null,
		['user_active_games/' + uid]: null,
		// Push tokens: the deleted account can no longer remove them, and
		// notifyTurn would keep pushing its games to the browser.
		['push_tokens/' + uid]: null,
		// Fair play: the suspension, abandonment count (and the rooms behind
		// it) and the report rate-limit stamp. A new account starts clean,
		// as a deleted one's uid never comes back.
		['user_flags/' + uid]: null,
		['report_limits/' + uid]: null,
	};
	// Public room records lose the name and uid too (their seats).
	const seatScrub = async (code, color) => {
		if (!code || (color !== 'red' && color !== 'blue')) return;
		const seat = (await db.ref('rooms/' + code + '/' + color + '/uid').once('value')).val();
		if (seat !== uid) return;
		updates['rooms/' + code + '/' + color + '/uid'] = 'deleted';
		updates['rooms/' + code + '/' + color + '/displayName'] = 'Deleted player';
	};
	// The player's games stay in their opponents' histories, without a name.
	games.forEach((g) => {
		const e = g.val() || {};
		if (e.opponentUid && e.opponentUid !== uid) {
			updates['user_games/' + e.opponentUid + '/' + g.key + '/opponent'] = 'Deleted player';
			updates['user_games/' + e.opponentUid + '/' + g.key + '/opponentUid'] = null;
		}
		if (e.gameId || g.key) {
			const id = e.gameId || g.key;
			// completed_games keeps the moves (training data) but not who played.
			updates['completed_games/' + id + '/' + (e.color === 'blue' ? 'blueUid' : 'redUid')] = 'deleted';
		}
	});
	const scrubs = [];
	games.forEach((g) => { const e = g.val() || {}; scrubs.push([e.roomCode, e.color]); });
	for (const [code, color] of scrubs) await seatScrub(code, color);
	const name = profile.val() && profile.val().displayName;
	// Same key rule as usernames/ in database.rules.json.
	if (typeof name === 'string' && /^[a-z0-9_-]{1,20}$/.test(name.toLowerCase())) {
		const key = name.toLowerCase();
		const claim = await db.ref('usernames/' + key).once('value');
		if (claim.val() === uid) updates['usernames/' + key] = null;
	}
	// Deleting completed_games children of records that no longer exist
	// would create stubs: only touch the ones that are there.
	for (const path of Object.keys(updates)) {
		if (!path.startsWith('completed_games/')) continue;
		const id = path.split('/')[1];
		if (!(await db.ref('completed_games/' + id + '/winner').once('value')).exists()) delete updates[path];
	}
	// Games still open: a waiting invite goes, a game in play is resigned
	// (the opponent wins; recordRoom records it, unrated without the
	// account), and the opponent's active-games entry goes with it.
	const rooms = [];
	active.forEach((a) => { rooms.push(a.key); });
	for (const code of rooms) {
		const ref = db.ref('rooms/' + code);
		const room = (await ref.once('value')).val();
		if (!room) continue;
		const me = room.red && room.red.uid === uid ? 'red' : room.blue && room.blue.uid === uid ? 'blue' : null;
		if (!me) continue;
		const opp = me === 'red' ? 'blue' : 'red';
		const oppUid = room[opp] && room[opp].uid;
		if (oppUid && oppUid !== uid) updates['user_active_games/' + oppUid + '/' + code] = null;
		// Off the lobby lists either way (open_rooms, live_rooms).
		updates['open_rooms/' + code] = null;
		updates['live_rooms/' + code] = null;
		if (room.status === 'waiting') {
			updates['rooms/' + code] = null;
		} else if (room.status === 'playing') {
			// Resigned, and the seat already anonymous: recordRoom and
			// rateGame then never see the uid.
			const now = Date.now();
			await ref.transaction((r) => {
				if (r === null) return null;
				if (r.status !== 'playing') return undefined;
				Object.assign(r, { forfeitedBy: me, finishedBy: me, winner: opp, endReason: 'forfeit',
					status: 'finished', closedAt: now, finishedAt: now });
				r[me] = Object.assign({}, r[me], { uid: 'deleted', displayName: 'Deleted player' });
				return r;
			});
		} else if (room.status === 'finished') {
			await seatScrub(code, me);
		}
	}
	await db.ref().update(updates);
	// Delete the sign-in last, here rather than in the client, so the uid
	// can never come back to a fresh profile.
	await getAuth().deleteUser(uid);
	logger.info('deleteUserData', { uid, games: games.numChildren() });
	return { ok: true };
});

exports.expireClocks = onSchedule({ schedule: 'every 1 minutes', region: REGION, timeoutSeconds: 120 }, async () => {
	const ended = await expireRooms(database(), Date.now());
	if (ended) logger.info('expireClocks', { ended });
});

exports.settleAbort = onValueWritten({
	// On the status, not abortedBy: the two may be written apart.
	ref: '/rooms/{code}/status',
	instance: DB_INSTANCE,
	region: REGION,
	// Retried on failure: finishRoom only acts on a room still 'aborted'.
	retry: true,
}, async (event) => {
	if (event.data.after.val() !== 'aborted' || event.data.before.val() === 'aborted') return;
	const db = event.data.after.ref.root.database;
	const code = event.params.code;
	const room = (await db.ref('rooms/' + code).once('value')).val();
	const by = room && room.abortedBy;
	if (by !== 'red' && by !== 'blue') return;
	// Each player may abort until both have moved; later it is a forfeit.
	if (room.status !== 'aborted' || roomTurns(room).length < 2) return;
	await finishRoom(db, code, 'aborted',
		{ winner: by === 'red' ? 'blue' : 'red', forfeitedBy: by, endReason: 'forfeit' });
	logger.info('settleAbort', { code, by });
});

// The emulators have no FCM: there the push is only logged.
async function sendPush(tokens, message) {
	if (process.env.FUNCTIONS_EMULATOR === 'true') {
		logger.info('notifyTurn (emulator, not sent)', { tokens: tokens.length, data: message.data });
		return tokens.map(() => ({ success: true }));
	}
	const { getMessaging } = require('firebase-admin/messaging');
	const res = await getMessaging().sendEachForMulticast(Object.assign({ tokens }, message));
	return res.responses.map((r) => (r.success ? { success: true } : { error: { code: r.error && r.error.code } }));
}

const notifyTurnFn = onValueCreated({
	ref: '/rooms/{code}/turns/{turnId}',
	instance: DB_INSTANCE,
	region: REGION,
	retry: false,
}, async (event) => {
	const db = event.data.ref.root.database;
	const res = await notifyTurn(db, event.params.code, event.params.turnId, Date.now(), sendPush);
	if (res && res.sent + res.removed > 0) logger.info('notifyTurn', Object.assign({ code: event.params.code }, res));
});
// Not on the emulators unless asked (SIGIL_EMULATE_PUSH=1): there is no FCM
// there, and the emulator starts a worker process per pending event, so a
// test that plays a hundred turns in a few seconds starves the other
// functions. test/e2e.test.js calls notify.js notifyTurn directly instead.
if (process.env.FUNCTIONS_EMULATOR !== 'true' || process.env.SIGIL_EMULATE_PUSH === '1') {
	exports.notifyTurn = notifyTurnFn;
}
