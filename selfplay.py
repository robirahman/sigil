"""
Self-play game generation for training data.

Usage:
    python selfplay.py --games 1000 --output training_data
"""

import argparse
import json
import os
import random
import sys
import time

from simboard import SimBoard, NODE_ORDER
from notation import GameRecorder
from policies import RandomPolicy, HeuristicPolicy, EpsilonGreedyPolicy

# Core spell pools
CORE_RITUALS = ['Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning']
CORE_SORCERIES = ['Grow', 'Fireblast', 'Hail_Storm', 'Meteor', 'Seal_of_Wind']
CORE_CHARMS = ['Sprout', 'Slash', 'Surge', 'Comet', 'Seal_of_Summer']

MAX_TURNS = 200  # Safety limit to prevent infinite games


def random_core_spells():
    """Generate a random core spell configuration (3 rituals, 3 sorceries, 3 charms)."""
    rituals = random.sample(CORE_RITUALS, 3)
    sorceries = random.sample(CORE_SORCERIES, 3)
    charms = random.sample(CORE_CHARMS, 3)
    return rituals + sorceries + charms


def play_game(red_policy, blue_policy, spell_names=None):
    """Play one self-play game. Returns (positions, winner, sgn_string).

    positions: list of (sfn_string, side_to_move) tuples
    winner: 'red', 'blue', or None (draw/timeout)
    """
    if spell_names is None:
        spell_names = random_core_spells()

    board = SimBoard(spell_names)
    board.setup_initial()

    recorder = GameRecorder(spell_names, red_name=red_policy.__class__.__name__,
                            blue_name=blue_policy.__class__.__name__)

    positions = []
    turn_num = 0

    while not board.gameover and turn_num < MAX_TURNS:
        turn_num += 1
        board.turn_counter = turn_num

        if turn_num % 2 == 1:
            color = 'red'
            display_num = (turn_num // 2) + 1
        else:
            color = 'blue'
            display_num = turn_num // 2

        board.whose_turn = color

        # Record position before the turn
        positions.append((board.to_sfn(), color))

        # Record turn start
        recorder.start_turn(color, display_num)

        # Check for Inferno bot trigger
        if 'Inferno' in board.charged_spells[color]:
            enemy = 'blue' if color == 'red' else 'red'
            board.gameover = True
            board.winner = enemy
            break

        # Choose and apply a turn
        policy = red_policy if color == 'red' else blue_policy
        turn = policy.choose_turn(board, color)

        # Record actions
        for action in turn.actions:
            if action.type == 'move':
                recorder.record('move', node=action.node)
            elif action.type == 'hard_move':
                recorder.record('hard_move', node=action.node,
                              pushed_to=action.pushed_to or 'X')
            elif action.type == 'blink':
                recorder.record('blink', node=action.node)
            elif action.type == 'cast':
                recorder.record('cast', spell=action.spell,
                              kept=action.kept or [])
            elif action.type in ('dash', 'dash_lightning'):
                recorder.record(action.type,
                              sacrificed=action.sacrificed or [],
                              dest=action.node or 'unknown')

        # The turn was already played on a copy inside get_legal_turns.
        # We need to replay it on the real board.
        _apply_turn_to_board(board, turn, color)

        board.update()

        # Check win conditions
        board.check_game_over(color)

    if turn_num >= MAX_TURNS and not board.gameover:
        # Timeout — declare based on score
        board.update()
        if board.totalstones['red'] > board.totalstones['blue'] + 1:
            board.winner = 'red'
        elif board.totalstones['blue'] + 1 > board.totalstones['red']:
            board.winner = 'blue'
        else:
            board.winner = None

    recorder.end_game(board.winner)
    sgn = recorder.to_sgn()

    return positions, board.winner, sgn


def _apply_turn_to_board(board, turn, color):
    """Replay a CompleteTurn's top-level effects on the board."""
    from simboard import CORE_SPELLS, POSITIONS

    for action in turn.actions:
        if action.type == 'move':
            board.stones[action.node] = color
        elif action.type == 'hard_move':
            board._push_enemy(action.node, color)
        elif action.type == 'blink':
            enemy = board._enemy(color)
            if board.stones[action.node] == enemy:
                board._push_enemy(action.node, color)
            else:
                board.stones[action.node] = color
        elif action.type == 'cast':
            board._cast_spell(action.spell, color)
        elif action.type == 'dash':
            if action.sacrificed:
                for sac in action.sacrificed:
                    board.stones[sac] = None
        elif action.type == 'dash_lightning':
            if action.sacrificed:
                for sac in action.sacrificed:
                    board.stones[sac] = None
        elif action.type == 'pass':
            pass
        board.update()


def generate_training_data(positions, winner):
    """Convert game positions + outcome into (sfn, label) training pairs."""
    data = []
    for sfn, side in positions:
        if winner is None:
            label = 0.5
        elif side == winner:
            label = 1.0
        else:
            label = 0.0
        data.append((sfn, label))
    return data


def run_selfplay(num_games, output_dir, policy_mix='mixed'):
    """Run many self-play games and save results."""
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(os.path.join(output_dir, 'sgn'), exist_ok=True)

    all_training_data = []
    wins = {'red': 0, 'blue': 0, 'draw': 0}

    policies = {
        'random': RandomPolicy(),
        'heuristic': HeuristicPolicy(),
        'epsilon': EpsilonGreedyPolicy(HeuristicPolicy(), epsilon=0.2),
    }

    # Load evolved genomes if available
    genome_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models')
    try:
        from genetic import GeneticPolicy, load_genome
        best_genome_path = os.path.join(genome_dir, 'best_genome.json')
        if os.path.exists(best_genome_path):
            best_genome = load_genome(best_genome_path)
            policies['genetic'] = GeneticPolicy(best_genome)
            policies['genetic_eps'] = EpsilonGreedyPolicy(GeneticPolicy(best_genome), epsilon=0.1)
            # Also load top genomes for diversity
            for i in range(1, 6):
                gp = os.path.join(genome_dir, f'genome_top{i}.json')
                if os.path.exists(gp):
                    policies[f'genetic_{i}'] = GeneticPolicy(load_genome(gp))
    except Exception:
        pass

    start_time = time.time()

    for i in range(num_games):
        # Choose policies
        if policy_mix == 'random':
            red_p = policies['random']
            blue_p = policies['random']
        elif policy_mix == 'heuristic':
            red_p = policies['heuristic']
            blue_p = policies['heuristic']
        else:
            # Mixed: randomly pair policies
            choices = ['random', 'heuristic', 'epsilon']
            red_p = policies[random.choice(choices)]
            blue_p = policies[random.choice(choices)]

        try:
            positions, winner, sgn = play_game(red_p, blue_p)
        except Exception as e:
            print(f"Game {i+1} failed: {e}")
            continue

        # Record outcome
        if winner == 'red':
            wins['red'] += 1
        elif winner == 'blue':
            wins['blue'] += 1
        else:
            wins['draw'] += 1

        # Save SGN
        sgn_path = os.path.join(output_dir, 'sgn', f'game_{i+1:05d}.sgn')
        with open(sgn_path, 'w') as f:
            f.write(sgn)

        # Collect training data
        training = generate_training_data(positions, winner)
        all_training_data.extend(training)

        if (i + 1) % 100 == 0:
            elapsed = time.time() - start_time
            rate = (i + 1) / elapsed
            print(f"Game {i+1}/{num_games} ({rate:.1f} games/sec) "
                  f"R:{wins['red']} B:{wins['blue']} D:{wins['draw']}")

    # Save training data as JSON lines
    data_path = os.path.join(output_dir, 'training_data.jsonl')
    with open(data_path, 'w') as f:
        for sfn, label in all_training_data:
            f.write(json.dumps({'sfn': sfn, 'label': label}) + '\n')

    elapsed = time.time() - start_time
    print(f"\nDone! {num_games} games in {elapsed:.1f}s")
    print(f"Results: Red {wins['red']}, Blue {wins['blue']}, Draw {wins['draw']}")
    print(f"Training samples: {len(all_training_data)}")
    print(f"Saved to: {output_dir}")

    return all_training_data


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Generate self-play training data')
    parser.add_argument('--games', type=int, default=1000, help='Number of games')
    parser.add_argument('--output', type=str, default='training_data', help='Output directory')
    parser.add_argument('--policy', type=str, default='mixed',
                       choices=['random', 'heuristic', 'mixed'],
                       help='Policy mix for self-play')
    args = parser.parse_args()

    run_selfplay(args.games, args.output, args.policy)
