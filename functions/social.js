'use strict';
/**
 * Badges and the activity feed: written here only, so neither can be forged.
 *
 *   badges/{uid}/{id}: { at, ... }          public; the catalog and the rules
 *                                           that award them are
 *                                           docs/static/scripts/engine/badges.js
 *   activity/{uid}/{key}: { t, at, ... }    public; what feed.html shows for the
 *                                           players one follows (read per player,
 *                                           newest first), and a profile's
 *                                           "Recent activity". At most
 *                                           ACTIVITY_KEEP entries a player.
 *   achievements/{uid}: { peakElo, puzzleStreak: { day, n, best } }
 *                                           public; the server's own state for
 *                                           rating milestones and the daily
 *                                           puzzle streak
 *
 * Activity keys are fixed per fact (w_<gameId>, r_<rating>, b_<badge>,
 * p_<n>_<day>, tj_/tw_<tournament>), so a retried event writes the same entry.
 * `at` is always the server's time, never a client-supplied game timestamp, so
 * no one can pin an entry to the top of the feed.
 *
 * Entry types (t):
 *   win              { game, opp, oppName, oppAI, rated, change, elo }
 *   rating           { elo }            a new multiple of 100, first time there
 *   puzzle-streak    { n, day }         the daily puzzle n days in a row
 *   badge            { badge }          a badge earned (not rating or puzzle
 *                                       badges, which the two above announce)
 *   tournament-join  { tid, tname }     from recordTournamentEntry
 *   tournament-win   { tid, tname }     from recordTournamentWin
 */

const { requireShared } = require('./engine-loader');
const B = requireShared('badges.js');

const AI_UID = /^__ai_[a-z0-9_]+__$/;
// Entries kept per player; pruned (oldest first) once ACTIVITY_SLACK more pile up.
const ACTIVITY_KEEP = 100;
const ACTIVITY_SLACK = 20;
// Rated games read back for the current win streak: enough for the longest
// streak badge.
const WIN_STREAK_LOOKBACK = Math.max(...B.SIGIL_BADGE_WIN_STREAKS) + 2;

/**
 * Badges whose award is posted to the feed. Rating and puzzle badges are not:
 * their milestones (rating, puzzle-streak) are posted instead.
 */
function postsBadge(id) {
	return !/^rating-|^puzzle-streak-|^tournament-win$/.test(id);
}

/**
 * Was this badge earned by this very game, rather than caught up on (a
 * veteran's first game after badges shipped earns games-100 too, but nobody
 * needs to read about it)?
 */
function freshBadge(id, entry, state) {
	let m;
	if (id === 'first-win') return (state.wins || 0) <= 1;
	if ((m = /^games-(\d+)$/.exec(id))) return state.gamesPlayed === Number(m[1]);
	if ((m = /^streak-(\d+)$/.exec(id))) return state.winStreak === Number(m[1]);
	if (id === 'giant-killer') return true;
	return false;
}

async function isGone(db, uid) {
	return (await db.ref('deleted_users/' + uid).once('value')).exists();
}

/**
 * An account deleted while this event was being handled (deleteUserData
 * marks deleted_users first, then scrubs): what was just written for it goes.
 */
async function undoIfGone(db, uid, out) {
	if (!(await isGone(db, uid))) return out;
	await db.ref().update({ ['activity/' + uid]: null, ['badges/' + uid]: null, ['achievements/' + uid]: null });
	return { skipped: 'deleted' };
}

/** Write an activity entry (idempotent by key) and prune the oldest. */
async function recordActivity(db, uid, key, entry) {
	await db.ref('activity/' + uid + '/' + key).set(entry);
	await pruneActivity(db, uid);
}

async function pruneActivity(db, uid, keep) {
	const max = keep || ACTIVITY_KEEP;
	const all = (await db.ref('activity/' + uid).once('value')).val() || {};
	const keys = Object.keys(all);
	if (keys.length <= max + (keep ? 0 : ACTIVITY_SLACK)) return 0;
	keys.sort((a, b) => ((all[a] && all[a].at) || 0) - ((all[b] && all[b].at) || 0));
	const drop = {};
	for (const k of keys.slice(0, keys.length - max)) drop[k] = null;
	await db.ref('activity/' + uid).update(drop);
	return Object.keys(drop).length;
}

