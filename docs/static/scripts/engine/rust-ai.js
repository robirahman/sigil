'use strict';
/**
 * RustAI — plays through the normal web UI, backed by the native Rust engine on a
 * localhost helper (engine/server/serve.py).
 *
 * The engine chooses from its OWN full enumeration — every push destination, dash
 * sacrifice subset, dash target and spell-resolution variant — and returns a JS
 * action list plus the position that list must produce. The browser asserts the
 * replay landed there and refuses the move otherwise.
 *
 * Why the assertion matters: `turns[].actions` feeds game review,
 * `reconstructGameLog`, SGN export and `ai/import_human_games.py`, so a silent
 * divergence between the engine's idea of the position and the board's would
 * corrupt recorded history and training data. Better to stop with a clear error.
 *
 * An earlier version had the browser propose candidates and the engine pick an
 * index. That was safe but capped the engine at the browser's `ENUM_CAPS`, which
 * offers on the order of 4,000x fewer turns per position.
 *
 * Only the 39 official spells are supported: the engine does not implement
 * Tectonic, Providence, Aftershock, Ambush or the fan-made Panda pack and rejects
 * positions containing them rather than mis-resolving.
 */
class RustAI {
	constructor(options) {
		options = options || {};
		this.endpoint = options.endpoint || '/api/move';
		this.timeMs = (options.timeLimit !== undefined ? options.timeLimit : 60) * 1000;
		this.pondering = false;      // the search lives in another process
		this.lastMeta = null;
		this._historySfns = [];
	}

	cancelPonder() { /* nothing to cancel */ }

	async pickTurn(board, color, onProgress) {
		const sim = SimBoard.fromSigilBoard(board);
		const sfn = boardToSfn(sim);

		let res;
		try {
			const r = await fetch(this.endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sfn: sfn,
					time_ms: this.timeMs,
					history_sfns: this._historySfns.slice(-64),
				}),
			});
			res = await r.json();
		} catch (e) {
			throw new Error(
				'Rust engine unreachable at ' + this.endpoint + '. Start it with:\n' +
				'  python engine/server/serve.py --docs docs --time 60\n' +
				'and open the game from that server (http://localhost:8000/...).\n' +
				'Underlying error: ' + e);
		}
		if (!res || !res.ok) {
			throw new Error('Rust engine error: ' + ((res && res.error) || 'unknown') +
				'\nIf this mentions an out-of-scope spell, the draw includes a pack the ' +
				'engine does not implement (Tectonic / Providence / Aftershock / Ambush / Panda).');
		}

		// Verify the actions reproduce the engine's position BEFORE playing them on
		// the real board: replay on a throwaway copy and compare.
		const probe = sim.copy();
		probe.enemy = (c) => (c === 'red' ? 'blue' : 'red');
		probe.getBoardStatePayload = () => ({});
		if (probe.movesLeftThisTurn === undefined) probe.movesLeftThisTurn = 1;
		try {
			await applyAITurn(probe, { actions: res.actions }, color, () => {});
			probe.update();
			probe.checkGameOver(color);
			probe.turnCounter++;
			probe.whoseTurn = (color === 'red') ? 'blue' : 'red';
			probe.update();
		} catch (e) {
			throw new Error('Rust engine action replay threw: ' + e);
		}
		const key = (x) => { const p = x.split(' '); return [p[0], p[1], p[3], p[4], p[5]].join(' '); };
		if (key(boardToSfn(probe)) !== key(res.expected_sfn)) {
			throw new Error(
				'Rust engine action list did not reproduce its own position — refusing ' +
				'the move rather than corrupting the game record.\n' +
				'  replayed: ' + key(boardToSfn(probe)) + '\n' +
				'  expected: ' + key(res.expected_sfn));
		}

		this.lastMeta = {
			depth: res.depth, nodes: res.nodes, score: res.score,
			timeMs: Math.round((res.seconds || 0) * 1000),
		};
		if (onProgress) onProgress(this.lastMeta);
		this._historySfns.push(sfn);
		return new SimTurn(res.actions.map((a) => {
			const act = new SimAction(a.type, {});
			Object.assign(act, a);
			return act;
		}));
	}
}

if (typeof window !== 'undefined') window.RustAI = RustAI;
