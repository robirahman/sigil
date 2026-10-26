'use strict';
// database.rules.json against the Realtime Database emulator:
//   cd functions && npm run test:rules
// (firebase emulators:exec starts the emulator and sets
// FIREBASE_DATABASE_EMULATOR_HOST.)

const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const assert = require('assert');
const { ref, set, get, update, remove, serverTimestamp } = require('firebase/database');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
let env;

test.before(async () => {
	const [host, port] = (process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000').split(':');
	env = await initializeTestEnvironment({
		projectId: 'demo-sigil',
		database: { rules: RULES, host, port: Number(port) },
	});
});
test.after(() => env && env.cleanup());
test.beforeEach(() => env.clearDatabase());

const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).database();
const seed = (data) => env.withSecurityRulesDisabled((ctx) => set(ref(ctx.database()), data));

const profile = { displayName: 'Alice', elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: 1 };

test('nobody can change a rating, not even its owner', async () => {
	await seed({ users: { alice: profile, bob: Object.assign({}, profile, { displayName: 'Bob' }) },
		leaderboard: { alice: { displayName: 'Alice', elo: 1000, gamesPlayed: 0 } } });
	await assertFails(set(ref(db('bob'), 'users/alice/elo'), 1032));
	await assertFails(set(ref(db('alice'), 'users/alice/elo'), 1032));
	await assertFails(set(ref(db('alice'), 'users/alice/wins'), 1));
	await assertFails(set(ref(db('alice'), 'leaderboard/alice/elo'), 1032));
	// Deleting the field to re-create it fresh is refused too.
	await assertFails(remove(ref(db('alice'), 'users/alice/elo')));
	await assertFails(remove(ref(db('alice'), 'users/alice')));
	await assertFails(remove(ref(db('alice'), 'leaderboard/alice')));
	// The rest of the profile stays the owner's.
	await assertSucceeds(set(ref(db('alice'), 'users/alice/displayName'), 'Alicia'));
	await assertSucceeds(set(ref(db('alice'), 'users/alice/annotationMode'), true));
});

test('a new profile starts at the starting values', async () => {
	await assertSucceeds(set(ref(db('carol'), 'users/carol'), profile));
	await assertSucceeds(set(ref(db('carol'), 'leaderboard/carol'), { displayName: 'Carol', elo: 1000, gamesPlayed: 0 }));
	await assertFails(set(ref(db('dave'), 'users/dave'), Object.assign({}, profile, { elo: 2000 })));
	await assertFails(set(ref(db('dave'), 'users/dave'), Object.assign({}, profile, { wins: 5 })));
	await assertFails(set(ref(db('carol'), 'leaderboard/carol2'), { displayName: 'X', elo: 1000, gamesPlayed: 0 }));
});

test('game histories are server-only', async () => {
	await assertFails(set(ref(db('alice'), 'user_games/alice/g1'), { result: 'win' }));
	await assertFails(set(ref(db('bob'), 'user_games/alice/g1'), { result: 'loss', opponentUid: 'bob' }));
});

test('a game record is written by one of its players, and only before it is rated', async () => {
	// Online games are recorded by the server; clients record AI and local games.
	await assertFails(set(ref(db('alice'), 'completed_games/g0'), { winner: 'red', timestamp: 1, redUid: 'alice', blueUid: 'bob', ranked: true }));
	const rec = { winner: 'red', timestamp: 1, redUid: 'alice', blueUid: '__ai_rust_hard__', ranked: true };
	await assertFails(set(ref(db('mallory'), 'completed_games/g1'), rec));
	await assertSucceeds(set(ref(db('alice'), 'completed_games/g1'), rec));
	await assertFails(set(ref(db('bob'), 'completed_games/g1'), rec));
	await assertSucceeds(set(ref(db('alice'), 'completed_games/g6'), Object.assign({}, rec, { blueUid: 'alice' })));
	await assertFails(set(ref(db('alice'), 'completed_games/g2'), Object.assign({ eloProcessed: true, eloChange: 32 }, rec)));
	await seed({ completed_games: { g3: Object.assign({ eloProcessed: true }, rec) } });
	await assertFails(set(ref(db('alice'), 'completed_games/g3'), rec));
	// Guest games need no sign-in and are never ranked.
	await assertSucceeds(set(ref(db(null), 'completed_games/g4'), { winner: 'red', timestamp: 1, guest: true, ranked: false }));
	await assertFails(set(ref(db(null), 'completed_games/g5'), { winner: 'red', timestamp: 1, guest: true, ranked: true }));
});

const waiting = { spellNames: ['a'], status: 'waiting', created: Date.now(), ranked: false,
	red: { uid: 'alice', displayName: 'Alice', connected: true }, blue: { connected: false },
	timeControl: { type: 'none' }, variant: 'standard', allowSpectators: true, seq: true };

