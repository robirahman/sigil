"""Does the engine keep filling sigils that Fissure has killed? (2026-10)

    fissure_dead_fill.py gen <out.jsonl> <games> [--ms 300] [--jobs 4] [--seed0 7000000]
    fissure_dead_fill.py probe <positions.jsonl> <out.json> [--ms 2000] [--jobs 4]

A sigil holding a Fissure wall (an `x` in the SFN) can never charge again, so its
spell is dead for both sides. `gen` plays self-play on Fissure draws
(ab_search.draw_for with SIGIL_REQUIRE_SPELL=39) and keeps every position, after
the first wall, whose side to move has an empty node in a dead sigil. `probe`
searches each kept position once with the ARM (`sigil_engine` as imported) and
once with the BASE ($SIGIL_BASE_MODULE, as ab_version.py), both in their own
shipped config, and counts the mover's NEW stones (on the board after the turn,
not before it) that sit on dead-sigil nodes.

Reported per engine:
  fill_rate   share of turns that put at least one new stone on a dead sigil
  dead_share  dead-sigil share of all new stones
  baseline    dead-sigil share of the empty nodes at turn start (what a placement
              blind to the sigils would give)
The two engines see the same positions, so the difference is paired.
"""
import argparse
import json
import multiprocessing as mp
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
os.environ.setdefault('SIGIL_REQUIRE_SPELL', '39')

# topology.rs SIGIL, slot 0..8.
SIGIL = [0x0000000003e, 0x0000007c000, 0x000f8000000, 0x00000000380, 0x00000700000,
         0x00e00000000, 0x00000000040, 0x00000080000, 0x00100000000]
TT_BITS = 20


def parse(sfn):
    """(red, blue, walls, mover) masks from an SFN."""
    stones = sfn.split(' ')[0].split('/')[0]
    m = {'r': 0, 'b': 0, 'x': 0}
    for i, ch in enumerate(stones):
        if ch in m:
            m[ch] |= 1 << i
    return m['r'], m['b'], m['x'], sfn.split()[1]


def dead_nodes(walls):
    d = 0
    for s in SIGIL:
        if walls & s:
            d |= s
    return d & ~walls


