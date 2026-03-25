"""Feature extraction for SigilNet.

Converts SimBoard states and CompleteTurn actions into tensors.
Extends the patterns from nn_evaluator.py with neighborhood features,
spell ID embeddings, and per-turn action encoding.
"""

import sys
import os
import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from notation import NODE_ORDER, ADJACENCY, POSITIONS
from simboard import CORE_SPELLS, MANA_NODES

from ai.config import (
    NUM_NODES, NUM_SPELL_SLOTS, SPELL_TO_ID,
    RAW_FEATURE_DIM, TURN_FEATURE_DIM,
)

# Precompute neighbor lists as indices for speed
_NODE_TO_IDX = {n: i for i, n in enumerate(NODE_ORDER)}
_NEIGHBOR_INDICES = []
for name in NODE_ORDER:
    _NEIGHBOR_INDICES.append([_NODE_TO_IDX[nb] for nb in ADJACENCY.get(name, [])])


def board_to_tensor(board, side_to_move=None):
    """Convert a SimBoard to (raw_features, spell_ids) tensors.

    Returns:
        raw_features: Tensor of shape (RAW_FEATURE_DIM,)
        spell_ids: LongTensor of shape (9,)
    """
    if side_to_move is None:
        side_to_move = board.whose_turn
    enemy = 'blue' if side_to_move == 'red' else 'red'

    features = []

    # --- Stone placement: 39 × 3 one-hot (own, enemy, empty) = 117 ---
    stones_own = np.zeros(NUM_NODES, dtype=np.float32)
    stones_enemy = np.zeros(NUM_NODES, dtype=np.float32)
    stones_empty = np.zeros(NUM_NODES, dtype=np.float32)

    for i, name in enumerate(NODE_ORDER):
        s = board.stones[name]
        if s == side_to_move:
            stones_own[i] = 1.0
        elif s == enemy:
            stones_enemy[i] = 1.0
        else:
            stones_empty[i] = 1.0

    features.extend(stones_own)
    features.extend(stones_enemy)
    features.extend(stones_empty)

    # --- Neighborhood features: 39 × 2 = 78 ---
    for i in range(NUM_NODES):
        nbs = _NEIGHBOR_INDICES[i]
        n_nbs = len(nbs) if nbs else 1
        own_frac = sum(stones_own[j] for j in nbs) / n_nbs
        enemy_frac = sum(stones_enemy[j] for j in nbs) / n_nbs
        features.append(own_frac)
        features.append(enemy_frac)

    # --- Spell charges: 9 × 3 one-hot = 27 ---
    for i in range(NUM_SPELL_SLOTS):
        spell_name = board.spell_names[i]
        own_charged = spell_name in board.charged_spells[side_to_move]
        enemy_charged = spell_name in board.charged_spells[enemy]
        features.append(1.0 if own_charged else 0.0)
        features.append(1.0 if enemy_charged else 0.0)
        features.append(1.0 if not own_charged and not enemy_charged else 0.0)

    # --- Mana: 3 ---
    for mn in MANA_NODES:
        s = board.stones[mn]
        if s == side_to_move:
            features.append(1.0)
        elif s == enemy:
            features.append(-1.0)
        else:
            features.append(0.0)

    # --- Spell counters: 2 ---
    features.append(board.spell_counter[side_to_move] / 6.0)
    features.append(board.spell_counter[enemy] / 6.0)

    # --- Lock status: 9 × 2 = 18 ---
    own_lock = board.lock[side_to_move]
    enemy_lock = board.lock[enemy]
    for i in range(NUM_SPELL_SLOTS):
        sn = board.spell_names[i]
        features.append(1.0 if own_lock == sn else 0.0)
        features.append(1.0 if enemy_lock == sn else 0.0)

    # --- Stone differential: 1 ---
    own_stones = board.totalstones[side_to_move]
    enemy_stones = board.totalstones[enemy]
    features.append((own_stones - enemy_stones) / 39.0)

    # --- Total stone counts: 2 ---
    features.append(own_stones / 39.0)
    features.append(enemy_stones / 39.0)

    # --- Turn progress: 2 ---
    features.append(board.turn_counter / 200.0)
    features.append(1.0 if board.turn_counter > 100 else 0.0)

    raw = torch.tensor(features, dtype=torch.float32)

    # --- Spell IDs: 9 integers ---
    spell_ids = torch.tensor(
        [SPELL_TO_ID.get(board.spell_names[i], 0) for i in range(NUM_SPELL_SLOTS)],
        dtype=torch.long
    )

    return raw, spell_ids


def encode_turn(turn, board, color):
    """Encode a CompleteTurn as a fixed-size feature vector.

    Returns: Tensor of shape (TURN_FEATURE_DIM,)  [64 features]
    """
    enemy = 'blue' if color == 'red' else 'red'
    features = np.zeros(TURN_FEATURE_DIM, dtype=np.float32)

    # Features layout:
    #  [0:39]  - move target node (one-hot, first move/blink target found)
    #  [39]    - has hard move
    #  [40]    - has blink
    #  [41]    - has dash
    #  [42]    - has cast
    #  [43:58] - spell cast ID (one-hot over 15 spells)
    #  [58]    - number of actions (normalized by 5)
    #  [59]    - estimated stone gain (move to empty = +1, hard move = 0, cast varies)
    #  [60]    - is pass-only turn
    #  [61:64] - reserved (zero)

    move_target = None
    for action in turn.actions:
        if action.type == 'move' and action.node:
            idx = _NODE_TO_IDX.get(action.node)
            if idx is not None and move_target is None:
                features[idx] = 1.0
                move_target = action.node
            # Estimate: soft move gains a stone
            features[59] += 1.0 / 39.0

        elif action.type == 'hard_move' and action.node:
            idx = _NODE_TO_IDX.get(action.node)
            if idx is not None and move_target is None:
                features[idx] = 1.0
                move_target = action.node
            features[39] = 1.0

        elif action.type == 'blink' and action.node:
            idx = _NODE_TO_IDX.get(action.node)
            if idx is not None and move_target is None:
                features[idx] = 1.0
                move_target = action.node
            features[40] = 1.0
            if board.stones.get(action.node) == enemy:
                pass  # push, no net gain
            else:
                features[59] += 1.0 / 39.0

        elif action.type in ('dash', 'dash_lightning'):
            features[41] = 1.0
            sac_count = len(action.sacrificed) if action.sacrificed else 0
            features[59] -= sac_count / 39.0

        elif action.type == 'cast':
            features[42] = 1.0
            spell_id = SPELL_TO_ID.get(action.spell, 0)
            features[43 + spell_id] = 1.0

        elif action.type == 'pass':
            pass

    features[58] = len(turn.actions) / 5.0
    if len(turn.actions) == 1 and turn.actions[0].type == 'pass':
        features[60] = 1.0

    return torch.tensor(features, dtype=torch.float32)


def encode_all_turns(turns, board, color):
    """Encode a list of CompleteTurns into a batch tensor.

    Returns: Tensor of shape (N, TURN_FEATURE_DIM)
    """
    if not turns:
        return torch.zeros(0, TURN_FEATURE_DIM, dtype=torch.float32)
    return torch.stack([encode_turn(t, board, color) for t in turns])
