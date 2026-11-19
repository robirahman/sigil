#!/usr/bin/env node
/**
 * Proves the practice drills (docs/static/scripts/drill-lessons.js) against
 * the REAL browser rules (GameController, the code that referees every game
 * on the site), without a browser:
 *
 *   node tools/drills-verify.js [--only <drill id>] [--verbose] [--tutorial]
 *
 * For each drill it walks EVERY complete turn the mover can play from the
 * drill's position (every token the controller offers at every prompt:
 * moves, push choices, dash and its sacrifices, casts, kept stones, spell
 * targets, End Turn), replaying each line on a fresh controller, and
 * evaluates the drill's `goal` on where each turn ends. Then it checks:
 *
 *   1. every line the drill's script accepts is legal, ends the turn, and
 *      meets the goal ("an accepted answer is never wrong");
 *   2. every turn that meets the goal is accepted by the script ("a right
 *      answer is never refused");
 *   3. every `why` explanation is attached to a token the controller really
 *      offers at that step and the script refuses, and no line through it
 *      meets the goal; its best outcome is printed (--verbose) so the
 *      wording can be checked against it;
 *   4. every `ask` step (a predicted push destination) names the one node
 *      the push really goes to;
 *   5. no turn that wins the game is refused, whatever the goal.
 *
 * --tutorial runs checks 1 and 4 on the tutorial lessons instead (they
 * have no goals: their scripts are walkthroughs, not exercises).
 *
 * Exits non-zero on any failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const SCRIPTS = path.join(REPO, 'docs', 'static', 'scripts');
const ENGINE = path.join(SCRIPTS, 'engine');
const args = process.argv.slice(2);
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const VERBOSE = args.includes('--verbose');
const TUTORIAL = args.includes('--tutorial');
// A drill whose turn tree is larger than this is a design error (the drills
// are meant to be small, focused positions).
const MAX_LINES = 200000;

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
	'features.js', 'enumerator.js', 'ai-player.js', 'game-controller.js', 'game-review.js', 'rust-ai.js',
].map(f => path.join(ENGINE, f)).concat(['live-analysis.js', 'game-board-local.js', 'tutorial-lessons.js', 'drill-lessons.js']
	.map(f => path.join(SCRIPTS, f)));
for (const f of FILES) vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
const G = vm.runInContext('({ GameController, tutorialLessonSfn, puzzleImportSfn, boardToSfn, NODE_ORDER, findPushOptions, drillStepAccepts })', sandbox);

const tick = () => new Promise(r => setImmediate(r));

/**
 * Play `tokens` from the lesson's position on a fresh controller (the other
 * side idle, as on the page) and report where it stands: the prompt it waits
 * on, the push / keep choices it offers, the turn and game results.
 */
async function play(lesson, tokens) {
	const mover = lesson.mover || 'blue';
	const st = { prompt: null, pushOpts: null, refill: null, turn: null, winner: null, pushes: [], noop: false, error: null };
	const gc = new G.GameController((ev) => {
		if (ev.type === 'message' && ev.awaiting) { st.prompt = ev; }
		else if (ev.type === 'pushingoptions') {
			st.pushOpts = Object.keys(ev).filter(k => k !== 'type' && k !== 'sourceNode');
		} else if (ev.type === 'chooserefills') {
			st.refill = Object.keys(ev).filter(k => k !== 'type' && k !== 'playercolor');
		} else if (ev.type === 'push_animation') {
			st.pushes.push({ from: ev.starting_node, to: ev.ending_node });
		} else if (ev.type === 'turn_complete' && ev.turn.color === mover) {
			st.turn = ev.turn;
		} else if (ev.type === 'game_over') {
			st.winner = ev.winner;
		}
	}, { aiColor: mover === 'red' ? 'blue' : 'red', ai: { pickTurn: () => new Promise(() => {}) }, variant: lesson.variant || 'standard' });
	gc._delay = () => Promise.resolve();
	const startPromise = gc.startGame(G.puzzleImportSfn(G.tutorialLessonSfn(lesson)));
	await startPromise;
	for (let i = 0; i < 4; i++) await tick();
	st.startStones = Object.assign({}, gc.board.totalStones);
	for (const tok of tokens) {
		const before = JSON.stringify([st.prompt, G.boardToSfn(gc.board)]);
		st.prompt = null; st.pushOpts = null; st.refill = null;
		gc.handlePlayerAction(tok);
		for (let i = 0; i < 6; i++) await tick();
		st.noop = !st.turn && !st.winner && JSON.stringify([st.prompt, G.boardToSfn(gc.board)]) === before;
		if (st.noop) break;
	}
	st.board = gc.board;
	return st;
}

