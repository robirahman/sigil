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
 * The replay is exactly the page's (tools/puzzle-smoke.js --replay and
 * rust-ai.js rustActionsToTurn): applyAITurn, update, the Seal of Destruction
 * end-of-turn burn, checkGameOver, then the turn passes. applyAITurn does NOT
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
const G = vm.runInContext(`({ SigilBoard, SimBoard, sfnToDict, normalizeVariant, applyAITurn,
	sealOfDestructionBurn, boardToSfn, puzzleSfnKey, NODE_ORDER })`, sandbox);

// Field -> kind of value. Anything else in an action is rejected, so a typo
// ("pushed" for "pushed_to") is an error rather than silently ignored.
const NODE = 'node', NODES = 'nodes', SPELL = 'spell', INT = 'int', BOOL = 'bool', PUSHES = 'pushes';
const SCHEMA = {
	pass: {},
	move: { node: NODE, providence: BOOL },
	hard_move: { node: NODE, pushed_to: NODE, providence: BOOL },
	blink: { node: NODE, pushed_to: NODE },
	dash: { sacrificed: NODES },
	dash_lightning: { sacrificed: NODES },
	cast: { spell: SPELL, kept: NODES },
	sacrifice: { node: NODE },
	fireblast: { destroyed: NODES },
	hail_storm: { destroyed: NODES },
	decay: { destroyed: NODES },
	hurricane: { destroyed: NODES },
	storm_front: { destroyed: NODES },
	meteor_destroy: { node: NODE },
	bewitch: { node: NODE, node2: NODE },
	corrupt: { converted: NODES },
	starfall: { node: NODE, node2: NODE, destroyed: NODES },
	gust: { destroyed: NODES, kept: NODES },
	fissure: { node: NODE, destroyed: NODES, wall: NODE },
	rock_slide: { pushes: PUSHES, destroyed: NODES },
	bank_stones: { spell: SPELL, banked: INT },
};
const REQUIRED = {
	move: ['node'], hard_move: ['node'], blink: ['node'], dash: ['sacrificed'], dash_lightning: ['sacrificed'],
	cast: ['spell'], sacrifice: ['node'], meteor_destroy: ['node'], bewitch: ['node', 'node2'],
	starfall: ['node', 'node2'], fissure: ['node'], rock_slide: ['pushes'], bank_stones: ['spell', 'banked'],
};
const NODE_SET = new Set(G.NODE_ORDER);

function validate(actions, spellNames) {
	if (!Array.isArray(actions)) throw new Error('actions must be a JSON array');
	if (actions.length === 0) throw new Error('empty action list (a turn starts with a placement)');
	if (actions.length > 40) throw new Error('too many actions');
	actions.forEach((a, i) => {
		const at = `action ${i + 1}`;
		if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error(`${at}: not an object`);
		const sch = SCHEMA[a.type];
		if (!sch) throw new Error(`${at}: unknown type ${JSON.stringify(a.type)}`);
		for (const [k, v] of Object.entries(a)) {
			if (k === 'type') continue;
			const kind = sch[k];
			if (!kind) throw new Error(`${at} (${a.type}): unexpected field ${JSON.stringify(k)}`);
			if (v === null && (k === 'wall' || k === 'pushed_to')) continue;
			if (kind === NODE && !NODE_SET.has(v)) throw new Error(`${at}: ${k} ${JSON.stringify(v)} is not a node`);
			if (kind === NODES && !(Array.isArray(v) && v.every(n => NODE_SET.has(n)))) throw new Error(`${at}: ${k} must be a list of node names`);
			if (kind === SPELL && !spellNames.includes(v)) throw new Error(`${at}: spell ${JSON.stringify(v)} is not on this board`);
			if (kind === INT && !(Number.isInteger(v) && v >= 0 && v <= 10)) throw new Error(`${at}: ${k} must be a small integer`);
			if (kind === BOOL && typeof v !== 'boolean') throw new Error(`${at}: ${k} must be true/false`);
			if (kind === PUSHES && !(Array.isArray(v) && v.every(p => p && NODE_SET.has(p.from) && NODE_SET.has(p.to) && Object.keys(p).length === 2)))
				throw new Error(`${at}: pushes must be a list of {"from": node, "to": node}`);
		}
		for (const k of REQUIRED[a.type] || []) if (a[k] === undefined) throw new Error(`${at} (${a.type}): missing ${k}`);
	});
}

async function replay(sfn, actions) {
	const d = G.sfnToDict(sfn);
	const b = new G.SigilBoard(null, G.normalizeVariant(d && d.variant));
	b.loadFromSfn(sfn);
	const sim = G.SimBoard.fromSigilBoard(b);
	validate(actions, sim.spellNames || b.spellNames || []);
	const color = String(sfn).trim().split(/\s+/)[1] === 'r' ? 'red' : 'blue';
	const probe = sim.copy();
	probe.enemy = (c) => (c === 'red' ? 'blue' : 'red');
	probe.getBoardStatePayload = () => ({});
	await G.applyAITurn(probe, { actions }, color, () => {});
	probe.update();
	G.sealOfDestructionBurn(probe, color);
	probe.checkGameOver(color);
	probe.turnCounter++;
	probe.whoseTurn = color === 'red' ? 'blue' : 'red';
	probe.update();
	const after = G.boardToSfn(probe);
	return { ok: true, after, key: G.puzzleSfnKey(after), gameover: !!probe.gameover, winner: probe.winner || null };
}

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
