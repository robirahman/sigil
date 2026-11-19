'use strict';
/**
 * The bot API (api.js routes it; a token with the `bot` scope, of a BOT
 * account): outside engines play on the site through it, never through the
 * database. The rules refuse every room, challenge, lobby, leaderboard and
 * game-record write by a BOT account (database.rules.json, `bots/`), so this
 * file is the only way a bot's move reaches a room, and every move is checked
 * first (turn-check.js) by the replay the rating function uses.
 *
 *   GET  /v1/bot/events                     SSE: challenge, challengeCanceled, gameStart, gameFinish
 *   GET  /v1/bot/games/{room}/stream        SSE: gameFull, then gameState on every turn and the end
 *   POST /v1/bot/games/{room}/turn          { actions: [...] }  the bot's turn, in the site's tokens
 *   POST /v1/bot/games/{room}/resign
 *   POST /v1/bot/games/{room}/abort         before both sides have moved
 *   POST /v1/bot/challenges/{room}/accept
 *   POST /v1/bot/challenges/{room}/decline  (or withdraw the bot's own)
 *   POST /v1/bot/challenge/{user}           { timeControl, variant?, color?, rated? }
 *
 * The rooms a bot plays in are ordinary rooms (the human's page plays them as
 * against any opponent): this file writes what a client would (the seat,
 * the turn with `last` and the clock node, currentSfn, the result), as the
 * admin, after the checks a client's write gets from the rules.
 *
 * Rated games: between bots, as the challenger asked; against a human, only
 * when the human opted in (rooms/{code}/rateBot, set by the human's own
 * challenge), never on a challenge a bot sends to a human. Bots play timed
 * games only: a bot that stops answering loses on time (expireClocks).
 */

const crypto = require('crypto');
const { checkTurn } = require('./turn-check');
const { onlineTranscript } = require('./rating');
const { ApiError, describeRoom, ROOM_RE, UID_RE, SITE } = require('./public-api');
const { requireShared } = require('./engine-loader');
const { roomGiftMs, roomTimeLeft, roomTurns, sideToMove } = requireShared('room-clock.js');

const AI_UID = /^__ai_[a-z0-9_]+__$/;
const other = (c) => (c === 'red' ? 'blue' : 'red');
// How long an event stream stays open before the client reconnects (the
// function's own timeout is longer).
const STREAM_MS = 9 * 60 * 1000;
const PING_MS = 20 * 1000;
// Waiting challenges a bot may have out at once.
const MAX_OPEN_CHALLENGES = 5;
// Time controls a bot challenge may ask for.
const REALTIME_MIN_MS = 30 * 1000;
const REALTIME_MAX_MS = 3 * 60 * 60 * 1000;
const INCREMENT_MAX_MS = 3 * 60 * 1000;
const CORR_MIN_MS = 60 * 60 * 1000;
const CORR_MAX_MS = 14 * 24 * 60 * 60 * 1000;
// Variants a bot challenge may ask for (the core board's).
const CHALLENGE_VARIANTS = ['standard', 'competitive', 'deathmatch', 'scramble', 'duplicates', 'competitive_deathmatch',
	'competitive_scramble', 'competitive_duplicates', 'deathmatch_duplicates', 'scramble_duplicates',
	'competitive_deathmatch_duplicates', 'competitive_scramble_duplicates'];
// Same alphabet as firebase-sync.js _generateRoomCode.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function roomCode() {
	const bytes = crypto.randomBytes(6);
	let code = '';
	for (let i = 0; i < 6; i++) code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
	return code;
}

/** The bot's seat in `room`, or null. */
function seatColor(room, uid) {
	if (room && room.red && room.red.uid === uid) return 'red';
	if (room && room.blue && room.blue.uid === uid) return 'blue';
	return null;
}

function checkRoomCode(code) {
	if (!ROOM_RE.test(code)) throw new ApiError(400, 'bad-request', 'Not a room code.');
}

