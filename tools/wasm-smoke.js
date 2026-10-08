// Headless gate for the Rust engine's WebAssembly build.
//
// Loads the committed no-modules glue + .wasm from docs/static/wasm/ alongside
// the browser engine files (the ai/replay_bridge.py concatenation pattern) and
// plays scripted games: every Engine.search result is replayed through the
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
// SIGIL_WASM_DIR points the smoke at an unshipped build (engine/build-wasm.sh
// with WASM_OUT=<dir>), e.g. a prototype that must not replace docs/static/wasm.
const WASM_DIR = process.env.SIGIL_WASM_DIR || path.join(REPO, 'docs', 'static', 'wasm');

// Superset of ai/replay_bridge.py's list: sim-board for the probe boards,
// features/enumerator because sim-board's evaluation hooks reference them.
const FILES = [
	'constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js',
	'sim-board.js', 'features.js', 'enumerator.js',
	'ai-player.js', 'game-controller.js', 'game-review.js',
	'rust-ai.js',   // RustAI.moveBudgetMs / parseClock, checked against the wasm
	'game-clock.js',
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
	// Play with the eval the site plays (rust-ai.js's default, which mirrors
	// eval.rs SHIPPED_EVAL), not a literal: until v25 this smoke searched with
	// 'tfit' whatever the site shipped.
	const EVAL = process.env.SIGIL_SMOKE_EVAL || new RustAI({ transport: 'http' }).evalName;
	console.log('eval ' + EVAL);
	// SIGIL_SMOKE_POLICY=<min_width> overrides the shipped generator policy.
	// The shipped engine has it on (policy::SHIPPED_POLICY); 'off' replays without it.
	if (process.env.SIGIL_SMOKE_POLICY === 'off') {
		wasm_bindgen.set_policy(false, 0);
		console.log('generator policy OFF');
	} else if (process.env.SIGIL_SMOKE_POLICY) {
		wasm_bindgen.set_policy(true, parseInt(process.env.SIGIL_SMOKE_POLICY, 10));
		console.log('generator policy ON, min_width ' + process.env.SIGIL_SMOKE_POLICY);
	}
	const info = JSON.parse(wasm_bindgen.engine_info());
	if (info.nodes !== 39) throw new Error('engine_info nodes != 39');
	// Game clock: the JS allocation must equal the engine's for every input.
	if (typeof wasm_bindgen.move_budget_ms === 'function') {
		let checked = 0;
		for (const rem of [0, 40, 149, 150, 151, 1000, 9999, 30000, 300000, 600000, 3600000]) {
			for (const inc of [0, 1000, 5000]) {
				for (const mv of [0, 5, 12, 18, 25, 60]) {
					const js = RustAI.moveBudgetMs(rem, inc, mv);
					const rs = wasm_bindgen.move_budget_ms(rem, inc, mv);
					if (js !== rs) throw new Error(`moveBudgetMs(${rem}, ${inc}, ${mv}) js ${js} != wasm ${rs}`);
					checked++;
				}
			}
		}
		const c = RustAI.parseClock('10+1');
		if (!c || c.baseMs !== 600000 || c.incMs !== 1000) throw new Error('parseClock 10+1');
		if (RustAI.parseClock('nonsense') !== null || RustAI.parseClock('0+1') !== null) throw new Error('parseClock rejects');
		console.log('game clock: ' + checked + ' allocations agree with the wasm');
	}

	// rust-ai.js's partial-SFN key: everything except the turn counter.
	// Includes the Providence banks (the optional `pm:` token), which the
		// stone field does not show.
		const key = (x) => { const p = x.split(' '); return [p[0], p[1], p[3], p[4], p[5],
			p.find(t => t.startsWith('pm:')) || ''].join(' '); };
	const OFFICIAL = ['core', 'springtime', 'celestial', 'fury', 'tempest',
	                  'flood', 'autumn', 'gloom', 'covenant'];

	// The gate, verbatim from rust-ai.js (fromSigilBoard swapped for an
	// SFN-built probe — same object either way).
	async function verify(sfn, res) {
		const color = sfnToDict(sfn).turn;
		const probe = sfnToSimBoard(sfn);
		probe.enemy = (c) => (c === 'red' ? 'blue' : 'red');
		probe.getBoardStatePayload = () => ({});
		await applyAITurn(probe, { actions: res.actions }, color, () => {});
		probe.update();
		probe.checkGameOver(color);
		probe.turnCounter++;
		probe.whoseTurn = (color === 'red') ? 'blue' : 'red';
		probe.update();
		if (key(boardToSfn(probe)) !== key(res.expected_sfn)) {
			throw new Error('replay mismatch:\n  replayed: ' + key(boardToSfn(probe)) +
			                '\n  expected: ' + key(res.expected_sfn) +
			                '\n  before:   ' + sfn +
			                '\n  actions:  ' + JSON.stringify(res.actions));
		}
		return probe.gameover;
	}

	// One persistent Engine for the scripted games, as the worker uses.
	const smokeEngine = new wasm_bindgen.Engine(18);
	function pick(sfn, history, budgetMs, onDepth) {
		return JSON.parse(smokeEngine.search(
			sfn, budgetMs, 4, history.concat([sfn]), EVAL, 0.10, 2, 6,
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

	// Tectonic + Providence: draws holding all six spells, every ply
	// replay-verified (walls, shields, Rock Slide pushes, banks, placements).
	const seen = { fissure: 0, rock_slide: 0, bank_stones: 0, providence: 0 };
	{
		const core = generateSpellList(['core']);
		const draws = [
			['Fissure', 'Endowment', core[0], 'Rock_Slide', 'Annuity', core[3], 'Bulwark', 'Dividend', core[6]],
			['Endowment', core[1], 'Fissure', 'Annuity', core[4], 'Rock_Slide', 'Dividend', core[7], 'Bulwark'],
			[core[0], 'Fissure', 'Endowment', core[3], 'Rock_Slide', 'Annuity', 'Bulwark', core[6], 'Dividend'],
		];
		for (let g = 0; g < draws.length; g++) {
			const b = new SigilBoard(draws[g].slice(), 'standard');
			b.setupInitial();
			let sfn = boardToSfn(b);
			const history = [];
			for (let ply = 0; ply < 60; ply++) {
				const res = pick(sfn, history, 150);
				if (!res.ok) throw new Error('tectonic game ' + g + ' ply ' + ply + ': ' + res.error);
				for (const a of res.actions) {
					if (a.type in seen) seen[a.type]++;
					if (a.providence) seen.providence++;
				}
				const over = await verify(sfn, res);
				plies++;
				history.push(sfn);
				sfn = res.expected_sfn;
				if (over) break;
			}
		}
		console.log('tectonic/providence games: ' + JSON.stringify(seen));
	}

	// The display report (search::report): present on every completed search,
	// with numeric stones and no mate at the opening. The even-position offset
	// itself (an even opening reads ~0, not the raw eval's -0.5) is pinned in
	// Rust (tests.rs, the report() tests). Here only a gross wiring error is
	// caught: the spell-aware evals genuinely rate some opening draws near one
	// stone for the mover (0.2-1.1 seen with nnue_spell3), so a tight bound
	// here was flaky on v27 and v28 alike.
	{
		const b = new SigilBoard(generateSpellList(OFFICIAL).slice(), 'standard');
		b.setupInitial();
		const res = pick(boardToSfn(b), [], 200);
		if (typeof res.stones !== 'number') throw new Error('search result lacks numeric "stones": ' + JSON.stringify(res));
		if (!(res.mate_in === null || Number.isInteger(res.mate_in))) throw new Error('mate_in must be null or an integer');
		if (typeof res.mate_proven !== 'boolean') throw new Error('mate_proven must be a boolean');
		if (Math.abs(res.stones) >= 2) throw new Error('opening reads ' + res.stones + ' stones; expected within a stone or so of 0');
		if (res.mate_in !== null) throw new Error('the opening is not a mate: ' + JSON.stringify(res));
	}
	// Competitive opening book: red's and blue's free placements are blinks on
	// the sigil the selector picked (reported in `opening`), replay-verified; the
	// third turn is an ordinary move with no opening report.
	{
		const b = new SigilBoard(generateSpellList(OFFICIAL).slice(), 'competitive');
		b.setupInitial();
		b.turnCounter = 1; b.whoseTurn = 'red';
		let sfn = boardToSfn(b);
		const history = [];
		for (let ply = 0; ply < 3; ply++) {
			const res = pick(sfn, history, 200);
			if (!res.ok) throw new Error('competitive ply ' + ply + ': ' + res.error);
			if (ply < 2) {
				if (res.actions[0].type !== 'blink') throw new Error('competitive opening should be a blink: ' + JSON.stringify(res.actions));
				// The selector is off since v27 (the search places the first stone);
				// when a build turns it on, its report must name the node it played.
				if (res.opening && res.opening.node !== res.actions[0].node) throw new Error('opening report mismatched: ' + JSON.stringify(res.opening));
				if (res.opening && !b.spellNames.includes(res.opening.spell)) throw new Error('opening names a spell not in the draw: ' + res.opening.spell);
			} else if (res.opening !== null) {
				throw new Error('turn 3 must carry no opening report: ' + JSON.stringify(res.opening));
			}
			await verify(sfn, res);
			history.push(sfn);
			sfn = res.expected_sfn;
		}
	}
	// judge_move: the turns field is the ply count in the mover's own turns.
	{
		const b = new SigilBoard(generateSpellList(OFFICIAL).slice(), 'standard');
		b.setupInitial();
		const first = pick(boardToSfn(b), [], 50);
		const j = JSON.parse(wasm_bindgen.judge_move(first.expected_sfn, 4, 300, 18));
		if (!j.ok) throw new Error('judge_move failed: ' + j.error);
		if (!('mate_in_turns' in j) || !('stones' in j)) throw new Error('judge_move lacks mate_in_turns/stones: ' + JSON.stringify(j));
		if (j.mate_in !== null && j.mate_in_turns !== Math.ceil(Math.abs(j.mate_in) / 2) * Math.sign(j.mate_in)) {
			throw new Error('mate_in_turns ' + j.mate_in_turns + ' does not match plies ' + j.mate_in);
		}
	}

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
		const bad = JSON.parse(smokeEngine.search(
			boardToSfn(b), 50, 4, [], 'no-such-eval', 0, 0, 0, undefined));
		if (bad.ok || !/unknown eval name/.test(bad.error || '')) {
			throw new Error('unknown eval name was not refused: ' + JSON.stringify(bad));
		}
	}
	// Edge: an out-of-scope spell in the SFN refuses rather than mis-resolving.
	{
		const b = new SigilBoard(generateSpellList(OFFICIAL).slice(), 'standard');
		b.setupInitial();
		const sfn = boardToSfn(b).replace(b.spellNames[0], 'Lifesap');
		const bad = JSON.parse(smokeEngine.search(
			sfn, 50, 4, [], EVAL, 0, 0, 0, undefined));
		if (bad.ok) throw new Error('out-of-scope spell was not refused');
	}
	// Persistent Engine: the table survives a move, a ponder primes it, and the
	// result is still replay-verified through the real applyAITurn.
	let engineMoves = 0;
	{
		const spells = generateSpellList(OFFICIAL);
		const b = new SigilBoard(spells.slice(), 'standard');
		b.setupInitial();
		let sfn = boardToSfn(b);
		const history = [];
		const eng = new wasm_bindgen.Engine(18);
		if (eng.tt_filled() !== 0) throw new Error('fresh Engine has a non-empty table');
		const esearch = (s, ms) => JSON.parse(eng.search(
			s, ms, 4, history.concat([s]), EVAL, 0.10, 2, 6, undefined));
		// Move 1: ordinary search.
		let res = esearch(sfn, BUDGET_MS);
		if (!res.ok) throw new Error('Engine.search: ' + res.error);
		const filled1 = eng.tt_filled();
		if (filled1 === 0) throw new Error('Engine table empty after a search');
		await verify(sfn, res); history.push(sfn); sfn = res.expected_sfn; engineMoves++;
		// Human "thinks": ponder the position they are looking at in slices.
		const pb = JSON.parse(eng.ponder_begin(sfn, 4, history.concat([sfn]), EVAL, 0.10, 2, 6));
		if (!pb.ok) throw new Error('ponder_begin: ' + pb.error);
		let steps = 0, last = null;
		for (; steps < 20; steps++) {
			last = JSON.parse(eng.ponder_step(30, 12));
			if (last.done) break;
		}
		if (!last || last.depth < 1) throw new Error('ponder completed no depth: ' + JSON.stringify(last));
		eng.ponder_end();
		const filled2 = eng.tt_filled();
		if (filled2 <= filled1) throw new Error('ponder added no table entries (' + filled1 + ' -> ' + filled2 + ')');
		// Reply on the primed table: the human's move is the engine's own choice
		// here (we have no human), so the primed subtree must be reachable.
		res = esearch(sfn, BUDGET_MS);
		if (!res.ok) throw new Error('Engine.search after ponder: ' + res.error);
		await verify(sfn, res); engineMoves++;
		// new_game clears everything.
		eng.new_game();
		if (eng.tt_filled() !== 0) throw new Error('new_game left ' + eng.tt_filled() + ' entries');
		// ponder_step with nothing to ponder is a no-op, not an error.
		const idle = JSON.parse(eng.ponder_step(10, 4));
		if (!idle.ok || !idle.done) throw new Error('idle ponder_step: ' + JSON.stringify(idle));
		eng.free();
	}
	// Step 6 option A (prototype): root split across several Engines, combined
	// by rust-ai.js's own pickSplitResult, every move replay-verified; then a
	// ponder (which must read the whole root) and a split search after it. Runs
	// only against a wasm that has set_root_split (SIGIL_WASM_DIR=<proto build>).
	let splitMoves = 0;
	{
		// The worker-count cap: hardwareConcurrency - 1, at least 1, default 1.
		const wc = RustAI.rustWorkerCount;
		if (wc(undefined, 8) !== 1 || wc(4, 8) !== 4 || wc(16, 8) !== 7 || wc(4, 1) !== 1 || wc(4, undefined) !== 1) {
			throw new Error('rustWorkerCount cap is wrong');
		}
		// The account page's device setting ('auto'): min(4, hardwareConcurrency - 1).
		if (wc('auto', 8) !== 4 || wc('auto', 4) !== 3 || wc('auto', 2) !== 1 || wc('auto', undefined) !== 1) {
			throw new Error("rustWorkerCount('auto') is wrong");
		}
		if (typeof wasm_bindgen.Engine.prototype.set_root_split === 'function') {
			const PARTS = parseInt(process.env.SIGIL_SMOKE_SPLIT || '4', 10);
			const engines = Array.from({ length: PARTS }, () => new wasm_bindgen.Engine(18));
			const b = new SigilBoard(generateSpellList(OFFICIAL).slice(), 'standard');
			b.setupInitial();
			let sfn = boardToSfn(b);
			const history = [];
			for (let ply = 0; ply < 8; ply++) {
				const perDepth = engines.map(() => []);
				const results = engines.map((eng, i) => {
					eng.set_root_split(i, PARTS);
					return JSON.parse(eng.search(sfn, 150, 4, history.concat([sfn]), EVAL, 0.10, 2, 6,
						(d, s) => perDepth[i].push([d, s])));
				});
				const res = RustAI.pickSplitResult(results, perDepth);
				if (results.every((r) => r.ok && r.depth > 0) && res.split.common_depth == null) {
					throw new Error('split ply ' + ply + ': common-depth merge not used');
				}
				if (!res.ok) throw new Error('split ply ' + ply + ': ' + res.error);
				if (!res.split || res.split.parts !== PARTS) throw new Error('split report missing');
				// Disjointness is pinned in Rust (root_split_parts_are_disjoint_and_cover_the_root).
				// It is not checkable from here: a part whose hash range is empty
				// searches the list's first turn, so with a small root (the opening
				// plies) several parts legitimately report the same turn.
				if (!results.some((r) => r.ok && r.depth > 0)) throw new Error('split ply ' + ply + ': no part completed a depth');
				const over = await verify(sfn, res);
				splitMoves++;
				history.push(sfn);
				sfn = res.expected_sfn;
				if (over) break;
				// The opponent's turn: ponder on every engine with the split dropped,
				// exactly as rust-worker.js does.
				for (const eng of engines) {
					eng.set_root_split(0, 1);
					const pb = JSON.parse(eng.ponder_begin(sfn, 4, history.concat([sfn]), EVAL, 0.10, 2, 6));
					if (!pb.ok) throw new Error('split ponder_begin: ' + pb.error);
					const st = JSON.parse(eng.ponder_step(20, 8));
					if (!st.ok) throw new Error('split ponder_step failed');
					eng.ponder_end();
				}
				const reply = JSON.parse(engines[0].search(sfn, 100, 4, history.concat([sfn]), EVAL, 0.10, 2, 6, undefined));
				if (!reply.ok) throw new Error('split reply: ' + reply.error);
				const over2 = await verify(sfn, reply);
				history.push(sfn);
				sfn = reply.expected_sfn;
				if (over2) break;
			}
			for (const eng of engines) eng.free();
			console.log('root split: ' + splitMoves + ' moves across ' + PARTS + ' engines replay-verified');
		} else {
			console.log('root split: skipped (this wasm has no set_root_split)');
		}
	}
	console.log('wasm smoke OK: ' + GAMES + ' games, ' + plies +
	            ' plies replay-verified, ' + progressTicks + ' progress ticks, ' +
	            engineMoves + ' persistent-Engine moves + ponder cycle, edge cases pass');
}
