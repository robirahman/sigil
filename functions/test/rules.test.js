'use strict';
// database.rules.json against the Realtime Database emulator:
//   cd functions && npm run test:rules
// (firebase emulators:exec starts the emulator and sets
// FIREBASE_DATABASE_EMULATOR_HOST.)

const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
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
	timeControl: { type: 'none' }, variant: 'standard', allowSpectators: true };

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
	await assertSucceeds(set(ref(db('alice'), 'rooms/R1/turns/t1'), { color: 'red', actions: ['a1', 'pass'], timestamp: serverTimestamp() }));
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
	const playing = Object.assign({}, waiting, { status: 'playing', blue: { uid: 'bob', connected: true },
		turns: { t1: { color: 'red', actions: ['a1'], timestamp: 1 }, t2: { color: 'blue', actions: ['b2'], timestamp: 2 } } });
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
	// Not once either has blocked the other (an offer left standing).
	await env.withSecurityRulesDisabled((c) => set(ref(c.database(), 'blocks/bob/alice'), true));
	await assertFails(set(ref(db('alice'), 'rooms/NEW'), rematch));
	await env.withSecurityRulesDisabled((c) => set(ref(c.database(), 'blocks'), { alice: { bob: true } }));
	await assertFails(set(ref(db('alice'), 'rooms/NEW'), rematch));
	await env.withSecurityRulesDisabled((c) => remove(ref(c.database(), 'blocks')));
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

const guestDb = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).database();
const named = (n) => Object.assign({}, profile, { displayName: n });

test('follows: written only by the follower, mirrored in followers', async () => {
	await seed({ users: { alice: named('Alice'), bob: named('Bob'), __ai_rust_hard__: named('Hard AI') } });
	const follow = (who, target, v) => ({ ['follows/' + who + '/' + target]: v, ['followers/' + target + '/' + who]: v });
	// Both halves, in one update.
	await assertFails(set(ref(db('alice'), 'follows/alice/bob'), true));
	await assertFails(set(ref(db('alice'), 'followers/bob/alice'), true));
	await assertSucceeds(update(ref(db('alice')), follow('alice', 'bob', true)));
	// Nobody follows (or unfollows) on someone else's behalf.
	await assertFails(update(ref(db('mallory')), follow('bob', 'alice', true)));
	await assertFails(update(ref(db('bob')), follow('alice', 'bob', null)));
	await assertFails(remove(ref(db('bob'), 'followers/bob/alice')));
	// Not yourself, not an account that does not exist, not an AI, not as a guest.
	await assertFails(update(ref(db('alice')), follow('alice', 'alice', true)));
	await assertFails(update(ref(db('alice')), follow('alice', 'nobody', true)));
	await assertFails(update(ref(db('alice')), follow('alice', '__ai_rust_hard__', true)));
	await assertFails(update(ref(guestDb('gina')), follow('gina', 'bob', true)));
	// Unfollow removes both halves together.
	await assertFails(remove(ref(db('alice'), 'follows/alice/bob')));
	await assertSucceeds(update(ref(db('alice')), follow('alice', 'bob', null)));
	// Follow lists are public.
	await assertSucceeds(get(ref(db(null), 'followers/bob')));
	await assertSucceeds(get(ref(db(null), 'follows/alice')));
	// Someone who blocked you cannot be followed.
	await seed({ users: { alice: named('Alice'), bob: named('Bob') }, blocks: { bob: { alice: true } }, blockedBy: { alice: { bob: true } } });
	await assertFails(update(ref(db('alice')), follow('alice', 'bob', true)));
	// Nor someone you blocked, nor an account being deleted.
	await seed({ users: { alice: named('Alice'), bob: named('Bob') }, blocks: { alice: { bob: true } }, blockedBy: { bob: { alice: true } } });
	await assertFails(update(ref(db('alice')), follow('alice', 'bob', true)));
	await seed({ users: { alice: named('Alice'), bob: named('Bob') }, deleted_users: { bob: 1 } });
	await assertFails(update(ref(db('alice')), follow('alice', 'bob', true)));
});

