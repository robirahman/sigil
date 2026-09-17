#!/usr/bin/env node
/**
 * Headless check of the Puzzles page's contract against the REAL browser
 * engine (GameController + applyAITurn), without a browser.
 *
 *   node tools/puzzle-smoke.js [docs/static/puzzles/mate_puzzles.json] [--limit N] [--verbose]
 *
 * For every puzzle whose stored solution is expressible as input tokens
 * (moves, hard moves with a push choice, blinks, dashes -- casts need the
 * spell prompts and are skipped, counted separately), this script:
 *
 *   1. starts a GameController from puzzleImportSfn(puzzle.sfn) with the
 *      PuzzleOpponent as the other side, exactly as puzzles.html does;
 *   2. asserts the first prompt is for the puzzle's mover and that the live
 *      board is the puzzle position (same puzzleSfnKey, same turn counter);
 *   3. plays the first stored solution through the human-input path;
 *   4. mate-in-1: asserts game_over with the mover winning;
 *      mate-in-2: asserts the scripted defence replays onto the position the
 *      solver predicted, plays the stored finishing move, asserts game_over.
 *
 * A failure here is a disagreement between the Rust solver and the browser
 * rules -- the thing the page exists to surface -- so it prints the SFN.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const ENGINE = path.join(REPO, 'docs', 'static', 'scripts', 'engine');
const args = process.argv.slice(2);
const jsonPath = args.find(a => !a.startsWith('--')) || path.join(REPO, 'docs', 'static', 'puzzles', 'mate_puzzles.json');
const limitIx = args.indexOf('--limit');
const LIMIT = limitIx >= 0 ? parseInt(args[limitIx + 1], 10) : 0;
const VERBOSE = args.includes('--verbose');

// ---- minimal browser shims so game-board-local.js's module-level code loads
const sandbox = {
	console, setTimeout, clearTimeout, setInterval, clearInterval, Promise,
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

const FILES = [
	'constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js', 'sim-board.js',
	'features.js', 'enumerator.js', 'ai-player.js', 'game-controller.js', 'game-review.js',
].map(f => path.join(ENGINE, f)).concat([path.join(REPO, 'docs', 'static', 'scripts', 'game-board-local.js')]);
for (const f of FILES) {
	vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
}
const { GameController, PuzzleOpponent, puzzleImportSfn, puzzleSfnKey, boardToSfn } = sandbox;
for (const [k, v] of Object.entries({ GameController, PuzzleOpponent, puzzleImportSfn, puzzleSfnKey, boardToSfn })) {
	if (typeof v !== 'function') { console.error('missing global', k); process.exit(2); }
}

/** Token plan for an applyAITurn action list, or null if it needs spell prompts. */
function tokenPlan(actions) {
	const plan = [];       // {kind:'node'|'action', token}
	for (const a of actions || []) {
		switch (a.type) {
			case 'pass': break;
			case 'move': case 'blink': plan.push({ kind: 'node', token: a.node }); break;
			case 'hard_move':
				plan.push({ kind: 'node', token: a.node });
				if (a.pushed_to) plan.push({ kind: 'node', token: a.pushed_to, optional: true });
				break;
			case 'dash': case 'dash_lightning':
				plan.push({ kind: 'action', token: 'dash' });
				for (const n of (a.sacrificed || [])) plan.push({ kind: 'node', token: n });
				break;
			default: return null;   // cast / resolver actions: not driven here
		}
	}
	plan.push({ kind: 'action', token: 'pass' });
	return plan;
}

