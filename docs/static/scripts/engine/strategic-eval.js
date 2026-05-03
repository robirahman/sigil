/**
 * Search-time strategic evaluator — hand-coded rules that bias MCTS
 * priors at decision time without retraining the network.
 *
 * Mirror of ai/strategic_eval.py. Encodes the mechanical rules from
 * the Sigil strategy blog (don't sacrifice for nothing, don't let
 * enemy spells grow, break enemy chains, etc.) as a deterministic
 * score per candidate turn. Bias is multiplicative on the network
 * prior: `policy ← policy * exp(alpha * score)` then renormalize.
 *
 * Reads the per-turn feature vector indices defined by encode_turn
 * (features.js). Keep these in sync.
 */

const STRAT_F_HAS_DASH = 41;
const STRAT_F_DASH_RECOVERS = 67;
const STRAT_F_NEW_THREATS_TO_US = 68;
const STRAT_F_CLEARED_ENEMY_THREATS = 69;
const STRAT_F_NET_STONE_CHANGE = 75;
const STRAT_F_ENEMY_THREAT_GROWTH = 76;
const STRAT_F_OWN_THREAT_GROWTH = 77;
const STRAT_F_DISRUPTS_ENEMY_CHAIN = 78;

const STRAT_W_NET_STONE = 1.5;
const STRAT_W_ENEMY_THREAT_GROWTH = 1.2;
const STRAT_W_OWN_THREAT_GROWTH = 0.5;
const STRAT_W_DISRUPTS_CHAIN = 1.0;
const STRAT_W_NEW_THREATS_TO_US = 0.8;
const STRAT_W_CLEARED_ENEMY_THREATS = 0.5;
const STRAT_W_NAKED_DASH = 1.0;

/**
 * Strategic score for a single turn given its feature vector.
 * @param {Float32Array} tf - turn features (TURN_FEATURE_DIM long)
 * @returns {number} signed score
 */
function strategicScore(tf) {
	const isDash = tf[STRAT_F_HAS_DASH] > 0.5;
	const dashRecovers = tf[STRAT_F_DASH_RECOVERS] > 0.5;
	let s = 0;
	s += STRAT_W_NET_STONE * tf[STRAT_F_NET_STONE_CHANGE];
	s -= STRAT_W_ENEMY_THREAT_GROWTH * tf[STRAT_F_ENEMY_THREAT_GROWTH];
	s += STRAT_W_OWN_THREAT_GROWTH * tf[STRAT_F_OWN_THREAT_GROWTH];
	s += STRAT_W_DISRUPTS_CHAIN * tf[STRAT_F_DISRUPTS_ENEMY_CHAIN];
	s -= STRAT_W_NEW_THREATS_TO_US * tf[STRAT_F_NEW_THREATS_TO_US];
	s += STRAT_W_CLEARED_ENEMY_THREATS * tf[STRAT_F_CLEARED_ENEMY_THREATS];
	if (isDash && !dashRecovers) s -= STRAT_W_NAKED_DASH;
	return s;
}

/**
 * Multiplicatively bias `policy` toward strategically better turns.
 * @param {Float32Array} policy - input prior (length N, sums to 1 or 0)
 * @param {Float32Array} turnFeatures - flat (N * TURN_FEATURE_DIM)
 * @param {number} numTurns - N
 * @param {number} turnFeatureDim - TURN_FEATURE_DIM
 * @param {number} alpha - bias strength (0 = disabled)
 * @returns {Float32Array} adjusted policy summing to 1 (or unchanged if alpha=0)
 */
function strategicAdjustPolicy(policy, turnFeatures, numTurns, turnFeatureDim, alpha) {
	if (!alpha || alpha <= 0 || numTurns === 0) return policy;
	const out = new Float32Array(numTurns);
	let total = 0;
	for (let i = 0; i < numTurns; i++) {
		const tf = turnFeatures.subarray(i * turnFeatureDim, (i + 1) * turnFeatureDim);
		let logit = alpha * strategicScore(tf);
		if (logit > 5) logit = 5;
		if (logit < -5) logit = -5;
		const f = Math.exp(logit);
		const v = policy[i] * f;
		out[i] = v;
		total += v;
	}
	if (total <= 0) return policy;
	for (let i = 0; i < numTurns; i++) out[i] /= total;
	return out;
}
