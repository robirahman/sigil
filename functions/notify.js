'use strict';
/**
 * Web pushes: "Your move" (index.js notifyTurn) and challenges from a
 * profile (index.js notifyChallenge), both through sendPush. Kept apart
 * from index.js so the tests can call it with a stub sender: the emulators
 * have no FCM.
 *
 * Tokens live in push_tokens/{uid}/{hash}: {token, created}, written by the
 * owner from active-games.html and readable only by them and the server.
 */

const { AI_UID } = require('./rating');
const { roomTurns, sideToMove, roomTimeLeft } = require('./engine-loader').requireShared('room-clock.js');

// FCM error codes after which a token never works again.
const DEAD_TOKEN_CODES = new Set([
	'messaging/registration-token-not-registered',
	'messaging/invalid-registration-token',
]);
// Web push keeps an undelivered message at most this long (FCM's cap).
const MAX_TTL_S = 28 * 24 * 3600;

/**
 * Who, if anyone, to tell that turn `turnId` of room `room` made it their
 * move: { uid, color, opponent, timeLeft } or null.
 *
 * Only while the game is on, only for the latest turn (a late or retried
 * event for an older one stays quiet), and only the seated player now to
 * move: never the mover, a spectator or an AI. Correspondence games always notify; realtime ones only when the
 * player to move has no tab open (no live connection in their seat's
 * `conns`; seats of older clients without conns go by their flag).
 */
function turnNotice(room, turnId, now) {
	if (!room || room.status !== 'playing' || !room.turns || !room.turns[turnId]) return null;
	const turns = roomTurns(room);
	if (turns[turns.length - 1] !== room.turns[turnId]) return null;
	const color = sideToMove(room);
	const mover = color === 'red' ? 'blue' : 'red';
	const seat = room[color] || {};
	const uid = seat.uid;
	if (typeof uid !== 'string' || !uid || AI_UID.test(uid)) return null;
	if (uid === (room[mover] || {}).uid) return null;
	const tc = room.timeControl || {};
	const live = seat.conns ? Object.keys(seat.conns).length > 0 : seat.connected !== false;
	if (tc.type !== 'correspondence' && live) return null;
	return {
		uid,
		color,
		opponent: (room[mover] || {}).displayName || (mover === 'red' ? 'Red' : 'Blue'),
		timeLeft: roomTimeLeft(room, color, now),
	};
}

function formatLeft(ms) {
	const h = Math.floor(ms / 3600000);
	if (h >= 48) return Math.floor(h / 24) + ' days';
	if (h >= 1) return h + (h === 1 ? ' hour' : ' hours');
	const m = Math.max(1, Math.floor(ms / 60000));
	return m + (m === 1 ? ' minute' : ' minutes');
}

/** The FCM message for a notice (data only: docs/sw.js shows it). */
function noticeMessage(code, notice) {
	const left = typeof notice.timeLeft === 'number' && notice.timeLeft > 0 ? notice.timeLeft : null;
	return {
		data: {
			title: 'Your move in Sigil',
			body: notice.opponent + ' has moved.' + (left ? ' ' + formatLeft(left) + ' left.' : ''),
			room: code,
			url: 'multiplayer.html?id=' + encodeURIComponent(code),
			// Same tag as the in-tab notice (turn-notify.js): one per game.
			tag: 'sigil-turn-' + code,
		},
		webpush: {
			headers: {
				Urgency: 'high',
				TTL: String(left ? Math.max(60, Math.min(MAX_TTL_S, Math.floor(left / 1000))) : 3600),
			},
		},
	};
}

/**
 * Push `message` to every browser `uid` has registered, through `send(tokens,
 * message)` (resolves to [{ok} | {error: {code}}] per token, as
 * sendEachForMulticast), and drop the tokens FCM reports dead. Resolves to
 * { uid, sent, removed }.
 */
