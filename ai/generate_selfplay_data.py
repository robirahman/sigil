"""Generate self-play training data from Easy-vs-Easy, Easy-vs-Medium,
and Medium-vs-Medium games using SimBoard.

Outputs JSONL in the same format as import_human_games.py.
"""
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simboard import SimBoard
from ai.search import _apply_turn
from ai.selfplay import random_core_spells
from ai.sigil_net import SigilNet
from ai.mcts import mcts_search
from ai.features import board_to_tensor, encode_all_turns
from ai.config import MAX_TURNS, MODELS_DIR, SPELL_TO_ID

# Easy AI priority orders (from singleplayergame.py)
PRIORITY_RED = [
    'b1','c1','a1','b10','b8','b9','b2','b3','b4','b6','b5','b7',
    'c10','c8','c9','c2','c3','c4','c6','c5','c7',
    'a10','a8','a9','a2','a3','a4','a6','a5','a7',
    'b11','b12','b13','c11','c12','c13','a11','a12','a13',
]
PRIORITY_BLUE = [
    'a1','c1','b1','a10','a8','a9','a2','a3','a4','a6','a5','a7',
    'c10','c8','c9','c2','c3','c4','c6','c5','c7',
    'b10','b8','b9','b2','b3','b4','b6','b5','b7',
    'a11','a12','a13','c11','c12','c13','b11','b12','b13',
]


def pick_easy_turn(board, color):
    priority = PRIORITY_RED if color == 'red' else PRIORITY_BLUE
    priority_rank = {node: i for i, node in enumerate(priority)}
    legal_turns = list(board.get_legal_turns(color))
    if not legal_turns:
        return None, legal_turns

    best_turn = None
    best_rank = 999
    best_idx = 0
    for idx, turn in enumerate(legal_turns):
        first = turn.actions[0]
        if first.type == 'pass':
            if best_turn is None:
                best_turn = turn
                best_idx = idx
            continue
        rank = priority_rank.get(first.node, 999)
        has_cast = any(a.type == 'cast' for a in turn.actions)
        if has_cast:
            rank -= 100
        if rank < best_rank:
            best_rank = rank
            best_turn = turn
            best_idx = idx

    return best_idx, legal_turns


def make_position(board, color, turn_idx, legal_turns, outcome):
    """Create a training position dict."""
    spell_ids = [SPELL_TO_ID.get(board.spell_names[i], 0) for i in range(9)]
    raw, _ = board_to_tensor(board, color)
    turn_feats = encode_all_turns(legal_turns, board, color)

    policy = np.zeros(len(legal_turns), dtype=np.float32)
    policy[turn_idx] = 1.0

    return {
        'sfn': board.to_sfn(),
        'spell_ids': spell_ids,
        'raw_features': raw.numpy().tolist(),
        'policy': policy.tolist(),
        'turn_encodings': turn_feats.numpy().tolist(),
        'outcome': outcome,
    }


def play_game(red_player, blue_player, model, sims=200):
    """Play one game. red_player/blue_player are 'easy' or 'medium'.
    Returns (winner, positions_list).
    """
    spells = random_core_spells()
    board = SimBoard(spells)
    board.setup_initial()

    # Record positions for both sides before applying turns
    red_positions = []  # (board_copy, color, turn_idx, legal_turns)
    blue_positions = []

    turn_num = 0
    while not board.gameover and turn_num < MAX_TURNS:
        turn_num += 1
        board.turn_counter = turn_num
        color = 'red' if turn_num % 2 == 1 else 'blue'
        board.whose_turn = color

        player = red_player if color == 'red' else blue_player

        if player == 'easy':
            turn_idx, legal_turns = pick_easy_turn(board, color)
            if turn_idx is None:
                break
            best_turn = legal_turns[turn_idx]
        else:
            legal_turns = list(board.get_legal_turns(color))
            best_turn, _, _ = mcts_search(
                board, color, model,
                num_simulations=sims,
                add_noise=True,
                temperature=None,
            )
            # Find which legal turn was chosen
            turn_idx = 0
            for i, lt in enumerate(legal_turns):
                if lt is best_turn:
                    turn_idx = i
                    break

        # Save position before applying
        if color == 'red':
            red_positions.append((board.copy(), color, turn_idx, legal_turns))
        else:
            blue_positions.append((board.copy(), color, turn_idx, legal_turns))

        _apply_turn(board, best_turn, color)
        board.update()
        board.check_game_over(color)

        if not board.gameover:
            board.advance_turn()

    # Determine winner
    if turn_num >= MAX_TURNS and not board.gameover:
        board.update()
        r, b = board.totalstones['red'], board.totalstones['blue'] + 1
        if r > b:
            winner = 'red'
        elif b > r:
            winner = 'blue'
        else:
            winner = None
    else:
        winner = board.winner

    # Convert to training positions with outcomes
    positions = []
    for saved_board, col, tidx, lturns in red_positions + blue_positions:
        if winner == col:
            outcome = 1.0
        elif winner is not None:
            outcome = -1.0
        else:
            outcome = 0.0
        positions.append(make_position(saved_board, col, tidx, lturns, outcome))

    return winner, positions


def main():
    num_easy_easy = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    num_easy_medium = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    num_medium_medium = int(sys.argv[3]) if len(sys.argv) > 3 else 50
    sims = 200

    model_path = os.path.join(MODELS_DIR, 'best_model.pt')
    print(f"Loading model from {model_path}")
    model = SigilNet.load(model_path)
    model.eval()

    output_path = 'ai/data/selfplay_synthetic.jsonl'
    os.makedirs('ai/data', exist_ok=True)
    total_positions = 0
    start = time.time()

    with open(output_path, 'w') as f:
        # Easy vs Easy
        print(f"\n--- Easy vs Easy ({num_easy_easy} games) ---")
        for i in range(num_easy_easy):
            winner, positions = play_game('easy', 'easy', model, sims)
            for pos in positions:
                f.write(json.dumps(pos) + '\n')
                total_positions += 1
            if (i + 1) % 10 == 0:
                print(f"  {i+1}/{num_easy_easy} games, {total_positions} positions [{time.time()-start:.0f}s]")

        # Easy vs Medium (alternate colors)
        print(f"\n--- Easy vs Medium ({num_easy_medium} games) ---")
        for i in range(num_easy_medium):
            if i % 2 == 0:
                winner, positions = play_game('easy', 'medium', model, sims)
            else:
                winner, positions = play_game('medium', 'easy', model, sims)
            for pos in positions:
                f.write(json.dumps(pos) + '\n')
                total_positions += 1
            if (i + 1) % 10 == 0:
                print(f"  {i+1}/{num_easy_medium} games, {total_positions} positions [{time.time()-start:.0f}s]")

        # Medium vs Medium
        print(f"\n--- Medium vs Medium ({num_medium_medium} games) ---")
        for i in range(num_medium_medium):
            winner, positions = play_game('medium', 'medium', model, sims)
            for pos in positions:
                f.write(json.dumps(pos) + '\n')
                total_positions += 1
            if (i + 1) % 10 == 0:
                print(f"  {i+1}/{num_medium_medium} games, {total_positions} positions [{time.time()-start:.0f}s]")

    elapsed = time.time() - start
    print(f"\nGenerated {total_positions} positions from "
          f"{num_easy_easy + num_easy_medium + num_medium_medium} games in {elapsed:.0f}s")
    print(f"Output: {output_path}")


if __name__ == '__main__':
    main()