test('rooms: create, join, play', async () => {
	await assertFails(set(ref(db(null), 'rooms/R1'), waiting));
	await assertFails(set(ref(db('bob'), 'rooms/R1'), waiting));
	await assertFails(set(ref(db('alice'), 'rooms/R1'), Object.assign({}, waiting, { ranked: true })));
	await assertFails(set(ref(db('alice'), 'rooms/R1'), Object.assign({}, waiting, { blue: { uid: 'bob' } })));
	// A new room carries no result.
	await assertFails(set(ref(db('alice'), 'rooms/R1'), Object.assign({}, waiting, { forfeitedBy: 'blue' })));
	await assertFails(set(ref(db('alice'), 'rooms/R1'), Object.assign({}, waiting, { winner: 'red' })));
	await assertSucceeds(set(ref(db('alice'), 'rooms/R1'), waiting));
	// An existing room cannot be replaced.
	await assertFails(set(ref(db('alice'), 'rooms/R1'), waiting));
	// Join: the empty seat, status and ranked in one update.
	await assertFails(update(ref(db('bob'), 'rooms/R1'), { red: { uid: 'bob', connected: true } }));
	await assertSucceeds(update(ref(db('bob'), 'rooms/R1'),
		{ blue: { uid: 'bob', displayName: 'Bob', connected: true }, status: 'playing', ranked: true }));
	// The seat is now taken.
	await assertFails(update(ref(db('mallory'), 'rooms/R1'), { blue: { uid: 'mallory', connected: true } }));
	// Turns: only as yourself, with the server's timestamp.
	// The first turn of a room moves rooms/{id}/last in the same write.
	await assertFails(set(ref(db('alice'), 'rooms/R1/turns/t1'), { color: 'red', actions: ['a1', 'pass'], timestamp: serverTimestamp() }));
	await assertSucceeds(update(ref(db('alice'), 'rooms/R1'), { 'turns/t1': { color: 'red', actions: ['a1', 'pass'], timestamp: serverTimestamp() }, last: { key: 't1', color: 'red' } }));
	await assertFails(set(ref(db('alice'), 'rooms/R1/turns/t2'), { color: 'blue', actions: ['pass'], timestamp: serverTimestamp() }));
	await assertFails(set(ref(db('mallory'), 'rooms/R1/turns/t2'), { color: 'blue', actions: ['pass'], timestamp: serverTimestamp() }));
	await assertFails(set(ref(db('bob'), 'rooms/R1/turns/t2'), { color: 'blue', actions: ['pass'], timestamp: 5 }));
	await assertFails(set(ref(db('bob'), 'rooms/R1/turns/t1'), { color: 'blue', actions: ['pass'], timestamp: serverTimestamp() }));
	await assertSucceeds(update(ref(db('bob'), 'rooms/R1'), { 'timer/red': 1000, currentSfn: 'x', 'blue/connected': false }));
	await assertFails(set(ref(db('mallory'), 'rooms/R1/currentSfn'), 'y'));
	// startedAt was the join's; seats stay writable while playing.
	await assertFails(set(ref(db('alice'), 'rooms/R1/startedAt'), 5));
	// Settings fixed at creation stay fixed.
	await assertFails(set(ref(db('alice'), 'rooms/R1/spellNames'), ['b']));
	await assertFails(set(ref(db('alice'), 'rooms/R1/startPos'), { redWinProb: 1 }));
	// A forfeit is written by the side that gives up.
	await assertFails(set(ref(db('alice'), 'rooms/R1/forfeitedBy'), 'blue'));
	await assertSucceeds(set(ref(db('bob'), 'rooms/R1/forfeitedBy'), 'blue'));
	// Finishing needs a winner and the finisher's own colour in finishedBy.
	await assertFails(update(ref(db('alice'), 'rooms/R1'), { status: 'finished' }));
	await assertFails(update(ref(db('alice'), 'rooms/R1'), { status: 'finished', winner: 'red', finishedBy: 'blue' }));
	await assertFails(update(ref(db('mallory'), 'rooms/R1'), { status: 'finished', winner: 'red', finishedBy: 'red' }));
	await assertFails(update(ref(db('alice'), 'rooms/R1'), { status: 'waiting' }));
	// The ranked flag is set at the join and never again; a reason for the
	// end comes from the side that closes the room.
	await assertFails(set(ref(db('alice'), 'rooms/R1/ranked'), false));
	await assertFails(update(ref(db('bob'), 'rooms/R1'), { endReason: 'time' }));
	await assertFails(update(ref(db('bob'), 'rooms/R1'), { endReason: 'time', finishedBy: 'red' }));
	await assertSucceeds(update(ref(db('bob'), 'rooms/R1'), { endReason: 'time', finishedBy: 'blue', winner: 'blue' }));
	// A playing room cannot be deleted.
	await assertFails(remove(ref(db('alice'), 'rooms/R1')));
	// ... and the server's time of closing.
	await assertFails(update(ref(db('alice'), 'rooms/R1'), { status: 'finished', winner: 'red', finishedBy: 'red' }));
	await assertFails(update(ref(db('alice'), 'rooms/R1'), { status: 'finished', winner: 'red', finishedBy: 'red', closedAt: 5 }));
	await assertSucceeds(update(ref(db('alice'), 'rooms/R1'), { status: 'finished', winner: 'red', finishedBy: 'red', closedAt: serverTimestamp() }));
	// Once finished the result is fixed, and only the server records it.
	await assertFails(set(ref(db('bob'), 'rooms/R1/winner'), 'blue'));
	await assertFails(set(ref(db('bob'), 'rooms/R1/status'), 'playing'));
	await assertFails(set(ref(db('alice'), 'rooms/R1/gameId'), 'g1'));
	await assertSucceeds(update(ref(db('bob'), 'rooms/R1'), { gameLog: [], finalSfn: 'x' }));
	// A finished room's seats are frozen (abandonment is judged by them).
	await assertFails(update(ref(db('bob'), 'rooms/R1/blue'), { connected: true, disconnectedAt: null }));
	// Spectators need no account.
	await assertSucceeds(set(ref(db(null), 'rooms/R1/spectators/s1'), { joined: 1 }));
	await assertSucceeds(remove(ref(db(null), 'rooms/R1/spectators/s1')));
	await assertFails(remove(ref(db('mallory'), 'rooms/R1')));
	// Finished but not yet rated by the server: it stays (recorded is not enough).
	await assertFails(remove(ref(db('alice'), 'rooms/R1')));
	await env.withSecurityRulesDisabled((c) => set(ref(c.database(), 'rooms/R1/gameId'), 'g1'));
	await assertFails(remove(ref(db('alice'), 'rooms/R1')));
	await env.withSecurityRulesDisabled((c) => set(ref(c.database(), 'rooms/R1/ratedAt'), 1));
	await assertSucceeds(remove(ref(db('alice'), 'rooms/R1')));
});

