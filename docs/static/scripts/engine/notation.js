function stoneChar(stone) {
	if (stone === 'red') return 'r';
	if (stone === 'blue') return 'b';
	// Node permanently destroyed by Fissure (a wall). Backward compatible:
	// 'x' never appears in pre-Fissure SFN strings.
	if (stone === 'X') return 'x';
	return '.';
}

function charToStone(ch) {
	if (ch === 'r') return 'red';
	if (ch === 'b') return 'blue';
	if (ch === 'x') return 'X';  // permanently destroyed node (wall)
	return null;
}

function boardToSfn(board) {
	const stonesStr = NODE_ORDER.map(n => stoneChar(board.stones[n])).join('');
	const spellsStr = board.spellNames.join(',');
	const turn = board.whoseTurn === 'red' ? 'r' : 'b';
	const tc = board.turnCounter;
	const rsc = board.spellCounter.red;
	const bsc = board.spellCounter.blue;
	const rlock = board.lock.red || '-';
	const block = board.lock.blue || '-';
	const rspring = board.springlock.red || '-';
	const bspring = board.springlock.blue || '-';
	const score = board.score || 'b1';
	let out = `${stonesStr}/${spellsStr} ${turn} ${tc} ${rsc}:${bsc} ${rlock}:${block} ${rspring}:${bspring} ${score}`;
	// Optional trailing variant token; omitted for 'standard' to keep
	// existing SFN strings byte-identical with the Python writer.
	const variant = board.variant || 'standard';
	if (variant !== 'standard') out += ` ${variant}`;
	// Providence pending-move schedules. Self-tagged optional token, emitted
	// only while a schedule is in flight, so every pre-Providence SFN — and
	// every Providence SFN with no active effect — stays byte-identical.
	// Readers recognize trailing tokens by prefix ('pm:'), not position.
	const pr = (board.pendingMoves && board.pendingMoves.red) || [];
	const pb = (board.pendingMoves && board.pendingMoves.blue) || [];
	if (pr.length || pb.length) {
		out += ` pm:${pr.length ? pr.join(',') : '-'}:${pb.length ? pb.join(',') : '-'}`;
	}
	// Aftershock burn schedules — same optional self-tagged pattern.
	// Canonical emission order: variant, pm:, ab:.
	const br = (board.pendingBurns && board.pendingBurns.red) || [];
	const bb = (board.pendingBurns && board.pendingBurns.blue) || [];
	if (br.length || bb.length) {
		out += ` ab:${br.length ? br.join(',') : '-'}:${bb.length ? bb.join(',') : '-'}`;
	}
	// Ambush snares — NODE_ORDER-canonical, '=' separator (never colliding
	// with pm:/ab: colon splitting). Emission order: variant, pm:, ab:, sn:.
	if (board.snares && Object.keys(board.snares).length) {
		const parts = [];
		for (const n of NODE_ORDER) {
			if (board.snares[n]) parts.push(n + '=' + (board.snares[n] === 'red' ? 'r' : 'b'));
		}
		if (parts.length) out += ' sn:' + parts.join(',');
	}
	return out;
}

function sfnToDict(sfnStr) {
	const parts = sfnStr.split(' ');
	const [stonesStr, spellsStr] = parts[0].split('/');

	const stones = {};
	for (let i = 0; i < NODE_ORDER.length; i++) {
		stones[NODE_ORDER[i]] = charToStone(stonesStr[i]);
	}

	const spellNames = spellsStr.split(',');
	const turn = parts[1] === 'r' ? 'red' : 'blue';
	const turncounter = parseInt(parts[2]);

	const scParts = parts[3].split(':');
	const redSc = parseInt(scParts[0]);
	const blueSc = parseInt(scParts[1]);

	const lockParts = parts[4].split(':');
	const redLock = lockParts[0] === '-' ? null : lockParts[0];
	const blueLock = lockParts[1] === '-' ? null : lockParts[1];

	const springParts = parts[5].split(':');
	const redSpring = springParts[0] === '-' ? null : springParts[0];
	const blueSpring = springParts[1] === '-' ? null : springParts[1];

	const score = parts[6];

	// Optional trailing tokens, recognized by prefix so they can appear in
	// any combination: 'pm:<red>:<blue>' carries Providence pending-move
	// schedules; any other token is the variant. Both default for legacy SFN.
	let variant = 'standard';
	let redPending = [];
	let bluePending = [];
	let redBurns = [];
	let blueBurns = [];
	const snares = {};
	for (const token of parts.slice(7)) {
		if (token.startsWith('pm:')) {
			const [, prStr, pbStr] = token.split(':');
			redPending = prStr === '-' ? [] : prStr.split(',').map(Number);
			bluePending = pbStr === '-' ? [] : pbStr.split(',').map(Number);
		} else if (token.startsWith('ab:')) {
			const [, brStr, bbStr] = token.split(':');
			redBurns = brStr === '-' ? [] : brStr.split(',').map(Number);
			blueBurns = bbStr === '-' ? [] : bbStr.split(',').map(Number);
		} else if (token.startsWith('sn:')) {
			for (const entry of token.slice(3).split(',')) {
				const eq = entry.indexOf('=');
				if (eq > 0) {
					snares[entry.slice(0, eq)] = entry.slice(eq + 1) === 'r' ? 'red' : 'blue';
				}
			}
		} else if (token) {
			variant = token;
		}
	}

	return {
		stones, spell_names: spellNames, turn, turncounter,
		red_spellcounter: redSc, blue_spellcounter: blueSc,
		red_lock: redLock, blue_lock: blueLock,
		red_springlock: redSpring, blue_springlock: blueSpring,
		score, variant,
		red_pending: redPending, blue_pending: bluePending,
		red_burns: redBurns, blue_burns: blueBurns,
		snares,
	};
}

