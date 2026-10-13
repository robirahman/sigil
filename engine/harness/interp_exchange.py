"""Interpretability experiment 2: exchange rates by counterfactual probe (2026-10).

    interp_exchange.py <source> <depths> <positions> <n_shards> <shard_base>

The AlphaZero piece-value analogue (engine/reports/2026-10-interpretability-plan.md):
take a real position, change exactly one stone, and record how much the engine's
value of the position changes for the side to move.

`source` is `selfplay` (round-4 games: every official spell drawn equally often,
current Rock Slide rule; the chunk list of plan_2026-10-12.json) or `human` (the
recorded human games, hydrated by eval_games.py; standard and competitive-opening
variants, the ones the engine plays).
`depths` is a colon list of fixed search depths, e.g. `2` or `2:4` (colons, because
the runner splits an arm's arguments on commas); the static
evaluations are always recorded. This shard (k = SIGIL_SHARD_OFF // 1000 -
shard_base) takes every n_shards-th game or chunk starting at k and samples
`positions` positions; a shard outside 0..n_shards-1 is the runner's smoke and
probes one position.

Per position, the probes are, for the side to move ("own") and its opponent:
  rm_own / rm_opp   remove that side's stone from each node it occupies
  add_own / add_opp place one of that side's stones on each empty node
  flip              the same stones with the other side to move (the move's value)
Every probe is a legal board under the real rules: stones only, so mana, charges
and the score lead are re-derived by `update`, exactly as play would derive them.
A probe that would leave a side with no stones is skipped (the game would be over).
The draw, counters, locks and bank are untouched.

Each probe records, from the side to move's point of view, in centistones:
  hand   static tfit_spell_v2 (the hand evaluation)
  full   static nnue_spell4 (hand evaluation + net), the shipped eval
  dN     the shipped search at fixed depth N (no clock)
and the charged masks after the change, so the analysis can separate "a stone"
from "a stone that completes or breaks a sigil".

Output: one `XPOS {json}` line per position. fit_exchange.py pools them.
"""
import io, json, os, random, sys, time, urllib.parse, urllib.request
import numpy as np
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import shard_offset

PLAN = 'gs://focus-surfer-494820-g0-sigil/data/spell_values/plan_2026-10-12.json'
HUMAN = 'gs://focus-surfer-494820-g0-sigil/data/interp/human_lines_2026-10-13.json'
EVAL = se.SHIPPED_EVAL
HAND = 'tfit_spell_v2'
AD = tuple(se.SHIPPED_ADAPTIVE)
N_NODES = 39


def _fetch(path):
    if not path.startswith('gs://'):
        return open(path, 'rb').read()
    bucket, name = path[5:].split('/', 1)
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        headers={'Metadata-Flavor': 'Google'}), timeout=15))['access_token']
    url = (f'https://storage.googleapis.com/storage/v1/b/{bucket}/o/'
           f'{urllib.parse.quote(name, safe="")}?alt=media')
    return urllib.request.urlopen(urllib.request.Request(
        url, headers={'Authorization': f'Bearer {tok}'}), timeout=300).read()


def mover_of(sfn):
    return 'red' if sfn.split()[1] == 'r' else 'blue'


def flip_sfn(sfn):
    parts = sfn.split(' ')
    parts[1] = 'b' if parts[1] == 'r' else 'r'
    return ' '.join(parts)


def values(sfn, depths, mover):
    """Static hand, static full and fixed-depth search values, mover's POV."""
    b = se.Board.from_sfn(sfn)
    out = {'hand': b.evaluate(mover, HAND), 'full': b.evaluate(mover, EVAL)}
    for d in depths:
        bb = se.Board.from_sfn(sfn)
        out[f'd{d}'] = bb.root_scores_and_play(d, EVAL, False, 1, [], False, None, AD)[1]
    return out


