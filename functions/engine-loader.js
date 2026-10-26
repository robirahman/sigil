'use strict';
/**
 * The site's own rules engine, loaded headless for the rating function.
 *
 * The browser engine (docs/static/scripts/engine/) is a set of classic
 * scripts that share globals, so they are concatenated and run in a vm
 * context, the way ai/replay_bridge.py runs them under node. Every call gets
 * a FRESH context: the engine keeps global state (the active board layout,
 * AI_REPLAY_INSTANT), and two replays must never see each other's.
 *
 * `firebase deploy` uploads only functions/, so the predeploy step
 * (copy-engine.js) copies the engine files into functions/engine/. Tests and
 * the emulator read them straight from docs/ when that copy is absent.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Same order as ai/replay_bridge.py (later files use earlier ones), plus
// elo.js for the rating math the clients use.
const ENGINE_FILES = [
	'constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js',
	'ai-player.js', 'game-controller.js', 'game-review.js', 'elo.js',
];

// Engine files the functions require() directly (CommonJS-aware), not part
// of the replay bundle.
const SHARED_FILES = ['room-clock.js'];

function engineDir() {
	const copied = path.join(__dirname, 'engine');
	if (fs.existsSync(path.join(copied, ENGINE_FILES[0]))) return copied;
	return path.resolve(__dirname, '..', 'docs', 'static', 'scripts', 'engine');
}

let _script = null;

function _compiled() {
	if (_script) return _script;
	const dir = engineDir();
	const parts = ENGINE_FILES.map((f) =>
		`// ===== ${f} =====\n` + fs.readFileSync(path.join(dir, f), 'utf8'));
	// Top-level const/class declarations don't attach to the context's
	// global object, so hand the ones we use back out explicitly.
	parts.push(`
;globalThis.__sigil = {
	SigilBoard, boardToSfn, normalizeSfnString, normalizeVariant,
	reconstructGameLog, unratedReason, computeEloChange,
	positionExpectedScore, gameStartRedWinProb,
	// The review panel's reader of game_evals documents (analysis.js tests).
	rustEvalsToReview, _reviewPositions,
};`);
	_script = new vm.Script(parts.join('\n;\n'), { filename: 'sigil-engine-bundle.js' });
	return _script;
}

/** A fresh engine instance: { SigilBoard, reconstructGameLog, ... }. */
function freshEngine() {
	const sandbox = {
		console: { log() {}, info() {}, debug() {}, warn: console.warn, error: console.error },
		setTimeout, clearTimeout, Promise, Math, Date, JSON,
	};
	vm.createContext(sandbox);
	_compiled().runInContext(sandbox);
	return sandbox.__sigil;
}

/** One of SHARED_FILES, from the same place as the engine. */
function requireShared(name) {
	return require(path.join(engineDir(), name));
}

module.exports = { freshEngine, requireShared, ENGINE_FILES, SHARED_FILES, engineDir };
