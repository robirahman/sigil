"""Deploy (or fetch) the Realtime Database security rules via the REST API.

Usage:
    # Dry run: print the live rules and the local diff, write nothing.
    python -m ai.deploy_db_rules --service-account firebase-service-account.json

    # Actually overwrite the live rules with database.rules.json.
    python -m ai.deploy_db_rules --service-account firebase-service-account.json --apply

The Firebase CLI is not required: RTDB rules live at the special
`.settings/rules.json` path and are read with GET / written with PUT,
authenticated with the same service-account token the elo scripts use.
"""
import argparse
import json
import sys

import requests

DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'
RULES_FILE = 'database.rules.json'


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
    parser = argparse.ArgumentParser(description='Deploy RTDB security rules')
    parser.add_argument('--service-account', required=True)
    parser.add_argument('--db-url', default=DB_URL)
    parser.add_argument('--rules-file', default=RULES_FILE)
    parser.add_argument('--apply', action='store_true',
                        help='Actually PUT the rules (default: dry run)')
    args = parser.parse_args()

    with open(args.rules_file) as f:
        local_text = f.read()
    local = json.loads(local_text)  # validate before touching the network

    token = auth_token(args.service_account)
    url = args.db_url.rstrip('/') + '/.settings/rules.json'

    live_resp = requests.get(url, params={'access_token': token})
    live_resp.raise_for_status()
    live = live_resp.json()

    live_norm = json.dumps(live, indent=2, sort_keys=True)
    local_norm = json.dumps(local, indent=2, sort_keys=True)

    if live_norm == local_norm:
        print('Live rules already match', args.rules_file, '— nothing to do.')
        return

    import difflib
    diff = difflib.unified_diff(
        live_norm.splitlines(), local_norm.splitlines(),
        fromfile='LIVE (sigil-js)', tofile=args.rules_file, lineterm='')
    print('\n'.join(diff))

    if not args.apply:
        print('\n[dry run] Re-run with --apply to push the local rules above.')
        return

    put = requests.put(url, params={'access_token': token}, data=local_text)
    put.raise_for_status()
    print('\nRules deployed to', args.db_url)


if __name__ == '__main__':
    sys.exit(main())
