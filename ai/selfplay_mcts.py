"""Self-play data generation using MCTS for training SigilNet.

Generates (board_state, MCTS_policy, game_outcome) training data.

Usage:
    python -m ai.selfplay_mcts --games 1000 --output ai/data/selfplay_001.jsonl
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import torch

from simboard import SimBoard
from search import _apply_turn
from selfplay import random_core_spells

from ai.sigil_net import SigilNet
from ai.mcts import mcts_search
from ai.features import board_to_tensor, encode_all_turns
from ai.config import (
    NUM_SIMS_TRAIN, TEMP_THRESHOLD, MAX_TURNS,
    MODELS_DIR, DATA_DIR, SPELL_TO_ID,
)


def play_selfplay_game(model, num_simulations=None):
    """Play a single self-play game using MCTS.

    Returns list of (sfn, spell_ids, turn_encodings, policy, side_to_move) tuples
    and the game winner.
    """
    if num_simulations is None:
        num_simulations = NUM_SIMS_TRAIN

    spells = random_core_spells()
    board = SimBoard(spells)
    board.setup_initial()

    positions = []
    turn_num = 0

    while not board.gameover and turn_num < MAX_TURNS:
        turn_num += 1
        board.turn_counter = turn_num
        color = 'red' if turn_num % 2 == 1 else 'blue'
        board.whose_turn = color

        # Temperature: explore early, exploit late
        temp = 1.0 if turn_num <= TEMP_THRESHOLD else 0.1

        # Run MCTS
        best_turn, policy, value = mcts_search(
            board, color, model,
            num_simulations=num_simulations,
            add_noise=True,
            temperature=temp,
        )

        # Record position data
        sfn = board.to_sfn()
        spell_ids = [SPELL_TO_ID.get(board.spell_names[i], 0) for i in range(9)]

        # Store legal turns and policy
        legal_turns = list(board.get_legal_turns(color))
        turn_feats = encode_all_turns(legal_turns, board, color)

        positions.append({
            'sfn': sfn,
            'spell_ids': spell_ids,
            'policy': policy.tolist(),
            'turn_encodings': turn_feats.numpy().tolist(),
            'side': color,
        })

        # Apply the chosen turn
        _apply_turn(board, best_turn, color)
        board.update()
        board.check_game_over(color)

        if not board.gameover:
            board.advance_turn()

    # Determine outcome
    if turn_num >= MAX_TURNS and not board.gameover:
        board.update()
        if board.totalstones['red'] > board.totalstones['blue'] + 1:
            board.winner = 'red'
        elif board.totalstones['blue'] + 1 > board.totalstones['red']:
            board.winner = 'blue'
        else:
            board.winner = None

    return positions, board.winner


def generate_training_data(model, num_games, output_path, num_simulations=None):
    """Generate training data from self-play games.

    Writes JSONL with fields: sfn, spell_ids, policy, turn_encodings, outcome
    """
    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else '.',
                exist_ok=True)

    total_positions = 0
    start_time = time.time()

    with open(output_path, 'w') as f:
        for game_idx in range(num_games):
            game_start = time.time()
            positions, winner = play_selfplay_game(model, num_simulations)
            game_time = time.time() - game_start

            for pos in positions:
                side = pos['side']
                # Outcome from side-to-move perspective: +1 win, -1 loss, 0 draw
                if winner == side:
                    outcome = 1.0
                elif winner is not None:
                    outcome = -1.0
                else:
                    outcome = 0.0

                record = {
                    'sfn': pos['sfn'],
                    'spell_ids': pos['spell_ids'],
                    'policy': pos['policy'],
                    'turn_encodings': pos['turn_encodings'],
                    'outcome': outcome,
                }
                f.write(json.dumps(record) + '\n')
                total_positions += 1

            if (game_idx + 1) % 10 == 0 or game_idx == 0:
                elapsed = time.time() - start_time
                rate = (game_idx + 1) / elapsed * 60
                print(f"Game {game_idx+1}/{num_games}: "
                      f"{len(positions)} positions, winner={winner}, "
                      f"{game_time:.1f}s, {rate:.1f} games/min",
                      flush=True)

    elapsed = time.time() - start_time
    print(f"\nGenerated {total_positions} positions from {num_games} games "
          f"in {elapsed:.0f}s ({total_positions/num_games:.0f} pos/game avg)")
    return total_positions


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Generate MCTS self-play training data')
    parser.add_argument('--games', type=int, default=100)
    parser.add_argument('--sims', type=int, default=NUM_SIMS_TRAIN)
    parser.add_argument('--model', type=str, default=None,
                        help='Path to model checkpoint')
    parser.add_argument('--output', type=str, default=None)
    args = parser.parse_args()

    # Load or create model
    if args.model and os.path.exists(args.model):
        model = SigilNet.load(args.model)
    else:
        model = SigilNet.load_or_create()
    model.eval()

    if args.output is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        args.output = os.path.join(DATA_DIR, f'selfplay_{int(time.time())}.jsonl')

    generate_training_data(model, args.games, args.output, args.sims)
    print(f"Data saved to {args.output}")
