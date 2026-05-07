"""Backfill redEloBefore/blueEloBefore/redEloAfter/blueEloAfter on existing
completed_games records by replaying eloChange deltas in chronological order.

All users (human and AI) start at 1000. For each ranked, eloProcessed game,
the player's Elo before is the running total; the after is computed by
applying the recorded eloChange (which is authoritative for the points
exchanged). After replay we verify reconstructed totals against the live
users/<uid>/elo values.

Usage:
    python -m ai.backfill_game_elos --service-account firebase-service-account.json
    python -m ai.backfill_game_elos --service-account firebase-service-account.json --apply
"""

import argparse
import os
import sys
from collections import defaultdict

import requests

DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'
DEFAULT_ELO = 1000


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


def main():
    parser = argparse.ArgumentParser(description='Backfill per-game player ratings')
    parser.add_argument('--service-account', required=True)
    parser.add_argument('--db-url', default=DB_URL)
    parser.add_argument('--apply', action='store_true',
                        help='Actually write updates (default: dry run)')
    args = parser.parse_args()

    token = auth_token(args.service_account)
    base = args.db_url.rstrip('/')

    resp = requests.get(base + '/completed_games.json',
                        params={'access_token': token})
    resp.raise_for_status()
    games = resp.json() or {}
    print(f'Loaded {len(games)} games')

    # Chronological order; push key is a deterministic tiebreaker
    items = sorted(games.items(),
                   key=lambda kv: (kv[1].get('timestamp', 0), kv[0]))

    running = defaultdict(lambda: DEFAULT_ELO)
    updates = {}
    counts = defaultdict(int)

    for game_id, g in items:
        if not g.get('ranked') or not g.get('eloProcessed'):
            counts['skip_unranked'] += 1
            continue

        red_uid = g.get('redUid')
        blue_uid = g.get('blueUid')
        delta = g.get('eloChange')
        winner = g.get('winner')

        if not red_uid or not blue_uid or delta is None or winner not in ('red', 'blue'):
            counts['skip_missing_fields'] += 1
            continue
        if red_uid == blue_uid:
            counts['skip_self_play'] += 1
            continue

        red_before = running[red_uid]
        blue_before = running[blue_uid]
        if winner == 'red':
            red_after, blue_after = red_before + delta, blue_before - delta
        else:
            red_after, blue_after = red_before - delta, blue_before + delta
        running[red_uid] = red_after
        running[blue_uid] = blue_after

        if 'redEloBefore' in g and 'blueEloBefore' in g:
            counts['skip_already_set'] += 1
            continue

        prefix = f'completed_games/{game_id}'
        updates[f'{prefix}/redEloBefore'] = red_before
        updates[f'{prefix}/blueEloBefore'] = blue_before
        updates[f'{prefix}/redEloAfter'] = red_after
        updates[f'{prefix}/blueEloAfter'] = blue_after
        counts['will_write'] += 1

    print(f"Will write:        {counts['will_write']} games "
          f"({len(updates)} field updates)")
    print(f"Already populated: {counts['skip_already_set']}")
    print(f"Unranked/unproc:   {counts['skip_unranked']}")
    print(f"Self-play:         {counts['skip_self_play']}")
    print(f"Missing fields:    {counts['skip_missing_fields']}")

    print('\nVerifying reconstructed totals against live users/<uid>/elo ...')
    users_resp = requests.get(base + '/users.json',
                              params={'access_token': token})
    users_resp.raise_for_status()
    users = users_resp.json() or {}
    mismatches = []
    for uid, recon_elo in running.items():
        live = (users.get(uid) or {}).get('elo')
        if live is not None and live != recon_elo:
            mismatches.append((uid, recon_elo, live))
    if not mismatches:
        print('  All reconstructed Elos match live profiles.')
    else:
        print(f'  {len(mismatches)} user(s) drifted from live values:')
        for uid, recon, live in mismatches[:10]:
            print(f'    {uid}: replay={recon}, live={live}')
        print('  Per-game deltas are preserved; drift just means original')
        print('  processing order differed from timestamp order.')

    if not args.apply:
        print('\nDry run. Re-run with --apply to write.')
        return
    if not updates:
        print('\nNothing to write.')
        return

    print(f'\nApplying {len(updates)} field updates ...')
    # Batch to keep individual PATCH bodies small
    keys = list(updates.keys())
    batch_size = 400
    for i in range(0, len(keys), batch_size):
        chunk = {k: updates[k] for k in keys[i:i + batch_size]}
        r = requests.patch(base + '/.json',
                           params={'access_token': token},
                           json=chunk)
        if r.status_code != 200:
            print(f'  Batch {i // batch_size} failed: HTTP {r.status_code}')
            print(r.text[:500])
            sys.exit(1)
        print(f'  Batch {i // batch_size + 1}: wrote {len(chunk)} fields')
    print('Done.')


if __name__ == '__main__':
    main()
