'use strict';
// node --test functions/test/notify.test.js
//
// Who notifyTurn tells, and when (notify.js turnNotice); the shared clock
// (docs/static/scripts/engine/room-clock.js) the site's list uses too.

const test = require('node:test');
const assert = require('node:assert');
const { turnNotice, noticeMessage, notifyTurn, challengeNotice, notifyChallenge } = require('../notify');
const { roomTimeLeft, sideToMove } = require('../engine-loader').requireShared('room-clock.js');

const t0 = 1_700_000_000_000;
const DAY = 86_400_000;

function room(extra, turns) {
	const r = {
		status: 'playing',
		timeControl: { type: 'correspondence', moveTimeout: DAY },
		red: { uid: 'alice', displayName: 'Alice', connected: false },
		blue: { uid: 'bob', displayName: 'Bob', connected: false },
		turns: {},
	};
	(turns || [['t1', 'red', t0]]).forEach(([k, color, ts]) => { r.turns[k] = { color, actions: ['pass'], timestamp: ts }; });
	return Object.assign(r, extra);
}

test('a correspondence move tells the player now to move, with their time left', () => {
	const n = turnNotice(room(), 't1', t0 + 3_600_000);
	assert.deepStrictEqual(n, { uid: 'bob', color: 'blue', opponent: 'Alice', timeLeft: DAY - 3_600_000 });
	const r = room({}, [['t1', 'red', t0], ['t2', 'blue', t0 + 1000]]);
	assert.strictEqual(turnNotice(r, 't2', t0 + 2000).uid, 'alice');
});

test('nobody is told about an old turn, a finished game, or their own move', () => {
	const r = room({}, [['t1', 'red', t0], ['t2', 'blue', t0 + 1000]]);
	// A late event for the first turn: it is not bob's move any more.
	assert.strictEqual(turnNotice(r, 't1', t0 + 2000), null);
	assert.strictEqual(turnNotice(r, 'nope', t0 + 2000), null);
	assert.strictEqual(turnNotice(room({ status: 'finished' }), 't1', t0), null);
	assert.strictEqual(turnNotice(null, 't1', t0), null);
	// One account in both seats.
	assert.strictEqual(turnNotice(room({ blue: { uid: 'alice', connected: false } }), 't1', t0), null);
	// An empty or AI seat.
	assert.strictEqual(turnNotice(room({ blue: { connected: false } }), 't1', t0), null);
	assert.strictEqual(turnNotice(room({ blue: { uid: '__ai_rust_hard__' } }), 't1', t0), null);
	// Spectators are never in a seat: the notice only names a seat's uid.
	const s = turnNotice(room({ spectators: { carol: { joined: 1 } } }), 't1', t0);
	assert.strictEqual(s.uid, 'bob');
});

test('a realtime move is pushed only to a player whose tab is closed', () => {
	const rt = { timeControl: { type: 'realtime', initialTime: 300_000, increment: 0 } };
	assert.strictEqual(turnNotice(room(Object.assign({ blue: { uid: 'bob', connected: true } }, rt)), 't1', t0), null);
	// Presence is per connection: a live conn means a tab is open.
	assert.strictEqual(turnNotice(room(Object.assign({ blue: { uid: 'bob', connected: false, conns: { c1: true } } }, rt)), 't1', t0), null);
	assert.ok(turnNotice(room(Object.assign({ blue: { uid: 'bob', conns: {}, disconnectedAt: t0 } }, rt)), 't1', t0));
	const n = turnNotice(room(Object.assign({ blue: { uid: 'bob', connected: false, disconnectedAt: t0 } }, rt)), 't1', t0 + 1000);
	assert.deepStrictEqual([n.uid, n.timeLeft], ['bob', 299_000]);
	// Untimed rooms count as realtime here.
	assert.strictEqual(turnNotice(room({ timeControl: { type: 'none' }, blue: { uid: 'bob', connected: true } }), 't1', t0), null);
	assert.strictEqual(turnNotice(room({ timeControl: { type: 'none' } }), 't1', t0).timeLeft, null);
});

test('the message names the game and its deadline, and expires with it', () => {
	const m = noticeMessage('ABC123', { opponent: 'Alice', timeLeft: 2 * DAY + 5 });
	assert.strictEqual(m.data.body, 'Alice has moved. 2 days left.');
	assert.strictEqual(m.data.url, 'multiplayer.html?id=ABC123');
	assert.strictEqual(m.data.tag, 'sigil-turn-ABC123');
	assert.strictEqual(m.webpush.headers.TTL, String(Math.floor((2 * DAY + 5) / 1000)));
	assert.strictEqual(noticeMessage('X', { opponent: 'Bob', timeLeft: 90 * 60_000 }).data.body, 'Bob has moved. 1 hour left.');
	assert.strictEqual(noticeMessage('X', { opponent: 'Bob', timeLeft: null }).data.body, 'Bob has moved.');
	// Every data value is a string (FCM refuses anything else).
	for (const v of Object.values(m.data)) assert.strictEqual(typeof v, 'string');
});

