'use strict';
// node --test functions/test/api.test.js
//
// The HTTP API's parts without an emulator (test/fake-db.js): personal
// tokens (api-tokens.js), rate limits (rate-limit.js), the read endpoints
// (public-api.js), and the daily puzzle against puzzles.html's own pick.
// The HTTP layer and the bot API run end to end in bot-e2e.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeDb } = require('./fake-db');
const { createToken, revokeToken, revokeUpdates, resolveToken, hashToken, TokenError } = require('../api-tokens');
const { hit, ipKey, sweepRateLimits, _over } = require('../rate-limit');
const pub = require('../public-api');
const { clientIp } = require('../api');
const { freshEngine } = require('../engine-loader');
const ONLINE = require('./online-game.json');

const NOW = 1_800_000_000_000;

// ---- tokens ----

test('a token is shown once and stored only as its hash', async () => {
	const db = fakeDb({ users: { u1: { displayName: 'Ann' } } });
	const t = await createToken(db, 'u1', { name: ' laptop ', scopes: ['read'] }, NOW);
	assert.match(t.token, /^sgl_[A-Za-z0-9_-]{43}$/);
	assert.deepStrictEqual([t.name, t.scopes], ['laptop', ['read']]);
	const dump = JSON.stringify(db.dump());
	assert.ok(!dump.includes(t.token), 'the token itself is never stored');
	assert.ok(!dump.includes(t.token.slice(4, 20)));
	const rec = db.dump().api_tokens[hashToken(t.token)];
	assert.deepStrictEqual(rec, { uid: 'u1', id: t.id, scopes: { read: true }, created: NOW });
	assert.deepStrictEqual(db.dump().user_api_tokens.u1[t.id], { name: 'laptop', scopes: { read: true }, created: NOW });
	// The owner's list never holds the hash either.
	assert.ok(!JSON.stringify(db.dump().user_api_tokens).includes(hashToken(t.token)));
});

test('token names, scopes and the count are checked; a bot token needs a BOT account', async () => {
	const db = fakeDb({ bots: { b1: { since: 1 } } });
	const code = async (p) => { try { await p; return 'ok'; } catch (e) { assert.ok(e instanceof TokenError); return e.code; } };
	assert.strictEqual(await code(createToken(db, 'u1', { name: '', scopes: ['read'] }, NOW)), 'invalid-argument');
	assert.strictEqual(await code(createToken(db, 'u1', { name: 'x'.repeat(41), scopes: ['read'] }, NOW)), 'invalid-argument');
	assert.strictEqual(await code(createToken(db, 'u1', { name: 'a', scopes: [] }, NOW)), 'invalid-argument');
	assert.strictEqual(await code(createToken(db, 'u1', { name: 'a', scopes: ['admin'] }, NOW)), 'invalid-argument');
	assert.strictEqual(await code(createToken(db, 'u1', { name: 'a', scopes: ['read', 'bot'] }, NOW)), 'permission-denied');
	assert.strictEqual(await code(createToken(db, 'b1', { name: 'a', scopes: ['read', 'bot'] }, NOW)), 'ok');
	for (let i = 0; i < 10; i++) await createToken(db, 'u2', { name: 'n' + i, scopes: ['read'] }, NOW);
	assert.strictEqual(await code(createToken(db, 'u2', { name: 'eleven', scopes: ['read'] }, NOW)), 'resource-exhausted');
});

test('a token resolves to its account until it is revoked or the account deleted', async () => {
	const db = fakeDb({});
	const t = await createToken(db, 'u1', { name: 'a', scopes: ['read'] }, NOW);
	assert.strictEqual(await resolveToken(db, undefined, NOW), null);
	const who = await resolveToken(db, 'Bearer ' + t.token, NOW);
	assert.deepStrictEqual(who, { uid: 'u1', id: t.id, scopes: ['read'] });
	assert.strictEqual(db.dump().user_api_tokens.u1[t.id].lastUsed, NOW);
	// Seen again soon: not written again.
	await resolveToken(db, 'bearer ' + t.token, NOW + 1000);
	assert.strictEqual(db.dump().user_api_tokens.u1[t.id].lastUsed, NOW);
	const bad = async (h) => { try { await resolveToken(db, h, NOW); return 'ok'; } catch (e) { return e.code; } };
	assert.strictEqual(await bad('Bearer sgl_' + 'A'.repeat(43)), 'unauthenticated');
	assert.strictEqual(await bad('Basic abc'), 'unauthenticated');
	assert.strictEqual(await bad(t.token), 'unauthenticated');
	assert.strictEqual(await revokeToken(db, 'u2', t.id), false, 'only its owner revokes it');
	assert.strictEqual(await revokeToken(db, 'u1', t.id), true);
	assert.strictEqual(await bad('Bearer ' + t.token), 'unauthenticated');
	assert.ok(!db.dump().user_api_tokens);
	const t2 = await createToken(db, 'u3', { name: 'a', scopes: ['read'] }, NOW);
	await db.ref('deleted_users/u3').set(NOW);
	assert.strictEqual(await bad('Bearer ' + t2.token), 'unauthenticated');
});

