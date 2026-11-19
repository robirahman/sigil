'use strict';
// node --test functions/test/turn-check.test.js
//
// The bot API's turn check (turn-check.js) on the recorded online game
// (online-game.json, every turn an input transcript) and on turns built to
// break it. The bot clock node (bot-api.js timerAfterTurn) too.

const test = require('node:test');
const assert = require('node:assert');
const { checkTurn, roomGame } = require('../turn-check');
const { timerAfterTurn, initialTimer } = require('../bot-api');
const { freshEngine } = require('../engine-loader');
const ONLINE = require('./online-game.json');

const T0 = 1_700_000_000_000;

/** A playing room holding the first `n` turns of `turns`. */
function room(n, turns, extra) {
	const r = Object.assign({ spellNames: ONLINE.spellNames, status: 'playing', seq: true, variant: 'standard',
		red: { uid: 'r' }, blue: { uid: 'b' }, turns: {} }, extra || {});
	let last = null;
	(turns || ONLINE.turns).slice(0, n).forEach((t, i) => {
		const key = '-k' + String(i).padStart(4, '0');
		r.turns[key] = Object.assign({ color: t.color, actions: t.actions, timestamp: T0 + i * 1000 }, last ? { after: last } : {});
		last = key;
	});
	if (last) r.last = { key: last, color: r.turns[last].color };
	return r;
}

// What a live client would send: no 'move' token (the UI answers the move
// prompt with a node), and not the fixture's 77-click random turn.
const sendable = (t) => !t.actions.includes('move') && t.actions.length <= 64;

test('every turn a client could send is accepted, in order, and the last one ends the game', async () => {
	const turns = ONLINE.turns;
	let checked = 0;
	for (let i = 0; i < turns.length; i++) {
		// Every few turns (the full replay is long), and the last.
		if (i % 7 !== 0 && i !== turns.length - 1) continue;
		const r = await checkTurn(freshEngine(), room(i), turns[i].color, turns[i].actions);
		if (sendable(turns[i])) {
			assert.strictEqual(r.ok, true, 'turn ' + (i + 1) + ': ' + r.error + ' ' + r.detail);
			assert.strictEqual(r.turnNumber, i + 1);
			assert.strictEqual(r.gameover, i === turns.length - 1);
			checked++;
		} else {
			assert.strictEqual(r.error, 'bad-actions');
		}
	}
	assert.ok(checked > 5);
	const last = await checkTurn(freshEngine(), room(turns.length - 1), turns[turns.length - 1].color, turns[turns.length - 1].actions);
	assert.deepStrictEqual([last.gameover, last.winner], [true, ONLINE.winner]);
});

test('a turn out of turn, after the end, or in a room not playing is refused', async () => {
	const e = freshEngine();
	assert.strictEqual((await checkTurn(e, room(0), 'blue', ['b11', 'pass'])).error, 'not-your-turn');
	assert.strictEqual((await checkTurn(e, room(1), 'red', ['a2', 'pass'])).error, 'not-your-turn');
	assert.strictEqual((await checkTurn(e, room(0, null, { status: 'finished' }), 'red', ['a2', 'pass'])).error, 'not-playing');
	// The recorded game is over after its last turn, whoever the room says moves.
	const over = room(ONLINE.turns.length);
	const next = ONLINE.winner === 'red' ? 'blue' : 'red';
	const r = await checkTurn(freshEngine(), over, ONLINE.turns[ONLINE.turns.length - 1].color === 'red' ? 'blue' : 'red', ['pass']);
	assert.strictEqual(r.ok, false);
	assert.ok(['not-playing', 'illegal-turn'].includes(r.error), r.error);
	void next;
});

test('tokens: nodes, the room\'s spells and the client controls only', async () => {
	const e = freshEngine();
	for (const bad of [['move'], ['reset'], ['__forfeit__'], ['Fireball', 'pass'], ['z99'], [], ['a2', 7], 'a2 pass',
		new Array(65).fill('pass')]) {
		const r = await checkTurn(e, room(0), 'red', bad);
		assert.strictEqual(r.error, 'bad-actions', JSON.stringify(bad));
	}
});

