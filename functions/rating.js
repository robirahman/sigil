'use strict';
/**
 * Server-side result checks and Elo for completed games.
 *
 * Clients no longer write ratings (database.rules.json makes elo, the game
 * counters and user_games server-only). A finished game's completed_games
 * record triggers index.js `rateGame`, which calls `judgeGame` here:
 *
 *   - Online games are recorded by the server from their room (index.js
 *     recordRoom), which only the two seated players can write, and the
 *     result must follow from the room. A natural end is replayed move by
 *     move with the site's own engine (engine-loader.js) and must end with
 *     the claimed winner. A forfeit is the loser's own `forfeitedBy` write.
 *     A loss on time is recomputed from the server timestamps of the turns,
 *     as of the server time the room was closed (closedAt).
 *     A result that does not follow counts as a forfeit by the player who
 *     wrote it (`finishedBy`), so finishing a lost game early cannot
 *     escape the rating.
 *   - Games against the AI are replayed the same way. The engine's moves
 *     cannot be re-searched here, so a human win must end on the board; a
 *     resignation or flag is only rated when it is the AI that won.
 *
 * Everything here is pure (no Firebase): index.js supplies the room, the
 * account check and the clock, which keeps it testable under node --test.
 */

const crypto = require('crypto');
const { freshEngine } = require('./engine-loader');

const AI_UID = /^__ai_[a-z0-9_]+__$/;
// Network slack allowed on a loss on time.
const CLOCK_GRACE_MS = 2000;
// How long a player may be gone before the opponent can claim the game
// (rooms without a correspondence clock). Same as ABANDON_GRACE_MS in
// docs/static/scripts/engine/constants.js.
const ABANDON_GRACE_MS = 60 * 1000;
const DEFAULT_ELO = 1000;

const other = (c) => (c === 'red' ? 'blue' : 'red');

function unrated(reason) {
	return { rated: false, reason };
}

/** A room's turns in the order they were played: [{color, actions, timestamp}]. */
function roomTurns(room) {
	const turns = room.turns || {};
	// By the server timestamp (the rules make it the write time); push ids
	// carry each client's own clock, so between two clients they can tie.
	return Object.keys(turns)
		.sort((a, b) => ((turns[a].timestamp || 0) - (turns[b].timestamp || 0)) || (a < b ? -1 : a > b ? 1 : 0))
		.map((k) => turns[k]);
}

/**
 * The number of a transcript's first turn. Start SFNs come in two
 * conventions: an AI game's setupSfn is its first turn's sfnBefore (counter
 * already advanced), a room's startSfn is the position before it (the game
 * loop advances the counter). Turn parity names the mover (odd = red), so
 * the first mover's colour tells which: the counter itself, or the next.
 */
function firstTurnNumber(startSfn, firstColor) {
	const c = startSfn ? parseInt(String(startSfn).split(' ')[2], 10) || 0 : 0;
	return (c % 2 === 1) === (firstColor === 'red') ? c : c + 1;
}

/**
 * The transcript to replay for an online room, from `turns/` alone (each
 * seat can only write its own). The finishing client's gameLog is not
 * used: a client that reloaded mid-game holds only the turns since.
 */
function onlineTranscript(room) {
	const turns = roomTurns(room);
	if (!turns.length) return [];
	const first = firstTurnNumber(room.startSfn, turns[0].color);
	return turns.map((t, i) => ({ color: t.color, turnNumber: first + i, kind: 'input', actions: t.actions || [] }));
}

/**
 * Did `loser` run out of time by `now`? Recomputed from the turns' server
 * timestamps, not from the clients' timer node. The first move of the game
 * is never charged (its start time is not on the server).
 */
function flagged(room, loser, now) {
	const tc = room.timeControl || {};
	const turns = roomTurns(room);
	if (!turns.length) return false;
	const last = turns[turns.length - 1];
	if (last.color === loser || typeof last.timestamp !== 'number') return false;
	if (tc.type === 'correspondence') {
		return typeof tc.moveTimeout === 'number' && now >= last.timestamp + tc.moveTimeout - CLOCK_GRACE_MS;
	}
	if (tc.type !== 'realtime' || typeof tc.initialTime !== 'number') return false;
	const inc = tc.increment || 0;
	let remaining = tc.initialTime;
	let prevTs = null;
	for (const t of turns) {
		if (typeof t.timestamp !== 'number') return false;
		if (t.color === loser && prevTs !== null) remaining += inc - (t.timestamp - prevTs);
		prevTs = t.timestamp;
	}
	return remaining - (now - last.timestamp) <= CLOCK_GRACE_MS;
}