test('deleting an account revokes all its tokens', async () => {
	const db = fakeDb({});
	const a = await createToken(db, 'u1', { name: 'a', scopes: ['read'] }, NOW);
	const b = await createToken(db, 'u1', { name: 'b', scopes: ['read'] }, NOW);
	const keep = await createToken(db, 'u2', { name: 'c', scopes: ['read'] }, NOW);
	const u = await revokeUpdates(db, 'u1', null);
	// No path in the update is another's parent (the database refuses that).
	const keys = Object.keys(u);
	assert.ok(!keys.some((k) => keys.some((o) => o !== k && o.startsWith(k + '/'))));
	await db.ref().update(u);
	const d = db.dump();
	assert.deepStrictEqual(Object.values(d.api_tokens).map((r) => r.uid), ['u2']);
	assert.ok(!d.api_tokens[hashToken(a.token)] && !d.api_tokens[hashToken(b.token)] && d.api_tokens[hashToken(keep.token)]);
	assert.deepStrictEqual(Object.keys(d.user_api_tokens), ['u2']);
});

// ---- rate limits ----

test('a minute holds the limit, then a new window starts', async () => {
	_over.clear();
	const db = fakeDb({});
	const t = NOW - (NOW % 60000) + 5;
	for (let i = 1; i <= 3; i++) assert.deepStrictEqual((await hit(db, 'k', 3, t)).remaining, 3 - i);
	const no = await hit(db, 'k', 3, t + 10);
	assert.deepStrictEqual([no.ok, no.remaining, no.reset], [false, 0, t - 5 + 60000]);
	// Remembered: refused without a database read.
	assert.strictEqual(_over.get('k'), t - 5);
	assert.strictEqual((await hit(db, 'k', 3, t + 60000)).ok, true);
	assert.strictEqual((await hit(db, 'other', 3, t)).ok, true);
	// IPs are kept hashed.
	assert.match(ipKey('203.0.113.9'), /^ip_[0-9a-f]{32}$/);
	assert.notStrictEqual(ipKey('203.0.113.9'), ipKey('203.0.113.8'));
	assert.ok(!JSON.stringify(db.dump()).includes('203.0.113'));
	// Old windows are swept.
	assert.strictEqual(await sweepRateLimits(db, t + 60000 + 11 * 60000), 2);
	assert.ok(!db.dump().api_rate);
});

test('the caller\'s IP is the last X-Forwarded-For hop', () => {
	const req = (xff, ip) => ({ get: (h) => (h === 'x-forwarded-for' ? xff : undefined), ip });
	assert.strictEqual(clientIp(req('1.2.3.4, 203.0.113.9')), '203.0.113.9');
	assert.strictEqual(clientIp(req('203.0.113.9')), '203.0.113.9');
	assert.strictEqual(clientIp(req(undefined, '10.0.0.1')), '10.0.0.1');
});

// ---- read endpoints ----

const users = {
	ann: { displayName: 'Ann', elo: 1210, gamesPlayed: 12, wins: 8, losses: 4, created: 5, puzzle: { rating: 1600, plays: 30 },
		puzzleStorm: { best: 21, runs: 4 }, puzzleAttempts: { p1: { solved: true } }, annotationMode: true },
	bob: { displayName: 'Bob', elo: 990, gamesPlayed: 3, wins: 1, losses: 2, created: 6 },
	rando: { displayName: 'RandoBot', elo: 1040, gamesPlayed: 2, wins: 2, losses: 0, created: 7, isBot: true },
};

