/**
 * Puzzle ratings (Elo), Lichess-style: a player's first attempt at a puzzle is
 * a game between the player and the puzzle. Solving it is a win for the
 * player; a miss or a revealed solution is a win for the puzzle. Both ratings
 * move.
 *
 * Storage (database.rules.json enforces the shape):
 *   users/<uid>/puzzle                 { rating, plays, last }   last = the
 *       puzzle whose first attempt this write records (the rules tie each
 *       rating change to exactly one new attempt)
 *   users/<uid>/puzzleAttempts/<id>    { solved, at, delta }   write-once
 *   puzzle_ratings/<id>                { rating, plays }       seeded from the
 *       AI calibration (tools/fit_puzzle_ratings.py); clients only update it,
 *       in the same write that records their first attempt
 *   puzzle_leaderboard/<uid>           { displayName, rating, plays }
 * Signed-out and anonymous visitors keep a rating in localStorage only and do
 * not move puzzle ratings.
 */

const PUZZLE_RATING_START = 1500;
const PUZZLE_LOCAL_KEY = 'sigil_puzzle_rating';

/** Expected score of a player rated `r` against a puzzle rated `p`. */
function puzzleExpected(r, p) {
	return 1 / (1 + Math.pow(10, (p - r) / 400));
}

/** Player K: fast while provisional, then steady. The rules allow up to 40. */
function puzzleKUser(plays) {
	return plays < 20 ? 40 : 20;
}

/** Puzzle K: the calibration is a few results, so early players move it more. The rules allow up to 32. */
function puzzleKPuzzle(plays) {
	return plays < 20 ? 24 : 12;
}

/** The rating update for one result: integer ratings, as the rules expect. */
function puzzleRatingUpdate(user, puzzle, solved) {
	const e = puzzleExpected(user.rating, puzzle.rating);
	const s = solved ? 1 : 0;
	const du = Math.round(puzzleKUser(user.plays) * (s - e));
	const dp = Math.round(puzzleKPuzzle(puzzle.plays) * (e - s));
	return {
		user: { rating: user.rating + du, plays: user.plays + 1 },
		puzzle: { rating: puzzle.rating + dp, plays: puzzle.plays + 1 },
		delta: du,
		puzzleDelta: dp,
	};
}

function _puzzleLocal() {
	try {
		const v = JSON.parse(localStorage.getItem(PUZZLE_LOCAL_KEY) || 'null');
		if (v && typeof v.rating === 'number') return Object.assign({ plays: 0, attempts: {} }, v);
	} catch (e) { /* storage blocked */ }
	return { rating: PUZZLE_RATING_START, plays: 0, attempts: {} };
}

function _puzzleSaveLocal(v) {
	try { localStorage.setItem(PUZZLE_LOCAL_KEY, JSON.stringify(v)); } catch (e) { /* storage blocked */ }
}

/** A signed-in, non-anonymous Firebase user, or null. */
function _puzzleRatedUser(user) {
	return user && !user.isAnonymous ? user : null;
}

/**
 * The viewer's rating and attempted puzzle ids: { rating, plays, attempts,
 * signedIn }. `user` is the settled Firebase user (or null).
 */
async function loadPuzzleRating(user) {
	const u = _puzzleRatedUser(user);
	if (!u || typeof firebase === 'undefined') {
		const l = _puzzleLocal();
		return { rating: l.rating, plays: l.plays, attempts: l.attempts, signedIn: false };
	}
	const db = firebase.database();
	const [r, a] = await Promise.all([
		db.ref('users/' + u.uid + '/puzzle').once('value'),
		db.ref('users/' + u.uid + '/puzzleAttempts').once('value'),
	]);
	const v = r.val() || {};
	const attempts = {};
	a.forEach((c) => { attempts[c.key] = c.val(); });
	return {
		rating: typeof v.rating === 'number' ? v.rating : PUZZLE_RATING_START,
		plays: typeof v.plays === 'number' ? v.plays : 0,
		attempts,
		signedIn: true,
	};
}

/** The puzzle's current rating: the live one when it has been played, else the calibration. */
async function loadPuzzleCurrentRating(puzzle) {
	const base = { rating: Math.round(puzzle.rating || PUZZLE_RATING_START), plays: 0 };
	if (typeof firebase === 'undefined' || !navigator.onLine) return base;
	try {
		const v = (await firebase.database().ref('puzzle_ratings/' + puzzle.id).once('value')).val();
		if (v && typeof v.rating === 'number') return { rating: v.rating, plays: v.plays || 0 };
	} catch (e) { /* offline or blocked: use the calibration */ }
	return base;
}

/**
 * Record the first result on `puzzle` for this viewer and move both ratings.
 * Returns { before, after, delta, puzzleBefore, puzzleAfter } or null when the
 * puzzle was attempted before (only the first result counts).
 */
async function recordPuzzleResult(user, puzzle, solved) {
	const u = _puzzleRatedUser(user);
	if (!u || typeof firebase === 'undefined') {
		const l = _puzzleLocal();
		if (l.attempts[puzzle.id] !== undefined) return null;
		const p = { rating: Math.round(puzzle.rating || PUZZLE_RATING_START), plays: 0 };
		const up = puzzleRatingUpdate(l, p, solved);
		l.attempts[puzzle.id] = solved ? 1 : 0;
		l.rating = up.user.rating;
		l.plays = up.user.plays;
		_puzzleSaveLocal(l);
		return { before: up.user.rating - up.delta, after: up.user.rating, delta: up.delta,
			puzzleBefore: p.rating, puzzleAfter: p.rating, local: true };
	}
	const db = firebase.database();
	const base = 'users/' + u.uid;
	const prev = await db.ref(base + '/puzzleAttempts/' + puzzle.id).once('value');
	if (prev.exists()) return null;
	const me = (await db.ref(base + '/puzzle').once('value')).val() || {};
	const mine = { rating: typeof me.rating === 'number' ? me.rating : PUZZLE_RATING_START, plays: me.plays || 0 };
	const pz = await loadPuzzleCurrentRating(puzzle);
	const up = puzzleRatingUpdate(mine, pz, solved);
	const name = (await db.ref(base + '/displayName').once('value')).val() || u.displayName || 'Player';
	const write = {};
	write[base + '/puzzle'] = Object.assign({ last: puzzle.id }, up.user);
	write[base + '/puzzleAttempts/' + puzzle.id] = { solved: !!solved, at: firebase.database.ServerValue.TIMESTAMP, delta: up.delta };
	write['puzzle_ratings/' + puzzle.id] = up.puzzle;
	write['puzzle_leaderboard/' + u.uid] = { displayName: String(name).slice(0, 30), rating: up.user.rating, plays: up.user.plays };
	await db.ref().update(write);
	return { before: mine.rating, after: up.user.rating, delta: up.delta,
		puzzleBefore: pz.rating, puzzleAfter: up.puzzle.rating, local: false };
}

/**
 * The next puzzle for a rated session: an unattempted one whose (calibrated)
 * rating is close to the player's, picked at random among the closest few so
 * two visits do not always land on the same puzzle.
 */
function pickRatedPuzzle(pool, rating, attempts, solvedLocal) {
	const fresh = pool.filter(p => !(attempts && attempts[p.id] !== undefined) && !(solvedLocal && solvedLocal[p.id]));
	const from = fresh.length ? fresh : pool;
	const near = from.slice().sort((a, b) => Math.abs((a.rating || 1500) - rating) - Math.abs((b.rating || 1500) - rating));
	const k = Math.min(near.length, 20);
	return near[Math.floor(Math.random() * k)];
}
