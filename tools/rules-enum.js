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
const G = vm.runInContext('({ GameController, puzzleImportSfn, boardToSfn, sfnToDict, NODE_ORDER: () => NODE_ORDER })', sandbox);

const MAX_TOKENS = 64;
const PROGRESS = !!process.env.RULES_ENUM_PROGRESS;
const UI_BUTTONS = new Set(['dash', 'skip_providence', 'pass', 'submit']);

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
			entryArgs = JSON.stringify(args);
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
			const p = Object.assign({}, payload);
			delete p.message;   // display text: Corrupt-style counters also show in board/args
			finish({
				kind: 'prompt', payload, now: G.boardToSfn(gc.board),
				state: h(entryBoard + '|' + entryArgs + '|' + JSON.stringify(sinceEntry)),
				board: h(JSON.stringify(gc.board) + '|' + JSON.stringify(payload)),
			});
			return new Promise(() => {});
		};
		const origCatch = (e) => finish({ kind: 'error', error: String((e && e.message) || e) });
		gc.startGame(G.puzzleImportSfn(sfn)).catch(origCatch);
		// turn ended (by token overflow) is detected through the next prompt
		setImmediate(() => {});
	});
}

let currentError = null;
process.on('unhandledRejection', (e) => { if (currentError) currentError(e); else throw e; });

async function enumerate(sfn) {
	const t0 = Date.now();
	const variant = variantOf(sfn);
	const nodes = G.NODE_ORDER().slice();
	const children = new Map();
	const seen = new Set();
	const stack = [{ prefix: [], parent: null }];
	let runs = 0, pruned = 0, errors = 0;
	while (stack.length) {
		const { prefix, parent: parentBoard } = stack.pop();
		if (PROGRESS && runs % 20000 === 0) process.stderr.write(`runs ${runs} states ${seen.size} children ${children.size} stack ${stack.length} ${Date.now() - t0} ms\n`);
		runs++;
		let r;
		try {
			r = await new Promise((res) => { currentError = (e) => res({ kind: 'error', error: String((e && e.message) || e) }); run(sfn, prefix, variant).then(res); });
		} finally { currentError = null; }
		if (r.kind === 'error') { errors++; continue; }
		if (r.kind === 'end') {
			const k = normKey(r.sfn);
			if (!children.has(k)) children.set(k, { sfn: r.sfn, key: k, tokens: prefix, gameover: r.gameover, winner: r.winner });
			continue;
		}
		if (r.kind !== 'prompt') continue;
		if (parentBoard !== null && parentBoard === r.board) { pruned++; continue; }   // rejected input: same prompt again
		if (seen.has(r.state)) continue;
		seen.add(r.state);
		if (prefix.length >= MAX_TOKENS) { errors++; continue; }
		for (const tok of alphabet(r.payload, nodes).reverse()) stack.push({ prefix: prefix.concat([tok]), parent: r.board });
	}
	return { sfn, children: [...children.values()], stats: { runs, states: seen.size, pruned_noop: pruned, errors, ms: Date.now() - t0 } };
}

module.exports = { enumerate, normKey, run, variantOf, G };

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
