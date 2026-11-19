'use strict';
// node --test functions/test/glicko.test.js
//
// Glicko-2 by pool (docs/static/scripts/engine/glicko.js) and its half of the
// rating function's writes (rating.js glickoUpdates), next to the Elo.

const test = require('node:test');
const assert = require('node:assert');
const G = require('../../docs/static/scripts/engine/glicko.js');
const { judgeGame, ratingUpdates, freshEngine, poolOfRecord } = require('../rating');
const AI = require('./ai-games.json');

const DAY = 86400000;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' vs ' + b);

test('the rating period matches Glickman\'s worked example', () => {
	// "Example of the Glicko-2 system" (2012): 1500/200/0.06 against
	// 1400/30 (win), 1550/100 (loss), 1700/300 (loss), tau 0.5.
	const r = G.ratePeriod({ r: 1500, rd: 200, vol: 0.06 },
		[{ r: 1400, rd: 30, score: 1 }, { r: 1550, rd: 100, score: 0 }, { r: 1700, rd: 300, score: 0 }],
		{ periods: 1, tau: 0.5 });
	near(r.r, 1464.06, 0.01, 'rating');
	near(r.rd, 151.52, 0.01, 'deviation');
	near(r.vol, 0.05999, 0.00001, 'volatility');
	// No games: only the deviation grows.
	const idle = G.ratePeriod({ r: 1500, rd: 200, vol: 0.06 }, [], { periods: 1 });
	assert.strictEqual(idle.r, 1500);
	near(idle.rd, 200.27, 0.01);
});

test('pools: standard by time control, other variants one pool each', () => {
	const rt = (min, inc) => ({ type: 'realtime', initialTime: min * 60000, increment: inc * 1000 });
	const want = { '1+0': 'bullet', '2+1': 'bullet', '3+0': 'blitz', '3+2': 'blitz', '5+0': 'blitz', '5+3': 'blitz',
		'10+0': 'rapid', '10+5': 'rapid', '15+10': 'rapid', '30+0': 'rapid' };
	for (const [k, pool] of Object.entries(want)) {
		const [m, i] = k.split('+').map(Number);
		assert.strictEqual(G.poolOf('standard', rt(m, i)), pool, k);
	}
	assert.strictEqual(G.poolOf('standard', { type: 'correspondence', moveTimeout: DAY }), 'correspondence');
	assert.strictEqual(G.poolOf('standard', { type: 'none' }), 'untimed');
	assert.strictEqual(G.poolOf('standard', undefined), 'untimed');
	assert.strictEqual(G.poolOf('competitive', rt(1, 0)), 'competitive');
	assert.strictEqual(G.poolOf('competitive', { type: 'none' }), 'competitive');
	assert.strictEqual(G.poolOf('competitive_deathmatch', { type: 'none' }), 'competitive_deathmatch');
	assert.strictEqual(G.poolLabel('competitive_deathmatch'), 'Competitive + Deathmatch');
	assert.deepStrictEqual(G.POOLS.map(G.poolLabel), ['Bullet', 'Blitz', 'Rapid', 'Correspondence', 'Untimed', 'Competitive']);
	// The rating function uses the same pools, normalizing the variant first.
	const e = freshEngine();
	assert.strictEqual(poolOfRecord({ variant: 'competitive', timeControl: rt(5, 0) }, e), 'competitive');
	assert.strictEqual(poolOfRecord({ timeControl: rt(5, 0) }, e), 'blitz');
});

test('a new pool rating starts from the Elo, provisional', () => {
	assert.deepStrictEqual(G.seed(1432, 20, 5), { r: 1432, rd: 250, vol: 0.06, n: 0, w: 0, l: 0, at: 5 });
	assert.deepStrictEqual(G.seed(1000, 0, 5), { r: 1000, rd: 350, vol: 0.06, n: 0, w: 0, l: 0, at: 5 });
	assert.deepStrictEqual(G.seed(undefined, 0, 5), { r: 1000, rd: 350, vol: 0.06, n: 0, w: 0, l: 0, at: 5 });
	assert.strictEqual(G.format(G.seed(1432, 20, 0)), '1432?');
	assert.strictEqual(G.format({ r: 1432.4, rd: 80 }), '1432');
	assert.strictEqual(G.formatRange({ r: 1500, rd: 60 }), '1380–1620');
});

