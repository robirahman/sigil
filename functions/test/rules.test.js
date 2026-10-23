'use strict';
// database.rules.json against the Realtime Database emulator:
//   cd functions && npm run test:rules
// (firebase emulators:exec starts the emulator and sets
// FIREBASE_DATABASE_EMULATOR_HOST.)

const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { ref, set, update, remove, serverTimestamp } = require('firebase/database');

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

test('rooms: rematches, local archives and expired invites', async () => {
	await seed({ rooms: { OLD: Object.assign({}, waiting, { status: 'finished', ranked: true,
		blue: { uid: 'bob', displayName: 'Bob' } }) } });
	const rematch = Object.assign({}, waiting, { status: 'playing', ranked: true, rematchOf: 'OLD',
		red: { uid: 'bob', connected: false }, blue: { uid: 'alice', connected: false } });
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