test('rooms: an abort names the side that aborts', async () => {
	await seed({ rooms: { R2: Object.assign({}, waiting, { status: 'playing', blue: { uid: 'bob', connected: true } }) } });
	// A seat going offline: the server stamps the time on the owner's seat.
	await assertSucceeds(update(ref(db('bob'), 'rooms/R2/blue'), { connected: false, disconnectedAt: serverTimestamp() }));
	await assertFails(update(ref(db('alice'), 'rooms/R2/blue'), { connected: false, disconnectedAt: 1 }));
	await assertFails(update(ref(db('alice'), 'rooms/R2'), { status: 'aborted' }));
	await assertFails(update(ref(db('alice'), 'rooms/R2'), { status: 'aborted', abortedBy: 'blue' }));
	await assertFails(update(ref(db('mallory'), 'rooms/R2'), { status: 'aborted', abortedBy: 'red' }));
	await assertSucceeds(update(ref(db('alice'), 'rooms/R2'), { status: 'aborted', abortedBy: 'red' }));
	await assertFails(update(ref(db('bob'), 'rooms/R2'), { status: 'finished', winner: 'blue', finishedBy: 'blue' }));
	// ... and once aborted, the seats are frozen.
	await assertFails(update(ref(db('bob'), 'rooms/R2/blue'), { connected: true }));
});

test('rooms: a takeback removes turns only when the opponent accepts', async () => {
	// A room created before turn sequencing (no `seq`): the old rule.
	const playing = Object.assign({}, waiting, { status: 'playing', blue: { uid: 'bob', connected: true },
		turns: { t1: { color: 'red', actions: ['a1'], timestamp: 1 }, t2: { color: 'blue', actions: ['b2'], timestamp: 2 } } });
	delete playing.seq;
	await seed({ rooms: { R3: playing } });
	await assertFails(remove(ref(db('alice'), 'rooms/R3/turns/t2')));
	await assertFails(set(ref(db('alice'), 'rooms/R3/takeback'), { by: 'blue', keys: { t1: true, t2: true } }));
	await assertFails(set(ref(db('mallory'), 'rooms/R3/takeback'), { by: 'red', keys: { t1: true, t2: true } }));
	await assertSucceeds(set(ref(db('alice'), 'rooms/R3/takeback'), { by: 'red', keys: { t1: true, t2: true } }));
	// The requester may not apply it itself.
	await assertFails(update(ref(db('alice'), 'rooms/R3'), { 'turns/t1': null, 'turns/t2': null, takeback: null }));
	await assertSucceeds(update(ref(db('bob'), 'rooms/R3'), { 'turns/t1': null, 'turns/t2': null, takeback: null, currentSfn: null }));
	// A move built on a turn that was taken back is refused; on the latest turn it lands.
	await assertFails(set(ref(db('alice'), 'rooms/R3/turns/t3'), { color: 'red', actions: ['a2'], timestamp: serverTimestamp(), after: 't2' }));
	await assertSucceeds(update(ref(db('alice'), 'rooms/R3'), { 'turns/t3': { color: 'red', actions: ['a2'], timestamp: serverTimestamp() }, takeback: null }));
	// Without a request naming them, turns stay.
	await seed({ rooms: { R4: playing } });
	await assertFails(remove(ref(db('bob'), 'rooms/R4/turns/t1')));
});

test('rooms: rematches, local archives and expired invites', async () => {
	await seed({ rooms: { OLD: Object.assign({}, waiting, { status: 'finished', ranked: true,
		blue: { uid: 'bob', displayName: 'Bob' } }) } });
	const rematch = Object.assign({}, waiting, { status: 'playing', ranked: true, rematchOf: 'OLD',
		red: { uid: 'bob', connected: false }, blue: { uid: 'alice', connected: false } });
	// Both players must have offered the rematch on the old room, and it
	// keeps the old room's clock and variant.
	await assertFails(set(ref(db('alice'), 'rooms/NEW'), rematch));
	await env.withSecurityRulesDisabled((c) => update(ref(c.database(), 'rooms/OLD/rematch'), { red: 'offered', blue: 'offered' }));
	await assertFails(set(ref(db('alice'), 'rooms/NEW'), Object.assign({}, rematch, { timeControl: { type: 'realtime', initialTime: 0 } })));
	await assertFails(set(ref(db('mallory'), 'rooms/NEW'), rematch));
	await assertFails(set(ref(db('alice'), 'rooms/NEW'), Object.assign({}, rematch, { blue: { uid: 'mallory' } })));
	await assertFails(set(ref(db('alice'), 'rooms/NEW'), Object.assign({}, rematch, { forfeitedBy: 'red' })));
	await assertSucceeds(set(ref(db('alice'), 'rooms/NEW'), rematch));

	const local = { local: true, status: 'finished', red: { uid: 'g1' }, blue: { uid: '__ai_easy__' }, winner: 'red', created: 1 };
	await assertSucceeds(set(ref(db(null), 'rooms/L1'), local));
	await assertFails(set(ref(db(null), 'rooms/L2'), Object.assign({}, local, { status: 'playing' })));

	await seed({ rooms: { EXP: Object.assign({}, waiting, { created: 1 }), FRESH: waiting } });
	await assertSucceeds(remove(ref(db('mallory'), 'rooms/EXP')));
	await assertFails(remove(ref(db('mallory'), 'rooms/FRESH')));
});

test('push tokens: only their owner reads or writes them', async () => {
	const h = '0123456789abcdef0123456789abcdef';
	const tok = { token: 'fcm-token', created: serverTimestamp() };
	await assertSucceeds(set(ref(db('bob'), 'push_tokens/bob/' + h), tok));
	await assertSucceeds(get(ref(db('bob'), 'push_tokens/bob')));
	await assertFails(get(ref(db('alice'), 'push_tokens/bob')));
	await assertFails(get(ref(db('alice'), 'push_tokens/bob/' + h)));
	await assertFails(get(ref(db(null), 'push_tokens/bob')));
	await assertFails(get(ref(db('alice'), 'push_tokens')));
	await assertFails(set(ref(db('alice'), 'push_tokens/bob/' + h), tok));
	await assertFails(remove(ref(db('alice'), 'push_tokens/bob/' + h)));
	await assertFails(set(ref(db(null), 'push_tokens/bob/' + h), tok));
	// The key is a token hash, the time the server's, and nothing else rides along.
	await assertFails(set(ref(db('bob'), 'push_tokens/bob/not-a-hash'), tok));
	await assertFails(set(ref(db('bob'), 'push_tokens/bob/' + h), { token: 'x', created: 1 }));
	await assertFails(set(ref(db('bob'), 'push_tokens/bob/' + h), Object.assign({ extra: 1 }, tok)));
	await assertSucceeds(remove(ref(db('bob'), 'push_tokens/bob/' + h)));
	// users/ stays public, so tokens never go there.
	await assertSucceeds(get(ref(db(null), 'users/bob')));
});