/**
 * Award a badge once: true when it is new. A new one that is `post`ed goes to
 * the feed as well.
 */
async function awardBadge(db, uid, id, now, detail, post) {
	if (!B.sigilBadge(id)) return false;
	const res = await db.ref('badges/' + uid + '/' + id).transaction((cur) => (cur ? undefined : Object.assign({ at: now }, detail || {})));
	if (!res.committed) return false;
	if (post) await recordActivity(db, uid, 'b_' + id, { t: 'badge', at: now, badge: id });
	return true;
}

/**
 * Rated games won in a row up to and including this one (its user_games
 * entry is already written), newest first by the game's time.
 */
async function winStreak(db, uid, entry) {
	const ts = typeof entry.timestamp === 'number' ? entry.timestamp : Infinity;
	const snap = await db.ref('user_games/' + uid).orderByChild('timestamp').endAt(ts).limitToLast(WIN_STREAK_LOOKBACK * 3).once('value');
	const games = [];
	snap.forEach((c) => { const v = c.val(); if (v && v.rated === true) games.push(v); });
	games.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
	let n = 0;
	for (const g of games) {
		if (g.result !== 'win') break;
		n++;
	}
	return n;
}

/**
 * A new user_games/{uid}/{gameId} entry (rateGame's, for every game a
 * signed-in player finishes): the win for the feed, rating milestones and
 * the badges it earns. Guests (no profile name) and AIs get nothing.
 */
async function onUserGame(db, uid, gameId, entry, now) {
	if (!entry || typeof uid !== 'string' || AI_UID.test(uid)) return { skipped: 'not-a-player' };
	const [name, gamesPlayed, wins] = await Promise.all(['displayName', 'gamesPlayed', 'wins']
		.map((f) => db.ref('users/' + uid + '/' + f).once('value').then((s) => s.val())));
	if (typeof name !== 'string' || !name) return { skipped: 'no-profile' };
	if (await isGone(db, uid)) return { skipped: 'deleted' };
	const out = { posted: [], badges: [] };

	if (entry.result === 'win') {
		const w = {
			t: 'win', at: now,
			game: typeof entry.roomCode === 'string' ? entry.roomCode : null,
			opp: typeof entry.opponentUid === 'string' && entry.opponentUid !== 'deleted' ? entry.opponentUid : null,
			oppName: typeof entry.opponent === 'string' ? entry.opponent.slice(0, 40) : null,
			oppAI: !!entry.opponentIsAI,
			rated: entry.rated === true,
		};
		if (w.rated && typeof entry.eloChange === 'number') w.change = entry.eloChange;
		if (w.rated && typeof entry.eloAfter === 'number') w.elo = entry.eloAfter;
		await recordActivity(db, uid, 'w_' + gameId, w);
		out.posted.push('w_' + gameId);
	}

	const state = { gamesPlayed: typeof gamesPlayed === 'number' ? gamesPlayed : 0, wins: typeof wins === 'number' ? wins : 0, winStreak: 0 };
	if (entry.rated === true) {
		state.winStreak = entry.result === 'win' ? await winStreak(db, uid, entry) : 0;
		if (typeof entry.eloAfter === 'number') {
			// The peak before this game: the stored one, or (first time) the
			// rating the game started from, so only a crossing in this game
			// is news.
			let crossed = [];
			const res = await db.ref('achievements/' + uid + '/peakElo').transaction((cur) => {
				const peak = typeof cur === 'number' ? cur : (typeof entry.eloBefore === 'number' ? entry.eloBefore : entry.eloAfter);
				crossed = B.sigilRatingMilestones(peak, entry.eloAfter);
				return Math.max(peak, entry.eloAfter);
			});
			if (res.committed) {
				for (const elo of crossed) {
					await recordActivity(db, uid, 'r_' + elo, { t: 'rating', at: now, elo });
					out.posted.push('r_' + elo);
				}
			}
		}
	}

	for (const id of B.sigilGameBadges(entry, state)) {
		const detail = id === 'giant-killer' && entry.roomCode ? { game: entry.roomCode } : null;
		const post = postsBadge(id) && freshBadge(id, entry, state);
		if (await awardBadge(db, uid, id, now, detail, post)) {
			out.badges.push(id);
			if (post) out.posted.push('b_' + id);
		}
	}
	return undoIfGone(db, uid, out);
}

