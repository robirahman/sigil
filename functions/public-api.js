'use strict';
/**
 * The public read endpoints of the HTTP API (api.js routes them). Each reads
 * only what the database rules already let anyone read (users/, user_games/,
 * rooms/, the leaderboards, puzzle_ratings/, the published puzzle set) and
 * answers a subset of it as JSON:
 *
 *   GET /v1/users/{uid}                 a player's profile and ratings
 *   GET /v1/users/by-name/{name}        the same, by display name
 *   GET /v1/users/{uid}/games           their recent games (?limit, ?before, ?moves=1)
 *   GET /v1/games/{room}                a game by room code, with its moves and SFNs
 *                                       (?after=N&wait=S: long-poll for turn N+1)
 *   GET /v1/puzzles/daily               the puzzle of the day (?date=YYYY-MM-DD, ?solutions=1)
 *   GET /v1/leaderboard                 ?board=rating|puzzles|storm|bots, ?limit
 *
 * Not public, so never answered: completed_games (the server's game records:
 * the moves of games against the site AI are kept there only), user_flags,
 * push tokens, challenges, anything under a token.
 * A game in play whose players turned spectators off is not shown until it
 * ends (the database lets anyone read it, the site does not show it).
 */

const fs = require('fs');
const path = require('path');
const { roomGame } = require('./turn-check');
const { requireShared } = require('./engine-loader');
const { roomTimeLeft, sideToMove, roomTurns } = requireShared('room-clock.js');

const SITE = 'https://sigilbattle.com';
const PROVISIONAL_GAMES = 10;
const GAMES_MAX = 50;
const GAMES_WITH_MOVES_MAX = 10;
const BOARD_MAX = 100;
const WAIT_MAX_S = 30;
const AI_UID = /^__ai_[a-z0-9_]+__$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ROOM_RE = /^[A-Z0-9]{4,12}$/;

class ApiError extends Error {
	constructor(status, code, message) {
		super(message || code);
		this.status = status;
		this.code = code;
	}
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

function intParam(query, name, def, min, max) {
	const raw = query && query[name];
	if (raw === undefined || raw === '') return def;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, 'bad-request', name + ' must be an integer from ' + min + ' to ' + max + '.');
	return n;
}

const flag = (query, name) => ['1', 'true', 'yes'].includes(String((query && query[name]) || '').toLowerCase());

// ---- players ----

async function isBotUid(db, uid) {
	if (typeof uid !== 'string' || !UID_RE.test(uid) || AI_UID.test(uid)) return false;
	return (await db.ref('bots/' + uid).once('value')).exists();
}

/** A player's profile: GET /v1/users/{uid}. */
async function userProfile(db, uid) {
	if (!UID_RE.test(uid)) throw new ApiError(400, 'bad-request', 'Not a player id.');
	const [snap, bot] = await Promise.all([db.ref('users/' + uid).once('value'), db.ref('bots/' + uid).once('value')]);
	const u = snap.val();
	if (!u || typeof u.displayName !== 'string') throw new ApiError(404, 'not-found', 'No such player.');
	const games = num(u.gamesPlayed) || 0;
	const out = {
		uid,
		name: u.displayName,
		url: SITE + '/profile.html?uid=' + encodeURIComponent(uid),
		created: num(u.created),
		isBot: bot.exists(),
		isAI: AI_UID.test(uid) || u.isAI === true,
		rating: { elo: num(u.elo) === null ? 1000 : u.elo, games, wins: num(u.wins) || 0, losses: num(u.losses) || 0,
			provisional: games < PROVISIONAL_GAMES },
		puzzles: u.puzzle && num(u.puzzle.rating) !== null ? { rating: u.puzzle.rating, plays: num(u.puzzle.plays) || 0 } : null,
		storm: u.puzzleStorm && num(u.puzzleStorm.best) !== null ? { best: u.puzzleStorm.best, runs: num(u.puzzleStorm.runs) || 0 } : null,
	};
	if (bot.exists()) out.botSince = num((bot.val() || {}).since);
	return out;
}

/** GET /v1/users/by-name/{name}: display names are unique (usernames/). */
async function userByName(db, name) {
	const key = String(name || '').toLowerCase();
	if (!/^[a-z0-9_-]{1,20}$/.test(key)) throw new ApiError(404, 'not-found', 'No such player.');
	const uid = (await db.ref('usernames/' + key).once('value')).val();
	if (typeof uid !== 'string') throw new ApiError(404, 'not-found', 'No such player.');
	return userProfile(db, uid);
}

