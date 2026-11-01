/**
 * SigilBench: replay a submitted turn (an applyAITurn action list) with the
 * real browser rules. Shared by the offline grader (bench/grader/apply.js,
 * which loads this file into a sandbox next to the engine scripts) and the
 * "Try the dev set" panel of sigilbench.html, so both read an answer the
 * same way.
 *
 * Needs the engine globals (script-level, so referenced bare, not via window): SigilBoard, SimBoard, sfnToDict, normalizeVariant,
 * applyAITurn, sealOfDestructionBurn, boardToSfn, puzzleSfnKey, NODE_ORDER.
 *
 * applyAITurn does NOT check legality -- it just mutates the board -- so the
 * result is only a CLAIM; the offline grader (bench_grade, Rust) accepts it
 * only if some legal turn reaches the same position.
 */
'use strict';
(function (root) {
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

	function validate(actions, spellNames) {
		const NODE_SET = new Set(NODE_ORDER);
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

	/**
	 * Replays `actions` for the side to move in `sfn`. Resolves to
	 * {ok: true, after, key, gameover, winner}; throws on a malformed list.
	 * The replay is exactly the page's (tools/puzzle-smoke.js --replay and
	 * rust-ai.js rustActionsToTurn): applyAITurn, update, the Seal of
	 * Destruction end-of-turn burn, checkGameOver, then the turn passes.
	 */
	async function replay(sfn, actions) {
		const d = sfnToDict(sfn);
		const b = new SigilBoard(null, normalizeVariant(d && d.variant));
		b.loadFromSfn(sfn);
		const sim = SimBoard.fromSigilBoard(b);
		validate(actions, sim.spellNames || b.spellNames || []);
		const color = String(sfn).trim().split(/\s+/)[1] === 'r' ? 'red' : 'blue';
		const probe = sim.copy();
		probe.enemy = (c) => (c === 'red' ? 'blue' : 'red');
		probe.getBoardStatePayload = () => ({});
		await applyAITurn(probe, { actions }, color, () => {});
		probe.update();
		sealOfDestructionBurn(probe, color);
		probe.checkGameOver(color);
		probe.turnCounter++;
		probe.whoseTurn = color === 'red' ? 'blue' : 'red';
		probe.update();
		const after = boardToSfn(probe);
		return { ok: true, after, key: puzzleSfnKey(after), gameover: !!probe.gameover, winner: probe.winner || null };
	}

	/**
	 * Pulls the action list out of whatever a person pastes: a bare JSON
	 * array, {"actions": [...]}, a submit_answer tool call, or a reply whose
	 * LAST ```json block (or last top-level [...]) holds one of those.
	 */
	function extractActions(text) {
		const t = String(text || '').trim();
		const unwrap = (v) => {
			if (Array.isArray(v)) return v;
			if (v && typeof v === 'object') {
				if (Array.isArray(v.actions)) return v.actions;
				if (v.input && Array.isArray(v.input.actions)) return v.input.actions;
				if (v.arguments) {
					const a = typeof v.arguments === 'string' ? JSON.parse(v.arguments) : v.arguments;
					if (a && Array.isArray(a.actions)) return a.actions;
				}
			}
			return null;
		};
		try { const v = unwrap(JSON.parse(t)); if (v) return v; } catch (e) { /* not bare JSON */ }
		const blocks = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1].trim());
		for (const b of blocks.reverse()) {
			try { const v = unwrap(JSON.parse(b)); if (v) return v; } catch (e) { /* next */ }
		}
		// Last balanced [...] that starts an array of objects.
		for (let i = t.lastIndexOf('[{'); i >= 0; i = t.lastIndexOf('[{', i - 1)) {
			let depth = 0, inStr = false, esc = false;
			for (let j = i; j < t.length; j++) {
				const c = t[j];
				if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
				if (c === '"') inStr = true;
				else if (c === '[' || c === '{') depth++;
				else if (c === ']' || c === '}') {
					depth--;
					if (depth === 0) {
						try { const v = JSON.parse(t.slice(i, j + 1)); if (Array.isArray(v)) return v; } catch (e) { /* keep looking */ }
						break;
					}
				}
			}
			if (i === 0) break;
		}
		throw new Error('No action list found. Paste a JSON array of actions, or {"actions": [...]}.');
	}

	root.SigilBenchReplay = { validate, replay, extractActions, SCHEMA };
})(typeof window !== 'undefined' ? window : globalThis);
