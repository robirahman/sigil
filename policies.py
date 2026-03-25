"""
Move selection policies for self-play data generation.
Each policy takes a SimBoard and color, returns a CompleteTurn.
"""

import random
from simboard import SimBoard, CompleteTurn, Action, NODE_ORDER, CORE_SPELLS


class RandomPolicy:
    """Pick uniformly at random from legal turns."""

    def choose_turn(self, board, color):
        turns = list(board.get_legal_turns(color))
        if not turns:
            return CompleteTurn([Action('pass')])
        return random.choice(turns)


class HeuristicPolicy:
    """Port of the existing AIPlayer priority logic to SimBoard.

    Mimics the rule-based AI: always move first, then pick highest-priority spell.
    """

    RED_PRIORITY = ['b1', 'c1', 'a1',
        'b10', 'b8', 'b9', 'b2', 'b3', 'b4', 'b6', 'b5', 'b7',
        'c10', 'c8', 'c9', 'c2', 'c3', 'c4', 'c6', 'c5', 'c7',
        'a10', 'a8', 'a9', 'a2', 'a3', 'a4', 'a6', 'a5', 'a7',
        'b11', 'b12', 'b13', 'c11', 'c12', 'c13', 'a11', 'a12', 'a13']

    BLUE_PRIORITY = ['a1', 'c1', 'b1',
        'a10', 'a8', 'a9', 'a2', 'a3', 'a4', 'a6', 'a5', 'a7',
        'c10', 'c8', 'c9', 'c2', 'c3', 'c4', 'c6', 'c5', 'c7',
        'b10', 'b8', 'b9', 'b2', 'b3', 'b4', 'b6', 'b5', 'b7',
        'a11', 'a12', 'a13', 'c11', 'c12', 'c13', 'b11', 'b12', 'b13']

    # Spell priority order (highest first)
    SPELL_PRIORITY = [
        'Carnage', 'Starfall', 'Bewitch', 'Flourish',
        'Fireblast', 'Hail_Storm', 'Meteor', 'Grow',
        'Surge', 'Slash', 'Sprout', 'Comet',
    ]

    def choose_turn(self, board, color):
        turns = list(board.get_legal_turns(color))
        if not turns:
            return CompleteTurn([Action('pass')])

        # Score each turn using heuristic
        best_turn = turns[0]
        best_score = -1000

        for turn in turns:
            score = self._score_turn(board, turn, color)
            if score > best_score:
                best_score = score
                best_turn = turn

        return best_turn

    def _score_turn(self, board, turn, color):
        """Heuristic score for a complete turn."""
        # Simulate the turn
        b = board.copy()
        enemy = 'blue' if color == 'red' else 'red'

        # Apply each action
        score = 0
        for action in turn.actions:
            if action.type == 'move':
                b.stones[action.node] = color
                score += self._node_priority_score(action.node, color)
            elif action.type == 'hard_move':
                b.stones[action.node] = color
                score += self._node_priority_score(action.node, color) + 2
            elif action.type == 'blink':
                if b.stones.get(action.node) != color:
                    b.stones[action.node] = color
                score += self._node_priority_score(action.node, color) + 1
            elif action.type == 'cast':
                spell_name = action.spell
                if spell_name in self.SPELL_PRIORITY:
                    # Higher priority spells get higher score
                    idx = self.SPELL_PRIORITY.index(spell_name)
                    score += (len(self.SPELL_PRIORITY) - idx) * 3
            elif action.type == 'dash' or action.type == 'dash_lightning':
                score += 1  # Dash is sometimes good
            elif action.type == 'pass':
                pass

        # Evaluate resulting position
        b.update()
        stone_diff = b.totalstones[color] - b.totalstones[enemy]
        score += stone_diff * 5

        return score

    def _node_priority_score(self, node_name, color):
        priority = self.RED_PRIORITY if color == 'red' else self.BLUE_PRIORITY
        if node_name in priority:
            idx = priority.index(node_name)
            return max(0, len(priority) - idx) / len(priority) * 3
        return 0


class EpsilonGreedyPolicy:
    """Wraps another policy, using it most of the time but exploring randomly."""

    def __init__(self, base_policy, epsilon=0.15):
        self.base_policy = base_policy
        self.epsilon = epsilon
        self.random_policy = RandomPolicy()

    def choose_turn(self, board, color):
        if random.random() < self.epsilon:
            return self.random_policy.choose_turn(board, color)
        return self.base_policy.choose_turn(board, color)