def load_base(path):
    # ab_version.load_base; that module loads $SIGIL_BASE_MODULE on import, so it
    # cannot be imported by `gen`, which has no base.
    import importlib.machinery, importlib.util
    loader = importlib.machinery.ExtensionFileLoader('sigil_engine', path)
    spec = importlib.util.spec_from_file_location('sigil_engine', path, loader=loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def engines():
    import sigil_engine as arm
    out = {'arm': arm}
    if os.environ.get('SIGIL_BASE_MODULE'):
        out['base'] = load_base(os.environ['SIGIL_BASE_MODULE'])
    return out


def play(se, sfn, ms):
    # Each engine in its own shipped config, as ab_version.game.
    bd = se.Board.from_sfn(sfn)
    if hasattr(se, 'SHIPPED_POLICY'):
        se.set_policy(*se.SHIPPED_POLICY)
    if hasattr(se, 'SHIPPED_EXPLORE'):
        se.set_policy_explore(*se.SHIPPED_EXPLORE)
    r = bd.play_best(ms, 64, TT_BITS, 16, None, [], se.SHIPPED_EVAL, False,
                     adaptive=tuple(se.SHIPPED_ADAPTIVE))
    return bd.to_sfn(), r


# ---- gen ---------------------------------------------------------------------

def gen_game(args):
    seed, ms = args
    import sigil_engine as se
    from ab_search import draw_for
    b = se.Board(draw_for(seed), "standard")
    b.setup_initial()
    sfn = b.to_sfn()
    out = []
    for ply in range(140):
        red, blue, walls, mover = parse(sfn)
        if walls and dead_nodes(walls) & ~(red | blue):
            out.append({'seed': seed, 'ply': ply, 'sfn': sfn})
        sfn, r = play(se, sfn, ms)
        if r[3]:
            break
    return seed, out


def cmd_gen(a):
    seeds = [(a.seed0 + i, a.ms) for i in range(a.games)]
    n_pos = n_games_with = 0
    with open(a.out, 'w') as f, mp.Pool(a.jobs) as pool:
        for k, (seed, pos) in enumerate(pool.imap_unordered(gen_game, seeds)):
            for p in pos:
                f.write(json.dumps(p) + '\n')
            n_pos += len(pos); n_games_with += bool(pos)
            if (k + 1) % 10 == 0:
                print(f'  {k + 1}/{a.games} games, {n_games_with} with a dead sigil, '
                      f'{n_pos} positions', flush=True)
    print(f'gen: {a.games} games, {n_games_with} reached a dead sigil, {n_pos} positions')


# ---- probe -------------------------------------------------------------------

_ENG = None


def probe_one(args):
    global _ENG
    if _ENG is None:
        _ENG = engines()
    rec, ms = args
    red, blue, walls, mover = parse(rec['sfn'])
    dead = dead_nodes(walls)
    empty = ~(red | blue | walls) & ((1 << 39) - 1)
    mine = red if mover == 'r' else blue
    row = {'seed': rec['seed'], 'ply': rec['ply'],
           'empty': bin(empty).count('1'), 'empty_dead': bin(empty & dead).count('1')}
    for name, se in _ENG.items():
        after, r = play(se, rec['sfn'], ms)
        ar, ab, aw, _ = parse(after)
        new = (ar if mover == 'r' else ab) & ~mine
        # A wall cast this turn kills more sigils; count against the START's dead set.
        row[name] = {'new': bin(new).count('1'), 'new_dead': bin(new & dead).count('1'),
                     'depth': r[0]}
    return row


def summarise(rows, name):
    turns = [r for r in rows if name in r]
    filled = sum(1 for r in turns if r[name]['new_dead'] > 0)
    new = sum(r[name]['new'] for r in turns)
    new_dead = sum(r[name]['new_dead'] for r in turns)
    return {'turns': len(turns), 'fill_rate': filled / max(1, len(turns)),
            'dead_share': new_dead / max(1, new), 'new_stones': new, 'new_dead': new_dead}


def cmd_probe(a):
    recs = [json.loads(l) for l in open(a.positions)]
    if a.limit:
        recs = recs[:a.limit]
    rows = []
    with mp.Pool(a.jobs) as pool:
        for k, row in enumerate(pool.imap_unordered(probe_one, [(r, a.ms) for r in recs])):
            rows.append(row)
            if (k + 1) % 25 == 0:
                print(f'  {k + 1}/{len(recs)}', flush=True)
    empty = sum(r['empty'] for r in rows)
    res = {'ms': a.ms, 'positions': len(rows),
           'baseline': sum(r['empty_dead'] for r in rows) / max(1, empty)}
    for name in ('arm', 'base'):
        if rows and name in rows[0]:
            res[name] = summarise(rows, name)
    if 'base' in res:
        # Paired: turns where exactly one engine fills a dead sigil.
        res['only_arm_fills'] = sum(1 for r in rows if r['arm']['new_dead'] and not r['base']['new_dead'])
        res['only_base_fills'] = sum(1 for r in rows if r['base']['new_dead'] and not r['arm']['new_dead'])
    json.dump({'summary': res, 'rows': rows}, open(a.out, 'w'), indent=1)
    print(json.dumps(res, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    g = sub.add_parser('gen')
    g.add_argument('out'); g.add_argument('games', type=int)
    g.add_argument('--ms', type=int, default=300); g.add_argument('--jobs', type=int, default=4)
    g.add_argument('--seed0', type=int, default=7_000_000)
    p = sub.add_parser('probe')
    p.add_argument('positions'); p.add_argument('out')
    p.add_argument('--ms', type=int, default=2000); p.add_argument('--jobs', type=int, default=4)
    p.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    {'gen': cmd_gen, 'probe': cmd_probe}[a.cmd](a)


if __name__ == '__main__':
    main()
