"""Feature extraction for SigilNet.

Converts SimBoard states and CompleteTurn actions into tensors.
Extends the patterns from nn_evaluator.py with neighborhood features,
spell ID embeddings, per-turn action encoding, and strategic features
informed by published strategy articles (mana influence, group connectivity,
surrounding, territory control, spell threat estimation).
"""

import sys
import os
from collections import deque
import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from notation import NODE_ORDER, ADJACENCY, POSITIONS
from simboard import CORE_SPELLS, MANA_NODES

from ai.config import (
    NUM_NODES, NUM_SPELL_SLOTS, NUM_SPELL_POSITIONS, SPELL_TO_ID,
    RAW_FEATURE_DIM, TURN_FEATURE_DIM,
)

# Precompute neighbor lists as indices for speed
_NODE_TO_IDX = {n: i for i, n in enumerate(NODE_ORDER)}
_NEIGHBOR_INDICES = []
for name in NODE_ORDER:
    _NEIGHBOR_INDICES.append([_NODE_TO_IDX[nb] for nb in ADJACENCY.get(name, [])])

# Precompute which spell position each node belongs to (0 = none)
_NODE_SPELL_POS = {}
for pos_idx, nodes in POSITIONS.items():
    for n in nodes:
        _NODE_SPELL_POS[n] = pos_idx

# Precompute which nodes are adjacent to mana nodes
_MANA_ADJACENT = set()
for mn in MANA_NODES:
    for nb in ADJACENCY.get(mn, []):
        _MANA_ADJACENT.add(nb)

# Max BFS distance on the 39-node graph (for normalization)
_MAX_DIST = 12.0


def _bfs_min_distance(board, start_node, target_color):
    """BFS from start_node, return distance to nearest stone of target_color.

    Returns _MAX_DIST if no stone of target_color is reachable.
    """
    if board.stones[start_node] == target_color:
        return 0.0
    visited = {start_node}
    queue = deque()
    for nb in ADJACENCY.get(start_node, []):
        queue.append((nb, 1))
        visited.add(nb)
    while queue:
        node, dist = queue.popleft()
        if board.stones[node] == target_color:
            return float(dist)
        for nb in ADJACENCY.get(node, []):
            if nb not in visited:
                visited.add(nb)
                queue.append((nb, dist + 1))
    return _MAX_DIST


def _count_connected_groups(stones_arr, neighbor_indices):
    """Count connected groups and return (num_groups, largest_group_size)."""
    visited = set()
    num_groups = 0
    largest = 0
    for i in range(len(stones_arr)):
        if stones_arr[i] == 0.0 or i in visited:
            continue
        # BFS flood fill
        num_groups += 1
        group_size = 0
        stack = [i]
        while stack:
            node = stack.pop()
            if node in visited:
                continue
            visited.add(node)
            if stones_arr[node] == 0.0:
                continue
            group_size += 1
            for nb in neighbor_indices[node]:
                if nb not in visited and stones_arr[nb] > 0:
                    stack.append(nb)
        largest = max(largest, group_size)
    return num_groups, largest


