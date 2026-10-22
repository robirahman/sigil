#!/usr/bin/env python3
"""AI self-play games from the training shards, as a puzzle-generator corpus.

    selfplay_corpus.py --prefix data/s3/v27_2026-10-07/d4/ --shards 6000 --seed 1 \\
        --out /tmp/selfplay_hydrated.json

The self-play shards in gs://focus-surfer-494820-g0-sigil (`v2d4_<base>_<n>.npz`,
written by the round-3/4 self-play runners) hold, per position, the SFN, the
game id, the ply, the side to move (`is_red`) and `y` = 1 when the side to move
went on to win. Consecutive plies of one game are consecutive turns, so the
games rebuild into the hydrated format gen_mate_puzzles.py reads
({gid: {redUid, blueUid, winner, timestamp, variant, turns: [{color,
turnNumber, sfnBefore, sfnAfter}]}}). A turn whose next position is missing
(a gap, or the game's last move) has no sfnAfter. Players are labelled
`__ai_selfplay_<tag>__`, which the puzzle page shows as "AI (selfplay <tag>)".

Shards are drawn at random (--seed) from the prefix and downloaded with the
application-default credentials (or the VM's metadata token).
"""
import argparse, io, json, os, random, sys, time, urllib.parse
from collections import defaultdict

import numpy as np
import requests

BUCKET = 'focus-surfer-494820-g0-sigil'


def token():
    try:
        r = requests.get('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
                         headers={'Metadata-Flavor': 'Google'}, timeout=3)
        return r.json()['access_token']
    except Exception:  # noqa: BLE001
        import google.auth, google.auth.transport.requests
        c, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
        c.refresh(google.auth.transport.requests.Request())
        return c.token


def list_objects(prefix, tok):
    out, page = [], None
    while True:
        p = {'prefix': prefix, 'fields': 'items(name),nextPageToken'}
        if page:
            p['pageToken'] = page
        j = requests.get(f'https://storage.googleapis.com/storage/v1/b/{BUCKET}/o', params=p,
                         headers={'Authorization': 'Bearer ' + tok}, timeout=60).json()
        out += [i['name'] for i in j.get('items', []) if i['name'].endswith('.npz')]
        page = j.get('nextPageToken')
        if not page:
            return out


def games_of(z, tag):
    out = {}
    by = defaultdict(list)
    for i, g in enumerate(z['game'].tolist()):
        by[g].append(i)
    for g, idx in by.items():
        idx.sort(key=lambda i: int(z['ply'][i]))
        turns, winner = [], None
        for k, i in enumerate(idx):
            sfn = str(z['sfn'][i])
            color = 'red' if int(z['is_red'][i]) else 'blue'
            won = bool(int(z['y'][i]))
            winner = color if won else ('blue' if color == 'red' else 'red')
            nxt = idx[k + 1] if k + 1 < len(idx) else None
            after = str(z['sfn'][nxt]) if nxt is not None and int(z['ply'][nxt]) == int(z['ply'][i]) + 1 else None
            turns.append({'color': color, 'turnNumber': int(sfn.split()[2]), 'sfnBefore': sfn, 'sfnAfter': after,
                          'fat': False})
        variant = 'competitive' if 'competitive' in turns[0]['sfnBefore'] else 'standard'
        out[f'selfplay-{tag}-{g}'] = {'redUid': f'__ai_selfplay_{tag}__', 'blueUid': f'__ai_selfplay_{tag}__',
                                      'winner': winner, 'timestamp': None, 'variant': variant, 'turns': turns}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--prefix', required=True)
    ap.add_argument('--shards', type=int, default=1000)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--tag', default='v27')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    tok = token()
    names = list_objects(args.prefix, tok)
    random.Random(args.seed).shuffle(names)
    names = names[:args.shards]
    hyd, t0 = {}, time.time()
    for n, name in enumerate(names):
        if n % 200 == 0 and n:
            tok = token() if n % 2000 == 0 else tok
            print(f'  {n}/{len(names)} shards, {len(hyd)} games, {time.time() - t0:.0f}s', flush=True)
        r = requests.get(f'https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/'
                         + urllib.parse.quote(name, safe='') + '?alt=media',
                         headers={'Authorization': 'Bearer ' + tok}, timeout=120)
        if r.status_code != 200:
            print('  skip', name, r.status_code, flush=True)
            continue
        z = np.load(io.BytesIO(r.content), allow_pickle=False)
        hyd.update(games_of(z, args.tag))
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(hyd, fh)
    print(f'{len(hyd)} games, {sum(len(g["turns"]) for g in hyd.values())} positions -> {args.out}')


if __name__ == '__main__':
    main()
