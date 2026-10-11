"""Delete every stored game that used any of the given spells.

Used when a spell's rules change so much that games recorded under the old
rules can no longer be replayed by the current engine. Per Robi, such games
are deleted rather than kept behind a legacy rules path. 2026-10 uses:
  * Providence (Dividend, Annuity, Endowment): per-turn extra-move
    schedules replaced by a per-player stone bank.
  * Fissure and Bulwark: Fissure's blast now also destroys the caster's own
    stones; Bulwark now also shields against conversion and destruction.

Matches any record whose spell list contains one of --spells (including
duplicate-variant aliases like "Annuity~2"):

  completed_games/<key>                 the game record
  user_games/<redUid|blueUid>/<key>     per-player history index entries
  game_reviews/<key>                    stored AI reviews
  game_evals/<roomCode>                 stored Rust-engine evaluations
  rooms/<code>                          room documents (finished or live)
  user_active_games/<uid>/<code>        active-game index entries

Dry run by default: prints what would be deleted. --apply sends a single
multi-path PATCH with null values. Elo already awarded by the deleted
rated games is NOT recomputed.

Usage:
    python3 -m ai.purge_spell_games --service-account firebase-service-account.json \
        --spells Fissure,Bulwark
    python3 -m ai.purge_spell_games --service-account ... --spells Fissure,Bulwark --apply
"""
import argparse
import datetime
import sys

import requests

from ai.backfill_game_elos import auth_token, DB_URL

PROVIDENCE = {'Dividend', 'Annuity', 'Endowment'}


def _uses_any(spell_names, targets):
    return any(str(s).split('~')[0] in targets for s in (spell_names or []))


def _get(db, path, tok, shallow=False):
    params = {'access_token': tok}
    if shallow:
        params['shallow'] = 'true'
    r = requests.get(f'{db}/{path}.json', params=params, timeout=300)
    r.raise_for_status()
    return r.json() or {}


def _fmt_ts(ts):
    try:
        return datetime.datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d')
    except (TypeError, ValueError, OSError):
        return '?'


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--service-account', required=True)
    ap.add_argument('--db-url', default=DB_URL)
    ap.add_argument('--spells', default=','.join(sorted(PROVIDENCE)),
                    help='comma-separated spell names to purge (default: the '
                         'Providence pack)')
    ap.add_argument('--apply', action='store_true',
                    help='actually delete (default: dry run)')
    args = ap.parse_args()
    targets = {s.strip() for s in args.spells.split(',') if s.strip()}
    print('Purging games that use any of: ' + ', '.join(sorted(targets)))
    tok = auth_token(args.service_account)
    db = args.db_url.rstrip('/')

    updates = {}

    games = _get(db, 'completed_games', tok)
    evals = _get(db, 'game_evals', tok, shallow=True)
    reviews = _get(db, 'game_reviews', tok, shallow=True)
    hits = [(k, g) for k, g in games.items()
            if isinstance(g, dict) and _uses_any(g.get('spellNames'), targets)]
    print(f'completed_games: {len(hits)} of {len(games)} match')
    for key, g in sorted(hits, key=lambda kv: kv[1].get('timestamp') or 0):
        rated = 'rated' if g.get('ranked') else 'unrated'
        print(f"  {key}  {_fmt_ts(g.get('timestamp'))}  "
              f"{g.get('redUid', '?')} vs {g.get('blueUid', '?')}  "
              f"winner={g.get('winner')}  {rated}  "
              f"turns={len(g.get('turns') or [])}")
        updates[f'completed_games/{key}'] = None
        for uid in (g.get('redUid'), g.get('blueUid')):
            if uid:
                updates[f'user_games/{uid}/{key}'] = None
        if key in reviews:
            updates[f'game_reviews/{key}'] = None
        room = g.get('roomCode')
        if room and room in evals:
            updates[f'game_evals/{room}'] = None

    rooms = _get(db, 'rooms', tok)
    room_hits = {code: r for code, r in rooms.items()
                 if isinstance(r, dict) and _uses_any(r.get('spellNames'), targets)}
    print(f'rooms: {len(room_hits)} of {len(rooms)} match')
    for code, r in sorted(room_hits.items()):
        status = r.get('status') or ('finished' if r.get('winner') else 'live?')
        print(f'  {code}  status={status}')
        updates[f'rooms/{code}'] = None
        if code in evals:
            updates[f'game_evals/{code}'] = None

    active = _get(db, 'user_active_games', tok)
    for uid, entries in (active or {}).items():
        for code in (entries or {}):
            if code in room_hits:
                updates[f'user_active_games/{uid}/{code}'] = None

    print(f'\n{len(updates)} paths to delete:')
    for p in sorted(updates):
        print('  ' + p)
    if not args.apply:
        print('\nDry run: nothing deleted. Re-run with --apply to delete.')
        return 0
    if not updates:
        print('Nothing to delete.')
        return 0
    r = requests.patch(f'{db}/.json', params={'access_token': tok},
                       json=updates, timeout=300)
    r.raise_for_status()
    print(f'Deleted {len(updates)} paths.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
