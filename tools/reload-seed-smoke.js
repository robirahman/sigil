#!/usr/bin/env node
/**
 * A seated player whose page reloads mid-game (MultiplayerController
 * _seedHistory, _endAsRoom), headless with the real engine and a stub sync:
 *
 *   node tools/reload-seed-smoke.js
 *
 * The game: each side places twice, then plays "null" turns (move, dash
 * sacrificing that stone and another, put the other back), so the position
 * before Red's turn 5 comes up again before turns 7 and 9: a twofold, then
 * a threefold (Blue wins) at the start of turn 9.
 *
 *   1. Reference: Red plays from the start and never reloads.
 *   2. Red reloads at the twofold (start of turn 7), Blue at the start of
 *      turn 8: each warns of the repetition, ends the game at the start of
 *      turn 9 as the reference does, and writes the same record (full game
 *      log, setup and final SFN). The room's result arriving first (the
 *      other client wrote it) does not cut its own ending short.
 *   3. The room's currentSfn trails its turns (a reload between a turn and
 *      its currentSfn write): the board goes on from the replay's position.
 *   4. A transcript that does not replay: a warning, the counts start
 *      empty and the board misses the threefold; the other client's result,
 *      which the room's turns show once they are readable again, ends the
 *      game here, on the reference's final position, with nothing written.
 *   5. A modified client closes the room with a win its moves do not show:
 *      the board does not take it, and says the server will judge it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const ENGINE = path.join(REPO, 'docs', 'static', 'scripts', 'engine');
const warnings = [];
const quiet = { log() {}, warn(...a) { warnings.push(a.map(String).join(' ')); }, error() {}, info() {}, debug() {} };
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
	'features.js', 'enumerator.js', 'ai-player.js', 'game-controller.js', 'game-review.js', 'multiplayer-controller.js']) {
	vm.runInContext(fs.readFileSync(path.join(ENGINE, f), 'utf8'), sandbox, { filename: f });
}
const E = vm.runInContext('({ MultiplayerController, reconstructGameLog, boardToSfn })', sandbox);

const SPELLS = ['Starfall', 'Flourish', 'Seal_of_Lightning', 'Grow', 'Fireblast', 'Hail_Storm', 'Surge', 'Slash', 'Sprout'];
const NULL = { red: ['a6', 'dash', 'a6', 'a2', 'a2', 'pass'], blue: ['b6', 'dash', 'b6', 'b2', 'b2', 'pass'] };
const TURNS = [['a11', 'pass'], ['b11', 'pass'], ['a2', 'pass'], ['b2', 'pass'],
	NULL.red, NULL.blue, NULL.red, NULL.blue].map((actions, i) => ({ color: i % 2 ? 'blue' : 'red', actions }));

let failures = 0;
const check = (ok, what, detail) => {
	console.log((ok ? 'ok   ' : 'FAIL ') + what + (detail !== undefined ? ' ' + JSON.stringify(detail) : ''));
	if (!ok) failures++;
};
const until = async (pred, what) => {
	for (let i = 0; i < 500; i++) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error('timed out waiting for ' + what);
};

/** The sync as the controller sees it after a join (or a reconnect that skipped `played`). */
function stubSync(played) {
	const sync = {
		variant: 'standard', startSfn: null, timeControl: { type: 'none' },
		reconnectTurns: played.map((t) => ({ color: t.color, actions: t.actions.slice() })),
		_turnKeys: played.map((_, i) => 'k' + i),
		_incomingQueue: [], _waitingResolver: null, sent: [], final: null, finish: null,
		// The room as the server holds it (readRoomResult), once finished.
		room: null,
		async readRoomResult() { return this.room; },
		serverNow: () => Date.now(),
		getNextOpponentAction() {
			if (this._incomingQueue.length) return Promise.resolve(this._incomingQueue.shift());
			return new Promise((r) => { this._waitingResolver = r; });
		},
		/** The opponent's turn arrives (child_added). */
		deliver(actions) {
			this._turnKeys.push('k' + this._turnKeys.length);
			for (const a of actions) {
				if (this._waitingResolver) { const r = this._waitingResolver; this._waitingResolver = null; r(a); } else this._incomingQueue.push(a);
			}
		},
		async sendTurn(actions) { this.sent.push(actions.slice()); this._turnKeys.push('k' + this._turnKeys.length); },
		saveGameState() {},
		writeRoomFinalState(winner, gameLog, finalSfn, setupSfn) {
			this.final = { winner, gameLog: JSON.parse(JSON.stringify(gameLog)), finalSfn, setupSfn };
		},
		async initTimer() {}, listenForForfeit() {}, listenToOpponentPresence() {}, listenForTakeback() {},
		listenForFinish(cb) { this.finish = cb; },
	};
	return sync;
}

