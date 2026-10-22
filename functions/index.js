'use strict';
/**
 * Cloud Functions for Sigil Online (Firebase Blaze plan).
 *
 *   rateGame       - checks and rates every new completed_games record
 *                    (rating.js); the only writer of Elo, the game counters
 *                    and user_games.
 *   deleteUserData - removes a player's own records and their sign-in, for
 *                    "Delete account" on account.html.
 *
 * Deploy: `firebase deploy --only functions` from the repo root (firebase.json
 * copies the engine into functions/engine/ first). Deploy together with
 * database.rules.json, which takes those writes away from the clients.
 */

const { onValueCreated } = require('firebase-functions/v2/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabaseWithUrl } = require('firebase-admin/database');
const { judgeGame, ratingUpdates, freshEngine } = require('./rating');

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

exports.rateGame = onValueCreated({
	ref: '/completed_games/{gameId}',
	instance: DB_INSTANCE,
	region: REGION,
	// One game at a time, site-wide: each rating reads both players'
	// current Elo, so two games of one player must not interleave.
	concurrency: 1,
	maxInstances: 1,
	memory: '512MiB',
	retry: false,
}, async (event) => {
	const gameId = event.params.gameId;
	const record = event.data.val();
	// The database the record was written to.
	const db = event.data.ref.root.database;
	if (!record || record.eloProcessed) return;

	const room = record.roomCode
		? (await db.ref('rooms/' + record.roomCode).once('value')).val() : null;
	const verdict = await judgeGame(record, { room, isFullAccount, now: Date.now() });
	if (verdict.skip) return;

	// One rating per game, however many records claim it (both clients of
	// an online game may record it, and a retried upload re-creates one).
	if (verdict.rated) {
		const claim = await db.ref('rating_claims/' + verdict.claimKey).transaction(
			(cur) => (cur ? undefined : gameId));
		if (!claim.committed) {
			Object.assign(verdict, { rated: false, reason: 'duplicate' });
		}
	}

	const uids = { red: record.redUid, blue: record.blueUid };
	const [redSnap, blueSnap, redLb, blueLb] = await Promise.all([
		db.ref('users/' + uids.red).once('value'),
		db.ref('users/' + uids.blue).once('value'),
		db.ref('leaderboard/' + uids.red + '/displayName').once('value'),
		db.ref('leaderboard/' + uids.blue + '/displayName').once('value'),
	]);
	const updates = ratingUpdates(gameId, record, verdict,
		{ red: redSnap.val(), blue: blueSnap.val() },
		{ red: redLb.exists(), blue: blueLb.exists() },
		freshEngine());
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
	const updates = {
		['users/' + uid]: null,
		['leaderboard/' + uid]: null,
		['user_games/' + uid]: null,
		['user_active_games/' + uid]: null,
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
	await db.ref().update(updates);
	// Delete the sign-in last, here rather than in the client, so the uid
	// can never come back to a fresh profile.
	await getAuth().deleteUser(uid);
	logger.info('deleteUserData', { uid, games: games.numChildren() });
	return { ok: true };
});
