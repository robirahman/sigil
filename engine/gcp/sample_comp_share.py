"""Competitive share of a selfplay_v2 dataset, from a random sample of chunks.

    sample_comp_share.py <gs prefix or list file> [--n 60] [--seed 0]

Downloads `n` random chunks (`*.npz` under the prefix, or the gs:// paths
listed one per line in a local file) to a temp dir and reports the share of
positions, and of games, whose SFN carries the competitive variant tag
(`competitive` / `competitive_deathmatch`), plus the start-kind split.
"""
import argparse, glob, os, random, subprocess, tempfile
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('--n', type=int, default=60); ap.add_argument('--seed', type=int, default=0)
    a = ap.parse_args()
    if a.src.startswith('gs://'):
        paths = subprocess.run(['gcloud', 'storage', 'ls', a.src.rstrip('/') + '/*.npz'],
                               capture_output=True, text=True).stdout.split()
    else:
        paths = [l.strip() for l in open(a.src) if l.strip()]
    random.Random(a.seed).shuffle(paths)
    pick = paths[:a.n]
    P = C = 0
    games = {}
    kinds = np.zeros(3, np.int64)
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(['gcloud', 'storage', 'cp', '-q', *pick, d + '/'], check=True, capture_output=True)
        for f in glob.glob(os.path.join(d, '*.npz')):
            z = np.load(f)
            for s, g, k in zip(z['sfn'], z['game'], z['kind']):
                c = ' competitive' in str(s)
                P += 1; C += c
                games[(os.path.basename(f), int(g))] = (c, int(k))
    for c, k in games.values():
        kinds[k] += 1
    print(f'chunks {len(pick)} of {len(paths)}; positions {P}, competitive {C / max(P, 1):.4f}; '
          f'games {len(games)}, competitive {sum(c for c, _ in games.values()) / max(len(games), 1):.4f}; '
          f'start kinds fresh-std/fresh-comp/human {kinds.tolist()}')


if __name__ == '__main__':
    main()