test('a game moves both ratings, the deviation shrinks and grows back with time', () => {
	const a = G.seed(1500, 10, 0);
	const b = G.seed(1500, 10, 0);
	const res = G.rateGame(a, b, 1, { now: 0 });
	assert.ok(res.a.r > 1500 && res.b.r < 1500);
	near(res.a.r - 1500, 1500 - res.b.r, 0.02, 'symmetric');
	assert.ok(res.a.rd < 250 && res.b.rd < 250);
	assert.deepStrictEqual([res.a.n, res.a.w, res.a.l, res.b.n, res.b.w, res.b.l], [1, 1, 0, 1, 0, 1]);
	assert.strictEqual(res.expectedA, 0.5);
	// Many games: the deviation reaches its floor and stops there.
	let x = a;
	let y = b;
	for (let i = 0; i < 200; i++) {
		const r = G.rateGame(x, y, i % 2, { now: i * 60000 });
		x = r.a; y = r.b;
	}
	assert.strictEqual(x.rd, G.C.MIN_RD);
	// Two years away: provisional again.
	assert.ok(G.currentRd(x, x.at + 365 * DAY) < G.C.PROVISIONAL_RD);
	assert.ok(G.currentRd(x, x.at + 2 * 365 * DAY) > G.C.PROVISIONAL_RD);
	assert.ok(G.currentRd(x, x.at + 7 * DAY) < 50);
	// An upset moves more than the expected result.
	const strong = { r: 1800, rd: 60, vol: 0.06, n: 50, w: 30, l: 20, at: 0 };
	const weak = { r: 1400, rd: 60, vol: 0.06, n: 50, w: 20, l: 30, at: 0 };
	const exp = G.rateGame(strong, weak, 1, { now: 0 });
	const ups = G.rateGame(strong, weak, 0, { now: 0 });
	assert.ok(ups.b.r - weak.r > 3 * (exp.a.r - strong.r));
});

test('an AI tier is an anchor at its Elo; its opponents still move', () => {
	const human = G.seed(1500, 10, 0);
	const ai = G.anchor({ r: 1200, rd: 50, n: 7, w: 3, l: 4, at: 0, ai: true }, 1600, 0);
	assert.deepStrictEqual([ai.r, ai.rd, ai.n], [1600, 50, 7]);
	const res = G.rateGame(human, ai, 1, { now: DAY });
	assert.deepStrictEqual([res.b.r, res.b.rd, res.b.n, res.b.l], [1600, 50, 8, 5]);
	assert.ok(res.a.r > 1500);
	assert.strictEqual(G.currentRd(ai, 10 * 365 * DAY), 50);
});

test('a game from a priced position pays by the position', () => {
	const a = G.seed(1500, 10, 0);
	const b = G.seed(1500, 10, 0);
	const even = G.rateGame(a, b, 1, { now: 0 });
	const favoured = G.rateGame(a, b, 1, { now: 0, posPA: 0.8 });
	const upset = G.rateGame(a, b, 1, { now: 0, posPA: 0.2 });
	assert.ok(favoured.a.r - 1500 < even.a.r - 1500 && even.a.r - 1500 < upset.a.r - 1500);
	assert.strictEqual(favoured.expectedA, 0.8);
	// A proven start says nothing about the players, whatever happens.
	for (const s of [0, 1]) {
		const p = G.rateGame(a, b, s, { now: 0, posPA: 1 });
		assert.deepStrictEqual([p.a.r, p.b.r, p.a.rd, p.a.n], [1500, 1500, 250, 1]);
	}
});

