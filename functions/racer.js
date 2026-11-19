'use strict';
/**
 * Puzzle Racer: the server side (index.js puzzleRace and sweepPuzzleRaces).
 *
 * 2 to 10 players race through the SAME puzzles for RACE_MS: the race's
 * host opens it (a public lobby, or a private link), the others join, the
 * host starts it. Everything that decides a race happens here, with admin
 * rights, never in a client:
 *   - who is in it (join, leave, at most RACE_MAX_PLAYERS) and the names
 *     shown (the account's name, or "Guest XXXX");
 *   - the puzzle sequence, picked from the Puzzles set with Puzzle Storm's
 *     ramp (pickStormPuzzle in docs/static/scripts/puzzle-progress.js), and
 *     the start time, a countdown after the start call, by this clock.
 * The sequence is kept at puzzle_race_seq/{id}, which the rules let nobody
 * read before startAt. A racer's only writes are their own progress,
 * players/{uid}/p = { n, score, at, st }: one more puzzle a write, the score
 * up by at most one, between startAt and endAt (+3 s for the last write in
 * flight), by the server's clock (database.rules.json).
 *
 *   puzzle_races/{id}        { host, public, status: 'lobby' | 'racing' | 'closed',
 *                              createdAt, startAt, endAt, len, max, next,
 *                              players: { uid: { name, guest, joinedAt, gone, p } } }
 *   puzzle_race_seq/{id}     [puzzle id, ...]
 *   puzzle_race_lobby/{id}   { hostName, n, max, createdAt }   public lobbies
 *   puzzle_race_hosts/{uid}  the race id of the host's last race (one open lobby each)
 *
 * A race is over when the server's clock passes endAt; nothing is written
 * then. sweepRaces deletes lobbies nobody started, lobbies everyone left,
 * and finished races after RACE_KEEP_MS (their results and rematch link
 * stay readable until then).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The emulator tests may shorten the race and pick from their own pool
// (SIGIL_RACER_MS, SIGIL_RACER_COUNTDOWN_MS, SIGIL_RACER_POOL).
const EMULATOR = process.env.FUNCTIONS_EMULATOR === 'true';
const emulated = (name, value) => (EMULATOR && Number(process.env[name]) > 0 ? Number(process.env[name]) : value);

const RACE_MAX_PLAYERS = 10;
const RACE_MIN_PLAYERS = 2;
const RACE_PUZZLES = 60;               // more than anyone solves in RACE_MS
const RACE_COUNTDOWN_MS = emulated('SIGIL_RACER_COUNTDOWN_MS', 10000);   // from the start call to the first puzzle
const RACE_MS = emulated('SIGIL_RACER_MS', 120000);                     // the race itself
const RACE_LOBBY_TTL_MS = 30 * 60000;  // a lobby nobody starts
const RACE_KEEP_MS = 2 * 3600000;      // a finished race (results, rematch link)
const RACE_SWEEP_MIN_AGE_MS = 2 * 60000;   // a lobby everyone left (a reload is not leaving)

class RaceError extends Error {
	constructor(code) { super(code); this.raceError = code; }
}

// ---------------------------------------------------------------------------
// The puzzle sequence
// ---------------------------------------------------------------------------

/** Puzzle Storm's pool (stormPool): mate puzzles only, as { id, rating }. */
function poolFromSet(puzzles) {
	return (puzzles || []).filter((p) => p && typeof p.id === 'string' && p.kind !== 'winning' && p.mate >= 1)
		.map((p) => ({ id: p.id, rating: p.rating || 1500 }));
}

let _pool = null;
/**
 * The pool, from functions/data/racer-pool.json (written by copy-engine.js
 * at deploy) or, in tests and the emulators, from the site's puzzle set.
 */
function racePool() {
	if (_pool) return _pool;
	const copied = path.join(__dirname, 'data', 'racer-pool.json');
	if (EMULATOR && process.env.SIGIL_RACER_POOL) {
		_pool = JSON.parse(fs.readFileSync(process.env.SIGIL_RACER_POOL, 'utf8'));
	} else if (fs.existsSync(copied)) {
		_pool = JSON.parse(fs.readFileSync(copied, 'utf8'));
	} else {
		const set = path.resolve(__dirname, '..', 'docs', 'static', 'puzzles', 'mate_puzzles.json');
		_pool = poolFromSet(JSON.parse(fs.readFileSync(set, 'utf8')).puzzles);
	}
	return _pool;
}

