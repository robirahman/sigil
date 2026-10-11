"""Purge expired waiting rooms (>72 hours old) from Realtime Database.

When an online game is created but nobody joins, it sits in status 'waiting'.
After 72 hours (ROOM_INVITE_EXPIRY_MS), these invite rooms are expired and
cleaned up from rooms/ and user_active_games/<uid>/.

Usage:
    # Dry run: inspect and list expired rooms without deleting anything
    python3 ai/purge_stale_rooms.py --service-account firebase-service-account.json

    # Actually apply deletions
    python3 ai/purge_stale_rooms.py --service-account firebase-service-account.json --apply
"""
import argparse
import datetime
import json
import subprocess
import time
import urllib.request
import urllib.parse

DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'
ROOM_INVITE_EXPIRY_MS = 72 * 60 * 60 * 1000  # 72 hours


def get_access_token(service_account_path):
    try:
        import google.auth.transport.requests
        from google.oauth2 import service_account
        creds = service_account.Credentials.from_service_account_file(
            service_account_path,
            scopes=['https://www.googleapis.com/auth/firebase.database',
                    'https://www.googleapis.com/auth/userinfo.email'],
        )
        creds.refresh(google.auth.transport.requests.Request())
        return creds.token
    except ImportError:
        # Fallback to gcloud if google-auth package is not installed in environment
        cmd = ['gcloud', 'auth', 'print-access-token']
        return subprocess.check_output(cmd).decode().strip()


def api_request(db_url, path, token, method='GET', data=None):
    url = f"{db_url.rstrip('/')}/{path.lstrip('/')}.json?access_token={token}"
    body = json.dumps(data).encode('utf-8') if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    if body:
        req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req) as resp:
        res = resp.read().decode('utf-8')
        return json.loads(res) if res else None


def fmt_time(ts_ms):
    if not ts_ms:
        return 'unknown'
    try:
        return datetime.datetime.fromtimestamp(ts_ms / 1000).strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        return str(ts_ms)


def main():
    parser = argparse.ArgumentParser(description='Purge expired invite rooms (>72h old)')
    parser.add_argument('--service-account', default='firebase-service-account.json')
    parser.add_argument('--db-url', default=DB_URL)
    parser.add_argument('--expiry-hours', type=float, default=72.0)
    parser.add_argument('--apply', action='store_true', help='Execute deletions')
    args = parser.parse_args()

    token = get_access_token(args.service_account)
    now_ms = int(time.time() * 1000)
    expiry_ms = int(args.expiry_hours * 3600 * 1000)

    print(f"Checking for invite rooms expired after {args.expiry_hours} hours...")
    print(f"Current time: {fmt_time(now_ms)}")

    uag = api_request(args.db_url, 'user_active_games', token) or {}

    updates = {}
    stale_rooms = []

    for uid, games in uag.items():
        if not isinstance(games, dict):
            continue
        for code, gentry in games.items():
            if not isinstance(gentry, dict):
                continue
            room = api_request(args.db_url, f'rooms/{code}', token)
            if not room:
                print(f"Missing room {code} in user_active_games for {uid} -> marking for cleanup")
                updates[f'user_active_games/{uid}/{code}'] = None
                continue

            status = room.get('status')
            created = room.get('created') or gentry.get('created') or 0
            age_ms = now_ms - created if created else 0
            age_hours = age_ms / 3600000.0

            if status == 'finished':
                print(f"Finished room {code} still indexed for {uid} -> marking index for cleanup")
                updates[f'user_active_games/{uid}/{code}'] = None
            elif status == 'waiting':
                if age_ms > expiry_ms:
                    red = room.get('red') or {}
                    creator = red.get('displayName') or uid
                    print(f"Expired waiting room: {code} (creator: {creator}, age: {age_hours:.1f}h, created: {fmt_time(created)})")
                    stale_rooms.append(code)
                    updates[f'rooms/{code}'] = None
                    updates[f'user_active_games/{uid}/{code}'] = None
                else:
                    print(f"Active waiting room: {code} (age: {age_hours:.1f}h, expires in: {args.expiry_hours - age_hours:.1f}h)")
            elif status == 'playing':
                # In-progress game — do not expire
                pass

    print(f"\nFound {len(stale_rooms)} expired waiting room(s).")
    print(f"Total multi-path database updates: {len(updates)}")

    if not updates:
        print("Nothing to clean up.")
        return

    if args.apply:
        print("\nApplying updates...")
        api_request(args.db_url, '', token, method='PATCH', data=updates)
        print("Cleanup completed successfully!")
    else:
        print("\nDry-run complete. Re-run with --apply to perform deletions.")


if __name__ == '__main__':
    main()
