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
from ai.search import _apply_turn
from ai.selfplay import random_core_spells

from ai.sigil_net import SigilNet
from ai.sigil_net_hard import SigilNetHard
from ai.mcts import mcts_search, legal_turns
from ai.features import board_to_tensor, encode_all_turns
from ai.config import (
    NUM_SIMS_TRAIN, TEMP_THRESHOLD, MAX_TURNS,
    MODELS_DIR, DATA_DIR, SPELL_TO_ID,
    RESIGN_THRESHOLD, RESIGN_CONSECUTIVE, RESIGN_DISABLE_PROB,
)


def play_selfplay_game(model, num_simulations=None, force_no_resign=False,
                       variant='standard', move_time_limit=None):
    """Play a single self-play game using MCTS.

    `move_time_limit` (seconds, optional) caps MCTS wall-clock per move.
    On pathological positions (e.g. 10k+ legal turns at mid-game) MCTS
    can otherwise spend tens of minutes on a single move, building a
    multi-GB tree that the worker never gets to free; budgeting it
    bounds per-game memory and turnaround. mcts_search exits as soon as
    *either* num_simulations completes or the time budget is hit.

    Returns list of (sfn, spell_ids, turn_encodings, policy, side_to_move) tuples
    and the game winner.
    """
    if num_simulations is None:
        num_simulations = NUM_SIMS_TRAIN

    spells = random_core_spells()
    board = SimBoard(spells, variant=variant)
    board.setup_initial()

    positions = []
    turn_num = 0
    resign_count = 0
    resign_disabled = (force_no_resign
                      or np.random.random() < RESIGN_DISABLE_PROB)

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
            time_limit=move_time_limit,
            add_noise=True,
            temperature=temp,
        )

        # Record position data
        sfn = board.to_sfn()
        spell_ids = [SPELL_TO_ID.get(board.spell_names[i], 0) for i in range(9)]

        # Pre-cache raw features so training skips SFN reconstruction
        raw, _ = board_to_tensor(board, color)

        # Store legal turns and policy (must match the enumeration MCTS used
        # so the recorded policy lines up with the turn encodings).
        turns = legal_turns(board, color)
        turn_feats = encode_all_turns(turns, board, color)

        positions.append({
            'sfn': sfn,
            'spell_ids': spell_ids,
            'raw_features': raw.numpy().tolist(),
            'policy': policy.tolist(),
            'turn_encodings': turn_feats.numpy().tolist(),
            'side': color,
        })

        # Resignation check: if value is very negative for several turns in a row
        if not resign_disabled:
            if value < -RESIGN_THRESHOLD:
                resign_count += 1
                if resign_count >= RESIGN_CONSECUTIVE:
                    enemy = 'blue' if color == 'red' else 'red'
                    board.gameover = True
                    board.winner = enemy
                    break
            else:
                resign_count = 0

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


# Module-level handle to the loaded model. The parent process sets
# this once in generate_training_data() before spawning per-game
# children; each forked child inherits the pointer (and the model's
# memory) via CoW so we don't pay a re-load cost per game and we
# don't have to pickle the SigilNet (which would be slow and lossy).
# Children only read from the model, so the CoW pages stay shared.
_SELFPLAY_MODEL = None


def _run_one_selfplay_game_subprocess(arg):
    """Worker entrypoint: play one game in a forked child, write the
    result JSON to arg['out_path'], exit. Uses the module-level
    _SELFPLAY_MODEL set by the parent before forking.

    Process-per-game (instead of one long-lived worker process per
    iteration) is the structural fix for the long-running OOM we kept
    hitting: Python's allocator never returns freed memory to the OS,
    so once a worker built (and freed) a 4 GB MCTS tree at any single
    move, its RSS stayed at 4 GB for the rest of the iteration. Short-
    lived per-game children exit at end-of-game and the OS reclaims
    everything — no compounding high-water marks across the 14 × 40
    game budget."""
    try:
        # Re-seed per child so different games don't start identical
        # (forks share the parent's RNG state up to fork time).
        seed = (os.getpid() * 2654435761) & 0xFFFFFFFF
        np.random.seed(seed)
        # Limit per-process BLAS thread count so 14 parallel workers
        # don't oversubscribe the CPU. (The bash loop also exports
        # OMP/MKL/OPENBLAS = 1; this is belt-and-suspenders.)
        try:
            torch.set_num_threads(1)
        except Exception:
            pass

        positions, winner = play_selfplay_game(
            _SELFPLAY_MODEL,
            num_simulations=arg['num_sims'],
            force_no_resign=arg['force_no_resign'],
            variant=arg['variant'],
            move_time_limit=arg['move_time_limit'],
        )
        result = {
            'positions': positions,
            'winner': winner,
            'error': None,
        }
    except Exception as e:
        result = {
            'positions': [],
            'winner': None,
            'error': repr(e),
        }
    tmp = arg['out_path'] + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(result, f)
    os.replace(tmp, arg['out_path'])


