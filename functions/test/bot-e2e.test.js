'use strict';
// The HTTP API and BOT accounts end to end, on the emulators (rules,
// functions, auth), through the client SDK and plain HTTP:
//   cd functions && npm run test:e2e
// Two BOT accounts made on the account page's callables play a full rated
// game against each other with the reference client (tools/sigil-bot.js);
// a human's challenge to a bot is rated only with the human's opt-in; the
// rules keep a bot account out of rooms, lobbies and leaderboards; illegal
// and out-of-turn moves are refused; tokens, scopes and rate limits hold.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } = require('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');
const { getDatabase, connectDatabaseEmulator, ref, set, update, get, onValue, serverTimestamp } = require('firebase/database');
const { loadEngine, runBot } = require('../../tools/sigil-bot');

const NS = 'sigil-js-default-rtdb';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FN_PORT = Number(process.env.FUNCTIONS_EMULATOR_PORT || 5001);
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-sigil';
const API = `http://127.0.0.1:${FN_PORT}/${PROJECT}/us-central1/api`;
let seq = 0;

test.before(async () => {
	const rules = require('fs').readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
	const res = await fetch(`http://${DB_HOST}/.settings/rules.json?ns=${NS}`,
		{ method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
	assert.strictEqual(res.status, 200, await res.text());
});

async function account(name) {
	const app = initializeApp({ projectId: PROJECT, apiKey: 'demo', databaseURL: `http://${DB_HOST}?ns=${NS}` }, name + ++seq);
	const auth = getAuth(app);
	connectAuthEmulator(auth, 'http://' + AUTH_HOST, { disableWarnings: true });
	const db = getDatabase(app);
	connectDatabaseEmulator(db, DB_HOST.split(':')[0], Number(DB_HOST.split(':')[1]));
	const cred = await createUserWithEmailAndPassword(auth, `${name.toLowerCase()}${seq}@example.com`, 'password123');
	const uid = cred.user.uid;
	const displayName = name + seq;
	// What auth-manager.js ensureUserProfile writes for a new account.
	await set(ref(db, 'users/' + uid), { displayName, elo: 1000, gamesPlayed: 0, wins: 0, losses: 0, created: Date.now() });
	await set(ref(db, 'leaderboard/' + uid), { displayName, elo: 1000, gamesPlayed: 0 });
	await set(ref(db, 'usernames/' + displayName.toLowerCase()), uid);
	const fns = getFunctions(app, 'us-central1');
	connectFunctionsEmulator(fns, '127.0.0.1', FN_PORT);
	const call = (fn, data) => httpsCallable(fns, fn)(data).then((r) => r.data);
	return { uid, db, name: displayName, call };
}

async function bot(name) {
	const a = await account(name);
	assert.deepStrictEqual((await a.call('upgradeToBot', { confirm: 'BOT' })).ok, true);
	a.token = (await a.call('createApiToken', { name: 'engine', scopes: ['read', 'bot'] })).token;
	return a;
}

async function http(method, p, token, body, headers) {
	const res = await fetch(API + p, {
		method,
		headers: Object.assign({}, token ? { Authorization: 'Bearer ' + token } : {}, body ? { 'Content-Type': 'application/json' } : {}, headers || {}),
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json = null;
	try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
	return { status: res.status, body: json, text, headers: res.headers };
}

function waitFor(db, p, pred, ms = 60000) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => { off(); reject(new Error('timed out waiting for ' + p)); }, ms);
		const off = onValue(ref(db, p), (snap) => {
			if (snap.exists() && (!pred || pred(snap.val()))) { clearTimeout(t); off(); resolve(snap.val()); }
		});
	});
}

let engine = null;
const quiet = () => {};

