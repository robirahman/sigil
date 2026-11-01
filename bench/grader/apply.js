#!/usr/bin/env node
/**
 * SigilBench: replay a submitted turn with the REAL browser rules.
 *
 * One JSON request per stdin line: {"sfn": <puzzle SFN>, "actions": [...]}
 * One JSON reply per line:
 *   {"ok": true, "after": <SFN, opponent to move>, "key": <puzzleSfnKey>,
 *    "gameover": bool, "winner": "red"|"blue"|null}
 *   {"ok": false, "error": "..."}            (malformed action list)
 *
 * The replay (docs/static/scripts/sigilbench-replay.js) is exactly the page's
 * (tools/puzzle-smoke.js --replay and rust-ai.js rustActionsToTurn):
 * applyAITurn, update, the Seal of Destruction end-of-turn burn,
 * checkGameOver, then the turn passes. applyAITurn does NOT
 * check legality -- it just mutates the board -- so the result is only a
 * CLAIM; bench_grade (Rust) accepts it only if some legal turn reaches the
 * same position.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');

const REPO = path.resolve(__dirname, '..', '..');
const ENGINE = path.join(REPO, 'docs', 'static', 'scripts', 'engine');
const sandbox = {
	console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
	setTimeout, clearTimeout, setInterval, clearInterval, Promise,
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
vm.runInContext('AI_REPLAY_INSTANT = true', sandbox);
// The action schema, validation and replay live in one file shared with the
// "Try the dev set" panel of docs/sigilbench.html.
const SHARED = path.join(REPO, 'docs', 'static', 'scripts', 'sigilbench-replay.js');
vm.runInContext(fs.readFileSync(SHARED, 'utf8'), sandbox, { filename: SHARED });
const replay = (sfn, actions) => sandbox.SigilBenchReplay.replay(sfn, actions);

const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on('line', (line) => {
	if (!line.trim()) return;
	chain = chain.then(async () => {
		let out;
		try {
			const req = JSON.parse(line);
			out = await replay(req.sfn, req.actions);
		} catch (e) {
			out = { ok: false, error: String((e && e.message) || e).split('\n')[0].slice(0, 300) };
		}
		process.stdout.write(JSON.stringify(out) + '\n');
	});
});
