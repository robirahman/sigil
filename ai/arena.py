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
from ai.search import _apply_turn
from ai.selfplay import random_core_spells

from ai.sigil_net import SigilNet
from ai.sigil_net_hard import SigilNetHard
from ai.sigil_net_graph import SigilNetGraph
from ai.mcts import mcts_search
from ai.config import MAX_TURNS, GATE_THRESHOLD, GATE_GAMES, MODELS_DIR


def play_arena_game(model1, model2, sims_per_move=200,
                    blunder_lambda1=0.0, blunder_lambda2=0.0,
                    strategic_alpha1=0.0, strategic_alpha2=0.0,
                    move_time_limit=None):
    """Play a single game: model1 as red, model2 as blue.

    `move_time_limit` (seconds, optional) caps per-move MCTS wall-clock.
    Without it, mid-game positions with explosive exhaustive enumeration
    can consume tens of minutes per move, making a 10-game gate take
    7+ hours. mcts_search exits whichever comes first — sims or budget.

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
        bl = blunder_lambda1 if color == 'red' else blunder_lambda2
        sa = strategic_alpha1 if color == 'red' else strategic_alpha2
        best_turn, _, _ = mcts_search(
            board, color, model,
            num_simulations=sims_per_move,
            time_limit=move_time_limit,
            add_noise=False,
            temperature=None,
            blunder_lambda=bl,
            strategic_alpha=sa,
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
        # Score perfectly tied at MAX_TURNS (red_total == blue_total + 1,
        # so red and blue+phantom are equal). Sigil has no draws under
        # the canonical rules; the in-engine 6-spell-counter tiebreak
        # awards the win to the side NOT to-move ("the player whose
        # turn it would be next has failed to break the tie"). Apply
        # the same rule here rather than returning None — `None` was
        # previously interpreted as a draw by callers, which Sigil
        # does not have.
        next_to_move = 'red' if turn_num % 2 == 0 else 'blue'
        return 'blue' if next_to_move == 'red' else 'red'

    return board.winner


def evaluate_models(model1, model2, num_games=None, sims_per_move=200,
                    blunder_lambda1=0.0, blunder_lambda2=0.0,
                    strategic_alpha1=0.0, strategic_alpha2=0.0,
                    move_time_limit=None):
    """Play num_games between two models, alternating colors.

    Returns: (model1_wins, model2_wins, draws, model1_win_rate)
    """
    if num_games is None:
        num_games = GATE_GAMES

    m1_wins = 0
    m2_wins = 0
    draws = 0

    start = time.time()
    # Per-game progress at finer granularity for small gates — a 10-
    # game gate would otherwise only print once.
    progress_every = max(1, num_games // 10)

    for game_idx in range(num_games):
        # Alternate who plays red
        if game_idx % 2 == 0:
            red_model, blue_model = model1, model2
            bl_red, bl_blue = blunder_lambda1, blunder_lambda2
            sa_red, sa_blue = strategic_alpha1, strategic_alpha2
        else:
            red_model, blue_model = model2, model1
            bl_red, bl_blue = blunder_lambda2, blunder_lambda1
            sa_red, sa_blue = strategic_alpha2, strategic_alpha1

        winner = play_arena_game(red_model, blue_model, sims_per_move,
                                 blunder_lambda1=bl_red,
                                 blunder_lambda2=bl_blue,
                                 strategic_alpha1=sa_red,
                                 strategic_alpha2=sa_blue,
                                 move_time_limit=move_time_limit)

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

        if (game_idx + 1) % progress_every == 0:
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
    arch = checkpoint.get('arch')
    if arch == 'SigilNetHard':
        return SigilNetHard.load(path)
    if arch == 'SigilNetGraph':
        return SigilNetGraph.load(path)
    return SigilNet.load(path)


def gate_model(candidate_path, current_best_path=None, num_games=None,
               sims_per_move=200, candidate_blunder_lambda=0.0,
               current_blunder_lambda=0.0, candidate_strategic_alpha=0.0,
               current_strategic_alpha=0.0, move_time_limit=None):
    """Test if candidate model is stronger than current best.

    `move_time_limit` (seconds, optional) caps per-move MCTS wall-clock
    so a gate run can't be wedged for hours by a single explosive
    mid-game position.

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
        candidate, current, num_games=num_games, sims_per_move=sims_per_move,
        blunder_lambda1=candidate_blunder_lambda,
        blunder_lambda2=current_blunder_lambda,
        strategic_alpha1=candidate_strategic_alpha,
        strategic_alpha2=current_strategic_alpha,
        move_time_limit=move_time_limit)

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
    parser.add_argument('--blunder-lambda1', type=float, default=0.0,
                        help='Blunder-head suppression strength for model1')
    parser.add_argument('--blunder-lambda2', type=float, default=0.0,
                        help='Blunder-head suppression strength for model2')
    parser.add_argument('--strategic-alpha1', type=float, default=0.0,
                        help='Strategic-evaluator bias strength for model1')
    parser.add_argument('--strategic-alpha2', type=float, default=0.0,
                        help='Strategic-evaluator bias strength for model2')
    parser.add_argument('--move-time-limit', type=float, default=None,
                        help='Per-move MCTS wall-clock cap (seconds). '
                             'Without this, mid-game positions with high '
                             'branching can consume tens of minutes per move; '
                             'a 10-game gate took 7+ hours uncapped. '
                             'Default: no limit.')
    args = parser.parse_args()

    accepted = gate_model(args.model1, args.model2,
                          num_games=args.games, sims_per_move=args.sims,
                          candidate_blunder_lambda=args.blunder_lambda1,
                          current_blunder_lambda=args.blunder_lambda2,
                          candidate_strategic_alpha=args.strategic_alpha1,
                          current_strategic_alpha=args.strategic_alpha2,
                          move_time_limit=args.move_time_limit)
    sys.exit(0 if accepted else 1)
