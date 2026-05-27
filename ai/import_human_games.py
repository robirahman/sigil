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
import datetime
import json
import os
import sys
import time

import requests
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from notation import sfn_to_dict, NODE_ORDER, POSITIONS
from simboard import SimBoard, CORE_SPELLS
from ai.search import _apply_turn
from ai.features import board_to_tensor, encode_all_turns
from ai.enumerator import get_legal_turns_exhaustive
from ai.config import SPELL_TO_ID, DATA_DIR
from ai.data_filters import FIREBLAST_RULE_CHANGE_CUTOFF


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
                scopes=['https://www.googleapis.com/auth/firebase.database',
                        'https://www.googleapis.com/auth/userinfo.email']
            )
            creds.refresh(google.auth.transport.requests.Request())
            resp = requests.get(url, params={'access_token': creds.token})
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

    # Preserve the Firebase key on each record (handy for logging / dedup).
    games = [dict(v, _gid=k) for k, v in data.items() if isinstance(v, dict)]
    print(f"Downloaded {len(games)} completed games")
    return games


def find_matching_turn(board, color, sfn_after):
    """Find the exhaustively-enumerated legal turn the human actually played.

    Self-play, MCTS and training all enumerate turns exhaustively
    (every keep-set, push destination and effect target) — so we
    enumerate the same way here and replay each candidate to the board
    it produces, comparing against the human's recorded after-state.
    Because every distinct in-turn choice (which stones to keep when
    refilling, where a pushed enemy lands, which target a spell hits)
    replays to a distinct board, an exact match uniquely recovers the
    human's choice and encodes it as the correct turn — no greedy
    collapse. The stored policy is then a one-hot on a *real* variant.

    Matching is exact on stones (the dominant, proven-distinguishing
    signal), with lock / springlock as a tie-break for the rare case
    of two variants with identical stones. Unmatched turns (e.g. the
    JS engine resolved a spell in a way SimBoard doesn't reproduce)
    return None so the caller can discard rather than guess — we never
    fabricate a policy target.

    Returns (turn_index, legal_turns) or (None, legal_turns) if no match.
    """
    legal_turns = list(get_legal_turns_exhaustive(board, color, exhaustive=True))
    if not legal_turns:
        return None, legal_turns

    target = sfn_to_dict(sfn_after)
    tgt_stones = target['stones']
    tgt_lock = (target.get('red_lock'), target.get('blue_lock'))
    tgt_spring = (target.get('red_springlock'), target.get('blue_springlock'))

    stone_matches = []
    for idx, turn in enumerate(legal_turns):
        test_board = board.copy()
        _apply_turn(test_board, turn, color)
        test_board.update()
        if all(test_board.stones[n] == tgt_stones[n] for n in NODE_ORDER):
            stone_matches.append((idx, test_board))

    if not stone_matches:
        return None, legal_turns
    if len(stone_matches) == 1:
        return stone_matches[0][0], legal_turns

    # Tie-break identical-stone variants by lock / springlock state.
    for idx, tb in stone_matches:
        if ((tb.lock['red'], tb.lock['blue']) == tgt_lock and
                (tb.springlock['red'], tb.springlock['blue']) == tgt_spring):
            return idx, legal_turns
    # Still tied: the variants reach the same stones+locks, so they are
    # behaviorally identical for training — take the first.
    return stone_matches[0][0], legal_turns


def game_played_date(game_record):
    """Best-effort date the game was played, from the Firebase
    `timestamp` (ms epoch). Returns a datetime.date or None."""
    ts = game_record.get('timestamp')
    if ts is None:
        return None
    try:
        ts = float(ts)
    except (TypeError, ValueError):
        return None
    if ts > 1e12:          # milliseconds → seconds
        ts /= 1000.0
    try:
        return datetime.date.fromtimestamp(ts)
    except (OverflowError, OSError, ValueError):
        return None