/**
 * `n` distinct puzzle ids, starting easy and ramping by rating: the k-th is
 * a random unused puzzle among the 12 nearest lo + 30k, lo being the 2nd
 * percentile rating. The same ramp as Puzzle Storm's pickStormPuzzle
 * (test/racer.test.js checks they pick alike).
 */
function pickRaceSequence(pool, n, rand) {
	rand = rand || secureRandom;
	const ratings = pool.map((p) => p.rating || 1500).sort((a, b) => a - b);
	const lo = ratings.length ? ratings[Math.floor(ratings.length * 0.02)] : 1000;
	const used = {};
	const out = [];
	for (let k = 0; k < n && out.length < pool.length; k++) {
		const target = lo + 30 * k;
		const fresh = pool.filter((p) => !used[p.id]);
		const near = fresh.slice().sort((a, b) => Math.abs((a.rating || 1500) - target) - Math.abs((b.rating || 1500) - target));
		const p = near[Math.floor(rand() * Math.min(near.length, 12))];
		used[p.id] = 1;
		out.push(p.id);
	}
	return out;
}

function secureRandom() {
	return crypto.randomInt(0, 2 ** 32) / 2 ** 32;
}

/** A race id: 12 URL-safe characters (72 random bits), a valid database key. */
function newRaceId() {
	return crypto.randomBytes(9).toString('base64url');
}

// ---------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

/** The name a racer is shown by: the account's, or "Guest" and four characters of the uid. */
async function racerName(db, uid, guest) {
	if (guest) return 'Guest ' + uid.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase();
	const v = (await db.ref('users/' + uid + '/displayName').once('value')).val();
	return typeof v === 'string' && v.trim() ? v.trim().slice(0, 30) : 'Player';
}

/** Players who have not left (a closed tab sets `gone` through onDisconnect). */
function presentPlayers(race) {
	return Object.entries((race && race.players) || {}).filter(([, p]) => p && p.name && p.gone !== true);
}

function lobbyEntry(race) {
	const host = race.players && race.players[race.host];
	return { hostName: (host && host.name) || 'Player', n: presentPlayers(race).length, max: race.max || RACE_MAX_PLAYERS, createdAt: race.createdAt };
}

/** The race as a transaction sees it: null on its first (cache) run. */
async function raceTransaction(db, id, fn) {
	const res = await db.ref('puzzle_races/' + id).transaction((race) => (race === null ? null : fn(race)));
	return { committed: res.committed, race: res.snapshot.val() };
}

/**
 * Open a race hosted by `me` ({ uid, name, guest }). The host's earlier race
 * still in its lobby is closed first: one open lobby a host.
 */
async function createRace(db, me, opts, now) {
	const pub = !!(opts && opts.public);
	const prev = (await db.ref('puzzle_race_hosts/' + me.uid).once('value')).val();
	if (typeof prev === 'string' && ID_RE.test(prev)) await closeLobby(db, prev, me.uid);
	const id = (opts && opts.id) || newRaceId();
	const race = {
		host: me.uid, public: pub, status: 'lobby', createdAt: now, max: RACE_MAX_PLAYERS,
		players: { [me.uid]: { name: me.name, guest: !!me.guest, joinedAt: now } },
	};
	const updates = { ['puzzle_races/' + id]: race, ['puzzle_race_hosts/' + me.uid]: id };
	if (pub) updates['puzzle_race_lobby/' + id] = lobbyEntry(race);
	await db.ref().update(updates);
	return { id };
}

/** Close a lobby the host has left behind (createRace). */
async function closeLobby(db, id, uid) {
	const { race } = await raceTransaction(db, id, (r) => {
		if (r.status !== 'lobby' || r.host !== uid) return undefined;
		r.status = 'closed';
		return r;
	});
	if (race && race.status === 'closed') await db.ref('puzzle_race_lobby/' + id).remove();
}

