#!/usr/bin/env node
/**
 * SpectatorController._seedHistory contract check (PR #67 Codex review):
 * when the replay of the game so far lands on the room's position, the
 * spectator's board takes the replay's repetition counts AND its Silence
 * state, which the SFN cannot carry but the repetition key includes. A board
 * that took only the counts would key the next position as unsilenced.
 *
 *   node tools/spectator-seed-smoke.js
 *
 * reconstructGameLog is stubbed (the replay itself is covered by
 * live-analysis-emulator-test.js): it reports a replay board on the room's
 * position with blue silenced and a known count table.
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
	matchMedia() { return { matches: false }; }, Image: function () {}, performance: { now: () => Date.now() },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js', 'sim-board.js',
	'features.js', 'enumerator.js', 'ai-player.js', 'game-controller.js', 'game-review.js', 'spectator-controller.js']) {
	vm.runInContext(fs.readFileSync(path.join(ENGINE, f), 'utf8'), sandbox, { filename: f });
}
const SPELLS = 'Flourish,Syzygy,Fissure,Decay,Gather,Seal_of_Wind,Seal_of_Summer,Azimuth,Surge';
const ROOM = 'r.........r..bb......................../' + SPELLS + ' r 3 0:0 -:- -:- b1';
const COUNTS = { 'p1-example': 2 };

let failures = 0;
const check = (ok, what, detail) => {
	console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail !== undefined ? ' ' + JSON.stringify(detail) : ''));
	if (!ok) failures++;
};

(async () => {
	const spells = SPELLS.split(',');
	sandbox.__ROOM = ROOM;
	sandbox.__COUNTS = COUNTS;
	vm.runInContext(`reconstructGameLog = async function (spellNames, variant, startSfn, turns, opts) {
		const b = new SigilBoard(spellNames, variant);
		b.loadFromSfn(__ROOM);
		b.silenced = { red: false, blue: true };
		b.allLoopingSnapshotCounts = Object.assign({}, __COUNTS);
		if (opts && opts.onBoard) opts.onBoard(b);
		return turns.map(() => ({ sfnAfter: __ROOM }));
	};`, sandbox);
	const events = [];
	const sync = { spectatorJoinTurns: [{ color: 'red', actions: ['a11', 'pass'] }, { color: 'blue', actions: ['b2', 'pass'] }], startSfn: null };
	const sc = vm.runInContext('(e, s, n) => new SpectatorController(e, s, n)', sandbox)((ev) => events.push(ev), sync, spells);
	sc.board = vm.runInContext('(n) => new SigilBoard(n, "standard")', sandbox)(spells);
	sc.board.loadFromSfn(ROOM);
	await sc._seedHistory(ROOM, 'standard');
	check(JSON.stringify(sc.board.allLoopingSnapshotCounts) === JSON.stringify(COUNTS), 'the repetition counts are taken from the replay', sc.board.allLoopingSnapshotCounts);
	check(sc.board.silenced && sc.board.silenced.blue === true && sc.board.silenced.red === false,
		'the replay\'s Silence state is taken too', sc.board.silenced);
	check(events.some((e) => e.type === 'history'), 'the history event is emitted');
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
