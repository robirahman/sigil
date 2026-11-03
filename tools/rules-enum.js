#!/usr/bin/env node
/**
 * Exhaustive turn enumeration through the browser's INTERACTIVE rules -- the
 * GameController a human plays -- for SigilBench verification.
 *
 *   node tools/rules-enum.js < sfns.txt > children.jsonl
 *   (one SFN per line, side to move = the mover; one JSON line out per input:
 *    {"sfn", "children": [{"sfn", "key", "tokens", "gameover", "winner"}],
 *     "stats": {"runs", "states", "pruned_noop", "ms"}})
 *
 * Why this and not sim-board.js's enumerator: the AI enumerator is a second
 * implementation of the rules that shared the Rust engine's old narrowing
 * (Rock Slide best-net pushes, Corrupt max-only), so it cannot check the
 * engine. This walks the controller's prompts instead, feeding every input the
 * UI can send at each prompt (game-board-local.js handleNodeClick /
 * handleCastSpell / handleDash / handleSkipProvidence / handleEndTurn /
 * handleSubmit):
 *   - a node, when awaiting 'node', or awaiting 'action' with 'move' or
 *     'providence' in the action list;
 *   - each of dash / skip_providence / pass / submit in the action list;
 *   - each spell in the action list (awaiting 'action').
 * The controller's coroutine cannot be forked, so every explored prefix is
 * replayed from the start position. Two prefixes are merged when they agree on
 * the board at the latest _takeTurn entry, its arguments, and every token
 * since: the controller's state is a function of exactly those (each
 * _takeTurn call is a tail call). A token after which the controller re-asks
 * the same prompt with the same board is a rejected input (the UI's retry
 * loops) and is pruned.
 *
 * Output children are DISTINCT resulting positions, keyed by the SFN with the
 * side-to-move and turn-counter tokens dropped (normKey), the same key
 * tools/rules-diff.py compares against the Rust enumerator.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');
const crypto = require('crypto');
const h = (x) => crypto.createHash('sha1').update(x).digest('base64');

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
const FILES = [
	'constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js', 'sim-board.js',
	'features.js', 'enumerator.js', 'ai-player.js', 'game-controller.js', 'game-review.js', 'rust-ai.js',
].map(f => path.join(ENGINE, f)).concat([path.join(REPO, 'docs', 'static', 'scripts', 'game-board-local.js')]);
for (const f of FILES) vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
const G = vm.runInContext('({ GameController, SigilBoard, puzzleImportSfn, boardToSfn, sfnToDict, NODE_ORDER: () => NODE_ORDER })', sandbox);

const MAX_TOKENS = 64;
const PROGRESS = !!process.env.RULES_ENUM_PROGRESS;
const TRACE = !!process.env.RULES_ENUM_TRACE;
const UI_BUTTONS = new Set(['dash', 'skip_providence', 'pass', 'submit']);

/** The SFN with the turn handed over: side-to-move flipped, counter + 1
 * (the form bench/grader/apply.js returns, ready to enumerate again). */
function handOver(sfn) {
	const p = String(sfn).trim().split(/\s+/);
	p[1] = p[1] === 'r' ? 'b' : 'r';
	p[2] = String(parseInt(p[2], 10) + 1);
	return p.join(' ');
}

function normKey(sfn) {
	const p = String(sfn).trim().split(/\s+/);
	return [p[0]].concat(p.slice(3)).join(' ');
}

function variantOf(sfn) {
	try { return (G.sfnToDict(sfn) || {}).variant || 'standard'; } catch (e) { return 'standard'; }
}

/** Inputs the UI can send at this prompt. */
function alphabet(payload, nodes) {
	const out = [];
	const al = Array.isArray(payload.actionlist) ? payload.actionlist : [];
	if (payload.awaiting === 'node' || (payload.awaiting === 'action' && (al.includes('move') || al.includes('providence')))) {
		out.push(...nodes);
	}
	if (payload.awaiting === 'action' || payload.awaiting === 'node') {
		for (const a of al) {
			if (UI_BUTTONS.has(a)) out.push(a);
			else if (payload.awaiting === 'action' && a !== 'move' && a !== 'providence') out.push(a); // spells
		}
	}
	return [...new Set(out)];
}

