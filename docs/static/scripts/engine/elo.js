/**
 * Client-side Elo rating computation and persistence.
 *
 * After a ranked game ends, the winner's client computes the Elo change
 * and writes it to Firebase RTDB via an atomic multi-path update.
 *
 * Security (enforced by database.rules.json):
 *   - Profile fields (displayName, settings, created) are writable only by
 *     their owner; AI records (__ai_*__) may be created by any signed-in user.
 *   - elo / gamesPlayed / wins / losses may be written by any signed-in user
 *     (so the winner's client can update both players), but each write must
 *     move Elo by at most 32 and bump counters by at most 1.
 *   - /user_games/{uid}/{gameId} may be written by the owner or by the
 *     opponent named in the entry's opponentUid.
 *   Without a server there is no rule tying an Elo write to a specific
 *   completed game, so repeated ±32 writes remain possible; that requires
 *   the Cloud Function in functions/index.js (Blaze plan).
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

	// Leaderboard (denormalized). Name and isAI are written on profile creation
	// and on rename — don't mirror them from /users every game, since a corrupt
	// users.displayName would propagate to the leaderboard on every match.
	updates['leaderboard/' + winnerUid + '/elo'] = newWinnerElo;
	updates['leaderboard/' + winnerUid + '/gamesPlayed'] = (winnerData.gamesPlayed || 0) + 1;

	updates['leaderboard/' + loserUid + '/elo'] = newLoserElo;
	updates['leaderboard/' + loserUid + '/gamesPlayed'] = (loserData.gamesPlayed || 0) + 1;

	// Mark as processed
	updates['completed_games/' + gameId + '/eloProcessed'] = true;
	updates['completed_games/' + gameId + '/eloChange'] = points;

	// Snapshot per-player ratings on the game record (PGN-style WhiteElo/BlackElo)
	const redBefore = game.winner === 'red' ? winnerElo : loserElo;
	const blueBefore = game.winner === 'red' ? loserElo : winnerElo;
	const redAfter = game.winner === 'red' ? newWinnerElo : newLoserElo;
	const blueAfter = game.winner === 'red' ? newLoserElo : newWinnerElo;
	updates['completed_games/' + gameId + '/redEloBefore'] = redBefore;
	updates['completed_games/' + gameId + '/blueEloBefore'] = blueBefore;
	updates['completed_games/' + gameId + '/redEloAfter'] = redAfter;
	updates['completed_games/' + gameId + '/blueEloAfter'] = blueAfter;

	// Per-user game index for profile pages (one entry per player).
	// Profile pages read /user_games/{uid} to list a player's games and
	// derive rating history.
	const redData = game.winner === 'red' ? winnerData : loserData;
	const blueData = game.winner === 'red' ? loserData : winnerData;
	const redName = redData.displayName || 'Red';
	const blueName = blueData.displayName || 'Blue';
	const roomCode = game.roomCode || null;
	const ts = game.timestamp || Date.now();

	// Red's entry (opponent is blue)
	updates['user_games/' + game.redUid + '/' + gameId] = {
		timestamp: ts,
		roomCode: roomCode,
		gameId: gameId,
		opponent: blueName,
		opponentUid: game.blueUid,
		opponentIsAI: !!blueData.isAI,
		color: 'red',
		result: game.winner === 'red' ? 'win' : 'loss',
		eloBefore: redBefore,
		eloAfter: redAfter,
		eloChange: redAfter - redBefore,
	};
	// Blue's entry (opponent is red)
	updates['user_games/' + game.blueUid + '/' + gameId] = {
		timestamp: ts,
		roomCode: roomCode,
		gameId: gameId,
		opponent: redName,
		opponentUid: game.redUid,
		opponentIsAI: !!redData.isAI,
		color: 'blue',
		result: game.winner === 'blue' ? 'win' : 'loss',
		eloBefore: blueBefore,
		eloAfter: blueAfter,
		eloChange: blueAfter - blueBefore,
	};

	await db.ref().update(updates);

	console.log('[Elo] Processed:', winnerData.displayName, '+' + points, '(' + newWinnerElo + '),',
		loserData.displayName, '-' + points, '(' + newLoserElo + ')');

	return { points, newWinnerElo, newLoserElo };
}