test('a profile shows the public ratings only, and marks a bot', async () => {
	const db = fakeDb({ users, bots: { rando: { since: 9 } }, usernames: { ann: 'ann', randobot: 'rando' } });
	const ann = await pub.userProfile(db, 'ann');
	assert.deepStrictEqual(ann, {
		uid: 'ann', name: 'Ann', url: 'https://sigilbattle.com/profile.html?uid=ann', created: 5, isBot: false, isAI: false,
		rating: { elo: 1210, games: 12, wins: 8, losses: 4, provisional: false },
		puzzles: { rating: 1600, plays: 30 }, storm: { best: 21, runs: 4 },
	});
	const bot = await pub.userByName(db, 'RandoBot');
	assert.deepStrictEqual([bot.uid, bot.isBot, bot.botSince, bot.rating.provisional], ['rando', true, 9, true]);
	await assert.rejects(pub.userProfile(db, 'nobody'), (e) => e.status === 404);
	await assert.rejects(pub.userByName(db, 'no one'), (e) => e.status === 404);
	await assert.rejects(pub.userProfile(db, 'a/b'), (e) => e.status === 400);
});

test('the leaderboards: players with games, bots on their own board', async () => {
	const db = fakeDb({
		leaderboard: { ann: { displayName: 'Ann', elo: 1210, gamesPlayed: 12 }, bob: { displayName: 'Bob', elo: 990, gamesPlayed: 3 },
			idle: { displayName: 'Idle', elo: 1500, gamesPlayed: 0 }, __ai_rust_hard__: { displayName: 'AI (Hard)', elo: 1600, gamesPlayed: 50, isAI: true } },
		bot_leaderboard: { rando: { displayName: 'RandoBot', elo: 1040, gamesPlayed: 2 } },
		storm_leaderboard: { ann: { displayName: 'Ann', score: 21 } },
	});
	const lb = await pub.leaderboard(db, {});
	assert.deepStrictEqual(lb.entries.map((e) => [e.rank, e.uid, e.rating, e.isAI, e.provisional]),
		[[1, '__ai_rust_hard__', 1600, true, false], [2, 'ann', 1210, false, false], [3, 'bob', 990, false, true]]);
	assert.deepStrictEqual((await pub.leaderboard(db, { board: 'rating', limit: '2' })).entries.length, 2);
	assert.deepStrictEqual((await pub.leaderboard(db, { board: 'bots' })).entries.map((e) => e.name), ['RandoBot']);
	assert.deepStrictEqual((await pub.leaderboard(db, { board: 'storm' })).entries, [{ rank: 1, uid: 'ann', name: 'Ann', isAI: false, score: 21 }]);
	await assert.rejects(pub.leaderboard(db, { board: 'secret' }), (e) => e.status === 400);
	await assert.rejects(pub.leaderboard(db, { limit: '1000' }), (e) => e.status === 400);
});

/** The recorded online game as a finished room. */
function finishedRoom(extra) {
	const turns = {};
	let last = null;
	ONLINE.turns.forEach((t, i) => {
		const k = '-k' + String(i).padStart(4, '0');
		turns[k] = Object.assign({ color: t.color, actions: t.actions, timestamp: NOW + i }, last ? { after: last } : {});
		last = k;
	});
	return Object.assign({ spellNames: ONLINE.spellNames, status: 'finished', seq: true, variant: 'standard', ranked: true,
		red: { uid: 'ann', displayName: 'Ann' }, blue: { uid: 'rando', displayName: 'RandoBot' }, turns, last: { key: last, color: 'red' },
		winner: ONLINE.winner, timeControl: { type: 'realtime', initialTime: 300000, increment: 0 }, created: NOW - 1, startedAt: NOW - 1,
		closedAt: NOW + 999 }, extra || {});
}

test('a game by room code: its players, result, moves and SFNs', async () => {
	pub._finishedCache.clear();
	const db = fakeDb({ rooms: { ABC234: finishedRoom() }, bots: { rando: { since: 1 } } });
	const g = await pub.gameByRoom(db, 'ABC234', freshEngine(), {});
	assert.deepStrictEqual([g.status, g.winner, g.endReason, g.rated], ['finished', ONLINE.winner, 'play', true]);
	assert.deepStrictEqual(g.players.blue, { uid: 'rando', name: 'RandoBot', isBot: true, isAI: false });
	assert.strictEqual(g.moves.length, ONLINE.turns.length);
	assert.deepStrictEqual(g.moves[0], { n: 1, color: 'red', actions: ['a2', 'pass'], sfn: g.moves[0].sfn });
	assert.match(g.moves[0].sfn, / r 1 /);
	assert.strictEqual(g.sfn, g.moves[g.moves.length - 1].sfn);
	await assert.rejects(pub.gameByRoom(db, 'NOPE22', freshEngine(), {}), (e) => e.status === 404);
	await assert.rejects(pub.gameByRoom(db, 'abc', freshEngine(), {}), (e) => e.status === 400);
});