test('a BOT account: made on its own say-so, irreversible, with a bot token only for bots', async () => {
	const human = await account('Hana');
	await assert.rejects(human.call('createApiToken', { name: 'x', scopes: ['bot'] }), /BOT account/);
	const read = await human.call('createApiToken', { name: 'scripts', scopes: ['read'] });
	assert.match(read.token, /^sgl_/);
	const me = await http('GET', '/v1/account', read.token);
	assert.deepStrictEqual([me.status, me.body.uid, me.body.isBot, me.body.scopes], [200, human.uid, false, ['read']]);
	// A read token is no bot token.
	assert.strictEqual((await http('GET', '/v1/bot/events', read.token)).status, 403);
	await assert.rejects(human.call('upgradeToBot', {}), /confirm/i);
	// An account with games cannot become a bot (here: one in play).
	await set(ref(human.db, 'user_active_games/' + human.uid + '/ABCD22'), { roomCode: 'ABCD22' });
	await assert.rejects(human.call('upgradeToBot', { confirm: 'BOT' }), /never played/);

	const b = await bot('Robo');
	assert.strictEqual((await get(ref(b.db, 'bots/' + b.uid))).exists(), true);
	assert.strictEqual((await get(ref(b.db, 'users/' + b.uid + '/isBot'))).val(), true);
	assert.strictEqual((await get(ref(b.db, 'leaderboard/' + b.uid))).exists(), false);
	assert.strictEqual((await get(ref(b.db, 'bot_leaderboard/' + b.uid + '/displayName'))).val(), b.name);
	await assert.rejects(b.call('upgradeToBot', { confirm: 'BOT' }), /already/);
	// The mark stays: the account cannot clear it, nor anyone else.
	await assert.rejects(set(ref(b.db, 'users/' + b.uid + '/isBot'), false));
	await assert.rejects(update(ref(b.db, 'users/' + b.uid), { isBot: null }));
	await assert.rejects(set(ref(b.db, 'bots/' + b.uid), null));
	await assert.rejects(set(ref(human.db, 'users/' + human.uid + '/isBot'), true));
	// Its tokens are listed for it (never the token), and revoked by id.
	const mine = (await get(ref(b.db, 'user_api_tokens/' + b.uid))).val();
	assert.strictEqual(Object.keys(mine).length, 1);
	assert.ok(!JSON.stringify(mine).includes(b.token));
	await assert.rejects(get(ref(human.db, 'user_api_tokens/' + b.uid)));
	await assert.rejects(get(ref(human.db, 'api_tokens')));
	const extra = await b.call('createApiToken', { name: 'old', scopes: ['bot'] });
	assert.strictEqual((await http('GET', '/v1/account', extra.token)).status, 200);
	await b.call('revokeApiToken', { id: extra.id });
	assert.strictEqual((await http('GET', '/v1/account', extra.token)).status, 401);
});

test('the rules keep a BOT account out of rooms, lobbies, challenges and leaderboards', async () => {
	const b = await bot('Rulebot');
	const human = await account('Ivy');
	const now = Date.now();
	const waiting = (uid) => ({ spellNames: ['Sprout'], status: 'waiting', created: now, ranked: false, seq: true,
		red: { uid, displayName: 'x', connected: true }, blue: { connected: false }, timeControl: { type: 'realtime', initialTime: 60000, increment: 0 },
		variant: 'standard', allowSpectators: true, creatorColor: 'red' });
	await assert.rejects(set(ref(b.db, 'rooms/BOTX22'), waiting(b.uid)));
	await set(ref(human.db, 'rooms/HUMX22'), waiting(human.uid));
	// Joining a human's open room directly.
	await assert.rejects(update(ref(b.db, 'rooms/HUMX22'), { blue: { uid: b.uid, displayName: 'b', connected: true, seq: true }, status: 'playing', ranked: false }));
	await assert.rejects(set(ref(b.db, 'rooms/HUMX22/blue'), { uid: b.uid, displayName: 'b' }));
	await assert.rejects(set(ref(b.db, 'challenges/' + human.uid + '/HUMX22'), { from: b.uid, at: serverTimestamp() }));
	await assert.rejects(set(ref(b.db, 'leaderboard/' + b.uid), { displayName: 'b', elo: 1000, gamesPlayed: 0 }));
	await assert.rejects(set(ref(b.db, 'live_rooms/HUMX22'), true));
	await assert.rejects(set(ref(b.db, 'user_active_games/' + b.uid + '/HUMX22'), { roomCode: 'HUMX22' }));
	await assert.rejects(set(ref(b.db, 'completed_games/x' + now), { winner: 'red', timestamp: 1, redUid: b.uid, blueUid: '__ai_rust_hard__', ranked: true }));
	// A human still can do all that.
	await set(ref(human.db, 'live_rooms/HUMX22'), null);
	await set(ref(human.db, 'user_active_games/' + human.uid + '/HUMX22'), { roomCode: 'HUMX22' });
	// Nobody writes a bot's leaderboard row or the API's own records.
	await assert.rejects(set(ref(human.db, 'bot_leaderboard/' + human.uid), { displayName: 'x', elo: 3000, gamesPlayed: 1 }));
	await assert.rejects(set(ref(human.db, 'bots/' + human.uid), { since: 1 }));
	await assert.rejects(set(ref(human.db, 'api_rate/x'), { w: 1, n: 0 }));
});

