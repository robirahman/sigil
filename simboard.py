"""
Headless simulation board for Sigil.

No WebSocket I/O. Designed for fast copying and legal move enumeration,
used by the alpha-beta search and self-play data generation.
"""

import copy
from collections import deque
from notation import NODE_ORDER, ADJACENCY, POSITIONS

# Mana nodes
MANA_NODES = ['a1', 'b1', 'c1']

# Core spells metadata: name -> {type, static, ischarm, nodes_count}
CORE_SPELLS = {
    'Flourish': {'resolve': 'soft_moves', 'count': 4, 'static': False, 'ischarm': False},
    'Carnage': {'resolve': 'hard_moves', 'count': 4, 'static': False, 'ischarm': False},
    'Bewitch': {'resolve': 'bewitch', 'static': False, 'ischarm': False},
    'Starfall': {'resolve': 'starfall', 'static': False, 'ischarm': False},
    'Seal_of_Lightning': {'resolve': None, 'static': True, 'ischarm': False},
    'Grow': {'resolve': 'soft_moves', 'count': 2, 'static': False, 'ischarm': False},
    'Fireblast': {'resolve': 'fireblast', 'static': False, 'ischarm': False},
    'Hail_Storm': {'resolve': 'hail_storm', 'static': False, 'ischarm': False},
    'Meteor': {'resolve': 'meteor', 'static': False, 'ischarm': False},
    'Seal_of_Wind': {'resolve': None, 'static': True, 'ischarm': False},
    'Sprout': {'resolve': 'soft_moves', 'count': 1, 'static': False, 'ischarm': True},
    'Slash': {'resolve': 'hard_moves', 'count': 1, 'static': False, 'ischarm': True},
    'Surge': {'resolve': 'surge_move', 'static': False, 'ischarm': True},
    'Comet': {'resolve': 'comet', 'static': False, 'ischarm': True},
    'Seal_of_Summer': {'resolve': None, 'static': True, 'ischarm': True},
    # Springtime expansion
    'Seal_of_Spring': {'resolve': None, 'static': True, 'ischarm': True},
    'Scatter': {'resolve': 'scatter', 'static': False, 'ischarm': False},
    'Blossom': {'resolve': 'blossom', 'static': False, 'ischarm': False},
    # Celestial expansion
    'Azimuth': {'resolve': 'azimuth', 'static': False, 'ischarm': True},
    'Eclipse': {'resolve': 'eclipse', 'static': False, 'ischarm': False},
    'Syzygy': {'resolve': 'syzygy', 'static': False, 'ischarm': False},
}

# Maps a 5-node ritual position to its "opposite" 1-node and 3-node positions.
SYZYGY_OPPOSITE = {1: (8, 5), 2: (9, 6), 3: (7, 4)}


class Action:
    """A single sub-action within a turn."""
    __slots__ = ('type', 'node', 'pushed_to', 'spell', 'sacrificed', 'kept',
                 'node2', 'destroyed')

    def __init__(self, type, **kwargs):
        self.type = type
        self.node = kwargs.get('node')
        self.pushed_to = kwargs.get('pushed_to')
        self.spell = kwargs.get('spell')
        self.sacrificed = kwargs.get('sacrificed')
        self.kept = kwargs.get('kept')
        self.node2 = kwargs.get('node2')
        self.destroyed = kwargs.get('destroyed')

    def __repr__(self):
        parts = [f"Action({self.type!r}"]
        for attr in ('node', 'pushed_to', 'spell', 'sacrificed', 'kept',
                     'node2', 'destroyed'):
            val = getattr(self, attr)
            if val is not None:
                parts.append(f"{attr}={val!r}")
        return ', '.join(parts) + ')'


class CompleteTurn:
    """A full sequence of actions constituting one player's turn."""
    __slots__ = ('actions',)

    def __init__(self, actions=None):
        self.actions = actions or []

    def __repr__(self):
        return f"CompleteTurn({self.actions})"


