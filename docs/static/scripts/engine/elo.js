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
 * Expected score of player A against B when A plays a side that wins with
 * probability `posP` from the start position between equal players (games
 * started from a position, engine/reports/2026-10-position-ratings.md). The
 * position is an Elo handicap added to the rating gap in logit space, so if
 * posP is calibrated, A's expected rating change is zero whichever side A
 * picks. A forced win (posP 0 or 1) is certain whatever the ratings.
 * @param {number} posP - P(A's side wins | position), 0..1
 * @param {number} eloA
 * @param {number} eloB
 * @returns {number} expected score of A, 0..1
 */
function positionExpectedScore(posP, eloA, eloB) {
	if (!(posP > 0)) return 0;
	if (!(posP < 1)) return 1;
	const logit = Math.log(posP / (1 - posP)) + Math.LN10 * (eloA - eloB) / 400;
	return 1 / (1 + Math.exp(-logit));
}

/**
 * Compute Elo points exchanged. K-factor = 32.
 * @param {number} winnerElo
 * @param {number} loserElo
 * @param {number|null} [winnerPosP] - for a game from a position: P(the
 *   winner's side wins | position). Omitted: the standard formula.
 * @returns {number} points gained by winner (and lost by loser): 1–32 for a
 *   standard game; 0–32 from a position, with no floor, since a floor of 1
 *   would pay a sure profit for converting a won position.
 */
function computeEloChange(winnerElo, loserElo, winnerPosP) {
	if (typeof winnerPosP === 'number') {
		return Math.round(32 * (1 - positionExpectedScore(winnerPosP, winnerElo, loserElo)));
	}
	const exponent = (winnerElo - loserElo) / 400;
	const expectedScore = 1 / (1 + Math.pow(10, exponent));
	return Math.max(1, Math.round(32 * expectedScore));
}

/** P(red wins | start position) of a game record, or null for a standard game. */
function gameStartRedWinProb(game) {
	const p = game && game.startPos && game.startPos.redWinProb;
	return (typeof p === 'number' && p >= 0 && p <= 1) ? p : null;
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

	// Read both profiles, and whether each has a leaderboard name
	const [winnerSnap, loserSnap, winnerLbName, loserLbName] = await Promise.all([
		db.ref('users/' + winnerUid).once('value'),
		db.ref('users/' + loserUid).once('value'),
		db.ref('leaderboard/' + winnerUid + '/displayName').once('value'),
		db.ref('leaderboard/' + loserUid + '/displayName').once('value'),
	]);

	const winnerData = winnerSnap.val() || {};
	const loserData = loserSnap.val() || {};

	const winnerElo = winnerData.elo || 1000;
	const loserElo = loserData.elo || 1000;
	const pRed = gameStartRedWinProb(game);
	const winnerPosP = pRed === null ? null : (game.winner === 'red' ? pRed : 1 - pRed);
	const points = computeEloChange(winnerElo, loserElo, winnerPosP);

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

	// Inactive AIs are pruned from the leaderboard while their profiles stay.
	// When one plays again, restore its name from the profile so it does not
	// come back as a nameless row. Only when the name is missing (so a corrupt
	// profile name cannot overwrite a good one), and only for AI records: the
	// rules let any signed-in client write __ai_*__ leaderboard entries but not
	// another human's, and one denied path would fail the whole update.
	[[winnerUid, winnerData, winnerLbName], [loserUid, loserData, loserLbName]].forEach(([uid, data, lbName]) => {
		const name = data.displayName;
		if (lbName.exists() || !data.isAI || !/^__ai_[a-z0-9_]+__$/.test(uid)) return;
		if (typeof name !== 'string' || name.length < 1 || name.length > 30) return;
		updates['leaderboard/' + uid + '/displayName'] = name;
		updates['leaderboard/' + uid + '/isAI'] = true;
	});

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
	if (pRed !== null) {
		updates['completed_games/' + gameId + '/redExpected'] = positionExpectedScore(pRed, redBefore, blueBefore);
	}

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
		fromPosition: pRed !== null,
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
		fromPosition: pRed !== null,
	};

	await db.ref().update(updates);

	console.log('[Elo] Processed:', winnerData.displayName, '+' + points, '(' + newWinnerElo + '),',
		loserData.displayName, '-' + points, '(' + newLoserElo + ')');

	return { points, newWinnerElo, newLoserElo };
}
