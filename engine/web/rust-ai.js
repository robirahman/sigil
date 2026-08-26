'use strict';
/**
 * RustAI — plays through the normal web UI, backed by the native Rust engine
 * running on a localhost helper (engine/server/serve.py).
 *
 * WHY THIS SHAPE. The site is static GitHub Pages with every AI running
 * client-side, so there is no deployed server; and the Rust engine's turn
 * representation cannot be applied by the JS (a `Cast` carries an outcome index
 * into the engine's own enumeration). Rather than build a translation layer for
 * all 39 spells, this adapter inverts the flow:
 *
 *   1. the browser enumerates its OWN legal turns, exactly as CavemanAI does
 *   2. it applies each with its OWN rules and serialises the result to SFN
 *   3. the server searches from each candidate and returns the best INDEX
 *   4. the browser plays that turn through the normal applyAITurn path
 *
 * So animations, the action log, and the recorded game history all behave like
 * any other AI, and no engine-internal representation crosses the wire.
 *
 * HONEST LIMITATION: the engine can only choose among the turns the browser
 * offered, and the browser's enumerator is capped (ENUM_CAPS), whereas the
 * standalone engine generates ~4,000x more turns per position. This is therefore
 * a weaker configuration than the standalone arena numbers. `lastMeta.candidates`
 * reports how wide the choice actually was.
 *
 * Only the 39 official spells are supported: the engine deliberately does not
 * implement Tectonic, Providence, Aftershock, Ambush or the fan-made Panda pack,
 * and will reject a position containing them.
 */
class RustAI {
	constructor(options) {
		options = options || {};
		this.endpoint = options.endpoint || '/api/pick';
		this.timeMs = (options.timeLimit !== undefined ? options.timeLimit : 60) * 1000;
		this.pondering = false;      // no ponder: the search lives in another process
		this.lastMeta = null;
		this._historySfns = [];
	}

	cancelPonder() { /* nothing to cancel */ }

	async pickTurn(board, color, onProgress) {
		const sim = SimBoard.fromSigilBoard(board);

		// 1. enumerate our own legal turns (exhaustive where available, so spell
		//    variants and push destinations are offered rather than collapsed)
		let turns;
		if (typeof getLegalTurnsExhaustive === 'function' && typeof ENUM_CAPS !== 'undefined') {
			turns = [...getLegalTurnsExhaustive(sim, color, ENUM_CAPS)];
		} else {
			turns = [...sim.getLegalTurns(color)];
		}
		if (turns.length === 0) return new SimTurn([new SimAction('pass')]);
		if (turns.length === 1) {
			this.lastMeta = { candidates: 1, depth: 0, nodes: 0, note: 'forced' };
			return turns[0];
		}

		// 2. apply each candidate with OUR rules and serialise the result
		const sfns = [];
		const keep = [];
		for (const t of turns) {
			try {
				const after = _minimaxApplyTurn(sim, t, color);
				sfns.push(boardToSfn(after));
				keep.push(t);
			} catch (e) { /* skip anything our own applier rejects */ }
		}
		if (sfns.length === 0) return turns[0];

		if (onProgress) onProgress({ depth: 0, nodes: 0, note: `${sfns.length} candidates` });

		// 3. ask the engine which resulting position it prefers
		let res;
		try {
			const r = await fetch(this.endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sfns: sfns,
					us: color,
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

		const idx = Math.max(0, Math.min(res.index | 0, keep.length - 1));
		this.lastMeta = {
			depth: res.depth, nodes: res.nodes, score: res.score,
			timeMs: Math.round((res.seconds || 0) * 1000), candidates: res.candidates,
		};
		if (onProgress) onProgress(this.lastMeta);
		// remember the position we are moving FROM, for repetition detection
		this._historySfns.push(boardToSfn(sim));
		return keep[idx];
	}
}

if (typeof window !== 'undefined') window.RustAI = RustAI;