// ---- games ----

const seatOf = (room, c, bots) => {
	const s = (room && room[c]) || {};
	const uid = typeof s.uid === 'string' ? s.uid : null;
	return { uid: uid && uid !== 'deleted' ? uid : null, name: s.displayName || (uid === 'deleted' ? 'Deleted player' : 'Guest'),
		isBot: !!(uid && bots[uid]), isAI: !!(uid && AI_UID.test(uid)) };
};

// Finished games do not change: their replays are kept (code -> body).
const finishedCache = new Map();
const CACHE_MAX = 300;

function clockOf(room, now) {
	const tc = room.timeControl || {};
	if (tc.type !== 'realtime' && tc.type !== 'correspondence') return null;
	const left = (c) => { const v = roomTimeLeft(room, c, now); return v === null ? null : Math.round(v); };
	return { red: left('red'), blue: left('blue'), at: now };
}

/**
 * A room as the API shows it (GET /v1/games/{room}). `engine` replays the
 * moves (engine-loader.js freshEngine). `viewerUid` is a token's account:
 * a player of a private game in play may read it.
 */
async function gameByRoom(db, code, engine, opts) {
	const o = opts || {};
	if (!ROOM_RE.test(code)) throw new ApiError(400, 'bad-request', 'Not a room code.');
	const room = (await db.ref('rooms/' + code).once('value')).val();
	if (!room || room.local === true || !room.status) throw new ApiError(404, 'not-found', 'No such game.');
	return describeRoom(db, code, room, engine, o);
}

async function describeRoom(db, code, room, engine, o) {
	const now = o.now || Date.now();
	const turnCount = roomTurns(room).length;
	const cached = finishedCache.get(code);
	if (room.status === 'finished' && cached && cached.turnCount === turnCount) return cached.body;
	const seats = [room.red && room.red.uid, room.blue && room.blue.uid].filter((u) => typeof u === 'string');
	if (room.status === 'playing' && room.allowSpectators === false && !(o.viewerUid && seats.includes(o.viewerUid))) {
		throw new ApiError(403, 'private-game', 'Its players do not allow spectators: it is shown once it ends.');
	}
	const bots = {};
	for (const u of seats) bots[u] = await isBotUid(db, u);
	const body = {
		room: code,
		url: SITE + '/multiplayer.html?id=' + encodeURIComponent(code),
		status: room.status,
		variant: room.variant || 'standard',
		timeControl: room.timeControl || { type: 'none' },
		rated: room.ranked === true,
		players: { red: seatOf(room, 'red', bots), blue: seatOf(room, 'blue', bots) },
		spellNames: room.spellNames || [],
		startSfn: room.startSfn || null,
		created: num(room.created),
		startedAt: num(room.startedAt),
		finishedAt: num(room.closedAt) || num(room.finishedAt),
		winner: room.status === 'finished' ? (room.winner || null) : null,
		endReason: room.status === 'finished' ? (room.forfeitedBy ? 'forfeit' : (room.endReason || 'play')) : null,
	};
	if (room.status === 'waiting' || room.status === 'expired') {
		return Object.assign(body, { moves: [], sfn: null, toMove: null, clock: null });
	}
	const game = await roomGame(engine, room);
	body.startPosition = game.start;
	body.moves = game.turns.map((t) => ({ n: t.turnNumber, color: t.color, actions: t.actions, sfn: t.sfnAfter }));
	body.sfn = game.sfn;
	body.replayed = game.valid;
	if (room.status === 'playing') {
		body.toMove = sideToMove(room);
		body.clock = clockOf(room, now);
	} else {
		body.toMove = null;
		body.clock = null;
	}
	if (room.status === 'finished') {
		if (finishedCache.size >= CACHE_MAX) finishedCache.delete(finishedCache.keys().next().value);
		finishedCache.set(code, { turnCount, body });
	}
	return body;
}

/**
 * Long-poll: resolve once room `code` has more than `after` turns or is no
 * longer playing, or after `waitS` seconds; then answer as gameByRoom.
 */
