"""Roll back games that ended prematurely due to the doPushEnemy mid-update bug.

The bug (fixed in spells.js commit bf4494f / 9349d65 on gh-pages-static):
when a player hard-moved the enemy's only stone in a competitive variant
opening, the live engine called board.update() between overwriting the
enemy stone and placing the pushed stone at its destination — so the
zero-stones immediate-loss rule fired against a side that was about to
have its stone re-placed somewhere else on the board.

This script:
  1. Identifies affected /completed_games records (variant=competitive,
     <=4 turns, loser still had >=1 stone in the final SFN).
  2. Backs up each record to a local JSON file.
  3. Reverses the Elo change on both players' /users + /leaderboard.
  4. Decrements gamesPlayed / wins / losses for both.
  5. Removes the per-user index entries from /user_games/<uid>/<gameId>.
  6. Deletes the /completed_games/<gameId> record so the training
     pipeline's next Firebase poll skips it cleanly.

Usage:
    python -m ai.rollback_glitched_games --apply
"""

import argparse
import json
import os
import sys
import time

import requests

from ai.backfill_game_elos import auth_token, DB_URL


def find_affected(base, token):
    """Return list of (game_id, game_record) for games that match the bug."""
    r = requests.get(base + '/completed_games.json', params={'access_token': token})
    r.raise_for_status()
    games = r.json() or {}
    affected = []
    for gid, g in games.items():
        if g.get('variant') != 'competitive':
            continue
        if g.get('autoArena'):
            # Orchestrator tier-arena games never hit doPushEnemy
            # (SimBoard's _pushEnemy is atomic).
            continue
        turns = g.get('turns') or []
        if len(turns) > 4:
            continue
        winner = g.get('winner')
        if not winner:
            continue
        last_sfn = turns[-1].get('sfnAfter') if turns else ''
        if not last_sfn:
            continue
        stones = last_sfn.split('/', 1)[0]
        red_count = stones.count('r')
        blue_count = stones.count('b')
        loser = 'blue' if winner == 'red' else 'red'
        loser_count = blue_count if loser == 'blue' else red_count
        if loser_count >= 1:
            affected.append((gid, g))
    return affected


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--service-account', default='firebase-service-account.json')
    p.add_argument('--db-url', default=DB_URL)
    p.add_argument('--apply', action='store_true',
                   help='Actually write the rollback (default: dry run).')
    p.add_argument('--backup-dir', default='ai/data/rollback_backup',
                   help='Directory to dump original game records before deletion.')
    args = p.parse_args()

    base = args.db_url.rstrip('/')
    token = auth_token(args.service_account)

    affected = find_affected(base, token)
    print(f'Found {len(affected)} affected game(s).')
    if not affected:
        return

    os.makedirs(args.backup_dir, exist_ok=True)

    for gid, g in affected:
        ts_iso = time.strftime('%Y-%m-%d %H:%M:%S',
                               time.localtime(g.get('timestamp', 0)/1000))
        winner = g['winner']
        loser = 'blue' if winner == 'red' else 'red'
        red_uid = g.get('redUid')
        blue_uid = g.get('blueUid')
        winner_uid = red_uid if winner == 'red' else blue_uid
        loser_uid = red_uid if loser == 'red' else blue_uid
        delta = int(g.get('eloChange') or 0)

        print(f'\n--- {gid} ({ts_iso}) ---')
        print(f'  variant={g.get("variant")} winner={winner} eloChange={delta}')
        print(f'  red_uid={red_uid}  blue_uid={blue_uid}')

        # Look up live Elo + counters for both players
        wr = requests.get(f'{base}/users/{winner_uid}.json',
                          params={'access_token': token})
        lr = requests.get(f'{base}/users/{loser_uid}.json',
                          params={'access_token': token})
        wp = wr.json() or {}
        lp = lr.json() or {}

        new_winner_elo = (wp.get('elo') or 1000) - delta
        new_loser_elo = (lp.get('elo') or 1000) + delta
        new_winner_games = max(0, (wp.get('gamesPlayed') or 0) - 1)
        new_loser_games = max(0, (lp.get('gamesPlayed') or 0) - 1)
        new_winner_wins = max(0, (wp.get('wins') or 0) - 1)
        new_loser_losses = max(0, (lp.get('losses') or 0) - 1)

        print(f'  winner ({wp.get("displayName","?")}): '
              f'elo {wp.get("elo")} -> {new_winner_elo}, '
              f'games {wp.get("gamesPlayed")} -> {new_winner_games}, '
              f'wins {wp.get("wins")} -> {new_winner_wins}')
        print(f'  loser  ({lp.get("displayName","?")}): '
              f'elo {lp.get("elo")} -> {new_loser_elo}, '
              f'games {lp.get("gamesPlayed")} -> {new_loser_games}, '
              f'losses {lp.get("losses")} -> {new_loser_losses}')

        backup_path = os.path.join(args.backup_dir, f'{gid}.json')
        if args.apply:
            with open(backup_path, 'w', encoding='utf-8') as f:
                json.dump({'gameId': gid, 'record': g,
                           'winnerProfileBefore': wp,
                           'loserProfileBefore': lp},
                          f, indent=2)
            print(f'  backed up to {backup_path}')

        # Atomic multi-path update
        updates = {
            f'users/{winner_uid}/elo': new_winner_elo,
            f'users/{winner_uid}/gamesPlayed': new_winner_games,
            f'users/{winner_uid}/wins': new_winner_wins,
            f'users/{loser_uid}/elo': new_loser_elo,
            f'users/{loser_uid}/gamesPlayed': new_loser_games,
            f'users/{loser_uid}/losses': new_loser_losses,
            f'leaderboard/{winner_uid}/elo': new_winner_elo,
            f'leaderboard/{winner_uid}/gamesPlayed': new_winner_games,
            f'leaderboard/{loser_uid}/elo': new_loser_elo,
            f'leaderboard/{loser_uid}/gamesPlayed': new_loser_games,
            f'user_games/{red_uid}/{gid}': None,
            f'user_games/{blue_uid}/{gid}': None,
            f'completed_games/{gid}': None,
        }

        if not args.apply:
            print(f'  (dry run — would PATCH {len(updates)} fields)')
            continue

        r = requests.patch(f'{base}/.json',
                           params={'access_token': token}, json=updates)
        if r.status_code != 200:
            print(f'  PATCH failed: {r.status_code} {r.text[:300]}')
            continue
        print(f'  rollback applied ({len(updates)} fields).')

    if not args.apply:
        print('\nDry run. Re-run with --apply to roll back for real.')


if __name__ == '__main__':
    main()