async function joinRace(db, id, me, now) {
	let why = null;
	const { committed, race } = await raceTransaction(db, id, (r) => {
		why = null;
		const players = r.players || {};
		if (r.status !== 'lobby') { why = r.status === 'racing' ? 'started' : 'closed'; return undefined; }
		if (players[me.uid] && players[me.uid].gone !== true) return undefined;   // already in
		if (presentPlayers(r).filter(([uid]) => uid !== me.uid).length >= (r.max || RACE_MAX_PLAYERS)) { why = 'full'; return undefined; }
		// Players who left give up their seats (a reload rejoins).
		for (const [uid, p] of Object.entries(players)) {
			if (p.gone === true && uid !== r.host && uid !== me.uid) delete players[uid];
		}
		players[me.uid] = { name: me.name, guest: !!me.guest, joinedAt: now };
		r.players = players;
		return r;
	});
	if (!race) throw new RaceError('not-found');
	if (why) throw new RaceError(why);
	if (committed && race.public && race.status === 'lobby') await db.ref('puzzle_race_lobby/' + id).set(lobbyEntry(race));
	return { id };
}

/** Leave a race still in its lobby; the earliest to join takes over as host. */
async function leaveRace(db, id, uid) {
	let why = null;
	const { race } = await raceTransaction(db, id, (r) => {
		why = null;
		if (r.status !== 'lobby') { why = r.status === 'racing' ? 'started' : 'closed'; return undefined; }
		if (!r.players || !r.players[uid]) return undefined;
		delete r.players[uid];
		if (r.host === uid) {
			const next = presentPlayers(r).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))[0];
			if (next) r.host = next[0];
			else r.status = 'closed';
		}
		return r;
	});
	if (!race) throw new RaceError('not-found');
	if (why) throw new RaceError(why);
	if (race.public) {
		if (race.status === 'lobby') await db.ref('puzzle_race_lobby/' + id).set(lobbyEntry(race));
		else await db.ref('puzzle_race_lobby/' + id).remove();
	}
	return { id };
}

/**
 * Start a race: the host, or any racer once the host has left, with at
 * least RACE_MIN_PLAYERS present. Players who left are dropped; the rest
 * get their progress (0 of len) and the clock starts RACE_COUNTDOWN_MS on.
 */
async function startRace(db, id, uid, now, pick) {
	const seq = (pick || ((n) => pickRaceSequence(racePool(), n)))(RACE_PUZZLES);
	if (!Array.isArray(seq) || !seq.length) throw new RaceError('no-puzzles');
	let why = null;
	const startAt = now + RACE_COUNTDOWN_MS;
	const { committed, race } = await raceTransaction(db, id, (r) => {
		why = null;
		if (r.status !== 'lobby') { why = r.status === 'racing' ? 'started' : 'closed'; return undefined; }
		const players = r.players || {};
		const me = players[uid];
		if (!me || me.gone === true) { why = 'not-a-racer'; return undefined; }
		const host = players[r.host];
		if (r.host !== uid && host && host.gone !== true) { why = 'not-host'; return undefined; }
		// The first RACE_MAX_PLAYERS to join (a player who left and came
		// back to a full lobby, through `gone`, waits for the next race).
		const present = presentPlayers(r).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0)).slice(0, r.max || RACE_MAX_PLAYERS);
		if (present.length < RACE_MIN_PLAYERS) { why = 'too-few'; return undefined; }
		r.players = {};
		for (const [k, p] of present) {
			r.players[k] = Object.assign({}, p, { gone: false, p: { n: 0, score: 0, at: 0, st: 0 } });
		}
		r.host = uid;
		r.status = 'racing';
		r.startAt = startAt;
		r.endAt = startAt + RACE_MS;
		r.len = seq.length;
		return r;
	});
	if (!race) throw new RaceError('not-found');
	if (!committed || race.startAt !== startAt) throw new RaceError(why || 'started');
	// Only the start that won writes the sequence, well inside the
	// countdown: the rules hide it until startAt.
	await db.ref().update({ ['puzzle_race_seq/' + id]: seq, ['puzzle_race_lobby/' + id]: null });
	return { id, startAt: race.startAt, endAt: race.endAt };
}

/**
 * A new race for the players of a finished one: the first racer to ask
 * opens it (hosting it, with the old race's visibility) and links it from
 * the old race's `next`; everyone after joins it.
 */
