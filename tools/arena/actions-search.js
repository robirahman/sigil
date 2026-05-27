'use strict';
/**
 * Find the input action-string sequence that drives the real
 * SpectatorController to reproduce a known turn outcome.
 *
 * Rather than hand-map each of the ~20 spell-resolver prompt flows, we treat
 * the consumer as a black box: the resolved SimTurn already names every node
 * involved (move target, push retreat, dash sacrifices, spell refills/targets),
 * so the answer to each prompt is almost always one of those nodes. We DFS over
 * that small token pool, replaying the candidate through SpectatorController,
 * and accept the first sequence that (a) runs to completion and (b) reproduces
 * `sfnAfter`. Correctness is by construction — we only return a sequence the
 * real consumer verifiably replays to the right board.
 *
 * The first token is fixed by the turn's opening action (you must move first,
 * so it's the move target — or a spell name / 'dash' / 'pass'). 'pass' is tried
 * first among continuations so completed turns yield minimal, natural scripts.
 */

const { replayTurn } = require('./consumer.js');

/**
 * Normalize an SFN for comparison. The engine's _minimaxApplyTurn advances the
 * turn after applying (whoseTurn flips, turnCounter++), while the consumer's
 * _takeTurn applies one player's actions WITHOUT advancing — so those two
 * fields legitimately differ. Everything the move/cast actually changes
 * (stones, spell list, spellCounters, locks, springlocks, score) is kept.
 *
 * SFN layout: "<stones>/<spells> <whoseTurn> <turnCounter> <sc.r:sc.b> <lock> <springlock> <score>"
 */
function sfnKey(sfn) {
	const parts = sfn.split(' ');
	if (parts.length < 3) return sfn;
	parts[1] = '_';  // whoseTurn
	parts[2] = '_';  // turnCounter
	return parts.join(' ');
}

function firstToken(action0) {
	const t = action0.type;
	if (t === 'move' || t === 'blink' || t === 'hard_move') return action0.node;
	if (t === 'dash' || t === 'dash_lightning') return 'dash';
	if (t === 'cast') return action0.spell;
	if (t === 'pass') return 'pass';
	// Resolver-emitted leading action (rare) — fall back to its node.
	return action0.node != null ? action0.node : 'pass';
}

/**
 * Tokens that could answer this turn's prompts, in TRUE appearance order —
 * the order the SimTurn lists them, which mirrors the resolver's prompt order.
 * No dedup: chained pushes legitimately reuse a node (push #1's retreat is
 * push #2's target), so the same token can appear twice. Outcome-only nodes
 * (e.g. fireblast `destroyed`) are included but get skipped by the monotonic
 * subsequence walk. The matching sequence is then an in-order subsequence of
 * this list, found in roughly as many replays as the turn is long.
 */
function orderedTokens(simTurn) {
	const out = [];
	for (const a of simTurn.actions) {
		if (a.type === 'pass') { out.push('pass'); continue; }
		if (a.type === 'dash' || a.type === 'dash_lightning') {
			// _doDash consumes sacrifices first, then the move target.
			out.push('dash');
			if (Array.isArray(a.sacrificed)) for (const n of a.sacrificed) out.push(n);
			if (a.node != null) out.push(a.node);
			continue;
		}
		if (a.type === 'cast' && a.spell) out.push(a.spell);  // refills follow
		for (const k of ['node', 'node2', 'pushed_to']) if (a[k] != null) out.push(a[k]);
		for (const k of ['sacrificed', 'kept', 'destroyed']) {
			if (Array.isArray(a[k])) for (const n of a[k]) out.push(n);
		}
	}
	return out;
}

const NEED_MORE = '__need_more_input__';

/**
 * @returns {{actions: string[], replays: number} | {error: string, replays: number}}
 */
async function findActions(consumer, spellNames, variant, sfnBefore, color,
                           simTurn, sfnAfter, opts = {}) {
	// A turn needs at most one input per action plus a little slack (push
	// retreats add a token; auto-resolved actions add none). Bounding depth to
	// the action count is what keeps long turns from exploding.
	const maxLen = opts.maxLen || (simTurn.actions.length + 4);
	const replayCap = opts.replayCap || 200000;
	const first = firstToken(simTurn.actions[0]);
	const ordered = orderedTokens(simTurn);
	// The opener is consumed as the first token; drop one copy so the
	// subsequence walk doesn't re-offer it.
	const pool = ordered.slice();
	const fi = pool.indexOf(first);
	if (fi >= 0) pool.splice(fi, 1);
	// Fallback pool: unique tokens (for the unrestricted DFS).
	const fullPool = [...new Set(ordered)];
	const targetKey = sfnKey(sfnAfter);
	let replays = 0;

	async function accept(prefix) {
		const r = await replayTurn(consumer, spellNames, variant, sfnBefore, color, prefix);
		if (r.ok) {
			return { done: true, win: sfnKey(r.sfn) === targetKey && r.consumed === prefix.length };
		}
		return { done: false, more: r.reason === NEED_MORE && r.consumed === prefix.length };
	}

	// Primary: monotonic subsequence of the appearance-ordered pool. Input
	// tokens appear in the SimTurn in prompt order, so the answer is some
	// in-order subsequence (optional tokens — e.g. auto-resolved push retreats
	// — skipped). Small, correctly structured space.
	async function walk(prefix, startIdx) {
		if (replays >= replayCap) return null;
		replays++;
		const a = await accept(prefix);
		if (a.done) return a.win ? prefix : null;
		if (!a.more || prefix.length >= maxLen) return null;
		for (let i = startIdx; i < pool.length; i++) {
			const res = await walk(prefix.concat(pool[i]), i + 1);
			if (res) return res;
		}
		return null;
	}

	let found = await walk([first], 0);
	if (found) return { actions: found, replays };

	// Fallback: unrestricted DFS (handles the rare turn whose prompt order
	// isn't a clean subsequence of appearance order). Bounded by replayCap.
	async function dfs(prefix) {
		if (replays >= replayCap) return null;
		replays++;
		const a = await accept(prefix);
		if (a.done) return a.win ? prefix : null;
		if (!a.more || prefix.length >= maxLen) return null;
		for (const tok of fullPool) {
			const res = await dfs(prefix.concat(tok));
			if (res) return res;
		}
		return null;
	}
	found = await dfs([first]);
	if (found) return { actions: found, replays };
	return { error: 'no action sequence reproduced sfnAfter', replays };
}

module.exports = { findActions, firstToken, orderedTokens };
