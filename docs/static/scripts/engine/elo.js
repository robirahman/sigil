/**
 * Elo rating math, shared by the site and the rating function.
 *
 * Ratings are computed on the server: the rateGame Cloud Function
 * (functions/index.js, functions/rating.js) checks each new completed_games
 * record and is the only writer of elo / gamesPlayed / wins / losses and
 * user_games (database.rules.json). It loads this file for the formula, so
 * the price lists on the site (position-rating.js) and the ratings agree.
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

/**
 * Why a game cannot be rated, or null when it can. The one rule shared by the
 * lobby (firebase-sync.js joinRoom), the AI game notice (game-board-local.js)
 * and the rating function (functions/rating.js), which re-checks it.
 * @param {string[]} spellNames
 * @param {string} variant
 * @param {string|null} startSfn - the start of a game from a position
 * @param {object|null} startPos - its price (position-rating.js)
 * @returns {null|string} 'unrated-pack' | 'deathmatch' | 'duplicates' |
 *   'scramble' | 'pentagon' | 'unpriced-start'
 */
function unratedReason(spellNames, variant, startSfn, startPos) {
	// Panda and Experimental are unofficial.
	if ((spellNames || []).some(s => isUnratedSpell(s))) return 'unrated-pack';
	if (variantHasDeathmatch(variant)) return 'deathmatch';
	if (variantHasDuplicates(variant)) return 'duplicates';
	if (variantHasScramble(variant)) return 'scramble';
	if (variantHasPentagon(variant)) return 'pentagon';
	// A game from a position is rated only when its start was priced.
	if (startSfn && !(startPos && typeof startPos.redWinProb === 'number')) return 'unpriced-start';
	return null;
}

/** P(red wins | start position) of a game record, or null for a standard game. */
function gameStartRedWinProb(game) {
	const p = game && game.startPos && game.startPos.redWinProb;
	return (typeof p === 'number' && p >= 0 && p <= 1) ? p : null;
}

/**
 * Wait for the server's rating of a just-recorded game (the rateGame Cloud
 * Function writes user_games/{uid}/{gameId} for each human player, rated or
 * not). Resolves with the result for the signed-in player, in the shape
 * the AI game notice and the offline queue use, or null when the game was
 * not rated or the function did not answer in time.
 *
 * @param {firebase.database.Database} db
 * @param {string} gameId - push key of the completed_games record
 * @param {object} game - the completed game record
 * @param {number} [timeoutMs]
 * @returns {Promise<null|{points, newWinnerElo, newLoserElo}>} the player's
 *   own side of newWinnerElo / newLoserElo; the opponent's is null.
 */
function awaitGameRating(db, gameId, game, timeoutMs) {
	const user = typeof firebase !== 'undefined' && firebase.auth().currentUser;
	const uid = user && user.uid;
	if (!game.ranked || !uid || (uid !== game.redUid && uid !== game.blueUid)) return Promise.resolve(null);
	const ref = db.ref('user_games/' + uid + '/' + gameId);
	return new Promise((resolve) => {
		let timer = null;
		const done = (v) => {
			clearTimeout(timer);
			ref.off('value', onValue);
			resolve(v);
		};
		const onValue = (snap) => {
			const e = snap.val();
			if (!e) return;
			if (e.rated !== true || typeof e.eloChange !== 'number') return done(null);
			const won = e.result === 'win';
			done({
				points: Math.abs(e.eloChange),
				newWinnerElo: won ? e.eloAfter : null,
				newLoserElo: won ? null : e.eloAfter,
			});
		};
		timer = setTimeout(() => done(null), timeoutMs || 30000);
		ref.on('value', onValue, () => done(null));
	});
}