test('rooms: lobby settings (public, casual, the creator\'s colour) are fixed at creation', async () => {
	// The creator may sit in either seat and must name it.
	const blueSeek = Object.assign({}, waiting, { public: true, casual: true, creatorColor: 'blue',
		red: { connected: false }, blue: { uid: 'alice', displayName: 'Alice', connected: true } });
	await assertFails(set(ref(db('alice'), 'rooms/L1'), Object.assign({}, blueSeek, { creatorColor: 'red' })));
	await assertFails(set(ref(db('alice'), 'rooms/L1'), Object.assign({}, blueSeek, { creatorColor: 'green' })));
	await assertFails(set(ref(db('alice'), 'rooms/L1'), Object.assign({}, blueSeek, { public: 'yes' })));
	await assertFails(set(ref(db('alice'), 'rooms/L1'), Object.assign({}, blueSeek, { casual: 1 })));
	await assertSucceeds(set(ref(db('alice'), 'rooms/L1'), blueSeek));
	await assertSucceeds(set(ref(db('alice'), 'rooms/L2'), Object.assign({}, waiting, { creatorColor: 'red', public: true })));
	// Fixed once created, by anyone.
	await assertFails(set(ref(db('alice'), 'rooms/L1/casual'), false));
	await assertFails(set(ref(db('alice'), 'rooms/L1/public'), false));
	await assertFails(set(ref(db('alice'), 'rooms/L1/creatorColor'), 'red'));
	// A casual room cannot be joined rated.
	await assertFails(update(ref(db('bob'), 'rooms/L1'),
		{ red: { uid: 'bob', displayName: 'Bob', connected: true }, status: 'playing', ranked: true }));
	await assertSucceeds(update(ref(db('bob'), 'rooms/L1'),
		{ red: { uid: 'bob', displayName: 'Bob', connected: true }, status: 'playing', ranked: false }));
	await assertFails(set(ref(db('bob'), 'rooms/L1/ranked'), true));
	// Two joiners race for one seat: the second claim is refused.
	await assertSucceeds(update(ref(db('bob'), 'rooms/L2'),
		{ blue: { uid: 'bob', displayName: 'Bob', connected: true }, status: 'playing', ranked: true }));
	await assertFails(update(ref(db('carol'), 'rooms/L2'),
		{ blue: { uid: 'carol', displayName: 'Carol', connected: true }, status: 'playing', ranked: true }));
	// The creator withdraws a waiting seek (waiting -> expired, then removed).
	await assertSucceeds(set(ref(db('alice'), 'rooms/L3'), Object.assign({}, waiting, { creatorColor: 'red', public: true })));
	await assertFails(set(ref(db('bob'), 'rooms/L3/status'), 'expired'));
	await assertSucceeds(set(ref(db('alice'), 'rooms/L3/status'), 'expired'));
	await assertFails(update(ref(db('bob'), 'rooms/L3'),
		{ blue: { uid: 'bob', displayName: 'Bob', connected: true }, status: 'playing', ranked: false }));
	await assertSucceeds(remove(ref(db('alice'), 'rooms/L3')));
});

test('rooms: the lobby reads a public index; rooms/ itself is not listable', async () => {
	const { query, orderByChild, equalTo, get } = require('firebase/database');
	const priv = Object.assign({}, waiting, { creatorColor: 'red' });
	const pub = Object.assign({}, waiting, { creatorColor: 'red', public: true });
	const live = Object.assign({}, waiting, { status: 'playing', blue: { uid: 'bob', connected: true } });
	const noSpec = Object.assign({}, live, { allowSpectators: false });
	await seed({ rooms: { PRIV: priv, PUB: pub, LIVE: live, NOSPEC: noSpec } });
	// No status-wide (or any) query of rooms/: private invites and
	// no-spectator games stay unlisted.
	const rooms = ref(db(null), 'rooms');
	await assertFails(get(query(rooms, orderByChild('status'), equalTo('waiting'))));
	await assertFails(get(query(rooms, orderByChild('status'), equalTo('playing'))));
	await assertFails(get(rooms));
	// The indexes are public to read.
	await assertSucceeds(get(ref(db(null), 'open_rooms')));
	await assertSucceeds(get(ref(db(null), 'live_rooms')));
	// open_rooms: only a public waiting room, only by its creator.
	await assertFails(set(ref(db('alice'), 'open_rooms/PRIV'), true));
	await assertFails(set(ref(db('bob'), 'open_rooms/PUB'), true));
	await assertFails(set(ref(db(null), 'open_rooms/PUB'), true));
	await assertFails(set(ref(db('alice'), 'open_rooms/PUB'), { x: 1 }));
	await assertFails(set(ref(db('alice'), 'open_rooms/NOPE'), true));
	await assertSucceeds(set(ref(db('alice'), 'open_rooms/PUB'), true));
	// ... and nobody else may take it down while it is open.
	await assertFails(remove(ref(db('bob'), 'open_rooms/PUB')));
	// live_rooms: a playing room that allows spectators, by one of its players.
	await assertFails(set(ref(db('alice'), 'live_rooms/NOSPEC'), true));
	await assertFails(set(ref(db('carol'), 'live_rooms/LIVE'), true));
	await assertFails(set(ref(db('alice'), 'live_rooms/PUB'), true));
	await assertSucceeds(set(ref(db('bob'), 'live_rooms/LIVE'), true));
	await assertFails(remove(ref(db('carol'), 'live_rooms/LIVE')));
	// The joiner moves the room from one list to the other.
	await assertSucceeds(update(ref(db('bob'), 'rooms/PUB'),
		{ blue: { uid: 'bob', displayName: 'Bob', connected: true }, status: 'playing', ranked: false, startedAt: serverTimestamp() }));
	await assertSucceeds(remove(ref(db('bob'), 'open_rooms/PUB')));
	await assertSucceeds(set(ref(db('bob'), 'live_rooms/PUB'), true));
	// Once a room is over (or gone), anyone may clear its stale entry.
	await assertSucceeds(update(ref(db('alice'), 'rooms/LIVE'), { forfeitedBy: 'red', finishedBy: 'red', winner: 'blue', endReason: 'forfeit', status: 'finished', closedAt: serverTimestamp() }));
	await assertSucceeds(remove(ref(db('carol'), 'live_rooms/LIVE')));
	await env.withSecurityRulesDisabled((ctx) => set(ref(ctx.database(), 'open_rooms/GONE'), true));
	await assertSucceeds(remove(ref(db('carol'), 'open_rooms/GONE')));
});

