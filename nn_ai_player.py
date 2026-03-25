"""
Neural network AI player for Sigil.

Uses the trained NN evaluator + alpha-beta search to pick moves,
then translates them back into live game engine calls.
"""

import json
import time
import os

from simboard import SimBoard, NODE_ORDER, POSITIONS, ADJACENCY, CORE_SPELLS
from nn_evaluator import SigilEvalNet
from search import iterative_deepening_search, _apply_turn


# Default model paths
_DIR = os.path.dirname(__file__)
MODEL_PATH = os.path.join(_DIR, 'models', 'eval_v1.json')
GENOME_PATH = os.path.join(_DIR, 'models', 'best_genome.json')


def _live_board_to_simboard(board):
    """Convert a live SPBoard to a SimBoard."""
    spell_names = [board.spells[i].name for i in range(9)]
    sim = SimBoard(spell_names)

    for name in NODE_ORDER:
        sim.stones[name] = board.nodes[name].stone

    sim.turn_counter = board.turncounter
    sim.whose_turn = board.whoseturn
    sim.score = board.score

    sim.spell_counter['red'] = board.redplayer.spellcounter
    sim.spell_counter['blue'] = board.blueplayer.spellcounter

    sim.lock['red'] = board.redplayer.lock.name if board.redplayer.lock else None
    sim.lock['blue'] = board.blueplayer.lock.name if board.blueplayer.lock else None

    sim.springlock['red'] = board.redplayer.springlock.name if board.redplayer.springlock else None
    sim.springlock['blue'] = board.blueplayer.springlock.name if board.blueplayer.springlock else None

    sim.update()
    return sim


