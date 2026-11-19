'use strict';
/**
 * A bot's turn, checked before it reaches a room (bot-api.js), and the
 * positions of a room's game so far (the bot streams and the public API).
 *
 * The check is the rating function's own replay: the room's turns (rating.js
 * onlineTranscript, the transcript rateGame replays) plus the new one, through
 * the site's engine (game-review.js reconstructGameLog, in a fresh vm context
 * from engine-loader.js). That replay is lenient the way a game record needs:
 * a token a prompt does not take is asked for again, tokens left over when a
 * turn ends are dropped, and a few clicks are replayed the way controllers
 * from before a rules fix played them (legacyReplay). A bot's turn is held to
 * what a live client sends instead:
 *   - every token is a node of the board, one of the room's spells, or one
 *     of the controls a client sends ('pass', 'dash', 'skip_providence',
 *     'submit'); never 'move', which the controller would take as the end of
 *     a turn with no move (no client sends it: the UI answers the move prompt
 *     with a node), and never a client-side control ('reset', 'forfeit');
 *   - the turn must end exactly when its tokens run out: none missing (the
 *     opponent's client would wait for them) and none left over (it would
 *     play them at the start of its next turn);
 *   - it must play the same under the live controller (reconstructGameLog
 *     `strict`) as in the lenient replay, so a click that only an old
 *     controller took (a Fissure wall as a move, an occupied node as a
 *     Competitive opening) is refused rather than spending a move.
 * The result (who has won, if anyone) is the replay's, counting threefold
 * repetition, which the game loops check at the start of the next turn.
 *
 * Pure apart from the engine: the room is passed in (a snapshot of
 * rooms/{code}), so it runs under node --test.
 */

const { onlineTranscript, roomTurns, sideToMove, firstTurnNumber } = require('./rating');

// A turn of more tokens than this is refused. The longest turns a client
// sends (a dash, a cast with its refills and targets) are a few dozen.
const MAX_TURN_TOKENS = 64;
const CONTROL_TOKENS = ['pass', 'dash', 'skip_providence', 'submit'];
const TOKEN_RE = /^[A-Za-z0-9_]{1,40}$/;

function fail(error, detail) {
	return { ok: false, error, detail: detail || null };
}

/** The room's spell names, variant and start position, as the replay reads them. */
function roomSetup(engine, room) {
	const spellNames = engine.normalizeSpellNames(room.spellNames || []);
	const variant = engine.normalizeVariant(room.variant);
	const startSfn = room.startSfn || null;
	return { spellNames, variant, startSfn };
}

/** The SFN before the first turn (the room's start, or the standard one). */
function startPosition(engine, room) {
	const { spellNames, variant, startSfn } = roomSetup(engine, room);
	const board = new engine.SigilBoard(spellNames, variant);
	if (startSfn) board.loadFromSfn(startSfn); else board.setupInitial();
	return { sfn: engine.boardToSfn(board), nodes: Object.keys(board.stones), counter: board.turnCounter };
}

/**
 * Threefold repetition at the start of the turn after `board`'s last one,
 * as the game loops check it (MultiplayerController._runGameLoop): looked
 * at, not kept.
 */
function threefoldNext(board) {
	if (!board || typeof board.takeSnapshot !== 'function') return false;
	const counts = board.allLoopingSnapshotCounts;
	const snap = board.snapshot;
	board.allLoopingSnapshotCounts = Object.assign({}, counts);
	let reps = 0;
	try {
		reps = board.takeSnapshot();
	} finally {
		board.allLoopingSnapshotCounts = counts;
		board.snapshot = snap;
	}
	return reps >= 3;
}

/**
 * Replay `transcript` from the room's start: { log, result: { gameover,
 * winner }, board } or throws. `strict` as reconstructGameLog takes it.
 */
async function replayTranscript(engine, room, transcript, strict) {
	const { spellNames, variant, startSfn } = roomSetup(engine, room);
	const result = {};
	let board = null;
	const log = await engine.reconstructGameLog(spellNames, variant, startSfn, transcript,
		{ result, strict: !!strict, onBoard: (b) => { board = b; } });
	if (!result.gameover && log.length && threefoldNext(board)) {
		result.gameover = true;
		result.winner = 'blue';
	}
	return { log, result, board };
}

/**
 * The game in `room` so far: { valid, start, turns: [{ color, turnNumber,
 * actions, sfnBefore, sfnAfter }], sfn (the position now), gameover, winner }.
 * `valid` is false when the room's turns do not replay (then `turns` is
 * empty and `sfn` the start).
 */