class SimBoard:
    """Lightweight, copyable board for simulation."""

    __slots__ = ('stones', 'spell_names', 'turn_counter', 'whose_turn',
                 'gameover', 'winner', 'score', 'spell_counter', 'lock',
                 'springlock', 'totalstones', 'mana', 'charged_spells')

    def __init__(self, spell_names=None):
        self.stones = {n: None for n in NODE_ORDER}
        self.spell_names = spell_names or ['Flourish', 'Carnage', 'Bewitch',
                                           'Grow', 'Fireblast', 'Hail_Storm',
                                           'Sprout', 'Slash', 'Surge']
        self.turn_counter = 0
        self.whose_turn = 'red'
        self.gameover = False
        self.winner = None
        self.score = 'b1'
        self.spell_counter = {'red': 0, 'blue': 0}
        self.lock = {'red': None, 'blue': None}
        self.springlock = {'red': None, 'blue': None}
        self.totalstones = {'red': 0, 'blue': 0}
        self.mana = {'red': 0, 'blue': 0}
        self.charged_spells = {'red': [], 'blue': []}

    def copy(self):
        b = SimBoard.__new__(SimBoard)
        b.stones = dict(self.stones)
        b.spell_names = self.spell_names  # immutable list, shared
        b.turn_counter = self.turn_counter
        b.whose_turn = self.whose_turn
        b.gameover = self.gameover
        b.winner = self.winner
        b.score = self.score
        b.spell_counter = dict(self.spell_counter)
        b.lock = dict(self.lock)
        b.springlock = dict(self.springlock)
        b.totalstones = dict(self.totalstones)
        b.mana = dict(self.mana)
        b.charged_spells = {'red': list(self.charged_spells['red']),
                            'blue': list(self.charged_spells['blue'])}
        return b

    def setup_initial(self):
        """Set up initial board state with starting stones."""
        self.stones['a1'] = 'red'
        self.stones['b1'] = 'blue'
        self.update()

    def update(self):
        """Recalculate derived state: totalstones, mana, charged_spells, score."""
        red_count = 0
        blue_count = 0
        for stone in self.stones.values():
            if stone == 'red':
                red_count += 1
            elif stone == 'blue':
                blue_count += 1
        self.totalstones['red'] = red_count
        self.totalstones['blue'] = blue_count

        # Score: blue gets +1 phantom stone
        redscore = red_count
        bluescore = blue_count + 1
        if redscore == bluescore:
            self.score = 'tied'
        elif redscore > bluescore:
            self.score = 'r' + str(min(3, redscore - bluescore))
        else:
            self.score = 'b' + str(min(3, bluescore - redscore))

        # Mana
        for color in ('red', 'blue'):
            self.mana[color] = sum(1 for n in MANA_NODES if self.stones[n] == color)

        # Charged spells
        for color in ('red', 'blue'):
            self.charged_spells[color] = []
        for i, spell_name in enumerate(self.spell_names):
            pos_idx = i + 1
            nodes = POSITIONS[pos_idx]
            if not nodes:
                continue
            first = self.stones[nodes[0]]
            if first is None:
                continue
            all_same = all(self.stones[n] == first for n in nodes[1:])
            if all_same:
                self.charged_spells[first].append(spell_name)

    def check_game_over(self, active_color):
        """Check win conditions after a turn. Returns True if game is over."""
        red_total = self.totalstones['red']
        blue_total = self.totalstones['blue'] + 1  # phantom stone

        if red_total > blue_total + 2:
            self.gameover = True
            self.winner = 'red'
            return True
        if blue_total > red_total + 2:
            self.gameover = True
            self.winner = 'blue'
            return True

        if self.spell_counter[active_color] >= 6:
            self.gameover = True
            if red_total > blue_total:
                self.winner = 'red'
            elif blue_total > red_total:
                self.winner = 'blue'
            else:
                self.winner = 'blue' if active_color == 'red' else 'red'
            return True

        return False

    def advance_turn(self):
        """Switch to the next player's turn."""
        self.turn_counter += 1
        self.whose_turn = 'blue' if self.whose_turn == 'red' else 'red'

    # ---- Move helpers ----

    def _enemy(self, color):
        return 'blue' if color == 'red' else 'red'

    def _adjacent_nodes(self, node_name):
        return ADJACENCY.get(node_name, [])

    def _soft_moveable(self, color):
        """Return list of empty nodes adjacent to color's stones."""
        result = []
        for name in NODE_ORDER:
            if self.stones[name] is None:
                for nb in self._adjacent_nodes(name):
                    if self.stones[nb] == color:
                        result.append(name)
                        break
        return result

    def _hard_moveable(self, color, exclude_nodes=None):
        """Return list of enemy nodes adjacent to color's stones."""
        enemy = self._enemy(color)
        exclude = set(exclude_nodes) if exclude_nodes else set()
        result = []
        for name in NODE_ORDER:
            if self.stones[name] == enemy:
                for nb in self._adjacent_nodes(name):
                    if nb not in exclude and self.stones[nb] == color:
                        result.append(name)
                        break
        return result

    def _all_moveable(self, color):
        """Return list of nodes (empty or enemy) adjacent to color's stones."""
        result = []
        for name in NODE_ORDER:
            if self.stones[name] != color:
                for nb in self._adjacent_nodes(name):
                    if self.stones[nb] == color:
                        result.append(name)
                        break
        return result

    def _blinkable(self, color):
        """Return list of all nodes not occupied by color."""
        return [n for n in NODE_ORDER if self.stones[n] != color]

    def escape_distance(self, node_name, defender_color, max_dist=6):
        """Minimum BFS distance from node_name through defender stones to
        the nearest empty cell, mirroring the push-chain logic in
        _push_enemy. Used by feature engineering as a 'liberty' analogue.

        Returns max_dist if no empty cell is reachable through a chain
        of defender stones (i.e. the stone at node_name would be crushed
        if the attacker pushed it).

        Non-mutating.
        """
        attacker = 'blue' if defender_color == 'red' else 'red'
        queue = deque()
        for nb in self._adjacent_nodes(node_name):
            queue.append((nb, 1))
        visited = {node_name}
        shortest = None
        while queue:
            next_node, dist = queue.popleft()
            if next_node in visited:
                continue
            visited.add(next_node)
            if shortest is not None and dist > shortest:
                break
            if dist > max_dist:
                break
            stone = self.stones[next_node]
            if stone == attacker:
                # Attacker's own stones block the push chain.
                continue
            elif stone == defender_color:
                for nb in self._adjacent_nodes(next_node):
                    if nb not in visited:
                        queue.append((nb, dist + 1))
            else:  # empty
                return dist
        return max_dist

    def is_crushable(self, node_name, attacker_color):
        """True iff a hard-move into node_name by attacker_color would
        crush the stone there (no empty cell reachable through the push
        chain). Returns False if node_name isn't occupied by the defender.

        Non-mutating; pure read of self.stones.
        """
        defender = 'blue' if attacker_color == 'red' else 'red'
        if self.stones[node_name] != defender:
            return False
        # Use 39 as the unreachable sentinel — graph has 39 nodes total.
        return self.escape_distance(node_name, defender, max_dist=39) >= 39

    def _push_enemy(self, node_name, color):
        """Push enemy stone from node_name. Returns push destination or 'X' for crush.

        Mutates self.stones: places color on node_name, moves enemy to destination.
        """
        enemy = self._enemy(color)
        self.stones[node_name] = color

        queue = deque()
        for nb in self._adjacent_nodes(node_name):
            queue.append((nb, 1))

        visited = {node_name}
        options = []
        shortest = None

        while queue:
            next_node, dist = queue.popleft()
            if next_node in visited:
                continue
            visited.add(next_node)

            if shortest is not None and dist > shortest:
                break

            stone = self.stones[next_node]
            if stone == color:
                continue
            elif stone == enemy:
                for nb in self._adjacent_nodes(next_node):
                    if nb not in visited:
                        queue.append((nb, dist + 1))
            else:  # empty
                options.append(next_node)
                shortest = dist

        if not options:
            # Crush — stone is destroyed
            return 'X'
        else:
            # Pick first option (greedy, same as AI)
            dest = options[0]
            self.stones[dest] = enemy
            return dest

    def _do_soft_move(self, color, node_name):
        """Place color stone on empty node. Returns the Action."""
        self.stones[node_name] = color
        return Action('move', node=node_name)

    def _do_hard_move(self, color, node_name):
        """Push enemy at node_name. Returns the Action."""
        dest = self._push_enemy(node_name, color)
        return Action('hard_move', node=node_name, pushed_to=dest)

    def _do_move(self, color, node_name, is_blink=False):
        """Execute a move to node_name. Returns an Action."""
        if self.stones[node_name] is None:
            if is_blink:
                self.stones[node_name] = color
                return Action('blink', node=node_name)
            else:
                return self._do_soft_move(color, node_name)
        elif self.stones[node_name] == self._enemy(color):
            act = self._do_hard_move(color, node_name)
            if is_blink:
                act.type = 'blink'
            return act
        return None  # invalid

    # ---- Spell resolution (greedy by default, branching via overrides) ----

    def _resolve_spell(self, spell_name, color, spell_position_nodes,
                       target_overrides=None):
        """Resolve a spell's effect. Returns list of Actions describing what
        happened.

        Defaults to greedy choices for spells with target options. Pass
        `target_overrides` (a dict) to force a specific resolution — used
        by the exhaustive turn enumerator to branch over target choices.

        Recognized override keys:
          - 'bewitch_pair': (node1, node2) — both must be enemy stones,
              adjacent to each other.
          - 'starfall_pair': (node1, node2) — both must be empty, adjacent.
          - 'meteor_target': node — blink target.
          - 'comet_target': node — blink target.
          - 'comet_sacrifice': node — own stone to sacrifice (≠ target).
          - 'hard_move_targets': [node, …] — for Carnage/Slash, the order in
              which to apply hard moves (first valid ones used).
          - 'soft_move_targets': [node, …] — for Flourish/Grow/Sprout.
        """
        info = CORE_SPELLS.get(spell_name)
        if info is None or info['resolve'] is None:
            return []

        actions = []
        enemy = self._enemy(color)
        resolve_type = info['resolve']
        overrides = target_overrides or {}

        if resolve_type == 'soft_moves':
            count = info['count']
            override_targets = list(overrides.get('soft_move_targets') or [])
            for _ in range(count):
                targets = self._soft_moveable(color)
                if not targets:
                    break
                chosen = None
                # Apply override targets in order, skipping any no longer legal.
                while override_targets and chosen is None:
                    candidate = override_targets.pop(0)
                    if candidate in targets:
                        chosen = candidate
                if chosen is None:
                    # Greedy fallback: prefer nodes not in the spell position
                    for t in targets:
                        if t not in spell_position_nodes:
                            chosen = t
                            break
                if chosen is None:
                    chosen = targets[0]
                actions.append(self._do_soft_move(color, chosen))
                self.update()

        elif resolve_type == 'hard_moves':
            count = info['count']
            override_targets = list(overrides.get('hard_move_targets') or [])
            for _ in range(count):
                targets = self._hard_moveable(color)
                if not targets:
                    break
                chosen = None
                while override_targets and chosen is None:
                    candidate = override_targets.pop(0)
                    if candidate in targets:
                        chosen = candidate
                if chosen is None:
                    chosen = targets[0]
                actions.append(self._do_hard_move(color, chosen))
                self.update()

        elif resolve_type == 'fireblast':
            destroyed = []
            for name in NODE_ORDER:
                if self.stones[name] == enemy:
                    for nb in self._adjacent_nodes(name):
                        if self.stones[nb] == color:
                            self.stones[name] = None
                            destroyed.append(name)
                            break
            if destroyed:
                actions.append(Action('fireblast', destroyed=destroyed))

        elif resolve_type == 'hail_storm':
            destroyed = []
            for pos_idx in range(1, 7):
                nodes = POSITIONS[pos_idx]
                for n in nodes:
                    if self.stones[n] == enemy:
                        self.stones[n] = None
                        destroyed.append(n)
                        self.update()
                        break
            if destroyed:
                actions.append(Action('hail_storm', destroyed=destroyed))

        elif resolve_type == 'bewitch':
            # Convert two adjacent enemy stones. Override picks a specific
            # pair; otherwise fall back to first-found by NODE_ORDER.
            override = overrides.get('bewitch_pair')
            if override is not None:
                n1, n2 = override
                if (self.stones[n1] == enemy
                        and self.stones[n2] == enemy
                        and n2 in self._adjacent_nodes(n1)):
                    self.stones[n1] = color
                    self.stones[n2] = color
                    actions.append(Action('bewitch', node=n1, node2=n2))
                    self.update()
                    return actions
            for name in NODE_ORDER:
                if self.stones[name] == enemy:
                    for nb in self._adjacent_nodes(name):
                        if self.stones[nb] == enemy:
                            self.stones[name] = color
                            self.stones[nb] = color
                            actions.append(Action('bewitch', node=name, node2=nb))
                            self.update()
                            return actions
            # No valid target found

        elif resolve_type == 'starfall':
            # Place two adjacent stones on empty nodes, then destroy
            # neighboring enemies. Override picks a specific empty pair;
            # otherwise the greedy choice maximizes enemy destruction.
            best = None
            override = overrides.get('starfall_pair')
            if override is not None:
                n1, n2 = override
                if (self.stones[n1] is None
                        and self.stones[n2] is None
                        and n2 in self._adjacent_nodes(n1)):
                    best = (n1, n2)
            if best is None:
                # Heuristic: max enemy stones destroyed; ties broken in
                # favor of pairs that destroy an enemy on a mana node
                # (a1/b1/c1). Mana destruction is strictly better than
                # destruction elsewhere because losing mana stalls the
                # opponent's spell tempo.
                best_score = (-1, -1)
                for name in NODE_ORDER:
                    if self.stones[name] is not None:
                        continue
                    for nb in self._adjacent_nodes(name):
                        if self.stones[nb] is not None:
                            continue
                        neighbors_union = (set(self._adjacent_nodes(name))
                                           | set(self._adjacent_nodes(nb)))
                        enemy_targets = [n for n in neighbors_union
                                         if self.stones[n] == enemy]
                        enemy_count = len(enemy_targets)
                        mana_kills = sum(1 for n in enemy_targets if n in MANA_NODES)
                        score = (enemy_count, mana_kills)
                        if score > best_score:
                            best_score = score
                            best = (name, nb)
            if best:
                n1, n2 = best
                self.stones[n1] = color
                self.stones[n2] = color
                destroyed = []
                neighbors_union = set(self._adjacent_nodes(n1)) | set(self._adjacent_nodes(n2))
                for n in neighbors_union:
                    if self.stones[n] == enemy:
                        self.stones[n] = None
                        destroyed.append(n)
                actions.append(Action('starfall', node=n1, node2=n2, destroyed=destroyed))
                self.update()

        elif resolve_type == 'meteor':
            # Blink move, then destroy 1 adjacent enemy. Override picks
            # a specific blink target.
            targets = self._blinkable(color)
            chosen = None
            override = overrides.get('meteor_target')
            if override is not None and override in targets:
                chosen = override
            else:
                # Heuristic: maximize total enemies destroyed (push-crush
                # if blinking onto an enemy with no escape, plus the one
                # adjacent enemy the spell destroys). Ties broken in
                # favor of options that eliminate an enemy mana stone —
                # via crush of a mana-occupant or via the adjacent-kill
                # falling on a mana node.
                best_score = (-1, -1)
                for t in targets:
                    crush = (self.stones[t] == enemy
                             and self.is_crushable(t, color))
                    crush_kills = 1 if crush else 0
                    crush_mana = 1 if (crush and t in MANA_NODES) else 0
                    # After the blink, t is owned by us. Find the first
                    # adjacent enemy (matches the actual resolver's
                    # iteration order), preferring one on a mana node.
                    adj_enemies = [
                        nb for nb in self._adjacent_nodes(t)
                        if self.stones[nb] == enemy
                    ]
                    if adj_enemies:
                        kill = 1
                        # Prefer killing a mana stone if available.
                        kill_mana = 1 if any(n in MANA_NODES for n in adj_enemies) else 0
                    else:
                        kill = 0
                        kill_mana = 0
                    score = (crush_kills + kill, crush_mana + kill_mana)
                    if score > best_score:
                        best_score = score
                        chosen = t
                if chosen is None and targets:
                    chosen = targets[0]
            if chosen:
                if self.stones[chosen] == enemy:
                    dest = self._push_enemy(chosen, color)
                    actions.append(Action('blink', node=chosen, pushed_to=dest))
                else:
                    self.stones[chosen] = color
                    actions.append(Action('blink', node=chosen))
                self.update()
                # Destroy 1 adjacent enemy — prefer one on a mana node so
                # the heuristic's mana-tiebreak choice is realized.
                adj_enemies = [
                    nb for nb in self._adjacent_nodes(chosen)
                    if self.stones[nb] == enemy
                ]
                kill_target = None
                for nb in adj_enemies:
                    if nb in MANA_NODES:
                        kill_target = nb
                        break
                if kill_target is None and adj_enemies:
                    kill_target = adj_enemies[0]
                if kill_target is not None:
                    self.stones[kill_target] = None
                    actions.append(Action('meteor_destroy', node=kill_target))
                self.update()

        elif resolve_type == 'comet':
            # Blink move (typically to a mana node), then sacrifice a stone.
            # Override picks a specific blink target.
            target = None
            override = overrides.get('comet_target')
            if override is not None:
                blinkable = self._blinkable(color)
                if override in blinkable:
                    target = override
            if target is None:
                for mn in reversed(MANA_NODES):
                    if self.stones[mn] != color:
                        adj_enemy = sum(1 for nb in self._adjacent_nodes(mn) if self.stones[nb] == enemy)
                        already_touching = self.stones[mn] == color or any(
                            self.stones[nb] == color for nb in self._adjacent_nodes(mn))
                        if not already_touching and adj_enemy < 2:
                            target = mn
                            break
                if target is None:
                    targets = self._blinkable(color)
                    if targets:
                        target = targets[0]
            if target:
                if self.stones[target] == enemy:
                    dest = self._push_enemy(target, color)
                    actions.append(Action('blink', node=target, pushed_to=dest))
                else:
                    self.stones[target] = color
                    actions.append(Action('blink', node=target))
                self.update()
                # Sacrifice the least valuable stone — but never the
                # just-placed blink target (that defeats the purpose of
                # the spell). JS implementation skips `target`; this
                # matches it for cross-engine feature parity.
                sac_override = overrides.get('comet_sacrifice')
                sac_done = False
                if sac_override is not None and sac_override != target:
                    if self.stones[sac_override] == color:
                        self.stones[sac_override] = None
                        actions.append(Action('sacrifice', node=sac_override))
                        sac_done = True
                if not sac_done:
                    for name in reversed(NODE_ORDER):
                        if self.stones[name] == color and name != target:
                            self.stones[name] = None
                            actions.append(Action('sacrifice', node=name))
                            break
                self.update()

        elif resolve_type == 'surge_move':
            # Make 1 move. Override picks a specific target.
            targets = self._all_moveable(color)
            override = overrides.get('surge_target')
            chosen = None
            if override is not None and override in targets:
                chosen = override
            elif targets:
                chosen = targets[0]
            if chosen:
                actions.append(self._do_move(color, chosen))
                self.update()

        elif resolve_type == 'azimuth':
            # 1 move into a spell where this color controls all but 1 node.
            qualifying = []
            for i in range(1, 10):
                unc = sum(1 for n in POSITIONS[i] if self.stones[n] != color)
                if unc == 1:
                    qualifying.append(i)
            moves = self._all_moveable(color)
            chosen = None
            for idx in qualifying:
                for n in POSITIONS[idx]:
                    if n in moves:
                        chosen = n
                        break
                if chosen:
                    break
            if chosen:
                actions.append(self._do_move(color, chosen))
                self.update()

        elif resolve_type == 'eclipse':
            # 2 moves into a spell where this color controls all but 2 nodes.
            candidates = []
            for i in range(1, 10):
                unc = sum(1 for n in POSITIONS[i] if self.stones[n] != color)
                if unc == 2:
                    candidates.append(i)
            chosen_spell = None
            first_node = None
            for idx in candidates:
                moves = self._all_moveable(color)
                for n in POSITIONS[idx]:
                    if n in moves:
                        chosen_spell = idx
                        first_node = n
                        break
                if first_node:
                    break
            if first_node:
                actions.append(self._do_move(color, first_node))
                self.update()
                moves2 = self._all_moveable(color)
                for n in POSITIONS[chosen_spell]:
                    if n in moves2:
                        actions.append(self._do_move(color, n))
                        self.update()
                        break

        elif resolve_type == 'scatter':
            # 1 soft blink into each of 2 different spells (any empty node).
            used_spells = set()
            for _ in range(2):
                placed = None
                for i in range(1, 10):
                    if i in used_spells:
                        continue
                    for n in POSITIONS[i]:
                        if self.stones[n] is None:
                            placed = (n, i)
                            break
                    if placed:
                        break
                if not placed:
                    break
                node_name, idx = placed
                self.stones[node_name] = color
                used_spells.add(idx)
                actions.append(Action('blink', node=node_name))
                self.update()

        elif resolve_type == 'blossom':
            # 1 soft blink into each other 3-node and 5-node spell.
            self_idx = self.spell_names.index(spell_name) + 1
            for i in range(1, 7):
                if i == self_idx:
                    continue
                placed = None
                for n in POSITIONS[i]:
                    if self.stones[n] is None:
                        placed = n
                        break
                if not placed:
                    break  # ends early
                self.stones[placed] = color
                actions.append(Action('blink', node=placed))
                self.update()

        elif resolve_type == 'syzygy':
            # 1 blink into the opposite 1-node spell, then up to 3 into the opposite 3-node spell.
            spell_idx = self.spell_names.index(spell_name) + 1
            opp = SYZYGY_OPPOSITE.get(spell_idx)
            if opp is not None:
                charm_idx, sorcery_idx = opp
                charm_node = POSITIONS[charm_idx][0]
                if self.stones[charm_node] != color:
                    if self.stones[charm_node] == enemy:
                        dest = self._push_enemy(charm_node, color)
                        actions.append(Action('blink', node=charm_node, pushed_to=dest))
                    else:
                        self.stones[charm_node] = color
                        actions.append(Action('blink', node=charm_node))
                    self.update()
                for _ in range(3):
                    target = next((n for n in POSITIONS[sorcery_idx] if self.stones[n] != color), None)
                    if target is None:
                        break
                    if self.stones[target] == enemy:
                        dest = self._push_enemy(target, color)
                        actions.append(Action('blink', node=target, pushed_to=dest))
                    else:
                        self.stones[target] = color
                        actions.append(Action('blink', node=target))
                    self.update()

        return actions

    def _cast_spell(self, spell_name, color, target_overrides=None):
        """Cast a spell: sacrifice nodes, refill by mana, resolve effect.

        Mutates board state. Returns list of Actions.
        """
        spell_idx = self.spell_names.index(spell_name)
        pos_idx = spell_idx + 1
        position_nodes = POSITIONS[pos_idx]
        spell_info = CORE_SPELLS[spell_name]
        is_charm = spell_info['ischarm']

        actions = []

        # Sacrifice all stones in spell position
        for n in position_nodes:
            self.stones[n] = None

        # Refill based on mana (non-charms only)
        kept = []
        if not is_charm:
            refills = self.mana[color]
            # AI refill priority: middle nodes first
            if len(position_nodes) == 3:
                refill_priority = [position_nodes[2], position_nodes[1], position_nodes[0]]
            else:
                refill_priority = [position_nodes[2], position_nodes[3], position_nodes[4],
                                   position_nodes[0], position_nodes[1]]
            for node in refill_priority:
                if refills > 0:
                    self.stones[node] = color
                    kept.append(node)
                    refills -= 1

        self.update()

        # Resolve spell effect (optionally with target overrides)
        resolve_actions = self._resolve_spell(
            spell_name, color, position_nodes, target_overrides=target_overrides)
        actions.extend(resolve_actions)

        self.update()

        # Lock management (non-charms only)
        if not is_charm:
            if self.lock[color] == spell_name:
                self.springlock[color] = spell_name
            else:
                self.lock[color] = spell_name
                self.springlock[color] = None
            self.spell_counter[color] += 1

        cast_action = Action('cast', spell=spell_name, kept=kept)
        return [cast_action] + actions

    # ---- Legal turn enumeration ----

    def get_legal_turns(self, color):
        """Generate legal CompleteTurn objects for the given color.

        Uses greedy heuristics for spell sub-actions to keep branching manageable.
        Yields CompleteTurn objects.
        """
        self.update()
        enemy = self._enemy(color)

        has_seal_of_wind = 'Seal_of_Wind' in self.charged_spells[color]
        has_seal_of_lightning = 'Seal_of_Lightning' in self.charged_spells[color]
        has_seal_of_summer = 'Seal_of_Summer' in self.charged_spells[color]

        # Phase 1: Move options
        if has_seal_of_wind:
            move_targets = self._blinkable(color)
        else:
            move_targets = self._all_moveable(color)

        if not move_targets:
            # Must pass if no moves available
            yield CompleteTurn([Action('pass')])
            return

        for move_target in move_targets:
            board_after_move = self.copy()
            is_blink = has_seal_of_wind and not any(
                board_after_move.stones[nb] == color
                for nb in board_after_move._adjacent_nodes(move_target)
            )
            move_action = board_after_move._do_move(color, move_target, is_blink=is_blink)
            if move_action is None:
                continue
            board_after_move.update()

            # Phase 2: After move — can dash, cast spells, or pass
            yield from board_after_move._enumerate_post_move(
                color, [move_action], can_dash=True, can_spell=True, can_summer=True)

    def _enumerate_post_move(self, color, actions_so_far, can_dash, can_spell, can_summer):
        """Enumerate post-move options: dash, spell, or pass."""
        enemy = self._enemy(color)
        has_seal_of_lightning = 'Seal_of_Lightning' in self.charged_spells[color]
        has_seal_of_summer = 'Seal_of_Summer' in self.charged_spells[color]
        has_autumn = 'Autumn' in self.charged_spells[enemy]

        # Option: pass (always available)
        yield CompleteTurn(actions_so_far + [Action('pass')])

        # Option: dash (if allowed and enough stones)
        if can_dash and can_spell and self.totalstones[color] > 2 and not has_autumn:
            dash_targets = self._all_moveable(color)
            if dash_targets:
                # For each possible dash, we do it greedily (one dash variant)
                board_d = self.copy()
                dash_actions = []

                if has_seal_of_lightning:
                    # Sacrifice 1 stone
                    sac = None
                    for name in reversed(NODE_ORDER):
                        if board_d.stones[name] == color:
                            sac = name
                            break
                    if sac:
                        board_d.stones[sac] = None
                        board_d.update()
                        # Move
                        targets = board_d._all_moveable(color)
                        if targets:
                            chosen = targets[0]
                            move_act = board_d._do_move(color, chosen)
                            if move_act:
                                dash_actions.append(Action('dash_lightning',
                                                           sacrificed=[sac], node=chosen))
                                dash_actions.append(move_act)
                                board_d.update()
                                yield from board_d._enumerate_post_dash(
                                    color, actions_so_far + dash_actions,
                                    can_spell=can_spell, can_summer=can_summer)
                else:
                    # Sacrifice 2 stones
                    sacs = []
                    for name in reversed(NODE_ORDER):
                        if board_d.stones[name] == color and len(sacs) < 2:
                            sacs.append(name)
                            board_d.stones[name] = None
                    if len(sacs) == 2:
                        board_d.update()
                        targets = board_d._all_moveable(color)
                        if targets:
                            chosen = targets[0]
                            move_act = board_d._do_move(color, chosen)
                            if move_act:
                                dash_actions.append(Action('dash', sacrificed=sacs, node=chosen))
                                dash_actions.append(move_act)
                                board_d.update()
                                yield from board_d._enumerate_post_dash(
                                    color, actions_so_far + dash_actions,
                                    can_spell=can_spell, can_summer=can_summer)

        # Option: cast spells
        if can_spell or (not can_spell and has_seal_of_summer and can_summer):
            castable = self._get_castable_spells(color, can_spell, can_summer)
            for spell_name in castable:
                board_s = self.copy()
                spell_actions = board_s._cast_spell(spell_name, color)
                board_s.update()
                if can_spell:
                    yield from board_s._enumerate_post_move(
                        color, actions_so_far + spell_actions,
                        can_dash=can_dash, can_spell=False, can_summer=can_summer)
                else:
                    yield from board_s._enumerate_post_move(
                        color, actions_so_far + spell_actions,
                        can_dash=can_dash, can_spell=False, can_summer=False)

    def _enumerate_post_dash(self, color, actions_so_far, can_spell, can_summer):
        """After dashing, can cast spells or pass."""
        yield CompleteTurn(actions_so_far + [Action('pass')])

        has_seal_of_summer = 'Seal_of_Summer' in self.charged_spells[color]

        if can_spell or (not can_spell and has_seal_of_summer and can_summer):
            castable = self._get_castable_spells(color, can_spell, can_summer)
            for spell_name in castable:
                board_s = self.copy()
                spell_actions = board_s._cast_spell(spell_name, color)
                board_s.update()
                # After spell, can only pass or cast summer spell
                yield CompleteTurn(actions_so_far + spell_actions + [Action('pass')])

    def _get_castable_spells(self, color, can_spell, can_summer):
        """Return list of spell names that can be cast."""
        enemy = self._enemy(color)
        has_winter = 'Winter' in self.charged_spells[enemy]
        has_spring = 'Seal_of_Spring' in self.charged_spells[color]
        has_seal_of_summer = 'Seal_of_Summer' in self.charged_spells[color]

        castable = []
        for spell_name in self.charged_spells[color]:
            info = CORE_SPELLS.get(spell_name)
            if info is None or info['static']:
                continue

            if info['ischarm']:
                if has_winter:
                    continue
                if spell_name == 'Surge':
                    # Surge can only be cast if we dashed this turn
                    # (caller manages this via can_dash flag)
                    continue
                if not can_spell and has_seal_of_summer and can_summer:
                    castable.append(spell_name)
                elif can_spell:
                    castable.append(spell_name)
            else:
                if self.lock[color] == spell_name:
                    if has_spring and self.springlock[color] != spell_name:
                        castable.append(spell_name)
                else:
                    castable.append(spell_name)
        return castable

    # ---- Turn application ----

    def apply_turn(self, turn):
        """Apply a CompleteTurn to this board, mutating state.

        Note: This replays the actions, which may not perfectly match
        because spell resolutions are greedy. For search purposes,
        we apply turns by copying + executing rather than replaying.
        """
        # Turns are applied by the search via copy + get_legal_turns,
        # so each CompleteTurn already contains the result of execution.
        # This method is mainly for external use.
        pass

    # ---- Serialization ----

    def to_sfn(self):
        from notation import board_to_sfn as _to_sfn_func
        # Create a minimal adapter
        class _Adapter:
            pass
        board = _Adapter()
        board.nodes = {n: _Adapter() for n in NODE_ORDER}
        for n in NODE_ORDER:
            board.nodes[n].stone = self.stones[n]
        board.spells = []
        for name in self.spell_names:
            s = _Adapter()
            s.name = name
            board.spells.append(s)
        board.whoseturn = self.whose_turn
        board.turncounter = self.turn_counter
        board.score = self.score
        board.redplayer = _Adapter()
        board.blueplayer = _Adapter()
        board.redplayer.spellcounter = self.spell_counter['red']
        board.blueplayer.spellcounter = self.spell_counter['blue']
        board.redplayer.lock = _Adapter() if self.lock['red'] else None
        board.blueplayer.lock = _Adapter() if self.lock['blue'] else None
        if board.redplayer.lock:
            board.redplayer.lock.name = self.lock['red']
        if board.blueplayer.lock:
            board.blueplayer.lock.name = self.lock['blue']
        board.redplayer.springlock = _Adapter() if self.springlock['red'] else None
        board.blueplayer.springlock = _Adapter() if self.springlock['blue'] else None
        if board.redplayer.springlock:
            board.redplayer.springlock.name = self.springlock['red']
        if board.blueplayer.springlock:
            board.blueplayer.springlock.name = self.springlock['blue']
        return _to_sfn_func(board)

    @classmethod
    def from_sfn(cls, sfn_str):
        from notation import sfn_to_dict
        d = sfn_to_dict(sfn_str)
        b = cls(spell_names=d['spell_names'])
        b.stones = dict(d['stones'])
        b.whose_turn = d['turn']
        b.turn_counter = d['turncounter']
        b.spell_counter = {'red': d['red_spellcounter'], 'blue': d['blue_spellcounter']}
        b.lock = {'red': d['red_lock'], 'blue': d['blue_lock']}
        b.springlock = {'red': d['red_springlock'], 'blue': d['blue_springlock']}
        b.score = d['score']
        b.update()
        return b
