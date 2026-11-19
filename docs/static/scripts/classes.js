/**
 * Classes (classes.html): a teacher makes a class, students join it with
 * its code, the teacher sets assignments (puzzles, a study, a page of the
 * site such as a tutorial lesson or a drill) and follows each student.
 *
 * What the teacher sees of a student is what the student's own records
 * already show on their public profile (users/{uid}: rating, games, puzzle
 * rating and results; user_games/{uid}), now gathered in one table, plus
 * the assignments they marked done. Joining is the consent: the join page
 * says so, and leaving ends it. Students never see each other: the rules
 * (database.rules.json) let a student read the class, its assignments and
 * their own entries only.
 *
 * Database:
 *   classes/{cid}/info              { name, teacher, teacherName, created }   teacher + students
 *   classes/{cid}/code              the join code                            teacher only
 *   classes/{cid}/members/{uid}     { name, joined, code }                   teacher; the student their own
 *   classes/{cid}/assignments/{aid} { kind: 'puzzles' | 'study' | 'link', title, note, due,
 *                                     puzzles: { <puzzle id>: order }, study, url, created }
 *   classes/{cid}/done/{aid}/{uid}  when the student marked it done          teacher; the student their own
 *   class_codes/{code}              { cid, name, teacherName }               anyone signed in, by code
 *   user_classes/{uid}/{cid}        { name, role: 'teacher' | 'student', at }  the player's list
 */

const CLASS_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CLASS_RECENT_DAYS = 30;
const CLASS_MAX_PUZZLES = 50;
const CLASS_PUZZLE_SETS = { m1: 'Mate in 1', m2: 'Mate in 2', m3: 'Mate in 3', win: 'Winning turn' };

function classTs() {
	return firebase.database.ServerValue.TIMESTAMP;
}

function classNewCode() {
	const a = new Uint8Array(6);
	crypto.getRandomValues(a);
	return Array.from(a, (b) => CLASS_CODE_CHARS[b % CLASS_CODE_CHARS.length]).join('');
}

/** Puzzle ids from pasted text: bare ids or puzzles.html?id=... links. */
function classParsePuzzleIds(text) {
	const out = [];
	for (const tok of String(text || '').split(/[\s,;]+/)) {
		if (!tok) continue;
		let id = tok;
		const m = tok.match(/[?&]id=([^&#\s]+)/);
		if (m) {
			try { id = decodeURIComponent(m[1]); } catch (e) { id = m[1]; }
		}
		if (/^[A-Za-z0-9_-]{1,64}$/.test(id) && out.indexOf(id) === -1) out.push(id);
	}
	return out;
}

/** A study id from a study link or a bare id. */
function classParseStudy(text) {
	const t = String(text || '').trim();
	const m = t.match(/[?&]study=([^&#\s]+)/);
	const id = m ? m[1] : t;
	return /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : '';
}

/** A page of this site, as an assignment link: 'tutorial.html?lesson=3'. */
function classParseLink(text) {
	let t = String(text || '').trim();
	try {
		const u = new URL(t, window.location.href);
		if (u.origin === window.location.origin) t = u.pathname.split('/').pop() + u.search + u.hash;
	} catch (e) { /* as typed */ }
	return /^[a-z0-9_-]+\.html([?#][-a-zA-Z0-9_=&%.,:;+~!*()/?#]*)?$/.test(t) && t.length <= 300 ? t : '';
}

/** `n` puzzles at random from the set's pool (set, difficulty filters). */
function classPickPuzzles(all, set, difficulty, n) {
	const pool = all.filter((p) => (!set || (p.kind === 'winning' ? 'win' : 'm' + p.mate) === set)
		&& (!difficulty || Number(p.difficulty) === Number(difficulty)));
	const out = [];
	const used = new Set();
	while (out.length < Math.min(n, pool.length)) {
		const p = pool[Math.floor(Math.random() * pool.length)];
		if (used.has(p.id)) continue;
		used.add(p.id);
		out.push(p.id);
	}
	return out;
}

/**
 * One student's progress on one assignment, from what the teacher can
 * read: { done, text }. Puzzles count as solved when the student's puzzle
 * record has solved them (any attempt); the first-try results are counted
 * apart. Studies and pages count when the student marked them done.
 */
function classAssignmentStatus(a, progress, doneAt) {
	if (a.kind === 'puzzles') {
		const ids = Object.keys(a.puzzles || {});
		const solved = (progress && progress.solved) || {};
		const results = (progress && progress.results) || {};
		const n = ids.filter((id) => solved[id]).length;
		const first = ids.filter((id) => results[id] && results[id].r === 's').length;
		return { done: n === ids.length && ids.length > 0, solved: n, first, total: ids.length, text: n + '/' + ids.length };
	}
	return { done: !!doneAt, text: doneAt ? 'Done' : '—', at: doneAt || null };
}

/** The ids of an assignment's puzzles, in the teacher's order. */
function classPuzzleOrder(a) {
	const p = a.puzzles || {};
	return Object.keys(p).sort((x, y) => (p[x] - p[y]) || (x < y ? -1 : 1));
}

if (typeof module !== 'undefined' && module.exports) {
	module.exports = { classParsePuzzleIds, classParseStudy, classAssignmentStatus, classPuzzleOrder, classPickPuzzles };
}