// ---- turn sequencing: rooms/{id}/last ----

const T = (color, after) => Object.assign({ color, actions: ['x'], timestamp: serverTimestamp() }, after ? { after } : {});
const move = (uid, room, key, color, after) => update(ref(db(uid), 'rooms/' + room),
	{ ['turns/' + key]: T(color, after), last: { key, color }, takeback: null });
const playingRoom = (extra) => Object.assign({}, waiting, { status: 'playing', ranked: true, blue: { uid: 'bob', connected: true } }, extra || {});

test('turns: each follows the last turn, alternating colours, from the first mover', async () => {
	await seed({ rooms: { S1: playingRoom() } });
	// Red moves first in a room from the start; blue may not open.
	await assertFails(move('bob', 'S1', 'b0', 'blue'));
	// The first turn names no turn before it.
	await assertFails(move('alice', 'S1', 'a1', 'red', 'nothing'));
	await assertSucceeds(move('alice', 'S1', 'a1', 'red'));
	// The same colour twice is refused, even following the last turn.
	await assertFails(move('alice', 'S1', 'a2', 'red', 'a1'));
	// A turn not built on the last one, or without `after`, is refused.
	await assertFails(move('bob', 'S1', 'b1', 'blue'));
	await assertFails(move('bob', 'S1', 'b1', 'blue', 'zz'));
	// A turn that leaves `last` behind, or points it at another turn.
	await assertFails(set(ref(db('bob'), 'rooms/S1/turns/b1'), T('blue', 'a1')));
	await assertFails(update(ref(db('bob'), 'rooms/S1'), { 'turns/b1': T('blue', 'a1'), last: { key: 'a1', color: 'red' } }));
	await assertFails(update(ref(db('bob'), 'rooms/S1'), { 'turns/b1': T('blue', 'a1'), last: { key: 'b1', color: 'red' } }));
	await assertFails(update(ref(db('bob'), 'rooms/S1'), { 'turns/b1': T('blue', 'a1'), last: { key: 'b1', color: 'blue', extra: 1 } }));
	await assertSucceeds(move('bob', 'S1', 'b1', 'blue', 'a1'));
	// Out of order: a turn following an older turn.
	await assertFails(move('alice', 'S1', 'a2', 'red', 'a1'));
	await assertSucceeds(move('alice', 'S1', 'a2', 'red', 'b1'));
	const last = (await get(ref(db('alice'), 'rooms/S1/last'))).val();
	assert.deepStrictEqual(last, { key: 'a2', color: 'red' });
});

test('turns: two turns in one write, `last` alone, deleting turns or `last` are refused', async () => {
	await seed({ rooms: { S2: playingRoom() } });
	await assertSucceeds(move('alice', 'S2', 'a1', 'red'));
	await assertSucceeds(move('bob', 'S2', 'b1', 'blue', 'a1'));
	// Red writes its turn and a blue reply, or two of its own, in one update.
	await assertFails(update(ref(db('alice'), 'rooms/S2'), { 'turns/a2': T('red', 'b1'), 'turns/a3': T('red', 'a2'), last: { key: 'a3', color: 'red' } }));
	await assertFails(update(ref(db('alice'), 'rooms/S2'), { 'turns/a2': T('red', 'b1'), 'turns/a3': T('red', 'b1'), last: { key: 'a2', color: 'red' } }));
	await assertFails(update(ref(db('alice'), 'rooms/S2'), { 'turns/a2': T('red', 'b1'), 'turns/b2': T('blue', 'a2'), last: { key: 'b2', color: 'blue' } }));
	// `last` alone: back to an older turn, to a missing turn, or with a false colour.
	await assertFails(set(ref(db('alice'), 'rooms/S2/last'), { key: 'a1', color: 'red' }));
	await assertFails(set(ref(db('alice'), 'rooms/S2/last'), { key: 'zz', color: 'red' }));
	await assertFails(set(ref(db('alice'), 'rooms/S2/last'), { key: 'b1', color: 'red' }));
	await assertFails(set(ref(db('alice'), 'rooms/S2/last/color'), 'blue'));
	await assertFails(set(ref(db('alice'), 'rooms/S2/last/key'), 'a1'));
	await assertFails(remove(ref(db('alice'), 'rooms/S2/last')));
	await assertFails(set(ref(db('mallory'), 'rooms/S2/last'), { key: 'b1', color: 'blue' }));
	// Deleting turns without an accepted takeback.
	await assertFails(remove(ref(db('alice'), 'rooms/S2/turns/b1')));
	await assertFails(update(ref(db('bob'), 'rooms/S2'), { 'turns/b1': null, last: { key: 'a1', color: 'red' } }));
	// A new room cannot be created with a `last`.
	await assertFails(set(ref(db('alice'), 'rooms/S3'), Object.assign({}, waiting, { last: { key: 'x', color: 'blue' } })));
	await assertSucceeds(move('alice', 'S2', 'a2', 'red', 'b1'));
});

