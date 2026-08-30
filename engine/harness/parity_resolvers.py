"""Differential test of the ported spell resolvers: full cast path in both engines.
Python: _castClearAndRefill-equivalent + _resolve_spell (greedy) + lock bookkeeping.
Rust:   cast_clear_and_refill + resolve_spell + finish_cast.
Only spells whose resolver is ported are exercised; the rest are reported as skipped.
"""
import random, sys, os
sys.path.insert(0, os.path.join(os.environ['SCRATCH'], 'ref'))
from notation import NODE_ORDER, POSITIONS
from simboard import SimBoard
from ai.config import SPELL_TO_ID
import sigil_engine as se

IDX = {n:i for i,n in enumerate(NODE_ORDER)}
ID_TO_SPELL = {i:s for s,i in SPELL_TO_ID.items()}

# Ask the Rust engine which resolvers are implemented, rather than keeping a
# hardcoded list in sync by hand. Harvest/Gather/Seal_of_Autumn are additionally
# excluded: they are absent from simboard.py's CORE_SPELLS entirely (the Python
# simulator never implemented Autumn), so there is no Python reference to compare
# against; they are covered by unit tests written from the live JS spec instead.
from simboard import CORE_SPELLS
_probe = se.Board(list(range(9)), "standard")
autumn_missing = [s for s in ('Harvest','Gather','Seal_of_Autumn') if s not in CORE_SPELLS]
print("absent from simboard.py CORE_SPELLS:", autumn_missing)
ported_ids = sorted(i for i in range(39)
                    if _probe.resolver_ready(i) and ID_TO_SPELL[i] in CORE_SPELLS)
print("exercising spell ids:", ported_ids)
print("  names:", [ID_TO_SPELL[i] for i in ported_ids])

fails = []
rng = random.Random(4242)
cases = 0
from collections import Counter
cover = Counter()
# Systematic sweep rather than pure sampling: every ported spell in every slot,
# over several random boards each. Position matters for Syzygy (defined only for
# ritual slots 1-3), Blossom and Erupt (which skip their own slot), and the
# soft-move avoidance mask, so slot coverage is not optional.
PLAN = [(sid, slot) for sid in ported_ids for slot in range(9) for _ in range(6)]
rng.shuffle(PLAN)
for target_id, slot in PLAN:
    # respect ritual/sorcery/charm sizing loosely: any id can sit in any slot for
    # engine purposes, and both engines index the same way, so this is a fair test.
    # Distinct spells, as a real draw is: duplicate ids would make a
    # position-by-id lookup ambiguous, which is a harness artifact not a rule.
    pool = [i for i in ported_ids if i != target_id]
    rng.shuffle(pool)
    draw = pool[:9]
    while len(draw) < 9: draw.append(target_id)
    draw = draw[:9]
    draw[slot] = target_id
    names = [ID_TO_SPELL[i] for i in draw]

    density = rng.choice([0.1, 0.2, 0.35])
    red, blue = [], []
    for n in NODE_ORDER:
        r = rng.random()
        if r < density: red.append(n)
        elif r < 2*density: blue.append(n)
    if not red or not blue:
        continue
    color = rng.choice(['red','blue'])
    lock_id = rng.choice([None] + draw)

    py = SimBoard(names, 'standard')
    for n in red:  py.stones[n] = 'red'
    for n in blue: py.stones[n] = 'blue'
    if lock_id is not None: py.lock[color] = ID_TO_SPELL[lock_id]
    py.update()

    rs = se.Board(draw, "standard")
    rs.set_stones([IDX[n] for n in red], [IDX[n] for n in blue])
    rs.lock = (lock_id if lock_id is not None and color=='red' else 255,
               lock_id if lock_id is not None and color=='blue' else 255)

    spell = names[slot]
    pos_nodes = POSITIONS[slot+1]
    # must actually be charged to be castable; force it in both engines
    for n in pos_nodes:
        py.stones[n] = color
    py.update()
    rs.set_stones(
        [IDX[n] for n in NODE_ORDER if py.stones[n]=='red'],
        [IDX[n] for n in NODE_ORDER if py.stones[n]=='blue'])
    rs.lock = (lock_id if lock_id is not None and color=='red' else 255,
               lock_id if lock_id is not None and color=='blue' else 255)

    if not rs.resolver_ready(draw[slot]):
        continue
    cases += 1
    cover[(ID_TO_SPELL[target_id], slot+1)] += 1

    # --- Python cast: clear + refill, then resolve ---
    info = CORE_SPELLS[spell]
    for n in pos_nodes: py.stones[n] = None
    if not info.get('ischarm'):
        refills = py.mana[color]
        priority = ([pos_nodes[2], pos_nodes[1], pos_nodes[0]] if len(pos_nodes)==3
                    else [pos_nodes[2], pos_nodes[3], pos_nodes[4], pos_nodes[0], pos_nodes[1]]
                    if len(pos_nodes)==5 else [pos_nodes[0]])
        for nd in priority:
            if refills > 0:
                py.stones[nd] = color; refills -= 1
    py.update()
    py._resolve_spell(spell, color, pos_nodes)
    py.update()

    # --- Rust cast ---
    rs.cast_clear_and_refill(slot, color)
    rs.resolve_spell_at(slot, color)
    rs.update()

    pr = sorted(n for n in NODE_ORDER if py.stones[n]=='red')
    pb = sorted(n for n in NODE_ORDER if py.stones[n]=='blue')
    rr = sorted(NODE_ORDER[i] for i in rs.red)
    rb = sorted(NODE_ORDER[i] for i in rs.blue)
    if (pr, pb) != (rr, rb):
        fails.append((spell, slot, color, lock_id, red, blue, pr, pb, rr, rb))
        if len(fails) >= 4: break

print(f"casts compared: {cases}")
spell_cov = Counter()
for (nm, sl), k in cover.items(): spell_cov[nm] += k
missing = [ID_TO_SPELL[i] for i in ported_ids if spell_cov[ID_TO_SPELL[i]] == 0]
print(f"spells exercised: {len(spell_cov)}/{len(ported_ids)}", 
      ("  MISSING: " + ", ".join(missing)) if missing else "")
slots_per = {nm: len({sl for (n2, sl) in cover if n2 == nm}) for nm in spell_cov}
thin = {nm: k for nm, k in slots_per.items() if k < 9}
print("spells not covered in all 9 slots:", thin if thin else "none")
print("min casts for any single spell:", min(spell_cov.values()) if spell_cov else 0)
if not fails:
    print("RESOLVER PARITY OK")
else:
    print(f"MISMATCHES: {len(fails)}")
    for spell, slot, color, lk, red, blue, pr, pb, rr, rb in fails[:4]:
        print(f"\n  spell={spell} slot={slot+1} color={color} lock={ID_TO_SPELL.get(lk)}")
        print(f"    start red={red}\n    start blue={blue}")
        print(f"    py red = {pr}\n    rs red = {rr}")
        print(f"    py blue= {pb}\n    rs blue= {rb}")
    sys.exit(1)