/**
 * Replay `tokens` from `sfn` through a fresh controller. Resolves to
 *   {kind:'prompt', payload, state, board}   the controller awaits input
 *   {kind:'end', sfn, gameover, winner}       the mover's turn completed
 *   {kind:'overrun'}                          the turn ended before the prefix did
 */
function run(sfn, tokens, variant) {
	return new Promise((resolve) => {
		let i = 0, done = false, turn = null;
		let entryBoard = null, entryArgs = null, sinceEntry = [];
		const finish = (r) => { if (!done) { done = true; resolve(r); } };
		const gc = new G.GameController((ev) => {
			if (done) return;
			if (ev.type === 'turn_complete') turn = ev.turn;
			else if (ev.type === 'game_over' && turn) finish({ kind: 'end', sfn: turn.sfnAfter, gameover: true, winner: ev.winner });
			else if (ev.type === 'game_over') finish({ kind: 'end', sfn: G.boardToSfn(gc.board), gameover: true, winner: ev.winner, early: true });
		}, { variant });
		gc._delay = () => Promise.resolve();
		const realTake = G.GameController.prototype._takeTurn;
		gc._takeTurn = function (...args) {
			entryBoard = JSON.stringify(gc.board);
			entryArgs = args;
			sinceEntry = [];
			return realTake.apply(this, args);
		};
		gc._waitForInput = function (payload) {
			if (done) return new Promise(() => {});
			if (turn) {   // the next turn's first prompt: the mover's turn is over
				finish({ kind: 'end', sfn: turn.sfnAfter, gameover: !!gc.board.gameover, winner: gc.board.winner || null });
				return new Promise(() => {});
			}
			if (i < tokens.length) {
				const t = tokens[i++];
				sinceEntry.push(t);
				return Promise.resolve(t);
			}
			finish(promptResult(gc, payload, entryBoard, entryArgs, sinceEntry));
			return new Promise(() => {});
		};
		const origCatch = (e) => finish({ kind: 'error', error: String((e && e.message) || e) });
		gc.startGame(G.puzzleImportSfn(sfn)).catch(origCatch);
		// turn ended (by token overflow) is detected through the next prompt
		setImmediate(() => {});
	});
}

/**
 * Resume at a recorded _takeTurn entry instead of replaying from the start:
 * restore the board as it was at that entry, call _takeTurn with the same
 * arguments, feed `since`, and on return run the game loop's turn tail
 * (_eotTriggers, update, then the next turn's opening Seal of Destruction
 * check). Equivalent to run() because every _takeTurn call is a tail call;
 * tools/rules-diff.py --check-resume compares the two on a sample.
 */
function runFrom(entry, since, variant) {
	return new Promise((resolve) => {
		let i = 0, done = false;
		let entryBoard = null, entryArgs = null, sinceEntry = [];
		const finish = (r) => { if (!done) { done = true; resolve(r); } };
		const gc = new G.GameController(() => {}, { variant });
		const saved = JSON.parse(entry.board);
		const board = new G.SigilBoard(saved.spellNames, variant);
		Object.assign(board, saved);
		gc.board = board;
		const realTake = G.GameController.prototype._takeTurn;
		gc._takeTurn = function (...args) {
			entryBoard = JSON.stringify(gc.board);
			entryArgs = args;
			sinceEntry = [];
			return realTake.apply(this, args);
		};
		gc._waitForInput = function (payload) {
			if (done) return new Promise(() => {});
			if (i < since.length) {
				const t = since[i++];
				sinceEntry.push(t);
				return Promise.resolve(t);
			}
			finish(promptResult(gc, payload, entryBoard, entryArgs, sinceEntry));
			return new Promise(() => {});
		};
		const color = board.whoseTurn;
		(async () => {
			await gc._takeTurn(...entry.args);
			if (done) return;
			gc._eotTriggers(color);
			board.update();
			const sfn = G.boardToSfn(board);
			let gameover = !!board.gameover, winner = board.winner || null;
			const next = board.enemy(color);
			if (!gameover && board.chargedSpells[next].includes('Seal_of_Destruction')) { gameover = true; winner = color; }
			finish({ kind: 'end', sfn, gameover, winner });
		})().catch((e) => finish({ kind: 'error', error: String((e && e.message) || e) }));
	});
}

