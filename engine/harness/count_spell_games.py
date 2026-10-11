"""Games and positions per spell in a selfplay_v2 data set.

    count_spell_games.py <out.json> <chunk dir or .npz>... [--workers N]

Reads only the `spells`, `game`, `kind` and `y` members of each chunk (the
spell draw is fixed for a game, so a game is counted once per spell in its
draw). Writes {"games": {spell: n}, "positions": {spell: n}, "per_game":
[[game, kind, n_positions, [9 spell ids]], ...], "totals": {...}} so a later
filter (e.g. dropping every game with Rock Slide, id 40) needs no re-read.
"""
import glob, json, os, sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
import numpy as np

NAMES = ['Flourish', 'Carnage', 'Bewitch', 'Starfall', 'Seal_of_Lightning', 'Grow',
         'Fireblast', 'Hail_Storm', 'Meteor', 'Seal_of_Wind', 'Sprout', 'Slash', 'Surge',
         'Comet', 'Seal_of_Summer', 'Blossom', 'Scatter', 'Seal_of_Spring', 'Syzygy',
         'Eclipse', 'Azimuth', 'Erupt', 'Fury', 'Charge', 'Hurricane', 'Storm_Front', 'Gust',
         'Tsunami', 'Torrent', 'Splash', 'Harvest', 'Gather', 'Seal_of_Autumn', 'Corrupt',
         'Decay', 'Lurk', 'Seal_of_Destruction', 'Seal_of_Stone', 'Seal_of_Winter',
         'Fissure', 'Rock_Slide', 'Bulwark', 'Dividend', 'Annuity', 'Endowment']


def read_chunk(path):
    z = np.load(path)
    sp, gm, kd = z['spells'], z['game'], z['kind']
    out = {}
    for i in range(len(gm)):
        g = int(gm[i])
        if g in out:
            out[g][2] += 1
        else:
            out[g] = [g, int(kd[i]), 1, sorted(int(x) for x in sp[i])]
    return list(out.values())


def summarize(per_game):
    games, pos = Counter(), Counter()
    for _g, _k, n, spells in per_game:
        for s in spells:
            games[s] += 1
            pos[s] += n
    return ({NAMES[s] if s < len(NAMES) else str(s): games[s] for s in sorted(games)},
            {NAMES[s] if s < len(NAMES) else str(s): pos[s] for s in sorted(pos)})


def main():
    args = sys.argv[1:]
    workers = os.cpu_count() or 4
    if '--workers' in args:
        i = args.index('--workers')
        workers = int(args[i + 1])
        del args[i:i + 2]
    out, srcs = args[0], args[1:]
    paths = []
    for s in srcs:
        paths += sorted(glob.glob(os.path.join(s, '**', '*.npz'), recursive=True)) if os.path.isdir(s) else [s]
    print(len(paths), 'chunks', flush=True)
    per_game = {}
    with ProcessPoolExecutor(workers) as ex:
        for k, rows in enumerate(ex.map(read_chunk, paths, chunksize=64), 1):
            for r in rows:
                if r[0] in per_game:   # a game split across chunks never happens; guard anyway
                    per_game[r[0]][2] += r[2]
                else:
                    per_game[r[0]] = r
            if k % 5000 == 0:
                print(k, flush=True)
    rows = list(per_game.values())
    games, pos = summarize(rows)
    totals = {'chunks': len(paths), 'games': len(rows), 'positions': sum(r[2] for r in rows),
              'kinds': dict(Counter(r[1] for r in rows))}
    json.dump({'games': games, 'positions': pos, 'totals': totals, 'per_game': rows}, open(out, 'w'))
    print(json.dumps(totals), flush=True)


if __name__ == '__main__':
    main()
