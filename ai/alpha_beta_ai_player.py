"""Alpha-beta minimax AI for Sigil using SigilNet as evaluator.

Two variants:
  - `pick_alpha_beta_turn`: reuses `search.iterative_deepening_search`
    with SigilNet's value head for leaf eval and child-eval-based ordering.
  - `pick_policy_ordered_turn`: variant that uses SigilNet's policy head
    for move ordering, which keeps the search on-distribution and lets
    deeper search compose better with a learned evaluator.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

from ai.features import board_to_tensor, encode_all_turns
from ai.sigil_net import SigilNet
from ai.config import MODELS_DIR
from ai.search import iterative_deepening_search, _apply_turn


_MEDIUM_MODEL = os.path.join(MODELS_DIR, 'best_model.pt')


class SigilNetEvaluator:
    """SigilNet adapter for alpha-beta search.

    Exposes:
      - `evaluate(board, color)`: value-only, returns float in [0, 1]
        (interface expected by `search.alpha_beta`).
      - `score_position(board, color, legal_turns)`: single forward pass
        returning `(value_in_0_1, policy_np)` from `color`'s perspective.
        Used by the policy-ordered variant.
    """

    def __init__(self, sigil_net):
        self.net = sigil_net
        self.net.eval()

    def evaluate(self, board, color=None):
        if color is None:
            color = board.whose_turn
        raw, spell_ids = board_to_tensor(board, side_to_move=color)
        value = self.net.evaluate(raw, spell_ids)
        return float((value + 1.0) / 2.0)

    def score_position(self, board, color, legal_turns):
        raw, spell_ids = board_to_tensor(board, side_to_move=color)
        turn_feats = encode_all_turns(legal_turns, board, color)
        value, policy = self.net.evaluate_with_policy(raw, spell_ids, turn_feats)
        return float((value + 1.0) / 2.0), policy


def load_default_evaluator(model_path=None):
    """Load the production SigilNet checkpoint and wrap it for alpha-beta."""
    path = model_path or _MEDIUM_MODEL
    net = SigilNet.load(path)
    net.eval()
    return SigilNetEvaluator(net)


def pick_alpha_beta_turn(board, color, evaluator, depth=2, time_limit=8.0):
    """Run iterative-deepening alpha-beta and return the best CompleteTurn."""
    _, best_turn = iterative_deepening_search(
        board, color, evaluator,
        max_depth=depth, time_limit=time_limit,
    )
    return best_turn


# ---- Policy-ordered alpha-beta ----

def _terminal_score(board, maximizing_color):
    if board.winner == maximizing_color:
        return 1.0
    if board.winner is not None:
        return 0.0
    return 0.5


def _alpha_beta_policy(board, depth, alpha, beta, maximizing_color,
                      evaluator, deadline):
    """Alpha-beta with SigilNet policy-based move ordering.

    At each non-terminal node, do one forward pass to get (value, policy)
    for the current board and all legal turns. Use policy for ordering
    and the value as the leaf evaluation when depth == 0.

    Both value and policy come from `color`'s (= side-to-move's) perspective;
    the value is converted to maximizing_color's perspective when used as
    a leaf score.
    """
    if deadline and time.time() > deadline:
        return evaluator.evaluate(board, maximizing_color), None

    if board.gameover:
        return _terminal_score(board, maximizing_color), None

    color = board.whose_turn
    legal_turns = list(board.get_legal_turns(color))
    if not legal_turns:
        return evaluator.evaluate(board, maximizing_color), None

    value_for_color, policy = evaluator.score_position(board, color, legal_turns)

    if depth == 0:
        leaf_value = value_for_color if color == maximizing_color else (
            1.0 - value_for_color)
        return leaf_value, None

    sorted_indices = np.argsort(-policy)
    is_maximizing = (color == maximizing_color)
    best_turn = legal_turns[int(sorted_indices[0])]

    if is_maximizing:
        max_eval = -float('inf')
        for idx in sorted_indices:
            if deadline and time.time() > deadline:
                break
            turn = legal_turns[int(idx)]
            child = board.copy()
            _apply_turn(child, turn, color)
            child.update()

            if child.gameover:
                eval_score = _terminal_score(child, maximizing_color)
            else:
                child.advance_turn()
                eval_score, _ = _alpha_beta_policy(
                    child, depth - 1, alpha, beta,
                    maximizing_color, evaluator, deadline)

            if eval_score > max_eval:
                max_eval = eval_score
                best_turn = turn
            alpha = max(alpha, eval_score)
            if beta <= alpha:
                break
        return max_eval, best_turn
    else:
        min_eval = float('inf')
        for idx in sorted_indices:
            if deadline and time.time() > deadline:
                break
            turn = legal_turns[int(idx)]
            child = board.copy()
            _apply_turn(child, turn, color)
            child.update()

            if child.gameover:
                eval_score = _terminal_score(child, maximizing_color)
            else:
                child.advance_turn()
                eval_score, _ = _alpha_beta_policy(
                    child, depth - 1, alpha, beta,
                    maximizing_color, evaluator, deadline)

            if eval_score < min_eval:
                min_eval = eval_score
                best_turn = turn
            beta = min(beta, eval_score)
            if beta <= alpha:
                break
        return min_eval, best_turn


def pick_policy_ordered_turn(board, color, evaluator, depth=4, time_limit=10.0):
    """Iterative-deepening alpha-beta with SigilNet policy-based ordering."""
    deadline = time.time() + time_limit
    best_turn = None

    for d in range(1, depth + 1):
        if time.time() > deadline:
            break
        _, turn = _alpha_beta_policy(
            board, d, -float('inf'), float('inf'),
            color, evaluator, deadline)
        if turn is not None:
            best_turn = turn

    return best_turn
