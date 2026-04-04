/**
 * Client-side Elo rating computation and persistence.
 *
 * After a ranked game ends, the winner's client computes the Elo change
 * and writes it to Firebase RTDB via an atomic multi-path update.
 *
 * Security: Firebase RTDB rules should validate that:
 *   - The writer is authenticated (auth !== null)
 *   - Elo changes are bounded (1–32 points for K=32)
 *   - The completed game record exists and is marked ranked
 *   - The eloProcessed flag prevents double-processing
 */

/**
 * Compute Elo points exchanged. K-factor = 32.
 * @param {number} winnerElo
 * @param {number} loserElo
 * @returns {number} points gained by winner (and lost by loser), 1–32
 */
function computeEloChange(winnerElo, loserElo) {
	const exponent = (winnerElo - loserElo) / 400;
	const expectedScore = 1 / (1 + Math.pow(10, exponent));
	return Math.max(1, Math.round(32 * expectedScore));
}

/**
 * Process Elo after a ranked game ends.
 * Called by the red player's client (same convention as saveCompletedGame).
 *
 * @param {firebase.database.Database} db
 * @param {string} gameId - push key of the completed_games record
 * @param {object} game - the completed game record
 */
async function processEloClientSide(db, gameId, game) {
	if (!game.ranked || !game.redUid || !game.blueUid) return;
	if (game.redUid === game.blueUid) return;

	const winnerUid = game.winner === 'red' ? game.redUid : game.blueUid;
	const loserUid = game.winner === 'red' ? game.blueUid : game.redUid;

	// Read both profiles
	const [winnerSnap, loserSnap] = await Promise.all([
		db.ref('users/' + winnerUid).once('value'),
		db.ref('users/' + loserUid).once('value'),
	]);

	const winnerData = winnerSnap.val() || {};
	const loserData = loserSnap.val() || {};

	const winnerElo = winnerData.elo || 1000;
	const loserElo = loserData.elo || 1000;
	const points = computeEloChange(winnerElo, loserElo);

	const newWinnerElo = winnerElo + points;
	const newLoserElo = loserElo - points;

	// Atomic multi-path update
	const updates = {};

	// User profiles
	updates['users/' + winnerUid + '/elo'] = newWinnerElo;
	updates['users/' + winnerUid + '/gamesPlayed'] = (winnerData.gamesPlayed || 0) + 1;
	updates['users/' + winnerUid + '/wins'] = (winnerData.wins || 0) + 1;

	updates['users/' + loserUid + '/elo'] = newLoserElo;
	updates['users/' + loserUid + '/gamesPlayed'] = (loserData.gamesPlayed || 0) + 1;
	updates['users/' + loserUid + '/losses'] = (loserData.losses || 0) + 1;

	// Leaderboard (denormalized)
	updates['leaderboard/' + winnerUid + '/elo'] = newWinnerElo;
	updates['leaderboard/' + winnerUid + '/displayName'] = winnerData.displayName || 'Unknown';
	updates['leaderboard/' + winnerUid + '/gamesPlayed'] = (winnerData.gamesPlayed || 0) + 1;

	updates['leaderboard/' + loserUid + '/elo'] = newLoserElo;
	updates['leaderboard/' + loserUid + '/displayName'] = loserData.displayName || 'Unknown';
	updates['leaderboard/' + loserUid + '/gamesPlayed'] = (loserData.gamesPlayed || 0) + 1;

	// Mark as processed
	updates['completed_games/' + gameId + '/eloProcessed'] = true;
	updates['completed_games/' + gameId + '/eloChange'] = points;

	await db.ref().update(updates);

	console.log('[Elo] Processed:', winnerData.displayName, '+' + points, '(' + newWinnerElo + '),',
		loserData.displayName, '-' + points, '(' + newLoserElo + ')');

	return { points, newWinnerElo, newLoserElo };
}