async function waitForRoom(db, code, after, waitS, engine, opts) {
	if (!ROOM_RE.test(code)) throw new ApiError(400, 'bad-request', 'Not a room code.');
	const ref = db.ref('rooms/' + code);
	const room = await new Promise((resolve) => {
		let done = false;
		let timer = null;
		const finish = (v) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			ref.off('value', onValue);
			resolve(v);
		};
		const onValue = (snap) => {
			const r = snap.val();
			if (!r || r.status !== 'playing' || roomTurns(r).length > after) finish(r);
			else latest = r;
		};
		let latest = null;
		timer = setTimeout(() => finish(latest), waitS * 1000);
		ref.on('value', onValue, () => finish(null));
	});
	if (!room || room.local === true || !room.status) throw new ApiError(404, 'not-found', 'No such game.');
	return describeRoom(db, code, room, engine, opts || {});
}

/** GET /v1/users/{uid}/games: the newest first. */
async function userGames(db, uid, query, engineFactory) {
	if (!UID_RE.test(uid)) throw new ApiError(400, 'bad-request', 'Not a player id.');
	const withMoves = flag(query, 'moves');
	const limit = intParam(query, 'limit', withMoves ? 5 : 20, 1, withMoves ? GAMES_WITH_MOVES_MAX : GAMES_MAX);
	const before = intParam(query, 'before', null, 0, Number.MAX_SAFE_INTEGER);
	if (!(await db.ref('users/' + uid + '/displayName').once('value')).exists()) throw new ApiError(404, 'not-found', 'No such player.');
	let q = db.ref('user_games/' + uid).orderByChild('timestamp');
	if (before !== null) q = q.endAt(before - 1);
	const snap = await q.limitToLast(limit).once('value');
	const rows = [];
	snap.forEach((c) => { rows.push([c.key, c.val() || {}]); });
	rows.sort((a, b) => (num(b[1].timestamp) || 0) - (num(a[1].timestamp) || 0));
	const games = [];
	for (const [key, g] of rows) {
		const opp = typeof g.opponentUid === 'string' ? g.opponentUid : null;
		const game = {
			gameId: g.gameId || key,
			room: typeof g.roomCode === 'string' ? g.roomCode : null,
			timestamp: num(g.timestamp),
			color: g.color === 'blue' ? 'blue' : 'red',
			result: g.result === 'win' ? 'win' : 'loss',
			opponent: { uid: opp, name: g.opponent || null, isAI: !!g.opponentIsAI || (!!opp && AI_UID.test(opp)),
				isBot: !!g.opponentIsBot || (!!opp && !AI_UID.test(opp) && (await isBotUid(db, opp))) },
			rated: g.rated === true,
			unratedReason: g.rated === true ? null : (g.unratedReason || null),
			rating: g.rated === true ? { before: num(g.eloBefore), after: num(g.eloAfter), change: num(g.eloChange) } : null,
			fromPosition: g.fromPosition === true,
		};
		game.url = game.room ? SITE + '/multiplayer.html?id=' + encodeURIComponent(game.room) : null;
		if (withMoves) {
			game.moves = null;
			game.sfn = null;
			if (game.room && ROOM_RE.test(game.room)) {
				try {
					const d = await gameByRoom(db, game.room, engineFactory(), {});
					game.moves = d.moves;
					game.startPosition = d.startPosition || null;
					game.sfn = d.sfn;
					game.spellNames = d.spellNames;
					game.variant = d.variant;
				} catch (e) {
					// The room was deleted after rating (its players may): no moves.
				}
			}
		}
		games.push(game);
	}
	const oldest = games.length ? games[games.length - 1].timestamp : null;
	return { uid, games, next: games.length === limit && oldest ? oldest : null };
}

// ---- puzzles ----

let _puzzles = null;
/** The published puzzle set (docs/static/puzzles), copied in by copy-engine.js at deploy. */
function puzzleSet() {
	if (_puzzles) return _puzzles;
	const copied = path.join(__dirname, 'data', 'daily-puzzles.json');
	if (fs.existsSync(copied)) {
		_puzzles = JSON.parse(fs.readFileSync(copied, 'utf8'));
	} else {
		const all = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'static', 'puzzles', 'mate_puzzles.json'), 'utf8'));
		_puzzles = slimPuzzles(all.puzzles || []);
	}
	return _puzzles;
}

/** What the API tells of a puzzle (no engine bookkeeping, no answer keys). */
function slimPuzzles(all) {
	return all.map((p) => ({
		id: p.id, index: p.index, kind: p.kind, mate: p.mate || null, mover: p.mover, sfn: p.sfn,
		variant: p.variant || 'standard', difficulty: p.difficulty, tags: p.tags || [], turn: p.turn || null,
		solutions: (p.solutions || []).map((s) => ({ actions: s.actions, after: s.after || null })),
	}));
}

