'use strict';
/**
 * Headless loader for the *consumer* side of the engine — the exact
 * `SpectatorController` + `SigilBoard` + spell-resolver code the browser
 * spectator runs to replay a Firebase `turns` stream.
 *
 * Loaded in its own `runInThisContext` script (separate top-level lexical
 * scope) so its declarations don't collide with the search-engine bundle
 * (engine.js), which shares some filenames (constants.js, notation.js).
 *
 * Used to (a) verify that a generated action-string sequence reproduces a
 * known board, and (b) search for that sequence — see actions-search.js.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Mirrors multiplayer.html's script order, trimmed to what the spectator
// replay path actually needs (no search/NN/firebase files).
const CONSUMER_FILES = [
	'constants.js',
	'notation.js',
	'board.js',
	'moves.js',
	'spells.js',
	'spectator-controller.js',
];

function engineDir() {
	return path.resolve(__dirname, '..', '..', 'docs', 'static', 'scripts', 'engine');
}

// Fresh sandbox global carrying the JS/Node built-ins the engine code uses.
// Each bundle runs in its own context so top-level const/class declarations
// can't collide with another bundle that shares filenames (constants.js,
// notation.js) — runInThisContext shares one global lexical scope, which does
// collide, so we avoid it.
function makeSandbox() {
	const names = [
		'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date',
		'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Promise', 'Proxy',
		'Reflect', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Function',
		'Infinity', 'NaN', 'undefined', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
		'encodeURIComponent', 'decodeURIComponent',
		'ArrayBuffer', 'Float32Array', 'Float64Array',
		'Int8Array', 'Int16Array', 'Int32Array', 'Uint8Array', 'Uint16Array', 'Uint32Array',
		'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
	];
	const sandbox = {};
	for (const n of names) sandbox[n] = globalThis[n];
	sandbox.globalThis = sandbox;
	return sandbox;
}

let _consumer = null;

function loadConsumer() {
	if (_consumer) return _consumer;
	const dir = engineDir();
	const parts = CONSUMER_FILES.map((f) =>
		`// ===== ${f} =====\n` + fs.readFileSync(path.join(dir, f), 'utf8'));
	parts.push(`
;globalThis.__sigilConsumer = {
	SpectatorController, SigilBoard, boardToSfn,
	getAllMoveTargets, getBlinkTargets,
};`);
	const ctx = vm.createContext(makeSandbox());
	vm.runInContext(parts.join('\n;\n'), ctx, { filename: 'sigil-consumer-bundle.js' });
	_consumer = ctx.__sigilConsumer;
	return _consumer;
}

// Sentinel thrown by the fake sync when an action sequence is too short
// (the controller asked for more input than we supplied).
const NEED_MORE = '__need_more_input__';

/**
 * Replay one player's turn through the real SpectatorController, feeding
 * `actions` as the input stream. Returns { ok, consumed, sfn } on success
 * (controller ran to completion) or { ok:false, reason, consumed } if it
 * needed more input / threw.
 *
 * @param consumer  result of loadConsumer()
 * @param spellNames 9-spell list
 * @param variant   'standard' | 'competitive'
 * @param sfnBefore SFN of the position before this turn
 * @param color     'red' | 'blue'
 * @param actions   candidate input-string array
 */
async function replayTurn(consumer, spellNames, variant, sfnBefore, color, actions) {
	const { SpectatorController, SigilBoard, boardToSfn } = consumer;
	let idx = 0;
	const sync = {
		variant,
		getNextOpponentAction() {
			if (idx >= actions.length) return Promise.reject(new Error(NEED_MORE));
			return Promise.resolve(actions[idx++]);
		},
	};
	const ctrl = new SpectatorController(() => {}, sync, spellNames);
	ctrl.board = new SigilBoard(spellNames, variant);
	ctrl.board.loadFromSfn(sfnBefore);
	try {
		await ctrl._takeTurn(color, true, true, true, true);
		return { ok: true, consumed: idx, sfn: boardToSfn(ctrl.board), board: ctrl.board };
	} catch (e) {
		return { ok: false, reason: e.message, consumed: idx };
	}
}

module.exports = { loadConsumer, replayTurn, CONSUMER_FILES };
