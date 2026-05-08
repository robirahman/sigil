"""Set or clear the `isDeveloper` flag on a user account in Firebase RTDB.

The flag gates the dev-only AI evaluation display in the game UI. Client
RTDB rules disallow writing `true` to /users/<uid>/isDeveloper directly,
so promotion has to happen via a service-account-authenticated REST call
that bypasses rules.

Usage:
    # Promote a user (requires --apply; default is dry-run)
    python -m ai.set_developer --uid <uid> --apply

    # Revoke
    python -m ai.set_developer --uid <uid> --revoke --apply

    # Look up a user's UID by displayName (case-sensitive substring match)
    python -m ai.set_developer --find <displayName>
"""

import argparse
import sys

import requests

# Re-uses the same auth_token helper that backfill_game_elos uses.
from ai.backfill_game_elos import auth_token, DB_URL


def find_uid_by_name(base, token, name_query):
    """Print users whose displayName contains the query (case-insensitive)."""
    resp = requests.get(base + '/users.json', params={'access_token': token})
    resp.raise_for_status()
    users = resp.json() or {}
    q = name_query.lower()
    matches = []
    for uid, profile in users.items():
        name = (profile or {}).get('displayName', '')
        if q in name.lower():
            matches.append((uid, name, (profile or {}).get('isDeveloper', False)))
    if not matches:
        print(f"No users with displayName containing {name_query!r}.")
        return
    print(f"{len(matches)} match(es):")
    for uid, name, is_dev in matches:
        flag = ' [dev]' if is_dev else ''
        print(f"  {uid}  {name}{flag}")


def main():
    p = argparse.ArgumentParser(
        description='Set or clear the isDeveloper flag on a user account.')
    p.add_argument('--service-account', default='firebase-service-account.json',
                   help='Path to Firebase service-account JSON.')
    p.add_argument('--db-url', default=DB_URL)
    p.add_argument('--uid', help='User UID to modify.')
    p.add_argument('--revoke', action='store_true',
                   help='Set isDeveloper to false instead of true.')
    p.add_argument('--apply', action='store_true',
                   help='Actually write the change (default: dry run).')
    p.add_argument('--find', metavar='QUERY',
                   help='List user UIDs whose displayName contains QUERY '
                        '(case-insensitive). Mutually exclusive with --uid.')
    args = p.parse_args()

    base = args.db_url.rstrip('/')
    token = auth_token(args.service_account)

    if args.find:
        find_uid_by_name(base, token, args.find)
        return

    if not args.uid:
        p.error('Either --uid or --find must be provided.')

    # Read current state to confirm the user exists.
    user_url = f'{base}/users/{args.uid}.json'
    resp = requests.get(user_url, params={'access_token': token})
    resp.raise_for_status()
    profile = resp.json()
    if profile is None:
        print(f'No /users/{args.uid} record found. Aborting.')
        sys.exit(1)

    current = bool(profile.get('isDeveloper'))
    new_value = not args.revoke
    print(f'User: {args.uid}  ({profile.get("displayName", "?")})')
    print(f'  current isDeveloper={current} -> new={new_value}')

    if current == new_value:
        print('  No change needed; already at desired value.')
        return

    if not args.apply:
        print('  Dry run. Re-run with --apply to write.')
        return

    # Atomic two-path update so /users/<uid>/isDeveloper and the
    # denormalized /leaderboard/<uid>/isDeveloper stay in sync; the
    # leaderboard page reads the flag from the denorm entry to avoid
    # one /users/<uid> fetch per row.
    updates = {
        f'users/{args.uid}/isDeveloper': new_value,
        f'leaderboard/{args.uid}/isDeveloper': new_value,
    }
    resp = requests.patch(f'{base}/.json', params={'access_token': token},
                          json=updates)
    if resp.status_code != 200:
        print(f'  Write failed: HTTP {resp.status_code}')
        print('  ', resp.text[:300])
        sys.exit(1)
    print(f'  Wrote isDeveloper={new_value} to /users + /leaderboard.')


if __name__ == '__main__':
    main()
