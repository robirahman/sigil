/**
 * Node trainer (nodes.html): timed rounds on the board's node names, like a
 * chess site's coordinate trainer. Two modes:
 *   find   a node name is shown; click that node
 *   name   a node is ringed; give its name (zone letter + number)
 * A round lasts NODE_TRAINER_ROUND_MS; the score is the number of right
 * answers (a wrong one scores nothing and moves on).
 *
 * Best scores, offline first like Puzzle Storm (puzzle-progress.js):
 *   localStorage sigil_node_trainer   { find: { best, runs, history: [{ score, at }] },
 *                                       name: { ... }, pending: [{ uid, mode, score, at }] }
 *   users/<uid>/nodeTrainer/<mode>    { best, runs, last, at }   signed-in accounts
 *                                     (not anonymous guests); database.rules.json
 *                                     holds `runs` to one more per write and `best`
 *                                     to the larger of the old best and `last`.
 * A round finished while signed in is queued on the device first and sent as a
 * transaction, so a round that cannot be saved (offline, the tab closed) is
 * sent on the next visit.
 */

const NODE_TRAINER_MODES = ['find', 'name'];
const NODE_TRAINER_ROUND_MS = 30000;
const NODE_TRAINER_MAX_SCORE = 200;   // database.rules.json allows 0..200
const NODE_TRAINER_KEY = 'sigil_node_trainer';
const NODE_TRAINER_ZONES = ['a', 'b', 'c'];

/** The 39 node names of the core board, in board order. */
function nodeTrainerNodes() {
	const out = [];
	for (const z of NODE_TRAINER_ZONES) for (let k = 1; k <= 13; k++) out.push(z + k);
	return out;
}

/** A random node, never `prev` twice running. */
function nodeTrainerPick(prev, rand) {
	rand = rand || Math.random;
	const nodes = nodeTrainerNodes().filter(n => n !== prev);
	return nodes[Math.floor(rand() * nodes.length)];
}

/** A typed answer as a node name ('B 12' -> 'b12'), or null. */
function nodeTrainerParse(text) {
	const t = String(text || '').toLowerCase().replace(/\s+/g, '');
	return /^[abc](1[0-3]|[1-9])$/.test(t) ? t : null;
}

/** What a node is, for the feedback line: "the charm of zone c". */
function nodeTrainerRole(node) {
	const m = /^([abc])(\d+)$/.exec(node || '');
	if (!m) return '';
	const k = parseInt(m[2], 10);
	const zone = 'zone ' + m[1];
	if (k === 1) return node === 'a1' ? 'the mana node where Red starts' : node === 'b1' ? 'the mana node where Blue starts' : 'the mana node at the top of the board';
	if (k <= 6) return 'node ' + (k - 1) + ' of the five-node sigil of ' + zone;
	if (k === 7) return 'the charm of ' + zone;
	if (k <= 10) return 'node ' + (k - 7) + ' of the three-node sigil of ' + zone;
	return 'a void node of ' + zone;
}

function _ntRead() {
	try {
		const v = JSON.parse(localStorage.getItem(NODE_TRAINER_KEY) || 'null');
		return v && typeof v === 'object' ? v : {};
	} catch (e) { return {}; }
}
function _ntWrite(v) {
	try { localStorage.setItem(NODE_TRAINER_KEY, JSON.stringify(v)); } catch (e) { /* storage blocked */ }
}
function _ntMode(rec, mode) {
	const m = rec[mode] || {};
	return { best: m.best || 0, runs: m.runs || 0, history: Array.isArray(m.history) ? m.history : [] };
}

/** This device's record: { find: { best, runs, history }, name: { ... }, pending }. */
function readNodeTrainerLocal() {
	const rec = _ntRead();
	const out = { pending: Array.isArray(rec.pending) ? rec.pending : [] };
	for (const m of NODE_TRAINER_MODES) out[m] = _ntMode(rec, m);
	return out;
}

/** A signed-in account (not an anonymous guest), or null. */
function _ntUser(user) {
	return user && !user.isAnonymous && typeof firebase !== 'undefined' ? user : null;
}

function _ntTimeout(promise, ms) {
	return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
}

