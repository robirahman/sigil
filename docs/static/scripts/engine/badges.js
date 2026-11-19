/**
 * badges.js — the badge catalog and the rules that award them, plus the
 * activity-feed milestones.
 *
 * One copy for the site and the server: profile.html and feed.html load it as
 * a classic script to name and draw badges, and functions/social.js
 * require()s it to award them (badges/{uid}/{id}, server-only), so a badge
 * shown is always one the server can grant.
 *
 * Badges are awarded from records the clients cannot write: user_games (the
 * rating function's entry for each game), users/{uid}/gamesPlayed, and the
 * server's own day count of daily-puzzle solves (achievements/{uid}).
 */

var SIGIL_BADGES = [
	// Games (user_games entries; counts and streaks over rated games)
	{ id: 'first-win', name: 'First Win', mark: '1st', group: 'Games', desc: 'Won a game.' },
	{ id: 'games-10', name: 'Regular', mark: '10', group: 'Games', desc: 'Played 10 rated games.' },
	{ id: 'games-100', name: 'Veteran', mark: '100', group: 'Games', desc: 'Played 100 rated games.' },
	{ id: 'games-500', name: 'Stalwart', mark: '500', group: 'Games', desc: 'Played 500 rated games.' },
	{ id: 'streak-5', name: 'On a Roll', mark: '5W', group: 'Games', desc: 'Won 5 rated games in a row.' },
	{ id: 'streak-10', name: 'Unstoppable', mark: '10W', group: 'Games', desc: 'Won 10 rated games in a row.' },
	{ id: 'giant-killer', name: 'Giant Killer', mark: 'GK', group: 'Games', desc: 'Won a rated game against a player rated at least 200 above you.' },
	// Rating (the rating after a rated game)
	{ id: 'rating-1200', name: 'Rated 1200', mark: '1200', group: 'Rating', desc: 'Reached a rating of 1200.' },
	{ id: 'rating-1400', name: 'Rated 1400', mark: '1400', group: 'Rating', desc: 'Reached a rating of 1400.' },
	{ id: 'rating-1600', name: 'Rated 1600', mark: '1600', group: 'Rating', desc: 'Reached a rating of 1600.' },
	{ id: 'rating-1800', name: 'Rated 1800', mark: '1800', group: 'Rating', desc: 'Reached a rating of 1800.' },
	{ id: 'rating-2000', name: 'Rated 2000', mark: '2000', group: 'Rating', desc: 'Reached a rating of 2000.' },
	// Puzzles (the daily puzzle, solved on consecutive UTC days)
	{ id: 'puzzle-streak-7', name: 'Puzzle Week', mark: '7d', group: 'Puzzles', desc: 'Solved the daily puzzle 7 days in a row.' },
	{ id: 'puzzle-streak-30', name: 'Puzzle Month', mark: '30d', group: 'Puzzles', desc: 'Solved the daily puzzle 30 days in a row.' },
	{ id: 'puzzle-streak-100', name: 'Puzzle Centurion', mark: '100d', group: 'Puzzles', desc: 'Solved the daily puzzle 100 days in a row.' },
	// Tournaments (awarded by the tournament code through functions/social.js
	// recordTournamentWin, once tournaments exist)
	{ id: 'tournament-win', name: 'Tournament Champion', mark: 'TC', group: 'Tournaments', desc: 'Won a tournament.' },
];

var SIGIL_BADGE_RATINGS = [1200, 1400, 1600, 1800, 2000];
var SIGIL_BADGE_GAME_COUNTS = [10, 100, 500];
var SIGIL_BADGE_WIN_STREAKS = [5, 10];
var SIGIL_BADGE_PUZZLE_STREAKS = [7, 30, 100];
// Puzzle streaks that are posted to the activity feed.
var SIGIL_FEED_PUZZLE_STREAKS = [7, 30, 100, 365];
// A rating milestone is posted at every multiple of this, from SIGIL_FEED_RATING_FROM.
var SIGIL_FEED_RATING_STEP = 100;
var SIGIL_FEED_RATING_FROM = 1100;
// "Giant killer": the opponent's rating before the game at least this far above one's own.
var SIGIL_GIANT_KILLER_GAP = 200;