class NNAIPlayer:
    """AI player that uses neural network + alpha-beta search.

    Drop-in replacement for AIPlayer in single-player games.
    """

    def __init__(self, board, color, model_path=None, genome_path=None,
                 search_depth=2, time_limit=5.0):
        self.ishuman = False
        self.board = board
        self.color = color
        self.enemy = 'blue' if color == 'red' else 'red'

        self.totalstones = 0
        self.charged_spells = []
        self.mana = 0
        self.lock = None
        self.springlock = None
        self.spellcounter = 0
        self.opp = None

        self.search_depth = search_depth
        self.time_limit = time_limit

        # Load the NN model
        nn_path = model_path or MODEL_PATH
        if os.path.exists(nn_path):
            self.model = SigilEvalNet.load(nn_path)
        else:
            self.model = SigilEvalNet()

        # Load the evolved genome for strategic turn selection
        self.genetic_policy = None
        gp = genome_path or GENOME_PATH
        if os.path.exists(gp):
            from genetic import GeneticPolicy, load_genome
            genome = load_genome(gp)
            self.genetic_policy = GeneticPolicy(genome)

    def taketurn(self, canmove=True, candash=True, canspell=True,
                 cansummer=True):
        """Take a full turn using evolved strategy + NN search."""
        self.board.update()
        time.sleep(1)  # Realistic delay

        # Convert live board to SimBoard
        sim = _live_board_to_simboard(self.board)

        best_turn = None

        if self.genetic_policy:
            # Use evolved genome to pick the turn — it evaluates all
            # legal turns using the evolved weight vector
            genetic_turn = self.genetic_policy.choose_turn(sim, self.color)

            # Also run NN search for comparison
            nn_score, nn_turn = iterative_deepening_search(
                sim, self.color, self.model,
                max_depth=self.search_depth,
                time_limit=self.time_limit)

            # Use the genetic turn but verify with NN — pick whichever
            # the NN rates higher after application
            if nn_turn is not None and genetic_turn is not None:
                sim_g = sim.copy()
                _apply_turn(sim_g, genetic_turn, self.color)
                sim_g.update()
                g_eval = self.model.evaluate(sim_g, self.color)

                sim_n = sim.copy()
                _apply_turn(sim_n, nn_turn, self.color)
                sim_n.update()
                n_eval = self.model.evaluate(sim_n, self.color)

                best_turn = genetic_turn if g_eval >= n_eval else nn_turn
            else:
                best_turn = genetic_turn or nn_turn
        else:
            # Fallback: NN search only
            score, best_turn = iterative_deepening_search(
                sim, self.color, self.model,
                max_depth=self.search_depth,
                time_limit=self.time_limit)

        if best_turn is None:
            return None

        # Execute the chosen turn on the live board
        self._execute_turn(best_turn)

    def _execute_turn(self, turn):
        """Translate CompleteTurn actions into live game engine calls."""
        for action in turn.actions:
            time.sleep(1)

            if action.type == 'move':
                self._execute_soft_move(action.node)

            elif action.type == 'hard_move':
                self.board.record('hard_move', node=action.node, pushed_to='pending')
                self._execute_push(action.node)

            elif action.type == 'blink':
                if self.board.nodes[action.node].stone == self.enemy:
                    self.board.record('blink', node=action.node)
                    self._execute_push(action.node)
                else:
                    self._execute_blink_soft(action.node)

            elif action.type == 'cast':
                spell_name = action.spell
                self.board.record('cast', spell=spell_name)
                self.board.spelldict[spell_name].cast(self)

            elif action.type == 'dash':
                self._execute_dash(action.sacrificed or [])

            elif action.type == 'dash_lightning':
                self._execute_dash_lightning(action.sacrificed or [])

            elif action.type == 'pass':
                pass  # End of turn

    def _execute_soft_move(self, node_name):
        """Place a stone on an empty node."""
        node = self.board.nodes[node_name]
        node.stone = self.color
        self.board.record('move', node=node_name)

        egress = {"type": "new_stone_animation", "color": self.color,
                  "node": node_name}
        self.opp.ws.send(json.dumps(egress))

        self.board.last_play = node_name
        self.board.last_player = self.color
        self.board.update()

    def _execute_blink_soft(self, node_name):
        """Blink to an empty node."""
        node = self.board.nodes[node_name]
        node.stone = self.color
        self.board.record('blink', node=node_name)

        egress = {"type": "new_stone_animation", "color": self.color,
                  "node": node_name}
        self.opp.ws.send(json.dumps(egress))

        self.board.last_play = node_name
        self.board.last_player = self.color
        self.board.update()

    def _execute_push(self, node_name):
        """Push an enemy stone at node_name."""
        node = self.board.nodes[node_name]
        node.stone = self.color

        egress = {"type": "new_stone_animation", "color": self.color,
                  "node": node_name}
        self.opp.ws.send(json.dumps(egress))

        self.board.last_play = node_name
        self.board.last_player = self.color
        self.board.update()

        # Find push destination using BFS (same as live game engine)
        pushingqueue = [(x, 1) for x in node.neighbors]
        pushingoptions = []
        alreadyvisited = [node]

        while pushingoptions == []:
            if pushingqueue == []:
                # Crush
                egress = {"type": "crush_animation",
                          "crushed_color": self.enemy, "node": node_name}
                self.opp.ws.send(json.dumps(egress))
                self.board.update()
                return

            nextpair = pushingqueue.pop(0)
            nextnode, distance = nextpair
            alreadyvisited.append(nextnode)
            if nextnode.stone == self.color:
                continue
            elif nextnode.stone == self.enemy:
                for neighbor in nextnode.neighbors:
                    if neighbor not in alreadyvisited:
                        pushingqueue.append((neighbor, distance + 1))
                continue
            else:
                pushingoptions.append(nextnode)
                shortestdistance = distance

        # Find remaining options at same distance
        while pushingqueue != []:
            nextpair = pushingqueue.pop(0)
            nextnode, distance = nextpair
            if distance > shortestdistance:
                break
            if nextnode.stone is None:
                pushingoptions.append(nextnode)

        # Pick first option
        push = pushingoptions[0].name
        self.board.nodes[push].stone = self.enemy

        egress = {"type": "push_animation", "pushed_color": self.enemy,
                  "starting_node": node_name, "ending_node": push}
        self.opp.ws.send(json.dumps(egress))
        self.board.update()

    def _execute_dash(self, sacrificed_nodes):
        """Execute a regular dash (sacrifice 2 stones, then move)."""
        self.opp.jmessage("Opponent dashes!")
        time.sleep(1)

        # If the search didn't specify sacrifices, pick the least valuable
        if not sacrificed_nodes:
            sacrificed_nodes = []
            for name in reversed(NODE_ORDER):
                if self.board.nodes[name].stone == self.color:
                    sacrificed_nodes.append(name)
                    if len(sacrificed_nodes) == 2:
                        break

        for sac in sacrificed_nodes:
            self.board.nodes[sac].stone = None
            if self.board.last_play == sac:
                self.board.last_play = None
                self.board.last_player = None
            self.board.update()
            time.sleep(1)

    def _execute_dash_lightning(self, sacrificed_nodes):
        """Execute a lightning dash (sacrifice 1 stone, then move)."""
        self.opp.jmessage("Opponent dashes!")
        time.sleep(1)

        if not sacrificed_nodes:
            for name in reversed(NODE_ORDER):
                if self.board.nodes[name].stone == self.color:
                    sacrificed_nodes = [name]
                    break

        for sac in sacrificed_nodes:
            self.board.nodes[sac].stone = None
            if self.board.last_play == sac:
                self.board.last_play = None
                self.board.last_player = None
            self.board.update()
            time.sleep(1)

    # ---- Methods required by the game engine ----

    def jmessage(self, message, awaiting=None):
        """AI doesn't receive messages, but the interface needs this."""
        pass

    def bot_triggers(self):
        if 'Inferno' in [spell.name for spell in self.charged_spells]:
            self.board.humanplayer.jmessage("DEATH BY INFERNO!")
            self.board.gameover = True
            self.board.winner = self.enemy

    def eot_triggers(self):
        if 'Inferno' in [spell.name for spell in self.charged_spells]:
            self.board.humanplayer.jmessage("INFERNO TRIGGER!")
            for name in self.board.nodes:
                node = self.board.nodes[name]
                if node.stone == self.enemy:
                    for neighbor in node.neighbors:
                        if neighbor.stone == self.color:
                            node.stone = None
                            if self.board.last_play == node.name:
                                self.board.last_play = None
                                self.board.last_player = None
            self.board.update()

        redtotal = 0
        bluetotal = 1
        for name in self.board.nodes:
            color = self.board.nodes[name].stone
            if color == 'red':
                redtotal += 1
            elif color == 'blue':
                bluetotal += 1

        if redtotal > bluetotal + 2:
            self.board.gameover = True
            self.board.winner = 'red'
        elif bluetotal > redtotal + 2:
            self.board.gameover = True
            self.board.winner = 'blue'
        else:
            if self.spellcounter >= 6:
                self.board.gameover = True
                if redtotal > bluetotal:
                    self.board.winner = 'red'
                elif bluetotal > redtotal:
                    self.board.winner = 'blue'
                else:
                    a = ['red', 'blue']
                    a.remove(self.board.whoseturn)
                    self.board.winner = a[0]

        self.board.update()

    # Node listing methods used by spellfile.py when casting spells for AI
    def allmoveablenodes(self):
        answer = []
        for name in NODE_ORDER:
            node = self.board.nodes[name]
            if node.stone != self.color:
                for neighbor in node.neighbors:
                    if neighbor.stone == self.color:
                        answer.append(node)
                        break
        return answer

    def allsoftmoveablenodes(self):
        answer = []
        for name in NODE_ORDER:
            node = self.board.nodes[name]
            if node.stone is None:
                for neighbor in node.neighbors:
                    if neighbor.stone == self.color:
                        answer.append(node)
                        break
        return answer

    def allhardmoveablenodes(self, hardmove_spell_nodes=None):
        if hardmove_spell_nodes is None:
            hardmove_spell_nodes = []
        answer = []
        for name in NODE_ORDER:
            node = self.board.nodes[name]
            if node.stone == self.enemy:
                for neighbor in node.neighbors:
                    if neighbor not in hardmove_spell_nodes:
                        if neighbor.stone == self.color:
                            answer.append(node)
                            break
        return answer

    def allblinkablenodes(self):
        answer = []
        for name in NODE_ORDER:
            node = self.board.nodes[name]
            if node.stone != self.color:
                answer.append(node)
        return answer

    # Priority order used by spell resolution (e.g., Bewitch)
    @property
    def priority_order(self):
        if self.color == 'red':
            return ['b1', 'c1', 'a1',
                'b10', 'b8', 'b9', 'b2', 'b3', 'b4', 'b6', 'b5', 'b7',
                'c10', 'c8', 'c9', 'c2', 'c3', 'c4', 'c6', 'c5', 'c7',
                'a10', 'a8', 'a9', 'a2', 'a3', 'a4', 'a6', 'a5', 'a7',
                'b11', 'b12', 'b13', 'c11', 'c12', 'c13', 'a11', 'a12', 'a13']
        else:
            return ['a1', 'c1', 'b1',
                'a10', 'a8', 'a9', 'a2', 'a3', 'a4', 'a6', 'a5', 'a7',
                'c10', 'c8', 'c9', 'c2', 'c3', 'c4', 'c6', 'c5', 'c7',
                'b10', 'b8', 'b9', 'b2', 'b3', 'b4', 'b6', 'b5', 'b7',
                'a11', 'a12', 'a13', 'c11', 'c12', 'c13', 'b11', 'b12', 'b13']

    @property
    def bewitch_priority_order(self):
        return self.priority_order

    # Methods used by spellfile.py for AI spell resolution
    def move(self, standardmove=False):
        """Make a move (used by spell resolution like Surge)."""
        time.sleep(1)
        legalmoves = self.allmoveablenodes()
        if not legalmoves:
            return
        node = legalmoves[0]
        if node.stone is None:
            self._execute_soft_move(node.name)
        else:
            self._execute_push(node.name)

    def softmove(self, dumb_move_nodes=None):
        """Make a soft move (used by Flourish, Grow, Sprout, etc.)."""
        if dumb_move_nodes is None:
            dumb_move_nodes = []
        legalmoves = self.allsoftmoveablenodes()
        if not legalmoves:
            return
        time.sleep(1)
        if self.lock:
            dumb_move_nodes += self.lock.position

        node = None
        for potential_node in legalmoves:
            if potential_node not in dumb_move_nodes:
                node = potential_node
                break
        if node is None:
            node = legalmoves[0]

        self._execute_soft_move(node.name)

    def hardmove(self):
        """Make a hard move (used by Carnage, Slash)."""
        legalmoves = self.allhardmoveablenodes()
        if not legalmoves:
            return
        time.sleep(1)
        node = legalmoves[0]
        self._execute_push(node.name)

    def pushenemy(self, node):
        """Push an enemy stone (used by spellfile.py)."""
        self._execute_push(node.name)