test('two bots play a full rated game with the reference client', { timeout: 300000 }, async () => {
	engine = engine || await loadEngine(path.join(__dirname, '..', '..', 'docs', 'static', 'scripts', 'engine'));
	const a = await bot('Alphabot');
	const b = await bot('Betabot');
	const runB = runBot({ api: API, token: b.token, engine, accept: 'bots', games: 1, seed: 7, log: quiet });
	// B listens before A challenges.
	await new Promise((r) => setTimeout(r, 1500));
	const runA = runBot({ api: API, token: a.token, engine, accept: 'none', games: 1, seed: 11, log: quiet,
		challenge: b.name, rated: true, timeControl: { type: 'realtime', initialTime: 600000, increment: 5000 } });
	const [ra, rb] = await Promise.all([runA, runB]);
	assert.strictEqual(ra.finished.length, 1);
	const code = ra.finished[0].room;
	assert.strictEqual(rb.finished[0].room, code);
	const room = (await get(ref(a.db, 'rooms/' + code))).val();
	assert.strictEqual(room.status, 'finished');
	assert.strictEqual(room.ranked, true);
	assert.ok(room.winner === 'red' || room.winner === 'blue');
	assert.deepStrictEqual([room.red.bot, room.blue.bot], [true, true]);
	// Recorded and rated by the server, on the bots' board only.
	const gameId = await waitFor(a.db, 'rooms/' + code + '/gameId');
	const ga = await waitFor(a.db, 'user_games/' + a.uid + '/' + gameId);
	assert.strictEqual(ga.rated, true, ga.unratedReason);
	assert.strictEqual(ga.opponentIsBot, true);
	const winnerUid = room[room.winner].uid;
	assert.ok((await get(ref(a.db, 'users/' + winnerUid + '/elo'))).val() > 1000);
	const lbA = (await get(ref(a.db, 'bot_leaderboard/' + a.uid))).val();
	assert.strictEqual(lbA.gamesPlayed, 1);
	assert.strictEqual((await get(ref(a.db, 'leaderboard/' + a.uid))).exists(), false);
	// Off both bots' active-games lists.
	assert.strictEqual((await get(ref(a.db, 'user_active_games/' + a.uid + '/' + code))).exists(), false);
	// The public API shows the game, its moves and the bots' board.
	const g = await http('GET', '/v1/games/' + code);
	assert.strictEqual(g.status, 200, g.text);
	assert.deepStrictEqual([g.body.status, g.body.winner, g.body.players.red.isBot, g.body.moves.length > 0, g.body.replayed],
		['finished', room.winner, true, true, true]);
	assert.strictEqual(g.body.moves.length, Object.keys(room.turns).length);
	const board = await http('GET', '/v1/leaderboard?board=bots');
	assert.ok(board.body.entries.some((e) => e.uid === winnerUid));
	assert.ok(!(await http('GET', '/v1/leaderboard')).body.entries.some((e) => e.uid === a.uid || e.uid === b.uid));
	const games = await http('GET', '/v1/users/' + a.uid + '/games?moves=1');
	assert.strictEqual(games.body.games[0].room, code);
	assert.strictEqual(games.body.games[0].moves.length, g.body.moves.length);
});