def generate_training_data(model, num_games, output_path, num_simulations=None,
                           force_no_resign=False, competitive_fraction=0.0,
                           move_time_limit=None, game_timeout=1800):
    """Generate training data from self-play games via process-per-game.

    Writes JSONL with fields: sfn, spell_ids, policy, turn_encodings,
    outcome. Each game runs in a short-lived forked child; the parent
    waits for the child to finish (or terminates it after
    `game_timeout` seconds), reads the child's result file, appends
    its positions to the output JSONL, and moves on. This bounds
    per-iteration RSS at the worst single-game peak (~few GB) instead
    of letting allocator high-water marks compound across 40 games.

    `competitive_fraction` in [0.0, 1.0] is the probability that any given
    self-play game is played under the competitive variant. The default of
    0.0 keeps existing pipelines reproducing standard data; pass 0.5 (for
    example) to mix variants 50/50 in the resulting file. The variant is
    encoded into each position's SFN, so downstream training can either
    ignore it or condition on it.

    `game_timeout` (seconds) is a per-game hard cap that catches a
    pathologically long game where every move uses its full
    `move_time_limit` budget. Such a game would otherwise wedge one
    worker for hours. On timeout, the child is terminated, the game
    is logged as dropped, and the next game starts.
    """
    global _SELFPLAY_MODEL
    _SELFPLAY_MODEL = model

    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else '.',
                exist_ok=True)

    from multiprocessing import get_context
    import tempfile
    import shutil
    ctx = get_context('fork')
    ipc_dir = tempfile.mkdtemp(prefix='sigil_selfplay_')

    total_positions = 0
    competitive_games = 0
    timed_out_games = 0
    error_games = 0
    start_time = time.time()

    try:
        with open(output_path, 'w') as f:
            for game_idx in range(num_games):
                variant = ('competitive'
                           if np.random.random() < competitive_fraction
                           else 'standard')
                if variant == 'competitive':
                    competitive_games += 1

                out_path = os.path.join(ipc_dir, f'game_{game_idx}.json')
                arg = {
                    'num_sims': num_simulations,
                    'force_no_resign': force_no_resign,
                    'variant': variant,
                    'move_time_limit': move_time_limit,
                    'out_path': out_path,
                }

                game_start = time.time()
                p = ctx.Process(
                    target=_run_one_selfplay_game_subprocess,
                    args=(arg,),
                    daemon=True,
                )
                p.start()
                p.join(timeout=game_timeout)
                if p.is_alive():
                    p.terminate()
                    p.join(timeout=5)
                    if p.is_alive():
                        p.kill()
                        p.join(timeout=5)
                    timed_out_games += 1
                    print(f"Game {game_idx+1}/{num_games}: TIMEOUT after "
                          f"{game_timeout}s — terminated and skipped",
                          flush=True)
                    for path in (out_path, out_path + '.tmp'):
                        try:
                            os.unlink(path)
                        except FileNotFoundError:
                            pass
                    continue

                game_time = time.time() - game_start

                if not os.path.exists(out_path):
                    error_games += 1
                    print(f"Game {game_idx+1}/{num_games}: child exited "
                          f"({p.exitcode}) without writing output, skipping",
                          flush=True)
                    continue

                try:
                    with open(out_path) as rf:
                        result = json.load(rf)
                finally:
                    for path in (out_path, out_path + '.tmp'):
                        try:
                            os.unlink(path)
                        except FileNotFoundError:
                            pass

                if result.get('error'):
                    error_games += 1
                    print(f"Game {game_idx+1}/{num_games}: worker error: "
                          f"{result['error']}", flush=True)
                    continue

                positions = result['positions']
                winner = result['winner']

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
                        'raw_features': pos['raw_features'],
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
    finally:
        shutil.rmtree(ipc_dir, ignore_errors=True)
        _SELFPLAY_MODEL = None

    elapsed = time.time() - start_time
    print(f"\nGenerated {total_positions} positions from {num_games} games "
          f"in {elapsed:.0f}s ({total_positions/max(num_games,1):.0f} pos/game avg) "
          f"[competitive: {competitive_games}/{num_games}, "
          f"timed-out: {timed_out_games}, errors: {error_games}]")
    return total_positions


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Generate MCTS self-play training data')
    parser.add_argument('--games', type=int, default=100)
    parser.add_argument('--sims', type=int, default=NUM_SIMS_TRAIN)
    parser.add_argument('--model', type=str, default=None,
                        help='Path to model checkpoint')
    parser.add_argument('--output', type=str, default=None)
    parser.add_argument('--net', type=str, default='medium',
                        choices=['medium', 'hard'],
                        help='Network architecture: medium (2M) or hard (44M)')
    parser.add_argument('--no-resign', action='store_true',
                        help='Force resignation off in every game')
    parser.add_argument('--competitive-fraction', type=float, default=0.0,
                        help='Fraction of games to play under the competitive '
                             'variant (0.0 = all standard, 1.0 = all competitive)')
    parser.add_argument('--move-time-limit', type=float, default=None,
                        help='Per-move MCTS wall-clock budget in seconds. '
                             'mcts_search exits whichever comes first — sims '
                             'or budget. Caps per-game memory on pathological '
                             'positions (10k+ legal turns at mid-game can '
                             'otherwise consume multi-GB trees per move and '
                             'never return). Default: no limit.')
    parser.add_argument('--game-timeout', type=float, default=1800,
                        help='Per-game hard ceiling (seconds). The game runs '
                             'in a forked child; if it exceeds this it gets '
                             'SIGTERM/SIGKILLed and dropped. Default: 1800 '
                             '(30 min) — prevents a worker from spending '
                             'hours on a single pathological game.')
    args = parser.parse_args()

    # Select network class
    net_class = SigilNetHard if args.net == 'hard' else SigilNet

    # Load or create model
    if args.model and os.path.exists(args.model):
        model = net_class.load(args.model)
    else:
        model = net_class.load_or_create()
    model.eval()

    if args.output is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        args.output = os.path.join(DATA_DIR, f'selfplay_{int(time.time())}.jsonl')

    generate_training_data(model, args.games, args.output, args.sims,
                           force_no_resign=args.no_resign,
                           competitive_fraction=args.competitive_fraction,
                           move_time_limit=args.move_time_limit,
                           game_timeout=args.game_timeout)
    print(f"Data saved to {args.output}")