/**
 * The clock node (`timer`) as a client leaves it after `color`'s turn at
 * `now`: realtime banked ms without gifts (roomTimerView adds them), or
 * correspondence deadlines. From the turns' timestamps (room-clock.js), the
 * clock that counts, not from the node.
 */
function timerAfterTurn(room, color, now) {
	const tc = room.timeControl || {};
	const opp = other(color);
	if (tc.type === 'realtime') {
		const mine = roomTimeLeft(room, color, now);
		const theirs = roomTimeLeft(room, opp, now);
		if (mine === null || theirs === null) return null;
		return {
			// roomTimeLeft has credited this turn's increment already.
			[color]: mine - roomGiftMs(room, color, now),
			[opp]: theirs - roomGiftMs(room, opp, now),
			activeColor: opp,
			lastUpdated: now,
		};
	}
	if (tc.type === 'correspondence' && typeof tc.moveTimeout === 'number') {
		const ts = room.timer || {};
		return { [color]: typeof ts[color] === 'number' ? ts[color] : 0, [opp]: now + tc.moveTimeout, activeColor: opp, lastUpdated: now };
	}
	return null;
}

/** The clock node at the start of a game (MultiplayerController.initTimer). */
function initialTimer(room, now) {
	const tc = room.timeControl || {};
	const first = sideToMove(room);
	if (tc.type === 'realtime') return { red: tc.initialTime, blue: tc.initialTime, activeColor: first, lastUpdated: now };
	if (tc.type === 'correspondence') return { red: 0, blue: 0, activeColor: first, lastUpdated: now };
	return null;
}

/** A room's review fields when the server ends it (rooms.js finishRoom does the same). */
function finishFields(room, fields, now) {
	const done = Object.assign(room, fields, { status: 'finished', closedAt: now, finishedAt: now });
	if (!Array.isArray(done.gameLog)) {
		done.gameLog = onlineTranscript(done);
		if (!done.setupSfn && done.startSfn) done.setupSfn = done.startSfn;
	}
	return done;
}

/**
 * The bot API, bound to its database and helpers.
 * deps: { db, engine: () => fresh engine, isFullAccount: async uid => bool,
 *         isSuspended: async uid => bool, now: () => ms }
 */