test('a bot\'s moves are checked: out of turn, illegal and unfinished turns are refused', { timeout: 120000 }, async () => {
	const a = await bot('Checkbot');
	const b = await bot('Foilbot');
	const ch = await http('POST', '/v1/bot/challenge/' + b.uid, a.token,
		{ timeControl: { type: 'realtime', initialTime: 300000, increment: 0 }, color: 'red', rated: false });
	assert.strictEqual(ch.status, 200, ch.text);
	const code = ch.body.room;
	// The challenge reached B (challenges/{b}) and B accepts it.
	await waitFor(b.db, 'challenges/' + b.uid + '/' + code);
	assert.strictEqual((await http('POST', '/v1/bot/challenges/' + code + '/accept', a.token)).status, 403, 'not A\'s to accept');
	const acc = await http('POST', '/v1/bot/challenges/' + code + '/accept', b.token);
	assert.deepStrictEqual([acc.status, acc.body.color, acc.body.rated], [200, 'blue', false], acc.text);
	const turn = (tok, actions) => http('POST', '/v1/bot/games/' + code + '/turn', tok, { actions });
	assert.strictEqual((await turn(b.token, ['b11', 'pass'])).body.error, 'not-your-turn');
	assert.strictEqual((await turn(a.token, ['move'])).body.error, 'bad-actions');
	assert.strictEqual((await turn(a.token, ['a2'])).body.error, 'illegal-turn');
	assert.strictEqual((await turn(a.token, ['a2', 'pass', 'pass'])).body.error, 'illegal-turn');
	const human = await account('Nosy');
	const nosyRead = (await human.call('createApiToken', { name: 'r', scopes: ['read'] })).token;
	assert.strictEqual((await turn(nosyRead, ['a2', 'pass'])).status, 403);
	// Read the start, and play a legal first turn: a node next to a red stone.
	const g0 = (await http('GET', '/v1/games/' + code, a.token)).body;
	assert.deepStrictEqual([g0.status, g0.toMove, g0.moves.length], ['playing', 'red', 0]);
	const ok = await turn(a.token, ['a2', 'pass']);
	assert.strictEqual(ok.status, 200, ok.text);
	assert.strictEqual((await turn(a.token, ['a3', 'pass'])).body.error, 'not-your-turn');
	const room = (await get(ref(a.db, 'rooms/' + code))).val();
	const key = room.last.key;
	assert.deepStrictEqual([room.turns[key].color, room.turns[key].actions, typeof room.turns[key].timestamp], ['red', ['a2', 'pass'], 'number']);
	assert.strictEqual(room.timer.activeColor, 'blue');
	assert.ok(typeof room.currentSfn === 'string');
	// Long-poll: B waits for the next turn, A's state is already there.
	const polled = await http('GET', '/v1/games/' + code + '?after=0&wait=5', b.token);
	assert.strictEqual(polled.body.moves.length, 1);
	// Resigning ends it.
	const res = await http('POST', '/v1/bot/games/' + code + '/resign', b.token);
	assert.strictEqual(res.status, 200, res.text);
	const fin = await waitFor(a.db, 'rooms/' + code, (r) => r.status === 'finished');
	assert.deepStrictEqual([fin.winner, fin.forfeitedBy], ['red', 'blue']);
	assert.strictEqual((await turn(a.token, ['a3', 'pass'])).status, 409);
});

