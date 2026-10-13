"""Pool interp_exchange.py output into exchange rates (interpretability experiment 2).

    fit_exchange.py <out.json> <log-glob> [<log-glob> ...]

Reads every `XPOS {json}` line and reports, separately for self-play and human
positions and for each valuation (hand = tfit_spell_v2 static, full = the shipped
eval static, dN = the shipped search at depth N), all in STONES from the side to
move's point of view (1 stone = 100 centistones):

  * own stone value per node: V(position) - V(that stone removed) where the side
    to move holds the node, and V(stone added) - V(position) where it is empty;
    pooled, by node, by node class (mana, ritual / sorcery / charm sigil, void)
    and by game phase (stones on the board);
  * the same for the opponent's stones (the value of removing one = a capture);
  * the charge premium: removing a stone that breaks the mover's own charged
    sigil, against removing one that breaks none; adding the stone that
    completes a sigil, against adding one that completes none (same positions);
  * the value of the move: V(position) - V(same stones, other side to move);
  * exchange rates relative to an ordinary stone (a stone on a void node).

Probes whose values are mate scores (|v| >= 4000 cs) are dropped for that
valuation. 95% intervals come from a bootstrap over games.
"""
import collections, glob, json, sys
import numpy as np

MATE = 4000
NAMES = [f'{arm}{i}' for arm in 'abc' for i in range(1, 14)]
CLASS = {}
for arm in range(3):
    o = 13 * arm
    CLASS[o] = 'mana'
    for i in range(1, 6): CLASS[o + i] = 'ritual sigil'
    CLASS[o + 6] = 'charm sigil'
    for i in range(7, 10): CLASS[o + i] = 'sorcery sigil'
    for i in range(10, 13): CLASS[o + i] = 'void'
SIGIL = [0x0000000003e, 0x0000007c000, 0x000f8000000, 0x00000000380, 0x00000700000,
         0x00e00000000, 0x00000000040, 0x00000080000, 0x00100000000]
SLOT_OF = {n: p for p in range(9) for n in range(39) if SIGIL[p] >> n & 1}


def phase(total):
    s = total[0] + total[1]
    return 'early (<=12 stones)' if s <= 12 else 'middle (13-20)' if s <= 20 else 'late (21+)'


def boot(vals, games, reps=400, seed=0):
    """Mean and 95% interval, bootstrapping games."""
    vals = np.asarray(vals, float); games = np.asarray(games)
    if len(vals) == 0:
        return None
    ug, inv = np.unique(games, return_inverse=True)
    s = np.bincount(inv, vals, len(ug)); c = np.bincount(inv, None, len(ug))
    rng = np.random.default_rng(seed); bs = []
    for _ in range(reps):
        k = rng.integers(0, len(ug), len(ug))
        bs.append(s[k].sum() / max(1, c[k].sum()))
    return [round(float(vals.mean()), 3), round(float(np.percentile(bs, 2.5)), 3),
            round(float(np.percentile(bs, 97.5)), 3), int(len(vals)), int(len(ug))]