/** A seated controller opening the room after `played`, on `roomSfn`. */
async function open(color, played, roomSfn, sync) {
	const events = [];
	const c = new E.MultiplayerController((ev) => events.push(ev), sync || stubSync(played), color, SPELLS.slice());
	c.events = events;
	await c.startGame(roomSfn || null);
	return c;
}

/** Play turn `i` of TURNS: clicks for our own, delivered for the opponent's. */
async function playTurn(c, i) {
	const t = TURNS[i];
	if (t.color !== c.myColor) { c.sync.deliver(t.actions); return; }
	for (const a of t.actions) {
		await until(() => c._inputResolve, 'input for ' + a);
		c.handlePlayerAction(a);
	}
	await until(() => c.sync.sent.length && c.sync.sent[c.sync.sent.length - 1].join() === t.actions.join(), 'turn ' + (i + 1) + ' sent');
}
const over = (c) => c.events.find((e) => e.type === 'game_over');
const said = (c, re) => c.events.filter((e) => e.type === 'message' && re.test(e.message || '')).length;
const slim = (log) => (log || []).map((t) => [t.color, t.turnNumber, (t.actions || []).join(' '), t.sfnBefore, t.sfnAfter].join('|'));

(async () => {
	// The positions after each turn, for the rooms' currentSfn.
	const rebuilt = await E.reconstructGameLog(SPELLS, 'standard', null, TURNS.map((t, i) => Object.assign({ turnNumber: i + 1 }, t)));
	const after = rebuilt.map((t) => t.sfnAfter);

	// 1. Reference: no reload.
	const ref = await open('red', [], null);
	for (let i = 0; i < TURNS.length; i++) await playTurn(ref, i);
	await until(() => over(ref), 'the reference game to end');
	check(over(ref).winner === 'blue' && said(ref, /Threefold repetition/) === 1, 'reference: threefold repetition at the start of turn 9, Blue wins');
	check(said(ref, /Repeated position/) === 2, 'reference: the twofold warnings (turns 7 and 8)', said(ref, /Repeated position/));
	check(ref.sync.final && ref.sync.final.winner === 'blue' && ref.sync.final.gameLog.length === 8, 'reference: the record is written');

	// 2. Red reloads at the twofold; Blue at the start of turn 8.
	for (const [color, n] of [['red', 6], ['blue', 7]]) {
		warnings.length = 0;
		const c = await open(color, TURNS.slice(0, n), after[n - 1]);
		check(said(c, /Repeated position/) === 1, color + ' reloaded at turn ' + (n + 1) + ': the twofold is announced');
		check(c._gameLog.length === n, color + ': the game log holds the turns before the reload', c._gameLog.length);
		check(c.events.some((e) => e.type === 'history' && e.sfns.length === n), color + ': the earlier positions are handed on');
		for (let i = n; i < TURNS.length; i++) {
			// The other client's result lands with the last turn, before this
			// board has played it: its own ending still comes.
			if (i === TURNS.length - 1 && TURNS[i].color !== color) {
				c.sync.deliver(TURNS[i].actions);
				c.sync.finish('blue', 'finished');
				continue;
			}
			await playTurn(c, i);
			if (i === TURNS.length - 1) c.sync.finish('blue', 'finished');
		}
		await until(() => over(c), color + '\'s game to end');
		check(over(c).winner === 'blue' && said(c, /Threefold repetition/) === 1, color + ': its own threefold repetition, Blue wins');
		const f = c.sync.final;
		check(!!f && f.winner === 'blue', color + ': it writes the result');
		check(!!f && JSON.stringify(slim(f.gameLog)) === JSON.stringify(slim(ref.sync.final.gameLog)), color + ': the record\'s game log is the reference\'s');
		check(!!f && f.finalSfn === ref.sync.final.finalSfn && f.setupSfn === ref.sync.final.setupSfn, color + ': the same setup and final positions',
			f && { final: f.finalSfn, setup: f.setupSfn });
		check(warnings.length === 0, color + ': no warning', warnings);
	}

	// 3. currentSfn one turn behind the turns the reconnect skipped.
	warnings.length = 0;
	const behind = await open('red', TURNS.slice(0, 6), after[4]);
	// On currentSfn the board would wait for Blue's turn 6, which the
	// reconnect skipped; on the replay's position it is Red's turn 7.
	await until(() => behind._inputResolve, 'turn 7');
	check(behind.board.turnCounter === 7 && behind.board.whoseTurn === 'red' && warnings.length === 0,
		'trailing currentSfn: the board goes on from the last turn played', { turn: behind.board.turnCounter, warnings });
	for (let i = 6; i < TURNS.length; i++) await playTurn(behind, i);
	await until(() => over(behind), 'the trailing game to end');
	check(said(behind, /Threefold repetition/) === 1 && behind.sync.final && behind.sync.final.gameLog.length === 8, 'trailing currentSfn: the threefold and a full record');

	// 4. A transcript that does not replay: warned, and the room's result ends it.
	warnings.length = 0;
	const broken = TURNS.slice(0, 6).map((t) => Object.assign({}, t));
	broken[0] = { color: 'red', actions: ['pass'] };
	const lost = await open('red', broken, after[5], stubSync(broken));
	check(warnings.some((w) => /\[Controller\].*does not reach|\[Controller\].*could not replay/.test(w)), 'unreplayable: a warning', warnings);
	check(lost._gameLog.length === 0 && Object.keys(lost.board.allLoopingSnapshotCounts).length === 1, 'unreplayable: no history');
	for (let i = 6; i < TURNS.length; i++) await playTurn(lost, i);
	// This board missed the threefold and gives Red turn 9.
	await until(() => lost._inputResolve, 'turn 9');
	check(!over(lost) && lost.board.turnCounter === 9, 'unreplayable: the board missed the threefold');
	lost.sync.room = { status: 'finished', winner: 'blue', turns: TURNS };
	lost.sync.finish('blue', 'finished');
	await until(() => over(lost), 'the room\'s result');
	check(over(lost).winner === 'blue' && lost.board.gameover && lost.board.winner === 'blue', 'the room\'s result ends the game here');
	check(E.boardToSfn(lost.board) === ref.sync.final.finalSfn, 'on the position the game ended on', E.boardToSfn(lost.board));
	check(lost.sync.final === null, 'and nothing is written');
	lost.handlePlayerAction('a6');
	check(lost._turnBuffer.length <= 1 && lost.sync.sent.length === 1, 'a click after it does nothing');

	// 5. Blue's modified client closes the room as a Blue win after turn 4.
	warnings.length = 0;
	const forged = await open('red', [], null);
	for (let i = 0; i < 4; i++) await playTurn(forged, i);
	await until(() => forged._inputResolve, 'turn 5');
	forged.sync.room = { status: 'finished', winner: 'blue', turns: TURNS.slice(0, 4) };
	forged.sync.finish('blue', 'finished');
	await until(() => said(forged, /result the moves do not show/), 'the notice');
	check(!over(forged) && !forged.board.gameover, 'a forged close: the board does not take the result');
	check(warnings.some((w) => /\[Controller\].*moves do not show/.test(w)) && forged.sync.final === null, 'it is warned of, and nothing is written', warnings);

	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