def _estimate_spell_potency(board, spell_name, color):
    """Estimate net stone gain if spell_name were cast now by color.

    Returns a rough estimate normalized by ~10 (max plausible gain).
    Positive = good for caster.
    """
    enemy = 'blue' if color == 'red' else 'red'
    info = CORE_SPELLS.get(spell_name)
    if info is None or info['resolve'] is None:
        return 0.0

    resolve_type = info['resolve']
    # Cost: sacrifice spell position stones, refill by mana
    spell_idx = board.spell_names.index(spell_name) if spell_name in board.spell_names else -1
    if spell_idx < 0:
        return 0.0
    pos_idx = spell_idx + 1
    pos_nodes = POSITIONS[pos_idx]
    num_sacrificed = len(pos_nodes)
    refill = board.mana[color] if not info['ischarm'] else 0
    cost = num_sacrificed - refill  # net stones lost from sacrifice

    gain = 0.0
    if resolve_type == 'soft_moves':
        gain = info['count']  # each soft move places a stone
    elif resolve_type == 'hard_moves':
        gain = 0.0  # hard moves are pushes, no net gain
    elif resolve_type == 'fireblast':
        # Count enemy stones adjacent to any own stone
        for name in NODE_ORDER:
            if board.stones[name] == enemy:
                for nb in ADJACENCY.get(name, []):
                    if board.stones[nb] == color:
                        gain += 1.0
                        break
    elif resolve_type == 'hail_storm':
        for pos_i in range(1, 7):
            nodes = POSITIONS[pos_i]
            for n in nodes:
                if board.stones[n] == enemy:
                    gain += 1.0
                    break
    elif resolve_type == 'bewitch':
        gain = 4.0  # converts 2 enemy to own = +4 swing
    elif resolve_type == 'starfall':
        gain = 2.0  # places 2 stones + destroys adjacent enemies
        # Count best adjacent enemy destruction
        best_destroy = 0
        for name in NODE_ORDER:
            if board.stones[name] is not None:
                continue
            for nb_name in ADJACENCY.get(name, []):
                if board.stones[nb_name] is not None:
                    continue
                neighbors_union = set(ADJACENCY.get(name, [])) | set(ADJACENCY.get(nb_name, []))
                enemy_count = sum(1 for n in neighbors_union if board.stones[n] == enemy)
                best_destroy = max(best_destroy, enemy_count)
        gain += best_destroy
    elif resolve_type == 'meteor':
        gain = 1.0  # blink + destroy 1
    elif resolve_type == 'comet':
        gain = 0.0  # blink but sacrifice 1
        cost += 1
    elif resolve_type == 'surge_move':
        gain = 1.0

    net = (gain - cost) / 10.0
    return max(-1.0, min(1.0, net))


