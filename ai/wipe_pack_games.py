"""Wipe completed game records that used given expansion-pack spells.

Used when a pack's mechanics change incompatibly (first use: the 2026-08-24
Aftershock/Ambush buff — burns bank instead of fizzling, burns/snares count
fully toward the owner's stone total), so games recorded under the old rules
would mis-train the AI and can no longer replay byte-faithfully. Finds every
completed game whose spell set includes any of the target spells and deletes
it — along with the per-user history index entries
(`user_games/<uid>/<pushKey>`) that mirror it. The matched records are
backed up to a local gitignored JSON file before any delete.

Usage:
    # Dry run (default): list the matching games, delete nothing.
    python -m ai.wipe_pack_games --service-account firebase-service-account.json

    # Actually delete them.
    python -m ai.wipe_pack_games --service-account firebase-service-account.json --confirm

    # Other spell sets:
    python -m ai.wipe_pack_games --service-account ... --spells Ember Smolder

Auth uses the same service-account REST pattern as ai/wipe_fissure_games.py.
"""
import argparse
import json
import sys
import time

import requests

DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'
DEFAULT_SPELLS = ['Ember', 'Smolder', 'Conflagration',
                  'Tripwire', 'Deadfall', 'Minefield']


def auth_token(service_account_path):
    import google.auth.transport.requests
    from google.oauth2 import service_account
    creds = service_account.Credentials.from_service_account_file(
        service_account_path,
        scopes=['https://www.googleapis.com/auth/firebase.database',
                'https://www.googleapis.com/auth/userinfo.email'],
    )
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def find_pack_games(db_url, token, spells):
    """Return {pushKey: record} for every completed game using the spells."""
    url = db_url.rstrip('/') + '/completed_games.json'
    resp = requests.get(url, params={'access_token': token})
    resp.raise_for_status()
    games = resp.json() or {}
    targets = set(spells)
    matches = {}
    for key, rec in games.items():
        if not isinstance(rec, dict):
            continue
        if targets & set(rec.get('spellNames') or []):
            matches[key] = rec
    return matches


def build_delete_patch(matches):
    """Multi-location update map: every path set to None is deleted."""
    patch = {}
    for key, rec in matches.items():
        patch[f'completed_games/{key}'] = None
        for uid_field in ('redUid', 'blueUid'):
            uid = rec.get(uid_field)
            if uid:
                patch[f'user_games/{uid}/{key}'] = None
    return patch


def main():
    parser = argparse.ArgumentParser(
        description='Delete completed games that used given pack spells')
    parser.add_argument('--service-account', required=True)
    parser.add_argument('--db-url', default=DB_URL)
    parser.add_argument('--spells', nargs='+', default=DEFAULT_SPELLS)
    parser.add_argument('--confirm', action='store_true',
                        help='Actually delete (default: dry run)')
    args = parser.parse_args()

    token = auth_token(args.service_account)
    matches = find_pack_games(args.db_url, token, args.spells)

    if not matches:
        print('No completed games contain %s — nothing to do.'
              % ', '.join(args.spells))
        return 0

    print(f'Found {len(matches)} completed game(s) containing any of '
          f'{args.spells}:')
    for key, rec in sorted(matches.items(),
                           key=lambda kv: kv[1].get('timestamp') or 0):
        print('  %s  winner=%s  ranked=%s  ts=%s' % (
            key, rec.get('winner'), rec.get('ranked'), rec.get('timestamp')))

    patch = build_delete_patch(matches)
    print(f'\nThis will delete {len(patch)} database path(s) '
          f'(records + per-user index entries).')

    if not args.confirm:
        print('\n[dry run] Re-run with --confirm to delete the games above.')
        return 0

    backup_path = ('ai/data/completed_games_backup_wiped_packs_%s.json'
                   % time.strftime('%Y-%m-%d'))
    with open(backup_path, 'w') as f:
        json.dump(matches, f)
    print(f'Backed up {len(matches)} record(s) to {backup_path} '
          '(gitignored, local only).')

    resp = requests.patch(args.db_url.rstrip('/') + '/.json',
                          params={'access_token': token}, json=patch)
    resp.raise_for_status()
    print(f'\nDeleted {len(matches)} game(s) from {args.db_url}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