function botApi(deps) {
	const { db } = deps;
	const now = () => (deps.now ? deps.now() : Date.now());

	async function loadRoom(code) {
		checkRoomCode(code);
		const room = (await db.ref('rooms/' + code).once('value')).val();
		if (!room || room.local === true) throw new ApiError(404, 'not-found', 'No such game.');
		return room;
	}

	async function myGame(uid, code) {
		const room = await loadRoom(code);
		const color = seatColor(room, uid);
		if (!color) throw new ApiError(403, 'not-your-game', 'This bot does not play in that game.');
		return { room, color };
	}

	/** Remove the bot's lobby / active-games entries of a room it has left. */
	async function unlist(code, uids) {
		const updates = { ['open_rooms/' + code]: null, ['live_rooms/' + code]: null };
		for (const u of uids) if (typeof u === 'string' && u) updates['user_active_games/' + u + '/' + code] = null;
		await db.ref().update(updates).catch(() => {});
	}

	// ---- turns ----

	async function submitTurn(uid, code, body) {
		const { room, color } = await myGame(uid, code);
		if (room.status !== 'playing') throw new ApiError(409, 'not-playing', 'The game is ' + room.status + '.');
		if (room.seq !== true) throw new ApiError(409, 'unsupported-room', 'A room from before turn sequencing.');
		const actions = body && body.actions;
		const verdict = await checkTurn(deps.engine(), room, color, actions);
		if (!verdict.ok) {
			const status = verdict.error === 'not-your-turn' || verdict.error === 'not-playing' ? 409 : 400;
			throw new ApiError(status, verdict.error, verdict.detail || verdict.error);
		}
		const expectedLast = (room.last && room.last.key) || null;
		const key = db.ref('rooms/' + code + '/turns').push().key;
		const at = now();
		let why = null;
		const res = await db.ref('rooms/' + code).transaction((r) => {
			// A transaction first runs on the local cache (empty): answer it
			// unchanged, and the server runs it again on the real room.
			if (r === null) return null;
			why = null;
			if (r.status !== 'playing') { why = 'not-playing'; return; }
			if (((r.last && r.last.key) || null) !== expectedLast || seatColor(r, uid) !== color) { why = 'conflict'; return; }
			const turn = { color, actions: actions.slice(), timestamp: at };
			if (expectedLast) turn.after = expectedLast;
			r.turns = Object.assign({}, r.turns, { [key]: turn });
			r.last = { key, color };
			// As firebase-sync.js sendTurn: a move ends any takeback request.
			delete r.takeback;
			r.currentSfn = verdict.sfnAfter;
			const timer = timerAfterTurn(r, color, at);
			if (timer) r.timer = timer;
			if (verdict.gameover) {
				delete r.endReason;
				finishFields(r, { winner: verdict.winner, finishedBy: color, finalSfn: verdict.sfnAfter }, at);
			}
			return r;
		});
		if (!res.committed) {
			if (why === 'not-playing') throw new ApiError(409, 'not-playing', 'The game ended.');
			throw new ApiError(409, 'conflict', 'The game moved on (another turn or a takeback): read it again.');
		}
		if (verdict.gameover) await unlist(code, [room.red && room.red.uid, room.blue && room.blue.uid]);
		return { ok: true, room: code, turn: verdict.turnNumber, sfn: verdict.sfnAfter, gameOver: verdict.gameover,
			winner: verdict.winner };
	}

	/** Resign (any time) or abort (until both sides have moved). */
	async function endGame(uid, code, how) {
		const { room, color } = await myGame(uid, code);
		if (room.status !== 'playing') throw new ApiError(409, 'not-playing', 'The game is ' + room.status + '.');
		const at = now();
		let why = null;
		const res = await db.ref('rooms/' + code).transaction((r) => {
			if (r === null) return null;
			why = null;
			if (r.status !== 'playing' || seatColor(r, uid) !== color) { why = 'not-playing'; return; }
			if (how === 'abort') {
				// As the rules let a player abort: only before both have moved.
				if (roomTurns(r).length >= 2) { why = 'too-late'; return; }
				return Object.assign(r, { abortedBy: color, status: 'aborted' });
			}
			return finishFields(r, { forfeitedBy: color, finishedBy: color, winner: other(color) }, at);
		});
		if (!res.committed) {
			if (why === 'too-late') throw new ApiError(409, 'too-late', 'Both sides have moved: resign instead.');
			throw new ApiError(409, 'not-playing', 'The game ended.');
		}
		await unlist(code, [room.red && room.red.uid, room.blue && room.blue.uid]);
		return { ok: true, room: code };
	}

	// ---- challenges ----

	async function blockedEitherWay(a, b) {
		const [x, y] = await Promise.all([db.ref('blocks/' + a + '/' + b).once('value'), db.ref('blocks/' + b + '/' + a).once('value')]);
		return x.exists() || y.exists();
	}

	async function displayName(uid) {
		const n = (await db.ref('users/' + uid + '/displayName').once('value')).val();
		return typeof n === 'string' ? n : 'Bot';
	}

	/** Should a game between these seats be rated (the room as it will start)? */
	async function rankedFor(room) {
		if (room.casual === true) return { ranked: false };
		const red = room.red && room.red.uid;
		const blue = room.blue && room.blue.uid;
		if (typeof red !== 'string' || typeof blue !== 'string') return { ranked: false };
		const engine = deps.engine();
		if (engine.unratedReason(room.spellNames, room.variant, room.startSfn || null, room.startPos || null)) return { ranked: false };
		const bots = {};
		for (const u of [red, blue]) bots[u] = (await db.ref('bots/' + u).once('value')).exists();
		// A human plays a bot rated only on their own say-so.
		if ((!bots[red] || !bots[blue]) && room.rateBot !== true) return { ranked: false };
		for (const u of [red, blue]) if (!(await deps.isFullAccount(u))) return { ranked: false };
		for (const u of [red, blue]) if (deps.isSuspended && (await deps.isSuspended(u))) return { ranked: false, unratedReason: 'suspended' };
		return { ranked: true };
	}

	async function acceptChallenge(uid, code) {
		const room = await loadRoom(code);
		if (room.status !== 'waiting') throw new ApiError(409, 'not-waiting', 'The challenge is no longer open.');
		if (room.invite !== uid) throw new ApiError(403, 'not-your-challenge', 'The challenge is for someone else.');
		const creator = room.creatorColor === 'blue' ? 'blue' : 'red';
		const joiner = other(creator);
		const creatorUid = room[creator] && room[creator].uid;
		if (typeof creatorUid !== 'string' || (room[joiner] && room[joiner].uid)) throw new ApiError(409, 'not-waiting', 'The challenge is no longer open.');
		const tc = room.timeControl || {};
		if (tc.type !== 'realtime' && tc.type !== 'correspondence') {
			throw new ApiError(400, 'untimed', 'Bots play timed games only (real-time or correspondence): decline it.');
		}
		if (await blockedEitherWay(uid, creatorUid)) throw new ApiError(403, 'blocked', 'You cannot play this player.');
		const at = now();
		const seat = { uid, displayName: await displayName(uid), connected: true, seq: true, anon: false, bot: true };
		const rank = await rankedFor(Object.assign({}, room, { [joiner]: seat }));
		let why = null;
		const res = await db.ref('rooms/' + code).transaction((r) => {
			if (r === null) return null;
			why = null;
			if (r.status !== 'waiting' || r.invite !== uid || (r[joiner] && r[joiner].uid) || !(r[creator] && r[creator].uid === creatorUid)) {
				why = 'gone';
				return;
			}
			r[joiner] = seat;
			r.status = 'playing';
			r.ranked = rank.ranked;
			if (rank.unratedReason) r.unratedReason = rank.unratedReason; else delete r.unratedReason;
			r.startedAt = at;
			// The page of a human creator starts its own clock node when it
			// is red (MultiplayerController.initTimer); a bot's game needs one.
			const timer = initialTimer(r, at);
			if (timer) r.timer = timer;
			return r;
		});
		if (!res.committed) throw new ApiError(409, 'not-waiting', 'The challenge is no longer open.');
		const started = res.snapshot.val();
		const updates = {
			['challenges/' + uid + '/' + code]: null,
			['open_rooms/' + code]: null,
			['user_active_games/' + uid + '/' + code]: activeEntry(started, code, joiner),
		};
		if (started.allowSpectators !== false) updates['live_rooms/' + code] = true;
		await db.ref().update(updates);
		return { ok: true, room: code, color: joiner, rated: rank.ranked };
	}

	async function declineChallenge(uid, code) {
		checkRoomCode(code);
		const room = (await db.ref('rooms/' + code).once('value')).val();
		// The bot's own challenge: withdrawn (firebase-sync.js withdrawRoom).
		if (room && room.status === 'waiting' && room[room.creatorColor === 'blue' ? 'blue' : 'red']
			&& room[room.creatorColor === 'blue' ? 'blue' : 'red'].uid === uid) {
			const res = await db.ref('rooms/' + code + '/status').transaction((s) => (s === 'waiting' ? 'expired' : undefined));
			if (!res.committed) throw new ApiError(409, 'not-waiting', 'Someone joined it first.');
			const updates = { ['rooms/' + code]: null, ['open_rooms/' + code]: null, ['user_active_games/' + uid + '/' + code]: null };
			if (typeof room.invite === 'string' && room.invite) updates['challenges/' + room.invite + '/' + code] = null;
			await db.ref().update(updates);
			return { ok: true, room: code, withdrawn: true };
		}
		const mine = await db.ref('challenges/' + uid + '/' + code).once('value');
		if (!mine.exists()) throw new ApiError(404, 'not-found', 'No such challenge.');
		await db.ref('challenges/' + uid + '/' + code).remove();
		return { ok: true, room: code, declined: true };
	}

	function activeEntry(room, code, color) {
		const opp = other(color);
		return {
			roomCode: code,
			myColor: color,
			opponentColor: opp,
			opponentUid: (room[opp] && room[opp].uid) || null,
			opponentDisplayName: (room[opp] && room[opp].displayName) || null,
			timeControlType: (room.timeControl && room.timeControl.type) || 'none',
			created: room.created || now(),
		};
	}

	function parseTimeControl(tc) {
		if (!tc || typeof tc !== 'object') throw new ApiError(400, 'bad-request', 'timeControl: { type: "realtime", initialTime, increment } or { type: "correspondence", moveTimeout } (ms).');
		if (tc.type === 'realtime') {
			const initialTime = Number(tc.initialTime);
			const increment = tc.increment === undefined ? 0 : Number(tc.increment);
			if (!Number.isInteger(initialTime) || initialTime < REALTIME_MIN_MS || initialTime > REALTIME_MAX_MS
				|| !Number.isInteger(increment) || increment < 0 || increment > INCREMENT_MAX_MS) {
				throw new ApiError(400, 'bad-request', 'Real-time: initialTime from 30 s to 3 h and increment up to 3 min, in ms.');
			}
			return { type: 'realtime', initialTime, increment };
		}
		if (tc.type === 'correspondence') {
			const moveTimeout = Number(tc.moveTimeout);
			if (!Number.isInteger(moveTimeout) || moveTimeout < CORR_MIN_MS || moveTimeout > CORR_MAX_MS) {
				throw new ApiError(400, 'bad-request', 'Correspondence: moveTimeout from 1 hour to 14 days, in ms.');
			}
			return { type: 'correspondence', moveTimeout };
		}
		throw new ApiError(400, 'bad-request', 'Bots play timed games only: timeControl.type realtime or correspondence.');
	}

	async function sendChallenge(uid, target, body) {
		const b = body || {};
		let targetUid = String(target || '');
		if (!UID_RE.test(targetUid)) throw new ApiError(400, 'bad-request', 'Not a player.');
		// A display name works too.
		if (!(await db.ref('users/' + targetUid + '/displayName').once('value')).exists()) {
			const byName = /^[A-Za-z0-9_-]{1,20}$/.test(targetUid)
				? (await db.ref('usernames/' + targetUid.toLowerCase()).once('value')).val() : null;
			if (typeof byName !== 'string') throw new ApiError(404, 'not-found', 'No such player.');
			targetUid = byName;
		}
		if (targetUid === uid || AI_UID.test(targetUid)) throw new ApiError(400, 'bad-request', 'Not a player this bot can challenge.');
		if ((await db.ref('deleted_users/' + targetUid).once('value')).exists()
			|| !(await db.ref('users/' + targetUid + '/displayName').once('value')).exists()) throw new ApiError(404, 'not-found', 'No such player.');
		if (await blockedEitherWay(uid, targetUid)) throw new ApiError(403, 'blocked', 'You cannot challenge this player.');
		const tc = parseTimeControl(b.timeControl);
		const variant = b.variant === undefined ? 'standard' : String(b.variant);
		if (!CHALLENGE_VARIANTS.includes(variant)) throw new ApiError(400, 'bad-request', 'variant: one of ' + CHALLENGE_VARIANTS.join(', ') + '.');
		const pick = b.color === undefined ? 'random' : b.color;
		if (!['red', 'blue', 'random'].includes(pick)) throw new ApiError(400, 'bad-request', 'color: red, blue or random.');
		const me = pick === 'random' ? (crypto.randomInt(2) ? 'red' : 'blue') : pick;
		const targetIsBot = (await db.ref('bots/' + targetUid).once('value')).exists();
		// A human is never challenged to a rated game by a bot.
		const rated = b.rated === true && targetIsBot;
		// Open challenges at once.
		const active = (await db.ref('user_active_games/' + uid).once('value')).val() || {};
		let open = 0;
		for (const c of Object.keys(active)) {
			if (!ROOM_RE.test(c)) continue;
			const s = (await db.ref('rooms/' + c + '/status').once('value')).val();
			if (s === 'waiting') open++;
		}
		if (open >= MAX_OPEN_CHALLENGES) throw new ApiError(429, 'too-many-challenges', 'At most ' + MAX_OPEN_CHALLENGES + ' open challenges: withdraw one first.');
		const engine = deps.engine();
		const spellNames = engine.generateSpellList(['core'], engine.variantHasDuplicates(variant));
		const at = now();
		const roomData = {
			spellNames,
			status: 'waiting',
			created: at,
			[me]: { connected: true, uid, displayName: await displayName(uid), anon: false, bot: true },
			[other(me)]: { connected: false },
			ranked: false,
			timeControl: tc,
			allowSpectators: true,
			variant,
			creatorColor: me,
			seq: true,
			invite: targetUid,
		};
		if (!rated) roomData.casual = true;
		let code = null;
		for (let i = 0; i < 5 && !code; i++) {
			const c = roomCode();
			const res = await db.ref('rooms/' + c).transaction((cur) => (cur === null ? roomData : undefined));
			if (res.committed) code = c;
		}
		if (!code) throw new ApiError(503, 'busy', 'Try again.');
		await db.ref().update({
			['challenges/' + targetUid + '/' + code]: { from: uid, at, tc, variant },
			['user_active_games/' + uid + '/' + code]: activeEntry(roomData, code, me),
		});
		return { ok: true, room: code, color: me, rated, url: SITE + '/multiplayer.html?id=' + code };
	}

	// ---- streams ----

	/**
	 * The bot's event stream: `send(event, data)` for each challenge to it
	 * (and its withdrawal), each game it starts and each it finishes. Resolves
	 * a stop function.
	 */
	function watchEvents(uid, send) {
		const listeners = [];
		const games = new Map(); // code -> { status }
		const on = (ref, ev, fn) => { ref.on(ev, fn, () => {}); listeners.push(() => ref.off(ev, fn)); };
		const challengesRef = db.ref('challenges/' + uid);
		on(challengesRef, 'child_added', async (snap) => {
			const code = snap.key;
			const c = snap.val() || {};
			if (!ROOM_RE.test(code)) return;
			const room = (await db.ref('rooms/' + code).once('value')).val();
			if (!room || room.status !== 'waiting' || room.invite !== uid) return;
			const creator = room.creatorColor === 'blue' ? 'blue' : 'red';
			const from = room[creator] || {};
			send('challenge', {
				room: code,
				from: { uid: from.uid || null, name: from.displayName || null, isBot: !!(from.uid && (await db.ref('bots/' + from.uid).once('value')).exists()) },
				color: other(creator),
				timeControl: room.timeControl || { type: 'none' },
				variant: room.variant || 'standard',
				startSfn: room.startSfn || null,
				rated: room.casual !== true && (room.rateBot === true || !!(from.uid && (await db.ref('bots/' + from.uid).once('value')).exists())),
				at: typeof c.at === 'number' ? c.at : null,
			});
		});
		on(challengesRef, 'child_removed', (snap) => {
			if (ROOM_RE.test(snap.key)) send('challengeCanceled', { room: snap.key });
		});
		const activeRef = db.ref('user_active_games/' + uid);
		on(activeRef, 'child_added', (snap) => {
			const code = snap.key;
			if (!ROOM_RE.test(code) || games.has(code)) return;
			const g = { status: null };
			games.set(code, g);
			const statusRef = db.ref('rooms/' + code + '/status');
			const fn = async (s) => {
				const st = s.val();
				if (st === g.status) return;
				const was = g.status;
				g.status = st;
				if (st === 'playing' && was !== 'playing') {
					const room = (await db.ref('rooms/' + code).once('value')).val() || {};
					const color = seatColor(room, uid);
					if (color) send('gameStart', { room: code, color, opponent: { uid: (room[other(color)] || {}).uid || null, name: (room[other(color)] || {}).displayName || null } });
				} else if (st === 'finished' || st === 'aborted' || st === 'expired' || st === null) {
					if (was === 'playing') {
						const room = (await db.ref('rooms/' + code).once('value')).val() || {};
						send('gameFinish', { room: code, status: st || 'gone', winner: room.winner || null,
							endReason: room.forfeitedBy ? 'forfeit' : (room.endReason || (st === 'finished' ? 'play' : st)) });
					}
					statusRef.off('value', fn);
					games.delete(code);
					// The game is over: off the bot's list.
					if (st !== 'waiting') db.ref('user_active_games/' + uid + '/' + code).remove().catch(() => {});
				}
			};
			statusRef.on('value', fn, () => {});
			listeners.push(() => statusRef.off('value', fn));
		});
		return () => { for (const off of listeners.splice(0)) off(); };
	}

	/**
	 * A game's stream: `send('gameFull', ...)` now, then `send('gameState',
	 * ...)` whenever a turn lands or the game ends. Resolves a stop function.
	 */
	async function watchGame(uid, code, send) {
		const { room, color } = await myGame(uid, code);
		const ref = db.ref('rooms/' + code);
		let sig = null;
		let busy = Promise.resolve();
		const view = async (r) => {
			const body = await describeRoom(db, code, r, deps.engine(), { viewerUid: uid, now: now() });
			return Object.assign(body, { you: color });
		};
		const fn = (snap) => {
			const r = snap.val();
			if (!r) return;
			const s = JSON.stringify([roomTurns(r).length, r.last && r.last.key, r.status, r.winner || null]);
			if (s === sig) return;
			const first = sig === null;
			sig = s;
			busy = busy.then(async () => {
				const body = await view(r);
				if (first) send('gameFull', body);
				else send('gameState', { room: code, status: body.status, moves: body.moves, sfn: body.sfn, toMove: body.toMove,
					clock: body.clock, winner: body.winner, endReason: body.endReason, you: color });
			}).catch(() => {});
		};
		void room;
		ref.on('value', fn, () => {});
		return () => ref.off('value', fn);
	}

	return {
		submitTurn, endGame, acceptChallenge, declineChallenge, sendChallenge, watchEvents, watchGame,
		_timerAfterTurn: timerAfterTurn, rankedFor,
	};
}

