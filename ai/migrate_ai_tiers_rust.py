"""One-time migration: retire the JS Caveman picker tiers in favor of Rust ones.

For each of the four picker tiers (easy / medium / hard / very_hard):

  1. Rename the existing JS AI's records to include "(JS)" —
     `users/__ai_<tier>__/displayName` and `leaderboard/__ai_<tier>__/displayName`
     become e.g. "AI (Easy) (JS)". Elo, W/L and game history stay attached:
     these records keep tracking any games still played against the JS AIs
     via direct ?ai=easy-style URLs.

  2. Create the replacement Rust AI's records at `__ai_rust_<tier>__`
     ("AI (Easy) (Rust)", ...) seeded 200 Elo ABOVE the JS counterpart's
     CURRENT Elo — the engine measures roughly that much stronger at equal
     time — with zeroed game counters.

Idempotent: a JS record whose name already ends in "(JS)" is left alone, and
an existing rust record is never overwritten (its Elo is live data by then).
A missing JS record (tier never played a rated game) still gets its Rust
counterpart, seeded from the 1000 baseline.

Usage:
    python -m ai.migrate_ai_tiers_rust --service-account firebase-service-account.json [--apply]
"""

import argparse
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ai.backfill_game_elos import auth_token

DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'
ELO_OFFSET = 200
BASELINE_ELO = 1000

TIERS = {
    'easy': 'Easy',
    'medium': 'Medium',
    'hard': 'Hard',
    'very_hard': 'Very Hard',
}


def main():
    parser = argparse.ArgumentParser(description='Rename JS AI tiers, create Rust ones')
    parser.add_argument('--service-account', required=True)
    parser.add_argument('--db-url', default=DB_URL)
    parser.add_argument('--apply', action='store_true',
                        help='Actually write updates (default: dry run)')
    args = parser.parse_args()

    token = auth_token(args.service_account)
    base = args.db_url.rstrip('/')

    def get(path):
        r = requests.get(f'{base}/{path}.json', params={'access_token': token})
        r.raise_for_status()
        return r.json()

    updates = {}
    for tier, label in TIERS.items():
        js_uid = f'__ai_{tier}__'
        rust_uid = f'__ai_rust_{tier}__'
        js_name = f'AI ({label}) (JS)'
        rust_name = f'AI ({label}) (Rust)'

        js_user = get(f'users/{js_uid}') or {}
        js_board = get(f'leaderboard/{js_uid}') or {}
        rust_user = get(f'users/{rust_uid}')

        js_elo = js_user.get('elo', js_board.get('elo', BASELINE_ELO))
        rust_elo = js_elo + ELO_OFFSET

        print(f'{tier}:')
        print(f'  JS   {js_uid}: '
              + (f'elo={js_elo} games={js_user.get("gamesPlayed", 0)} '
                 f'name={js_user.get("displayName")!r} -> {js_name!r}'
                 if (js_user or js_board) else 'no record (never played rated)'))

        # 1. Rename the JS records that exist (idempotent).
        for path, rec in ((f'users/{js_uid}', js_user),
                          (f'leaderboard/{js_uid}', js_board)):
            if rec and rec.get('displayName') != js_name:
                updates[f'{path}/displayName'] = js_name

        # 2. Create the Rust records unless they already exist.
        if rust_user:
            print(f'  Rust {rust_uid}: already exists '
                  f'(elo={rust_user.get("elo")}) — leaving untouched')
            continue
        print(f'  Rust {rust_uid}: create at elo={rust_elo} '
              f'({js_elo} + {ELO_OFFSET})')
        updates[f'users/{rust_uid}'] = {
            'displayName': rust_name,
            'elo': rust_elo,
            'gamesPlayed': 0,
            'wins': 0,
            'losses': 0,
            'created': int(time.time() * 1000),
            'isAI': True,
        }
        updates[f'leaderboard/{rust_uid}'] = {
            'displayName': rust_name,
            'elo': rust_elo,
            'gamesPlayed': 0,
            'isAI': True,
        }

    if not updates:
        print('\nNothing to do — already migrated.')
        return

    print(f'\n{len(updates)} update paths:')
    for k in sorted(updates):
        print(f'  {k} = {updates[k]!r}')

    if not args.apply:
        print('\nDry run. Re-run with --apply to write.')
        return

    r = requests.patch(f'{base}/.json', params={'access_token': token},
                       json=updates)
    r.raise_for_status()
    print('\nApplied.')


if __name__ == '__main__':
    main()