/** The tokens the controller offers at `st`'s prompt. */
function offered(st) {
	const p = st.prompt;
	if (!p) return [];
	if (p.awaiting === 'action') {
		const out = [];
		const al = p.actionlist || [];
		if (al.includes('move')) out.push(...Object.keys(p.moveoptions || {}));
		for (const a of al) if (a !== 'move' && a !== 'reset') out.push(a);
		return out;
	}
	if (st.pushOpts) return st.pushOpts.slice();
	if (st.refill) return st.refill.slice();
	const mo = Object.keys(p.moveoptions || {});
	if (mo.length) return mo;
	// A prompt naming no nodes (a dash's sacrifices, a spell's targets):
	// every node holding a stone; the refused ones are dropped as no-ops by
	// the caller. (Every such prompt picks a stone: the empty-node choices
	// -- pushes, kept stones, placements -- come with their options.)
	return G.NODE_ORDER.filter(n => st.board.stones[n] === 'red' || st.board.stones[n] === 'blue');
}

function outcome(st, lesson) {
	const mover = lesson.mover || 'blue';
	const enemy = mover === 'red' ? 'blue' : 'red';
	const b = st.board;
	b.update();
	return {
		winner: st.winner,
		mine: b.totalStones[mover], theirs: b.totalStones[enemy],
		lostMine: st.startStones[mover] - b.totalStones[mover],
		lostTheirs: st.startStones[enemy] - b.totalStones[enemy],
		myCharged: b.chargedSpells[mover].slice(), theirCharged: b.chargedSpells[enemy].slice(),
		mySpells: b.spellCounter[mover], score: b.score,
		stones: Object.assign({}, b.stones), mover, enemy,
		after: st.turn ? st.turn.sfnAfter : null,
	};
}

function meetsGoal(o, goal, tokens, mover) {
	if (!goal) return true;
	if (goal.win && o.winner !== mover) return false;
	if (goal.notLose && o.winner && o.winner !== mover) return false;
	if (goal.notOver && o.winner) return false;
	if (typeof goal.crush === 'number' && o.lostTheirs < goal.crush) return false;
	if (goal.uncharged && o.theirCharged.includes(goal.uncharged)) return false;
	if (goal.charged && !o.myCharged.includes(goal.charged)) return false;
	if (goal.cast && !tokens.includes(goal.cast)) return false;
	if (goal.noCast && tokens.some(t => /^[A-Z]/.test(t))) return false;
	if (typeof goal.minStones === 'number' && o.mine < goal.minStones) return false;
	if (goal.holds && !goal.holds.every(n => o.stones[n] === o.mover)) return false;
	if (goal.notTheirs && goal.notTheirs.some(n => o.stones[n] === o.enemy)) return false;
	return true;
}

/**
 * Every complete line from the drill's position: [{ tokens, o }]. Lines that
 * transpose into the same mid-turn state (two sacrifices in either order, two
 * soft moves swapped) share one walk of what follows: the state key is the
 * board, the prompt and its choices, and how many tokens were played.
 */
