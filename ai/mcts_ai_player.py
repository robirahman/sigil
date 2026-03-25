"""MCTS AI player for Sigil.

Uses SigilNet + Monte Carlo Tree Search for move selection.
Inherits from NNAIPlayer for all live game engine integration
(_execute_turn, pushenemy, softmove, etc.).
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nn_ai_player import NNAIPlayer, _live_board_to_simboard
from ai.sigil_net import SigilNet
from ai.sigil_net_hard import SigilNetHard
from ai.mcts import mcts_search
from ai.config import NUM_SIMS_PLAY, MODELS_DIR


# Model paths by difficulty
_MEDIUM_MODEL = os.path.join(MODELS_DIR, 'best_model.pt')
_HARD_MODEL = os.path.join(MODELS_DIR, 'best_model_hard.pt')


class MCTSAIPlayer(NNAIPlayer):
    """AI player using MCTS + SigilNet.

    Drop-in replacement for NNAIPlayer. Inherits all game engine
    interface methods (_execute_turn, pushenemy, softmove, etc.)
    and only overrides taketurn() with MCTS search.

    Args:
        net_class: SigilNet (medium/2M) or SigilNetHard (hard/44M)
        model_path: path to model checkpoint
    """

    def __init__(self, board, color, model_path=None, net_class=None,
                 time_limit=8.0, num_simulations=None, **kwargs):
        super().__init__(board, color, **kwargs)

        self.time_limit = time_limit
        self.num_simulations = num_simulations or NUM_SIMS_PLAY

        if net_class is None:
            net_class = SigilNet
        if model_path is None:
            model_path = _HARD_MODEL if net_class is SigilNetHard else _MEDIUM_MODEL

        # Load the appropriate SigilNet variant
        self.sigil_net = None
        if os.path.exists(model_path):
            try:
                self.sigil_net = net_class.load(model_path)
                self.sigil_net.eval()
            except Exception:
                self.sigil_net = None

        if self.sigil_net is None:
            self.sigil_net = net_class()
            self.sigil_net.eval()

    def taketurn(self, canmove=True, candash=True, canspell=True,
                 cansummer=True):
        """Take a full turn using MCTS search."""
        self.board.update()
        time.sleep(1)  # Realistic delay

        # Convert live board to SimBoard
        sim = _live_board_to_simboard(self.board)

        # Run MCTS
        best_turn, policy, value = mcts_search(
            sim, self.color, self.sigil_net,
            num_simulations=self.num_simulations,
            time_limit=self.time_limit,
            add_noise=False,
            temperature=None,  # Greedy in production
        )

        if best_turn is None:
            return None

        # Execute the chosen turn on the live board
        # (inherited from NNAIPlayer)
        self._execute_turn(best_turn)
