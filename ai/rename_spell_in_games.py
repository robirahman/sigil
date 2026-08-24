"""Rename a spell inside stored Firebase game records.

Used when a spell is renamed without any mechanics change (first use: the
2026-08-24 swap — spell Flood -> Tsunami, pack Tsunami -> Flood), so old
records stay fully valid and are migrated in place rather than wiped.
Rewrites every field that embeds spell names, field-aware (never a blind
substring replace):

  completed_games/<key>: spellNames[], setupSfn, finalSfn,
      turns[].sfnBefore/.sfnAfter (fat), turns[].actions (slim: raw
      input tokens and sim {spell: ...} action objects)
  rooms/<code>: spellNames[], currentSfn, setupSfn, finalSfn,
      gameLog[] (same entry shape), turns/*/actions (live token stream)

Changed records are backed up to a local gitignored JSON file before any
write. The client-side legacy alias (LEGACY_SPELL_RENAMES in
engine/constants.js + notation.py) keeps un-migrated data replayable, so
running this is about keeping the stored corpus clean, not about
correctness — safe to re-run any time (idempotent).

Usage:
    # Dry run (default): report what would change, write nothing.
    python -m ai.rename_spell_in_games --service-account firebase-service-account.json

    # Actually rewrite.
    python -m ai.rename_spell_in_games --service-account firebase-service-account.json --confirm

    # Other renames:
    python -m ai.rename_spell_in_games --service-account ... --old Flood --new Tsunami

Auth uses the same service-account REST pattern as ai/wipe_pack_games.py.
"""
import argparse
import copy
import json
import sys
import time

import requests

DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'


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


def rename_in_sfn(sfn, old, new):
    """Replace exact spell names in the SFN's spell segment AND its
    lock/springlock fields (parts 4-5, which hold spell names too)."""
    if not isinstance(sfn, str) or '/' not in sfn:
        return sfn
    parts = sfn.split(' ')
    slash = parts[0].index('/')
    spells = [new if n == old else n
              for n in parts[0][slash + 1:].split(',')]
    parts[0] = parts[0][:slash + 1] + ','.join(spells)
    for i in (4, 5):
        if i < len(parts) and ':' in parts[i]:
            parts[i] = ':'.join(new if v == old else v
                                for v in parts[i].split(':'))
    return ' '.join(parts)


def rename_action(action, old, new):
    """Slim-turn action: raw input token (string) or sim action object."""
    if action == old:
        return new
    if isinstance(action, dict) and action.get('spell') == old:
        action = dict(action)
        action['spell'] = new
        return action
    return action


def rename_turn_entry(turn, old, new):
    """One gameLog/turns entry (fat, slim, snapshot, or live-stream)."""
    if not isinstance(turn, dict):
        return turn
    turn = dict(turn)
    for f in ('sfnBefore', 'sfnAfter'):
        if turn.get(f):
            turn[f] = rename_in_sfn(turn[f], old, new)
    acts = turn.get('actions')
    if isinstance(acts, list):
        turn['actions'] = [rename_action(a, old, new) for a in acts]
    toks = turn.get('tokens')
    if isinstance(toks, list):
        turn['tokens'] = [rename_action(a, old, new) for a in toks]
    return turn


def rename_record(rec, old, new):
    """Return a rewritten copy of a completed_games or rooms record."""
    rec = copy.deepcopy(rec)
    names = rec.get('spellNames')
    if isinstance(names, list):
        rec['spellNames'] = [new if n == old else n for n in names]
    for f in ('setupSfn', 'finalSfn', 'currentSfn'):
        if rec.get(f):
            rec[f] = rename_in_sfn(rec[f], old, new)
    for f in ('turns', 'gameLog'):
        entries = rec.get(f)
        if isinstance(entries, list):
            rec[f] = [rename_turn_entry(t, old, new) for t in entries]
        elif isinstance(entries, dict):  # rooms/*/turns is a push-key dict
            rec[f] = {k: rename_turn_entry(t, old, new)
                      for k, t in entries.items()}
    return rec


def fetch(db_url, token, path):
    resp = requests.get(db_url.rstrip('/') + f'/{path}.json',
                        params={'access_token': token})
    resp.raise_for_status()
    return resp.json() or {}


def main():
    parser = argparse.ArgumentParser(
        description='Rename a spell inside stored game records')
    parser.add_argument('--service-account', required=True)
    parser.add_argument('--db-url', default=DB_URL)
    parser.add_argument('--old', default='Flood')
    parser.add_argument('--new', default='Tsunami')
    parser.add_argument('--confirm', action='store_true',
                        help='Actually rewrite (default: dry run)')
    args = parser.parse_args()

    token = auth_token(args.service_account)
    patch = {}
    backup = {}
    counts = {}
    for top in ('completed_games', 'rooms'):
        records = fetch(args.db_url, token, top)
        changed = 0
        for key, rec in records.items():
            if not isinstance(rec, dict):
                continue
            new_rec = rename_record(rec, args.old, args.new)
            if new_rec != rec:
                patch[f'{top}/{key}'] = new_rec
                backup[f'{top}/{key}'] = rec
                changed += 1
        counts[top] = (changed, len(records))

    for top, (changed, total) in counts.items():
        print(f'{top}: {changed} of {total} record(s) contain "{args.old}"')

    if not patch:
        print('Nothing to rewrite.')
        return 0

    if not args.confirm:
        for path in sorted(patch):
            print('  would rewrite', path)
        print(f'\n[dry run] Re-run with --confirm to rewrite '
              f'{len(patch)} record(s).')
        return 0

    backup_path = ('ai/data/completed_games_backup_rename_%s_to_%s_%s.json'
                   % (args.old, args.new, time.strftime('%Y-%m-%d')))
    with open(backup_path, 'w') as f:
        json.dump(backup, f)
    print(f'Backed up {len(backup)} record(s) to {backup_path} '
          '(gitignored, local only).')

    resp = requests.patch(args.db_url.rstrip('/') + '/.json',
                          params={'access_token': token}, json=patch)
    resp.raise_for_status()
    print(f'Rewrote {len(patch)} record(s): "{args.old}" -> "{args.new}".')
    return 0


if __name__ == '__main__':
    sys.exit(main())