def convert_game(game_record):
    """Convert one game record to training positions.

    Returns (positions, matched, unmatched): a list of dicts matching
    selfplay_mcts.py's record format, plus how many turns were matched
    to an enumerated turn vs. discarded as unmatchable.
    """
    spell_names = game_record.get('spellNames', [])
    winner = game_record.get('winner')
    turns = game_record.get('turns', [])
    played_date = game_played_date(game_record)
    red_elo = game_record.get('redEloBefore')
    blue_elo = game_record.get('blueEloBefore')
    # Player-supplied per-turn annotations: { '<turnNumber>': 'good' | 'bad' }.
    # Firebase keys are strings; we coerce to int below for matching.
    raw_annotations = game_record.get('annotations') or {}
    annotations = {}
    for k, v in raw_annotations.items():
        if v not in ('good', 'bad'):
            continue
        try:
            annotations[int(k)] = v
        except (TypeError, ValueError):
            continue

    if not spell_names or not turns or not winner:
        return [], 0, 0

    # Skip games using spells outside the net's fixed vocabulary — the
    # spell-embedding can't represent them, and silently mapping an
    # unknown spell to id 0 (Flourish) would corrupt the input. (Newer
    # spells like Syzygy / Eclipse / Seal_of_Spring appear in a handful
    # of real games.)
    if any(s not in SPELL_TO_ID for s in spell_names):
        return [], 0, 0

    positions = []
    matched = 0
    unmatched = 0

    for turn_data in turns:
        color = turn_data.get('color')
        sfn_before = turn_data.get('sfnBefore')
        sfn_after = turn_data.get('sfnAfter')
        turn_number = turn_data.get('turnNumber')

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

        position = {
            'sfn': sfn,
            'spell_ids': spell_ids,
            'raw_features': raw.numpy().tolist(),
            'policy': policy.tolist(),
            'turn_encodings': turn_feats.numpy().tolist(),
            'outcome': outcome,
        }
        # Player's own rating from their POV; opponent's for context. Optional.
        own_elo = red_elo if color == 'red' else blue_elo
        opp_elo = blue_elo if color == 'red' else red_elo
        if own_elo is not None:
            position['player_elo'] = own_elo
        if opp_elo is not None:
            position['opponent_elo'] = opp_elo
        # Human-supplied annotation, if any. Each annotation is set by the
        # OPPOSITE-color player about the move whose turnNumber this is.
        if turn_number is not None and turn_number in annotations:
            position['annotation'] = annotations[turn_number]
        if played_date is not None:
            position['played_date'] = played_date.isoformat()
        positions.append(position)
        matched += 1

    return positions, matched, unmatched


def _convert_task(arg):
    """Top-level worker for multiprocessing: (game_index, record) ->
    (game_index, positions, matched, unmatched)."""
    i, game = arg
    positions, matched, unmatched = convert_game(game)
    return i, positions, matched, unmatched


def _has_fireblast(spell_names):
    return any(s == 'Fireblast' for s in (spell_names or []))