async function sendPush(db, uid, message, send) {
	const snap = await db.ref('push_tokens/' + uid).once('value');
	const keys = [];
	const tokens = [];
	snap.forEach((c) => {
		const t = c.child('token').val();
		if (typeof t === 'string' && t) { keys.push(c.key); tokens.push(t); }
	});
	if (!tokens.length) return { uid, sent: 0, removed: 0 };
	const results = await send(tokens, message);
	const dead = {};
	results.forEach((r, i) => {
		if (r && r.error && DEAD_TOKEN_CODES.has(r.error.code)) dead['push_tokens/' + uid + '/' + keys[i]] = null;
	});
	if (Object.keys(dead).length) await db.ref().update(dead);
	return { uid, sent: results.filter((r) => r && !r.error).length, removed: Object.keys(dead).length };
}

/**
 * Handle a new turn: tell the player to move (sendPush). Resolves to
 * { uid, sent, removed } or null when nobody is told.
 */
async function notifyTurn(db, code, turnId, now, send) {
	const room = (await db.ref('rooms/' + code).once('value')).val();
	const notice = turnNotice(room, turnId, now);
	if (!notice) return null;
	return sendPush(db, notice.uid, noticeMessage(code, notice), send);
}

// ---- Challenges (challenges/{target}/{room}, from a profile) ----

function tcLabel(tc) {
	if (!tc || tc.type === 'none' || !tc.type) return 'untimed';
	if (tc.type === 'realtime') return Math.round((tc.initialTime || 0) / 6000) / 10 + '+' + Math.round((tc.increment || 0) / 1000);
	if (tc.type === 'correspondence') {
		const ms = tc.moveTimeout || 0;
		return ms >= 86400000 ? Math.round(ms / 86400000) + ' days/move' : Math.round(ms / 3600000) + ' hours/move';
	}
	return '';
}

/**
 * The push for a challenge still open: the room waits for exactly this
 * player, its creator sent it, and the target has not blocked them (the
 * rules check all three at the write; this re-reads them for a retry).
 * { uid, title, body } or null.
 */
function challengeNotice(target, room, challenge, blocked, fromName) {
	if (!room || !challenge || room.status !== 'waiting' || room.invite !== target) return null;
	const creator = room.creatorColor === 'blue' ? 'blue' : 'red';
	if (!room[creator] || room[creator].uid !== challenge.from || blocked) return null;
	const name = fromName || room[creator].displayName || 'A player';
	return { uid: target, title: 'Sigil challenge', body: name + ' challenges you to a game (' + tcLabel(room.timeControl) + ').' };
}

function challengeMessage(code, notice) {
	return {
		data: {
			title: notice.title,
			body: notice.body,
			room: code,
			url: 'multiplayer.html?id=' + encodeURIComponent(code),
			tag: 'sigil-challenge-' + code,
		},
		// An invite expires after three days (ROOM_INVITE_EXPIRY_MS).
		webpush: { headers: { Urgency: 'high', TTL: String(3 * 24 * 3600) } },
	};
}

/** Handle a new challenge: push it to its target. Null when nobody is told. */
async function notifyChallenge(db, target, code, send) {
	const [room, challenge] = await Promise.all([
		db.ref('rooms/' + code).once('value').then((s) => s.val()),
		db.ref('challenges/' + target + '/' + code).once('value').then((s) => s.val()),
	]);
	const from = challenge && typeof challenge.from === 'string' ? challenge.from : null;
	const [blocked, fromName] = from ? await Promise.all([
		// Either way: a sender who just blocked the target is withdrawing it.
		Promise.all([db.ref('blocks/' + target + '/' + from).once('value'), db.ref('blocks/' + from + '/' + target).once('value')])
			.then(([a, b]) => a.exists() || b.exists()),
		db.ref('users/' + from + '/displayName').once('value').then((s) => s.val()),
	]) : [false, null];
	const notice = challengeNotice(target, room, challenge, blocked, fromName);
	if (!notice) return null;
	return sendPush(db, target, challengeMessage(code, notice), send);
}

module.exports = { turnNotice, noticeMessage, notifyTurn, formatLeft, sendPush, challengeNotice, challengeMessage, notifyChallenge };