def board_to_tensor(board, side_to_move=None):
    """Convert a SimBoard to (raw_features, spell_ids) tensors.

    Returns:
        raw_features: Tensor of shape (RAW_FEATURE_DIM,)  [294 features]
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

    # ==================================================================
    # STRATEGIC FEATURES (44 new features)
    # Informed by published strategy articles from pineislandgames.com
    # ==================================================================

    # --- Mana influence: 3 × 2 = 6 ---
    # BFS distance from each mana node to nearest own/enemy stone
    for mn in MANA_NODES:
        own_dist = _bfs_min_distance(board, mn, side_to_move) / _MAX_DIST
        enemy_dist = _bfs_min_distance(board, mn, enemy) / _MAX_DIST
        features.append(own_dist)
        features.append(enemy_dist)

    # --- Group connectivity & surround: 13 ---
    own_groups, own_largest = _count_connected_groups(stones_own, _NEIGHBOR_INDICES)
    enemy_groups, enemy_largest = _count_connected_groups(stones_enemy, _NEIGHBOR_INDICES)
    own_total = max(own_stones, 1)
    enemy_total = max(enemy_stones, 1)

    features.append(own_groups / 10.0)
    features.append(enemy_groups / 10.0)
    features.append(own_largest / own_total)
    features.append(enemy_largest / enemy_total)

    # Surround detection: count stones with 0 or 1 empty neighbors
    own_surrounded = 0   # 0 empty neighbors
    own_nearly = 0       # 1 empty neighbor
    enemy_surrounded = 0
    enemy_nearly = 0
    own_dead = 0         # own stones fully encircled by enemy
    enemy_dead = 0
    own_perimeter = 0    # own stones adjacent to empty/enemy
    enemy_perimeter = 0
    surround_pressure = 0.0  # sum over enemy stones of own-neighbor fraction

    for i in range(NUM_NODES):
        nbs = _NEIGHBOR_INDICES[i]
        if not nbs:
            continue
        n_nbs = len(nbs)
        empty_count = sum(1 for j in nbs if stones_empty[j] > 0)
        own_nb = sum(1 for j in nbs if stones_own[j] > 0)
        enemy_nb = sum(1 for j in nbs if stones_enemy[j] > 0)

        if stones_own[i] > 0:
            if empty_count == 0:
                own_surrounded += 1
                if enemy_nb == n_nbs:
                    own_dead += 1
            elif empty_count == 1:
                own_nearly += 1
            if empty_count > 0 or enemy_nb > 0:
                own_perimeter += 1

        if stones_enemy[i] > 0:
            if empty_count == 0:
                enemy_surrounded += 1
                if own_nb == n_nbs:
                    enemy_dead += 1
            elif empty_count == 1:
                enemy_nearly += 1
            if empty_count > 0 or own_nb > 0:
                enemy_perimeter += 1
            surround_pressure += own_nb / n_nbs

    features.append(own_surrounded / own_total)
    features.append(own_nearly / own_total)
    features.append(enemy_surrounded / enemy_total)
    features.append(enemy_nearly / enemy_total)
    features.append(own_dead / own_total)
    features.append(enemy_dead / enemy_total)
    features.append(own_perimeter / own_total)
    features.append(enemy_perimeter / enemy_total)
    features.append(surround_pressure / enemy_total)

    # --- Territory / spell position control: 9 + 3 = 12 ---
    mana_adj_control = 0.0
    non_mana_control = 0.0
    charm_control = 0.0
    for pos_idx in range(1, NUM_SPELL_POSITIONS + 1):
        pos_nodes = POSITIONS[pos_idx]
        n_pos = len(pos_nodes)
        own_in_pos = sum(1 for n in pos_nodes if board.stones[n] == side_to_move)
        features.append(own_in_pos / n_pos)
        # Aggregate by position type
        is_mana_adj = any(n in _MANA_ADJACENT or n in MANA_NODES for n in pos_nodes)
        if n_pos == 1:
            charm_control += own_in_pos / n_pos
        elif is_mana_adj:
            mana_adj_control += own_in_pos / n_pos
        else:
            non_mana_control += own_in_pos / n_pos
    features.append(mana_adj_control / 3.0)  # normalize by max possible
    features.append(non_mana_control / 3.0)
    features.append(charm_control / 3.0)

    # --- Spell threat / potency: 9 ---
    for i in range(NUM_SPELL_SLOTS):
        spell_name = board.spell_names[i]
        own_charged = spell_name in board.charged_spells[side_to_move]
        enemy_charged = spell_name in board.charged_spells[enemy]
        if own_charged:
            features.append(_estimate_spell_potency(board, spell_name, side_to_move))
        elif enemy_charged:
            features.append(-_estimate_spell_potency(board, spell_name, enemy))
        else:
            features.append(0.0)

    # --- Scaling spell value: 4 ---
    # Fireblast potential: enemy stones adjacent to own stones
    fireblast_potential = 0
    for name in NODE_ORDER:
        if board.stones[name] == enemy:
            for nb in ADJACENCY.get(name, []):
                if board.stones[nb] == side_to_move:
                    fireblast_potential += 1
                    break
    features.append(fireblast_potential / 10.0)

    # Hailstorm potential: first enemy stone in each sorcery position
    hailstorm_potential = 0
    for pos_i in range(1, 7):
        for n in POSITIONS[pos_i]:
            if board.stones[n] == enemy:
                hailstorm_potential += 1
                break
    features.append(hailstorm_potential / 6.0)

    # Bewitch potential: count adjacent enemy-enemy pairs
    bewitch_potential = 0
    seen_pairs = set()
    for name in NODE_ORDER:
        if board.stones[name] == enemy:
            for nb in ADJACENCY.get(name, []):
                if board.stones[nb] == enemy:
                    pair = tuple(sorted([name, nb]))
                    if pair not in seen_pairs:
                        seen_pairs.add(pair)
                        bewitch_potential += 1
    features.append(bewitch_potential / 10.0)

    # Starfall potential: best pair of adjacent empty nodes by enemy neighbor count
    starfall_potential = 0
    for name in NODE_ORDER:
        if board.stones[name] is not None:
            continue
        for nb_name in ADJACENCY.get(name, []):
            if board.stones[nb_name] is not None:
                continue
            neighbors_union = set(ADJACENCY.get(name, [])) | set(ADJACENCY.get(nb_name, []))
            enemy_count = sum(1 for n in neighbors_union if board.stones[n] == enemy)
            starfall_potential = max(starfall_potential, enemy_count)
    features.append(starfall_potential / 6.0)

    raw = torch.tensor(features, dtype=torch.float32)

    # --- Spell IDs: 9 integers ---
    spell_ids = torch.tensor(
        [SPELL_TO_ID.get(board.spell_names[i], 0) for i in range(NUM_SPELL_SLOTS)],
        dtype=torch.long
    )

    return raw, spell_ids


def encode_turn(turn, board, color):
    """Encode a CompleteTurn as a fixed-size feature vector.

    Returns: Tensor of shape (TURN_FEATURE_DIM,)  [80 features]
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
    #  [61]    - target is mana node
    #  [62:71] - target is in spell position 1-9 (one-hot)
    #  [71]    - target borders mana node
    #  [72]    - cast: estimated net stone gain from spell effect
    #  [73]    - cast: enemy stones affected by spell
    #  [74]    - cast: is scaling spell (Fireblast/Hailstorm) at high value
    #  [75:80] - reserved (zero)

    move_target = None
    cast_spell_name = None
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
            cast_spell_name = action.spell

        elif action.type == 'pass':
            pass

    features[58] = len(turn.actions) / 5.0
    if len(turn.actions) == 1 and turn.actions[0].type == 'pass':
        features[60] = 1.0

    # --- Strategic turn features (indices 61-74) ---

    # Mana and spell position targeting
    if move_target is not None:
        # Target is mana node
        if move_target in MANA_NODES:
            features[61] = 1.0
        # Target is in spell position
        sp = _NODE_SPELL_POS.get(move_target, 0)
        if 1 <= sp <= 9:
            features[62 + sp - 1] = 1.0
        # Target borders mana node
        if move_target in _MANA_ADJACENT:
            features[71] = 1.0

    # Spell cast quality estimation
    if cast_spell_name is not None:
        # Net stone gain from spell
        potency = _estimate_spell_potency(board, cast_spell_name, color)
        features[72] = potency

        # Enemy stones affected
        info = CORE_SPELLS.get(cast_spell_name)
        if info:
            resolve_type = info['resolve']
            affected = 0.0
            if resolve_type == 'fireblast':
                for name in NODE_ORDER:
                    if board.stones[name] == enemy:
                        for nb in ADJACENCY.get(name, []):
                            if board.stones[nb] == color:
                                affected += 1
                                break
            elif resolve_type == 'hail_storm':
                for pos_i in range(1, 7):
                    for n in POSITIONS[pos_i]:
                        if board.stones[n] == enemy:
                            affected += 1
                            break
            elif resolve_type == 'bewitch':
                affected = 2.0
            features[73] = affected / 10.0

            # Is scaling spell at high value
            if resolve_type in ('fireblast', 'hail_storm') and affected >= 3:
                features[74] = 1.0

    return torch.tensor(features, dtype=torch.float32)


def encode_all_turns(turns, board, color):
    """Encode a list of CompleteTurns into a batch tensor.

    Returns: Tensor of shape (N, TURN_FEATURE_DIM)
    """
    if not turns:
        return torch.zeros(0, TURN_FEATURE_DIM, dtype=torch.float32)
    return torch.stack([encode_turn(t, board, color) for t in turns])