def main():
    parser = argparse.ArgumentParser(
        description='Import human games from Firebase for AI training')
    parser.add_argument('--db-url', type=str,
                        default='https://sigil-js-default-rtdb.firebaseio.com',
                        help='Firebase Realtime Database URL')
    parser.add_argument('--service-account', type=str, default=None,
                        help='Path to Firebase service account JSON key')
    parser.add_argument('--output', type=str, default=None,
                        help='Output JSONL path (default: '
                             'ai/data/human/human_games_<today>.jsonl)')
    parser.add_argument('--jobs', type=int, default=1,
                        help='Parallel worker processes for conversion '
                             '(exhaustive enumeration is CPU-bound)')
    args = parser.parse_args()

    if args.output is None:
        today = datetime.date.today().isoformat()
        args.output = os.path.join(DATA_DIR, 'human',
                                   f'human_games_{today}.jsonl')

    games = download_games(args.db_url, args.service_account)
    if not games:
        return

    # Pre-filter: drop games that pre-date the Fireblast nerf AND used
    # Fireblast (old, cost-free Fireblast mis-teaches the value head).
    # Uses the authoritative Firebase timestamp, not file mtime. The
    # glitched competitive opening-pass games were already removed from
    # Firebase, so no competitive carve-out is needed here.
    kept_games = []
    skipped_fireblast = 0
    skipped_oov = 0
    for g in games:
        sn = g.get('spellNames') or []
        if any(s not in SPELL_TO_ID for s in sn):
            skipped_oov += 1          # uses spells the net can't represent
            continue
        d = game_played_date(g)
        if (d is not None and d < FIREBLAST_RULE_CHANGE_CUTOFF
                and _has_fireblast(sn)):
            skipped_fireblast += 1
            continue
        kept_games.append(g)

    os.makedirs(os.path.dirname(args.output) if os.path.dirname(args.output) else '.',
                exist_ok=True)

    total_positions = 0
    total_matched = 0
    total_unmatched = 0
    games_with_positions = 0
    elos = []
    dates = []
    annotations = 0
    start_time = time.time()

    tasks = list(enumerate(kept_games))

    def _handle(i, game, positions, matched, unmatched, fh):
        nonlocal total_positions, total_matched, total_unmatched
        nonlocal games_with_positions, annotations
        total_matched += matched
        total_unmatched += unmatched
        if positions:
            games_with_positions += 1
        for pos in positions:
            pos['game_index'] = i
            fh.write(json.dumps(pos) + '\n')
            total_positions += 1
            if pos.get('player_elo') is not None:
                elos.append(pos['player_elo'])
            if pos.get('played_date'):
                dates.append(pos['played_date'])
            if pos.get('annotation'):
                annotations += 1

    with open(args.output, 'w') as f:
        if args.jobs and args.jobs > 1:
            from multiprocessing import Pool
            with Pool(args.jobs) as pool:
                for n, (i, positions, matched, unmatched) in enumerate(
                        pool.imap_unordered(_convert_task, tasks, chunksize=4)):
                    _handle(i, kept_games[i], positions, matched, unmatched, f)
                    if (n + 1) % 50 == 0:
                        print(f"  processed {n+1}/{len(tasks)} games "
                              f"({total_positions} positions)")
        else:
            for n, (i, game) in enumerate(tasks):
                positions, matched, unmatched = convert_game(game)
                _handle(i, game, positions, matched, unmatched, f)
                if (n + 1) % 50 == 0:
                    print(f"  processed {n+1}/{len(tasks)} games "
                          f"({total_positions} positions)")

    elapsed = time.time() - start_time
    match_total = total_matched + total_unmatched
    match_rate = (total_matched / match_total * 100) if match_total else 0.0
    print(f"\nConverted {total_positions} positions from "
          f"{games_with_positions}/{len(kept_games)} games in {elapsed:.1f}s")
    print(f"  skipped (out-of-vocab spells): {skipped_oov} games")
    print(f"  skipped (pre-nerf Fireblast): {skipped_fireblast} games")
    print(f"  turn match rate: {total_matched}/{match_total} ({match_rate:.1f}%) "
          f"— {total_unmatched} unmatched/discarded")
    if elos:
        import statistics
        elos_sorted = sorted(elos)
        print(f"  player_elo (positions w/ rating): n={len(elos)} "
              f"min={elos_sorted[0]} median={int(statistics.median(elos_sorted))} "
              f"max={elos_sorted[-1]}")
        for lo in (0, 1050, 1200, 1400):
            print(f"    >= {lo}: {sum(1 for e in elos if e >= lo)} positions")
    if dates:
        print(f"  played dates: {min(dates)} -> {max(dates)}")
    print(f"  annotated positions: {annotations}")
    print(f"Output: {args.output}")


if __name__ == '__main__':
    main()
