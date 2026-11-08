#!/usr/bin/env node
/**
 * Regression check: a Fissure wall is not a move target.
 *
 *   node tools/fissure-wall-smoke.js
 *
 * Until 2026-11-03, clicking a wall node at a move prompt fell through every
 * branch of GameController._doMove: the move (or the move after a dash) was
 * spent and no stone was placed. Found by the SigilBench v3 rules differential
 * test. This drives the real controller headlessly from a position where b4 is
 * a wall next to the mover's stones and checks that a wall click is rejected
 * (the move is asked for again, the board is unchanged) both for the turn's
 * move and for the move after a dash, and that a legal move still works.
 * The competitive opening's free placement (a mover with no stones yet) had
 * the same hole for any click off the empty nodes, and is checked too.
 * It also checks that the rejected click is left out of the turn's
 * transcript, so the recorded turn replays the same under a controller from
 * before the fix, and that the multiplayer controller carries the same guard
 * for the local player. Exits non-zero on a failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const ENGINE = path.join(REPO, 'docs', 'static', 'scripts', 'engine');
const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
const sandbox = {
	console: quiet, setTimeout, clearTimeout, setInterval, clearInterval, Promise,
	window: null, document: { addEventListener() {}, documentElement: { classList: { add() {} } } },
	navigator: { userAgent: 'node', onLine: true },
	localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
	sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
	matchMedia() { return { matches: false }; },
	Image: function () {},
	performance: { now: () => Date.now() },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js', 'sim-board.js',
	'features.js', 'enumerator.js', 'ai-player.js', 'game-controller.js']) {
	vm.runInContext(fs.readFileSync(path.join(ENGINE, f), 'utf8'), sandbox, { filename: f });
}
const { GameController, boardToSfn } = vm.runInContext('({ GameController, boardToSfn })', sandbox);

// Red to move; b4 is a wall (x) next to red's stones on b2, b3, b5, b6.
const SFN = '.........x....rrxrr..bb...b..b......b../Flourish,Syzygy,Fissure,Decay,Gather,Seal_of_Wind,Seal_of_Summer,Azimuth,Surge r 25 0:3 -:Fissure -:- b2 competitive';

/** Feed `tokens`; resolve with the prompt shown after the last one (and the
 *  transcript of the turn, once it is complete). */
function promptAfter(tokens, sfn = SFN) {
	return new Promise((resolve) => {
		let i = 0, done = false, turn = null;
		const gc = new GameController((ev) => { if (ev.type === 'turn_complete') turn = ev.turn; }, { variant: 'competitive' });
		gc._delay = () => Promise.resolve();
		gc._waitForInput = (payload) => {
			if (done) return new Promise(() => {});
			if (i < tokens.length) return Promise.resolve(tokens[i++]);
			done = true;
			resolve({ payload, stones: boardToSfn(gc.board).split(' ')[0].split('/')[0], color: gc.board.whoseTurn, turn });
			return new Promise(() => {});
		};
		const p = sfn.split(' ');
		p[2] = String(parseInt(p[2], 10) - 1);   // the loop advances the counter before the turn
		gc.startGame(p.join(' '));
	});
}

let failures = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failures++; };

(async () => {
	const start = await promptAfter([]);
	check(start.color === 'red' && start.payload.actionlist && start.payload.actionlist.includes('move'),
		'start: red is asked for a move');
	const wall = await promptAfter(['b4']);
	check(wall.payload.awaiting === 'node' && wall.stones === start.stones,
		'a click on the wall b4 is rejected: the move is asked for again, board unchanged');
	const legal = await promptAfter(['b4', 'b1']);
	check(legal.payload.awaiting === 'action' && legal.stones !== start.stones,
		'a legal move after the rejected click is played');
	const dash = await promptAfter(['b1', 'dash', 'b2', 'b3']);
	check(dash.payload.awaiting === 'node', 'after a dash, the dash move is asked for');
	const dashWall = await promptAfter(['b1', 'dash', 'b2', 'b3', 'b4']);
	check(dashWall.payload.awaiting === 'node' && dashWall.stones === dash.stones,
		'a click on the wall as the dash move is rejected: asked again, board unchanged');
	// Competitive opening: blue has no stones yet; only an empty node places.
	const OPEN = 'r...x' + '.'.repeat(34) + '/Flourish,Syzygy,Fissure,Decay,Gather,Seal_of_Wind,Seal_of_Summer,Azimuth,Surge b 2 0:0 -:- -:- tied competitive';
	const o0 = await promptAfter([], OPEN);
	check(o0.color === 'blue' && o0.payload.awaiting === 'node', 'competitive opening: blue is asked to place its first stone');
	for (const bad of ['a5', 'a1']) {
		const o = await promptAfter([bad], OPEN);
		check(o.payload.awaiting === 'node' && o.stones === o0.stones,
			'competitive opening: a click on ' + (bad === 'a5' ? 'the wall' : "red's stone") + ' is rejected, asked again');
	}
	const oDone = await promptAfter(['a5', 'a1', 'a9', 'pass'], OPEN);
	check(oDone.turn && JSON.stringify(oDone.turn.actions) === JSON.stringify(['a9', 'pass']),
		'competitive opening: rejected clicks are left out of the transcript: ' + JSON.stringify(oDone.turn && oDone.turn.actions));
	const done = await promptAfter(['b4', 'b1', 'pass']);
	check(done.turn && JSON.stringify(done.turn.actions) === JSON.stringify(['b1', 'pass']),
		'the rejected wall click is left out of the turn transcript: ' + JSON.stringify(done.turn && done.turn.actions));
	const src = fs.readFileSync(path.join(ENGINE, 'multiplayer-controller.js'), 'utf8');
	check(/stones\[nodeName\] === DESTROYED && color === this\.myColor\)/.test(src),
		'multiplayer-controller.js rejects the local player\'s wall click in _doMove');
	check(/if \(moveoptions\[resp\] \|\| !isMyTurn\) break;/.test(src),
		'multiplayer-controller.js re-asks the local player\'s competitive-opening placement');
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