def main():
    out_path, globs = sys.argv[1], sys.argv[2:]
    recs = []
    seen = set()
    for g in globs:
        for path in sorted(glob.glob(g)):
            for line in open(path, errors='replace'):
                if not line.startswith('XPOS '):
                    continue
                try:
                    d = json.loads(line[5:])
                except json.JSONDecodeError:
                    continue
                key = (d['src'], str(d['game']), d['ply'], d['sfn'])
                if key in seen:
                    continue
                seen.add(key); recs.append(d)
    print(f'{len(recs)} positions', flush=True)
    res = {}
    for src in ('selfplay', 'human'):
        R = [d for d in recs if d['src'] == src]
        if not R:
            continue
        vals_keys = ['hand', 'full'] + [f'd{x}' for x in R[0]['depths']]
        S = collections.defaultdict(lambda: ([], []))      # (group, valuation) -> (values, games)
        def add(group, vk, v, game):
            S[(group, vk)][0].append(v / 100.0); S[(group, vk)][1].append(game)
        for d in R:
            game = f"{src}:{d['game']}"
            ph = phase(d['total'])
            mover_i = 0 if d['mover'] == 'red' else 1
            own_charged = set(d['charged'][mover_i]); opp_charged = set(d['charged'][1 - mover_i])
            for kind, n, v, ch in d['probes']:
                for vk in vals_keys:
                    b0, b1 = d['base'][vk], v[vk]
                    if abs(b0) >= MATE or abs(b1) >= MATE:
                        continue
                    if kind == 'flip':
                        add('move value', vk, b0 - b1, game)
                        add(f'move value | {ph}', vk, b0 - b1, game)
                        continue
                    side = 'own' if kind.endswith('own') else 'opp'
                    # Value of the stone to the side to move, either way round.
                    sv = (b0 - b1) if kind.startswith('rm') else (b1 - b0)
                    if side == 'opp':
                        sv = -sv                               # an enemy stone's value to the mover is negative; report its size
                    new_own = set(ch[mover_i]); new_opp = set(ch[1 - mover_i])
                    if kind == 'rm_own':
                        tag = 'breaks own charge' if own_charged - new_own else 'no charge change'
                    elif kind == 'add_own':
                        tag = 'completes own sigil' if new_own - own_charged else 'no charge change'
                    elif kind == 'rm_opp':
                        tag = 'breaks enemy charge' if opp_charged - new_opp else 'no charge change'
                    else:
                        tag = 'completes enemy sigil' if new_opp - opp_charged else 'no charge change'
                    act = 'held' if kind.startswith('rm') else 'placed'
                    add(f'{side} stone', vk, sv, game)
                    add(f'{side} stone | {act}', vk, sv, game)
                    add(f'{side} stone | {ph}', vk, sv, game)
                    add(f'{side} stone | class {CLASS[n]}', vk, sv, game)
                    add(f'{side} stone | class {CLASS[n]} | {ph}', vk, sv, game)
                    add(f'{side} stone | node {NAMES[n]}', vk, sv, game)
                    add(f'{side} stone | {kind} | {tag}', vk, sv, game)
                    if n in SLOT_OF:
                        s = d['spells'][SLOT_OF[n]]
                        add(f'{side} stone | spell {s}', vk, sv, game)
                        add(f'{side} stone | spell {s} | {tag}', vk, sv, game)
        res[src] = {f'{g} || {vk}': boot(*S[(g, vk)]) for (g, vk) in sorted(S)}
        res[src + '_positions'] = len(R)
        res[src + '_games'] = len({d['game'] for d in R})
    json.dump(res, open(out_path, 'w'), indent=0)
    for src in ('selfplay', 'human'):
        if src not in res:
            continue
        print(f"\n=== {src}: {res[src + '_positions']} positions, {res[src + '_games']} games")
        T = res[src]
        for g in ['own stone', 'opp stone', 'move value',
                  *[f'own stone | class {c}' for c in ('void', 'mana', 'ritual sigil', 'sorcery sigil', 'charm sigil')],
                  *[f'own stone | {p}' for p in ('early (<=12 stones)', 'middle (13-20)', 'late (21+)')],
                  'own stone | rm_own | breaks own charge', 'own stone | rm_own | no charge change',
                  'own stone | add_own | completes own sigil', 'own stone | add_own | no charge change',
                  'opp stone | rm_opp | breaks enemy charge', 'opp stone | rm_opp | no charge change']:
            row = []
            for vk in ('hand', 'full', 'd2', 'd4'):
                v = T.get(f'{g} || {vk}')
                row.append('-' if v is None else f'{v[0]:+.2f} [{v[1]:+.2f},{v[2]:+.2f}]')
            n = T.get(f'{g} || full')
            print(f"{g:42s} " + '  '.join(f'{x:>22s}' for x in row) + f"  n={n[3] if n else 0}")


if __name__ == '__main__':
    main()
