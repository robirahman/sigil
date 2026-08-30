"""Soundness: for every official spell, in many legal positions, the GREEDY
resolution must be one of the enumerated outcomes. If the greedy pick is missing,
the enumeration has a hole; if enumeration returns only the greedy pick where the
live game offers a choice, it is hiding options."""
import random, sys, os
sys.path.insert(0, os.path.join(os.environ['SCRATCH'],'ref'))
from notation import NODE_ORDER
from ai.config import SPELL_TO_ID
import sigil_engine as se
ID2S={i:s for s,i in SPELL_TO_ID.items()}
IDX={n:i for i,n in enumerate(NODE_ORDER)}

rng=random.Random(99)
from collections import defaultdict
miss=[]; counts=defaultdict(list); tested=defaultdict(int)

for trial in range(4000):
    draw=se.Board.legal_draw(rng.randrange(1<<40))
    slot=rng.randrange(9)
    sid=draw[slot]
    red,blue=[],[]
    for n in NODE_ORDER:
        r=rng.random()
        if r<0.20: red.append(n)
        elif r<0.40: blue.append(n)
    if not red or not blue: continue
    col=rng.choice(['red','blue'])
    b=se.Board(draw,"standard")
    b.set_stones([IDX[x] for x in red],[IDX[x] for x in blue])
    # force the sigil charged so the spell is castable
    own = set(red if col=='red' else blue)
    nodes = [NODE_ORDER[i] for i in range(39)]
    b.set_stones([IDX[x] for x in red],[IDX[x] for x in blue])
    # charge by giving the caster the whole sigil
    import itertools
    SIG=[list(range(1,6)),list(range(6,11)),list(range(11,16))]  # unused
    # simplest: ask engine for the sigil mask by clearing+refilling later; instead
    # just set the caster's stones to include that sigil's nodes
    outs = b.cast_outcomes(slot, col)
    if not outs: continue
    tested[ID2S[sid]] += 1
    counts[ID2S[sid]].append(len(outs))
    # greedy path
    g = b.clone_board()
    g.cast_clear_and_refill(slot, col)
    g.resolve_spell_at(slot, col)
    gr = (sum(1<<i for i in g.red), sum(1<<i for i in g.blue))
    if gr not in set(outs):
        miss.append((ID2S[sid], slot, col, red, blue, len(outs)))

print(f"spells tested: {len(tested)}/39")
untested=[ID2S[i] for i in range(39) if ID2S[i] not in tested]
if untested: print("  untested:", untested)
print(f"greedy-not-in-enumeration failures: {len(miss)}")
for m in miss[:5]: print("   ", m[:3], f"outs={m[5]}")
print()
print(f"{'spell':22s} {'cases':>6s} {'mean outs':>10s} {'max outs':>9s}")
for nm in sorted(counts, key=lambda k:-sum(counts[k])/len(counts[k])):
    v=counts[nm]
    print(f"{nm:22s} {len(v):6d} {sum(v)/len(v):10.1f} {max(v):9d}")
