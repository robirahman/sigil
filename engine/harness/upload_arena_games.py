#!/usr/bin/env python3
"""Arena game records -> Firebase `ai_arena_games/<key>`, kept as training data.

    gcloud storage cat "gs://<bucket>/runs/<run>/live/arm*.log" | \\
        python engine/harness/upload_arena_games.py --arena tier-roundrobin-2026-10-10 \\
            --prefix rr20261010 --run <run> [--run <run2>] --engine-version 28 \\
            --commit <sha> --service-account "<sa.json>" [--apply]

Reads the `RECORD {json}` lines a harness prints at the end of each game
(tier_roundrobin.py) from the given log files, or stdin. Each record is stored
under `<prefix>_<seed>_<red>_<blue>` with the arena metadata added; `positions`
is every SFN from the setup to the final position. Smoke games (seed below
--min-seed) are dropped. Dry run unless --apply. The node is not
`completed_games`: AI-vs-AI games there would mix into the human-game stats and
audits that read it. database.rules.json closes the node to clients; the
service account bypasses the rules.
"""
import argparse, json, sys

DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'
NODE = 'ai_arena_games'


def db_token(service_account):
    import google.auth.transport.requests
    from google.oauth2 import service_account as sa
    creds = sa.Credentials.from_service_account_file(
        service_account,
        scopes=['https://www.googleapis.com/auth/firebase.database',
                'https://www.googleapis.com/auth/userinfo.email'])
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def read_records(fhs, min_seed):
    recs = {}
    for fh in fhs:
        for ln in fh:
            if not ln.startswith('RECORD '):
                continue
            r = json.loads(ln[len('RECORD '):])
            if r['seed'] >= min_seed:
                recs[(r['seed'], r['red'], r['blue'])] = r
    return recs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('logs', nargs='*', help='log files (default: stdin)')
    ap.add_argument('--arena', required=True)
    ap.add_argument('--prefix', required=True, help='key prefix, e.g. rr20261010')
    ap.add_argument('--run', action='append', default=[], help='GCS run id(s) the logs came from')
    ap.add_argument('--engine-version', type=int, required=True)
    ap.add_argument('--commit', required=True)
    ap.add_argument('--min-seed', type=int, default=1)
    ap.add_argument('--service-account')
    ap.add_argument('--apply', action='store_true')
    a = ap.parse_args()
    fhs = [open(p, encoding='utf-8') for p in a.logs] or [sys.stdin]
    recs = read_records(fhs, a.min_seed)
    out = {}
    for (seed, red, blue), r in sorted(recs.items()):
        r.update(source='tier_roundrobin', arena=a.arena, runIds=a.run,
                 engineVersion=a.engine_version, commit=a.commit, isAiArena=True,
                 redUid=f'__ai_rust_{red}__', blueUid=f'__ai_rust_{blue}__',
                 timestamp=r['endTime'], setupSfn=r['positions'][0], finalSfn=r['positions'][-1])
        out[f'{a.prefix}_{seed}_{red}_{blue}'] = r
    unfinished = sum(not r['finished'] for r in out.values())
    print(f'{len(out)} games ({unfinished} unfinished), '
          f'{sum(len(json.dumps(r)) for r in out.values()) / 1e3:.0f} kB')
    if not a.apply:
        print('dry run; pass --apply to write')
        return
    import requests
    tok = db_token(a.service_account)
    for k, r in out.items():
        requests.put(f'{DB_URL}/{NODE}/{k}.json', params={'access_token': tok},
                     json=r, timeout=60).raise_for_status()
    keys = requests.get(f'{DB_URL}/{NODE}.json', params={'access_token': tok, 'shallow': 'true'},
                        timeout=60).json() or {}
    print(f'wrote {len(out)}; {sum(k.startswith(a.prefix + "_") for k in keys)} under {NODE}/{a.prefix}_*')


if __name__ == '__main__':
    main()
