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
from ai.mcts import mcts_search
from ai.config import NUM_SIMS_PLAY, MODELS_DIR


# Default model path
_DEFAULT_MODEL = os.path.join(MODELS_DIR, 'best_model.pt')


class MCTSAIPlayer(NNAIPlayer):
    """AI player using MCTS + SigilNet.

    Drop-in replacement for NNAIPlayer. Inherits all game engine
    interface methods (_execute_turn, pushenemy, softmove, etc.)
    and only overrides taketurn() with MCTS search.
    """

    def __init__(self, board, color, model_path=None, time_limit=8.0,
                 num_simulations=None, **kwargs):
        # Initialize the base NNAIPlayer (loads genetic policy + old NN as fallback)
        super().__init__(board, color, **kwargs)

        self.time_limit = time_limit
        self.num_simulations = num_simulations or NUM_SIMS_PLAY

        # Load SigilNet (PyTorch model)
        self.sigil_net = None
        mpath = model_path or _DEFAULT_MODEL
        if os.path.exists(mpath):
            try:
                self.sigil_net = SigilNet.load(mpath)
                self.sigil_net.eval()
            except Exception:
                self.sigil_net = None

        # If no trained model exists yet, use a fresh random network
        # (still better than nothing — MCTS explores regardless)
        if self.sigil_net is None:
            self.sigil_net = SigilNet()
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