test('a human\'s challenge to a bot is rated only with the human\'s opt-in; bots play timed games', { timeout: 60000 }, async () => {
	const b = await bot('Optbot');
	const human = await account('Uma');
	const make = async (code, extra) => {
		await set(ref(human.db, 'rooms/' + code), Object.assign({ spellNames: ['Flourish', 'Seal_of_Lightning', 'Bewitch', 'Hail_Storm', 'Grow', 'Meteor', 'Sprout', 'Slash', 'Comet'],
			status: 'waiting', created: Date.now(), ranked: false, seq: true, invite: b.uid, creatorColor: 'red',
			red: { uid: human.uid, displayName: human.name, connected: true }, blue: { connected: false },
			timeControl: { type: 'realtime', initialTime: 300000, increment: 0 }, variant: 'standard', allowSpectators: true }, extra));
		await set(ref(human.db, 'challenges/' + b.uid + '/' + code), { from: human.uid, at: serverTimestamp() });
	};
	await make('OPTA22', { rateBot: true });
	await make('OPTB22', {});
	await make('OPTC22', { timeControl: { type: 'none' } });
	const a1 = await http('POST', '/v1/bot/challenges/OPTA22/accept', b.token);
	assert.deepStrictEqual([a1.status, a1.body.rated], [200, true], a1.text);
	const a2 = await http('POST', '/v1/bot/challenges/OPTB22/accept', b.token);
	assert.deepStrictEqual([a2.status, a2.body.rated], [200, false], a2.text);
	assert.strictEqual((await get(ref(human.db, 'rooms/OPTB22/ranked'))).val(), false);
	const a3 = await http('POST', '/v1/bot/challenges/OPTC22/accept', b.token);
	assert.deepStrictEqual([a3.status, a3.body.error], [400, 'untimed']);
	assert.strictEqual((await http('POST', '/v1/bot/challenges/OPTC22/decline', b.token)).status, 200);
	assert.strictEqual((await get(ref(human.db, 'challenges/' + b.uid + '/OPTC22'))).exists(), false);
	// The human's page sees the bot seated and the game on.
	const r = (await get(ref(human.db, 'rooms/OPTA22'))).val();
	assert.deepStrictEqual([r.status, r.blue.uid, r.blue.bot, r.blue.connected, r.ranked, typeof r.startedAt], ['playing', b.uid, true, true, true, 'number']);
	// A bot challenges a human: never rated, whatever it asks.
	const ch = await http('POST', '/v1/bot/challenge/' + human.name, b.token,
		{ timeControl: { type: 'correspondence', moveTimeout: 86400000 }, rated: true });
	assert.deepStrictEqual([ch.status, ch.body.rated], [200, false], ch.text);
	assert.strictEqual((await get(ref(human.db, 'rooms/' + ch.body.room + '/casual'))).val(), true);
	const bad = await http('POST', '/v1/bot/challenge/' + human.uid, b.token, { timeControl: { type: 'none' } });
	assert.strictEqual(bad.status, 400);
});

test('public reads need no token; tokens are checked; limits hold', { timeout: 60000 }, async () => {
	const human = await account('Zed');
	const p = await http('GET', '/v1/users/' + human.uid);
	assert.deepStrictEqual([p.status, p.body.name, p.body.isBot], [200, human.name, false]);
	assert.strictEqual(p.headers.get('access-control-allow-origin'), '*');
	assert.strictEqual((await http('GET', '/v1/users/by-name/' + human.name)).body.uid, human.uid);
	assert.strictEqual((await http('GET', '/v1/puzzles/daily')).status, 200);
	assert.strictEqual((await http('GET', '/v1/nothing')).status, 404);
	// A browser's preflight for a token call (the emulator answers it with
	// its own CORS layer; production with api.js cors()).
	const pre = await fetch(API + '/v1/users/' + human.uid, { method: 'OPTIONS',
		headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
	assert.strictEqual(pre.status, 204);
	assert.match(pre.headers.get('access-control-allow-headers') || '', /authorization/i);
	assert.ok(pre.headers.get('access-control-allow-origin'));
	assert.strictEqual((await http('GET', '/v1/users/' + human.uid, 'sgl_' + 'x'.repeat(43))).status, 401);
	assert.strictEqual((await http('GET', '/v1/bot/events')).status, 401);
	// Anonymous callers: 60 a minute per address.
	const xff = { 'X-Forwarded-For': '198.51.100.' + (seq % 250) };
	let last = null;
	for (let i = 0; i < 61; i++) last = await http('GET', '/v1', null, null, xff);
	assert.strictEqual(last.status, 429);
	assert.ok(Number(last.headers.get('retry-after')) >= 1);
	// Another address is not held back.
	assert.strictEqual((await http('GET', '/v1', null, null, { 'X-Forwarded-For': '198.51.100.251' })).status, 200);
});

test.after(() => setTimeout(() => process.exit(0), 100));
