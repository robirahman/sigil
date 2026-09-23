#!/usr/bin/env node
// Game clocks (GameClock + GameController): the local game's chess-style
// clock, checked without a browser.
//   1. GameClock arithmetic: charging, increment, idempotent start, flag.
//   2. A clocked local game where the human never moves: their clock runs
//      out, the loop ends the game as a loss on time for them, the final
//      position is the clean start of the turn, endReason is 'time'.
//   3. An AI that thinks past its clock loses on time; its move is never applied.
//   4. GameClock.parse agrees with RustAI.parseClock; label/toTimeControl round-trip.
//
//   node tools/clock-smoke.js
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.dirname(__dirname);
const ENGINE = path.join(REPO, 'docs', 'static', 'scripts', 'engine');
const FILES = [
	'constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js',
	'sim-board.js', 'features.js', 'enumerator.js',
	'rust-ai.js', 'game-clock.js', 'ai-player.js', 'game-controller.js', 'game-review.js',
];
let src = FILES.map((f) => fs.readFileSync(path.join(ENGINE, f), 'utf8')).join('\n;\n');
src += `\n;\n(${driver.toString()})().catch((e) => { console.error(e); process.exit(1); });\n`;
new Function('require', src)(require);

async function driver() {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const assert = (c, m) => { if (!c) throw new Error(m); };

	// 1. Arithmetic.
	const gc = new GameClock({ baseMs: 10000, incMs: 2000 });
	gc.start('red', 1000);
	gc.start('red', 1500);                       // idempotent: no restart
	assert(gc.remainingOf('red', 4000) === 7000, 'red charged 3 s');
	assert(gc.remainingOf('blue', 4000) === 10000, 'blue untouched');
	gc.stop(4000);                                // +2 s increment
	assert(gc.remaining.red === 9000, 'increment credited: ' + gc.remaining.red);
	gc.start('blue', 4000);
	assert(gc.flagged(13999) === null && gc.flagged(14000) === 'blue', 'blue flags at 10 s');
	const snap = gc.snapshot(9000);
	assert(snap.red === 9000 && snap.blue === 5000 && snap.active === 'blue', 'snapshot');
	const resumed = new GameClock({ baseMs: 10000, incMs: 2000 }, { red: 1234, blue: 4321 });
	assert(resumed.remaining.red === 1234 && resumed.remaining.blue === 4321, 'resume state');

	// 4. Grammar parity.
	for (const t of ['5+0', '10+1', '2.5+3', '15+10', 'x', '0+1', '']) {
		const a = GameClock.parse(t), b = RustAI.parseClock(t);
		assert(JSON.stringify(a) === JSON.stringify(b), 'parse mismatch for ' + JSON.stringify(t));
	}
	assert(GameClock.label({ baseMs: 600000, incMs: 1000 }) === '10+1', 'label 10+1');
	assert(GameClock.label({ baseMs: 150000, incMs: 3000 }) === '2.5+3', 'label 2.5+3');
	const tc = GameClock.toTimeControl({ baseMs: 300000, incMs: 0 });
	assert(tc.type === 'realtime' && tc.initialTime === 300000 && tc.increment === 0, 'toTimeControl');
	assert(GameClock.fromTimeControl(tc).baseMs === 300000, 'fromTimeControl');
	assert(GameClock.formatMs(61000) === '1:01' && GameClock.formatMs(500) === '0:01' && GameClock.formatMs(0) === '0:00', 'formatMs');

	// 2. A human who never moves flags. Red (human) to move first.
	const events = [];
	const gcont = new GameController((e) => events.push(e), {
		clock: { baseMs: 600, incMs: 100 },
		spellNames: ['Flourish', 'Bewitch', 'Starfall', 'Seal_of_Stone', 'Grow', 'Storm_Front', 'Lurk', 'Comet', 'Gust'],
	});
	const t0 = Date.now();
	const done = new Promise((resolve) => {
		const orig = gcont.emit;
		gcont.emit = (e) => { orig(e); if (e.type === 'game_over') resolve(e); };
	});
	gcont.startGame();
	const over = await Promise.race([done, sleep(5000).then(() => null)]);
	assert(over, 'the clocked game did not end on the flag');
	const dt = Date.now() - t0;
	assert(over.endReason === 'time', 'endReason ' + over.endReason);
	assert(over.winner === 'blue', 'red flagged, blue should win: ' + over.winner);
	assert(dt >= 550 && dt < 3000, 'flag fired after ' + dt + ' ms (clock 600 ms)');
	const ticks = events.filter((e) => e.type === 'clock_tick');
	assert(ticks.length >= 2, 'clock ticks were emitted');
	const last = ticks[ticks.length - 1];
	assert(last.red === 0 && last.blue === 600, 'final tick red 0 / blue 600: ' + JSON.stringify(last));
	assert(gcont.board.gameover && gcont.board.winner === 'blue', 'board closed');
	assert(gcont._clockInterval === null, 'ticker stopped');

	// 3. An AI that overruns its clock loses on time; its move is not applied.
	const slowAi = {
		pickTurn: async (board, color) => { await sleep(900); return { actions: [{ type: 'pass' }] }; },
	};
	const events2 = [];
	const g2 = new GameController((e) => events2.push(e), {
		clock: { baseMs: 400, incMs: 0 }, ai: slowAi, aiColor: 'red',
		spellNames: ['Flourish', 'Bewitch', 'Starfall', 'Seal_of_Stone', 'Grow', 'Storm_Front', 'Lurk', 'Comet', 'Gust'],
	});
	const done2 = new Promise((resolve) => {
		const orig = g2.emit;
		g2.emit = (e) => { orig(e); if (e.type === 'game_over') resolve(e); };
	});
	g2.startGame();
	const over2 = await Promise.race([done2, sleep(5000).then(() => null)]);
	assert(over2 && over2.endReason === 'time' && over2.winner === 'blue', 'slow AI should lose on time: ' + JSON.stringify(over2));
	// The snapshot restore rewinds to the turn start: nothing was recorded
	// and the position is the setup position.
	assert(g2._gameLog.length === 0, 'the AI move after the flag must not be applied');
	assert(events2.filter((e) => e.type === 'turn_complete').length === 0, 'no turn completed');
	console.log('clock smoke OK: arithmetic, parity, human flag after ' + dt + ' ms, AI flag');
}