/**
 * users/{uid}/puzzleProgress/daily/{day} written: a solve of today's (or
 * yesterday's) daily puzzle extends the server's streak count, which earns
 * the streak badges and posts the milestones. The solve itself is the
 * client's word, as every puzzle result is; the day it counts for is the
 * server's.
 */
async function onPuzzleDaily(db, uid, day, status, now) {
	if (status !== 'solved' || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { skipped: 'not-a-solve' };
	if (await isGone(db, uid)) return { skipped: 'deleted' };
	let next = null;
	const res = await db.ref('achievements/' + uid + '/puzzleStreak').transaction((cur) => {
		next = B.sigilNextPuzzleStreak(cur, day, now);
		return next === null ? undefined : next;
	});
	if (!res.committed || !next) return { skipped: 'no-change' };
	const out = { streak: next.n, posted: [], badges: [] };
	if (B.SIGIL_FEED_PUZZLE_STREAKS.includes(next.n)) {
		const key = 'p_' + next.n + '_' + day;
		await recordActivity(db, uid, key, { t: 'puzzle-streak', at: now, n: next.n, day });
		out.posted.push(key);
	}
	for (const id of B.sigilPuzzleStreakBadges(next.n)) {
		if (await awardBadge(db, uid, id, now, null, false)) out.badges.push(id);
	}
	return undoIfGone(db, uid, out);
}

function _tournament(t) {
	return { tid: String(t.id).slice(0, 64), tname: String(t.name || 'a tournament').slice(0, 80) };
}

/**
 * For the tournament code (server side), when a player enters one:
 * "X joined <name>" in the feed. t = { id, name }.
 */
async function recordTournamentEntry(db, uid, t, now) {
	if (!t || !t.id || AI_UID.test(uid) || await isGone(db, uid)) return false;
	const v = _tournament(t);
	await recordActivity(db, uid, 'tj_' + v.tid.replace(/[.#$/[\]]/g, '_'), Object.assign({ t: 'tournament-join', at: now }, v));
	return true;
}

/** For the tournament code, when a tournament ends: the winner's badge and feed entry. */
async function recordTournamentWin(db, uid, t, now) {
	if (!t || !t.id || AI_UID.test(uid) || await isGone(db, uid)) return false;
	const v = _tournament(t);
	await awardBadge(db, uid, 'tournament-win', now, v, false);
	await recordActivity(db, uid, 'tw_' + v.tid.replace(/[.#$/[\]]/g, '_'), Object.assign({ t: 'tournament-win', at: now }, v));
	return true;
}

/**
 * deleteUserData: the deleted player's own social records go, and the wins
 * their opponents posted against them lose the name. `games` is their
 * user_games snapshot; adds to `updates`.
 */
async function deletionUpdates(db, uid, games, updates) {
	for (const p of ['activity', 'badges', 'achievements', 'notes', 'bookmarks', 'streamers', 'titles']) updates[p + '/' + uid] = null;
	const wins = [];
	games.forEach((g) => {
		const e = g.val() || {};
		if (e.result === 'loss' && typeof e.opponentUid === 'string' && e.opponentUid && e.opponentUid !== uid && !AI_UID.test(e.opponentUid)) {
			wins.push('activity/' + e.opponentUid + '/w_' + g.key);
		}
	});
	// Only entries that are there: a field written under a missing one
	// would create a stub.
	for (const p of wins) {
		if (!(await db.ref(p + '/t').once('value')).exists()) continue;
		updates[p + '/opp'] = null;
		updates[p + '/oppName'] = 'Deleted player';
	}
	return updates;
}

module.exports = {
	ACTIVITY_KEEP, onUserGame, onPuzzleDaily, recordActivity, pruneActivity, awardBadge, winStreak,
	recordTournamentEntry, recordTournamentWin, deletionUpdates, freshBadge, postsBadge,
};
