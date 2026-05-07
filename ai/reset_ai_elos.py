"""Reset Elo scores for every AI opponent in Firebase to baseline (1000).

Wipes accumulated Elo / win-loss counters from /users/<aiUid> and
/leaderboard/<aiUid> for every user with `isAI: true`. Intended for
use right after an AI tier upgrade so the leaderboard reflects the
new strength rather than the old.

Usage:
    python -m ai.reset_ai_elos --service-account firebase-service-account.json --apply
"""

import argparse
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ai.backfill_game_elos import auth_token

DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'
RESET_ELO = 1000


def main():
    parser = argparse.ArgumentParser(description='Reset AI Elo to baseline')
    parser.add_argument('--service-account', required=True)
    parser.add_argument('--db-url', default=DB_URL)
    parser.add_argument('--reset-elo', type=int, default=RESET_ELO)
    parser.add_argument('--apply', action='store_true',
                        help='Actually write updates (default: dry run)')
    args = parser.parse_args()

    token = auth_token(args.service_account)
    base = args.db_url.rstrip('/')

    users = requests.get(base + '/users.json',
                         params={'access_token': token}).json() or {}
    print(f'Loaded {len(users)} users')

    ai_uids = [uid for uid, u in users.items()
               if isinstance(u, dict) and u.get('isAI')]
    print(f'AI users to reset ({len(ai_uids)}):')
    for uid in ai_uids:
        u = users[uid]
        print(f'  {uid}: elo={u.get("elo")} games={u.get("gamesPlayed")} '
              f'W={u.get("wins")} L={u.get("losses")}')

    if not ai_uids:
        print('No AI users found.')
        return

    updates = {}
    for uid in ai_uids:
        for path in (f'users/{uid}', f'leaderboard/{uid}'):
            updates[f'{path}/elo'] = args.reset_elo
            updates[f'{path}/gamesPlayed'] = 0
            updates[f'{path}/wins'] = 0
            updates[f'{path}/losses'] = 0
    print(f'\nField updates to apply: {len(updates)}')

    if not args.apply:
        print('Dry run. Re-run with --apply to write.')
        return

    r = requests.patch(base + '/.json',
                       params={'access_token': token}, json=updates)
    if r.status_code != 200:
        print(f'PATCH failed: HTTP {r.status_code}')
        print(r.text[:500])
        sys.exit(1)
    print('Done.')


if __name__ == '__main__':
    main()