test('a game in play without spectators is shown to its players only', async () => {
	pub._finishedCache.clear();
	const room = finishedRoom({ status: 'playing', allowSpectators: false });
	delete room.winner;
	const db = fakeDb({ rooms: { PRIV22: room } });
	await assert.rejects(pub.gameByRoom(db, 'PRIV22', freshEngine(), {}), (e) => e.status === 403 && e.code === 'private-game');
	const g = await pub.gameByRoom(db, 'PRIV22', freshEngine(), { viewerUid: 'rando', now: NOW + 5000 });
	assert.strictEqual(g.status, 'playing');
	assert.strictEqual(typeof g.clock.red, 'number');
});

test('a player\'s games, newest first, with their moves on request', async () => {
	pub._finishedCache.clear();
	const ug = {};
	for (let i = 0; i < 4; i++) {
		ug['g' + i] = { timestamp: NOW + i * 1000, roomCode: i === 3 ? 'ABC234' : null, gameId: 'g' + i, opponent: i === 3 ? 'RandoBot' : 'AI (Hard)',
			opponentUid: i === 3 ? 'rando' : '__ai_rust_hard__', opponentIsAI: i !== 3, color: 'red', result: 'win', rated: i !== 1,
			eloBefore: 1000, eloAfter: 1016, eloChange: 16, unratedReason: i === 1 ? 'casual' : undefined };
	}
	const db = fakeDb({ users, user_games: { ann: ug }, rooms: { ABC234: finishedRoom() }, bots: { rando: { since: 1 } } });
	const all = await pub.userGames(db, 'ann', {}, freshEngine);
	assert.deepStrictEqual(all.games.map((g) => g.gameId), ['g3', 'g2', 'g1', 'g0']);
	assert.deepStrictEqual(all.games[0].opponent, { uid: 'rando', name: 'RandoBot', isAI: false, isBot: true });
	assert.deepStrictEqual([all.games[2].rated, all.games[2].unratedReason, all.games[2].rating], [false, 'casual', null]);
	assert.strictEqual(all.next, null);
	const page = await pub.userGames(db, 'ann', { limit: '2' }, freshEngine);
	assert.deepStrictEqual([page.games.map((g) => g.gameId), page.next], [['g3', 'g2'], NOW + 2000]);
	const rest = await pub.userGames(db, 'ann', { limit: '2', before: String(page.next) }, freshEngine);
	assert.deepStrictEqual(rest.games.map((g) => g.gameId), ['g1', 'g0']);
	const moves = await pub.userGames(db, 'ann', { moves: '1', limit: '2' }, freshEngine);
	assert.strictEqual(moves.games[0].moves.length, ONLINE.turns.length);
	assert.strictEqual(moves.games[1].moves, null, 'a game against the AI keeps its moves private');
	await assert.rejects(pub.userGames(db, 'ann', { moves: '1', limit: '11' }, freshEngine), (e) => e.status === 400);
	await assert.rejects(pub.userGames(db, 'ghost', {}, freshEngine), (e) => e.status === 404);
});

test('the daily puzzle is the one puzzles.html shows that day', async () => {
	// puzzles.html's own dailyPuzzle, taken from the page.
	const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'puzzles.html'), 'utf8');
	const m = /function dailyPuzzle\(all, day\) \{[\s\S]*?\n\t\t\t\}/.exec(html);
	assert.ok(m, 'puzzles.html dailyPuzzle');
	const pageDaily = vm.runInNewContext('(' + m[0] + ')', { Math });
	const all = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'static', 'puzzles', 'mate_puzzles.json'), 'utf8')).puzzles;
	const slim = pub.puzzleSet();
	assert.strictEqual(slim.length, all.length);
	for (let d = 0; d < 60; d++) {
		const day = new Date(NOW + d * 86400000).toISOString().slice(0, 10);
		assert.strictEqual(pub.dailyPuzzle(slim, day).id, pageDaily(all, day).id, day);
	}
	const db = fakeDb({});
	const today = new Date(NOW).toISOString().slice(0, 10);
	const p = await pub.daily(db, {}, NOW);
	assert.strictEqual(p.id, pageDaily(all, today).id);
	assert.strictEqual(p.url, 'https://sigilbattle.com/puzzles.html?daily=1');
	assert.strictEqual(p.solutions, undefined);
	await db.ref('puzzle_ratings/' + p.id).set({ rating: 1500, plays: 3 });
	const withSol = await pub.daily(db, { solutions: '1', date: '2026-01-02' }, NOW);
	assert.ok(Array.isArray(withSol.solutions) && withSol.solutions.length > 0);
	assert.match(withSol.url, /puzzles\.html\?id=/);
	assert.deepStrictEqual((await pub.daily(db, {}, NOW)).rating, { rating: 1500, plays: 3 });
	await assert.rejects(pub.daily(db, { date: '2999-01-01' }, NOW), (e) => e.status === 400);
	await assert.rejects(pub.daily(db, { date: 'today' }, NOW), (e) => e.status === 400);
});

