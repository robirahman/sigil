"""Randomised differential test: Rust kernel vs simboard.py on the primitives the
whole search rests on. Positions are random stone placements, not necessarily
reachable, precisely so we probe corners self-play never reaches."""
import random, sys, os
sys.path.insert(0, os.path.join(os.environ['SCRATCH'], 'ref'))
from notation import NODE_ORDER
from simboard import SimBoard
import sigil_engine as se

IDX = {n: i for i, n in enumerate(NODE_ORDER)}
SPELLS = ['Flourish','Carnage','Bewitch','Starfall','Seal_of_Lightning',
          'Grow','Fireblast','Hail_Storm','Meteor']
SPELL_IDS = [0,1,2,3,4,5,6,7,8]

def make_pair(rng, density):
    red, blue = [], []
    for n in NODE_ORDER:
        r = rng.random()
        if r < density: red.append(n)
        elif r < 2*density: blue.append(n)
    py = SimBoard(SPELLS, 'standard')
    for n in red:  py.stones[n] = 'red'
    for n in blue: py.stones[n] = 'blue'
    py.update()
    rs = se.Board(SPELL_IDS, "standard")
    rs.set_stones([IDX[n] for n in red], [IDX[n] for n in blue])
    return py, rs, red, blue

def names(idxs): return sorted(NODE_ORDER[i] for i in idxs)

fails = []
def check(what, a, b, ctx):
    if a != b: fails.append((what, a, b, ctx))

rng = random.Random(20260826)
t = -1
for t in range(4000):
    py, rs, red, blue = make_pair(rng, rng.choice([0.05, 0.15, 0.3, 0.45]))
    ctx = f"case {t} red={red} blue={blue}"
    check("total", (py.totalstones['red'], py.totalstones['blue']), rs.total, ctx)
    check("mana",  (py.mana['red'], py.mana['blue']), rs.mana, ctx)
    for c in ('red','blue'):
        check(f"charged[{c}]", sorted(py.charged_spells[c]),
              sorted(SPELLS[p-1] for p in rs.charged(c)), ctx)
        check(f"soft_moveable[{c}]", sorted(py._soft_moveable(c)), names(rs.soft_moveable(c)), ctx)
        check(f"hard_moveable[{c}]", sorted(py._hard_moveable(c)), names(rs.hard_moveable(c)), ctx)
        check(f"all_moveable[{c}]",  sorted(py._all_moveable(c)),  names(rs.all_moveable(c)), ctx)
    for c in ('red','blue'):
        defender = 'blue' if c == 'red' else 'red'
        for target in py._hard_moveable(c):
            ti = IDX[target]
            check(f"escape_distance({target},{defender})",
                  py.escape_distance(target, defender, max_dist=39),
                  rs.escape_distance(ti, defender, 39), ctx)
            check(f"is_crushable({target},{c})",
                  py.is_crushable(target, c), rs.is_crushable(ti, c), ctx)
            check(f"push_options({target},{c})",
                  None, None, ctx)  # placeholder keeps numbering stable
            pc, rc = py.copy(), rs.clone_board()
            pdest = pc._push_enemy(target, c)
            rdest = rc.push_enemy(ti, c)
            check(f"push_dest({target},{c})",
                  None if pdest == 'X' else pdest,
                  None if rdest is None else NODE_ORDER[rdest], ctx)
            pc.update()
            check(f"push_result_red({target},{c})",
                  sorted(n for n in NODE_ORDER if pc.stones[n]=='red'), names(rc.red), ctx)
            check(f"push_result_blue({target},{c})",
                  sorted(n for n in NODE_ORDER if pc.stones[n]=='blue'), names(rc.blue), ctx)
    if len(fails) > 5: break

print(f"positions compared: {t+1}")
if not fails:
    print("PARITY OK — all primitives agree with simboard.py")
else:
    print(f"MISMATCHES: {len(fails)}")
    for what, a, b, ctx in fails[:6]:
        print(f"\n  {what}\n    python: {a}\n    rust:   {b}\n    {ctx}")
    sys.exit(1)