test('a turn must end exactly when its tokens run out', async () => {
	const e = freshEngine();
	// The first recorded turn, a move and a pass.
	assert.deepStrictEqual(ONLINE.turns[0].actions, ['a2', 'pass']);
	assert.strictEqual((await checkTurn(e, room(0), 'red', ['a2', 'pass'])).ok, true);
	// Unfinished: the opponent's page would wait for the rest.
	const short = await checkTurn(e, room(0), 'red', ['a2']);
	assert.deepStrictEqual([short.ok, short.error], [false, 'illegal-turn']);
	assert.match(short.detail, /not finished/);
	// Left over: the opponent's page would play it at the start of its next turn.
	const long = await checkTurn(e, room(0), 'red', ['a2', 'pass', 'pass']);
	assert.deepStrictEqual([long.ok, long.error], [false, 'illegal-turn']);
	assert.match(long.detail, /unused actions/);
});

test('a click only an old controller took is refused (a Competitive opening onto a stone)', async () => {
	const e = freshEngine();
	const comp = (n, turns) => room(n, turns, { variant: 'competitive' });
	const opening = [{ color: 'red', actions: ['a1', 'pass'] }];
	assert.strictEqual((await checkTurn(e, comp(0, opening), 'red', ['a1', 'pass'])).ok, true);
	// Blue clicks red's stone, then an empty node: the live game asks again
	// and places on b1; a controller from before the fix skipped the
	// placement on the first click.
	const r = await checkTurn(e, comp(1, opening), 'blue', ['a1', 'b1', 'pass']);
	assert.deepStrictEqual([r.ok, r.error], [false, 'illegal-turn']);
	assert.strictEqual((await checkTurn(e, comp(1, opening), 'blue', ['b1', 'pass'])).ok, true);
});

test('roomGame replays a room into its positions', async () => {
	const g = await roomGame(freshEngine(), room(ONLINE.turns.length, null, { status: 'finished' }));
	assert.strictEqual(g.valid, true);
	assert.strictEqual(g.turns.length, ONLINE.turns.length);
	assert.deepStrictEqual([g.gameover, g.winner], [true, ONLINE.winner]);
	assert.strictEqual(g.sfn, g.turns[g.turns.length - 1].sfnAfter);
	assert.deepStrictEqual(g.turns[2].actions, ONLINE.turns[2].actions);
	const empty = await roomGame(freshEngine(), room(0));
	assert.deepStrictEqual([empty.turns.length, empty.sfn], [0, empty.start]);
});

test('the clock node after a bot\'s turn follows the turns\' timestamps', () => {
	const tc = { type: 'realtime', initialTime: 60_000, increment: 2_000 };
	const r = room(3, null, { timeControl: tc, startedAt: T0 - 5_000 });
	// Turn 4 (blue) lands 7 s after turn 3.
	const at = T0 + 2_000 + 7_000;
	r.turns['-k0003'] = { color: 'blue', actions: ONLINE.turns[3].actions, timestamp: at, after: '-k0002' };
	r.last = { key: '-k0003', color: 'blue' };
	const t = timerAfterTurn(r, 'blue', at);
	// Blue: 60 s, +2 -1 on turn 2 (1 s after turn 1), +2 -7 on turn 4.
	assert.deepStrictEqual([t.blue, t.red, t.activeColor, t.lastUpdated], [60_000 + 1_000 - 5_000, 60_000 + 1_000, 'red', at]);
	const corr = room(1, null, { timeControl: { type: 'correspondence', moveTimeout: 86_400_000 }, timer: { red: 0, blue: 0 } });
	assert.deepStrictEqual(timerAfterTurn(corr, 'red', T0 + 5), { red: 0, blue: T0 + 5 + 86_400_000, activeColor: 'blue', lastUpdated: T0 + 5 });
	assert.deepStrictEqual(initialTimer(room(0, null, { timeControl: tc }), 7), { red: 60_000, blue: 60_000, activeColor: 'red', lastUpdated: 7 });
	assert.strictEqual(initialTimer(room(0, null, { timeControl: { type: 'none' } }), 7), null);
});