test('notifyTurn sends to the recipient\'s tokens and drops the dead ones', async () => {
	const data = {
		rooms: { R1: room() },
		push_tokens: {
			bob: { h1: { token: 'tok-good', created: 1 }, h2: { token: 'tok-dead', created: 1 } },
			alice: { h3: { token: 'tok-alice', created: 1 } },
		},
	};
	const removed = [];
	// A tiny stand-in for the admin database.
	const db = {
		ref(p) {
			const parts = p ? p.split('/') : [];
			const val = parts.reduce((o, k) => (o == null ? undefined : o[k]), data);
			return {
				once: async () => ({
					val: () => (val === undefined ? null : val),
					forEach: (fn) => Object.keys(val || {}).forEach((k) => fn({ key: k, child: (c) => ({ val: () => val[k][c] }) })),
				}),
				update: async (u) => { removed.push(...Object.keys(u)); },
			};
		},
	};
	const sent = [];
	const send = async (tokens, msg) => {
		sent.push({ tokens, msg });
		return tokens.map((t) => (t === 'tok-dead' ? { error: { code: 'messaging/registration-token-not-registered' } } : { success: true }));
	};
	const res = await notifyTurn(db, 'R1', 't1', t0 + 1000, send);
	assert.deepStrictEqual(res, { uid: 'bob', sent: 1, removed: 1 });
	assert.deepStrictEqual(sent[0].tokens, ['tok-good', 'tok-dead']);
	assert.deepStrictEqual(removed, ['push_tokens/bob/h2']);
});

test('the shared clock: correspondence deadlines and realtime banks', () => {
	const r = room();
	assert.strictEqual(sideToMove(r), 'blue');
	assert.strictEqual(roomTimeLeft(r, 'blue', t0 + 1000), DAY - 1000);
	// No deadline runs for the player who just moved.
	assert.strictEqual(roomTimeLeft(r, 'red', t0 + 1000), null);
	// Nothing runs before the first move.
	assert.strictEqual(roomTimeLeft(room({}, []), 'red', t0), null);
	const rt = room({ timeControl: { type: 'realtime', initialTime: 60_000, increment: 2000 } },
		[['a', 'red', t0], ['b', 'blue', t0 + 10_000], ['c', 'red', t0 + 25_000]]);
	// Blue used 10 s (+2 s back) and is waiting; red used 15 s (+2) on its second move.
	assert.strictEqual(roomTimeLeft(rt, 'blue', t0 + 30_000), 60_000 + 2000 - 10_000 - 5000);
	assert.strictEqual(roomTimeLeft(rt, 'red', t0 + 30_000), 60_000 + 2000 - 15_000);
});

// ---- Challenges (sendPush, shared with notifyTurn) ----

function fakeDb(data, removed) {
	return {
		ref(p) {
			const parts = p ? p.split('/') : [];
			const val = parts.reduce((o, k) => (o == null ? undefined : o[k]), data);
			return {
				once: async () => ({
					val: () => (val === undefined ? null : val),
					exists: () => val !== undefined && val !== null,
					forEach: (fn) => Object.keys(val || {}).forEach((k) => fn({ key: k, child: (c) => ({ val: () => val[k][c] }) })),
				}),
				update: async (u) => { removed.push(...Object.keys(u)); },
			};
		},
	};
}

const challengeRoom = (extra) => Object.assign({
	status: 'waiting', creatorColor: 'red', invite: 'bob',
	timeControl: { type: 'realtime', initialTime: 300_000, increment: 3000 },
	red: { uid: 'alice', displayName: 'Alice' }, blue: { connected: false },
}, extra);

test('a challenge is pushed only while it is open, from the room\'s creator, unblocked', () => {
	const ch = { from: 'alice', at: t0 };
	assert.deepStrictEqual(challengeNotice('bob', challengeRoom(), ch, false, 'Alice'),
		{ uid: 'bob', title: 'Sigil challenge', body: 'Alice challenges you to a game (5+3).' });
	assert.strictEqual(challengeNotice('bob', challengeRoom({ status: 'playing' }), ch, false), null);
	assert.strictEqual(challengeNotice('bob', challengeRoom({ invite: 'carol' }), ch, false), null);
	assert.strictEqual(challengeNotice('bob', challengeRoom(), { from: 'mallory' }, false), null);
	assert.strictEqual(challengeNotice('bob', challengeRoom(), ch, true), null);
	assert.strictEqual(challengeNotice('bob', null, ch, false), null);
	assert.strictEqual(challengeNotice('bob', challengeRoom(), null, false), null);
});

test('notifyChallenge sends to the target\'s tokens through sendPush', async () => {
	const data = {
		rooms: { C1: challengeRoom({ timeControl: { type: 'correspondence', moveTimeout: 3 * DAY } }) },
		challenges: { bob: { C1: { from: 'alice', at: t0 } } },
		users: { alice: { displayName: 'Alice A' } },
		push_tokens: { bob: { h1: { token: 'tok-good', created: 1 }, h2: { token: 'tok-dead', created: 1 } } },
	};
	const removed = [];
	const sent = [];
	const send = async (tokens, msg) => {
		sent.push({ tokens, msg });
		return tokens.map((t) => (t === 'tok-dead' ? { error: { code: 'messaging/invalid-registration-token' } } : { success: true }));
	};
	const res = await notifyChallenge(fakeDb(data, removed), 'bob', 'C1', send);
	assert.deepStrictEqual(res, { uid: 'bob', sent: 1, removed: 1 });
	assert.strictEqual(sent[0].msg.data.body, 'Alice A challenges you to a game (3 days/move).');
	assert.strictEqual(sent[0].msg.data.url, 'multiplayer.html?id=C1');
	assert.strictEqual(sent[0].msg.data.tag, 'sigil-challenge-C1');
	assert.deepStrictEqual(removed, ['push_tokens/bob/h2']);
	// Blocked meanwhile: nothing is sent.
	data.blocks = { bob: { alice: true } };
	assert.strictEqual(await notifyChallenge(fakeDb(data, []), 'bob', 'C1', send), null);
	assert.strictEqual(sent.length, 1);
	// ... or the sender blocked the target.
	data.blocks = { alice: { bob: true } };
	assert.strictEqual(await notifyChallenge(fakeDb(data, []), 'bob', 'C1', send), null);
	assert.strictEqual(sent.length, 1);
});
