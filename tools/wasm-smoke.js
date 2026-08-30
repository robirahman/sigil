// Headless gate for the Rust engine's WebAssembly build.
//
// Loads the committed no-modules glue + .wasm from docs/static/wasm/ alongside
// the browser engine files (the ai/replay_bridge.py concatenation pattern) and
// plays scripted games: every pick_move_actions result is replayed through the
// SAME applyAITurn + partial-SFN comparison rust-ai.js uses as its gate, so a
// pass here means the wasm engine's action lists reproduce its own positions
// under the browser's rules.
//
// Run after every `engine/build-wasm.sh`:   node tools/wasm-smoke.js
//
// Exit 0 = every ply of every game verified, plus the edge cases:
//   * a 1 ms budget still returns a playable (non-empty) action list — an empty
//     one can never pass the replay gate, because the gate's probe advances the
//     side to move, which IS part of the compared key;
//   * an unknown eval name and an out-of-scope spell both return ok:false.

'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.dirname(__dirname);
const ENGINE = path.join(REPO, 'docs', 'static', 'scripts', 'engine');
const WASM_DIR = path.join(REPO, 'docs', 'static', 'wasm');

// Superset of ai/replay_bridge.py's list: sim-board for the probe boards,
// features/enumerator because sim-board's evaluation hooks reference them.
const FILES = [
	'constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js',
	'sim-board.js', 'features.js', 'enumerator.js',
	'ai-player.js', 'game-controller.js', 'game-review.js',
];

let src = FILES.map((f) => fs.readFileSync(path.join(ENGINE, f), 'utf8')).join('\n;\n');
src += '\n;\n' + fs.readFileSync(path.join(WASM_DIR, 'sigil_engine.js'), 'utf8');
src += `\n;\n(${driver.toString()})().catch((e) => { console.error(e); process.exit(1); });\n`;
// One function scope: engine globals and the glue's `let wasm_bindgen` are all
// local to it, exactly as they share one global scope in the browser.
new Function('require', '__dirname', 'WASM_DIR', src)(require, __dirname, WASM_DIR);

async function driver() {
	// Serialized into the engine scope via toString(), so no outer closure:
	// everything it needs is defined here or passed as a scope argument.
	const GAMES = 3;          // distinct random official-pack draws
	const PLIES = 24;         // per game, or until game over
	const BUDGET_MS = 200;
	const fs = require('fs');
	const path = require('path');
	await wasm_bindgen({ module_or_path: fs.readFileSync(path.join(WASM_DIR, 'sigil_engine_bg.wasm')) });
	const info = JSON.parse(wasm_bindgen.engine_info());
	if (info.nodes !== 39) throw new Error('engine_info nodes != 39');

	// rust-ai.js's partial-SFN key: everything except the turn counter.
	const key = (x) => { const p = x.split(' '); return [p[0], p[1], p[3], p[4], p[5]].join(' '); };
	const OFFICIAL = ['core', 'springtime', 'celestial', 'fury', 'tempest',
	                  'flood', 'autumn', 'gloom', 'covenant'];

	// The gate, verbatim from rust-ai.js (fromSigilBoard swapped for an
	// SFN-built probe — same object either way).
	async function verify(sfn, res) {
		const color = sfnToDict(sfn).turn;
		const probe = sfnToSimBoard(sfn);
		probe.enemy = (c) => (c === 'red' ? 'blue' : 'red');
		probe.getBoardStatePayload = () => ({});
		if (probe.movesLeftThisTurn === undefined) probe.movesLeftThisTurn = 1;
		await applyAITurn(probe, { actions: res.actions }, color, () => {});
		probe.update();
		probe.checkGameOver(color);
		probe.turnCounter++;
		probe.whoseTurn = (color === 'red') ? 'blue' : 'red';
		probe.update();
		if (key(boardToSfn(probe)) !== key(res.expected_sfn)) {
			throw new Error('replay mismatch:\n  replayed: ' + key(boardToSfn(probe)) +
			                '\n  expected: ' + key(res.expected_sfn));
		}
		return probe.gameover;
	}

	function pick(sfn, history, budgetMs, onDepth) {
		return JSON.parse(wasm_bindgen.pick_move_actions(
			sfn, budgetMs, 18, 4, history.concat([sfn]), 'tfit', 0.10, 2, 6,
			onDepth || undefined));
	}

	let progressTicks = 0;
	let plies = 0;
	for (let g = 0; g < GAMES; g++) {
		const spells = generateSpellList(OFFICIAL);
		const b = new SigilBoard(spells.slice(), 'standard');
		b.setupInitial();
		let sfn = boardToSfn(b);
		const history = [];
		for (let ply = 0; ply < PLIES; ply++) {
			const res = pick(sfn, history, BUDGET_MS,
				() => { progressTicks++; });
			if (!res.ok) throw new Error('game ' + g + ' ply ' + ply + ': ' + res.error);
			if (!Array.isArray(res.actions) || res.actions.length === 0) {
				throw new Error('game ' + g + ' ply ' + ply + ': empty action list');
			}
			const over = await verify(sfn, res);
			plies++;
			history.push(sfn);
			sfn = res.expected_sfn;
			if (over) break;
		}
	}
	if (progressTicks === 0) throw new Error('on_depth progress callback never fired');

	// Edge: a 1 ms budget must still return a playable turn.
	{
		const spells = generateSpellList(OFFICIAL);
		const b = new SigilBoard(spells.slice(), 'standard');
		b.setupInitial();
		const sfn = boardToSfn(b);
		const res = pick(sfn, [], 1);
		if (!res.ok || !res.actions.length) throw new Error('1ms budget returned no playable turn');
		await verify(sfn, res);
	}
	// Edge: unknown eval name refuses rather than guessing.
	{
		const b = new SigilBoard(generateSpellList(OFFICIAL).slice(), 'standard');
		b.setupInitial();
		const bad = JSON.parse(wasm_bindgen.pick_move_actions(
			boardToSfn(b), 50, 18, 4, [], 'no-such-eval', 0, 0, 0, undefined));
		if (bad.ok || !/unknown eval name/.test(bad.error || '')) {
			throw new Error('unknown eval name was not refused: ' + JSON.stringify(bad));
		}
	}
	// Edge: an out-of-scope spell in the SFN refuses rather than mis-resolving.
	{
		const b = new SigilBoard(generateSpellList(OFFICIAL).slice(), 'standard');
		b.setupInitial();
		const sfn = boardToSfn(b).replace(b.spellNames[0], 'Lifesap');
		const bad = JSON.parse(wasm_bindgen.pick_move_actions(
			sfn, 50, 18, 4, [], 'tfit', 0, 0, 0, undefined));
		if (bad.ok) throw new Error('out-of-scope spell was not refused');
	}
	console.log('wasm smoke OK: ' + GAMES + ' games, ' + plies +
	            ' plies replay-verified, ' + progressTicks + ' progress ticks, edge cases pass');
}