/**
 * May the opponent of `loser` claim the game because `loser` left? Their
 * seat must be marked gone (onDisconnect writes it with the server's
 * clock; only the seat's owner can clear it) for the grace period, and
 * both players must have moved (before that the game can only be aborted).
 */
function abandoned(room, loser, now) {
	const tc = room.timeControl || {};
	const seat = room[loser] || {};
	if (tc.type === 'correspondence') return false;
	if (roomTurns(room).length < 2) return false;
	return seat.connected === false && typeof seat.disconnectedAt === 'number'
		&& now - seat.disconnectedAt >= ABANDON_GRACE_MS - CLOCK_GRACE_MS;
}

/** The side to move in a room: after the last turn, or the first mover. */
function sideToMove(room) {
	const turns = roomTurns(room);
	if (turns.length) return other(turns[turns.length - 1].color);
	return room.startSfn && room.startSfn.split(' ')[1] === 'b' ? 'blue' : 'red';
}

/**
 * The completed_games record for a finished online room, written by the
 * server (index.js recordRoom). Same shape as the clients' AI-game records;
 * room annotations come along for the training data.
 */
function recordFromRoom(room, code, now) {
	const transcript = onlineTranscript(room);
	const rec = {
		spellNames: room.spellNames || [],
		winner: room.winner,
		turns: transcript,
		setupSfn: room.setupSfn || room.startSfn || null,
		finalSfn: room.finalSfn || null,
		roomCode: code,
		timestamp: now,
		variant: room.variant || 'standard',
		timeControl: room.timeControl || { type: 'none' },
		endReason: room.forfeitedBy ? 'forfeit' : (room.endReason || 'play'),
		redUid: (room.red && room.red.uid) || null,
		blueUid: (room.blue && room.blue.uid) || null,
		ranked: room.ranked === true,
		recordedBy: 'server',
	};
	if (room.startPos && typeof room.startPos.redWinProb === 'number') rec.startPos = room.startPos;
	if (room.annotations) rec.annotations = room.annotations;
	if (room.eval_annotations) rec.eval_annotations = room.eval_annotations;
	return rec;
}

/**
 * Replay a transcript; resolves to the winner it ends with, or null. The
 * replayer takes each turn's number from the transcript, so the numbers are
 * checked here: they must start at the start position's turn (1 for the
 * standard start) and run on by one, and every turn must be played.
 */
async function replayWinner(engine, spellNames, variant, startSfn, turns) {
	if (!turns.length) return null;
	const first = firstTurnNumber(startSfn && engine.normalizeSfnString(startSfn), turns[0].color);
	if (!turns.every((t, i) => t.turnNumber === first + i)) return null;
	const result = {};
	let rebuilt;
	try {
		rebuilt = await engine.reconstructGameLog(spellNames, variant, startSfn || null, turns, { result });
	} catch (e) {
		return null;
	}
	if (rebuilt.length !== turns.length) return null;
	return result.gameover ? result.winner : null;
}

/**
 * The verdict on one completed_games record.
 * @param {object} record - the completed_games value
 * @param {object} ctx
 *   room          - rooms/{record.roomCode} (null if absent)
 *   isFullAccount - async uid => true for a signed-in, non-anonymous account
 *   now           - server time (ms)
 * @returns {Promise<object>} { rated: true, winner, claimKey, startPos } or
 *   { rated: false, reason }, plus { kind: 'online' | 'ai' } when known.
 *   `skip: true` marks a record with no player to index (guest games).
 */
async function judgeGame(record, ctx) {
	if (!record || record.guest === true) return { rated: false, reason: 'guest', skip: true };
	const { redUid, blueUid, winner } = record;
	if (typeof redUid !== 'string' || typeof blueUid !== 'string') return { rated: false, reason: 'no-players', skip: true };
	if (winner !== 'red' && winner !== 'blue') return unrated('no-result');
	if (redUid === blueUid) return unrated('same-player');
	const aiSide = AI_UID.test(redUid) ? 'red' : AI_UID.test(blueUid) ? 'blue' : null;
	if (AI_UID.test(redUid) && AI_UID.test(blueUid)) return unrated('ai-vs-ai');
	const engine = freshEngine();
	const spellNames = record.spellNames || [];
	const variant = engine.normalizeVariant(record.variant);
	const verdict = aiSide
		? await _judgeAiGame(engine, record, aiSide, spellNames, variant)
		: await _judgeOnlineGame(engine, record, ctx, spellNames, variant);
	if (!verdict.rated) return verdict;
	if (record.ranked !== true) return Object.assign(unrated('casual'), { kind: verdict.kind });
	for (const uid of [redUid, blueUid]) {
		if (!AI_UID.test(uid) && !(await ctx.isFullAccount(uid))) {
			return Object.assign(unrated('guest-account'), { kind: verdict.kind });
		}
	}
	return verdict;
}

