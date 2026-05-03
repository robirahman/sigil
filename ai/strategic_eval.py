"""Search-time strategic evaluator — hand-coded rules that bias MCTS
priors without retraining the network.

Until now, every fix to the AI's strategic behavior went through the
training pipeline: add a feature → retrain → hope the network internalizes
it. That has diminishing returns once the data signal is exhausted.

This module computes a deterministic "strategic score" per candidate
turn from the same per-turn feature vector that ai/features.py already
produces, then folds it into the network's prior multiplicatively
(`policy ← policy * exp(alpha * score)` then renormalize). The rules
encode what Burch's strategy blog spells out as mechanical:
  - Don't sacrifice stones for nothing (naked dash penalty).
  - Don't make moves that grow the opponent's filled-but-uncast spells.
  - Reward breaking enemy mana-to-mana chains.
  - Reward our own threat growth and exploit existing crush opportunities.

It runs on top of any model — no retraining required — and works
identically in the browser (port: docs/static/scripts/engine/strategic-eval.js).
"""

import numpy as np


# Feature indices into the 84-dim per-turn vector produced by
# ai/features.py:encode_turn. Keep these in lockstep with that file.
F_HAS_DASH = 41
F_DASH_RECOVERS = 67
F_NEW_THREATS_TO_US = 68
F_CLEARED_ENEMY_THREATS = 69
F_NET_STONE_CHANGE = 75
F_ENEMY_THREAT_GROWTH = 76
F_OWN_THREAT_GROWTH = 77
F_DISRUPTS_ENEMY_CHAIN = 78


# Coefficients tuned by hand to match Burch's qualitative weighting.
# Larger absolute values bias more strongly. The total score is bounded
# in roughly [-4, +3] in practice, so with the default alpha (1.0) the
# strongest moves get ~e^3 ≈ 20× boost or e^-4 ≈ 1/55× suppression.
W_NET_STONE = 1.5
W_ENEMY_THREAT_GROWTH = 1.2
W_OWN_THREAT_GROWTH = 0.5
W_DISRUPTS_CHAIN = 1.0
W_NEW_THREATS_TO_US = 0.8
W_CLEARED_ENEMY_THREATS = 0.5
W_NAKED_DASH = 1.0  # extra penalty on top of net-stone signal


def strategic_scores(turn_features):
    """Compute one strategic score per turn.

    Args:
        turn_features: ndarray of shape (N, TURN_FEATURE_DIM).

    Returns: ndarray of shape (N,), one score per turn (signed).
    """
    tf = np.asarray(turn_features, dtype=np.float32)
    net_stone = tf[:, F_NET_STONE_CHANGE]
    enemy_growth = tf[:, F_ENEMY_THREAT_GROWTH]
    own_growth = tf[:, F_OWN_THREAT_GROWTH]
    disrupts = tf[:, F_DISRUPTS_ENEMY_CHAIN]
    new_threats = tf[:, F_NEW_THREATS_TO_US]
    cleared = tf[:, F_CLEARED_ENEMY_THREATS]
    is_dash = tf[:, F_HAS_DASH] > 0.5
    dash_recovers = tf[:, F_DASH_RECOVERS] > 0.5

    score = (
        W_NET_STONE * net_stone
        - W_ENEMY_THREAT_GROWTH * enemy_growth
        + W_OWN_THREAT_GROWTH * own_growth
        + W_DISRUPTS_CHAIN * disrupts
        - W_NEW_THREATS_TO_US * new_threats
        + W_CLEARED_ENEMY_THREATS * cleared
    )
    naked_dash = is_dash & ~dash_recovers
    score -= W_NAKED_DASH * naked_dash.astype(np.float32)
    return score


def adjust_policy(policy, turn_features, alpha=1.0, forbidden_mask=None):
    """Bias `policy` toward strategically better turns.

    Args:
        policy: ndarray (N,) of nonneg priors that sum to 1 (or 0 if all forbidden).
        turn_features: ndarray (N, TURN_FEATURE_DIM).
        alpha: strength of the bias (0 disables).
        forbidden_mask: optional bool array where True = leave at 0.

    Returns: ndarray (N,) of adjusted priors summing to 1.
    """
    if alpha <= 0:
        return policy
    scores = strategic_scores(turn_features)
    # Cap the multiplicative factor to avoid numerical issues and keep
    # the network policy from being completely overridden in extreme
    # cases. exp(±5) ≈ 148× / 1/148× is the cap.
    logits = np.clip(alpha * scores, -5.0, 5.0)
    factor = np.exp(logits)
    if forbidden_mask is not None and forbidden_mask.any():
        factor = factor.copy()
        factor[forbidden_mask] = 0.0
    new = policy * factor
    s = new.sum()
    if s <= 0:
        return policy  # fallback if everything got zeroed
    return new / s
