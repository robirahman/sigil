"""Playtest: alpha-beta (SigilNet eval) vs MCTS, both using v22.

Both sides use the same SigilNet checkpoint (best_model.pt). The only
difference is the search algorithm.

Usage:
    python playtest_alphabeta_vs_mcts.py [num_games] [mcts_sims] [ab_depth] [ab_time] [variant]

Variants:
    value  — child-eval-based ordering (uses SigilNet value head).
    policy — policy-head ordering, single forward pass per node.

Defaults: 10 games, 200 MCTS sims, depth=2, time=8s, variant=value.
"""
import os
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))) or '.')

from simboard import SimBoard
from ai.search import _apply_turn
from ai.selfplay import random_core_spells
from notation import GameRecorder
from ai.sigil_net import SigilNet
from ai.mcts import mcts_search
from ai.config import MAX_TURNS, MODELS_DIR

from ai.alpha_beta_ai_player import (
    SigilNetEvaluator, pick_alpha_beta_turn, pick_policy_ordered_turn,
)
from ai.playtest_easy_vs_medium import record_turn_actions


def play_game(sigil_net, evaluator, ab_color, sims=200,
              ab_depth=2, ab_time=8.0, variant='value'):
    """Play one alpha-beta vs MCTS game. Returns (winner, sgn, turns, avg_ab_time)."""
    spells = random_core_spells()
    board = SimBoard(spells)
    board.setup_initial()

    recorder = GameRecorder(
        spells,
        red_name='AB' if ab_color == 'red' else 'MCTS',
        blue_name='AB' if ab_color == 'blue' else 'MCTS',
    )

    turn_num = 0
    ab_move_times = []
    while not board.gameover and turn_num < MAX_TURNS:
        turn_num += 1
        board.turn_counter = turn_num
        color = 'red' if turn_num % 2 == 1 else 'blue'
        board.whose_turn = color

        recorder.start_turn(color, turn_num)

        if color == ab_color:
            t0 = time.time()
            picker = pick_policy_ordered_turn if variant == 'policy' else pick_alpha_beta_turn
            best_turn = picker(
                board, color, evaluator,
                depth=ab_depth, time_limit=ab_time,
            )
            ab_move_times.append(time.time() - t0)
        else:
            best_turn, _, _ = mcts_search(
                board, color, sigil_net,
                num_simulations=sims,
                add_noise=False,
                temperature=None,
            )

        if best_turn is None:
            break

        record_turn_actions(recorder, best_turn, color)
        _apply_turn(board, best_turn, color)
        board.update()
        board.check_game_over(color)

        if not board.gameover:
            board.advance_turn()

    if turn_num >= MAX_TURNS and not board.gameover:
        board.update()
        r = board.totalstones['red']
        b = board.totalstones['blue'] + 1
        if r > b:
            winner = 'red'
        elif b > r:
            winner = 'blue'
        else:
            winner = None
    else:
        winner = board.winner

    recorder.end_game(winner)
    avg_ab = sum(ab_move_times) / len(ab_move_times) if ab_move_times else 0.0
    return winner, recorder.to_sgn(), turn_num, avg_ab


def main():
    num_games = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    sims = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    ab_depth = int(sys.argv[3]) if len(sys.argv) > 3 else 2
    ab_time = float(sys.argv[4]) if len(sys.argv) > 4 else 8.0
    variant = sys.argv[5] if len(sys.argv) > 5 else 'value'

    if variant not in ('value', 'policy'):
        raise SystemExit(f"variant must be 'value' or 'policy', got {variant!r}")

    model_path = os.path.join(MODELS_DIR, 'best_model.pt')
    print(f"Loading SigilNet from {model_path}")
    sigil_net = SigilNet.load(model_path)
    sigil_net.eval()
    evaluator = SigilNetEvaluator(sigil_net)

    print(f"Config: {num_games} games, MCTS sims={sims}, "
          f"AB depth={ab_depth}, AB time_limit={ab_time}s, variant={variant}")

    ab_wins = 0
    mcts_wins = 0
    draws = 0

    os.makedirs('games', exist_ok=True)
    start = time.time()

    for i in range(num_games):
        ab_color = 'red' if i % 2 == 0 else 'blue'
        mcts_color = 'blue' if ab_color == 'red' else 'red'

        winner, sgn, turns, avg_ab = play_game(
            sigil_net, evaluator, ab_color,
            sims=sims, ab_depth=ab_depth, ab_time=ab_time, variant=variant,
        )

        if winner == ab_color:
            ab_wins += 1
            result_str = 'AB wins'
        elif winner == mcts_color:
            mcts_wins += 1
            result_str = 'MCTS wins'
        else:
            draws += 1
            result_str = 'Draw'

        ts = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
        sgn_path = f'games/playtest_ab_v_mcts_{ts}.sgn'
        with open(sgn_path, 'w') as f:
            f.write(sgn)

        elapsed = time.time() - start
        print(f"  Game {i+1}/{num_games}: {result_str} ({winner}) in {turns} turns "
              f"| AB(={ab_color}, {avg_ab:.1f}s/move) "
              f"[AB:{ab_wins} MCTS:{mcts_wins} D:{draws}] [{elapsed:.0f}s]")

    print(f"\n{'=' * 50}")
    print(f"Results: AB {ab_wins} - MCTS {mcts_wins} - Draws {draws}")
    total_decided = ab_wins + mcts_wins
    if total_decided > 0:
        print(f"AB win rate:   {ab_wins / total_decided:.0%}")
        print(f"MCTS win rate: {mcts_wins / total_decided:.0%}")
    print(f"Total time: {time.time() - start:.0f}s")


if __name__ == '__main__':
    main()
