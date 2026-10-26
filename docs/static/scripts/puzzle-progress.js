/**
 * Puzzle progress: this device's record, mirrored to the signed-in account so
 * it follows the player across devices. Offline first: localStorage is always
 * written; the account copy is merged on sign-in and written through after.
 *
 * localStorage (the device copy; signed-out use reads and writes only these):
 *   sigil_puzzles_solved   { <puzzle id>: ms }          ever solved (game-board-local.js)
 *   sigil_puzzle_results   { <puzzle id>: { r, at } }   the FIRST result per puzzle:
 *                          r = 's' solved | 'f' failed | 'v' revealed
 *   sigil_puzzle_daily     { done: { <UTC day>: 'solved'|'failed'|'revealed' },
 *                            streak, last, best }       (puzzles.html)
 *   sigil_puzzle_storm     { best, runs, history: [{ score, at }] }   Storm, signed out
 *   sigil_puzzle_progress_owner   the uid this device last synced with
 *
 * Account copy (database.rules.json validates every leaf):
 *   users/<uid>/puzzleProgress  { solved: { id: ms }, results: { id: { r, at } },
 *                                 daily: { day: status }, dailyBest }
 *   users/<uid>/puzzleStorm     { best, runs, last, at }   Puzzle Storm
 *   storm_leaderboard/<uid>     { displayName, score }    score = puzzleStorm/best
 *
 * Merging never clobbers: the union of both copies, the earliest solve and
 * the earliest first result per puzzle, the account's status on a day both
 * copies recorded, the larger best streak. Writes go to single leaves (one
 * multi-path update), never to a whole node, so two devices writing at once
 * both land. Puzzle ratings (puzzle-rating.js) are separate and untouched.
 */

const PUZZLE_PROGRESS_KEYS = {
	solved: 'sigil_puzzles_solved',
	results: 'sigil_puzzle_results',
	daily: 'sigil_puzzle_daily',
	storm: 'sigil_puzzle_storm',
	owner: 'sigil_puzzle_progress_owner',
};
const PUZZLE_RESULT_CODE = { solved: 's', failed: 'f', revealed: 'v' };
const PUZZLE_DAILY_KEEP = 60;