/* ------------------------------------------------------------------ *
 * SGN-T — transcript-based game notation ("Sigil Game Notation,
 * transcript variant"). Replaces the old JSON-blob game export, which
 * stored ~3 full SFN board snapshots per turn (>5KB per game).
 *
 * Framing matches Python notation.py's SGN (bracket headers, R<n>./B<n>.
 * turn lines) plus:
 *   [Format "transcript-v1"]  — discriminator; absent => classic SGN
 *                               (display-grade, not JS-replayable).
 *   [Setup "<sfn>"]           — only for games begun from an imported SFN.
 *   [FinalSfn "<sfn>"]        — replay integrity check.
 *   [Annotations "12:good"]   — move annotations, keyed by turnNumber.
 *   [Evals "12:red"]          — eval annotations, keyed by turnNumber.
 *
 * Turn lines:
 *   R2. a11 dash a1 a2 c10 Bewitch b6 b2 pass
 *       Human turn: raw input tokens in prompt order (the same encoding
 *       the multiplayer wire protocol replays), space-free by construction.
 *   B3* {"actions":[{"type":"move","node":"b9"},...]}
 *       AI turn: compact-JSON SimActions, replayed via applyAITurn.
 *   R5= <sfn>
 *       Snapshot turn (hybrid records migrated from fat storage): the
 *       move sequence is unknown; the replayer adopts the after-state
 *       verbatim and continues from it.
 *
 * The same slim turn entries ({color, turnNumber, kind, actions} via
 * slimGameLog below) are the canonical AT-REST shape for every stored
 * record: rooms gameLog, completed_games turns (since 2026-08, with
 * setupSfn/finalSfn anchors), and localStorage saves. SFN snapshots are
 * for positions (imports, reconnect anchors), never per-turn storage —
 * readers rebuild positions by replay (hydrateGameLog/reconstructGameLog
 * in game-review.js; Python consumers bridge through
 * tools/replay-transcripts.js via ai/replay_bridge.py).
 * ------------------------------------------------------------------ */

function _sgnAnnotationsToHeader(ann) {
	if (!ann) return '';
	const parts = [];
	for (const key of Object.keys(ann)) {
		if (ann[key] === null || ann[key] === undefined) continue;
		parts.push(key + ':' + ann[key]);
	}
	return parts.join(',');
}

function _sgnHeaderToAnnotations(str) {
	const out = {};
	if (!str) return out;
	for (const part of str.split(',')) {
		const idx = part.indexOf(':');
		if (idx <= 0) continue;
		out[part.slice(0, idx)] = part.slice(idx + 1);
	}
	return out;
}

function _sgnStripAction(a) {
	const out = {};
	for (const k of Object.keys(a)) {
		if (a[k] !== null && a[k] !== undefined) out[k] = a[k];
	}
	return out;
}

/**
 * Project fat in-memory gameLog entries down to the canonical AT-REST
 * shape: { color, turnNumber, kind, actions } — the marginal moves only,
 * no board states. This is the single slim projection used by every
 * stored record (rooms gameLog, completed_games turns, localStorage
 * saves); readers rebuild positions by replaying through
 * reconstructGameLog. Sim actions are stripped of null/undefined fields
 * (Firebase rejects undefined, and empty fields are dead weight).
 */
