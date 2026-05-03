/**
 * Browser-side mirror of ai/forbidden_moves.py.
 *
 * Loads the compact JSON table shipped at static/models/forbidden_moves.json
 * and exposes a mask(board, color, legalTurns) helper that MCTS uses to
 * zero priors on human-flagged 'bad' moves.
 *
 * Position keys and turn signatures must stay in sync with their Python
 * counterparts so the same table works on both sides — see ai/forbidden_moves.py.
 */

function _stoneCharFM(s) {
	if (s === 'red') return 'r';
	if (s === 'blue') return 'b';
	return '.';
}

function _positionKey(board, color) {
	const stones = NODE_ORDER.map(n => _stoneCharFM(board.stones[n])).join('');
	const spells = board.spellNames.join('|');
	return `${stones}\t${spells}\t${color}`;
}

function _fmtField(v) {
	// Match Python's str(None) == 'None' so signatures bit-match the table.
	return v === null || v === undefined ? 'None' : String(v);
}

function _turnSignature(turn) {
	return turn.actions
		.map(a => `${_fmtField(a.type)}:${_fmtField(a.node)}:${_fmtField(a.spell)}`)
		.join('|');
}

class ForbiddenMovesJS {
	constructor() {
		this._table = new Map();
	}

	add(key, sig) {
		let bucket = this._table.get(key);
		if (!bucket) {
			bucket = new Set();
			this._table.set(key, bucket);
		}
		bucket.add(sig);
	}

	legalMask(board, color, legalTurns) {
		const mask = new Array(legalTurns.length).fill(false);
		const key = _positionKey(board, color);
		const bucket = this._table.get(key);
		if (!bucket) return mask;
		for (let i = 0; i < legalTurns.length; i++) {
			if (bucket.has(_turnSignature(legalTurns[i]))) mask[i] = true;
		}
		return mask;
	}

	static async load(url) {
		const fm = new ForbiddenMovesJS();
		try {
			const resp = await fetch(url);
			if (!resp.ok) return fm;
			const entries = await resp.json();
			for (const e of entries) {
				const stones = e.stones;
				const spells = (e.spells || []).join('|');
				const key = `${stones}\t${spells}\t${e.color}`;
				for (const s of e.signatures || []) fm.add(key, s);
			}
		} catch (err) {
			console.warn('ForbiddenMoves load failed:', err);
		}
		return fm;
	}
}
