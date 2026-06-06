'use strict';
/**
 * Headless loader for the browser Caveman/Prune engine.
 *
 * The engine files under docs/static/scripts/engine/ are DOM-free and designed
 * to be concatenated into one scope (the in-browser AI Worker does this via
 * importScripts). We mirror that: read the same files in the same order,
 * concatenate, and run once under Node's `vm` in the real global context (so
 * all JS built-ins are present). `window` / `self` / `Worker` are `undefined`
 * in Node, which the engine's `typeof window !== 'undefined'` guards handle.
 *
 * No browser, no DOM, no postMessage round-trip — `cavemanSearch` is called
 * directly, so the move chosen from a position is identical to the in-browser
 * AI at equal search depth.
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
	// Top-level const/class declarations don't attach to globalThis, so hand
	// the symbols the arena needs back out explicitly.
	parts.push(`
;globalThis.__sigilEngine = {
	SimBoard, SimTurn, SimAction,
	cavemanSearch, _minimaxApplyTurn,
	generateSpellList, getLegalTurnsExhaustive, ENUM_CAPS,
	NODE_ORDER, boardToSfn,
};`);
	vm.runInThisContext(parts.join('\n;\n'), { filename: 'sigil-engine-bundle.js' });
	_engine = globalThis.__sigilEngine;
	return _engine;
}

/**
 * Parse an AI spec string into a config object.
 *
 * Syntax: `<mode>[:key=val,key=val]` where mode is `caveman` | `prune`:
 *   - caveman: complete enumeration (every legal turn, no caps). The default.
 *   - prune:   ranked top-1 ("narrow") enumeration + Carnage planner.
 * Optional keys (mostly for experiments):
 *   pure         disable alpha-beta cutoffs (full minimax, no pruning of the
 *                tree — slower, same value). e.g. `caveman:pure`
 *   capabs=N     pin every ENUM_CAPS choice-point to N variants (ranked).
 *                `caveman:capabs=1` ≈ the prune narrow enumeration.
 *   caps=F       scale every ENUM_CAPS entry by factor F.
 *   lp=0|1       Carnage push planner on/off (prune default on).
 *   refill=...   exhaustive | closest_enemy | farthest_enemy | closest_mana
 *                | farthest_mana  (Carnage refill choice).
 *
 * Examples: "caveman", "prune", "caveman:capabs=2", "prune:lp=0".
 */
function parseModeSpec(str) {
	const [mode, rest] = String(str).split(':');
	if (mode !== 'caveman' && mode !== 'prune') {
		throw new Error(`Unknown AI mode "${mode}" (expected caveman | prune)`);
	}
	const cfg = { label: str, preset: mode, pure: false, capScale: null, capAbs: null, lp: null, refill: null };
	if (rest) {
		for (const kv of rest.split(',')) {
			const [k, v] = kv.split('=');
			if (k === 'pure') cfg.pure = (v === undefined || v === '1' || v === 'true');
			else if (k === 'caps') cfg.capScale = parseFloat(v);
			else if (k === 'capabs') cfg.capAbs = parseInt(v, 10);
			else if (k === 'lp') cfg.lp = (v === undefined || v === '1' || v === 'true');
			else if (k === 'refill') cfg.refill = v;
			else throw new Error(`Unknown spec key "${k}" in "${str}"`);
		}
	}
	return cfg;
}

/** Build a scaled copy of ENUM_CAPS, or null to use the preset default. */
function scaledCaps(baseCaps, scale) {
	if (!scale || scale === 1) return null;
	const out = {};
	for (const k of Object.keys(baseCaps)) out[k] = Math.max(1, Math.round(baseCaps[k] * scale));
	return out;
}

/** Map a parsed AI spec to cavemanSearch options. */
function specToOpts(cfg, { timeLimit, maxDepth }, baseCaps) {
	const opts = {
		preset: cfg.preset,
		timeLimit,
		maxDepth,
	};
	if (cfg.pure) opts.usePruning = false;
	if (cfg.lp !== null) opts.rankLaterPushes = cfg.lp;
	if (cfg.refill === 'exhaustive') opts.exhaustiveRefill = true;
	else if (cfg.refill) opts.refillHeuristic = cfg.refill;
	if (cfg.capAbs != null && baseCaps) {
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
