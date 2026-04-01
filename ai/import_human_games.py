"""Download completed multiplayer games from Firebase and convert to training data.

Each game record contains SFN snapshots before and after each turn.
We replay each position, enumerate legal turns, find the one that matches
the human's action, and create a training example with policy = 1.0 for
the chosen turn (behavioral cloning).

Output format matches selfplay_mcts.py: JSONL with fields
sfn, spell_ids, raw_features, policy, turn_encodings, outcome.

Usage:
    # Set FIREBASE_DB_URL or pass --db-url
    python -m ai.import_human_games --db-url https://sigil-js-default-rtdb.firebaseio.com --output ai/data/human_games.jsonl

    # Or use a service account key for authenticated access
    python -m ai.import_human_games --service-account path/to/key.json --output ai/data/human_games.jsonl
"""

import argparse
import json
import os
import sys
import time

import requests
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from notation import sfn_to_dict, NODE_ORDER
from simboard import SimBoard, CORE_SPELLS
from search import _apply_turn
from ai.features import board_to_tensor, encode_all_turns
from ai.config import SPELL_TO_ID, DATA_DIR


def download_games(db_url, service_account_path=None):
    """Download completed games from Firebase Realtime Database.

    Returns list of game records.
    """
    url = db_url.rstrip('/') + '/completed_games.json'

    if service_account_path:
        # Use service account for authenticated access
        try:
            import google.auth.transport.requests
            from google.oauth2 import service_account

            creds = service_account.Credentials.from_service_account_file(
                service_account_path,
                scopes=['https://www.googleapis.com/auth/firebase.database']
            )
            creds.refresh(google.auth.transport.requests.Request())
            headers = {'Authorization': 'Bearer ' + creds.token}
            resp = requests.get(url, headers=headers)
        except ImportError:
            print("Install google-auth for service account support: pip install google-auth")
            sys.exit(1)
    else:
        # Anonymous access (works if read rules allow it, or in test mode)
        resp = requests.get(url)

    if resp.status_code != 200:
        print(f"Error downloading games: HTTP {resp.status_code}")
        print(resp.text[:500])
        sys.exit(1)

    data = resp.json()
    if data is None:
        print("No completed games found.")
        return []

    games = list(data.values())
    print(f"Downloaded {len(games)} completed games")
    return games


def find_matching_turn(board, color, sfn_after):
    """Enumerate legal turns and find the one that produces sfn_after.

    Returns (turn_index, legal_turns) or (None, legal_turns) if no match.
    """
    legal_turns = list(board.get_legal_turns(color))
    if not legal_turns:
        return None, legal_turns

    target_state = sfn_to_dict(sfn_after)

    for idx, turn in enumerate(legal_turns):
        test_board = board.copy()
        _apply_turn(test_board, turn, color)
        test_board.update()

        # Compare stone positions (the most discriminative check)
        match = True
        for node in NODE_ORDER:
            if test_board.stones[node] != target_state['stones'][node]:
                match = False
                break

        if match:
            return idx, legal_turns

    return None, legal_turns


def convert_game(game_record):
    """Convert one game record to training positions.

    Returns list of dicts matching selfplay_mcts.py format.
    """
    spell_names = game_record.get('spellNames', [])
    winner = game_record.get('winner')
    turns = game_record.get('turns', [])

    if not spell_names or not turns or not winner:
        return []

    positions = []
    unmatched = 0

    for turn_data in turns:
        color = turn_data.get('color')
        sfn_before = turn_data.get('sfnBefore')
        sfn_after = turn_data.get('sfnAfter')

        if not color or not sfn_before or not sfn_after:
            continue

        # Reconstruct board from SFN
        board = SimBoard.from_sfn(sfn_before)

        # Find which legal turn produces the after-state
        turn_idx, legal_turns = find_matching_turn(board, color, sfn_after)

        if turn_idx is None or not legal_turns:
            unmatched += 1
            continue

        # Create training example
        sfn = sfn_before
        spell_ids = [SPELL_TO_ID.get(board.spell_names[i], 0) for i in range(9)]

        raw, _ = board_to_tensor(board, color)
        turn_feats = encode_all_turns(legal_turns, board, color)

        # Policy: 1.0 for chosen turn, 0.0 for all others
        policy = np.zeros(len(legal_turns), dtype=np.float32)
        policy[turn_idx] = 1.0

        # Outcome from this color's perspective
        if winner == color:
            outcome = 1.0
        elif winner is not None:
            outcome = -1.0
        else:
            outcome = 0.0

        positions.append({
            'sfn': sfn,
            'spell_ids': spell_ids,
            'raw_features': raw.numpy().tolist(),
            'policy': policy.tolist(),
            'turn_encodings': turn_feats.numpy().tolist(),
            'outcome': outcome,
        })

    if unmatched > 0:
        print(f"  Warning: {unmatched} turns could not be matched to legal turns")

    return positions


def main():
    parser = argparse.ArgumentParser(
        description='Import human games from Firebase for AI training')
    parser.add_argument('--db-url', type=str, required=True,
                        help='Firebase Realtime Database URL')
    parser.add_argument('--service-account', type=str, default=None,
                        help='Path to Firebase service account JSON key')
    parser.add_argument('--output', type=str,
                        default=os.path.join(DATA_DIR, 'human_games.jsonl'),
                        help='Output JSONL path')
    args = parser.parse_args()

    games = download_games(args.db_url, args.service_account)
    if not games:
        return

    os.makedirs(os.path.dirname(args.output) if os.path.dirname(args.output) else '.',
                exist_ok=True)

    total_positions = 0
    start_time = time.time()

    with open(args.output, 'w') as f:
        for i, game in enumerate(games):
            positions = convert_game(game)
            for pos in positions:
                f.write(json.dumps(pos) + '\n')
                total_positions += 1

            if (i + 1) % 10 == 0 or i == 0:
                winner = game.get('winner', '?')
                print(f"Game {i+1}/{len(games)}: {len(positions)} positions, winner={winner}")

    elapsed = time.time() - start_time
    print(f"\nConverted {total_positions} positions from {len(games)} games "
          f"in {elapsed:.1f}s")
    print(f"Output: {args.output}")


if __name__ == '__main__':
    main()
