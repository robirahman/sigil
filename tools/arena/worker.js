'use strict';
/**
 * Worker-thread entry: load the engine once, play an assigned slice of
 * games sequentially, post each result back to the orchestrator as it
 * completes. One engine bundle per worker; games within a worker are
 * sequential (each search already saturates one core).
 */

const { parentPort, workerData } = require('worker_threads');
const { loadEngine } = require('./engine.js');
const { playGame } = require('./play-game.js');

(async () => {
	const engine = loadEngine();
	for (const spec of workerData.specs) {
		try {
			const result = await playGame(engine, spec);
			parentPort.postMessage({ ok: true, result });
		} catch (err) {
			parentPort.postMessage({
				ok: false,
				gameId: spec.gameId,
				error: (err && err.stack) || String(err),
			});
		}
	}
	parentPort.postMessage({ done: true });
})();