function sigilBadge(id) {
	for (var i = 0; i < SIGIL_BADGES.length; i++) if (SIGIL_BADGES[i].id === id) return SIGIL_BADGES[i];
	return null;
}

/**
 * The badges a game earns, from its user_games entry and the player's state
 * after it: { gamesPlayed (rated, users/{uid}), winStreak (rated games won in
 * a row, this one included) }. Ids only; awarding twice is a no-op.
 */
function sigilGameBadges(entry, state) {
	var out = [];
	if (!entry) return out;
	var s = state || {};
	if (entry.result === 'win') out.push('first-win');
	if (entry.rated === true) {
		var gp = typeof s.gamesPlayed === 'number' ? s.gamesPlayed : 0;
		SIGIL_BADGE_GAME_COUNTS.forEach(function (n) { if (gp >= n) out.push('games-' + n); });
		var ws = typeof s.winStreak === 'number' ? s.winStreak : 0;
		SIGIL_BADGE_WIN_STREAKS.forEach(function (n) { if (ws >= n) out.push('streak-' + n); });
		if (typeof entry.eloAfter === 'number') {
			SIGIL_BADGE_RATINGS.forEach(function (r) { if (entry.eloAfter >= r) out.push('rating-' + r); });
		}
		if (entry.result === 'win' && !entry.opponentIsAI && typeof entry.opponentEloBefore === 'number'
			&& typeof entry.eloBefore === 'number' && entry.opponentEloBefore - entry.eloBefore >= SIGIL_GIANT_KILLER_GAP) {
			out.push('giant-killer');
		}
	}
	return out;
}

/**
 * The rating milestones crossed going from a peak of `peak` to `elo`
 * (multiples of SIGIL_FEED_RATING_STEP from SIGIL_FEED_RATING_FROM): each is
 * posted once, the first time the player gets there.
 */
function sigilRatingMilestones(peak, elo) {
	var out = [];
	if (typeof elo !== 'number' || typeof peak !== 'number' || elo <= peak) return out;
	var m = Math.max(SIGIL_FEED_RATING_FROM, Math.floor(peak / SIGIL_FEED_RATING_STEP) * SIGIL_FEED_RATING_STEP + SIGIL_FEED_RATING_STEP);
	for (; m <= elo; m += SIGIL_FEED_RATING_STEP) out.push(m);
	return out;
}

/** The badge ids a daily-puzzle streak of `n` days earns. */
function sigilPuzzleStreakBadges(n) {
	return SIGIL_BADGE_PUZZLE_STREAKS.filter(function (k) { return n >= k; }).map(function (k) { return 'puzzle-streak-' + k; });
}

/** The UTC day key (YYYY-MM-DD) `offset` days from `ms`. */
function sigilUtcDay(ms, offset) {
	return new Date(ms + (offset || 0) * 86400000).toISOString().slice(0, 10);
}

/**
 * The daily-puzzle streak after a 'solved' entry for `day` arrives at `now`,
 * from the stored one ({ day, n, best } or null). Only today's and
 * yesterday's (UTC) puzzle count, so a synced log of old days cannot build a
 * streak. Returns null when nothing changes.
 */
function sigilNextPuzzleStreak(cur, day, now) {
	if (day !== sigilUtcDay(now, 0) && day !== sigilUtcDay(now, -1)) return null;
	var c = cur && typeof cur.day === 'string' ? cur : null;
	if (c && c.day >= day) return null;
	var prev = sigilUtcDay(Date.parse(day + 'T00:00:00Z'), -1);
	var n = c && c.day === prev ? (c.n || 0) + 1 : 1;
	return { day: day, n: n, best: Math.max(n, (c && c.best) || 0) };
}

if (typeof module !== 'undefined' && module.exports) {
	module.exports = {
		SIGIL_BADGES, SIGIL_BADGE_RATINGS, SIGIL_BADGE_GAME_COUNTS, SIGIL_BADGE_WIN_STREAKS, SIGIL_BADGE_PUZZLE_STREAKS,
		SIGIL_FEED_PUZZLE_STREAKS, SIGIL_FEED_RATING_STEP, SIGIL_FEED_RATING_FROM, SIGIL_GIANT_KILLER_GAP,
		sigilBadge, sigilGameBadges, sigilRatingMilestones, sigilPuzzleStreakBadges, sigilUtcDay, sigilNextPuzzleStreak,
	};
}