/**
 * Make `uid` a BOT account (index.js upgradeToBot). Irreversible; only an
 * account with no games yet, so no human rating moves to the bots' list and
 * no bot's to the humans'. Throws ApiError.
 */
async function upgradeToBot(db, uid, deps, at) {
	if (!(await deps.isFullAccount(uid))) throw new ApiError(403, 'permission-denied', 'Sign in with an account first (not a guest).');
	if ((await db.ref('bots/' + uid).once('value')).exists()) throw new ApiError(409, 'already-bot', 'This account is already a BOT account.');
	if (deps.isSuspended && (await deps.isSuspended(uid))) throw new ApiError(403, 'suspended', 'A suspended account cannot become a bot.');
	const [user, games, active] = await Promise.all([
		db.ref('users/' + uid).once('value'), db.ref('user_games/' + uid).limitToFirst(1).once('value'),
		db.ref('user_active_games/' + uid).limitToFirst(1).once('value'),
	]);
	const u = user.val() || {};
	if (typeof u.displayName !== 'string') throw new ApiError(409, 'no-profile', 'Choose a display name first.');
	if ((u.gamesPlayed || 0) > 0 || games.exists() || active.exists()) {
		throw new ApiError(409, 'has-games', 'Only an account that has never played a game can become a bot.');
	}
	await db.ref().update({
		['bots/' + uid]: { since: at },
		['users/' + uid + '/isBot']: true,
		// Bots are never on the players' boards: their own board instead.
		['leaderboard/' + uid]: null,
		['puzzle_leaderboard/' + uid]: null,
		['storm_leaderboard/' + uid]: null,
		['bot_leaderboard/' + uid]: { displayName: u.displayName, elo: typeof u.elo === 'number' ? u.elo : 1000, gamesPlayed: 0 },
	});
	return { ok: true, uid, since: at };
}

module.exports = { botApi, upgradeToBot, timerAfterTurn, initialTimer, seatColor, STREAM_MS, PING_MS, MAX_OPEN_CHALLENGES };
