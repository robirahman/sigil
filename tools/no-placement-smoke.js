#!/usr/bin/env node
// A player with NO legal stone placement (surrounded, enemy Seal of Stone)
// may still dash, cast or pass: a turn is move + optional dash + optional
// cast, and a missing first move invalidates only the move (ruling
// 2026-08-26; the engine's `enumerate_turns_capped` and the lazy stream
// already agree). The site used to `return` out of `_takeTurn` and skip the
// whole turn, and both JS enumerators collapsed the turn to a bare pass.
//
// Checks, on the engine test fixture `no_first_move_board` (red: b4 b7 b8,
// walled in by blue, blue holds Seal of Stone; red's Sprout is charged):
//   1. `SimBoard.getLegalTurns` and `getLegalTurnsExhaustive` both offer a
//      dash and a cast, not just [pass].
//   2. `hydrateGameLog` replays a human transcript that starts with `dash`
//      (dash, two sacrifices, the placement, pass) to the position the Rust
//      engine reaches for the same turn.
//
//   node tools/no-placement-smoke.js
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.dirname(__dirname);
const ENGINE = path.join(REPO, 'docs', 'static', 'scripts', 'engine');
const FILES = [
	'constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js',
	'sim-board.js', 'features.js', 'enumerator.js',
	'ai-player.js', 'game-controller.js', 'game-review.js',
];
let src = FILES.map((f) => fs.readFileSync(path.join(ENGINE, f), 'utf8')).join('\n;\n');
src += `\n;\n(${driver.toString()})().catch((e) => { console.error(e); process.exit(1); });\n`;
new Function('require', src)(require);

async function driver() {
	// The Rust fixture, as `Board::to_sfn` prints it (engine/src/tests.rs
	// `no_first_move_board`), and the position the engine reaches after the
	// turn [dash (sacrifice b4, b7), place b7, pass].
	const SFN = '.......bbb.....brb.rrbb..............b./Flourish,Carnage,Bewitch,Seal_of_Stone,Fireblast,Hail_Storm,Seal_of_Summer,Sprout,Slash r 1 0:0 -:- -:- b3 deathmatch';
	const AFTER_STONES = '.......bbb.....b.b.rrbb..............b.';
	const spellNames = SFN.split('/')[1].split(' ')[0].split(',');

	// 1. The two JS enumerators.
	const sim = sfnToSimBoard(SFN);
	sim.update();
	const first = (t) => (t.actions && t.actions[0] && t.actions[0].type) || '?';
	const greedy = [...sim.getLegalTurns('red')].map(first);
	const exhaustive = getLegalTurnsExhaustive(sim, 'red').map(first);
	for (const [name, kinds] of [['getLegalTurns', greedy], ['getLegalTurnsExhaustive', exhaustive]]) {
		if (!kinds.includes('pass')) throw new Error(name + ': no bare pass');
		if (!kinds.includes('dash')) throw new Error(name + ': no dash turn (' + kinds.join(',') + ')');
		if (!kinds.includes('cast')) throw new Error(name + ': no cast turn (' + kinds.join(',') + ')');
		if (kinds.some((k) => k === 'move' || k === 'hard_move' || k === 'blink')) {
			throw new Error(name + ': a first move appeared in a position that has none');
		}
	}

	// 2. The controller's input path, through the shared replayer.
	const fat = await hydrateGameLog(spellNames, 'deathmatch', SFN, null, [
		{ color: 'red', kind: 'input', turnNumber: 1, actions: ['dash', 'b4', 'b7', 'b7', 'pass'] },
	]);
	if (fat.length !== 1) throw new Error('expected one replayed turn, got ' + fat.length);
	const stones = fat[0].sfnAfter.split('/')[0];
	if (stones !== AFTER_STONES) {
		throw new Error('dash-first turn replayed to\n  ' + stones + '\nexpected\n  ' + AFTER_STONES);
	}
	console.log('no-placement smoke OK: greedy ' + greedy.length + ' turns, exhaustive ' +
	            exhaustive.length + ' turns, dash-first transcript replays');
}