function promptResult(gc, payload, entryBoard, entryArgs, sinceEntry) {
	return {
		kind: 'prompt', payload, now: TRACE ? G.boardToSfn(gc.board) : undefined,
		entry: { board: entryBoard, args: entryArgs }, since: sinceEntry.slice(),
		state: h(entryBoard + '|' + JSON.stringify(entryArgs) + '|' + JSON.stringify(sinceEntry)),
		board: h(JSON.stringify(gc.board) + '|' + JSON.stringify(payload)),
	};
}

let currentError = null;
process.on('unhandledRejection', (e) => { if (currentError) currentError(e); else throw e; });

/**
 * Every distinct position the mover can reach. Options:
 *   resume (default true): runFrom for every prefix after the first prompt;
 *     false replays each prefix from the start through run() (the reference);
 *   target: a normKey -- stop as soon as that position is reached (a legality
 *     check: reaching it through the controller proves the turn legal);
 *   prefer: a Set of tokens explored first (e.g. the nodes and spells of the
 *     action list that claims to reach `target`).
 * Children carry `sfn` in handed-over form (opponent to move).
 */
async function enumerate(sfn, opts = {}) {
	const resume = opts.resume !== undefined ? opts.resume : !process.env.RULES_ENUM_FULL_REPLAY;
	const t0 = Date.now();
	const variant = variantOf(sfn);
	const nodes = G.NODE_ORDER().slice();
	const children = new Map();
	const seen = new Set();
	const stack = [{ prefix: [], parent: null, entry: null, since: null }];
	let runs = 0, pruned = 0, errors = 0;
	while (stack.length) {
		const it = stack.pop();
		const { prefix, parent: parentBoard } = it;
		if (PROGRESS && runs % 20000 === 0) process.stderr.write(`runs ${runs} states ${seen.size} children ${children.size} stack ${stack.length} ${Date.now() - t0} ms\n`);
		runs++;
		let r;
		try {
			r = await new Promise((res) => {
				currentError = (e) => res({ kind: 'error', error: String((e && e.message) || e) });
				(resume && it.entry ? runFrom(it.entry, it.since, variant) : run(sfn, prefix, variant)).then(res);
			});
		} finally { currentError = null; }
		if (r.kind === 'error') { errors++; if (PROGRESS) process.stderr.write('error ' + r.error + ' ' + JSON.stringify(prefix) + '\n'); continue; }
		if (r.kind === 'end') {
			const k = normKey(r.sfn);
			if (!children.has(k)) children.set(k, { sfn: handOver(r.sfn), key: k, tokens: prefix, gameover: r.gameover, winner: r.winner });
			if (opts.target && k === opts.target) break;
			continue;
		}
		if (r.kind !== 'prompt') continue;
		if (parentBoard !== null && parentBoard === r.board) { pruned++; continue; }   // rejected input: same prompt again
		if (seen.has(r.state)) continue;
		seen.add(r.state);
		if (prefix.length >= MAX_TOKENS) { errors++; continue; }
		let toks = alphabet(r.payload, nodes);
		if (opts.prefer) toks = toks.filter(t => !opts.prefer.has(t)).concat(toks.filter(t => opts.prefer.has(t)));
		else toks.reverse();
		for (const tok of toks) {
			stack.push({ prefix: prefix.concat([tok]), parent: r.board, entry: r.entry, since: r.since.concat([tok]) });
		}
	}
	return { sfn, children: [...children.values()], stats: { runs, states: seen.size, pruned_noop: pruned, errors, ms: Date.now() - t0 } };
}

module.exports = { enumerate, normKey, handOver, run, runFrom, variantOf, G };

if (require.main === module) {
	const rl = readline.createInterface({ input: process.stdin });
	const lines = [];
	rl.on('line', (l) => { if (l.trim()) lines.push(l.trim()); });
	rl.on('close', async () => {
		for (const sfn of lines) {
			const r = await enumerate(sfn);
			process.stdout.write(JSON.stringify(r) + '\n');
		}
	});
}
