#!/usr/bin/env python3
"""Download one shard of a prefix from the SigilBench private bucket on a VM
(metadata-server token; the sigilbench-eval service account can read it).

    python3 bench/tools/fetch_private.py <prefix> <dest> [--shard i/n] [--group-depth 1]

Objects are grouped by their directory (`--group-depth` levels below the
prefix's own directory, e.g. a self-play run's worker base); group j of the
sorted groups belongs to shard j % n, so a worker's consecutive files stay
together. Prints "<groups> groups, <mine> mine, <files> files".
"""
import argparse
import json
import os
import urllib.parse
import urllib.request

B = 'focus-surfer-494820-g0-sigilbench-private'


def tok():
    r = urllib.request.Request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
                               headers={'Metadata-Flavor': 'Google'})
    return json.load(urllib.request.urlopen(r, timeout=15))['access_token']


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('prefix')
    ap.add_argument('dest')
    ap.add_argument('--shard', default='0/1')
    ap.add_argument('--suffix', default='.npz')
    a = ap.parse_args()
    i, n = (int(x) for x in a.shard.split('/'))
    names, page, t = [], None, tok()
    while True:
        q = {'prefix': a.prefix, 'fields': 'items(name),nextPageToken'}
        if page:
            q['pageToken'] = page
        r = urllib.request.Request(f'https://storage.googleapis.com/storage/v1/b/{B}/o?' + urllib.parse.urlencode(q),
                                   headers={'Authorization': 'Bearer ' + t})
        j = json.load(urllib.request.urlopen(r, timeout=60))
        names += [x['name'] for x in j.get('items', []) if x['name'].endswith(a.suffix)]
        page = j.get('nextPageToken')
        if not page:
            break
    groups = sorted({os.path.dirname(x) for x in names})
    mine = {g for k, g in enumerate(groups) if k % n == i}
    got = 0
    for x in names:
        if os.path.dirname(x) not in mine:
            continue
        out = os.path.join(a.dest, x[len(a.prefix):].lstrip('/'))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        for attempt in range(3):
            try:
                r = urllib.request.Request(f'https://storage.googleapis.com/storage/v1/b/{B}/o/'
                                           + urllib.parse.quote(x, safe='') + '?alt=media',
                                           headers={'Authorization': 'Bearer ' + t})
                open(out, 'wb').write(urllib.request.urlopen(r, timeout=120).read())
                got += 1
                break
            except Exception:  # noqa: BLE001
                t = tok()
    print(f'{len(groups)} groups, {len(mine)} mine, {got} files')


if __name__ == '__main__':
    main()
