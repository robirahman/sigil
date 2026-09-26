#!/usr/bin/env node
// Reset Turn must rewind Seal-of-Spring state. `takeSnapshot` saved the
// lock but not the springlock, so a reset turn left it as the cancelled
// turn had set it:
//   1. Grow is locked, Seal of Spring is charged: red casts Grow a second
//      time (Grow becomes springlocked), then clicks Reset Turn. Grow must be
//      castable again, and a turn that then just moves and passes must end
//      with the same SFN and threefold-repetition key as the same turn played
//      without the reset (the stale springlock sat in both).
//   2. Grow is already springlocked: red casts Flourish (which clears the
//      springlock), then resets. Grow must stay uncastable.
// Drives the real GameController loop with scripted clicks.
//
//   node tools/springlock-reset-smoke.js
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.dirname(__dirname);
const ENGINE = path.join(REPO, 'docs', 'static', 'scripts', 'engine');
const FILES = [
	'constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js',
	'sim-board.js', 'features.js', 'enumerator.js',
	'ai-player.js', 'game-controller.js',
];
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
let src = FILES.map((f) => fs.readFileSync(path.join(ENGINE, f), 'utf8')).join('\n;\n');
src += `\n;\n(${driver.toString()})().catch((e) => { console.error(e); process.exit(1); });\n`;
new Function('require', src)(require);

async function driver() {
	// Grow at sorcery1 (a8-a10), Flourish at ritual1 (a2-a6), Seal of Spring
	// at charm1 (a7). Red has cast Grow once (locked); red to move, turn 3.
	const SPELLS = ['Flourish', 'Carnage', 'Bewitch', 'Grow', 'Hail_Storm', 'Meteor', 'Seal_of_Spring', 'Sprout', 'Slash'];
	function sfn(red, springRed) {
		const st = {};
		for (const n of NODE_ORDER) st[n] = '.';
		for (const n of red) st[n] = 'r';
		for (const n of ['b1', 'b2', 'b3', 'c1', 'c2']) st[n] = 'b';
		return NODE_ORDER.map((n) => st[n]).join('') + '/' + SPELLS.join(',')
			+ ' r 2 1:0 Grow:- ' + springRed + ':- b0';
	}

	// Plays `script` (clicks; '?' = the first offered move target) until it
	// runs out. Returns the action lists offered and the final board.
	async function play(startSfn, script) {
		script = script.slice();
		const offered = [];
		let gc;
		let done;
		const finished = new Promise((r) => { done = r; });
		gc = new GameController((p) => {
			if (p.type === 'game_over') done();
			if (!p.awaiting) return;
			offered.push(p.actionlist || []);
			if (!script.length) { done(); return; }
			let tok = script.shift();
			if (tok === '?') tok = Object.keys(p.moveoptions || {})[0];
			setImmediate(() => gc.handlePlayerAction(tok));
		}, { variant: 'standard' });
		gc._delay = () => Promise.resolve();
		await gc.startGame(startSfn);
		await finished;
		return { offered, board: gc.board };
	}
	const loopKeys = (b) => Object.keys(b.allLoopingSnapshotCounts).sort().join('\n');

	// 1. Second cast, reset, then move + pass.
	const start1 = sfn(['a1', 'a7', 'a8', 'a9', 'a10'], '-');
	const reset = await play(start1, ['?', 'Grow', 'a8', '?', '?', 'reset', '?', 'pass']);
	const afterReset = reset.offered[reset.offered.length - 2];   // after the replayed move
	if (!afterReset.includes('Grow')) {
		throw new Error('after Reset Turn, Grow is no longer castable: offered ' + afterReset.join(','));
	}
	const plain = await play(start1, ['?', 'pass']);
	if (boardToSfn(reset.board) !== boardToSfn(plain.board)) {
		throw new Error('reset turn ends in\n  ' + boardToSfn(reset.board) + '\nnot\n  ' + boardToSfn(plain.board));
	}
	if (loopKeys(reset.board) !== loopKeys(plain.board)) {
		throw new Error('reset turn leaves a different threefold-repetition key');
	}

	// 2. Grow springlocked; cast Flourish, reset: Grow stays uncastable.
	const start2 = sfn(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10'], 'Grow');
	const rev = await play(start2, ['a11', 'Flourish', 'a2', '?', '?', '?', '?', 'reset', 'a11']);
	const last = rev.offered[rev.offered.length - 1];
	if (last.includes('Grow')) {
		throw new Error('after Reset Turn, a springlocked Grow became castable a third time');
	}
	console.log('springlock reset smoke OK');
	process.exit(0);
}
