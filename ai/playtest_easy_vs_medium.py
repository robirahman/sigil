"""Automated playtest: Easy AI vs Medium AI on SimBoard.

Easy AI: picks the first legal turn whose initial move is highest
in a priority order (replicating the heuristic AIPlayer).

Medium AI: MCTS with SigilNet (200 sims for speed).
"""
import os, sys, time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))) or '.')

from simboard import SimBoard, CORE_SPELLS
from ai.search import _apply_turn
from ai.selfplay import random_core_spells
from notation import GameRecorder, NODE_ORDER
from ai.sigil_net import SigilNet
from ai.mcts import mcts_search
from ai.config import MAX_TURNS, MODELS_DIR

# Easy AI priority orders (same as singleplayergame.py AIPlayer)
PRIORITY_RED = [
    'b1','c1','a1',
    'b10','b8','b9', 'b2','b3','b4','b6','b5','b7',
    'c10','c8','c9', 'c2','c3','c4','c6','c5','c7',
    'a10','a8','a9', 'a2','a3','a4','a6','a5','a7',
    'b11','b12','b13','c11','c12','c13','a11','a12','a13',
]
PRIORITY_BLUE = [
    'a1','c1','b1',
    'a10','a8','a9', 'a2','a3','a4','a6','a5','a7',
    'c10','c8','c9', 'c2','c3','c4','c6','c5','c7',
    'b10','b8','b9', 'b2','b3','b4','b6','b5','b7',
    'a11','a12','a13','c11','c12','c13','b11','b12','b13',
]

def pick_easy_turn(board, color):
    """Pick a turn using the Easy AI's priority heuristic."""
    priority = PRIORITY_RED if color == 'red' else PRIORITY_BLUE
    priority_rank = {node: i for i, node in enumerate(priority)}

    legal_turns = list(board.get_legal_turns(color))
    if not legal_turns:
        return legal_turns[0] if legal_turns else None

    # Score each turn by the priority rank of its first move
    best_turn = None
    best_rank = 999

    for turn in legal_turns:
        first = turn.actions[0]
        if first.type == 'pass':
            # Pass is worst priority
            if best_turn is None:
                best_turn = turn
            continue
        node = first.node
        rank = priority_rank.get(node, 999)

        # Prefer turns with spells (Easy AI casts when possible)
        has_cast = any(a.type == 'cast' for a in turn.actions)
        if has_cast:
            rank -= 100  # strongly prefer casting

        if rank < best_rank:
            best_rank = rank
            best_turn = turn

    return best_turn


def record_turn_actions(recorder, turn, color):
    """Record a SimBoard CompleteTurn's actions to GameRecorder."""
    for action in turn.actions:
        if action.type == 'move':
            recorder.record('move', node=action.node)
        elif action.type == 'hard_move':
            pushed_to = action.pushed_to or 'X'
            recorder.record('hard_move', node=action.node, pushed_to=pushed_to)
        elif action.type == 'blink':
            recorder.record('blink', node=action.node)
        elif action.type == 'dash':
            recorder.record('dash', sacrificed=action.sacrificed or [],
                          dest=action.node)
        elif action.type == 'dash_lightning':
            recorder.record('dash_lightning', sacrificed=action.sacrificed or [],
                          dest=action.node)
        elif action.type == 'cast':
            recorder.record('cast', spell=action.spell,
                          kept=action.kept or [])
        elif action.type == 'pass':
            pass  # auto-appended by recorder


def play_game(model, easy_color, sims=200):
    """Play one Easy vs Medium game. Returns (winner, sgn_string)."""
    spells = random_core_spells()
    board = SimBoard(spells)
    board.setup_initial()

    medium_color = 'blue' if easy_color == 'red' else 'red'
    recorder = GameRecorder(spells,
                           red_name='Easy' if easy_color == 'red' else 'Medium',
                           blue_name='Easy' if easy_color == 'blue' else 'Medium')

    turn_num = 0
    while not board.gameover and turn_num < MAX_TURNS:
        turn_num += 1
        board.turn_counter = turn_num
        color = 'red' if turn_num % 2 == 1 else 'blue'
        board.whose_turn = color

        recorder.start_turn(color, turn_num)

        if color == easy_color:
            best_turn = pick_easy_turn(board, color)
        else:
            best_turn, _, _ = mcts_search(
                board, color, model,
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
        r, b = board.totalstones['red'], board.totalstones['blue'] + 1
        if r > b:
            winner = 'red'
        elif b > r:
            winner = 'blue'
        else:
            winner = None
    else:
        winner = board.winner

    recorder.end_game(winner)
    return winner, recorder.to_sgn(), turn_num


def main():
    num_games = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    sims = 200

    model_path = os.path.join(MODELS_DIR, 'best_model.pt')
    print(f"Loading Medium model from {model_path}")
    model = SigilNet.load(model_path)
    model.eval()

    easy_wins = 0
    medium_wins = 0
    draws = 0

    os.makedirs('games', exist_ok=True)
    start = time.time()

    for i in range(num_games):
        # Alternate colors
        easy_color = 'red' if i % 2 == 0 else 'blue'
        medium_color = 'blue' if easy_color == 'red' else 'red'

        winner, sgn, turns = play_game(model, easy_color, sims=sims)

        # Determine who won
        if winner == easy_color:
            easy_wins += 1
            result_str = 'Easy wins'
        elif winner == medium_color:
            medium_wins += 1
            result_str = 'Medium wins'
        else:
            draws += 1
            result_str = 'Draw'

        # Save SGN
        ts = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
        sgn_path = f'games/playtest_easy_v_medium_{ts}.sgn'
        with open(sgn_path, 'w') as f:
            f.write(sgn)

        elapsed = time.time() - start
        print(f"  Game {i+1}/{num_games}: {result_str} ({winner}) "
              f"in {turns} turns | Easy(={easy_color}) "
              f"[E:{easy_wins} M:{medium_wins} D:{draws}] [{elapsed:.0f}s]")

    print(f"\n{'='*50}")
    print(f"Results: Easy {easy_wins} - Medium {medium_wins} - Draws {draws}")
    total_decided = easy_wins + medium_wins
    if total_decided > 0:
        print(f"Easy win rate:   {easy_wins/total_decided:.0%}")
        print(f"Medium win rate: {medium_wins/total_decided:.0%}")
    print(f"Total time: {time.time() - start:.0f}s")


if __name__ == '__main__':
    main()