function _ppRead(key, fallback) {
	try {
		const v = JSON.parse(localStorage.getItem(key) || 'null');
		return v && typeof v === 'object' ? v : fallback;
	} catch (e) { return fallback; }
}
function _ppWrite(key, v) {
	try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage blocked */ }
}
/** Firebase keys may not hold . # $ [ ] / -- puzzle ids and days never do; anything else is skipped. */
function _ppKeyOk(k) {
	return typeof k === 'string' && k.length > 0 && k.length <= 64 && !/[.#$\[\]\/]/.test(k);
}

/** The device copy, as the account stores it. */
function readLocalPuzzleProgress() {
	const daily = _ppRead(PUZZLE_PROGRESS_KEYS.daily, {});
	return {
		solved: _ppRead(PUZZLE_PROGRESS_KEYS.solved, {}),
		results: _ppRead(PUZZLE_PROGRESS_KEYS.results, {}),
		daily: Object.assign({}, daily.done || {}),
		dailyBest: daily.best || 0,
	};
}

/** UTC day string `n` days before `day`. */
function _ppDayBefore(day, n) {
	return new Date(Date.parse(day + 'T00:00:00Z') - (n || 1) * 86400000).toISOString().slice(0, 10);
}

/**
 * The daily record recomputed from its per-day log: `last` is the latest
 * solved day and `streak` the run of consecutive solved days ending there (a
 * miss ends a streak, as recordDaily does). The best streak is the longest run
 * in the log, or the larger stored best.
 */
function puzzleDailyFromLog(done, bestBefore) {
	const days = Object.keys(done || {}).sort();
	const kept = {};
	for (const d of days.slice(Math.max(0, days.length - PUZZLE_DAILY_KEEP))) kept[d] = done[d];
	let best = bestBefore || 0, run = 0, prev = null, last = null, streak = 0;
	for (const d of Object.keys(kept).sort()) {
		if (kept[d] === 'solved') {
			run = (prev && prev === _ppDayBefore(d) && run > 0) ? run + 1 : 1;
			best = Math.max(best, run);
			last = d;
			streak = run;
		} else {
			run = 0;
		}
		prev = d;
	}
	// A miss after the last solve ended that streak.
	if (last && Object.keys(kept).some(d => d > last && kept[d] !== 'solved')) streak = 0;
	const out = { done: kept, streak, best };
	if (last) out.last = last;
	return out;
}

/** The union of two progress records (`a` wins a day both recorded). Pure. */
function mergePuzzleProgress(a, b) {
	a = a || {}; b = b || {};
	const out = { solved: {}, results: {}, daily: {}, dailyBest: Math.max(a.dailyBest || 0, b.dailyBest || 0) };
	for (const src of [a.solved || {}, b.solved || {}]) {
		for (const [id, t] of Object.entries(src)) {
			if (!_ppKeyOk(id) || typeof t !== 'number') continue;
			out.solved[id] = out.solved[id] === undefined ? t : Math.min(out.solved[id], t);
		}
	}
	for (const src of [a.results || {}, b.results || {}]) {
		for (const [id, v] of Object.entries(src)) {
			if (!_ppKeyOk(id) || !v || !['s', 'f', 'v'].includes(v.r) || typeof v.at !== 'number') continue;
			const cur = out.results[id];
			if (!cur || v.at < cur.at) out.results[id] = { r: v.r, at: v.at };
		}
	}
	for (const src of [b.daily || {}, a.daily || {}]) {
		for (const [d, s] of Object.entries(src)) {
			if (/^\d{4}-\d{2}-\d{2}$/.test(d) && ['solved', 'failed', 'revealed'].includes(s)) out.daily[d] = s;
		}
	}
	const days = Object.keys(out.daily).sort();
	for (const d of days.slice(0, Math.max(0, days.length - PUZZLE_DAILY_KEEP))) delete out.daily[d];
	return out;
}

/** Store a merged record as the device copy. */
function writeLocalPuzzleProgress(p) {
	_ppWrite(PUZZLE_PROGRESS_KEYS.solved, p.solved || {});
	_ppWrite(PUZZLE_PROGRESS_KEYS.results, p.results || {});
	_ppWrite(PUZZLE_PROGRESS_KEYS.daily, puzzleDailyFromLog(p.daily, p.dailyBest));
}

/** The leaves of `merged` the account copy `remote` lacks (or holds later), as update() paths. */
function puzzleProgressDiff(merged, remote, base) {
	remote = remote || {};
	const w = {};
	for (const [id, t] of Object.entries(merged.solved || {})) {
		if (!remote.solved || remote.solved[id] !== t) w[base + '/solved/' + id] = t;
	}
	for (const [id, v] of Object.entries(merged.results || {})) {
		const r = remote.results && remote.results[id];
		if (!r || r.r !== v.r || r.at !== v.at) w[base + '/results/' + id] = { r: v.r, at: v.at };
	}
	for (const [d, s] of Object.entries(merged.daily || {})) {
		if (!remote.daily || remote.daily[d] !== s) w[base + '/daily/' + d] = s;
	}
	const best = Math.max(merged.dailyBest || 0, puzzleDailyFromLog(merged.daily, 0).best);
	if (best > (remote.dailyBest || 0)) w[base + '/dailyBest'] = best;
	return w;
}

/** A signed-in, non-anonymous Firebase user, or null (as puzzle-rating.js). */
function _ppUser(user) {
	return user && !user.isAnonymous && typeof firebase !== 'undefined' ? user : null;
}

function _ppTimeout(promise, ms) {
	return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
}

/**
 * Merge this device with the account. Returns the merged record ({ synced })
 * or the device copy when signed out or offline. When the device last synced
 * with ANOTHER account, its copy belongs to that account: it is replaced by
 * this account's, not uploaded into it.
 */
async function syncPuzzleProgress(user) {
	const local = readLocalPuzzleProgress();
	const u = _ppUser(user);
	if (!u || (typeof navigator !== 'undefined' && navigator.onLine === false)) return Object.assign(local, { synced: false });
	let owner = null;
	try { owner = localStorage.getItem(PUZZLE_PROGRESS_KEYS.owner); } catch (e) { /* storage blocked */ }
	const base = 'users/' + u.uid + '/puzzleProgress';
	const db = firebase.database();
	let remote;
	try {
		remote = (await _ptOnce(db.ref(base))) || {};
	} catch (e) {
		return Object.assign(local, { synced: false });
	}
	const foreign = owner && owner !== u.uid;
	const merged = foreign ? mergePuzzleProgress(remote, {}) : mergePuzzleProgress(remote, local);
	writeLocalPuzzleProgress(merged);
	try { localStorage.setItem(PUZZLE_PROGRESS_KEYS.owner, u.uid); } catch (e) { /* storage blocked */ }
	const w = puzzleProgressDiff(merged, remote, base);
	if (Object.keys(w).length) {
		// Queued by the SDK when the connection drops; the next sync retries anyway.
		db.ref().update(w).catch((e) => console.warn('Puzzle progress not saved:', e && e.message));
	}
	return Object.assign(merged, { synced: true });
}

function _ptOnce(ref) {
	return _ppTimeout(ref.once('value').then(s => s.val()), 10000);
}

/**
 * Record one result on the device (the first result per puzzle; a solve also
 * lands in sigil_puzzles_solved, which the board writes too) and write it
 * through to the account. `daily`, when given, is { day, status, best } for
 * today's puzzle.
 */
function recordPuzzleProgress(user, puzzle, status, daily) {
	const code = PUZZLE_RESULT_CODE[status];
	if (!puzzle || !code) return;
	const now = Date.now();
	const results = _ppRead(PUZZLE_PROGRESS_KEYS.results, {});
	const leaves = {};
	if (!results[puzzle.id]) {
		results[puzzle.id] = { r: code, at: now };
		_ppWrite(PUZZLE_PROGRESS_KEYS.results, results);
		leaves['results/' + puzzle.id] = results[puzzle.id];
	}
	if (status === 'solved') {
		const solved = _ppRead(PUZZLE_PROGRESS_KEYS.solved, {});
		if (!solved[puzzle.id]) { solved[puzzle.id] = now; _ppWrite(PUZZLE_PROGRESS_KEYS.solved, solved); }
		leaves['solved/' + puzzle.id] = solved[puzzle.id];
	}
	if (daily && daily.day) {
		leaves['daily/' + daily.day] = daily.status;
		if (daily.best) leaves.dailyBest = daily.best;
	}
	const u = _ppUser(user);
	if (!u || !_ppKeyOk(puzzle.id)) return;
	let owner = null;
	try { owner = localStorage.getItem(PUZZLE_PROGRESS_KEYS.owner); } catch (e) { /* storage blocked */ }
	if (owner && owner !== u.uid) return;   // not merged with this account yet
	const base = 'users/' + u.uid + '/puzzleProgress/';
	const w = {};
	for (const [k, v] of Object.entries(leaves)) w[base + k] = v;
	if (Object.keys(w).length) firebase.database().ref().update(w).catch((e) => console.warn('Puzzle progress not saved:', e && e.message));
}

// ---------------------------------------------------------------------------
// Puzzle Storm. A run is solo and unrated: its puzzles never touch the puzzle
// ratings or the solved list. The best score is kept per account (and per
// device when signed out).
// ---------------------------------------------------------------------------

const STORM_MAX_SCORE = 300;    // database.rules.json allows 0..300

function readLocalStorm() {
	const v = _ppRead(PUZZLE_PROGRESS_KEYS.storm, {});
	return { best: v.best || 0, runs: v.runs || 0, history: Array.isArray(v.history) ? v.history : [] };
}

/** The best Storm score and run count: the account's when signed in, else this device's. */
async function loadStormRecord(user) {
	const local = readLocalStorm();
	const u = _ppUser(user);
	if (!u) return Object.assign(local, { signedIn: false });
	try {
		const v = (await _ptOnce(firebase.database().ref('users/' + u.uid + '/puzzleStorm'))) || {};
		return { best: v.best || 0, runs: v.runs || 0, history: local.history, signedIn: true };
	} catch (e) {
		return Object.assign(local, { signedIn: true, offline: true });
	}
}

/**
 * Record a finished run. Always logged on the device; signed in, it also
 * goes to users/<uid>/puzzleStorm and (on a new best) storm_leaderboard.
 * Returns { best, runs, newBest }.
 */
async function recordStormRun(user, score) {
	score = Math.max(0, Math.min(STORM_MAX_SCORE, Math.floor(score || 0)));
	const local = readLocalStorm();
	local.history = local.history.concat([{ score, at: Date.now() }]).slice(-50);
	const u = _ppUser(user);
	if (!u) {
		const newBest = score > local.best;
		local.best = Math.max(local.best, score);
		local.runs += 1;
		_ppWrite(PUZZLE_PROGRESS_KEYS.storm, local);
		return { best: local.best, runs: local.runs, newBest, signedIn: false };
	}
	_ppWrite(PUZZLE_PROGRESS_KEYS.storm, local);
	const db = firebase.database();
	const base = 'users/' + u.uid;
	const cur = (await _ptOnce(db.ref(base + '/puzzleStorm'))) || {};
	const prevBest = cur.best || 0;
	const rec = { best: Math.max(prevBest, score), runs: (cur.runs || 0) + 1, last: score, at: firebase.database.ServerValue.TIMESTAMP };
	const w = { [base + '/puzzleStorm']: rec };
	if (rec.best > prevBest) {
		const name = (await _ptOnce(db.ref(base + '/displayName'))) || u.displayName || 'Player';
		w['storm_leaderboard/' + u.uid] = { displayName: String(name).slice(0, 30), score: rec.best };
	}
	// Offline, the SDK keeps the write queued and the promise pending: report it as queued.
	const done = await Promise.race([db.ref().update(w).then(() => 'saved'), new Promise(r => setTimeout(() => r('queued'), 8000))]);
	return { best: rec.best, runs: rec.runs, newBest: score > prevBest, signedIn: true, queued: done === 'queued' };
}

/** Time control for a run: 3 minutes, -10 s a miss, combo bonuses (Lichess's 5/12/20/30). */
const STORM_START_MS = 180000;
const STORM_MISS_MS = 10000;
const STORM_COMBO_BONUS = [[5, 3000], [12, 5000], [20, 7000], [30, 10000]];
/** The time bonus earned by reaching combo `n`, or 0. Past 30, +10 s every 10. */
function stormComboBonus(n) {
	for (const [at, ms] of STORM_COMBO_BONUS) if (n === at) return ms;
	return n > 30 && n % 10 === 0 ? 10000 : 0;
}

/**
 * The run's k-th puzzle (0-based): starting easy and ramping by puzzle rating,
 * a random unused puzzle among the 12 nearest the target. Mate puzzles only:
 * a winning-turn judgement takes the engine seconds.
 */
function pickStormPuzzle(pool, k, used, rand) {
	rand = rand || Math.random;
	const ratings = pool.map(p => p.rating || 1500).sort((a, b) => a - b);
	const lo = ratings.length ? ratings[Math.floor(ratings.length * 0.02)] : 1000;
	const target = lo + 30 * k;
	const fresh = pool.filter(p => !(used && used[p.id]));
	const from = fresh.length ? fresh : pool;
	const near = from.slice().sort((a, b) => Math.abs((a.rating || 1500) - target) - Math.abs((b.rating || 1500) - target));
	return near[Math.floor(rand() * Math.min(near.length, 12))];
}
function stormPool(all) {
	return all.filter(p => p.kind !== 'winning' && p.mate >= 1);
}