/**
 * Today's puzzle, exactly as puzzles.html dailyPuzzle picks it: an FNV-1a
 * hash of 'sigil-daily-' + the UTC date over the difficulties 2 to 4
 * (test/api.test.js checks this copy against the page's).
 */
function dailyPuzzle(all, day) {
	const pool = all.filter(p => p.difficulty >= 2 && p.difficulty <= 4);
	const from = pool.length ? pool : all;
	let h = 2166136261;
	for (const ch of 'sigil-daily-' + day) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
	return from[h % from.length];
}

/** GET /v1/puzzles/daily. */
async function daily(db, query, now) {
	const today = new Date(now).toISOString().slice(0, 10);
	const day = query && query.date ? String(query.date) : today;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day + 'T00:00:00Z')) || day > today) {
		throw new ApiError(400, 'bad-request', 'date must be a past or present UTC day, YYYY-MM-DD.');
	}
	const p = dailyPuzzle(puzzleSet(), day);
	if (!p) throw new ApiError(404, 'not-found', 'No puzzles.');
	const r = (await db.ref('puzzle_ratings/' + p.id).once('value')).val();
	const out = {
		date: day,
		id: p.id,
		number: typeof p.index === 'number' ? p.index + 1 : null,
		url: SITE + '/puzzles.html?' + (day === today ? 'daily=1' : 'id=' + encodeURIComponent(p.id)),
		kind: p.kind,
		mate: p.mate,
		mover: p.mover,
		sfn: p.sfn,
		variant: p.variant,
		difficulty: p.difficulty,
		tags: p.tags,
		rating: r && num(r.rating) !== null ? { rating: r.rating, plays: num(r.plays) || 0 } : null,
	};
	if (flag(query, 'solutions')) out.solutions = p.solutions;
	return out;
}

// ---- leaderboards ----

const BOARDS = {
	rating: { path: 'leaderboard', by: 'elo', value: (d) => d.elo, games: (d) => d.gamesPlayed },
	bots: { path: 'bot_leaderboard', by: 'elo', value: (d) => d.elo, games: (d) => d.gamesPlayed },
	puzzles: { path: 'puzzle_leaderboard', by: 'rating', value: (d) => d.rating, games: (d) => d.plays },
	storm: { path: 'storm_leaderboard', by: 'score', value: (d) => d.score, games: () => null },
};

/** GET /v1/leaderboard: the board as leaderboard.html shows it (players with games only). */
async function leaderboard(db, query) {
	const name = (query && query.board) || 'rating';
	const b = BOARDS[name];
	if (!b) throw new ApiError(400, 'bad-request', 'board: one of ' + Object.keys(BOARDS).join(', ') + '.');
	const limit = intParam(query, 'limit', 50, 1, BOARD_MAX);
	let fetchN = limit;
	let rows = [];
	for (let i = 0; i < 4; i++) {
		const snap = await db.ref(b.path).orderByChild(b.by).limitToLast(fetchN).once('value');
		rows = [];
		let n = 0;
		snap.forEach((c) => {
			n++;
			const d = c.val() || {};
			const v = num(b.value(d));
			if (v === null || typeof d.displayName !== 'string') return;
			const g = b.games(d);
			if ((name === 'rating' || name === 'bots') && !(g > 0)) return;
			if (name === 'storm' && !(v > 0)) return;
			if (name !== 'bots' && d.isBot === true) return;
			rows.push({ uid: c.key, name: d.displayName, value: v, games: num(g), isAI: d.isAI === true || AI_UID.test(c.key) });
		});
		if (rows.length >= limit || n < fetchN) break;
		fetchN += (limit - rows.length) + 50;
	}
	rows = rows.sort((x, y) => y.value - x.value).slice(0, limit);
	return {
		board: name,
		entries: rows.map((r, i) => {
			const e = { rank: i + 1, uid: r.uid, name: r.name, isAI: r.isAI };
			if (name === 'storm') e.score = r.value; else e.rating = r.value;
			if (r.games !== null) {
				e.games = r.games;
				if (name !== 'storm') e.provisional = r.games < PROVISIONAL_GAMES;
			}
			return e;
		}),
	};
}

module.exports = {
	ApiError, userProfile, userByName, userGames, gameByRoom, waitForRoom, describeRoom, daily, dailyPuzzle, puzzleSet,
	slimPuzzles, leaderboard, isBotUid, intParam, flag, SITE, ROOM_RE, UID_RE, WAIT_MAX_S, _finishedCache: finishedCache,
};
