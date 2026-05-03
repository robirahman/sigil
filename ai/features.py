"""Feature extraction for SigilNet.

Converts SimBoard states and CompleteTurn actions into tensors.

The feature vector is split into a "base" block (stones, neighborhood,
spell charges, mana, locks, counters) and tactical blocks added in the
v22 rework:

  - per-stone life-status (escape_distance and crushable_now for both
    sides) — gives the network a Go-like "liberty" signal so it can
    distinguish stones about to be crushed from stones safe in the rear.
  - spell-position fill counts and "threat of activation" features —
    encode which spells are close to castable and what casting them
    right now would do (net stone change). This is what lets the
    network reason about tempo and held threats.

Per-turn encoding gets extra tactical fields too (e.g. how many enemy
stones a turn crushes, whether a dash recovers material) — see
encode_turn() below.
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

# Spell positions are 1-indexed in POSITIONS (POSITIONS[1] = slot 0's nodes).
_SPELL_POSITION_NODES = [POSITIONS[i + 1] for i in range(NUM_SPELL_SLOTS)]
ESCAPE_MAX = 6  # Cap for escape_distance feature (matches simboard default)


def _life_status_features(board, side_to_move, enemy):
    """Per-node life-status block: 4 channels × NUM_NODES = 156 dims.

    Channels:
      0. own_escape: escape_distance / ESCAPE_MAX for our stones (else 0)
      1. enemy_escape: escape_distance / ESCAPE_MAX for enemy stones (else 0)
      2. own_crushable_now: 1.0 for our stones the enemy can crush this turn
      3. enemy_crushable_now: 1.0 for enemy stones we can crush this turn

    "Crushable now" requires both that a hard-move into the node would
    crush (no escape route) and that the attacker has a stone adjacent
    to the node so the move is legal.
    """
    own_escape = np.zeros(NUM_NODES, dtype=np.float32)
    enemy_escape = np.zeros(NUM_NODES, dtype=np.float32)
    own_crushable = np.zeros(NUM_NODES, dtype=np.float32)
    enemy_crushable = np.zeros(NUM_NODES, dtype=np.float32)

    for i, name in enumerate(NODE_ORDER):
        s = board.stones[name]
        if s == side_to_move:
            d = board.escape_distance(name, side_to_move, max_dist=ESCAPE_MAX)
            own_escape[i] = d / ESCAPE_MAX
            # Crushable now: enemy has a neighboring stone AND escape fails.
            has_attacker_neighbor = any(
                board.stones[nb] == enemy
                for nb in board._adjacent_nodes(name)
            )
            if has_attacker_neighbor and board.is_crushable(name, enemy):
                own_crushable[i] = 1.0
        elif s == enemy:
            d = board.escape_distance(name, enemy, max_dist=ESCAPE_MAX)
            enemy_escape[i] = d / ESCAPE_MAX
            has_our_neighbor = any(
                board.stones[nb] == side_to_move
                for nb in board._adjacent_nodes(name)
            )
            if has_our_neighbor and board.is_crushable(name, side_to_move):
                enemy_crushable[i] = 1.0
    return own_escape, enemy_escape, own_crushable, enemy_crushable


def _spell_fill_features(board, side_to_move, enemy):
    """Per-spell fill block: 9 × 2 = 18 dims.

    For each spell slot, normalized counts of own and enemy stones in
    that slot's position nodes. Captures "how close to castable" without
    needing the full mana / lock / charm tempo model.
    """
    own = np.zeros(NUM_SPELL_SLOTS, dtype=np.float32)
    enm = np.zeros(NUM_SPELL_SLOTS, dtype=np.float32)
    for i, nodes in enumerate(_SPELL_POSITION_NODES):
        if not nodes:
            continue
        n_own = sum(1 for n in nodes if board.stones[n] == side_to_move)
        n_enm = sum(1 for n in nodes if board.stones[n] == enemy)
        own[i] = n_own / len(nodes)
        enm[i] = n_enm / len(nodes)
    return own, enm


def _threat_of_activation_features(board, side_to_move, enemy):
    """Per-spell hypothetical-cast block: 9 × 2 = 18 dims.

    For each spell currently in our charged-spells list, simulate a
    cast in a copied board and report (own_stones_after - own_before)
    minus (enemy_stones_after - enemy_before), normalized by NUM_NODES.
    A high positive value means casting now would be devastating against
    the enemy (= strong "threat of activation" lever); a negative value
    means casting now is bad for us. Same computation mirrored for the
    enemy's charged spells.

    Spells that aren't currently charged contribute 0.
    """
    own = np.zeros(NUM_SPELL_SLOTS, dtype=np.float32)
    enm = np.zeros(NUM_SPELL_SLOTS, dtype=np.float32)

    own_charged = set(board.charged_spells.get(side_to_move, []))
    enm_charged = set(board.charged_spells.get(enemy, []))

    for i, sn in enumerate(board.spell_names):
        if sn in own_charged:
            own[i] = _net_stone_delta_if_cast(board, sn, side_to_move)
        if sn in enm_charged:
            enm[i] = _net_stone_delta_if_cast(board, sn, enemy)
    return own, enm


def _net_stone_delta_if_cast(board, spell_name, color):
    """Approximate (own_after - enemy_after) - (own_before - enemy_before),
    normalized by NUM_NODES, if `color` were to cast `spell_name` right now.
    Uses a copy of the board so callers stay non-mutating.
    """
    enemy = 'blue' if color == 'red' else 'red'
    own_before = board.totalstones[color]
    enm_before = board.totalstones[enemy]
    sim = board.copy()
    try:
        sim._cast_spell(spell_name, color)
        sim.update()
    except Exception:
        # If the cast can't be resolved cleanly (e.g. preconditions not
        # satisfied in this state), report 0 — better than NaN-poisoning
        # the feature vector.
        return 0.0
    own_after = sim.totalstones[color]
    enm_after = sim.totalstones[enemy]
    delta_us = own_after - own_before
    delta_them = enm_after - enm_before
    return float((delta_us - delta_them) / NUM_NODES)


def _tempo_scalar_features(board, side_to_move, enemy,
                           own_escape, enemy_escape,
                           own_fill, enm_fill,
                           own_threat, enm_threat):
    """8-dim scalar block summarizing tempo and pressure.

    These are simple aggregates that the network would otherwise have
    to derive from per-node features at every layer; surfacing them
    once at the input is cheap.
    """
    own_can_cast = float(np.sum(own_fill >= 0.999))   # near-full positions
    enm_can_cast = float(np.sum(enm_fill >= 0.999))
    return np.array([
        own_can_cast / NUM_SPELL_SLOTS,
        enm_can_cast / NUM_SPELL_SLOTS,
        (board.mana[side_to_move] - board.mana[enemy]) / 3.0,
        float(np.sum(own_escape) / NUM_NODES),     # average own fragility
        float(np.sum(enemy_escape) / NUM_NODES),   # average enemy fragility
        float(np.max(own_threat, initial=0.0)),    # best held threat we have
        float(np.max(enm_threat, initial=0.0)),    # best held threat against us
        # Net "spell race" hint: count of slots where we have more stones
        float(np.sum((own_fill > enm_fill).astype(np.float32))) / NUM_SPELL_SLOTS,
    ], dtype=np.float32)


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

    # === Tactical blocks (added in v22) ===

    own_escape, enemy_escape, own_crush, enemy_crush = _life_status_features(
        board, side_to_move, enemy)
    features.extend(own_escape)        # 39
    features.extend(enemy_escape)      # 39
    features.extend(own_crush)         # 39
    features.extend(enemy_crush)       # 39  (= 156 dims total)

    own_fill, enm_fill = _spell_fill_features(board, side_to_move, enemy)
    features.extend(own_fill)          # 9
    features.extend(enm_fill)          # 9   (= 18 dims)

    own_threat, enm_threat = _threat_of_activation_features(
        board, side_to_move, enemy)
    features.extend(own_threat)        # 9
    features.extend(enm_threat)        # 9   (= 18 dims)

    tempo = _tempo_scalar_features(
        board, side_to_move, enemy,
        own_escape, enemy_escape, own_fill, enm_fill, own_threat, enm_threat,
    )
    features.extend(tempo)             # 8

    raw = torch.tensor(features, dtype=torch.float32)
    assert raw.numel() == RAW_FEATURE_DIM, (
        f'Feature dim mismatch: got {raw.numel()}, expected {RAW_FEATURE_DIM}')

    # --- Spell IDs: 9 integers ---
    spell_ids = torch.tensor(
        [SPELL_TO_ID.get(board.spell_names[i], 0) for i in range(NUM_SPELL_SLOTS)],
        dtype=torch.long
    )

    return raw, spell_ids


def encode_turn(turn, board, color):
    """Encode a CompleteTurn as a fixed-size feature vector.

    Returns: Tensor of shape (TURN_FEATURE_DIM,)  [84 features]
    """
    enemy = 'blue' if color == 'red' else 'red'
    features = np.zeros(TURN_FEATURE_DIM, dtype=np.float32)

    # Layout:
    #  [0:39]  — move target one-hot
    #  [39]    — has hard move
    #  [40]    — has blink
    #  [41]    — has dash
    #  [42]    — has cast
    #  [43:58] — spell cast ID (one-hot over 15 spells)
    #  [58]    — number of actions (normalized by 5)
    #  [59]    — naive estimated stone gain
    #  [60]    — is pass-only turn
    #  [61:64] — reserved (zero)
    #  [64]    — enemy stones crushed by this turn (count / 3)
    #  [65]    — own stones lost by this turn (count / 3)
    #  [66]    — own stones sacrificed for dash (1 if dash, else 0)
    #  [67]    — dash recovers material (1 if dash AND it crushes ≥1 enemy)
    #  [68]    — creates new crush threat against own stones
    #            (count of own stones that become crushable / 3)
    #  [69]    — eliminates an enemy crush threat (count_before − count_after / 3)
    #  [70]    — fills any spell to castable next turn (1/0)
    #  [71]    — claims a mana node (1/0)
    #  [72]    — soft move count (number of soft moves this turn / 3)
    #  [73]    — hard move count
    #  [74]    — net spell-position stones added by this turn
    #  [75]    — net stone change this turn  (signed, [-3,3]/3)  [v27]
    #  [76]    — enemy threat-of-activation growth (max post-pre, [0,1])  [v27]
    #  [77]    — own threat-of-activation growth (max post-pre, [0,1])  [v27]
    #  [78]    — disrupts enemy mana-to-mana chain (count / 3)  [v27]
    #  [79:84] — reserved

    crushable_own_before = _count_crushable(board, color, enemy)
    crushable_enm_before = _count_crushable(board, enemy, color)
    # Pre-turn enemy/own threat-of-activation maxima (only currently-charged
    # spells contribute non-zero entries; others are 0). Used by the v27
    # threat-growth features.
    pre_own_threat, pre_enm_threat = _threat_of_activation_features(
        board, color, enemy)
    pre_max_own_threat = float(pre_own_threat.max(initial=0.0))
    pre_max_enm_threat = float(pre_enm_threat.max(initial=0.0))
    pre_enemy_chains = _chain_count(board, enemy)
    sim_after = _simulate_turn(board, turn, color)

    move_target = None
    soft_count = 0
    hard_count = 0
    spell_pos_delta = 0
    claimed_mana = False

    for action in turn.actions:
        if action.type == 'move' and action.node:
            idx = _NODE_TO_IDX.get(action.node)
            if idx is not None and move_target is None:
                features[idx] = 1.0
                move_target = action.node
            features[59] += 1.0 / 39.0
            soft_count += 1
            if action.node in MANA_NODES and board.stones.get(action.node) is None:
                claimed_mana = True
            for sp_idx, nodes in enumerate(_SPELL_POSITION_NODES):
                if nodes and action.node in nodes:
                    spell_pos_delta += 1
                    break

        elif action.type == 'hard_move' and action.node:
            idx = _NODE_TO_IDX.get(action.node)
            if idx is not None and move_target is None:
                features[idx] = 1.0
                move_target = action.node
            features[39] = 1.0
            hard_count += 1

        elif action.type == 'blink' and action.node:
            idx = _NODE_TO_IDX.get(action.node)
            if idx is not None and move_target is None:
                features[idx] = 1.0
                move_target = action.node
            features[40] = 1.0
            if board.stones.get(action.node) == enemy:
                pass
            else:
                features[59] += 1.0 / 39.0

        elif action.type in ('dash', 'dash_lightning'):
            features[41] = 1.0
            sac_count = len(action.sacrificed) if action.sacrificed else 0
            features[59] -= sac_count / 39.0
            features[66] = 1.0

        elif action.type == 'cast':
            features[42] = 1.0
            spell_id = SPELL_TO_ID.get(action.spell, 0)
            features[43 + spell_id] = 1.0

    features[58] = len(turn.actions) / 5.0
    if len(turn.actions) == 1 and turn.actions[0].type == 'pass':
        features[60] = 1.0

    # Tactical extension: read from sim_after
    if sim_after is not None:
        own_before = board.totalstones[color]
        own_after = sim_after.totalstones[color]
        enm_before = board.totalstones[enemy]
        enm_after = sim_after.totalstones[enemy]
        # Enemy stones lost during our turn
        enemy_crushed = max(0, enm_before - enm_after)
        own_lost = max(0, own_before - own_after)
        features[64] = min(enemy_crushed, 3) / 3.0
        features[65] = min(own_lost, 3) / 3.0

        if features[41] > 0:  # dash
            features[67] = 1.0 if enemy_crushed >= 1 or claimed_mana else 0.0

        # Crush-threat deltas: how many of our stones are crushable
        # in the resulting position? (Enemy moves next.)
        crushable_own_after = _count_crushable(sim_after, color, enemy)
        crushable_enm_after = _count_crushable(sim_after, enemy, color)
        new_threats_to_us = max(0, crushable_own_after - crushable_own_before)
        cleared_enemy_threats = max(0, crushable_enm_before - crushable_enm_after)
        features[68] = min(new_threats_to_us, 3) / 3.0
        features[69] = min(cleared_enemy_threats, 3) / 3.0

        features[70] = 1.0 if _has_castable_spell(sim_after, color) else 0.0

        # --- v27: per-turn lookahead features (75–78) ---
        net = (own_after - own_before) - (enm_after - enm_before)
        features[75] = max(-3, min(3, net)) / 3.0

        post_own_threat, post_enm_threat = _threat_of_activation_features(
            sim_after, color, enemy)
        # Enemy growing their own threat is bad for us (opponent's spell
        # gets stronger after our move).
        enemy_growth = max(
            0.0,
            float(post_enm_threat.max(initial=0.0)) - pre_max_enm_threat,
        )
        own_growth = max(
            0.0,
            float(post_own_threat.max(initial=0.0)) - pre_max_own_threat,
        )
        features[76] = min(enemy_growth, 1.0)
        features[77] = min(own_growth, 1.0)

        # Mana-to-mana chain disruption — how many enemy chains existed
        # before that no longer do after our turn. Burch's "break the
        # bridge stone" heuristic, computed mechanically.
        post_enemy_chains = _chain_count(sim_after, enemy)
        chains_broken = max(0, pre_enemy_chains - post_enemy_chains)
        features[78] = min(chains_broken, 3) / 3.0

    features[71] = 1.0 if claimed_mana else 0.0
    features[72] = min(soft_count, 3) / 3.0
    features[73] = min(hard_count, 3) / 3.0
    features[74] = min(max(spell_pos_delta, -3), 3) / 3.0

    return torch.tensor(features, dtype=torch.float32)


def _chain_count(board, color):
    """Count mana-pair chains owned by `color`.

    A chain is a path of `color` stones (via ADJACENCY, allowing the
    mana-node endpoints themselves to be the bridge stones) connecting
    two distinct mana nodes. With three mana nodes a1/b1/c1 there are
    C(3,2) = 3 possible pairs; the helper returns how many of those
    pairs have at least one such path. Used by the per-turn
    `disrupts_enemy_chain` feature.
    """
    # Find connected components among `color`'s stones, *including* the
    # mana nodes if they're occupied by `color`. Standard BFS.
    visited = set()
    components = []  # list of sets of node names
    for n in NODE_ORDER:
        if n in visited or board.stones[n] != color:
            continue
        comp = set()
        stack = [n]
        while stack:
            cur = stack.pop()
            if cur in comp:
                continue
            comp.add(cur)
            for nb in ADJACENCY.get(cur, []):
                if nb not in comp and board.stones[nb] == color:
                    stack.append(nb)
        visited |= comp
        components.append(comp)

    chains = 0
    pairs = (('a1', 'b1'), ('a1', 'c1'), ('b1', 'c1'))
    for x, y in pairs:
        for comp in components:
            if x in comp and y in comp:
                chains += 1
                break
    return chains


def _count_crushable(board, defender, attacker):
    """How many of `defender`'s stones are crushable by `attacker` right now."""
    n = 0
    for name in NODE_ORDER:
        if board.stones[name] != defender:
            continue
        has_attacker_neighbor = any(
            board.stones[nb] == attacker
            for nb in board._adjacent_nodes(name)
        )
        if has_attacker_neighbor and board.is_crushable(name, attacker):
            n += 1
    return n