function runPuzzle(puzzle) {
	return new Promise((resolve) => {
		const mover = puzzle.mover;
		const opp = mover === 'red' ? 'blue' : 'red';
		const sol = (puzzle.solutions || [])[0];
		if (!sol) return resolve({ status: 'skip', why: 'no stored solution' });
		const plan1 = tokenPlan(sol.actions);
		const plan2 = puzzle.mate === 2 ? tokenPlan(sol.finish && sol.finish.actions) : [];
		if (!plan1 || (puzzle.mate === 2 && (!sol.finish || !plan2))) {
			return resolve({ status: 'skip', why: 'solution needs spell prompts' });
		}
		let plan = plan1.slice();
		let stage = 'first';                 // first | defence | finish | done
		let checkedStart = false;
		const log = [];
		let finished = false;
		const finish = (r) => { if (!finished) { finished = true; clearTimeout(timer); resolve(Object.assign({ log }, r)); } };
		const timer = setTimeout(() => finish({ status: 'fail', why: 'timeout (engine waiting for input the plan did not provide)' }), 8000);

		let gc;
		const component = { puzzleStatus: 'playing' };
		const opponent = new PuzzleOpponent(puzzle, component);
		gc = new GameController((ev) => {
			log.push(ev.type + (ev.message ? ': ' + ev.message : ''));
			if (finished) return;
			if (ev.type === 'message' && ev.awaiting) {
				if (!checkedStart) {
					checkedStart = true;
					const sfn = boardToSfn(gc.board);
					if (gc.board.whoseTurn !== mover) return finish({ status: 'fail', why: 'first prompt is for ' + gc.board.whoseTurn + ', not the mover' });
					if (puzzleSfnKey(sfn) !== puzzleSfnKey(puzzle.sfn)) return finish({ status: 'fail', why: 'live board differs from puzzle position: ' + sfn });
					if (String(gc.board.turnCounter) !== puzzle.sfn.split(/\s+/)[2]) return finish({ status: 'fail', why: 'turn counter ' + gc.board.turnCounter + ' vs ' + puzzle.sfn.split(/\s+/)[2] });
				}
				if (gc.board.whoseTurn !== mover) return;   // opponent prompts (none expected)
				// Feed the next planned token matching what the engine awaits.
				let next = plan[0];
				if (!next) return finish({ status: 'fail', why: 'engine asked for more input (' + ev.awaiting + ': ' + ev.message + ') after the plan ran out' });
				if (next.kind !== ev.awaiting) {
					if (next.optional && ev.awaiting === 'action') { plan.shift(); next = plan[0]; }
					else return finish({ status: 'fail', why: 'engine awaits ' + ev.awaiting + ' (' + ev.message + ') but plan has ' + next.kind + ' ' + next.token });
				}
				plan.shift();
				setTimeout(() => gc.handlePlayerAction(next.token), 0);
				return;
			}
			if (ev.type === 'turn_complete') {
				const t = ev.turn;
				if (t.color === mover && stage === 'first') {
					const key = puzzleSfnKey(t.sfnAfter);
					if (!puzzle.solution_keys.includes(key)) return finish({ status: 'fail', why: 'played the stored solution but reached a position not in solution_keys: ' + t.sfnAfter });
					stage = puzzle.mate === 1 ? 'done' : 'defence';
				} else if (t.color === opp && stage === 'defence') {
					if (puzzleSfnKey(t.sfnAfter) !== puzzleSfnKey(sol.defence.after)) return finish({ status: 'fail', why: 'defence replayed to ' + t.sfnAfter + ' but solver predicted ' + sol.defence.after });
					stage = 'finish';
					plan = plan2.slice();
				} else if (t.color === mover && stage === 'finish') {
					stage = 'done';
				}
				return;
			}
			if (ev.type === 'game_over') {
				if (ev.winner !== mover) return finish({ status: 'fail', why: 'game over but winner is ' + ev.winner });
				if (stage !== 'done') return finish({ status: 'fail', why: 'game ended early at stage ' + stage });
				return finish({ status: 'ok' });
			}
			if (ev.type === 'whoseturndisplay' && ev.color === opp && puzzle.mate === 1) {
				return finish({ status: 'fail', why: 'mate-in-1 solution did not end the game; opponent to move at ' + boardToSfn(gc.board) });
			}
		}, { aiColor: opp, ai: opponent, variant: puzzle.variant || 'standard' });
		gc.startGame(puzzleImportSfn(puzzle.sfn)).catch(e => finish({ status: 'fail', why: 'startGame threw: ' + (e && e.message) }));
	});
}

(async () => {
	const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
	let puzzles = data.puzzles || [];
	if (LIMIT) puzzles = puzzles.slice(0, LIMIT);
	const tally = { ok: 0, fail: 0, skip: 0 };
	const fails = [];
	for (const p of puzzles) {
		const r = await runPuzzle(p);
		tally[r.status]++;
		if (r.status === 'fail') fails.push({ id: p.id, mate: p.mate, why: r.why, sfn: p.sfn, log: r.log.slice(-6) });
		if (VERBOSE || r.status === 'fail') console.log(`${r.status.toUpperCase().padEnd(4)} ${p.id} mate-in-${p.mate} ${r.why || ''}`);
	}
	console.log(`\n${puzzles.length} puzzles: ${tally.ok} ok, ${tally.fail} FAIL, ${tally.skip} skipped (cast solutions need the spell prompts)`);
	for (const f of fails) {
		console.log(`\nFAIL ${f.id} (mate-in-${f.mate}): ${f.why}\n  sfn: ${f.sfn}\n  last events: ${f.log.join(' | ')}`);
	}
	process.exit(tally.fail ? 1 : 0);
})();
