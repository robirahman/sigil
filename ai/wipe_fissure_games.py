"""Wipe completed game records that used the Fissure spell.

Fissure's mechanic changed (the target node is now *permanently destroyed*,
not just cleared of stones), so games recorded under the old rules would
mis-train the AI. This script finds every completed game whose spell set
includes 'Fissure' and deletes it — along with the per-user history index
entries (`user_games/<uid>/<pushKey>`) that mirror it.

Usage:
    # Dry run (default): list the matching games, delete nothing.
    python -m ai.wipe_fissure_games --service-account firebase-service-account.json

    # Actually delete them.
    python -m ai.wipe_fissure_games --service-account firebase-service-account.json --confirm

Auth uses the same service-account REST pattern as ai/deploy_db_rules.py and
the elo scripts. On this box, bootstrap deps first (see firebase notes):
    python3 /tmp/get-pip.py --target /tmp/pylibs
    pip install --target /tmp/pylibs requests google-auth
    PYTHONPATH=/tmp/pylibs python -m ai.wipe_fissure_games --service-account firebase-service-account.json
"""
import argparse
import sys

import requests

DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'
SPELL = 'Fissure'


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


def find_fissure_games(db_url, token):
    """Return {pushKey: record} for every completed game containing Fissure."""
    url = db_url.rstrip('/') + '/completed_games.json'
    resp = requests.get(url, params={'access_token': token})
    resp.raise_for_status()
    games = resp.json() or {}
    matches = {}
    for key, rec in games.items():
        if not isinstance(rec, dict):
            continue
        if SPELL in (rec.get('spellNames') or []):
            matches[key] = rec
    return matches


def build_delete_patch(matches):
    """Multi-location update map: every path set to None is deleted.

    Removes the completed_games record and the per-user history index
    entries (user_games/<uid>/<pushKey>) for both players, when present.
    """
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
        description='Delete completed games that used the Fissure spell')
    parser.add_argument('--service-account', required=True)
    parser.add_argument('--db-url', default=DB_URL)
    parser.add_argument('--confirm', action='store_true',
                        help='Actually delete (default: dry run)')
    args = parser.parse_args()

    token = auth_token(args.service_account)
    matches = find_fissure_games(args.db_url, token)

    if not matches:
        print('No completed games contain Fissure — nothing to do.')
        return 0

    print(f'Found {len(matches)} completed game(s) containing {SPELL!r}:')
    for key, rec in sorted(matches.items(),
                           key=lambda kv: kv[1].get('timestamp') or 0):
        ts = rec.get('timestamp')
        winner = rec.get('winner')
        ranked = rec.get('ranked')
        print(f'  {key}  winner={winner}  ranked={ranked}  ts={ts}')

    patch = build_delete_patch(matches)
    print(f'\nThis will delete {len(patch)} database path(s) '
          f'(records + per-user index entries).')

    if not args.confirm:
        print('\n[dry run] Re-run with --confirm to delete the games above.')
        return 0

    resp = requests.patch(args.db_url.rstrip('/') + '/.json',
                          params={'access_token': token}, json=patch)
    resp.raise_for_status()
    print(f'\nDeleted {len(matches)} Fissure game(s) from {args.db_url}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