def _simulate_turn(board, turn, color):
    """Apply a turn on a copied board for feature lookahead. Returns
    the post-turn SimBoard or None if the simulation throws.

    SimBoard.apply_turn is a no-op (turns are applied via copy +
    get_legal_turns at search time), so we replay actions here ourselves
    to mirror docs/static/scripts/engine/sim-board.js:applySimTurn.
    """
    try:
        sim = board.copy()
        for action in turn.actions:
            if action.type == 'move':
                sim.stones[action.node] = color
            elif action.type == 'hard_move':
                sim._push_enemy(action.node, color)
            elif action.type == 'blink':
                if sim.stones[action.node] == sim._enemy(color):
                    sim._push_enemy(action.node, color)
                else:
                    sim.stones[action.node] = color
            elif action.type == 'cast':
                sim._cast_spell(action.spell, color)
            elif action.type in ('dash', 'dash_lightning'):
                if action.sacrificed:
                    for sac in action.sacrificed:
                        sim.stones[sac] = None
            sim.update()
        return sim
    except Exception:
        return None


def _has_castable_spell(board, color):
    """True if `color` has any non-charm spell whose position is fully
    occupied by their stones (a proxy for 'castable next turn')."""
    own = color
    for i, sn in enumerate(board.spell_names):
        info = CORE_SPELLS.get(sn)
        if info is None or info.get('static') or info.get('ischarm'):
            continue
        nodes = _SPELL_POSITION_NODES[i]
        if nodes and all(board.stones[n] == own for n in nodes):
            return True
    return False


def encode_all_turns(turns, board, color):
    """Encode a list of CompleteTurns into a batch tensor.

    Returns: Tensor of shape (N, TURN_FEATURE_DIM)
    """
    if not turns:
        return torch.zeros(0, TURN_FEATURE_DIM, dtype=torch.float32)
    return torch.stack([encode_turn(t, board, color) for t in turns])
