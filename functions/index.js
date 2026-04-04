/**
 * OPTIONAL: Firebase Cloud Function for server-side Elo processing.
 *
 * This is NOT required — Elo is computed client-side in elo.js.
 * This Cloud Function version exists as an alternative if you want
 * stronger security guarantees (requires Firebase Blaze plan).
 *
 * To use: `cd functions && npm install && firebase deploy --only functions`
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

exports.processElo = functions.database
	.ref('/completed_games/{gameId}')
	.onCreate(async (snapshot, context) => {
		const game = snapshot.val();

		if (!game.ranked || !game.redUid || !game.blueUid) return null;
		if (game.eloProcessed) return null;
		if (game.redUid === game.blueUid) return null;

		const db = admin.database();
		const winnerUid = game.winner === 'red' ? game.redUid : game.blueUid;
		const loserUid = game.winner === 'red' ? game.blueUid : game.redUid;

		const [winnerSnap, loserSnap] = await Promise.all([
			db.ref(`users/${winnerUid}`).once('value'),
			db.ref(`users/${loserUid}`).once('value'),
		]);

		const winnerData = winnerSnap.val() || {};
		const loserData = loserSnap.val() || {};

		const winnerElo = winnerData.elo || 1000;
		const loserElo = loserData.elo || 1000;

		const exponent = (winnerElo - loserElo) / 400;
		const expectedScore = 1 / (1 + Math.pow(10, exponent));
		const points = Math.max(1, Math.round(32 * expectedScore));

		const newWinnerElo = winnerElo + points;
		const newLoserElo = loserElo - points;

		const updates = {};
		updates[`users/${winnerUid}/elo`] = newWinnerElo;
		updates[`users/${winnerUid}/gamesPlayed`] = (winnerData.gamesPlayed || 0) + 1;
		updates[`users/${winnerUid}/wins`] = (winnerData.wins || 0) + 1;
		updates[`users/${loserUid}/elo`] = newLoserElo;
		updates[`users/${loserUid}/gamesPlayed`] = (loserData.gamesPlayed || 0) + 1;
		updates[`users/${loserUid}/losses`] = (loserData.losses || 0) + 1;
		updates[`leaderboard/${winnerUid}/elo`] = newWinnerElo;
		updates[`leaderboard/${winnerUid}/displayName`] = winnerData.displayName || 'Unknown';
		updates[`leaderboard/${winnerUid}/gamesPlayed`] = (winnerData.gamesPlayed || 0) + 1;
		updates[`leaderboard/${loserUid}/elo`] = newLoserElo;
		updates[`leaderboard/${loserUid}/displayName`] = loserData.displayName || 'Unknown';
		updates[`leaderboard/${loserUid}/gamesPlayed`] = (loserData.gamesPlayed || 0) + 1;
		updates[`completed_games/${context.params.gameId}/eloProcessed`] = true;
		updates[`completed_games/${context.params.gameId}/eloChange`] = points;

		await db.ref().update(updates);
		return null;
	});
