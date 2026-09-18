#!/usr/bin/env python3
"""Remove completed_games records whose final Fireblast never paid its sacrifice.

    python tools/fix_fireblast_records.py --service-account sa.json            # dry run (default)
    python tools/fix_fireblast_records.py --service-account sa.json --apply    # delete

The list is ai/data/fireblast_no_sacrifice_records.json (see its "what"). Each record
was re-counted from its own SFNs: with one caster stone paid, the score lead is 2, so
the recorded win is wrong and cannot be repaired by inserting the sacrifice -- the game
should simply have gone on. Deleting removes `completed_games/<id>` and any
`user_games/<uid>/<id>` index entries for both players. Elo that these games already
moved is NOT reverted here; see ai/backfill_game_elos.py for recomputation.
"""
import argparse, json, os, sys
import requests
import google.auth.transport.requests
from google.oauth2 import service_account

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = 'https://sigil-js-default-rtdb.firebaseio.com'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--service-account', required=True)
    ap.add_argument('--list', default=os.path.join(REPO, 'ai', 'data', 'fireblast_no_sacrifice_records.json'))
    ap.add_argument('--apply', action='store_true', help='actually delete (default: dry run)')
    a = ap.parse_args()
    creds = service_account.Credentials.from_service_account_file(
        a.service_account, scopes=['https://www.googleapis.com/auth/firebase.database',
                                   'https://www.googleapis.com/auth/userinfo.email'])
    creds.refresh(google.auth.transport.requests.Request())
    tok = {'access_token': creds.token}
    recs = json.load(open(a.list))['records']
    print(f"{len(recs)} records; {'DELETING' if a.apply else 'dry run'}")
    for r in recs:
        gid = r['game']
        cur = requests.get(f'{DB}/completed_games/{gid}.json', params=dict(tok, shallow='true'), timeout=60).json()
        if cur is None:
            print(f'  {gid}: already absent'); continue
        # Re-verify the fingerprint before touching anything: same final turn, same winner.
        g = requests.get(f'{DB}/completed_games/{gid}.json', params=tok, timeout=60).json()
        final = (g.get('finalSfn') or '')
        stones = final.split()[0].split('/')[0] if final else None
        if g.get('winner') != r['recorded_winner'] or (
                stones is not None and stones.count('r' if r['caster'] == 'red' else 'b') != r['stones_after_as_recorded']['caster']):
            print(f'  {gid}: record changed since the list was made; skipping'); continue
        refs = []
        for uid in (r.get('redUid'), r.get('blueUid')):
            if not uid: continue
            if requests.get(f'{DB}/user_games/{uid}/{gid}.json', params=dict(tok, shallow='true'), timeout=60).json() is not None:
                refs.append(f'user_games/{uid}/{gid}')
        print(f"  {gid} {r['date']} {r['red']} vs {r['blue']} winner={r['recorded_winner']} t{r['turn']} "
              f"caster {r['stones_after_as_recorded']['caster']} v {r['stones_after_as_recorded']['opponent']} stones, lead after paying {r['lead_after_paying_sacrifice']}"
              + (f"; also {', '.join(refs)}" if refs else ''))
        if a.apply:
            requests.delete(f'{DB}/completed_games/{gid}.json', params=tok, timeout=60).raise_for_status()
            for p in refs:
                requests.delete(f'{DB}/{p}.json', params=tok, timeout=60).raise_for_status()
            print('    deleted')
    if not a.apply:
        print('dry run only; pass --apply to delete')


if __name__ == '__main__':
    main()