test('blocks: owner-written with their blockedBy index; readable by the owner and the one blocked', async () => {
	const blk = (who, target, v) => ({ ['blocks/' + who + '/' + target]: v, ['blockedBy/' + target + '/' + who]: v });
	await seed({ users: { alice: named('Alice'), bob: named('Bob'), carol: named('Carol') } });
	// Not an account that does not exist (or was deleted).
	await assertFails(update(ref(db('bob')), blk('bob', 'ghost', true)));
	// Nor one being deleted (deleteUserData marks it first, removes the profile last).
	await env.withSecurityRulesDisabled((c) => set(ref(c.database(), 'deleted_users/carol'), 1));
	await assertFails(update(ref(db('bob')), blk('bob', 'carol', true)));
	await env.withSecurityRulesDisabled((c) => remove(ref(c.database(), 'deleted_users')));
	// The block and its reverse index go together.
	await assertFails(set(ref(db('bob'), 'blocks/bob/alice'), true));
	await assertFails(set(ref(db('bob'), 'blockedBy/alice/bob'), true));
	await assertSucceeds(update(ref(db('bob')), blk('bob', 'alice', true)));
	await assertFails(update(ref(db('alice')), blk('bob', 'carol', true)));
	await assertFails(update(ref(db('alice')), blk('bob', 'alice', null)));
	await assertFails(remove(ref(db('bob'), 'blocks/bob/alice')));
	await assertFails(update(ref(db('bob')), blk('bob', 'bob', true)));
	await assertFails(update(ref(db('bob')), Object.assign(blk('bob', 'carol', true), { 'blocks/bob/carol': 'yes' })));
	await assertFails(update(ref(guestDb('gina')), blk('gina', 'bob', true)));
	await assertSucceeds(get(ref(db('bob'), 'blocks/bob')));
	await assertSucceeds(get(ref(db('alice'), 'blocks/bob/alice')));
	await assertFails(get(ref(db('alice'), 'blocks/bob')));
	await assertFails(get(ref(db('carol'), 'blocks/bob/alice')));
	// Who blocked you is not listable.
	await assertFails(get(ref(db('alice'), 'blockedBy/alice')));
	await assertSucceeds(update(ref(db('bob')), blk('bob', 'alice', null)));
});

test('blocking ends the blocked player\'s follow of the blocker', async () => {
	await seed({ users: { alice: named('Alice'), bob: named('Bob'), carol: named('Carol') },
		follows: { alice: { bob: true }, carol: { bob: true } }, followers: { bob: { alice: true, carol: true } } });
	const unfollowOf = (who, target) => ({ ['follows/' + who + '/' + target]: null, ['followers/' + target + '/' + who]: null });
	// Not without a block.
	await assertFails(update(ref(db('bob')), unfollowOf('alice', 'bob')));
	// With the block, in the same update.
	await assertSucceeds(update(ref(db('bob')), Object.assign({ 'blocks/bob/alice': true, 'blockedBy/alice/bob': true }, unfollowOf('alice', 'bob'))));
	// Only the blocked player's follow, and only both halves together.
	await assertFails(update(ref(db('bob')), unfollowOf('carol', 'bob')));
	await assertFails(remove(ref(db('bob'), 'followers/bob/carol')));
	let v = null;
	await env.withSecurityRulesDisabled(async (c) => { v = (await get(ref(c.database()))).val(); });
	if (v.follows.alice || v.followers.bob.alice || !v.followers.bob.carol) throw new Error('follows: ' + JSON.stringify(v));
});