test('turns: a room from a position starts with its side to move', async () => {
	// A room's startSfn is the position before the first turn: counter 13 -> blue moves (rating.js sideToMove).
	await seed({ rooms: { P1: playingRoom({ startSfn: 'x r 13 0:0' }), P2: playingRoom({ startSfn: 'x b 12 0:0' }),
		P3: playingRoom({ startSfn: 'x r 7' }) } });
	await assertFails(move('alice', 'P1', 'a1', 'red'));
	await assertSucceeds(move('bob', 'P1', 'b1', 'blue'));
	await assertSucceeds(move('alice', 'P1', 'a1', 'red', 'b1'));
	await assertFails(move('bob', 'P2', 'b1', 'blue'));
	await assertSucceeds(move('alice', 'P2', 'a1', 'red'));
	await assertSucceeds(move('bob', 'P3', 'b1', 'blue'));
});

test('turns: a room begun before `last` keeps the old rule until it ends', async () => {
	const legacy = playingRoom({ turns: { t1: { color: 'red', actions: ['a'], timestamp: 1 }, t2: { color: 'blue', actions: ['b'], timestamp: 2 } } });
	delete legacy.seq;
	await seed({ rooms: { O1: legacy } });
	await assertSucceeds(set(ref(db('alice'), 'rooms/O1/turns/t3'), T('red', 't2')));
	await assertSucceeds(set(ref(db('bob'), 'rooms/O1/turns/t4'), T('blue')));
	await assertFails(set(ref(db('bob'), 'rooms/O1/turns/t5'), T('blue', 'gone')));
	// A takeback there works as before.
	await assertSucceeds(set(ref(db('bob'), 'rooms/O1/takeback'), { by: 'blue', keys: { t4: true } }));
	await assertSucceeds(update(ref(db('alice'), 'rooms/O1'), { 'turns/t4': null, takeback: null }));
});

test('turns: sequencing is fixed at creation (rooms/{id}/seq); rooms created before it keep the old rule', async () => {
	// New rooms must sequence: no room is created without `seq`, and it never changes.
	const noSeq = Object.assign({}, waiting);
	delete noSeq.seq;
	await assertFails(set(ref(db('alice'), 'rooms/Q1'), noSeq));
	await assertFails(set(ref(db('alice'), 'rooms/Q1'), Object.assign({}, waiting, { seq: false })));
	await assertSucceeds(set(ref(db('alice'), 'rooms/Q1'), waiting));
	await assertFails(set(ref(db('alice'), 'rooms/Q1/seq'), false));
	await assertFails(remove(ref(db('alice'), 'rooms/Q1/seq')));
	// A room created before (no `seq`), still without turns: a client from
	// before the deploy opens it without `last`, as before.
	const old = playingRoom();
	delete old.seq;
	await seed({ rooms: { Z1: old, Z2: playingRoom() } });
	await assertSucceeds(set(ref(db('alice'), 'rooms/Z1/turns/a1'), T('red')));
	await assertFails(set(ref(db('bob'), 'rooms/Z1/last'), { key: 'a1', color: 'red' }));
	await assertFails(set(ref(db('alice'), 'rooms/Z2/turns/a1'), T('red')));
	await assertFails(set(ref(db('bob'), 'rooms/Z2/turns/b1'), T('blue')));
	await assertSucceeds(move('alice', 'Z2', 'a1', 'red'));
});

test('takeback: the acceptor moves `last` back to the turn kept, in the same write', async () => {
	await seed({ rooms: { K1: playingRoom() } });
	await assertSucceeds(move('alice', 'K1', 'a1', 'red'));
	await assertSucceeds(move('bob', 'K1', 'b1', 'blue', 'a1'));
	await assertSucceeds(move('alice', 'K1', 'a2', 'red', 'b1'));
	await assertSucceeds(move('bob', 'K1', 'b2', 'blue', 'a2'));
	// Red asks to take back a2 and blue's reply b2.
	await assertSucceeds(set(ref(db('alice'), 'rooms/K1/takeback'), { by: 'red', keys: { a2: true, b2: true } }));
	// The requester may not rewrite `last` while its offer stands, nor apply it.
	await assertFails(set(ref(db('alice'), 'rooms/K1/last'), { key: 'b1', color: 'blue' }));
	await assertFails(update(ref(db('alice'), 'rooms/K1'), { 'turns/a2': null, 'turns/b2': null, takeback: null, last: { key: 'b1', color: 'blue' } }));
	// The acceptor: `last` alone, without deleting the turns.
	await assertFails(set(ref(db('bob'), 'rooms/K1/last'), { key: 'b1', color: 'blue' }));
	// ... deleting them but leaving `last` on a removed turn.
	await assertFails(update(ref(db('bob'), 'rooms/K1'), { 'turns/a2': null, 'turns/b2': null, takeback: null }));
	// ... moving `last` to an older turn, or to the wrong one.
	await assertFails(update(ref(db('bob'), 'rooms/K1'), { 'turns/a2': null, 'turns/b2': null, takeback: null, last: { key: 'a1', color: 'red' } }));
	await assertFails(update(ref(db('bob'), 'rooms/K1'), { 'turns/b2': null, takeback: null, last: { key: 'a2', color: 'red' } }));
	// ... removing only part of what was asked, or a turn not asked for.
	await assertFails(update(ref(db('bob'), 'rooms/K1'), { 'turns/a2': null, takeback: null, last: { key: 'b1', color: 'blue' } }));
	// ... accepting and slipping in a turn of its own built on a removed turn.
	await assertFails(update(ref(db('bob'), 'rooms/K1'), { 'turns/a2': null, 'turns/b2': null, 'turns/b3': T('blue', 'b2'), takeback: null, last: { key: 'b3', color: 'blue' } }));
	await assertSucceeds(update(ref(db('bob'), 'rooms/K1'), { 'turns/a2': null, 'turns/b2': null, takeback: null, currentSfn: 'x', last: { key: 'b1', color: 'blue' } }));
	// Red moves again from b1.
	await assertFails(move('bob', 'K1', 'b3', 'blue', 'b1'));
	await assertSucceeds(move('alice', 'K1', 'a3', 'red', 'b1'));

	// Blue takes back its own last turn (red has not replied).
	await assertSucceeds(move('bob', 'K1', 'b4', 'blue', 'a3'));
	await assertSucceeds(set(ref(db('bob'), 'rooms/K1/takeback'), { by: 'blue', keys: { b4: true } }));
	// The request may not list older turns for removal.
	await assertSucceeds(set(ref(db('bob'), 'rooms/K1/takeback'), { by: 'blue', keys: { b4: true, a3: true, b1: true } }));
	await assertFails(update(ref(db('alice'), 'rooms/K1'), { 'turns/b4': null, 'turns/a3': null, takeback: null, last: { key: 'b1', color: 'blue' } }));
	await assertSucceeds(update(ref(db('alice'), 'rooms/K1'), { 'turns/b4': null, takeback: null, last: { key: 'a3', color: 'red' } }));
});

