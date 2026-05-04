"""Phase A arena gate: TT+killers minimax vs vanilla minimax.

Plays N games head-to-head with the same v27 model under both engines,
alternating colors. The TT/killers side should reach >= 55% (gate
threshold from ai/config.py:GATE_THRESHOLD) to ship.

Usage:
    python -m ai.arena_minimax_tt --games 60 --time 12 --depth 3
"""

import argparse
import os
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simboard import SimBoard
from search import _apply_turn as _apply_turn_in_place
from selfplay import random_core_spells

from ai.sigil_net import SigilNet
from ai.minimax_ai import minimax_search
from ai.config import MAX_TURNS, MODELS_DIR


_VANILLA_OPTS = dict(
    exhaustive_root=True, exhaustive_opponent=False,
    enable_tt=False, enable_killers=False, aspiration_delta=0.0,
)
_PHASE_ABC_OPTS = dict(
    exhaustive_root=True, exhaustive_opponent=True,
    enable_tt=True, enable_killers=True, aspiration_delta=0.15,
)


def play_one_game(model, time_limit, max_depth, red_opts, blue_opts):
    """Play a single game between two minimax instances on the same model.

    `red_opts` / `blue_opts` are dicts of minimax_search kwargs.
    Returns 'red' / 'blue' / None (draw).
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

        opts = red_opts if color == 'red' else blue_opts
        best_turn = minimax_search(
            board, color, model,
            time_limit=time_limit, max_depth=max_depth,
            ordering_alpha=1.0,
            **opts,
        )

        _apply_turn_in_place(board, best_turn, color)
        board.update()
        board.check_game_over(color)
        if not board.gameover:
            board.advance_turn()

    if turn_num >= MAX_TURNS and not board.gameover:
        board.update()
        if board.totalstones['red'] > board.totalstones['blue'] + 1:
            return 'red'
        if board.totalstones['blue'] + 1 > board.totalstones['red']:
            return 'blue'
        return None
    return board.winner


def main():
    parser = argparse.ArgumentParser(
        description='Minimax-engine A/B arena. Side A is the experimental '
                    '(Phase A+B+C) build; side B is the vanilla baseline.')
    parser.add_argument('--model', type=str,
                        default=os.path.join(MODELS_DIR, 'best_model.pt'))
    parser.add_argument('--games', type=int, default=20)
    parser.add_argument('--time', type=float, default=12.0,
                        help='Time limit per move (seconds)')
    parser.add_argument('--depth', type=int, default=3)
    parser.add_argument('--phaseA-only', action='store_true',
                        help='Compare Phase A (TT+killers) vs vanilla. Default: '
                             'Phase A+B+C vs vanilla.')
    args = parser.parse_args()

    print(f'Loading model: {args.model}', flush=True)
    model = SigilNet.load_or_create(args.model, device='cpu')
    model.eval()

    if args.phaseA_only:
        side_a = dict(
            exhaustive_root=True, exhaustive_opponent=False,
            enable_tt=True, enable_killers=True, aspiration_delta=0.0,
        )
        side_a_label = 'PhaseA'
    else:
        side_a = _PHASE_ABC_OPTS
        side_a_label = 'PhaseABC'
    side_b = _VANILLA_OPTS
    side_b_label = 'Vanilla'

    print(f'Settings: {args.games} games, {args.time}s/move, depth={args.depth}',
          flush=True)
    print(f'  Side A ({side_a_label}): {side_a}', flush=True)
    print(f'  Side B ({side_b_label}): {side_b}', flush=True)

    a_wins = 0
    b_wins = 0
    draws = 0
    start = time.time()

    for game_idx in range(args.games):
        if game_idx % 2 == 0:
            red_opts, blue_opts = side_a, side_b
            a_is_red = True
        else:
            red_opts, blue_opts = side_b, side_a
            a_is_red = False

        t0 = time.time()
        winner = play_one_game(
            model, args.time, args.depth, red_opts, blue_opts)
        elapsed = time.time() - t0

        if winner is None:
            draws += 1
            outcome = 'D'
        elif (winner == 'red' and a_is_red) or (winner == 'blue' and not a_is_red):
            a_wins += 1
            outcome = 'A'
        else:
            b_wins += 1
            outcome = 'B'

        total = a_wins + b_wins + draws
        rate = a_wins / max(1, total)
        total_elapsed = time.time() - start
        avg_game = total_elapsed / total
        print(f'  Game {game_idx+1:3d}/{args.games}: winner={outcome} '
              f'(A={a_wins}, B={b_wins}, D={draws}, '
              f'A-rate={rate:.3f}) [{elapsed:.0f}s/game, '
              f'avg {avg_game:.0f}s]',
              flush=True)

    total = a_wins + b_wins + draws
    win_rate = a_wins / max(1, total)
    elapsed = time.time() - start
    print()
    print(f'Final: A={a_wins} B={b_wins} D={draws} ({side_a_label} win rate={win_rate:.3f})')
    print(f'Total time: {elapsed:.0f}s ({elapsed / max(1, total):.1f}s per game avg)')

    threshold = 0.55
    if win_rate >= threshold:
        print(f'PASS: {side_a_label} >= {threshold:.0%} gate')
        return 0
    print(f'FAIL: {side_a_label} below {threshold:.0%} gate')
    return 1


if __name__ == '__main__':
    sys.exit(main())