test('challenges: by a room\'s creator, for its invited player, unless blocked', async () => {
	const room = Object.assign({}, waiting, { creatorColor: 'red', invite: 'bob' });
	await seed({ users: { alice: named('Alice'), bob: named('Bob'), carol: named('Carol') } });
	// The invite is fixed at creation and never public.
	await assertFails(set(ref(db('alice'), 'rooms/C1'), Object.assign({}, room, { invite: 'alice' })));
	await assertFails(set(ref(db('alice'), 'rooms/C1'), Object.assign({}, room, { public: true })));
	await assertSucceeds(set(ref(db('alice'), 'rooms/C1'), room));
	await assertFails(set(ref(db('alice'), 'rooms/C1/invite'), 'carol'));
	const ch = { from: 'alice', at: serverTimestamp(), tc: { type: 'none' }, variant: 'standard' };
	// Only the creator, only for a room that exists and invites that player.
	await assertFails(set(ref(db('carol'), 'challenges/bob/C1'), Object.assign({}, ch, { from: 'carol' })));
	await assertFails(set(ref(db('alice'), 'challenges/carol/C1'), ch));
	await assertFails(set(ref(db('alice'), 'challenges/bob/NOPE'), ch));
	await assertFails(set(ref(db('alice'), 'challenges/bob/C1'), Object.assign({}, ch, { from: 'carol' })));
	await assertFails(set(ref(db('alice'), 'challenges/bob/C1'), Object.assign({}, ch, { at: 5 })));
	await assertFails(set(ref(db('alice'), 'challenges/bob/C1'), Object.assign({}, ch, { variant: 'deathmatch' })));
	await assertFails(set(ref(db('alice'), 'challenges/bob/C1'), Object.assign({}, ch, { note: 'hi' })));
	await assertSucceeds(set(ref(db('alice'), 'challenges/bob/C1'), ch));
	// Not overwritten; read by the target and the room's players only.
	await assertFails(set(ref(db('alice'), 'challenges/bob/C1'), ch));
	await assertSucceeds(get(ref(db('bob'), 'challenges/bob')));
	await assertSucceeds(get(ref(db('alice'), 'challenges/bob/C1')));
	await assertFails(get(ref(db('carol'), 'challenges/bob')));
	await assertFails(get(ref(db('carol'), 'challenges/bob/C1')));
	// Only the invited player takes the open seat.
	await assertFails(update(ref(db('carol'), 'rooms/C1'),
		{ blue: { uid: 'carol', displayName: 'Carol', connected: true }, status: 'playing', ranked: false }));
	// The target declines (or accepts) by removing it; a stranger cannot.
	await assertFails(remove(ref(db('carol'), 'challenges/bob/C1')));
	await assertSucceeds(remove(ref(db('bob'), 'challenges/bob/C1')));
	await assertSucceeds(update(ref(db('bob'), 'rooms/C1'),
		{ blue: { uid: 'bob', displayName: 'Bob', connected: true }, status: 'playing', ranked: true }));
	// Not for a room that is no longer waiting.
	await assertFails(set(ref(db('alice'), 'challenges/bob/C1'), ch));
	// A guest cannot challenge.
	await env.withSecurityRulesDisabled((c) => set(ref(c.database(), 'rooms/C2'),
		Object.assign({}, room, { red: { uid: 'gina', connected: true } })));
	await assertFails(set(ref(guestDb('gina'), 'challenges/bob/C2'), Object.assign({}, ch, { from: 'gina' })));
});

test('blocking: no challenge to the blocker, no seat in their rooms', async () => {
	const room = Object.assign({}, waiting, { creatorColor: 'red', invite: 'bob' });
	await seed({ users: { alice: named('Alice'), bob: named('Bob') }, blocks: { bob: { alice: true } },
		rooms: { C3: room, P1: Object.assign({}, waiting, { creatorColor: 'red', red: { uid: 'bob', connected: true }, public: true }) } });
	const ch = { from: 'alice', at: serverTimestamp() };
	await assertFails(set(ref(db('alice'), 'challenges/bob/C3'), ch));
	// Nor can Bob challenge Alice, whom he blocked (she could not take his seat).
	await env.withSecurityRulesDisabled((c) => set(ref(c.database(), 'rooms/C4'),
		Object.assign({}, waiting, { creatorColor: 'red', invite: 'alice', red: { uid: 'bob', connected: true } })));
	await assertFails(set(ref(db('bob'), 'challenges/alice/C4'), { from: 'bob', at: serverTimestamp() }));
	// Alice cannot take the seat of a room Bob created (quick pair, open games).
	await assertFails(update(ref(db('alice'), 'rooms/P1'),
		{ blue: { uid: 'alice', displayName: 'Alice', connected: true }, status: 'playing', ranked: false }));
	await assertSucceeds(update(ref(db('carol'), 'rooms/P1'),
		{ blue: { uid: 'carol', displayName: 'Carol', connected: true }, status: 'playing', ranked: false }));
	// Unblocked, the challenge goes through.
	await env.withSecurityRulesDisabled((c) => remove(ref(c.database(), 'blocks/bob/alice')));
	await assertSucceeds(set(ref(db('alice'), 'challenges/bob/C3'), ch));
});

test('presence: one entry per connection, by its owner, with the server time', async () => {
	await assertSucceeds(set(ref(db('alice'), 'presence/alice/c1'), serverTimestamp()));
	await assertFails(set(ref(db('alice'), 'presence/alice/c2'), 5));
	await assertFails(set(ref(db('bob'), 'presence/alice/c3'), serverTimestamp()));
	await assertFails(set(ref(guestDb('gina'), 'presence/gina/c1'), serverTimestamp()));
	await assertSucceeds(get(ref(db(null), 'presence/alice')));
	await assertSucceeds(remove(ref(db('alice'), 'presence/alice/c1')));
});