def probe(sfn, depths):
    b = se.Board.from_sfn(sfn)
    mover = mover_of(sfn)
    own_i = 0 if mover == 'red' else 1
    red, blue = list(b.red), list(b.blue)
    side = [red, blue]
    res = {'mover': mover, 'red': red, 'blue': blue, 'spells': list(b.spell_ids()),
           'charged': [b.charged('red'), b.charged('blue')], 'mana': list(b.mana),
           'total': list(b.total), 'counter': list(b.spell_counter),
           'base': values(sfn, depths, mover), 'probes': []}
    empty = [n for n in range(N_NODES) if n not in red and n not in blue]
    plan = []
    for who, tag in ((own_i, 'own'), (1 - own_i, 'opp')):
        for n in side[who]:
            plan.append(('rm_' + tag, who, n))
        for n in empty:
            plan.append(('add_' + tag, who, n))
    for kind, who, n in plan:
        st = [list(red), list(blue)]
        if kind.startswith('rm'):
            if len(st[who]) <= 1:
                continue                       # would end the game
            st[who].remove(n)
        else:
            st[who].append(n)
        bb = se.Board.from_sfn(sfn)
        bb.set_stones(st[0], st[1])
        bb.update()
        if bb.gameover:
            continue
        psfn = bb.to_sfn()
        v = values(psfn, depths, mover)
        res['probes'].append([kind, n, v, [bb.charged('red'), bb.charged('blue')]])
    fs = flip_sfn(sfn)
    fb = se.Board.from_sfn(fs)
    if not fb.gameover:
        # The other side to move, still scored from the ORIGINAL mover's POV.
        v = values(fs, depths, 'blue' if mover == 'red' else 'red')
        res['probes'].append(['flip', -1, {k: -x for k, x in v.items()}, res['charged']])
    return res


def selfplay_positions(k, n_shards, want, rng):
    plan = json.loads(_fetch(PLAN))
    chunks = [c for i, c in enumerate(plan['chunks']) if i % n_shards == k]
    rng.shuffle(chunks)
    for path in chunks:
        try:
            z = np.load(io.BytesIO(_fetch(path)))
        except Exception as e:  # noqa: BLE001
            print(f'skip {path}: {e}', flush=True); continue
        rows = [i for i in range(len(z['sfn']))
                if not (int(z['kind'][i]) == 1 and int(z['ply'][i]) <= 2) and int(z['ply'][i]) >= 2]
        for r in rng.sample(rows, min(2, len(rows))):
            yield {'src': 'selfplay', 'chunk': os.path.basename(path), 'row': r,
                   'game': int(z['game'][r]), 'ply': int(z['ply'][r]), 'y': int(z['y'][r]),
                   'sfn': str(z['sfn'][r])}


def human_positions(k, n_shards, want, rng):
    lines = json.loads(_fetch(HUMAN))
    games = [g for i, g in enumerate(sorted(lines)) if i % n_shards == k]
    rng.shuffle(games)
    for code in games:
        g = lines[code]
        if g.get('variant', 'standard') not in ('standard', 'competitive'):
            continue
        pos = g['positions']
        if isinstance(pos, str):
            pos = json.loads(pos.replace("'", '"'))
        idx = list(range(2, len(pos)))
        for i in rng.sample(idx, min(6, len(idx))):
            yield {'src': 'human', 'game': code, 'ply': i, 'winner': g.get('winner'),
                   'red_uid': g.get('redUid'), 'blue_uid': g.get('blueUid'), 'sfn': pos[i]}


def main():
    a = sys.argv[1:]
    source, depths = a[0], [int(x) for x in a[1].replace(',', ':').split(':') if x]
    want, n_shards, base = int(a[2]), int(a[3]), int(a[4])
    se.set_policy(*se.SHIPPED_POLICY)
    se.set_policy_explore(*se.SHIPPED_EXPLORE)
    se.set_opening_book(False)
    k = shard_offset() // 1000 - base
    smoke = not (0 <= k < n_shards)
    if smoke:
        k, want = 0, 1
        print('smoke: one position', flush=True)
    rng = random.Random(1000 * k + (7 if source == 'human' else 3))
    gen = selfplay_positions if source == 'selfplay' else human_positions
    t0 = time.time(); n = 0
    for meta in gen(k, n_shards, want, rng):
        sfn = meta['sfn']
        try:
            if se.Board.from_sfn(sfn).gameover:
                continue
        except ValueError:                     # a retired or out-of-scope spell
            continue
        res = probe(sfn, depths)
        res.update(meta)
        res['depths'] = depths
        res['eval'] = EVAL
        print('XPOS ' + json.dumps(res, separators=(',', ':')), flush=True)
        n += 1
        if n >= want:
            break
    print(f'SHARD off={shard_offset()} k={k} source={source} depths={depths} positions={n} '
          f'{time.time() - t0:.0f}s', flush=True)


if __name__ == '__main__':
    main()