async function _judgeOnlineGame(engine, record, ctx, spellNames, variant) {
	const room = ctx.room;
	const kind = 'online';
	if (!room || room.local === true) return Object.assign(unrated('no-room'), { kind });
	if (!room.red || !room.blue || room.red.uid !== record.redUid || room.blue.uid !== record.blueUid) {
		return Object.assign(unrated('seat-mismatch'), { kind });
	}
	if (room.status !== 'finished' || room.winner !== record.winner) return Object.assign(unrated('room-result-mismatch'), { kind });
	if (room.ranked !== true) return Object.assign(unrated('casual'), { kind });
	const why = engine.unratedReason(room.spellNames, room.variant, room.startSfn || null, room.startPos || null);
	if (why) return Object.assign(unrated(why), { kind });

	const loser = other(record.winner);
	let ok;
	if (room.forfeitedBy === 'red' || room.forfeitedBy === 'blue') {
		ok = room.forfeitedBy === loser;
	} else if (room.endReason === 'time') {
		// At the moment the room was closed (closedAt, the server's time:
		// the rules require it), not when this runs: a claim made early
		// must not come true by waiting.
		ok = typeof room.closedAt === 'number' && flagged(room, loser, room.closedAt);
	} else if (room.endReason === 'abandon') {
		ok = typeof room.closedAt === 'number' && abandoned(room, loser, room.closedAt);
	} else {
		const transcript = onlineTranscript(room);
		ok = !!transcript && (await replayWinner(engine, room.spellNames, engine.normalizeVariant(room.variant),
			room.startSfn || null, transcript)) === record.winner;
	}
	const verdict = {
		rated: true,
		kind,
		winner: record.winner,
		claimKey: 'room_' + record.roomCode,
		startPos: room.startPos && typeof room.startPos.redWinProb === 'number' ? room.startPos : null,
	};
	if (ok) return verdict;
	if (room.finishedBy !== 'red' && room.finishedBy !== 'blue') return Object.assign(unrated('result-not-verified'), { kind });
	// The player who closed the room with a result that does not follow
	// from it loses, as if they had resigned.
	return Object.assign(verdict, { winner: other(room.finishedBy), overturned: true });
}

async function _judgeAiGame(engine, record, aiSide, spellNames, variant) {
	const kind = 'ai';
	const startPos = record.startPos && typeof record.startPos.redWinProb === 'number' ? record.startPos : null;
	// A priced start is the position the price was computed for; without
	// one the game replays from the standard start, whatever setupSfn says.
	let startSfn = null;
	if (startPos) {
		if (!record.setupSfn || !startPos.sfn
			|| engine.normalizeSfnString(startPos.sfn) !== engine.normalizeSfnString(record.setupSfn)) {
			return Object.assign(unrated('unpriced-start'), { kind });
		}
		startSfn = record.setupSfn;
	}
	const why = engine.unratedReason(spellNames, variant, startSfn, startPos);
	if (why) return Object.assign(unrated(why), { kind });

	const turns = Array.isArray(record.turns) ? record.turns : [];
	if (!turns.length || turns.some((t) => t.kind === 'snapshot')) return Object.assign(unrated('no-transcript'), { kind });
	const ending = record.endReason || 'play';
	if (ending === 'play') {
		const w = await replayWinner(engine, spellNames, variant, startSfn, turns);
		if (w !== record.winner) return Object.assign(unrated('result-not-verified'), { kind });
	} else if (record.winner !== aiSide) {
		// A resignation or flag by the AI cannot be checked here.
		return Object.assign(unrated('result-not-verified'), { kind });
	}
	const claim = crypto.createHash('sha256')
		.update(JSON.stringify([record.redUid, record.blueUid, startSfn, turns, record.winner]))
		.digest('hex').slice(0, 40);
	return { rated: true, kind, winner: record.winner, claimKey: 'ai_' + claim, startPos };
}

