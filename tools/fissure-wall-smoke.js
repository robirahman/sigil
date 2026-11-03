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
 * The multiplayer and spectator controllers carry the same guard; this also
 * checks their source for it. Exits non-zero on a failure.
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

/** Feed `tokens`; resolve with the prompt shown after the last one. */
function promptAfter(tokens) {
	return new Promise((resolve) => {
		let i = 0, done = false;
		const gc = new GameController(() => {}, { variant: 'competitive' });
		gc._delay = () => Promise.resolve();
		gc._waitForInput = (payload) => {
			if (done) return new Promise(() => {});
			if (i < tokens.length) return Promise.resolve(tokens[i++]);
			done = true;
			resolve({ payload, stones: boardToSfn(gc.board).split(' ')[0].split('/')[0], color: gc.board.whoseTurn });
			return new Promise(() => {});
		};
		const p = SFN.split(' ');
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
	for (const f of ['multiplayer-controller.js', 'spectator-controller.js']) {
		const src = fs.readFileSync(path.join(ENGINE, f), 'utf8');
		check(/stones\[nodeName\] === DESTROYED\) return this\._promptMove/.test(src), f + ' rejects a wall in _doMove');
	}
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