async function allLines(lesson) {
	const memo = new Map();
	let walks = 0;
	async function dfs(prefix, st) {
		if (st.turn || st.winner) return [{ tokens: [], o: outcome(st, lesson) }];
		const b = st.board;
		const key = prefix.length + '|' + G.boardToSfn(b) + '|' + b.crushedThisTurn + '|' + JSON.stringify([st.prompt, st.pushOpts, st.refill, b.silenced]);
		if (memo.has(key)) return memo.get(key);
		if (++walks > MAX_LINES) throw new Error('turn tree too large (> ' + MAX_LINES + ' states)');
		const out = [];
		for (const tok of offered(st)) {
			const child = await play(lesson, prefix.concat([tok]));
			if (child.noop) continue;
			for (const sub of await dfs(prefix.concat([tok]), child)) out.push({ tokens: [tok].concat(sub.tokens), o: sub.o });
		}
		memo.set(key, out);
		return out;
	}
	return dfs([], await play(lesson, []));
}

// The script's verdict on a token line: 'ok' (every token accepted and the
// script finished), 'short' (accepted so far, steps left), or the index of
// the first refused token. `ask` steps take no game token.
function scriptVerdict(lesson, tokens) {
	let step = 0, remaining = null;
	const steps = lesson.steps.filter(s => !s.ask);
	for (let i = 0; i < tokens.length; i++) {
		const s = steps[step];
		if (!s) return { refusedAt: i };
		const r = G.drillStepAccepts(s.do, tokens[i], remaining, true);
		if (!r.ok) return { refusedAt: i, step };
		remaining = r.remaining;
		if (!remaining) step += 1;
	}
	return step >= steps.length ? { ok: true } : { short: true, step };
}

async function checkAsks(lesson, fail) {
	// Replay the script's first line up to each ask; the next step's node is
	// the hard move whose push the ask predicts.
	const prefix = [];
	for (let k = 0; k < lesson.steps.length; k++) {
		const s = lesson.steps[k];
		if (s.ask) {
			const next = lesson.steps[k + 1];
			const from = next && typeof next.do === 'string' ? next.do : null;
			if (!from) { fail('ask at step ' + (k + 1) + ' must be followed by a single hard move'); continue; }
			const st = await play(lesson, prefix);
			const res = G.findPushOptions(st.board, from, lesson.mover || 'blue');
			if (res.crushed || res.options.length !== 1 || res.options[0] !== s.ask) {
				fail('ask at step ' + (k + 1) + ' says ' + s.ask + ' but the push from ' + from + ' goes to ' + (res.crushed ? '(crushed)' : res.options.join('/')));
			}
			continue;
		}
		const d = s.do;
		prefix.push(typeof d === 'string' ? d : d.oneOf ? d.oneOf[0] : d.all ? d.all[0] : d.pick ? d.from[0] : null);
		if (d.all) prefix.push(...d.all.slice(1));
		if (d.pick) prefix.push(...d.from.slice(1, d.pick));
		if (prefix[prefix.length - 1] === null) break;   // an { any } step: stop here
	}
}

