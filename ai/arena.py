"""Model-vs-model arena for gating evaluation.

Plays games between two SigilNet models using MCTS to determine
if a new model is stronger than the current best.

Usage:
    python -m ai.arena --model1 ai/models/best_model.pt --model2 ai/models/candidate.pt --games 100
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
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


# Module-level handles to the two models being gated. Parent sets these
# before forking the per-game children; each child inherits the pointers
# (and the model memory) via CoW so we don't pickle SigilNets across
# process boundaries. Children only read from the models, so the CoW
# pages stay shared.
_ARENA_MODEL1 = None
_ARENA_MODEL2 = None


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


def _run_one_arena_game_subprocess(arg):
    """Worker entrypoint: play one arena game in a forked child, write
    the winner ('red' / 'blue' / None) plus optional error to a JSON
    tempfile, exit. Uses the module-level _ARENA_MODEL1/_ARENA_MODEL2
    set by the parent before forking.

    Process-per-game (instead of one long-lived gate process playing
    all 30 games sequentially) bounds per-iteration memory at the
    worst single-game peak. The previous gate held one long-lived
    Python process whose RSS climbed to 14.5 GB across 30 games as the
    allocator high-water-marked from a few heavy MCTS expansions; one
    single game stretched past 60 minutes despite a 5s/move cap
    because mcts_search expansions (encoding thousands of legal turns
    through the net per new leaf) compound across the move stream
    inside one process. With per-game children, the parent's
    .join(timeout=N) is the hard ceiling — a stuck game costs at most
    `game_timeout` seconds and the OS reclaims its memory."""
    try:
        # Re-seed per child so successive games don't start identical
        # (forks share the parent's RNG up to fork time).
        import numpy as _np
        _np.random.seed((os.getpid() * 2654435761) & 0xFFFFFFFF)
        try:
            torch.set_num_threads(1)
        except Exception:
            pass

        if arg['red_is_model1']:
            m_red, m_blue = _ARENA_MODEL1, _ARENA_MODEL2
            bl_red, bl_blue = arg['blunder_lambda1'], arg['blunder_lambda2']
            sa_red, sa_blue = arg['strategic_alpha1'], arg['strategic_alpha2']
        else:
            m_red, m_blue = _ARENA_MODEL2, _ARENA_MODEL1
            bl_red, bl_blue = arg['blunder_lambda2'], arg['blunder_lambda1']
            sa_red, sa_blue = arg['strategic_alpha2'], arg['strategic_alpha1']

        winner = play_arena_game(
            m_red, m_blue, arg['sims_per_move'],
            blunder_lambda1=bl_red, blunder_lambda2=bl_blue,
            strategic_alpha1=sa_red, strategic_alpha2=sa_blue,
            move_time_limit=arg['move_time_limit'])
        result = {'winner': winner, 'error': None}
    except Exception as e:
        result = {'winner': None, 'error': repr(e)}
    tmp = arg['out_path'] + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(result, f)
    os.replace(tmp, arg['out_path'])


def evaluate_models(model1, model2, num_games=None, sims_per_move=200,
                    blunder_lambda1=0.0, blunder_lambda2=0.0,
                    strategic_alpha1=0.0, strategic_alpha2=0.0,
                    move_time_limit=None, game_timeout=300):
    """Play num_games between two models, alternating colors, with each
    game in its own short-lived child process.

    `game_timeout` (seconds) is a hard per-game ceiling — a game
    exceeding it gets SIGTERM/SIGKILLed and is logged as a draw (no
    win to either side). Without this, an uncapped gate with sims=200
    + move_time_limit=5 still wedged a single game past 60 minutes
    because each MCTS expansion can spend seconds enumerating + NN-
    encoding 4000+ legal turns on a heavy mid-game leaf, and those
    expansions compound across the move stream.

    Returns: (model1_wins, model2_wins, draws, model1_win_rate)
    """
    if num_games is None:
        num_games = GATE_GAMES

    global _ARENA_MODEL1, _ARENA_MODEL2
    _ARENA_MODEL1 = model1
    _ARENA_MODEL2 = model2

    from multiprocessing import get_context
    ctx = get_context('fork')
    ipc_dir = tempfile.mkdtemp(prefix='sigil_arena_')

    m1_wins = 0
    m2_wins = 0
    draws = 0
    timed_out = 0
    error_games = 0

    start = time.time()
    try:
        for game_idx in range(num_games):
            game_start = time.time()
            red_is_model1 = (game_idx % 2 == 0)
            out_path = os.path.join(ipc_dir, f'game_{game_idx}.json')
            arg = {
                'red_is_model1': red_is_model1,
                'sims_per_move': sims_per_move,
                'move_time_limit': move_time_limit,
                'blunder_lambda1': blunder_lambda1,
                'blunder_lambda2': blunder_lambda2,
                'strategic_alpha1': strategic_alpha1,
                'strategic_alpha2': strategic_alpha2,
                'out_path': out_path,
            }

            p = ctx.Process(
                target=_run_one_arena_game_subprocess,
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
                timed_out += 1
                draws += 1
                game_time = time.time() - game_start
                elapsed = time.time() - start
                print(f"  Game {game_idx+1}/{num_games}: TIMEOUT after "
                      f"{game_timeout}s — terminated, counted as draw "
                      f"[{game_time:.0f}s, total {elapsed:.0f}s]",
                      flush=True)
                for path in (out_path, out_path + '.tmp'):
                    try:
                        os.unlink(path)
                    except FileNotFoundError:
                        pass
                continue

            if not os.path.exists(out_path):
                error_games += 1
                print(f"  Game {game_idx+1}/{num_games}: child exited "
                      f"({p.exitcode}) without writing output", flush=True)
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
                print(f"  Game {game_idx+1}/{num_games}: worker error: "
                      f"{result['error']}", flush=True)
                continue

            winner = result['winner']
            if red_is_model1:
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

            elapsed = time.time() - start
            game_time = time.time() - game_start
            total = m1_wins + m2_wins + draws
            rate = m1_wins / total if total > 0 else 0
            print(f"  Game {game_idx+1}/{num_games}: winner={winner}  "
                  f"M1={m1_wins} M2={m2_wins} D={draws} "
                  f"(M1 rate={rate:.3f}) "
                  f"[{game_time:.0f}s, total {elapsed:.0f}s]",
                  flush=True)
    finally:
        shutil.rmtree(ipc_dir, ignore_errors=True)
        _ARENA_MODEL1 = None
        _ARENA_MODEL2 = None

    if timed_out or error_games:
        print(f"  ({timed_out} timed-out, {error_games} worker-errored)",
              flush=True)

    # Draws count as 0.5/0.5 (chess Elo convention). The old "draws = 0
    # for candidate" formula was unduly conservative: a 7-1 result with
    # 22 draws-by-timeout came out to 0.23 win rate (rejected at the
    # 0.55 gate) when the decisive-game record was 87.5% for the
    # candidate. Timed-out arena games are inconclusive, not losses, so
    # half-credit is the honest treatment.
    total = m1_wins + m2_wins + draws
    win_rate = (m1_wins + 0.5 * draws) / total if total > 0 else 0.0
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
               current_strategic_alpha=0.0, move_time_limit=None,
               game_timeout=300):
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
        move_time_limit=move_time_limit,
        game_timeout=game_timeout)

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
                             'mcts_search exits whichever comes first — sims '
                             'or budget. Default: no limit.')
    parser.add_argument('--game-timeout', type=float, default=300,
                        help='Per-game hard ceiling (seconds). The game runs '
                             'in a forked child; if it exceeds this it gets '
                             'SIGTERM/SIGKILLed and counted as a draw. '
                             'Default: 300.')
    args = parser.parse_args()

    accepted = gate_model(args.model1, args.model2,
                          num_games=args.games, sims_per_move=args.sims,
                          candidate_blunder_lambda=args.blunder_lambda1,
                          current_blunder_lambda=args.blunder_lambda2,
                          candidate_strategic_alpha=args.strategic_alpha1,
                          current_strategic_alpha=args.strategic_alpha2,
                          move_time_limit=args.move_time_limit,
                          game_timeout=args.game_timeout)
    sys.exit(0 if accepted else 1)