/** One round into users/<uid>/nodeTrainer/<mode>, as a transaction. */
async function _ntSave(u, mode, score, at) {
	const ref = firebase.database().ref('users/' + u.uid + '/nodeTrainer/' + mode);
	let prevBest = 0;
	const res = await ref.transaction((cur) => {
		cur = cur || {};
		prevBest = cur.best || 0;
		return { best: Math.max(prevBest, score), runs: (cur.runs || 0) + 1, last: score, at: firebase.database.ServerValue.TIMESTAMP };
	});
	if (res.committed && at !== undefined) {
		const l = readNodeTrainerLocal();
		_ntWrite(Object.assign(_ntRead(), { pending: l.pending.filter(p => p.at !== at) }));
	}
	return { rec: res.committed ? res.snapshot.val() : null, prevBest };
}

/** Send the rounds this device finished for `user` but could not save. */
async function flushNodeTrainerPending(user) {
	const u = _ntUser(user);
	if (!u || (typeof navigator !== 'undefined' && navigator.onLine === false)) return 0;
	let n = 0;
	for (const p of readNodeTrainerLocal().pending.filter(x => x.uid === u.uid)) {
		const r = await Promise.race([_ntSave(u, p.mode, p.score, p.at), new Promise(res => setTimeout(() => res(null), 10000))]);
		if (!r || !r.rec) break;
		n += 1;
	}
	return n;
}

/**
 * The best scores: the account's when signed in (with this device's unsent
 * rounds), else this device's. { find: { best, runs }, name: { ... }, signedIn }.
 */
async function loadNodeTrainerRecord(user) {
	const local = readNodeTrainerLocal();
	const u = _ntUser(user);
	if (!u) {
		return { find: local.find, name: local.name, signedIn: false };
	}
	try { await flushNodeTrainerPending(u); } catch (e) { /* kept for the next visit */ }
	const pending = readNodeTrainerLocal().pending.filter(p => p.uid === u.uid);
	const out = { signedIn: true };
	let remote = null;
	try {
		remote = (await _ntTimeout(firebase.database().ref('users/' + u.uid + '/nodeTrainer').once('value'), 10000)).val() || {};
	} catch (e) { out.offline = true; }
	for (const m of NODE_TRAINER_MODES) {
		const mine = pending.filter(p => p.mode === m);
		const r = (remote && remote[m]) || {};
		out[m] = {
			best: Math.max(r.best || 0, ...mine.map(p => p.score), out.offline ? local[m].best : 0),
			runs: (r.runs || 0) + mine.length,
			history: local[m].history,
		};
	}
	return out;
}

/**
 * Record a finished round. Always kept on the device; signed in, it also goes
 * to the account. Returns { best, runs, newBest, signedIn, queued }.
 */
async function recordNodeTrainerRound(user, mode, score) {
	if (!NODE_TRAINER_MODES.includes(mode)) throw new Error('unknown mode ' + mode);
	score = Math.max(0, Math.min(NODE_TRAINER_MAX_SCORE, Math.floor(score || 0)));
	const rec = _ntRead();
	const m = _ntMode(rec, mode);
	const at = Date.now();
	const deviceBest = m.best;
	m.best = Math.max(m.best, score);
	m.runs += 1;
	m.history = m.history.concat([{ score, at }]).slice(-20);
	rec[mode] = m;
	const u = _ntUser(user);
	if (!u) {
		_ntWrite(rec);
		return { best: m.best, runs: m.runs, newBest: score > deviceBest, signedIn: false };
	}
	rec.pending = (Array.isArray(rec.pending) ? rec.pending : []).concat([{ uid: u.uid, mode, score, at }]).slice(-50);
	_ntWrite(rec);
	let saved = null;
	try {
		saved = await Promise.race([_ntSave(u, mode, score, at), new Promise(r => setTimeout(() => r(null), 10000))]);
	} catch (e) { saved = null; }
	if (!saved || !saved.rec) {
		return { best: Math.max(score, deviceBest), runs: null, newBest: score > deviceBest, signedIn: true, queued: true };
	}
	return { best: saved.rec.best, runs: saved.rec.runs, newBest: score > saved.prevBest, signedIn: true, queued: false };
}