(async () => {
	const all = TUTORIAL ? sandbox.SIGIL_TUTORIAL_LESSONS : sandbox.SIGIL_DRILLS;
	const lessons = all.filter(l => !ONLY || l.id === ONLY);
	if (!lessons.length) { console.error('no lessons'); process.exit(2); }
	let failures = 0;
	for (const lesson of lessons) {
		const mover = lesson.mover || 'blue';
		const errs = [];
		const fail = (m) => errs.push(m);
		const t0 = Date.now();
		await checkAsks(lesson, fail);
		const lines = await allLines(lesson);
		const goalLines = lines.filter(l => meetsGoal(l.o, lesson.goal, l.tokens, mover)
			&& (!lesson.win || l.o.winner === mover));
		const accepted = lines.filter(l => scriptVerdict(lesson, l.tokens).ok);
		if (!accepted.length) fail('the script accepts no complete turn');
		for (const l of accepted) {
			if (lesson.win && l.o.winner !== mover) fail('accepted line does not win: ' + l.tokens.join(' '));
			if (!TUTORIAL && !meetsGoal(l.o, lesson.goal, l.tokens, mover)) fail('accepted line misses the goal: ' + l.tokens.join(' ') + ' -> ' + JSON.stringify(l.o));
		}
		if (!TUTORIAL) {
			if (!lesson.goal) fail('no goal');
			// A turn that wins the game is never a wrong answer.
			for (const l of lines) {
				if (l.o.winner === mover && !scriptVerdict(lesson, l.tokens).ok) {
					fail('a winning turn is refused: ' + l.tokens.join(' '));
					break;
				}
			}
			for (const l of goalLines) {
				const v = scriptVerdict(lesson, l.tokens);
				if (!v.ok) fail('a turn that meets the goal is refused at token ' + (v.refusedAt + 1) + ': ' + l.tokens.join(' '));
			}
			// Each `why`: offered on an accepted line at that step, refused by
			// the script, and no goal line goes through it.
			const steps = lesson.steps.filter(s => !s.ask);
			steps.forEach((s, k) => {
				for (const tok of Object.keys(s.why || {}).filter(t => t !== '*')) {
					if (G.drillStepAccepts(s.do, tok, null, true).ok) { fail('why[' + tok + '] at step ' + (k + 1) + ' is a token the script accepts'); continue; }
					// Lines whose first k tokens the script accepts and whose
					// next token is `tok` (a pick/all step spans several tokens:
					// any position inside it counts).
					const through = lines.filter(l => {
						const v = scriptVerdict(lesson, l.tokens);
						return v.refusedAt !== undefined && v.step === k && l.tokens[v.refusedAt] === tok;
					});
					if (!through.length) { fail('why[' + tok + '] at step ' + (k + 1) + ': the controller never offers it there'); continue; }
					const good = through.filter(l => meetsGoal(l.o, lesson.goal, l.tokens, mover));
					if (good.length) fail('why[' + tok + '] at step ' + (k + 1) + ': ' + good.length + ' line(s) through it meet the goal, e.g. ' + good[0].tokens.join(' '));
					if (VERBOSE) {
						const best = through.slice().sort((a, b) => (b.o.mine - b.o.theirs) - (a.o.mine - a.o.theirs))[0];
						const o = best.o;
						console.log('     why[' + tok + '] step ' + (k + 1) + ': ' + through.length + ' lines; best: ' + (o.winner ? 'winner ' + o.winner + ', ' : '')
							+ 'stones ' + o.mine + '/' + o.theirs + ' (lost ' + o.lostMine + '/' + o.lostTheirs + '), score ' + o.score + ', via ' + best.tokens.join(' '));
					}
				}
			});
		}
		const ms = Date.now() - t0;
		if (errs.length) {
			failures += 1;
			console.log('FAIL ' + lesson.id + ' (' + lines.length + ' lines, ' + goalLines.length + ' meet the goal, ' + accepted.length + ' accepted, ' + ms + ' ms)');
			for (const e of errs.slice(0, 12)) console.log('     ' + e);
			if (errs.length > 12) console.log('     ... ' + (errs.length - 12) + ' more');
		} else {
			console.log('ok   ' + lesson.id + ' (' + lines.length + ' lines, ' + goalLines.length + ' meet the goal, ' + accepted.length + ' accepted, ' + ms + ' ms)');
		}
		if (VERBOSE) {
			const fmt = (l) => l.tokens.join(' ') + '  -> ' + (l.o.winner ? 'winner ' + l.o.winner + ', ' : '') + 'stones ' + l.o.mine + '/' + l.o.theirs + ', score ' + l.o.score;
			for (const l of goalLines.slice(0, 20)) console.log('     goal: ' + fmt(l));
			if (goalLines.length > 20) console.log('     ... ' + (goalLines.length - 20) + ' more goal lines');
		}
	}
	if (failures) { console.error(failures + ' drill(s) failed'); process.exit(1); }
	console.log('all ' + lessons.length + ' ' + (TUTORIAL ? 'lessons' : 'drills') + ' verified');
})().catch(e => { console.error('VERIFY FAILED:', e && e.stack || e); process.exit(1); });