// ---- the HTTP handler ----

function call(handler, method, p, opts) {
	const o = opts || {};
	const headers = Object.assign({}, o.headers || {});
	const req = { method, path: p.split('?')[0], query: Object.fromEntries(new URLSearchParams(p.split('?')[1] || '')),
		body: o.body, get: (h) => headers[h.toLowerCase()], on() {}, ip: o.ip || '192.0.2.1' };
	return new Promise((resolve) => {
		const res = { headers: {}, statusCode: 200, headersSent: false,
			set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
			status(n) { this.statusCode = n; return this; },
			json(b) { this.body = b; resolve(this); },
			send(b) { this.body = b; resolve(this); },
			end() { resolve(this); } };
		handler(req, res);
	});
}

test('the handler: CORS, routes, token checks and rate-limit headers', async () => {
	_over.clear();
	const { createApiHandler } = require('../api');
	const db = fakeDb({ users });
	const h = createApiHandler({ db, engine: freshEngine, isFullAccount: async () => true, now: () => NOW });
	const pre = await call(h, 'OPTIONS', '/v1/users/ann');
	assert.strictEqual(pre.statusCode, 204);
	assert.strictEqual(pre.headers['access-control-allow-origin'], '*');
	assert.match(pre.headers['access-control-allow-headers'], /Authorization/);
	const root = await call(h, 'GET', '/v1');
	assert.deepStrictEqual([root.statusCode, root.body.name], [200, 'Sigil API']);
	assert.strictEqual(root.headers['x-ratelimit-limit'], '60');
	const ann = await call(h, 'GET', '/v1/users/ann');
	assert.deepStrictEqual([ann.statusCode, ann.body.name, ann.headers['access-control-allow-origin']], [200, 'Ann', '*']);
	assert.strictEqual((await call(h, 'GET', '/v1/users/ghost')).statusCode, 404);
	assert.strictEqual((await call(h, 'GET', '/elsewhere')).statusCode, 404);
	assert.strictEqual((await call(h, 'PUT', '/v1')).statusCode, 405);
	const noBot = await call(h, 'GET', '/v1/bot/events');
	assert.deepStrictEqual([noBot.statusCode, noBot.body.error], [401, 'unauthenticated']);
	const t = await createToken(db, 'ann', { name: 'r', scopes: ['read'] }, NOW);
	const auth = { headers: { authorization: 'Bearer ' + t.token } };
	const me = await call(h, 'GET', '/v1/account', auth);
	assert.deepStrictEqual([me.statusCode, me.body.uid, me.body.isBot, me.headers['x-ratelimit-limit']], [200, 'ann', false, '300']);
	assert.strictEqual((await call(h, 'POST', '/v1/bot/games/ABC234/turn', Object.assign({ body: { actions: ['pass'] } }, auth))).body.error, 'missing-scope');
	const bad = await call(h, 'GET', '/v1/account', { headers: { authorization: 'Bearer sgl_' + 'z'.repeat(43) } });
	assert.deepStrictEqual([bad.statusCode, bad.headers['www-authenticate']], [401, 'Bearer']);
	// The per-IP limit.
	let last = null;
	for (let i = 0; i < 70 && (!last || last.statusCode !== 429); i++) last = await call(h, 'GET', '/v1', { ip: '192.0.2.77' });
	assert.strictEqual(last.statusCode, 429);
	assert.ok(Number(last.headers['retry-after']) >= 1);
	assert.strictEqual((await call(h, 'GET', '/v1', { ip: '192.0.2.78' })).statusCode, 200);
});
