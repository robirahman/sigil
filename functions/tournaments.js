'use strict';
/**
 * Tournaments (tournaments.html, tournament.html): arenas, Swiss events and
 * simultaneous exhibitions.
 *
 * Everything that decides an event happens here, on the server: who plays
 * whom and with which colour, the scores, the rounds, the start and the end.
 * The clients only ask (index.js `tournament` callable) and play their games
 * in ordinary rooms this module creates (status 'playing', both seats
 * filled), so the clocks (room-clock.js), the result checks and the rating
 * (rating.js, index.js recordRoom / rateGame), the records and the reviews
 * work exactly as in any online game. A room's `tournament` field ties it to
 * its event; the rules keep clients from writing it.
 *
 * Database (database.rules.json: all server-only, except a player's own
 * presence):
 *   tournaments/{tid}               the event: kind, settings, status, round
 *   tournament_index/{tid}          the public list (private events are not in it)
 *   tournament_players/{tid}/{uid}  each player's standing and pairing state
 *   tournament_pairings/{tid}/{pid} each game (or bye) and its result
 *   tournament_active/{tid}         events not over yet (tick's work list)
 *   tournament_locks/{tid}          one writer per event at a time (withLock)
 *   tournament_presence/{tid}/{uid}/{conn}  players with the event's page open
 *   tournament_limits/{uid}/{tid}   the events a player created that are not over
 *   user_tournaments/{uid}/{tid}    the events a player created or joined
 *
 * Arena (Lichess style): from the start until the end time, a player who is
 * free (joined, not paused, not in a game, with the page open or just back
 * from a game) is paired at once with the free player nearest in the
 * standings, avoiding their last opponent. A win is 2 points, 4 on a streak
 * (after two wins in a row, until a loss), +1 for a berserk win (the winner
 * halved their own clock before their first move and played at least
 * BERSERK_MIN_TURNS turns). A loss is 0. Games still going at the end count.
 *
 * Swiss: a fixed number of rounds. Each round pairs players with equal
 * scores where it can (top half against bottom half), never the same two
 * players twice when it can be avoided, balancing colours; an odd player out
 * gets a bye (1 point), at most once each while others have not had one. A
 * round starts when every game of the last one is over (after roundGap).
 * Standings: points, then Buchholz, then Sonneborn-Berger, then rating.
 *
 * Simul: the host plays every opponent at once, one room each, all on the
 * same spells; the host may get extra clock time per opponent. Unrated.
 *
 * A player who does not make their first move in time (NOSHOW_MS) is a
 * no-show: the room is aborted (unrated, not recorded). In an arena the
 * no-show is paused and their opponent goes back to the pool; in a Swiss
 * the opponent wins by forfeit and the no-show is withdrawn.
 */

const crypto = require('crypto');
const { freshEngine, requireShared } = require('./engine-loader');
const { roomResult, roomTurns, sideToMove } = require('./rating');
const { roomInitialTime } = requireShared('room-clock.js');

const KINDS = ['arena', 'swiss', 'simul'];
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
// A lock older than this is a crashed writer's: taken over.
const LOCK_MS = 30000;
// A player just out of a game is pairable this long without the page open
// (the game page sends them back to the event).
const PRESENCE_GRACE_MS = 30000;
// The first move must come this long after the game started (the second
// player's: after the first move).
const NOSHOW_MS = { arena: 45000, swiss: 90000, simul: 5 * MIN };
// Own turns a berserk winner must have played for the bonus point.
const BERSERK_MIN_TURNS = 4;
// Two players who just played may be paired again only after both waited this long.
const REMATCH_WAIT_MS = 10000;
const REPEAT_MS = { daily: DAY, weekly: 7 * DAY };

/** What a creator may ask for: players without the admin flag, and admins. */
const LIMITS = {
	user: { open: 3, aheadMs: 7 * DAY, arenaMin: [10, 180], rounds: [3, 11], players: 64, simul: 20, minutes: [1, 60] },
	admin: { open: 50, aheadMs: 60 * DAY, arenaMin: [10, 720], rounds: [3, 15], players: 256, simul: 50, minutes: [1, 180] },
};

class TournamentError extends Error {
	/** `code` is an https error code (index.js passes it to the client). */
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}
const fail = (code, message) => { throw new TournamentError(code, message); };

const other = (c) => (c === 'red' ? 'blue' : 'red');
const clean = (v) => JSON.parse(JSON.stringify(v));

