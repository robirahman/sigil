"""Arena script for minimax vs MCTS comparison.

Each game: one side runs `minimax_search` (iterative-deepening alpha-beta),
the other runs the production `mcts_search`. Both use the same model.
Tests whether decision-time tactical search outperforms sample-based MCTS
at equal model strength.

Run:
    python -m ai.arena_minimax --games 16 --depth 3 --time 5.0
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simboard import SimBoard
from search import _apply_turn
from selfplay import random_core_spells

from ai.config import MAX_TURNS, MODELS_DIR
from ai.mcts import mcts_search
from ai.minimax_ai import minimax_search


def _load_model(path):
    import torch
    from ai.sigil_net import SigilNet
    from ai.sigil_net_graph import SigilNetGraph
    ckpt = torch.load(path, map_location='cpu', weights_only=True)
    if ckpt.get('arch') == 'SigilNetGraph':
        return SigilNetGraph.load(path)
    return SigilNet.load(path)


def play_one_game(model, minimax_red, sims_per_move, depth, time_limit,
                  strategic_alpha, exhaustive_root=False, opponent='mcts',
                  opponent_depth=3, opponent_time=4.0):
    """Returns 'red' / 'blue' / None.

    minimax_red: True if red plays the experimental minimax, False if blue.
    opponent: 'mcts' (default) or 'minimax_greedy' — what the other side plays.
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

        is_test_side = (minimax_red and color == 'red') or \
                       ((not minimax_red) and color == 'blue')
        if is_test_side:
            best = minimax_search(board, color, model,
                                  time_limit=time_limit, max_depth=depth,
                                  ordering_alpha=strategic_alpha,
                                  exhaustive_root=exhaustive_root)
        elif opponent == 'minimax_greedy':
            best = minimax_search(board, color, model,
                                  time_limit=opponent_time,
                                  max_depth=opponent_depth,
                                  ordering_alpha=strategic_alpha,
                                  exhaustive_root=False)
        else:
            best, _, _ = mcts_search(board, color, model,
                                     num_simulations=sims_per_move,
                                     add_noise=False, temperature=None,
                                     strategic_alpha=strategic_alpha)

        _apply_turn(board, best, color)
        board.update()
        board.check_game_over(color)
        if not board.gameover:
            board.advance_turn()

    if board.gameover:
        return board.winner
    board.update()
    if board.totalstones['red'] > board.totalstones['blue'] + 1:
        return 'red'
    if board.totalstones['blue'] + 1 > board.totalstones['red']:
        return 'blue'
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=os.path.join(MODELS_DIR, 'best_model.pt'))
    ap.add_argument('--games', type=int, default=16)
    ap.add_argument('--sims', type=int, default=200)
    ap.add_argument('--depth', type=int, default=3)
    ap.add_argument('--time', type=float, default=5.0)
    ap.add_argument('--strategic-alpha', type=float, default=1.0)
    ap.add_argument('--exhaustive-root', action='store_true',
                    help='Test side enumerates every dash/spell variant at root')
    ap.add_argument('--opponent', default='mcts',
                    choices=['mcts', 'minimax_greedy'])
    ap.add_argument('--opponent-depth', type=int, default=3)
    ap.add_argument('--opponent-time', type=float, default=4.0)
    args = ap.parse_args()

    model = _load_model(args.model)
    model.eval()
    test_label = (
        f'Minimax(depth={args.depth}, time={args.time}s'
        f'{", exhaustive_root" if args.exhaustive_root else ""})'
    )
    if args.opponent == 'mcts':
        opp_label = f'MCTS(sims={args.sims})'
    else:
        opp_label = f'Minimax(depth={args.opponent_depth}, time={args.opponent_time}s)'
    print(f'{test_label} vs {opp_label} (alpha={args.strategic_alpha}) — model {args.model}')

    minimax_wins = 0
    mcts_wins = 0
    draws = 0
    start = time.time()

    for i in range(args.games):
        # Alternate which color is minimax
        minimax_red = (i % 2 == 0)
        winner = play_one_game(model, minimax_red,
                               sims_per_move=args.sims,
                               depth=args.depth, time_limit=args.time,
                               strategic_alpha=args.strategic_alpha,
                               exhaustive_root=args.exhaustive_root,
                               opponent=args.opponent,
                               opponent_depth=args.opponent_depth,
                               opponent_time=args.opponent_time)
        minimax_color = 'red' if minimax_red else 'blue'
        if winner == minimax_color:
            minimax_wins += 1
        elif winner is None:
            draws += 1
        else:
            mcts_wins += 1

        elapsed = time.time() - start
        rate = minimax_wins / max(1, minimax_wins + mcts_wins + draws)
        print(f'  Game {i+1}/{args.games}: minimax={minimax_wins} mcts={mcts_wins} '
              f'D={draws} (minimax rate={rate:.3f}) [{elapsed:.0f}s]', flush=True)

    total = minimax_wins + mcts_wins + draws
    rate = minimax_wins / max(1, total)
    print(f'\nResult: minimax W={minimax_wins} L={mcts_wins} D={draws} '
          f'(rate={rate:.3f})')


if __name__ == '__main__':
    main()