test('takeback: of the first turn removes `last` with it', async () => {
	await seed({ rooms: { K2: playingRoom() } });
	await assertSucceeds(move('alice', 'K2', 'a1', 'red'));
	await assertSucceeds(set(ref(db('alice'), 'rooms/K2/takeback'), { by: 'red', keys: { a1: true } }));
	await assertFails(update(ref(db('alice'), 'rooms/K2'), { 'turns/a1': null, takeback: null, last: null }));
	await assertFails(update(ref(db('bob'), 'rooms/K2'), { 'turns/a1': null, takeback: null }));
	await assertSucceeds(update(ref(db('bob'), 'rooms/K2'), { 'turns/a1': null, takeback: null, last: null }));
	// The room starts over: red's first turn again.
	await assertFails(move('bob', 'K2', 'b1', 'blue'));
	await assertSucceeds(move('alice', 'K2', 'a2', 'red'));
	// With turns left, `last` may not be removed.
	await assertSucceeds(move('bob', 'K2', 'b2', 'blue', 'a2'));
	await assertSucceeds(set(ref(db('bob'), 'rooms/K2/takeback'), { by: 'blue', keys: { b2: true } }));
	await assertFails(update(ref(db('alice'), 'rooms/K2'), { 'turns/b2': null, takeback: null, last: null }));
});

// ---- reports, admins, bans ----

test('reports: create-only by a signed-in account, read by admins only', async () => {
	await seed({ admins: { root1: true } });
	const rep = { by: 'alice', target: 'bob', room: 'R1', reason: 'cheating', note: 'engine moves', at: serverTimestamp() };
	await assertFails(set(ref(db(null), 'reports/r1'), Object.assign({}, rep, { by: null })));
	await assertFails(set(ref(env.authenticatedContext('anon1', { firebase: { sign_in_provider: 'anonymous' } }).database(), 'reports/r1'),
		Object.assign({}, rep, { by: 'anon1' })));
	await assertFails(set(ref(db('alice'), 'reports/r1'), Object.assign({}, rep, { by: 'carol' })));
	await assertFails(set(ref(db('alice'), 'reports/r1'), Object.assign({}, rep, { target: 'alice' })));
	await assertFails(set(ref(db('alice'), 'reports/r1'), Object.assign({}, rep, { reason: 'ugly' })));
	await assertFails(set(ref(db('alice'), 'reports/r1'), Object.assign({}, rep, { at: 5 })));
	await assertFails(set(ref(db('alice'), 'reports/r1'), Object.assign({}, rep, { resolved: true })));
	await assertFails(set(ref(db('alice'), 'reports/r1'), Object.assign({}, rep, { extra: 1 })));
	await assertFails(set(ref(db('alice'), 'reports/r1'), Object.assign({}, rep, { note: 'x'.repeat(501) })));
	await assertSucceeds(set(ref(db('alice'), 'reports/r1'), rep));
	// Create-only: the reporter cannot edit, resolve or delete it.
	await assertFails(set(ref(db('alice'), 'reports/r1/note'), 'never mind'));
	await assertFails(set(ref(db('alice'), 'reports/r1/resolved'), true));
	await assertFails(remove(ref(db('alice'), 'reports/r1')));
	await assertFails(set(ref(db('alice'), 'reports/r1'), rep));
	// Hidden from everyone but admins (the target and the reporter included).
	await assertFails(get(ref(db('alice'), 'reports')));
	await assertFails(get(ref(db('alice'), 'reports/r1')));
	await assertFails(get(ref(db('bob'), 'reports')));
	await assertSucceeds(get(ref(db('root1'), 'reports')));
	// An admin resolves it with a note; the report itself stays as filed.
	await assertSucceeds(update(ref(db('root1'), 'reports/r1'), { resolved: true, adminNote: 'banned 7 days', resolvedBy: 'root1', resolvedAt: serverTimestamp() }));
	await assertFails(update(ref(db('root1'), 'reports/r1'), { target: 'carol' }));
	await assertFails(remove(ref(db('root1'), 'reports/r1')));
	// Nobody can make themselves an admin; each admin may read their own flag.
	await assertFails(set(ref(db('alice'), 'admins/alice'), true));
	await assertSucceeds(get(ref(db('root1'), 'admins/root1')));
	await assertFails(get(ref(db('alice'), 'admins/root1')));
});