/**
 * The database writes for a judged game. `users` holds the two /users
 * records as read ({ red, blue }, null when missing); `hasLbName` whether
 * each has a leaderboard name. Mirrors what elo.js processEloClientSide
 * wrote, plus user_games entries for unrated games and the verdict.
 */
function ratingUpdates(gameId, record, verdict, users, hasLbName, engine) {
	const updates = {};
	const red = users.red || {};
	const blue = users.blue || {};
	const uidOf = { red: record.redUid, blue: record.blueUid };
	const data = { red, blue };
	const ts = typeof record.timestamp === 'number' ? record.timestamp : Date.now();
	const fromPosition = !!(verdict.startPos);
	const winner = verdict.rated ? verdict.winner : record.winner;
	const entry = (c) => ({
		timestamp: ts,
		roomCode: record.roomCode || null,
		gameId,
		opponent: data[other(c)].displayName || (other(c) === 'red' ? 'Red' : 'Blue'),
		opponentUid: uidOf[other(c)],
		opponentIsAI: !!data[other(c)].isAI || AI_UID.test(uidOf[other(c)]),
		color: c,
		result: winner === c ? 'win' : 'loss',
		fromPosition,
	});

	if (!verdict.rated) {
		updates['completed_games/' + gameId + '/eloProcessed'] = true;
		updates['completed_games/' + gameId + '/unratedReason'] = verdict.reason;
		// Another record of a game already rated: the players' histories
		// list the game once.
		if (verdict.reason === 'duplicate') return updates;
		for (const c of ['red', 'blue']) {
			if (AI_UID.test(uidOf[c])) continue;
			updates['user_games/' + uidOf[c] + '/' + gameId] = Object.assign(entry(c), { rated: false, unratedReason: verdict.reason });
		}
		return updates;
	}

	const w = verdict.winner;
	const l = other(w);
	const before = { red: typeof red.elo === 'number' ? red.elo : DEFAULT_ELO, blue: typeof blue.elo === 'number' ? blue.elo : DEFAULT_ELO };
	const pRed = verdict.startPos ? verdict.startPos.redWinProb : null;
	const winnerPosP = pRed === null ? null : (w === 'red' ? pRed : 1 - pRed);
	const points = engine.computeEloChange(before[w], before[l], winnerPosP);
	const after = { [w]: before[w] + points, [l]: before[l] - points };

	for (const c of ['red', 'blue']) {
		const uid = uidOf[c];
		const d = data[c];
		const won = c === w;
		updates['users/' + uid + '/elo'] = after[c];
		updates['users/' + uid + '/gamesPlayed'] = (d.gamesPlayed || 0) + 1;
		updates['users/' + uid + '/' + (won ? 'wins' : 'losses')] = (d[won ? 'wins' : 'losses'] || 0) + 1;
		updates['leaderboard/' + uid + '/elo'] = after[c];
		updates['leaderboard/' + uid + '/gamesPlayed'] = (d.gamesPlayed || 0) + 1;
		// Inactive AIs are pruned from the leaderboard while their profiles
		// stay: restore the name when one plays again.
		if (!hasLbName[c] && d.isAI && AI_UID.test(uid) && typeof d.displayName === 'string'
			&& d.displayName.length >= 1 && d.displayName.length <= 30) {
			updates['leaderboard/' + uid + '/displayName'] = d.displayName;
			updates['leaderboard/' + uid + '/isAI'] = true;
		}
		if (!AI_UID.test(uid)) {
			updates['user_games/' + uid + '/' + gameId] = Object.assign(entry(c), {
				rated: true,
				eloBefore: before[c],
				eloAfter: after[c],
				eloChange: after[c] - before[c],
			});
		}
	}
	const g = 'completed_games/' + gameId + '/';
	updates[g + 'eloProcessed'] = true;
	updates[g + 'eloChange'] = points;
	updates[g + 'redEloBefore'] = before.red;
	updates[g + 'blueEloBefore'] = before.blue;
	updates[g + 'redEloAfter'] = after.red;
	updates[g + 'blueEloAfter'] = after.blue;
	if (pRed !== null) updates[g + 'redExpected'] = engine.positionExpectedScore(pRed, before.red, before.blue);
	return updates;
}

module.exports = {
	AI_UID, CLOCK_GRACE_MS, ABANDON_GRACE_MS, firstTurnNumber, judgeGame, ratingUpdates, recordFromRoom, flagged,
	abandoned, sideToMove, onlineTranscript, roomTurns, freshEngine,
};