test('ratingUpdates writes the pool ratings next to an unchanged Elo', async () => {
	const e = freshEngine();
	const v = await judgeGame(AI.N3WMQJ, { room: null, isFullAccount: async () => true, priceStart: async () => null, now: Date.now() });
	assert.strictEqual(v.rated, true);
	const users = { red: { elo: 1500, gamesPlayed: 10, wins: 6, losses: 4, displayName: 'P' },
		blue: { elo: 1458, gamesPlayed: 99, wins: 50, losses: 49, displayName: 'AI (Medium) (Rust)', isAI: true } };
	const plain = ratingUpdates('G1', AI.N3WMQJ, v, users, { red: true, blue: true }, e);
	const now = 1792682421945 + 1000;
	const u = ratingUpdates('G1', AI.N3WMQJ, v, users, { red: true, blue: true }, e, { red: null, blue: null, now });
	// Every Elo write is the same as without pools.
	for (const [k, x] of Object.entries(plain)) {
		if (k.startsWith('user_games/')) assert.deepStrictEqual(Object.assign({}, u[k], { glicko: undefined }), Object.assign({}, x, { glicko: undefined }), k);
		else assert.deepStrictEqual(u[k], x, k);
	}
	// N3WMQJ is a Competitive game: the competitive pool. The human starts
	// from their Elo, the AI is anchored at its own.
	const pool = 'competitive';
	assert.strictEqual(u['completed_games/G1/pool'], pool);
	const human = u['ratings/human_player_1/' + pool];
	const ai = u['ratings/__ai_rust_medium__/' + pool];
	assert.ok(human.r > 1500 && human.rd < 250 && human.n === 1 && human.w === 1 && human.at === now, JSON.stringify(human));
	assert.deepStrictEqual([ai.r, ai.rd, ai.n, ai.l, ai.ai], [1458, 50, 1, 1, true]);
	const entry = u['user_games/human_player_1/G1'];
	assert.strictEqual(entry.eloChange, plain['completed_games/G1/eloChange']);
	assert.deepStrictEqual(Object.keys(entry.glicko).sort(), ['after', 'before', 'change', 'opponentBefore', 'opponentRd', 'pool', 'rdAfter', 'rdBefore']);
	assert.deepStrictEqual([entry.glicko.pool, entry.glicko.before, entry.glicko.rdBefore, entry.glicko.opponentBefore, entry.glicko.opponentRd],
		[pool, 1500, 250, 1458, 50]);
	near(entry.glicko.change, human.r - 1500, 0.01);
	// No path is written twice (the entry holds its glicko).
	assert.ok(!Object.keys(u).some((k) => k.endsWith('/glicko') && k.startsWith('user_games/')));
	assert.deepStrictEqual(u['pool_leaderboard/' + pool + '/human_player_1'], { displayName: 'P', r: human.r, rd: human.rd, n: 1 });
	assert.deepStrictEqual(u['pool_leaderboard/' + pool + '/__ai_rust_medium__'], { displayName: 'AI (Medium) (Rust)', r: 1458, rd: 50, n: 1, isAI: true });
	assert.strictEqual(u['completed_games/G1/ratedWinner'], 'red');
	assert.deepStrictEqual(Object.keys(u['completed_games/G1/glicko']).sort(), ['blue', 'red', 'redExpected']);

	// A stored pool rating is the one that moves (and the AI's moves with its Elo).
	const stored = { r: 1610, rd: 70, vol: 0.06, n: 40, w: 25, l: 15, at: now - DAY };
	const u2 = ratingUpdates('G2', AI.N3WMQJ, v, users, { red: true, blue: true }, e,
		{ red: stored, blue: { r: 1300, rd: 50, vol: 0.06, n: 9, w: 4, l: 5, at: 0, ai: true }, now });
	const h2 = u2['ratings/human_player_1/' + pool];
	assert.ok(h2.r > 1610 && h2.r < 1640 && h2.n === 41 && h2.w === 26, JSON.stringify(h2));
	assert.deepStrictEqual([u2['ratings/__ai_rust_medium__/' + pool].r, u2['ratings/__ai_rust_medium__/' + pool].n], [1458, 10]);

	// An unrated game writes no pool rating.
	const n = ratingUpdates('G3', AI.N3WMQJ, { rated: false, reason: 'casual' }, users, { red: true, blue: true }, e, { red: null, blue: null, now });
	assert.ok(!Object.keys(n).some((k) => k.startsWith('ratings/') || k.startsWith('pool_leaderboard/')));
	assert.strictEqual(n['user_games/human_player_1/G3'].glicko, undefined);
});

test('a player without a leaderboard name gets no pool leaderboard row', async () => {
	const e = freshEngine();
	const v = await judgeGame(AI.N3WMQJ, { room: null, isFullAccount: async () => true, priceStart: async () => null, now: Date.now() });
	const users = { red: { elo: 1000, gamesPlayed: 0 }, blue: { elo: 1458, displayName: 'AI', isAI: true } };
	const u = ratingUpdates('G1', AI.N3WMQJ, v, users, { red: false, blue: true }, e, { red: null, blue: null, now: 1 });
	assert.strictEqual(u['pool_leaderboard/competitive/human_player_1'], undefined);
	assert.strictEqual(u['ratings/human_player_1/competitive'].rd < 350, true);
	assert.strictEqual(u['user_games/human_player_1/G1'].glicko.rdBefore, 350);
});
