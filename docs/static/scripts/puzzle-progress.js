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

/**
 * Whether `next` should replace the stored leaf `cur` (keyed by the leaf's
 * path): the earliest solve and first result win, the stored day wins, the
 * larger best streak wins. The same order as mergePuzzleProgress.
 */
function _ppLeafWins(path, cur, next) {
	if (cur === null || cur === undefined) return true;
	if (/\/solved\/[^/]+$/.test(path)) return typeof cur !== 'number' || next < cur;
	if (/\/results\/[^/]+$/.test(path)) return !cur || typeof cur.at !== 'number' || next.at < cur.at;
	if (/\/dailyBest$/.test(path)) return typeof cur !== 'number' || next > cur;
	return false;   // a day already recorded on the account stays
}

/**
 * Write progress leaves. Each is a transaction that keeps the stored value
 * when it already wins (_ppLeafWins), so two devices racing on one puzzle
 * cannot replace an earlier first result with a later one.
 */
function _ppWriteLeaves(db, w) {
	return Promise.all(Object.entries(w).map(([path, val]) =>
		db.ref(path).transaction((cur) => (_ppLeafWins(path, cur, val) ? val : undefined), undefined, false)))
		.catch((e) => console.warn('Puzzle progress not saved:', e && e.message));
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
	const t0 = Date.now();
	let remote;
	try {
		remote = (await _ptOnce(db.ref(base))) || {};
	} catch (e) {
		return Object.assign(local, { synced: false });
	}
	const foreign = owner && owner !== u.uid;
	// Results recorded while the read was in flight are this account's (it
	// was signed in), whoever the device last synced with: keep them.
	const now = readLocalPuzzleProgress();
	const recent = { solved: {}, results: {}, daily: {} };
	for (const [id, t] of Object.entries(now.solved)) if (typeof t === 'number' && t >= t0) recent.solved[id] = t;
	for (const [id, v] of Object.entries(now.results)) if (v && typeof v.at === 'number' && v.at >= t0) recent.results[id] = v;
	const merged = foreign ? mergePuzzleProgress(remote, recent) : mergePuzzleProgress(remote, mergePuzzleProgress(local, now));
	writeLocalPuzzleProgress(merged);
	try { localStorage.setItem(PUZZLE_PROGRESS_KEYS.owner, u.uid); } catch (e) { /* storage blocked */ }
	const w = puzzleProgressDiff(merged, remote, base);
	if (Object.keys(w).length) {
		// Queued by the SDK when the connection drops; the next sync retries anyway.
		_ppWriteLeaves(db, w);
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
	const u = _ppUser(user);
	if (!u || !_ppKeyOk(puzzle.id)) return;
	let owner = null;
	try { owner = localStorage.getItem(PUZZLE_PROGRESS_KEYS.owner); } catch (e) { /* storage blocked */ }
	// This result is the signed-in player's even before the device has merged
	// with their account; the daily log may still be another account's.
	if (daily && daily.day && !(owner && owner !== u.uid)) {
		leaves['daily/' + daily.day] = daily.status;
		if (daily.best) leaves.dailyBest = daily.best;
	}
	const base = 'users/' + u.uid + '/puzzleProgress/';
	const w = {};
	for (const [k, v] of Object.entries(leaves)) w[base + k] = v;
	if (Object.keys(w).length) _ppWriteLeaves(firebase.database(), w);
}

// ---------------------------------------------------------------------------
// Puzzle Storm. A run is solo and unrated: its puzzles never touch the puzzle
// ratings or the solved list. The best score is kept per account (and per
// device when signed out).
// ---------------------------------------------------------------------------

const STORM_MAX_SCORE = 300;    // database.rules.json allows 0..300

function readLocalStorm() {
	const v = _ppRead(PUZZLE_PROGRESS_KEYS.storm, {});
	return { best: v.best || 0, runs: v.runs || 0, history: Array.isArray(v.history) ? v.history : [],
		pending: Array.isArray(v.pending) ? v.pending : [] };
}

/**
 * One run into users/<uid>/puzzleStorm, as a transaction: two runs finishing
 * at once (two tabs or devices) each count, since the rules want `runs`
 * exactly one past the stored value. (One page records one run at a time:
 * the SDK merges a client's own queued transactions on a path into a single
 * write.) Then storm_leaderboard on a new best. Returns { rec, prevBest }.
 */
async function _stormSave(u, score) {
	const db = firebase.database();
	const base = 'users/' + u.uid;
	let prevBest = 0;
	const res = await db.ref(base + '/puzzleStorm').transaction((cur) => {
		cur = cur || {};
		prevBest = cur.best || 0;
		return { best: Math.max(prevBest, score), runs: (cur.runs || 0) + 1, last: score, at: firebase.database.ServerValue.TIMESTAMP };
	});
	const rec = res.snapshot.val();
	if (res.committed && rec && rec.best > prevBest) {
		// The row must equal the stored best; a run finishing in between
		// may raise it again, so write what is stored now.
		const name = (await _ptOnce(db.ref(base + '/displayName'))) || u.displayName || 'Player';
		for (let k = 0; k < 3; k++) {
			const best = (await _ptOnce(db.ref(base + '/puzzleStorm/best'))) || 0;
			try {
				await db.ref('storm_leaderboard/' + u.uid).set({ displayName: String(name).slice(0, 30), score: best });
				break;
			} catch (e) { if (k === 2) throw e; }
		}
	}
	return { rec, prevBest };
}

/** Drop one pending run (by its `at`) from the device record. */
function _stormDone(at) {
	const l = readLocalStorm();
	l.pending = l.pending.filter(p => p.at !== at);
	_ppWrite(PUZZLE_PROGRESS_KEYS.storm, l);
}

/**
 * Send the runs this device finished for `user` but could not save (offline,
 * or the page closed first), oldest first. Returns how many were saved.
 */
async function flushStormPending(user) {
	const u = _ppUser(user);
	if (!u || (typeof navigator !== 'undefined' && navigator.onLine === false)) return 0;
	let n = 0;
	for (const p of readLocalStorm().pending.filter(x => x.uid === u.uid)) {
		const r = await Promise.race([_stormSave(u, p.score), new Promise(res => setTimeout(() => res(null), 10000))]);
		if (!r) break;
		_stormDone(p.at);
		n += 1;
	}
	return n;
}

/** The best Storm score and run count: the account's when signed in, else this device's. */
async function loadStormRecord(user) {
	const local = readLocalStorm();
	const u = _ppUser(user);
	if (!u) return Object.assign(local, { signedIn: false });
	try { await flushStormPending(u); } catch (e) { /* kept for the next visit */ }
	const pending = readLocalStorm().pending.filter(p => p.uid === u.uid);
	const pendingBest = Math.max(0, ...pending.map(p => p.score));
	try {
		const v = (await _ptOnce(firebase.database().ref('users/' + u.uid + '/puzzleStorm'))) || {};
		return { best: Math.max(v.best || 0, pendingBest), runs: (v.runs || 0) + pending.length, history: local.history, signedIn: true, pending: pending.length };
	} catch (e) {
		return Object.assign(local, { best: Math.max(local.best, pendingBest), signedIn: true, offline: true, pending: pending.length });
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
	// The run is on the device first, as pending: if the save below never
	// lands (offline, the page closes), the next Storm or dashboard visit
	// sends it (flushStormPending).
	const at = Date.now();
	const deviceBest = local.best;
	local.best = Math.max(local.best, score);
	local.runs += 1;
	local.pending = local.pending.concat([{ uid: u.uid, score, at }]).slice(-50);
	_ppWrite(PUZZLE_PROGRESS_KEYS.storm, local);
	const saving = _stormSave(u, score);
	// A save that lands after the timeout still clears its pending entry.
	saving.then((r) => { if (r && r.rec) _stormDone(at); }, () => {});
	const saved = await Promise.race([saving, new Promise(r => setTimeout(() => r(null), 10000))]);
	if (!saved || !saved.rec) {
		return { best: Math.max(score, deviceBest), runs: null, newBest: score > deviceBest, signedIn: true, queued: true };
	}
	_stormDone(at);
	return { best: saved.rec.best, runs: saved.rec.runs, newBest: score > saved.prevBest, signedIn: true, queued: false };
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
