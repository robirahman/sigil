'use strict';
/**
 * Headless loader for the browser Caveman engine.
 *
 * The engine files under docs/static/scripts/engine/ are DOM-free and are
 * already designed to be concatenated into one scope (the in-browser AI
 * Worker does exactly this via importScripts). We mirror that here: read the
 * same files in the same order, concatenate, and run once under Node's `vm`
 * in the real global context (so all JS built-ins are present). `window`,
 * `self` and `Worker` are simply `undefined` in Node, which the engine's
 * `typeof window !== 'undefined'` guards already handle.
 *
 * Returns the engine symbols the arena harness needs. No browser, no DOM,
 * no postMessage round-trip — `cavemanSearch` is called directly.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Same load order as docs/static/scripts/engine/ai-worker.js importScripts().
const ENGINE_FILES = [
	'constants.js',
	'notation.js',
	'sim-board.js',
	'features.js',
	'sigil-net.js',
	'sigil-net-graph.js',
	'strategic-eval.js',
	'enumerator.js',
	'minimax-ai.js',
	'caveman-ai.js',
];

function engineDir() {
	return path.resolve(__dirname, '..', '..', 'docs', 'static', 'scripts', 'engine');
}

let _engine = null;

function loadEngine() {
	if (_engine) return _engine;
	const dir = engineDir();
	const parts = ENGINE_FILES.map((f) => {
		const p = path.join(dir, f);
		return `// ===== ${f} =====\n` + fs.readFileSync(p, 'utf8');
	});
	// Epilogue: top-level `const`/`class` declarations don't attach to the
	// global object, so explicitly hand the symbols we need back out.
	parts.push(`
;globalThis.__sigilEngine = {
	SimBoard, SimTurn, SimAction,
	cavemanSearch, _minimaxApplyTurn,
	generateSpellList, getLegalTurnsExhaustive, ENUM_CAPS,
	NODE_ORDER, boardToSfn,
};`);
	const src = parts.join('\n;\n');
	vm.runInThisContext(src, { filename: 'sigil-engine-bundle.js' });
	_engine = globalThis.__sigilEngine;
	return _engine;
}

/**
 * Parse an AI spec string into a config object.
 *
 * Syntax: `<mode>[:key=val,key=val]` where mode is pure_minimax |
 * pruned_minimax and the optional keys are:
 *   plies=N   exhaustive enumeration at every ply < N (default: engine's
 *             historical root+ply-1 behavior). N>2 enumerates deeper
 *             dash/cast variants instead of the single greedy one.
 *   caps=F    scale every ENUM_CAPS entry by factor F (e.g. caps=2 doubles
 *             how many variants of each choice-point are expanded).
 *
 * Examples: "pure_minimax", "pruned_minimax:plies=3", "pruned_minimax:plies=4,caps=2"
 */
function parseModeSpec(str) {
	const [mode, rest] = String(str).split(':');
	if (mode !== 'pure_minimax' && mode !== 'pruned_minimax') {
		throw new Error(`Unknown AI mode "${mode}" (expected pure_minimax | pruned_minimax)`);
	}
	const cfg = { label: str, mode, exhaustivePlies: null, capScale: null, capAbs: null, deepCap: null, lp: null, refill: null };
	if (rest) {
		for (const kv of rest.split(',')) {
			const [k, v] = kv.split('=');
			if (k === 'plies') cfg.exhaustivePlies = parseInt(v, 10);
			else if (k === 'caps') cfg.capScale = parseFloat(v);
			else if (k === 'capabs') cfg.capAbs = parseInt(v, 10);  // pin every cap to N
			else if (k === 'deepcap') cfg.deepCap = parseInt(v, 10);  // full caps root+ply1, N deeper
			else if (k === 'lp') cfg.lp = (v === undefined || v === '1' || v === 'true');  // Carnage push planner on/off
			else if (k === 'refill') cfg.refill = v;  // exhaustive | closest_enemy | farthest_enemy | closest_mana | farthest_mana
			else throw new Error(`Unknown spec key "${k}" in "${str}"`);
		}
	}
	return cfg;
}

/** Build a scaled copy of ENUM_CAPS, or null to use the engine default. */
function scaledCaps(baseCaps, scale) {
	if (!scale || scale === 1) return null;
	const out = {};
	for (const k of Object.keys(baseCaps)) out[k] = Math.max(1, Math.round(baseCaps[k] * scale));
	return out;
}

/** Map a parsed AI spec to cavemanSearch options. */
function specToOpts(cfg, { timeLimit, maxDepth }, baseCaps) {
	const opts = {
		usePruning: cfg.mode === 'pruned_minimax',
		timeLimit,             // seconds per move
		maxDepth,              // ply cap (large by default)
		exhaustiveRoot: true,  // matches the in-browser arena defaults
		exhaustiveOpponent: true,
	};
	if (cfg.exhaustivePlies != null) opts.exhaustivePlies = cfg.exhaustivePlies;
	if (cfg.deepCap != null) opts.deepCap = cfg.deepCap;
	if (cfg.lp !== null) opts.rankLaterPushes = cfg.lp;  // else engine default (on)
	if (cfg.refill === 'exhaustive') {
		opts.exhaustiveRefill = true;
	} else if (cfg.refill) {
		opts.refillHeuristic = cfg.refill;
	}
	if (cfg.capAbs != null && baseCaps) {
		// Pin every choice-point cap to N: width-N *ranked* enumeration.
		// capAbs=1 ≈ "smart greedy" — the engine's top-ranked variant of
		// each dash/cast, same branching as greedy but not arbitrary.
		const out = {};
		for (const k of Object.keys(baseCaps)) out[k] = cfg.capAbs;
		opts.enumCaps = out;
	} else if (cfg.capScale && baseCaps) {
		const sc = scaledCaps(baseCaps, cfg.capScale);
		if (sc) opts.enumCaps = sc;
	}
	return opts;
}

module.exports = { loadEngine, parseModeSpec, specToOpts, scaledCaps, ENGINE_FILES };