function slimGameLog(gameLog) {
	return (gameLog || []).map(t => {
		// Hybrid records (migrated fat games with a few undeduced turns)
		// keep the after-state for exactly those turns — the replayer
		// jumps the board there and continues.
		if (t.kind === 'snapshot') {
			return {
				color: t.color,
				turnNumber: t.turnNumber,
				kind: 'snapshot',
				sfnAfter: t.sfnAfter,
			};
		}
		return {
			color: t.color,
			turnNumber: t.turnNumber,
			kind: t.kind || 'input',
			actions: (t.kind === 'sim')
				? (t.actions || []).map(_sgnStripAction)
				: (t.actions || []),
		};
	});
}

/**
 * Serialize a finished game to SGN-T text.
 * @param {Object} header - { red, blue, result, spellNames, variant,
 *   setupSfn, finalSfn, annotations, evalAnnotations, date }
 * @param {Array} turns - gameLog entries: { color, turnNumber, kind,
 *   actions } (fat in-memory entries are fine; SFN fields are ignored).
 */
function gameToSgn(header, turns) {
	const esc = (s) => String(s == null ? '' : s).replace(/"/g, "'");
	const lines = [];
	lines.push('[Date "' + (header.date || new Date().toISOString().slice(0, 10)) + '"]');
	lines.push('[Red "' + esc(header.red || 'Red') + '"]');
	lines.push('[Blue "' + esc(header.blue || 'Blue') + '"]');
	lines.push('[Result "' + esc(header.result || '*') + '"]');
	lines.push('[Spells "' + (header.spellNames || []).join(',') + '"]');
	const variant = header.variant || 'standard';
	if (variant !== 'standard') lines.push('[Variant "' + variant + '"]');
	lines.push('[Format "transcript-v1"]');
	if (header.setupSfn) lines.push('[Setup "' + header.setupSfn + '"]');
	if (header.finalSfn) lines.push('[FinalSfn "' + header.finalSfn + '"]');
	const ann = _sgnAnnotationsToHeader(header.annotations);
	if (ann) lines.push('[Annotations "' + ann + '"]');
	const evals = _sgnAnnotationsToHeader(header.evalAnnotations);
	if (evals) lines.push('[Evals "' + evals + '"]');
	lines.push('');
	for (const t of (turns || [])) {
		const prefix = (t.color === 'red' ? 'R' : 'B') + t.turnNumber;
		if (t.kind === 'snapshot') {
			// Hybrid turn: moves unknown, after-state recorded verbatim.
			lines.push(prefix + '= ' + (t.sfnAfter || ''));
		} else if (t.kind === 'sim') {
			const actions = (t.actions || []).map(_sgnStripAction);
			lines.push(prefix + '* ' + JSON.stringify({ actions }));
		} else {
			lines.push(prefix + '. ' + (t.actions || []).join(' '));
		}
	}
	lines.push('');
	return lines.join('\n');
}

/** Quick sniff: is this text an SGN transcript (classic or -T)? */
function isSgnText(text) {
	if (typeof text !== 'string') return false;
	const t = text.trim();
	return t.startsWith('[') && t.includes('[Spells ');
}

/**
 * Parse SGN / SGN-T text.
 * @returns {{ headers: Object, turns: Array<{color, turnNumber, kind,
 *   tokens?, actions?}> }} — kind 'input' carries `tokens` (string list),
 *   kind 'sim' carries `actions` (plain objects). headers.Format tells
 *   callers whether the transcript is replayable ('transcript-v1').
 */
function parseSgn(text) {
	const headers = {};
	const turns = [];
	for (let line of text.split('\n')) {
		line = line.trim();
		if (!line) continue;
		if (line.startsWith('[')) {
			const sp = line.indexOf(' ');
			const q1 = line.indexOf('"');
			const q2 = line.lastIndexOf('"');
			if (sp > 1 && q1 > sp && q2 > q1) {
				headers[line.slice(1, sp)] = line.slice(q1 + 1, q2);
			}
			continue;
		}
		const m = line.match(/^([RB])(\d+)([.*=])\s*(.*)$/);
		if (!m) continue;
		const color = m[1] === 'R' ? 'red' : 'blue';
		const turnNumber = parseInt(m[2], 10);
		if (m[3] === '=') {
			// Hybrid snapshot turn: moves unknown, after-state verbatim.
			turns.push({ color, turnNumber, kind: 'snapshot', sfnAfter: m[4] });
		} else if (m[3] === '*') {
			let actions = [];
			try { actions = (JSON.parse(m[4]) || {}).actions || []; } catch (e) { /* malformed */ }
			turns.push({ color, turnNumber, kind: 'sim', actions });
		} else {
			// Classic-SGN terminator tokens ('P') are tolerated but the
			// transcript-v1 writer never emits them ('pass' is an input token).
			const tokens = m[4] ? m[4].split(' ') : [];
			turns.push({ color, turnNumber, kind: 'input', tokens });
		}
	}
	return { headers, turns };
}
