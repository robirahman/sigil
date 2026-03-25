"""Model-vs-model arena for gating evaluation.

Plays games between two SigilNet models using MCTS to determine
if a new model is stronger than the current best.

Usage:
    python -m ai.arena --model1 ai/models/best_model.pt --model2 ai/models/candidate.pt --games 100
"""

import argparse
import os
import sys
import time
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simboard import SimBoard
from search import _apply_turn
from selfplay import random_core_spells

from ai.sigil_net import SigilNet
from ai.sigil_net_hard import SigilNetHard
from ai.mcts import mcts_search
from ai.config import MAX_TURNS, GATE_THRESHOLD, GATE_GAMES, MODELS_DIR


def play_arena_game(model1, model2, sims_per_move=200):
    """Play a single game: model1 as red, model2 as blue.

    Returns: 'red', 'blue', or None (draw).
    """
    spells = random_core_spells()
    board = SimBoard(spells)
    board.setup_initial()

    turn_num = 0
    while not board.gameover and turn_num < MAX_TURNS:
        turn_num += 1
        board.turn_counter = turn_num
        color = 'red' if turn_num % 2 == 1 else 'blue'
        board.whose_turn = color

        model = model1 if color == 'red' else model2
        best_turn, _, _ = mcts_search(
            board, color, model,
            num_simulations=sims_per_move,
            add_noise=False,
            temperature=None,
        )

        _apply_turn(board, best_turn, color)
        board.update()
        board.check_game_over(color)

        if not board.gameover:
            board.advance_turn()

    if turn_num >= MAX_TURNS and not board.gameover:
        board.update()
        if board.totalstones['red'] > board.totalstones['blue'] + 1:
            return 'red'
        elif board.totalstones['blue'] + 1 > board.totalstones['red']:
            return 'blue'
        return None

    return board.winner


def evaluate_models(model1, model2, num_games=None, sims_per_move=200):
    """Play num_games between two models, alternating colors.

    Returns: (model1_wins, model2_wins, draws, model1_win_rate)
    """
    if num_games is None:
        num_games = GATE_GAMES

    m1_wins = 0
    m2_wins = 0
    draws = 0

    start = time.time()

    for game_idx in range(num_games):
        # Alternate who plays red
        if game_idx % 2 == 0:
            red_model, blue_model = model1, model2
        else:
            red_model, blue_model = model2, model1

        winner = play_arena_game(red_model, blue_model, sims_per_move)

        if game_idx % 2 == 0:
            if winner == 'red':
                m1_wins += 1
            elif winner == 'blue':
                m2_wins += 1
            else:
                draws += 1
        else:
            if winner == 'red':
                m2_wins += 1
            elif winner == 'blue':
                m1_wins += 1
            else:
                draws += 1

        if (game_idx + 1) % 10 == 0:
            elapsed = time.time() - start
            total = m1_wins + m2_wins + draws
            rate = m1_wins / total if total > 0 else 0
            print(f"  Game {game_idx+1}/{num_games}: "
                  f"M1={m1_wins} M2={m2_wins} D={draws} "
                  f"(M1 rate={rate:.3f}) [{elapsed:.0f}s]",
                  flush=True)

    total = m1_wins + m2_wins + draws
    win_rate = m1_wins / total if total > 0 else 0.0
    return m1_wins, m2_wins, draws, win_rate


def _load_any_net(path):
    """Load a model checkpoint, auto-detecting architecture."""
    checkpoint = torch.load(path, map_location='cpu', weights_only=True)
    if checkpoint.get('arch') == 'SigilNetHard':
        return SigilNetHard.load(path)
    return SigilNet.load(path)


def gate_model(candidate_path, current_best_path=None, num_games=None,
               sims_per_move=200):
    """Test if candidate model is stronger than current best.

    Returns True if candidate should replace the current best.
    """
    if current_best_path is None:
        current_best_path = os.path.join(MODELS_DIR, 'best_model.pt')

    if not os.path.exists(current_best_path):
        print("No current best model — candidate accepted by default")
        return True

    print(f"Gating: {candidate_path} vs {current_best_path}")

    current = _load_any_net(current_best_path)
    current.eval()
    candidate = _load_any_net(candidate_path)
    candidate.eval()

    # Candidate is model1
    wins, losses, draws, win_rate = evaluate_models(
        candidate, current, num_games=num_games, sims_per_move=sims_per_move)

    print(f"\nResult: Candidate W={wins} L={losses} D={draws} "
          f"(win rate={win_rate:.3f}, threshold={GATE_THRESHOLD})")

    if win_rate >= GATE_THRESHOLD:
        print("ACCEPTED — candidate is the new best model")
        return True
    else:
        print("REJECTED — current best model retained")
        return False


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Model vs model arena')
    parser.add_argument('--model1', type=str, required=True,
                        help='Path to first model (candidate)')
    parser.add_argument('--model2', type=str, default=None,
                        help='Path to second model (current best)')
    parser.add_argument('--games', type=int, default=GATE_GAMES)
    parser.add_argument('--sims', type=int, default=200)
    args = parser.parse_args()

    accepted = gate_model(args.model1, args.model2,
                          num_games=args.games, sims_per_move=args.sims)
    sys.exit(0 if accepted else 1)
