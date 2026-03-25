"""Monte Carlo Tree Search for Sigil.

Uses PUCT (Predictor + Upper Confidence bounds for Trees) guided by SigilNet.
Integrates directly with SimBoard for legal move generation.
"""

import math
import time
import numpy as np
import torch

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from search import _apply_turn
from ai.features import board_to_tensor, encode_all_turns
from ai.config import (
    C_PUCT, NUM_SIMS_PLAY, NUM_SIMS_TRAIN,
    DIRICHLET_ALPHA, DIRICHLET_EPSILON, TEMP_THRESHOLD, TEMP_PLAY,
)


class MCTSNode:
    """A node in the MCTS search tree."""

    __slots__ = ('board', 'color', 'parent', 'parent_action_idx',
                 'children', 'legal_turns', 'prior', 'visit_count',
                 'total_value', 'is_terminal', 'terminal_value', 'is_expanded')

    def __init__(self, board, color, parent=None, parent_action_idx=None):
        self.board = board
        self.color = color
        self.parent = parent
        self.parent_action_idx = parent_action_idx
        self.children = {}          # action_idx -> MCTSNode
        self.legal_turns = None     # list of CompleteTurn
        self.prior = None           # np.array (num_legal_turns,)
        self.visit_count = None     # np.array (num_legal_turns,)
        self.total_value = None     # np.array (num_legal_turns,)
        self.is_terminal = False
        self.terminal_value = 0.0
        self.is_expanded = False

    @property
    def total_visits(self):
        if self.visit_count is None:
            return 0
        return int(self.visit_count.sum())


def mcts_search(board, color, model, num_simulations=None, time_limit=None,
                add_noise=False, temperature=None):
    """Run MCTS and return the best turn + policy distribution.

    Args:
        board: SimBoard (not mutated)
        color: 'red' or 'blue'
        model: SigilNet (in eval mode)
        num_simulations: number of MCTS simulations (default NUM_SIMS_PLAY)
        time_limit: optional wall-clock limit in seconds
        add_noise: whether to add Dirichlet noise at root (for training)
        temperature: if None, pick greedily; else sample with this temperature

    Returns:
        best_turn: CompleteTurn
        policy: np.array of visit-count-based probabilities over legal turns
        value: float, root value estimate
    """
    if num_simulations is None:
        num_simulations = NUM_SIMS_PLAY

    root = MCTSNode(board.copy(), color)
    _expand_node(root, model)

    if root.is_terminal or root.legal_turns is None or len(root.legal_turns) == 0:
        from simboard import CompleteTurn, Action
        return CompleteTurn([Action('pass')]), np.array([1.0]), 0.0

    # Add Dirichlet noise at root for exploration during training
    if add_noise and root.prior is not None and len(root.prior) > 0:
        noise = np.random.dirichlet([DIRICHLET_ALPHA] * len(root.prior))
        root.prior = (1 - DIRICHLET_EPSILON) * root.prior + DIRICHLET_EPSILON * noise

    deadline = time.time() + time_limit if time_limit else None

    for sim in range(num_simulations):
        if deadline and time.time() > deadline:
            break
        _simulate(root, model)

    # Extract policy from visit counts
    visits = root.visit_count
    total = visits.sum()
    if total == 0:
        policy = np.ones(len(root.legal_turns)) / len(root.legal_turns)
    else:
        policy = visits / total

    # Select action
    if temperature is None or temperature < 0.01:
        action_idx = int(np.argmax(visits))
    else:
        # Temperature-based sampling
        adjusted = visits ** (1.0 / temperature)
        prob = adjusted / adjusted.sum()
        action_idx = np.random.choice(len(root.legal_turns), p=prob)

    # Root value estimate
    if total > 0:
        root_value = root.total_value.sum() / total
    else:
        root_value = 0.0

    return root.legal_turns[action_idx], policy, root_value


def _simulate(root, model):
    """One MCTS simulation: select → expand → backup."""
    node = root
    search_path = []

    # Selection: walk down tree using PUCT
    while node.is_expanded and not node.is_terminal:
        action_idx = _select_action(node)
        search_path.append((node, action_idx))

        if action_idx not in node.children:
            # Create child
            child_board = node.board.copy()
            turn = node.legal_turns[action_idx]
            _apply_turn(child_board, turn, node.color)
            child_board.update()
            child_board.check_game_over(node.color)

            child_color = 'blue' if node.color == 'red' else 'red'
            if not child_board.gameover:
                child_board.advance_turn()

            child = MCTSNode(child_board, child_color, parent=node,
                             parent_action_idx=action_idx)
            node.children[action_idx] = child
            node = child
            break
        else:
            node = node.children[action_idx]

    # Expansion + evaluation
    if node.is_terminal:
        value = node.terminal_value
    elif not node.is_expanded:
        value = _expand_node(node, model)
    else:
        # Fully expanded terminal or value
        value = 0.0

    # Backup: propagate value up the tree
    # Value is from the perspective of node.color
    # We need to negate at each level since players alternate
    for parent_node, action_idx in reversed(search_path):
        # Value needs to be from parent's perspective
        # If parent.color != node.color at leaf, negate appropriately
        if parent_node.color != node.color:
            parent_value = -value
        else:
            parent_value = value

        parent_node.visit_count[action_idx] += 1
        parent_node.total_value[action_idx] += parent_value

        # For the next level up, the value perspective changes
        # Actually, let's track correctly: each backup step just negates
        value = -value  # flip for opponent's perspective


def _select_action(node):
    """Select action using PUCT formula."""
    total_n = node.total_visits
    sqrt_total = math.sqrt(total_n) if total_n > 0 else 1.0

    n = node.visit_count
    with np.errstate(divide='ignore', invalid='ignore'):
        q = np.where(n > 0, node.total_value / n, 0.0)
    u = C_PUCT * node.prior * sqrt_total / (1.0 + n)

    scores = q + u
    return int(np.argmax(scores))


def _expand_node(node, model):
    """Expand a leaf node: enumerate legal turns, get NN evaluation.

    Returns: value estimate from current player's perspective.
    """
    board = node.board

    # Check terminal
    if board.gameover:
        node.is_terminal = True
        node.is_expanded = True
        if board.winner == node.color:
            node.terminal_value = 1.0
        elif board.winner is not None:
            node.terminal_value = -1.0
        else:
            node.terminal_value = 0.0
        return node.terminal_value

    # Enumerate legal turns
    node.legal_turns = list(board.get_legal_turns(node.color))

    if not node.legal_turns:
        node.is_terminal = True
        node.is_expanded = True
        node.terminal_value = 0.0
        return 0.0

    n_turns = len(node.legal_turns)
    node.visit_count = np.zeros(n_turns, dtype=np.float32)
    node.total_value = np.zeros(n_turns, dtype=np.float32)

    # Get NN evaluation
    raw, spell_ids = board_to_tensor(board, node.color)
    turn_feats = encode_all_turns(node.legal_turns, board, node.color)

    value, policy = model.evaluate_with_policy(raw, spell_ids, turn_feats)
    node.prior = policy
    node.is_expanded = True

    return value