async function rematchRace(db, id, me, now, newId) {
	const old = (await db.ref('puzzle_races/' + id).once('value')).val();
	if (!old) throw new RaceError('not-found');
	if (!old.players || !old.players[me.uid]) throw new RaceError('not-a-racer');
	if (old.status !== 'racing' || !(now >= old.endAt)) throw new RaceError('not-finished');
	if (typeof old.next === 'string') return joinRace(db, old.next, me, now);
	const created = await createRace(db, me, { public: !!old.public, id: newId || newRaceId() }, now);
	const res = await db.ref('puzzle_races/' + id + '/next').transaction((cur) => (cur === null ? created.id : undefined));
	const next = res.snapshot.val();
	if (res.committed && next === created.id) return created;
	// Another racer's rematch won: drop this one, join theirs.
	await db.ref().update({ ['puzzle_races/' + created.id]: null, ['puzzle_race_lobby/' + created.id]: null, ['puzzle_race_hosts/' + me.uid]: null });
	return joinRace(db, next, me, now);
}

/** The callable: { action: 'create' | 'join' | 'leave' | 'start' | 'rematch', id?, public? }. */
async function handle(db, data, caller, now) {
	const action = data && data.action;
	const id = data && data.id;
	if (action !== 'create' && !(typeof id === 'string' && ID_RE.test(id))) throw new RaceError('bad-request');
	const me = async () => ({ uid: caller.uid, guest: !!caller.guest, name: await racerName(db, caller.uid, !!caller.guest) });
	switch (action) {
		case 'create': return createRace(db, await me(), { public: data.public === true }, now);
		case 'join': return joinRace(db, id, await me(), now);
		case 'leave': return leaveRace(db, id, caller.uid);
		case 'start': return startRace(db, id, caller.uid, now);
		case 'rematch': return rematchRace(db, id, await me(), now);
		default: throw new RaceError('bad-request');
	}
}

/**
 * Delete what is done with: lobbies older than RACE_LOBBY_TTL_MS or that
 * everyone has left (after RACE_SWEEP_MIN_AGE_MS), closed races, races
 * finished more than RACE_KEEP_MS ago, and anything left half-written (a
 * player's onDisconnect landing after the race was deleted). Public lobby
 * entries are dropped with their race, and refreshed (who is still there)
 * when it stays. Resolves to the number of races deleted.
 */
async function sweepRaces(db, now) {
	const snap = await db.ref('puzzle_races').orderByChild('createdAt').endAt(now - RACE_SWEEP_MIN_AGE_MS).limitToFirst(500).once('value');
	const updates = {};
	const kept = {};
	const dropped = [];
	snap.forEach((c) => {
		const r = c.val() || {};
		let drop;
		if (typeof r.createdAt !== 'number' || r.status === 'closed') drop = true;
		else if (r.status === 'lobby') drop = now - r.createdAt > RACE_LOBBY_TTL_MS || presentPlayers(r).length === 0;
		else if (r.status === 'racing') drop = !(typeof r.endAt === 'number' && now - r.endAt <= RACE_KEEP_MS);
		else drop = true;
		if (!drop) { kept[c.key] = r; return; }
		dropped.push([c.key, r.host]);
		updates['puzzle_races/' + c.key] = null;
		updates['puzzle_race_seq/' + c.key] = null;
		updates['puzzle_race_lobby/' + c.key] = null;
	});
	// A host's index entry goes with the race it points at.
	for (const [id, host] of dropped) {
		if (typeof host !== 'string' || !host) continue;
		if ((await db.ref('puzzle_race_hosts/' + host).once('value')).val() === id) updates['puzzle_race_hosts/' + host] = null;
	}
	// Lobby entries: gone with their race, or refreshed.
	const lobby = (await db.ref('puzzle_race_lobby').once('value')).val() || {};
	for (const id of Object.keys(lobby)) {
		if (updates['puzzle_race_lobby/' + id] === null) continue;
		const r = kept[id] || (await db.ref('puzzle_races/' + id).once('value')).val();
		if (!r || r.status !== 'lobby' || !r.public) updates['puzzle_race_lobby/' + id] = null;
		else if (lobby[id].n !== presentPlayers(r).length) updates['puzzle_race_lobby/' + id + '/n'] = presentPlayers(r).length;
	}
	if (Object.keys(updates).length) await db.ref().update(updates);
	return dropped.length;
}

module.exports = {
	RACE_MAX_PLAYERS, RACE_MIN_PLAYERS, RACE_PUZZLES, RACE_COUNTDOWN_MS, RACE_MS, RACE_LOBBY_TTL_MS, RACE_KEEP_MS, RACE_SWEEP_MIN_AGE_MS,
	RaceError, poolFromSet, racePool, pickRaceSequence, newRaceId, racerName, presentPlayers,
	createRace, joinRace, leaveRace, startRace, rematchRace, handle, sweepRaces,
};
