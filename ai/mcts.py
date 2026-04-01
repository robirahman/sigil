"""Monte Carlo Tree Search for Sigil.

Uses PUCT (Predictor + Upper Confidence bounds for Trees) guided by SigilNet.
Supports batched leaf evaluation with virtual loss for faster NN throughput.
"""

import math
import time
import numpy as np
import torch
import torch.nn.functional as F

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from search import _apply_turn
from ai.features import board_to_tensor, encode_all_turns
from ai.config import (
    C_PUCT, NUM_SIMS_PLAY, NUM_SIMS_TRAIN,
    DIRICHLET_ALPHA, DIRICHLET_EPSILON, TEMP_THRESHOLD, TEMP_PLAY,
    MCTS_BATCH_SIZE, FPU_REDUCTION,
)


class MCTSNode:
    """A node in the MCTS search tree."""

    __slots__ = ('board', 'color', 'parent', 'parent_action_idx',
                 'children', 'legal_turns', 'prior', 'visit_count',
                 'total_value', 'virtual_loss',
                 'is_terminal', 'terminal_value', 'is_expanded')

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
        self.virtual_loss = None    # np.array (num_legal_turns,)
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
    """Run MCTS with batched leaf evaluation and return best turn + policy.

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

    # Batched simulation loop
    sims_done = 0
    while sims_done < num_simulations:
        if deadline and time.time() > deadline:
            break

        batch_size = min(MCTS_BATCH_SIZE, num_simulations - sims_done)
        _simulate_batch(root, model, batch_size)
        sims_done += batch_size

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


def _simulate_batch(root, model, batch_size):
    """Run batch_size MCTS simulations with batched leaf NN evaluation.

    Uses virtual loss to encourage different simulations to explore
    different branches of the tree.
    """
    # Phase 1: Collect leaves by running tree traversals with virtual loss
    leaves = []  # list of (node, search_path, is_terminal)

    for _ in range(batch_size):
        node = root
        search_path = []

        # Selection: walk down tree using PUCT (virtual loss biases away from in-flight edges)
        while node.is_expanded and not node.is_terminal:
            action_idx = _select_action(node)
            search_path.append((node, action_idx))

            # Apply virtual loss to discourage other traversals from this edge
            node.virtual_loss[action_idx] += 1

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

        leaves.append((node, search_path))

    # Phase 2: Batch-evaluate all unexpanded, non-terminal leaves
    needs_eval = []  # indices into leaves that need NN evaluation
    eval_inputs = []  # (raw, spell_ids, turn_feats) for each

    for i, (node, search_path) in enumerate(leaves):
        if node.is_terminal:
            continue
        if node.is_expanded:
            continue

        # Prepare for expansion
        board = node.board
        if board.gameover:
            node.is_terminal = True
            node.is_expanded = True
            if board.winner == node.color:
                node.terminal_value = 1.0
            elif board.winner is not None:
                node.terminal_value = -1.0
            else:
                node.terminal_value = 0.0
            continue

        node.legal_turns = list(board.get_legal_turns(node.color))
        if not node.legal_turns:
            node.is_terminal = True
            node.is_expanded = True
            node.terminal_value = 0.0
            continue

        n_turns = len(node.legal_turns)
        node.visit_count = np.zeros(n_turns, dtype=np.float32)
        node.total_value = np.zeros(n_turns, dtype=np.float32)
        node.virtual_loss = np.zeros(n_turns, dtype=np.float32)

        raw, spell_ids = board_to_tensor(board, node.color)
        turn_feats = encode_all_turns(node.legal_turns, board, node.color)

        needs_eval.append(i)
        eval_inputs.append((raw, spell_ids, turn_feats))

    # Batch NN evaluation
    if len(eval_inputs) == 1:
        # Single leaf — use the regular (non-batched) method
        raw, spell_ids, turn_feats = eval_inputs[0]
        value, policy = model.evaluate_with_policy(raw, spell_ids, turn_feats)
        eval_results = [(value, policy)]
    elif len(eval_inputs) > 1:
        eval_results = _batch_evaluate(model, eval_inputs)
    else:
        eval_results = []

    # Apply NN results to leaves and store value for backup
    leaf_values = [0.0] * len(leaves)

    for idx_in_eval, leaf_idx in enumerate(needs_eval):
        node = leaves[leaf_idx][0]
        value, policy = eval_results[idx_in_eval]
        node.prior = policy
        node.is_expanded = True
        leaf_values[leaf_idx] = value

    # Set values for terminal/already-expanded leaves
    needs_eval_set = set(needs_eval)
    for i, (node, search_path) in enumerate(leaves):
        if i not in needs_eval_set:
            if node.is_terminal:
                leaf_values[i] = node.terminal_value

    # Phase 3: Backup all leaves and remove virtual losses
    for i, (node, search_path) in enumerate(leaves):
        value = leaf_values[i]

        # Backup: propagate value up the tree and remove virtual loss
        for parent_node, action_idx in reversed(search_path):
            if parent_node.color != node.color:
                parent_value = -value
            else:
                parent_value = value

            parent_node.visit_count[action_idx] += 1
            parent_node.total_value[action_idx] += parent_value
            parent_node.virtual_loss[action_idx] -= 1

            value = -value


def _batch_evaluate(model, eval_inputs):
    """Evaluate multiple positions in a single batched NN forward pass.

    Args:
        model: SigilNet or SigilNetHard
        eval_inputs: list of (raw_features, spell_ids, turn_features) tensors

    Returns: list of (value: float, policy: np.array) tuples
    """
    from ai.config import TURN_FEATURE_DIM

    B = len(eval_inputs)
    raw_batch = torch.stack([inp[0] for inp in eval_inputs])
    spell_batch = torch.stack([inp[1] for inp in eval_inputs])

    # Pad turn features to max length in the batch
    turn_counts = [inp[2].size(0) for inp in eval_inputs]
    max_turns = max(turn_counts)
    turn_batch = torch.zeros(B, max_turns, TURN_FEATURE_DIM)
    for i, inp in enumerate(eval_inputs):
        n = turn_counts[i]
        turn_batch[i, :n] = inp[2]
    turn_counts_t = torch.tensor(turn_counts, dtype=torch.long)

    with torch.no_grad():
        values, logits = model.forward(raw_batch, spell_batch, turn_batch, turn_counts_t)

    results = []
    for i in range(B):
        v = values[i].item()
        n = turn_counts[i]
        turn_logits = logits[i, :n]
        policy = F.softmax(turn_logits, dim=0).cpu().numpy()
        results.append((v, policy))

    return results


def _select_action(node):
    """Select action using PUCT formula with virtual loss and FPU reduction."""
    total_n = node.total_visits
    sqrt_total = math.sqrt(total_n) if total_n > 0 else 1.0

    n = node.visit_count
    vl = node.virtual_loss

    # Compute parent value for FPU (First Play Urgency)
    if total_n > 0:
        parent_q = node.total_value.sum() / total_n
    else:
        parent_q = 0.0
    fpu_value = parent_q - FPU_REDUCTION

    # Virtual loss: treat in-flight edges as if they returned a loss
    effective_n = n + vl
    with np.errstate(divide='ignore', invalid='ignore'):
        q = np.where(effective_n > 0, (node.total_value - vl) / effective_n, fpu_value)
    u = C_PUCT * node.prior * sqrt_total / (1.0 + effective_n)

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
    node.virtual_loss = np.zeros(n_turns, dtype=np.float32)

    # Get NN evaluation
    raw, spell_ids = board_to_tensor(board, node.color)
    turn_feats = encode_all_turns(node.legal_turns, board, node.color)

    value, policy = model.evaluate_with_policy(raw, spell_ids, turn_feats)
    node.prior = policy
    node.is_expanded = True

    return value