test('bans: set by admins, read by their owner, keep the player out of rated rooms only', async () => {
	await seed({ admins: { root1: true }, rooms: { B1: waiting, B2: waiting, B3: waiting, B4: waiting } });
	const ban = { banUntil: Date.now() + 86400000, reason: 'engine use', by: 'root1', at: serverTimestamp() };
	await assertFails(set(ref(db('bob'), 'user_flags/bob'), ban));
	await assertFails(set(ref(db('alice'), 'user_flags/bob'), ban));
	await assertFails(set(ref(db('root1'), 'user_flags/bob'), Object.assign({}, ban, { by: 'alice' })));
	await assertSucceeds(set(ref(db('root1'), 'user_flags/bob'), ban));
	// Only the player and admins see it; the player cannot lift it.
	await assertSucceeds(get(ref(db('bob'), 'user_flags/bob')));
	await assertFails(get(ref(db('alice'), 'user_flags/bob')));
	await assertSucceeds(get(ref(db('root1'), 'user_flags')));
	await assertFails(remove(ref(db('bob'), 'user_flags/bob')));
	await assertFails(set(ref(db('bob'), 'user_flags/bob/banUntil'), 0));
	await assertFails(set(ref(db('bob'), 'user_flags/bob/abandons'), 0));
	// A rated join is refused; the same join unrated goes ahead.
	const join = (ranked) => ({ blue: { uid: 'bob', displayName: 'Bob', connected: true }, status: 'playing', ranked });
	await assertFails(update(ref(db('bob'), 'rooms/B1'), join(true)));
	await assertSucceeds(update(ref(db('bob'), 'rooms/B1'), join(false)));
	// ... and a banned creator's room is never rated either.
	await env.withSecurityRulesDisabled((c) => set(ref(c.database(), 'user_flags/alice'), { banUntil: Date.now() + 86400000 }));
	await assertFails(update(ref(db('carol'), 'rooms/B2'), Object.assign(join(true), { blue: { uid: 'carol', connected: true } })));
	// The room records why it is unrated, only with ranked false and only
	// while a player in it is suspended.
	const carol = (o) => update(ref(db('carol'), 'rooms/B2'), Object.assign(join(false), { blue: { uid: 'carol', connected: true } }, o));
	await assertFails(carol({ unratedReason: 'casual' }));
	await assertFails(carol({ ranked: true, unratedReason: 'suspended' }));
	await assertSucceeds(carol({ unratedReason: 'suspended' }));
	// A ban that has run out no longer counts.
	await env.withSecurityRulesDisabled((c) => set(ref(c.database(), 'user_flags/alice'), { banUntil: Date.now() - 1000, abandons: 3 }));
	await assertFails(update(ref(db('dave'), 'rooms/B3'), Object.assign(join(false), { blue: { uid: 'dave', connected: true }, unratedReason: 'suspended' })));
	await assertSucceeds(update(ref(db('dave'), 'rooms/B3'), Object.assign(join(true), { blue: { uid: 'dave', connected: true } })));
	// A room already marked ranked while waiting: a suspended joiner who
	// leaves `ranked` alone still cannot start it (status checks the bans).
	await env.withSecurityRulesDisabled((c) => update(ref(c.database(), 'rooms/B4'), { ranked: true }));
	await env.withSecurityRulesDisabled((c) => set(ref(c.database(), 'user_flags/erin'), { banUntil: Date.now() + 86400000 }));
	const erin = { blue: { uid: 'erin', connected: true }, status: 'playing' };
	await assertFails(update(ref(db('erin'), 'rooms/B4'), erin));
	await assertSucceeds(update(ref(db('erin'), 'rooms/B4'), Object.assign({ ranked: false, unratedReason: 'suspended' }, erin)));
	// Guests (anonymous accounts) still create and join casual rooms.
	const anon = env.authenticatedContext('g1', { firebase: { sign_in_provider: 'anonymous' } }).database();
	await assertSucceeds(set(ref(anon, 'rooms/G1'), Object.assign({}, waiting, { red: { uid: 'g1', connected: true, anon: true } })));
	// A rematch of a rated room with a banned player is unrated.
	await env.withSecurityRulesDisabled((c) => update(ref(c.database(), 'rooms/B1'), { status: 'finished', ranked: true, rematch: { red: 'offered', blue: 'offered' } }));
	const rematch = Object.assign({}, waiting, { status: 'playing', ranked: true, rematchOf: 'B1',
		red: { uid: 'bob', connected: false }, blue: { uid: 'alice', connected: false } });
	await env.withSecurityRulesDisabled((c) => set(ref(c.database(), 'user_flags/alice'), { banUntil: Date.now() + 86400000 }));
	await assertFails(set(ref(db('alice'), 'rooms/RM'), rematch));
	await assertFails(set(ref(db('alice'), 'rooms/RM'), Object.assign({}, rematch, { unratedReason: 'suspended' })));
	await assertSucceeds(set(ref(db('alice'), 'rooms/RM'), Object.assign({}, rematch, { ranked: false, unratedReason: 'suspended' })));
});

test('engine analysis: game_evals and the position eval cache are server-only, and public', async () => {
	await seed({
		game_evals: { ROOM1: { gameId: 'g1', plies: 2 } },
		position_evals: { abc: { sfn: 'x', engine: 'rust-v34-nnue_mt256-t1000', stones: 1.5, depth: 3 } },
		game_evals_progress: { g1: { roomCode: 'ROOM1', next: 3 } },
	});
	await assertSucceeds(get(ref(db(null), 'position_evals/abc')));
	await assertSucceeds(get(ref(db('alice'), 'game_evals/ROOM1')));
	// Not even a signed-in player may write a cached eval (the evalPositions
	// callable searches each position itself) or a game's analysis.
	await assertFails(set(ref(db('alice'), 'position_evals/abc'), { sfn: 'x', engine: 'rust-v34-nnue_mt256-t1000', stones: 39 }));
	await assertFails(set(ref(db('alice'), 'position_evals/new'), { sfn: 'y', stones: 0 }));
	await assertFails(remove(ref(db('alice'), 'position_evals/abc')));
	await assertFails(set(ref(db('alice'), 'game_evals/ROOM2'), { gameId: 'g2' }));
	// The cache is read by key only, and the analysis in progress not at all.
	await assertFails(get(ref(db('alice'), 'position_evals')));
	await assertFails(get(ref(db('alice'), 'game_evals_progress/g1')));
	await assertFails(set(ref(db('alice'), 'game_evals_progress/g1/next'), 0));
	// Nor the evalPositions quota counters.
	await assertFails(get(ref(db('alice'), 'eval_quota')));
	await assertFails(set(ref(db('alice'), 'eval_quota/2026-10-26/u_alice'), 0));
	await assertFails(set(ref(db('alice'), 'analysis_pending/g1'), { winner: 'red' }));
});