async function roomGame(engine, room) {
	const start = startPosition(engine, room);
	const transcript = onlineTranscript(room);
	const out = { valid: true, start: start.sfn, turns: [], sfn: start.sfn, gameover: false, winner: null };
	if (!transcript.length) return out;
	try {
		const { log, result } = await replayTranscript(engine, room, transcript, false);
		if (log.length !== transcript.length && !result.gameover) return Object.assign(out, { valid: false });
		out.turns = log.map((t, i) => ({ color: t.color, turnNumber: t.turnNumber,
			actions: transcript[i] ? transcript[i].actions : t.actions, sfnBefore: t.sfnBefore, sfnAfter: t.sfnAfter }));
		out.sfn = log.length ? log[log.length - 1].sfnAfter : start.sfn;
		out.gameover = !!result.gameover;
		out.winner = result.winner || null;
		// Turns written after the game ended (a broken room) do not count.
		if (log.length !== transcript.length) out.valid = false;
	} catch (e) {
		return Object.assign(out, { valid: false });
	}
	return out;
}

/**
 * Check `actions`, a turn for `color` in `room` (status 'playing'):
 *   { ok: true, turnNumber, sfnBefore, sfnAfter, gameover, winner }
 *   { ok: false, error, detail } with error one of
 *     'not-playing', 'not-your-turn', 'bad-actions', 'room-invalid', 'illegal-turn'.
 */
async function checkTurn(engine, room, color, actions) {
	if (!room || room.status !== 'playing') return fail('not-playing');
	if (color !== 'red' && color !== 'blue') return fail('not-your-turn');
	if (sideToMove(room) !== color) return fail('not-your-turn', 'It is ' + sideToMove(room) + '\'s move.');
	if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_TURN_TOKENS) {
		return fail('bad-actions', 'actions must be an array of 1 to ' + MAX_TURN_TOKENS + ' tokens.');
	}
	const start = startPosition(engine, room);
	const { spellNames } = roomSetup(engine, room);
	const allowed = new Set([...start.nodes, ...spellNames, ...CONTROL_TOKENS]);
	for (let i = 0; i < actions.length; i++) {
		const a = actions[i];
		if (typeof a !== 'string' || !TOKEN_RE.test(a) || !allowed.has(a)) {
			return fail('bad-actions', 'Token ' + i + ' (' + JSON.stringify(a).slice(0, 50)
				+ ') is not a node, one of this game\'s spells, or pass / dash / skip_providence / submit.');
		}
	}
	const prior = onlineTranscript(room);
	const turnNumber = prior.length ? prior[0].turnNumber + prior.length : firstTurnNumber(room.startSfn, color);
	const turn = { color, turnNumber, kind: 'input', actions: actions.slice() };
	const transcript = prior.concat([turn]);

	// Why a turn does not replay: the game so far may be the cause.
	const diagnose = async (fallback) => {
		if (prior.length) {
			let before;
			try {
				before = await replayTranscript(engine, room, prior, false);
			} catch (e) {
				return fail('room-invalid', 'The game so far does not replay: ' + String((e && e.message) || e));
			}
			if (before.log.length !== prior.length) return fail('room-invalid', 'The game so far has turns past its end.');
			if (before.result.gameover) return fail('not-playing', 'The game is over: ' + before.result.winner + ' has won.');
		}
		return fallback;
	};
	const replayFailed = (e) => {
		const msg = String((e && e.message) || e);
		if (/transcript exhausted/.test(msg)) return fail('illegal-turn', 'The turn is not finished: it needs more tokens (end it with "pass").');
		return fail('illegal-turn', 'The turn does not replay: ' + msg);
	};
	let lenient;
	let live;
	try {
		lenient = await replayTranscript(engine, room, transcript, false);
	} catch (e) {
		return diagnose(replayFailed(e));
	}
	if (lenient.log.length !== transcript.length) return diagnose(fail('illegal-turn', 'The turn does not replay.'));
	try {
		live = await replayTranscript(engine, room, transcript, true);
	} catch (e) {
		return replayFailed(e);
	}
	if (live.log.length !== transcript.length) return fail('illegal-turn', 'The turn does not replay.');
	const a = lenient.log[lenient.log.length - 1];
	const b = live.log[live.log.length - 1];
	if (engine.normalizeSfnString(a.sfnAfter) !== engine.normalizeSfnString(b.sfnAfter)
		|| !!lenient.result.gameover !== !!live.result.gameover || (lenient.result.winner || null) !== (live.result.winner || null)) {
		return fail('illegal-turn', 'The turn uses a click the live game refuses (a Fissure wall or an occupied node as a move).');
	}
	return {
		ok: true,
		turnNumber,
		sfnBefore: b.sfnBefore,
		sfnAfter: b.sfnAfter,
		gameover: !!live.result.gameover,
		winner: live.result.winner || null,
	};
}

module.exports = { checkTurn, roomGame, startPosition, threefoldNext, MAX_TURN_TOKENS, CONTROL_TOKENS, roomTurns };
