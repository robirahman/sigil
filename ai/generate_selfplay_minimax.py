"""Minimax-vs-minimax self-play data generation.

Plays Hard-vs-Hard games using the production minimax engine
(iterative-deepening alpha-beta with TT, killer moves, aspiration
windows, exhaustive_root, exhaustive_opponent, blunder_lambda=1.0).
Each move uses ~3-15s of search; each game takes 5-15 min, depending
on position complexity. A 6-hour run typically produces 30-80 games.

Outputs JSONL with per-position {sfn, spell_ids, raw_features, policy
(one-hot at chosen move), turn_encodings, outcome, source} — same
schema as ai/data/human_games.jsonl and the existing selfplay files.

Usage:
    python generate_selfplay_minimax.py --hours 6
"""

import argparse
import datetime
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simboard import SimBoard
from ai.search import _apply_turn
from ai.selfplay import random_core_spells, random_spell_set

from ai.sigil_net import SigilNet
from ai.minimax_ai import minimax_search
from ai.features import board_to_tensor, encode_all_turns
from ai.config import MAX_TURNS, MODELS_DIR, SPELL_TO_ID


def make_position(board, color, turn_idx, legal_turns, outcome):
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
        'source': 'selfplay_minimax',
    }


def play_game(model, time_limit, max_depth, blunder_lambda, expansions=None):
    """Play one minimax-vs-minimax game. Returns (winner, positions).

    `expansions` selects the spell pool (see ai.selfplay.random_spell_set):
    None/'core' for core only, 'all' for every official expansion, or a
    specific key like 'tectonic' to guarantee those spells are in the pool.
    """
    spells = random_spell_set(expansions)
    board = SimBoard(spells)
    board.setup_initial()

    saved = []  # (board_copy, color, turn_idx, legal_turns)
    turn_num = 0
    while not board.gameover and turn_num < MAX_TURNS:
        turn_num += 1
        board.turn_counter = turn_num
        color = 'red' if turn_num % 2 == 1 else 'blue'
        board.whose_turn = color

        legal_turns = list(board.get_legal_turns(color))
        if not legal_turns:
            break
        best_turn = minimax_search(
            board, color, model,
            time_limit=time_limit, max_depth=max_depth,
            ordering_alpha=1.0, exhaustive_root=True,
            exhaustive_opponent=True, blunder_lambda=blunder_lambda,
            enable_tt=True, enable_killers=True, aspiration_delta=0.15,
        )
        # Find which legal turn matches.
        turn_idx = 0
        for i, lt in enumerate(legal_turns):
            if lt is best_turn:
                turn_idx = i
                break
        else:
            # Match by structural identity if `is` failed.
            from ai.minimax_ai import _turn_eq
            for i, lt in enumerate(legal_turns):
                if _turn_eq(lt, best_turn):
                    turn_idx = i
                    break

        saved.append((board.copy(), color, turn_idx, legal_turns))
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

    positions = []
    for saved_board, col, tidx, lturns in saved:
        if winner == col:
            outcome = 1.0
        elif winner is not None:
            outcome = -1.0
        else:
            outcome = 0.0
        positions.append(make_position(saved_board, col, tidx, lturns, outcome))
    return winner, positions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--hours', type=float, default=6.0,
                        help='Wall-clock budget')
    parser.add_argument('--model', type=str,
                        default=os.path.join(MODELS_DIR, 'best_model.pt'))
    parser.add_argument('--time-per-move', type=float, default=8.0,
                        help='Seconds per move (per side)')
    parser.add_argument('--max-depth', type=int, default=4)
    parser.add_argument('--blunder-lambda', type=float, default=1.0)
    parser.add_argument('--output', type=str, default=None)
    parser.add_argument('--expansions', type=str, default='all',
                        help="Spell pool: 'core', 'all' (every official "
                             "expansion, incl. Tectonic/Fissure), or a "
                             "comma/space list of keys e.g. 'tectonic' or "
                             "'tectonic gloom'. Default 'all'.")
    args = parser.parse_args()

    if args.output is None:
        date = datetime.date.today().isoformat()
        args.output = f'ai/data/selfplay_minimax_{date}.jsonl'

    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)

    print(f'Loading model: {args.model}', flush=True)
    model = SigilNet.load(args.model, device='cpu')
    model.eval()

    print(f'Wall-clock budget: {args.hours:.1f} h', flush=True)
    print(f'Per-move budget:   {args.time_per_move}s, max_depth={args.max_depth}', flush=True)
    print(f'Blunder lambda:    {args.blunder_lambda}', flush=True)
    print(f'Spell pool:        {args.expansions}', flush=True)
    print(f'Output:            {args.output}', flush=True)
    print(flush=True)

    deadline = time.time() + args.hours * 3600.0
    games_played = 0
    total_positions = 0
    red_wins = blue_wins = draws = 0
    start = time.time()

    # Append mode so a re-run resumes; tag with append-timestamp for
    # later analysis.
    with open(args.output, 'a') as f:
        while time.time() < deadline:
            game_t0 = time.time()
            winner, positions = play_game(
                model, args.time_per_move, args.max_depth, args.blunder_lambda,
                expansions=args.expansions)
            game_dt = time.time() - game_t0
            for pos in positions:
                f.write(json.dumps(pos) + '\n')
            f.flush()

            games_played += 1
            total_positions += len(positions)
            if winner == 'red':
                red_wins += 1
            elif winner == 'blue':
                blue_wins += 1
            else:
                draws += 1

            elapsed = time.time() - start
            remaining = max(0, deadline - time.time())
            avg_game = elapsed / games_played
            print(f'  Game {games_played:3d}: '
                  f'winner={winner} positions={len(positions):2d} '
                  f'({game_dt:.0f}s)  '
                  f'totals: R={red_wins} B={blue_wins} D={draws}  '
                  f'pos={total_positions}  '
                  f'elapsed={elapsed/60:.1f}m  '
                  f'remaining={remaining/60:.1f}m  '
                  f'avg/game={avg_game:.0f}s',
                  flush=True)

    print(f'\nDone. {games_played} games, {total_positions} positions in {(time.time()-start)/3600:.2f} h.',
          flush=True)
    print(f'  R={red_wins} B={blue_wins} D={draws}', flush=True)
    print(f'  Output: {args.output}', flush=True)


if __name__ == '__main__':
    main()
