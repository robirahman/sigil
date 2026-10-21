"""Sample start positions for the position win-probability calibration.

    position_starts.py <human_lines.json> <selfplay_npz_glob> <n> <out.json> [human_frac=0.7] [seed=1]

The calibration (position_selfplay.py, fit_position_winprob.py) asks: from THIS
position, how often does red win when the Very Hard AI plays both sides? The
positions should look like the ones players will start rated games from -- any
ply of a reviewed game ("Rematch from here") or an imported position -- so
`human_frac` of them are a uniformly random ply of a recorded human game (an
eval_games.py `hydrate` file, e.g. data/interp/human_lines_<date>.json), with
the game's earlier positions as repetition history, and the rest are a random
ply of an engine self-play game (selfplay_v2 chunks), which brings the even,
well-played middlegames that human games are short of.

Only the variants a rated game from a position can have (standard and
competitive) and only spells the engine plays are kept; a game played under
the old Tectonic / Providence / Rock Slide rules (data_filters) and finished
positions are skipped.

Output: a JSON list of {sfn, hist, src, ply}; `hist` holds the SFNs before
`sfn` (human starts only).
"""
import glob, json, os, random, sys
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se
sys.path.insert(0, os.path.join(_HERE, '..', '..', 'ai'))
from data_filters import is_old_rules_game

RATED_VARIANTS = ('standard', 'competitive')


def playable(sfn):
    try:
        b = se.Board.from_sfn(sfn)
    except Exception:
        return False
    return not b.gameover


def main():
    a = sys.argv[1:]
    lines, npz_glob, n, out = a[0], a[1], int(a[2]), a[3]
    human_frac = float(a[4]) if len(a) > 4 else 0.7
    rng = random.Random(int(a[5]) if len(a) > 5 else 1)

    games = list(json.load(open(lines)).values())
    human = []
    for g in games:
        pos = g.get('positions') or []
        if len(pos) < 2 or g.get('variant', 'standard') not in RATED_VARIANTS:
            continue
        names = pos[0].split(' ', 1)[0].split('/', 1)[1].split(',')
        if is_old_rules_game(names, g.get('timestamp')) or not playable(pos[0]):
            continue
        human.append(pos)
    sp = []
    for f in sorted(glob.glob(npz_glob)):
        z = np.load(f, allow_pickle=True)
        sp += [str(s) for s in z['sfn']]
    print(f"human games {len(human)} of {len(games)}; self-play positions {len(sp)}", flush=True)

    starts, seen = [], set()
    n_h = round(n * human_frac)
    while len(starts) < n_h:
        pos = rng.choice(human)
        i = rng.randrange(len(pos) - 1)       # the last recorded position may be terminal
        if pos[i] in seen or not playable(pos[i]):
            continue
        seen.add(pos[i])
        starts.append(dict(sfn=pos[i], hist=pos[:i], src='human', ply=i))
    while len(starts) < n:
        s = rng.choice(sp)
        if s in seen or not playable(s):
            continue
        seen.add(s)
        starts.append(dict(sfn=s, hist=[], src='selfplay', ply=int(s.split()[2])))
    rng.shuffle(starts)
    json.dump(starts, open(out, 'w'))
    print(f"wrote {len(starts)} starts to {out}", flush=True)


if __name__ == '__main__':
    main()