function roomCode() {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code = '';
	for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
	return code;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/**
 * The event a create request asks for, checked against the limits:
 * { kind, name, description, timeControl, variant, packs, private, rated,
 *   official, repeat, startsAt, durationMs, berserk, rounds, roundGapMs,
 *   maxPlayers, hostColor, hostExtraMs }. Throws invalid-argument.
 */
function validateCreate(input, admin, now) {
	const L = admin ? LIMITS.admin : LIMITS.user;
	const d = input || {};
	const bad = (field) => fail('invalid-argument', 'invalid-' + field);
	const kind = KINDS.includes(d.kind) ? d.kind : bad('kind');
	const name = typeof d.name === 'string' ? d.name.replace(/\s+/g, ' ').trim() : '';
	if (name.length < 3 || name.length > 50) bad('name');
	const description = typeof d.description === 'string' ? d.description.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
	const engine = freshEngine();
	let timeControl;
	if (kind === 'simul' && d.untimed === true) {
		timeControl = { type: 'none' };
	} else {
		const min = Number(d.minutes);
		const inc = Number(d.increment || 0);
		if (!Number.isFinite(min) || min < L.minutes[0] || min > L.minutes[1] || Math.round(min * 2) !== min * 2) bad('minutes');
		if (!Number.isInteger(inc) || inc < 0 || inc > 60) bad('increment');
		timeControl = { type: 'realtime', initialTime: Math.round(min * MIN), increment: inc * 1000 };
	}
	const variant = engine.normalizeVariant(typeof d.variant === 'string' ? d.variant : 'standard');
	let packs = engine.normalizeExpansionSelection(Array.isArray(d.packs) ? d.packs.slice(0, 40) : ['core']);
	if (!packs.length) packs = ['core'];
	// The packs must fill the board (generateSpellList throws otherwise).
	try {
		engine.setBoardLayout(engine.variantBoardLayout(variant));
		engine.generateSpellList(packs, engine.variantHasDuplicates(variant));
	} catch (e) {
		bad('packs');
	}
	const t = {
		kind, name, description, timeControl, variant, packs: Array.from(new Set(packs)),
		private: d.private === true,
		// Rated events are the admins' scheduled ones; simuls are never rated.
		rated: admin && d.rated === true && kind !== 'simul',
		official: admin && d.official === true,
		repeat: admin && kind !== 'simul' && REPEAT_MS[d.repeat] ? d.repeat : null,
	};
	if (kind !== 'simul') {
		const startsAt = Number(d.startsAt);
		if (!Number.isFinite(startsAt) || startsAt < now - MIN || startsAt > now + L.aheadMs) bad('startsAt');
		t.startsAt = Math.max(now, Math.round(startsAt));
		const max = d.maxPlayers === undefined || d.maxPlayers === null ? L.players : Number(d.maxPlayers);
		if (!Number.isInteger(max) || max < 2 || max > L.players) bad('maxPlayers');
		t.maxPlayers = max;
	}
	if (kind === 'arena') {
		const dur = Number(d.durationMin);
		if (!Number.isInteger(dur) || dur < L.arenaMin[0] || dur > L.arenaMin[1]) bad('durationMin');
		t.durationMs = dur * MIN;
		t.endsAt = t.startsAt + t.durationMs;
		t.berserk = d.berserk !== false;
	} else if (kind === 'swiss') {
		const rounds = Number(d.rounds);
		if (!Number.isInteger(rounds) || rounds < L.rounds[0] || rounds > L.rounds[1]) bad('rounds');
		t.rounds = rounds;
		const gap = d.roundGapSec === undefined || d.roundGapSec === null ? 30 : Number(d.roundGapSec);
		if (!Number.isInteger(gap) || gap < 0 || gap > 600) bad('roundGapSec');
		t.roundGapMs = gap * 1000;
		t.round = 0;
	} else {
		const max = d.maxPlayers === undefined || d.maxPlayers === null ? Math.min(10, L.simul) : Number(d.maxPlayers);
		if (!Number.isInteger(max) || max < 1 || max > L.simul) bad('maxPlayers');
		t.maxPlayers = max;
		t.hostColor = ['red', 'blue', 'alternate'].includes(d.hostColor) ? d.hostColor : 'red';
		const extra = Number(d.hostExtraSec || 0);
		if (!Number.isInteger(extra) || extra < 0 || extra > 600) bad('hostExtraSec');
		t.hostExtraMs = timeControl.type === 'realtime' ? extra * 1000 : 0;
	}
	return t;
}

/** The public list's entry for an event. */
function indexEntry(t) {
	return clean({
		kind: t.kind, name: t.name, status: t.status, startsAt: t.startsAt || t.createdAt, endsAt: t.endsAt || null,
		nbPlayers: t.nbPlayers || 0, maxPlayers: t.maxPlayers || null, official: !!t.official, rated: !!t.rated,
		timeControl: t.timeControl, variant: t.variant, by: t.createdByName || null, rounds: t.rounds || null,
		round: t.round || null,
	});
}

/* ------------------------------------------------------------------ */
/* Pure parts: scoring, pairing, standings                             */
/* ------------------------------------------------------------------ */

/**
 * An arena game's points for one player, and their streak after it.
 * `won`: true / false; `berserkBonus`: they berserked and played enough.
 */
function arenaPoints(streak, won, berserkBonus) {
	if (!won) return { points: 0, streak: 0 };
	return { points: (streak >= 2 ? 4 : 2) + (berserkBonus ? 1 : 0), streak: streak + 1 };
}

/** Lichess's performance rating: opponents' average + 400 x (W - L) / N. */
function performance(p) {
	if (!p.games) return null;
	return Math.round((p.oppRatingSum || 0) / p.games + 400 * ((p.wins || 0) - (p.losses || 0)) / p.games);
}

/** Arena standings order: points, then performance, then who joined first. */
function arenaCompare(a, b) {
	return (b.score || 0) - (a.score || 0) || (performance(b) || 0) - (performance(a) || 0)
		|| (a.joinedAt || 0) - (b.joinedAt || 0) || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
}

/**
 * Colours for two players about to meet: red to the one who has had fewer
 * reds than blues, then to the one who was blue last; `rand` breaks a tie.
 * Players: { uid, colors: 'rbr...' }. Returns [red, blue].
 */
function assignColors(a, b, rand) {
	const bal = (p) => [...(p.colors || '')].reduce((s, c) => s + (c === 'r' ? 1 : -1), 0);
	const last = (p) => (p.colors || '').slice(-1);
	if (bal(a) !== bal(b)) return bal(a) < bal(b) ? [a, b] : [b, a];
	if (last(a) !== last(b)) {
		if (last(a) === 'b' || last(b) === 'r') return [a, b];
		return [b, a];
	}
	return (rand ? rand() : Math.random()) < 0.5 ? [a, b] : [b, a];
}

/**
 * Arena pairings among the free players: each in standings order takes the
 * nearest free player below them who was not their last opponent (that
 * one too only once both have waited REMATCH_WAIT_MS). Players: { uid,
 * score, rating, lastOpp, colors, waitingSince, ... }. Returns [[red, blue]].
 */
function pairArena(free, now, rand) {
	const list = free.slice().sort((a, b) => (b.score || 0) - (a.score || 0) || (b.rating || 0) - (a.rating || 0)
		|| (a.uid < b.uid ? -1 : 1));
	const used = new Set();
	const pairs = [];
	const waited = (p) => now - (p.waitingSince || now) >= REMATCH_WAIT_MS;
	for (let i = 0; i < list.length; i++) {
		const a = list[i];
		if (used.has(a.uid)) continue;
		let pick = null;
		let rematch = null;
		for (let j = i + 1; j < list.length; j++) {
			const b = list[j];
			if (used.has(b.uid)) continue;
			if (a.lastOpp === b.uid || b.lastOpp === a.uid) { rematch = rematch || b; continue; }
			pick = b;
			break;
		}
		if (!pick && rematch && waited(a) && waited(rematch)) pick = rematch;
		if (!pick) continue;
		used.add(a.uid);
		used.add(pick.uid);
		pairs.push(assignColors(a, pick, rand));
	}
	return pairs;
}

/** Red minus blue games so far. */
const colorBalance = (p) => [...(p.colors || '')].reduce((s, c) => s + (c === 'r' ? 1 : -1), 0);

/**
 * The colour a Swiss player must have next ('r' / 'b'), or null: two more
 * of one colour than the other, or the same colour the last two rounds,
 * must be evened out (FIDE's absolute colour preference).
 */
function absoluteColor(p) {
	const b = colorBalance(p);
	const c = p.colors || '';
	if (b <= -2 || c.endsWith('bb')) return 'r';
	if (b >= 2 || c.endsWith('rr')) return 'b';
	return null;
}

/**
 * One Swiss round's pairings. Players: { uid, score, rating, opps: [uid],
 * colors: 'rb..', byes }. Returns { pairs: [[red, blue]], bye: player|null }.
 * Backtracking over the standings (within a score group the top half meets
 * the bottom half, odd ones float down), with two constraints dropped only
 * when no pairing keeps them: no two players meet twice, and two players
 * who must have the same colour (absoluteColor) do not meet. The bye goes
 * to the lowest-ranked player who has not had one that leaves such a
 * pairing.
 */
function swissPair(players, rand) {
	const list = players.slice().sort((a, b) => (b.score || 0) - (a.score || 0) || (b.rating || 0) - (a.rating || 0)
		|| (a.uid < b.uid ? -1 : 1));
	const opps = new Map(list.map((p) => [p.uid, new Set(p.opps || [])]));
	const order = (a, rest) => {
		const same = rest.filter((p) => (p.score || 0) === (a.score || 0));
		const lower = rest.filter((p) => (p.score || 0) !== (a.score || 0));
		const ideal = Math.max(0, Math.floor((same.length + 1) / 2) - 1);
		return [...same.slice(ideal), ...same.slice(0, ideal).reverse(), ...lower];
	};
	const abs = new Map(list.map((p) => [p.uid, absoluteColor(p)]));
	let budget;
	const solve = (rest, level) => {
		if (!rest.length) return [];
		if (--budget < 0) return null;
		const a = rest[0];
		const others = rest.slice(1);
		for (const b of order(a, others)) {
			if (level < 2 && opps.get(a.uid).has(b.uid)) continue;
			if (level < 1 && abs.get(a.uid) && abs.get(a.uid) === abs.get(b.uid)) continue;
			const sub = solve(others.filter((x) => x !== b), level);
			if (sub) return [[a, b], ...sub];
		}
		return null;
	};
	const attempt = (level) => {
		if (list.length % 2 === 0) {
			budget = 50000;
			const pairs = solve(list, level);
			return pairs ? { pairs, bye: null } : null;
		}
		// Bye candidates: lowest first, those without a bye before the rest.
		const cands = list.slice().reverse();
		cands.sort((a, b) => (a.byes ? 1 : 0) - (b.byes ? 1 : 0));
		for (const bye of cands) {
			budget = 50000;
			const pairs = solve(list.filter((p) => p !== bye), level);
			if (pairs) return { pairs, bye };
		}
		return null;
	};
	const res = attempt(0) || attempt(1) || attempt(2) || { pairs: [], bye: null };
	return { pairs: res.pairs.map(([a, b]) => swissColors(a, b, rand)), bye: res.bye };
}

/**
 * Swiss colours: a colour a player must have first (absoluteColor), then
 * as assignColors, a tie going to the higher-ranked player's due colour.
 */
function swissColors(a, b, rand) {
	const absA = absoluteColor(a), absB = absoluteColor(b);
	if (absA && absA !== absB) return absA === 'r' ? [a, b] : [b, a];
	if (absB && absB !== absA) return absB === 'r' ? [b, a] : [a, b];
	const bal = colorBalance;
	if (bal(a) !== bal(b)) return bal(a) < bal(b) ? [a, b] : [b, a];
	const last = (p) => (p.colors || '').slice(-1);
	if (last(a) && last(a) !== last(b)) return last(a) === 'b' ? [a, b] : [b, a];
	if (last(a)) return last(a) === 'b' ? [a, b] : [b, a];
	return assignColors(a, b, rand);
}

/**
 * Swiss standings with tie-breaks: [{ uid, score, buchholz, sb, rank }]
 * sorted. `pairings`: the event's pairings (done ones count; a bye adds
 * nothing to the tie-breaks).
 */
function swissStandings(players, pairings) {
	const score = {};
	for (const p of players) score[p.uid] = p.score || 0;
	const tb = {};
	for (const p of players) tb[p.uid] = { buchholz: 0, sb: 0 };
	for (const g of pairings) {
		if (!g || g.bye || g.status !== 'done' || !g.red || !g.blue) continue;
		for (const c of ['red', 'blue']) {
			const me = g[c], opp = g[other(c)];
			if (!tb[me]) continue;
			tb[me].buchholz += score[opp] || 0;
			if (g.winner === c) tb[me].sb += score[opp] || 0;
		}
	}
	const rows = players.map((p) => ({ uid: p.uid, score: p.score || 0, buchholz: tb[p.uid].buchholz, sb: tb[p.uid].sb, rating: p.rating || 0 }));
	rows.sort((a, b) => b.score - a.score || b.buchholz - a.buchholz || b.sb - a.sb || b.rating - a.rating || (a.uid < b.uid ? -1 : 1));
	rows.forEach((r, i) => { r.rank = i + 1; });
	return rows;
}

/** A room's turns by `color` (the berserk bonus needs some). */
function ownTurns(room, color) {
	return roomTurns(room).filter((t) => t && t.color === color).length;
}

/* ------------------------------------------------------------------ */
/* The lock and the state                                              */
/* ------------------------------------------------------------------ */

/**
 * Run fn(guard) while holding the event's lock (tournament_locks/{tid}), so
 * two writers never pair the same player or score a game twice. A lock not
 * renewed for LOCK_MS is taken over (its holder crashed): the holder renews
 * it every LOCK_MS / 3, and guard.confirm() (save() calls it) renews it once
 * more and throws if it was lost, so a writer that outlived its lease never
 * writes. Throws 'unavailable' after waitMs of waiting.
 */
async function withLock(db, tid, fn, waitMs = 15000) {
	const ref = db.ref('tournament_locks/' + tid);
	const me = crypto.randomUUID();
	const until = Date.now() + waitMs;
	for (;;) {
		const now = Date.now();
		const res = await ref.transaction((cur) => (cur && cur.by !== me && cur.until > now ? undefined : { by: me, until: now + LOCK_MS }),
			undefined, false);
		if (res.committed) break;
		if (Date.now() > until) fail('unavailable', 'busy');
		await new Promise((r) => setTimeout(r, 100 + Math.floor(Math.random() * 200)));
	}
	let lost = false;
	const renew = async () => {
		const at = Date.now();
		// null on the first (cached) run sends it to the server, which reruns
		// it on the lock as it is; a missing lock commits as null: lost.
		const r = await ref.transaction((cur) => (cur === null ? null : cur.by === me ? { by: me, until: at + LOCK_MS } : undefined),
			undefined, false);
		const v = r.snapshot && r.snapshot.val();
		if (!r.committed || !v || v.by !== me) { lost = true; return false; }
		return true;
	};
	const timer = setInterval(() => { renew().catch(() => {}); }, Math.floor(LOCK_MS / 3));
	const guard = {
		async confirm() {
			if (lost || !(await renew())) fail('aborted', 'lock-lost');
		},
	};
	try {
		return await fn(guard);
	} finally {
		clearInterval(timer);
		// A transaction first runs on the local cache (null here): answer
		// null, and the server reruns it on the lock as it is.
		await ref.transaction((cur) => (cur === null || cur.by === me ? null : undefined), undefined, false).catch(() => {});
	}
}

/**
 * An event's state as one writer sees it: the event, its players, the
 * pairings it needs (all for a Swiss or a simul, the open ones for an
 * arena) and who has the page open. Changes go through the setters and are
 * written by save() in one multi-path update.
 */
async function load(db, tid) {
	const tSnap = await db.ref('tournaments/' + tid).once('value');
	const t = tSnap.val();
	if (!t) return null;
	const pairQuery = t.kind === 'arena'
		? db.ref('tournament_pairings/' + tid).orderByChild('status').equalTo('playing')
		: db.ref('tournament_pairings/' + tid);
	const [players, pairings, presence] = await Promise.all([
		db.ref('tournament_players/' + tid).once('value'),
		pairQuery.once('value'),
		db.ref('tournament_presence/' + tid).once('value'),
	]);
	const S = {
		db, tid, t, players: {}, pairings: {}, present: new Set(),
		dirtyT: false, dirtyPlayers: new Set(), dirtyPairings: new Set(), extra: {}, created: [],
		// Pairings opened by this writer: their rooms are not written yet.
		fresh: new Set(),
	};
	players.forEach((c) => { S.players[c.key] = Object.assign({ uid: c.key }, c.val()); });
	pairings.forEach((c) => { S.pairings[c.key] = c.val(); });
	presence.forEach((c) => { if (c.hasChildren()) S.present.add(c.key); });
	return S;
}

const touchT = (S) => { S.dirtyT = true; };
const touchP = (S, uid) => { S.dirtyPlayers.add(uid); };
const touchG = (S, pid) => { S.dirtyPairings.add(pid); };

async function save(S) {
	if (S.guard) await S.guard.confirm();
	const u = Object.assign({}, S.extra);
	const base = (n) => n + '/' + S.tid;
	if (S.dirtyT) {
		u[base('tournaments')] = clean(S.t);
		if (!S.t.private) u[base('tournament_index')] = indexEntry(S.t);
	}
	for (const uid of S.dirtyPlayers) {
		const p = S.players[uid];
		if (!p) { u[base('tournament_players') + '/' + uid] = null; continue; }
		const rec = Object.assign({}, p);
		delete rec.uid;
		u[base('tournament_players') + '/' + uid] = clean(rec);
	}
	for (const pid of S.dirtyPairings) u[base('tournament_pairings') + '/' + pid] = clean(S.pairings[pid]);
	if (Object.keys(u).length) await S.db.ref().update(u);
	S.extra = {};
	S.dirtyT = false;
	S.dirtyPlayers.clear();
	S.dirtyPairings.clear();
}

/* ------------------------------------------------------------------ */
/* Games                                                               */
/* ------------------------------------------------------------------ */

/** Nine (or fifteen) spells for the event's variant and packs, as the lobby draws them. */
function drawSpells(t) {
	const engine = freshEngine();
	const variant = engine.normalizeVariant(t.variant);
	engine.setBoardLayout(engine.variantBoardLayout(variant));
	return engine.generateSpellList(t.packs && t.packs.length ? t.packs : ['core'], engine.variantHasDuplicates(variant));
}

async function isSuspended(db, uid, now) {
	const until = (await db.ref('user_flags/' + uid + '/banUntil').once('value')).val();
	return typeof until === 'number' && until > now;
}

/**
 * Open a game between two players (player records, red first) in a room
 * of its own, and its pairing. `opts`: { spellNames, round, extraTime }.
 * The room is as a joined lobby room is (firebase-sync.js createRoom +
 * joinRoom), with the timer node written: the first mover's clock runs
 * from now (startedAt).
 */
async function openGame(S, red, blue, now, opts) {
	const { db, t, tid } = S;
	let code = roomCode();
	for (let i = 0; i < 5 && (await db.ref('rooms/' + code + '/status').once('value')).exists(); i++) code = roomCode();
	const pid = db.ref('tournament_pairings/' + tid).push().key;
	const spellNames = opts.spellNames || drawSpells(t);
	const engine = freshEngine();
	const why = engine.unratedReason(spellNames, t.variant, null, null);
	let ranked = !!t.rated && !why;
	let suspended = false;
	if (ranked && ((await isSuspended(db, red.uid, now)) || (await isSuspended(db, blue.uid, now)))) {
		ranked = false;
		suspended = true;
	}
	const tc = t.timeControl || { type: 'none' };
	const room = {
		spellNames, status: 'playing', created: now, startedAt: now,
		red: { uid: red.uid, displayName: red.name || 'Player', connected: false, anon: false, seq: true },
		blue: { uid: blue.uid, displayName: blue.name || 'Player', connected: false, anon: false, seq: true },
		ranked, timeControl: tc, allowSpectators: true, variant: t.variant || 'standard', creatorColor: 'red', seq: true,
		tournament: { id: tid, kind: t.kind, name: t.name, pairing: pid, berserk: t.kind === 'arena' && t.berserk === true },
	};
	if (!t.rated) room.casual = true;
	if (suspended) room.unratedReason = 'suspended';
	if (opts.extraTime) room.extraTime = opts.extraTime;
	if (tc.type === 'realtime') {
		room.timer = { red: roomInitialTime(room, 'red'), blue: roomInitialTime(room, 'blue'), activeColor: 'red', lastUpdated: now };
	}
	const pairing = {
		room: code, red: red.uid, blue: blue.uid, redName: red.name || 'Player', blueName: blue.name || 'Player',
		redRating: red.rating || null, blueRating: blue.rating || null, at: now, status: 'playing',
	};
	if (opts.round) pairing.round = opts.round;
	S.pairings[pid] = pairing;
	S.fresh.add(pid);
	touchG(S, pid);
	for (const [p, c] of [[red, 'red'], [blue, 'blue']]) {
		const opp = c === 'red' ? blue : red;
		S.extra['user_active_games/' + p.uid + '/' + code] = {
			roomCode: code, myColor: c, opponentColor: other(c), opponentUid: opp.uid,
			opponentDisplayName: opp.name || null, timeControlType: tc.type || 'none', created: now,
		};
		// A simul's host has no player record.
		if (S.players[p.uid]) {
			Object.assign(S.players[p.uid], { playing: code, pairing: pid, waitingSince: null, colors: (S.players[p.uid].colors || '') + c[0] });
			touchP(S, p.uid);
		}
	}
	S.extra['rooms/' + code] = room;
	// Watch Live lists public events' games; a private event's are watched by link.
	if (!t.private) S.extra['live_rooms/' + code] = true;
	S.created.push(code);
	return pid;
}

/**
 * Score a game that ended: `res` is roomResult's ({ winner }, or { reason }
 * for a room with no result to give), or { noShow: color }.
 */
function applyResult(S, pid, res, room, now) {
	const g = S.pairings[pid];
	const t = S.t;
	const uids = { red: g.red, blue: g.blue };
	const winner = res && (res.winner === 'red' || res.winner === 'blue') ? res.winner : null;
	g.endedAt = now;
	if (res && res.noShow) {
		g.how = 'noshow';
		g.noShow = res.noShow;
	} else if (winner) {
		g.how = room && room.forfeitedBy ? 'forfeit' : (room && room.endReason) || 'play';
	} else {
		g.how = 'void';
	}
	touchG(S, pid);
	const points = { red: 0, blue: 0 };
	for (const c of ['red', 'blue']) {
		const p = S.players[uids[c]];
		if (!p) continue;
		if (p.pairing === pid) { p.playing = null; p.pairing = null; }
		p.freedAt = now;
		touchP(S, p.uid);
	}
	if (t.kind === 'arena') {
		if (winner) {
			g.status = 'done';
			g.winner = winner;
			for (const c of ['red', 'blue']) {
				const p = S.players[uids[c]];
				if (!p) continue;
				const opp = S.players[uids[other(c)]];
				const won = c === winner;
				const berserked = !!(room && room.berserk && room.berserk[c] === true);
				const bonus = won && berserked && ownTurns(room, c) >= BERSERK_MIN_TURNS;
				const r = arenaPoints(p.streak || 0, won, bonus);
				points[c] = r.points;
				p.score = (p.score || 0) + r.points;
				p.streak = r.streak;
				p.games = (p.games || 0) + 1;
				p[won ? 'wins' : 'losses'] = (p[won ? 'wins' : 'losses'] || 0) + 1;
				if (berserked) p.berserks = (p.berserks || 0) + 1;
				p.sheet = (p.sheet || '') + String(r.points);
				p.oppRatingSum = (p.oppRatingSum || 0) + ((opp && opp.rating) || (c === 'red' ? g.blueRating : g.redRating) || 1000);
				p.lastOpp = uids[other(c)];
			}
			g.berserk = room && room.berserk ? { red: room.berserk.red === true, blue: room.berserk.blue === true } : null;
		} else {
			g.status = 'void';
			// A no-show is paused (Join again to play on); the opponent is free.
			if (res && res.noShow) {
				const p = S.players[uids[res.noShow]];
				if (p) { p.active = false; p.waitingSince = null; }
			}
		}
		for (const c of ['red', 'blue']) {
			const p = S.players[uids[c]];
			if (p && p.active && !p.playing && !p.withdrawn) p.waitingSince = now;
		}
	} else if (t.kind === 'swiss') {
		// A no-show loses by forfeit and is withdrawn from later rounds.
		const w = winner || (res && res.noShow ? other(res.noShow) : null);
		g.status = w ? 'done' : 'void';
		g.winner = w;
		if (w) {
			points[w] = 1;
			const p = S.players[uids[w]];
			if (p) { p.score = (p.score || 0) + 1; p.wins = (p.wins || 0) + 1; p.games = (p.games || 0) + 1; }
			const l = S.players[uids[other(w)]];
			if (l) { l.losses = (l.losses || 0) + 1; l.games = (l.games || 0) + 1; }
		}
		if (res && res.noShow) {
			const p = S.players[uids[res.noShow]];
			if (p) { p.withdrawn = true; p.absent = (p.absent || 0) + 1; }
		}
	} else {
		g.status = winner ? 'done' : 'void';
		g.winner = winner;
		const host = t.host;
		const hostColor = uids.red === host ? 'red' : 'blue';
		const opp = S.players[uids[other(hostColor)]];
		if (opp) opp.result = winner ? (winner === hostColor ? 'loss' : 'win') : 'void';
		if (winner) {
			const k = winner === hostColor ? 'hostWins' : 'hostLosses';
			t[k] = (t[k] || 0) + 1;
			touchT(S);
		}
	}
	g.points = points;
}

/**
 * A room that is still before both first moves and whose player to move
 * is past NOSHOW_MS: aborted here (no result, no rating). Returns the
 * no-show's colour, or null when the room was not aborted.
 */
async function abortNoShow(db, code, color, now) {
	const ref = db.ref('rooms/' + code);
	const res = await ref.transaction((r) => {
		if (r === null) return null;
		if (r.status !== 'playing') return undefined;
		if (roomTurns(r).length >= 2 || sideToMove(r) !== color) return undefined;
		return Object.assign(r, { status: 'aborted', abortedBy: color, endReason: 'noshow', closedAt: now, finishedAt: now });
	});
	const v = res.committed && res.snapshot.val();
	if (!v || v.status !== 'aborted' || v.closedAt !== now) return null;
	const u = { ['live_rooms/' + code]: null };
	for (const c of ['red', 'blue']) if (v[c] && v[c].uid) u['user_active_games/' + v[c].uid + '/' + code] = null;
	await db.ref().update(u).catch(() => {});
	return color;
}

/**
 * The open games' first moves: a player past NOSHOW_MS loses the game
 * (aborted room). With `full` (the minute tick), also scores any game
 * whose room ended without its trigger having scored it.
 */
async function sweepGames(S, now, full) {
	const { db, t } = S;
	for (const [pid, g] of Object.entries(S.pairings)) {
		if (!g || g.status !== 'playing' || S.fresh.has(pid)) continue;
		if (g.started && !full) continue;
		const room = (await db.ref('rooms/' + g.room).once('value')).val();
		if (!room) {
			applyResult(S, pid, { reason: 'no-room' }, null, now);
			continue;
		}
		if (room.status === 'finished') {
			applyResult(S, pid, await roomResult(freshEngine(), room), room, now);
			continue;
		}
		if (room.status === 'aborted') {
			if (roomTurns(room).length < 2) applyResult(S, pid, { noShow: room.abortedBy }, room, now);
			continue;
		}
		if (room.status !== 'playing') continue;
		const turns = roomTurns(room);
		if (turns.length >= 2) {
			g.started = true;
			touchG(S, pid);
			continue;
		}
		const toMove = sideToMove(room);
		// A simul's host may take their time over the first moves.
		if (t.kind === 'simul' && room[toMove] && room[toMove].uid === t.host) continue;
		const since = turns.length ? turns[0].timestamp : room.startedAt;
		if (typeof since !== 'number' || now - since < NOSHOW_MS[t.kind]) continue;
		const who = await abortNoShow(db, g.room, toMove, now);
		if (who) applyResult(S, pid, { noShow: who }, room, now);
	}
}

/* ------------------------------------------------------------------ */
/* The state machine                                                   */
/* ------------------------------------------------------------------ */

const openGames = (S) => Object.values(S.pairings).filter((g) => g && g.status === 'playing');

/** End an event: final ranks and podium; off the active list once its games are over. */
function finish(S, now) {
	const { t } = S;
	if (t.status !== 'finished') {
		t.status = 'finished';
		t.finishedAt = now;
	}
	const players = Object.values(S.players).filter((p) => p && !p.removed);
	let ranked;
	if (t.kind === 'swiss') {
		ranked = swissStandings(players, Object.values(S.pairings)).map((r) => Object.assign({}, S.players[r.uid], r));
		for (const r of ranked) {
			const p = S.players[r.uid];
			Object.assign(p, { rank: r.rank, buchholz: r.buchholz, sb: r.sb });
			touchP(S, p.uid);
		}
	} else if (t.kind === 'arena') {
		ranked = players.slice().sort(arenaCompare);
		ranked.forEach((p, i) => { p.rank = i + 1; touchP(S, p.uid); });
	} else {
		ranked = [];
	}
	t.podium = ranked.slice(0, 3).map((p) => ({ uid: p.uid, name: p.name || 'Player', score: p.score || 0 }));
	const open = openGames(S).length;
	t.final = open === 0;
	touchT(S);
	if (t.final) {
		S.extra['tournament_active/' + S.tid] = null;
		if (t.createdBy) S.extra['tournament_limits/' + t.createdBy + '/' + S.tid] = null;
		repeatEvent(S, now);
	}
}

/** A repeating event (admins: daily / weekly) schedules its next edition once. */
function repeatEvent(S, now) {
	const { t, db } = S;
	if (!t.repeat || !REPEAT_MS[t.repeat] || t.repeatedTo || !t.startsAt) return;
	let startsAt = t.startsAt + REPEAT_MS[t.repeat];
	while (startsAt < now) startsAt += REPEAT_MS[t.repeat];
	const tid = db.ref('tournaments').push().key;
	const next = {
		kind: t.kind, name: t.name, description: t.description || '', timeControl: t.timeControl, variant: t.variant,
		packs: t.packs, private: !!t.private, rated: !!t.rated, official: !!t.official, repeat: t.repeat,
		startsAt, maxPlayers: t.maxPlayers, createdBy: t.createdBy, createdByName: t.createdByName,
		createdAt: now, status: 'created', nbPlayers: 0, repeatOf: S.tid,
	};
	if (t.kind === 'arena') Object.assign(next, { durationMs: t.durationMs, endsAt: startsAt + t.durationMs, berserk: !!t.berserk });
	if (t.kind === 'swiss') Object.assign(next, { rounds: t.rounds, roundGapMs: t.roundGapMs, round: 0 });
	t.repeatedTo = tid;
	S.extra['tournaments/' + tid] = clean(next);
	S.extra['tournament_active/' + tid] = true;
	// As create() does: the creator's events list, and their open count.
	if (t.createdBy) {
		S.extra['user_tournaments/' + t.createdBy + '/' + tid] = { kind: t.kind, name: t.name, at: now, role: 'creator' };
		S.extra['tournament_limits/' + t.createdBy + '/' + tid] = now;
	}
	if (!next.private) S.extra['tournament_index/' + tid] = indexEntry(next);
}

/**
 * Cancel an event: its open games are aborted (no result, no rating: an
 * abort without abortedBy is no forfeit to index.js settleAbort), their
 * pairings void, their players free, and the event final.
 */
async function cancelEvent(S, now, reason) {
	const { t, db } = S;
	for (const [pid, g] of Object.entries(S.pairings)) {
		if (!g || g.status !== 'playing') continue;
		if (g.room && !S.fresh.has(pid)) {
			const ref = db.ref('rooms/' + g.room);
			const res = await ref.transaction((r) => {
				if (r === null) return null;
				if (r.status !== 'playing') return undefined;
				return Object.assign(r, { status: 'aborted', endReason: 'cancelled', closedAt: now, finishedAt: now });
			});
			// Aborted here, or (the transaction left it) ended first.
			const v = res.snapshot && res.snapshot.val();
			if (v && v.status === 'finished') {
				// It ended first: scored as usual.
				applyResult(S, pid, await roomResult(freshEngine(), v), v, now);
				continue;
			}
			S.extra['live_rooms/' + g.room] = null;
			for (const c of ['red', 'blue']) if (g[c]) S.extra['user_active_games/' + g[c] + '/' + g.room] = null;
		}
		Object.assign(g, { status: 'void', how: 'cancelled', endedAt: now });
		touchG(S, pid);
		for (const c of ['red', 'blue']) {
			const p = S.players[g[c]];
			if (p && p.pairing === pid) { p.playing = null; p.pairing = null; touchP(S, p.uid); }
		}
	}
	t.status = 'cancelled';
	t.cancelledAt = now;
	t.cancelReason = reason || null;
	t.final = true;
	touchT(S);
	S.extra['tournament_active/' + S.tid] = null;
	if (t.createdBy) S.extra['tournament_limits/' + t.createdBy + '/' + S.tid] = null;
}

/** An account being deleted (deleteUserData marks it first): never paired again. */
async function isDeleted(db, uid) {
	return (await db.ref('deleted_users/' + uid).once('value')).exists();
}

/** Arena: pair every free player who can be paired now. */
async function pairArenaNow(S, now) {
	const free = [];
	for (const p of Object.values(S.players)) {
		if (!p || !p.active || p.withdrawn || p.playing) continue;
		if (!S.present.has(p.uid) && now - (p.freedAt || p.joinedAt || 0) >= PRESENCE_GRACE_MS) continue;
		if (await isDeleted(S.db, p.uid)) continue;
		free.push(p);
	}
	for (const p of free) if (!p.waitingSince) { p.waitingSince = now; touchP(S, p.uid); }
	for (const [red, blue] of pairArena(free, now)) await openGame(S, red, blue, now, {});
}

/** Swiss: the history each player brings to a round. */
function swissHistory(S) {
	const h = {};
	for (const p of Object.values(S.players)) h[p.uid] = { opps: [], byes: 0 };
	for (const g of Object.values(S.pairings)) {
		if (!g) continue;
		if (g.bye) { if (h[g.red]) h[g.red].byes++; continue; }
		if (h[g.red]) h[g.red].opps.push(g.blue);
		if (h[g.blue]) h[g.blue].opps.push(g.red);
	}
	return h;
}

async function startSwissRound(S, now) {
	const { t } = S;
	const round = (t.round || 0) + 1;
	const h = swissHistory(S);
	const players = [];
	for (const p of Object.values(S.players)) {
		if (!p || p.withdrawn || p.removed || (await isDeleted(S.db, p.uid))) continue;
		players.push(Object.assign({}, p, h[p.uid]));
	}
	const { pairs, bye } = swissPair(players);
	t.round = round;
	t.roundStartedAt = now;
	t.nextRoundAt = null;
	t.roundSpells = drawSpells(t);
	touchT(S);
	for (const [red, blue] of pairs) await openGame(S, S.players[red.uid], S.players[blue.uid], now, { spellNames: t.roundSpells, round });
	if (bye) {
		const pid = S.db.ref('tournament_pairings/' + S.tid).push().key;
		const p = S.players[bye.uid];
		S.pairings[pid] = { round, red: bye.uid, blue: null, redName: p.name || 'Player', bye: true, status: 'done',
			winner: 'red', points: { red: 1, blue: 0 }, at: now, endedAt: now, how: 'bye' };
		touchG(S, pid);
		p.score = (p.score || 0) + 1;
		p.byes = (p.byes || 0) + 1;
		touchP(S, p.uid);
	}
}

async function startSimul(S, now) {
	const { t } = S;
	const opps = [];
	for (const p of Object.values(S.players)) if (p && !p.removed && !(await isDeleted(S.db, p.uid))) opps.push(p);
	opps.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
	if (!opps.length) fail('failed-precondition', 'no-players');
	t.status = 'started';
	t.startedAt = now;
	t.spells = drawSpells(t);
	touchT(S);
	const host = { uid: t.host, name: t.hostName || 'Host', rating: t.hostRating || null };
	const extra = t.timeControl && t.timeControl.type === 'realtime' && t.hostExtraMs > 0 ? t.hostExtraMs * opps.length : 0;
	for (let i = 0; i < opps.length; i++) {
		const hostRed = t.hostColor === 'red' || (t.hostColor === 'alternate' && i % 2 === 0);
		const [red, blue] = hostRed ? [host, opps[i]] : [opps[i], host];
		const pid = await openGame(S, red, blue, now, { spellNames: t.spells, extraTime: extra ? { [hostRed ? 'red' : 'blue']: extra } : null });
		opps[i].color = hostRed ? 'blue' : 'red';
		opps[i].room = S.pairings[pid].room;
		touchP(S, opps[i].uid);
	}
}

/**
 * Move an event on as of `now`: start it, run its no-show checks, pair
 * free arena players, start Swiss rounds, end it. Idempotent; the caller
 * holds the lock and saves.
 */
async function step(S, now, full) {
	const { t } = S;
	if (t.status === 'cancelled') return;
	if (t.status === 'finished' && t.final) return;
	if (t.kind === 'arena') {
		if (t.status === 'created' && now >= t.startsAt) {
			t.status = 'started';
			t.startedAt = now;
			touchT(S);
		}
		if (t.status === 'started' || t.status === 'finished') await sweepGames(S, now, full);
		if (t.status === 'started' && now >= t.endsAt) finish(S, now);
		else if (t.status === 'finished') finish(S, now);
		if (t.status === 'started') await pairArenaNow(S, now);
		return;
	}
	if (t.kind === 'swiss') {
		if (t.status === 'created' && now >= t.startsAt) {
			const n = Object.values(S.players).filter((p) => p && !p.withdrawn).length;
			if (n < 2) { await cancelEvent(S, now, 'not-enough-players'); return; }
			t.status = 'started';
			t.startedAt = now;
			touchT(S);
			await startSwissRound(S, now);
			return;
		}
		if (t.status !== 'started') return;
		await sweepGames(S, now, full);
		const current = Object.values(S.pairings).filter((g) => g && g.round === t.round);
		if (current.some((g) => g.status === 'playing')) return;
		if (t.round >= t.rounds || Object.values(S.players).filter((p) => p && !p.withdrawn).length < 2) {
			finish(S, now);
			return;
		}
		if (!t.nextRoundAt) {
			t.nextRoundAt = now + (t.roundGapMs || 0);
			touchT(S);
		}
		if (now >= t.nextRoundAt) await startSwissRound(S, now);
		return;
	}
	if (t.status === 'started') {
		await sweepGames(S, now, full);
		if (!openGames(S).length) finish(S, now);
	}
}

/** Move one event on (the poke, the tick, a trigger). Quiet when it is busy. */
async function advance(db, tid, now, opts) {
	try {
		return await withLock(db, tid, async (guard) => {
			const S = await load(db, tid);
			if (!S) return null;
			S.guard = guard;
			await step(S, now || Date.now(), !!(opts && opts.full));
			await save(S);
			return { status: S.t.status, created: S.created };
		}, opts && opts.waitMs ? opts.waitMs : 15000);
	} catch (e) {
		if (e && e.code === 'unavailable') return null;
		throw e;
	}
}

/** Every event not over yet (the minute tick). */
async function tick(db, now) {
	const snap = await db.ref('tournament_active').once('value');
	const ids = Object.keys(snap.val() || {});
	let n = 0;
	for (const tid of ids) {
		const res = await advance(db, tid, now, { full: true, waitMs: 3000 }).catch(() => null);
		if (res && res.created && res.created.length) n += res.created.length;
	}
	return { events: ids.length, games: n };
}

/**
 * A tournament room ended (index.js tournamentGameEnd): score it, free its
 * players and move the event on. The result is checked as the rating
 * checks it (rating.js roomResult), before the lock is taken.
 */
async function onRoomEnded(db, code, now) {
	const room = (await db.ref('rooms/' + code).once('value')).val();
	const tour = room && room.tournament;
	if (!tour || typeof tour.id !== 'string' || typeof tour.pairing !== 'string') return null;
	let res;
	if (room.status === 'finished') {
		res = await roomResult(freshEngine(), room);
	} else if (room.status === 'aborted') {
		// After both first moves an abort is a forfeit (index.js settleAbort
		// finishes the room, and this runs again).
		if (roomTurns(room).length >= 2) return null;
		res = { noShow: room.abortedBy === 'blue' ? 'blue' : 'red' };
	} else {
		return null;
	}
	return withLock(db, tour.id, async (guard) => {
		const S = await load(db, tour.id);
		if (!S) return null;
		S.guard = guard;
		// A cancelled event scores nothing more (its open games were aborted).
		if (S.t.status === 'cancelled') return null;
		// The pairing as stored (an arena loads only its open ones).
		if (!S.pairings[tour.pairing]) {
			const g = (await db.ref('tournament_pairings/' + tour.id + '/' + tour.pairing).once('value')).val();
			if (g) S.pairings[tour.pairing] = g;
		}
		const g = S.pairings[tour.pairing];
		// Only the room the server paired (a client cannot write `tournament`,
		// but check anyway), and only once.
		if (!g || g.room !== code || g.status !== 'playing') return null;
		const at = now || Date.now();
		applyResult(S, tour.pairing, res, room, at);
		await step(S, at, false);
		await save(S);
		return S.pairings[tour.pairing];
	});
}

/* ------------------------------------------------------------------ */
/* What players and creators ask for (index.js `tournament`)           */
/* ------------------------------------------------------------------ */

async function profile(db, uid) {
	const u = (await db.ref('users/' + uid).once('value')).val() || {};
	return { name: typeof u.displayName === 'string' && u.displayName ? u.displayName : 'Player', rating: typeof u.elo === 'number' ? u.elo : 1000 };
}

async function create(db, uid, input, ctx) {
	const { admin, now } = ctx;
	const L = admin ? LIMITS.admin : LIMITS.user;
	const t = validateCreate(input, admin, now);
	if (!admin && (await isSuspended(db, uid, now))) fail('permission-denied', 'suspended');
	if (await isDeleted(db, uid)) fail('permission-denied', 'deleted');
	const tid = db.ref('tournaments').push().key;
	// At most L.open events of one creator not over yet.
	const lim = await db.ref('tournament_limits/' + uid).transaction((cur) => {
		const open = Object.assign({}, cur || {});
		if (Object.keys(open).length >= L.open) return undefined;
		open[tid] = now;
		return open;
	}, undefined, false);
	if (!lim.committed) fail('resource-exhausted', 'too-many-events');
	const me = await profile(db, uid);
	Object.assign(t, { createdBy: uid, createdByName: me.name, createdAt: now, status: 'created', nbPlayers: 0 });
	if (t.kind === 'simul') Object.assign(t, { host: uid, hostName: me.name, hostRating: me.rating, startsAt: now });
	const u = {
		['tournaments/' + tid]: clean(t),
		['tournament_active/' + tid]: true,
		['user_tournaments/' + uid + '/' + tid]: { kind: t.kind, name: t.name, at: now, role: t.kind === 'simul' ? 'host' : 'creator' },
	};
	if (!t.private) u['tournament_index/' + tid] = indexEntry(t);
	await db.ref().update(u);
	// Deleted meanwhile (deleteUserData marks the account before it reads
	// its events): its scrub may have missed this one, so it goes.
	if (await isDeleted(db, uid)) {
		const undo = {};
		for (const k of Object.keys(u)) undo[k] = null;
		undo['tournament_limits/' + uid + '/' + tid] = null;
		await db.ref().update(undo);
		fail('permission-denied', 'deleted');
	}
	return { id: tid };
}

async function join(S, uid, now) {
	const { t, db } = S;
	const p = S.players[uid];
	const open = t.kind === 'arena' ? (t.status === 'created' || (t.status === 'started' && now < t.endsAt))
		: t.kind === 'swiss' ? (t.status === 'created' || (t.status === 'started' && t.round < Math.ceil(t.rounds / 2)))
			: t.status === 'created';
	if (!open) fail('failed-precondition', 'closed');
	if (t.kind === 'simul' && uid === t.host) fail('failed-precondition', 'host');
	if (p && p.removed) fail('permission-denied', 'removed');
	if (t.rated && (await isSuspended(db, uid, now))) fail('permission-denied', 'suspended');
	if (p) {
		// Back from a pause (arena) or a withdrawal (Swiss).
		if (t.kind === 'arena') { p.active = true; if (!p.playing) p.waitingSince = now; }
		if (t.kind === 'swiss') p.withdrawn = false;
		touchP(S, uid);
		return;
	}
	const n = Object.values(S.players).filter((x) => x && !x.removed).length;
	if (n >= (t.maxPlayers || Infinity)) fail('resource-exhausted', 'full');
	const me = await profile(db, uid);
	S.players[uid] = { uid, name: me.name, rating: me.rating, joinedAt: now, score: 0, games: 0, wins: 0, losses: 0 };
	if (t.kind === 'arena') Object.assign(S.players[uid], { active: true, streak: 0, sheet: '', waitingSince: now });
	touchP(S, uid);
	t.nbPlayers = n + 1;
	touchT(S);
	S.extra['user_tournaments/' + uid + '/' + S.tid] = { kind: t.kind, name: t.name, at: now, role: 'player' };
}

function leave(S, uid) {
	const { t } = S;
	const p = S.players[uid];
	if (!p) return;
	if (t.status === 'created') {
		delete S.players[uid];
		touchP(S, uid);
		t.nbPlayers = Math.max(0, Object.values(S.players).filter((x) => x && !x.removed).length);
		touchT(S);
		S.extra['user_tournaments/' + uid + '/' + S.tid] = null;
		return;
	}
	if (t.kind === 'arena') { p.active = false; p.waitingSince = null; }
	if (t.kind === 'swiss') p.withdrawn = true;
	touchP(S, uid);
}

/**
 * The callable's actions. `data`: { action, id, ... }; `ctx`: { admin, now }.
 *   create   - a new event (validateCreate); returns { id }
 *   join     - join, or come back from a pause / withdrawal
 *   withdraw - leave (before the start), pause (arena) or withdraw (Swiss)
 *   start    - the creator (or an admin) starts now; a simul's host starts it
 *   cancel   - the creator (of a scheduled site event: before the start), or an admin
 *   kick     - a simul's host before the start, or an admin: removes data.uid
 *   poke     - move the event on (a page whose countdown ran out)
 */
async function act(db, uid, data, ctx) {
	const action = data && data.action;
	const now = ctx.now || Date.now();
	if (action === 'create') return create(db, uid, data.config || {}, Object.assign({}, ctx, { now }));
	const tid = data && data.id;
	if (typeof tid !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(tid)) fail('invalid-argument', 'invalid-id');
	if (action === 'poke') {
		// One try: a poke while another writer holds the event is redundant,
		// and pokes never queue behind the lock.
		const res = await advance(db, tid, now, { waitMs: 1 });
		return { ok: true, status: res ? res.status : null };
	}
	if (!['join', 'withdraw', 'start', 'cancel', 'kick'].includes(action)) fail('invalid-argument', 'invalid-action');
	return withLock(db, tid, async (guard) => {
		const S = await load(db, tid);
		if (!S) fail('not-found', 'no-event');
		S.guard = guard;
		const { t } = S;
		if (await isDeleted(db, uid)) fail('permission-denied', 'deleted');
		const owner = uid === t.createdBy || ctx.admin;
		if (t.status === 'cancelled' || (t.status === 'finished' && action !== 'cancel')) fail('failed-precondition', 'over');
		if (action === 'join') {
			await join(S, uid, now);
		} else if (action === 'withdraw') {
			leave(S, uid);
		} else if (action === 'start') {
			if (!owner) fail('permission-denied', 'not-owner');
			if (t.status !== 'created') fail('failed-precondition', 'started');
			if (t.kind === 'simul') {
				await startSimul(S, now);
			} else {
				if (t.kind === 'swiss' && Object.values(S.players).filter((p) => p && !p.withdrawn).length < 2) {
					fail('failed-precondition', 'not-enough-players');
				}
				t.startsAt = now;
				if (t.kind === 'arena') t.endsAt = now + t.durationMs;
				touchT(S);
			}
		} else if (action === 'cancel') {
			// A player's own event, at any time before it ends; a scheduled
			// site event only by an admin once it has started.
			if (!ctx.admin && !(uid === t.createdBy && (t.status === 'created' || !t.official))) fail('permission-denied', 'not-owner');
			if (t.status === 'finished') fail('failed-precondition', 'over');
			await cancelEvent(S, now, ctx.admin && uid !== t.createdBy ? 'admin' : 'creator');
		} else if (action === 'kick') {
			const target = data.uid;
			if (typeof target !== 'string' || !S.players[target]) fail('not-found', 'no-player');
			const host = t.kind === 'simul' && uid === t.host && t.status === 'created';
			if (!ctx.admin && !host) fail('permission-denied', 'not-owner');
			if (t.status === 'created') {
				leave(S, target);
			} else {
				Object.assign(S.players[target], { removed: true, active: false, withdrawn: true, waitingSince: null });
				touchP(S, target);
			}
		}
		await step(S, now, false);
		await save(S);
		// Deleted while this ran: the scrub may have read the account's
		// events before this join wrote it in, so scrub this one now.
		if (action === 'join' && (await isDeleted(db, uid))) {
			await scrubInEvent(S, uid);
			await save(S);
		}
		return { ok: true, status: S.t.status };
	});
}

const DELETED_NAME = 'Deleted player';

/** A deleted account in one event (held lock, loaded state): scrubbed as scrubUser says. */
async function scrubInEvent(S, uid) {
	const { t, db, tid } = S;
	// An arena loads only its open pairings: the names are in all of them.
	const all = (await db.ref('tournament_pairings/' + tid).once('value')).val() || {};
	Object.assign(S.pairings, Object.fromEntries(Object.entries(all).filter(([pid]) => !S.pairings[pid])));
	const p = S.players[uid];
	if (p) {
		Object.assign(p, { name: DELETED_NAME, withdrawn: true, waitingSince: null });
		if (t.kind === 'arena') p.active = false;
		touchP(S, uid);
	}
	for (const [pid, g] of Object.entries(S.pairings)) {
		if (g && g.red === uid) { g.redName = DELETED_NAME; touchG(S, pid); }
		if (g && g.blue === uid) { g.blueName = DELETED_NAME; touchG(S, pid); }
	}
	// A series of a deleted creator ends with this edition.
	if (t.createdBy === uid) { t.createdByName = DELETED_NAME; t.repeat = null; touchT(S); }
	if (t.host === uid) { t.hostName = DELETED_NAME; touchT(S); }
	for (const x of t.podium || []) if (x && x.uid === uid) { x.name = DELETED_NAME; touchT(S); }
	S.extra['tournament_presence/' + tid + '/' + uid] = null;
	S.extra['user_tournaments/' + uid + '/' + tid] = null;
}

/**
 * A deleted account's tournament traces (index.js deleteUserData, after it
 * marks deleted_users/{uid}): in each of its events, under that event's
 * lock (so no writer restores the row from an older read), its name leaves
 * the standings, the pairings and the event, it is out of the event and its
 * presence goes. Its own index and limits go in the caller's `updates`.
 * Only records that exist are touched (a child written under a missing
 * record would create a stub row).
 */
async function scrubUser(db, uid, updates) {
	const mine = (await db.ref('user_tournaments/' + uid).once('value')).val() || {};
	updates['user_tournaments/' + uid] = null;
	updates['tournament_limits/' + uid] = null;
	for (const tid of Object.keys(mine)) {
		if (!/^[A-Za-z0-9_-]{1,40}$/.test(tid)) continue;
		// Best effort per event: a busy event must not fail the deletion (the
		// pairing skips deleted accounts either way).
		await withLock(db, tid, async (guard) => {
			const S = await load(db, tid);
			if (!S) return;
			S.guard = guard;
			await scrubInEvent(S, uid);
			await save(S);
		}, 30000).catch((e) => { console.warn('scrubUser', tid, String((e && e.message) || e)); });
	}
}

module.exports = {
	KINDS, LIMITS, NOSHOW_MS, BERSERK_MIN_TURNS, PRESENCE_GRACE_MS, REMATCH_WAIT_MS, TournamentError,
	validateCreate, arenaPoints, performance, arenaCompare, assignColors, pairArena, swissPair, swissStandings,
	withLock, load, save, step, advance, tick, onRoomEnded, act, abortNoShow, scrubUser,
};
