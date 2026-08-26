#!/usr/bin/env python3
"""Drive the SFN-assertion gate for the action emitter.

For many positions and many enumerated turns, emit the JS action list and check
that the REAL `applyAITurn` reproduces the position the engine predicted.

    python engine/harness/run_emit_gate.py [positions] [moves_per_position]

Any mismatch blocks shipping: `turns[].actions` feeds game review,
`reconstructGameLog`, SGN export and `ai/import_human_games.py`, so a silent
divergence would corrupt recorded history and training data.

Coverage is reported alongside the pass rate. A run that exercises no CASTS proves
almost nothing — moves and dashes are the easy half, and the first version of this
gate passed 3,270/3,270 while testing zero casts.
"""
import collections, json, os, random, subprocess, sys
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, os.path.join(os.environ['SCRATCH'], 'ref'))
import sigil_engine as se

ENGINE_DIR = os.environ.get('SIGIL_ENGINE_JS') or os.path.join(
    os.environ['SCRATCH'], 'ref', 'docs', 'static', 'scripts', 'engine')
GATE = os.path.join(_HERE, 'emit_gate.js')

# Node indices per sigil position (a1..a13 = 0..12, b* = 13..25, c* = 26..38).
SIGILS = [[1,2,3,4,5], [14,15,16,17,18], [27,28,29,30,31],
          [7,8,9], [20,21,22], [33,34,35], [6], [19], [32]]

def make_position(rng, force_charge):
    b = se.Board(se.Board.legal_draw(rng.randrange(1 << 40)), "standard")
    own = set()
    if force_charge is not None:
        own |= set(SIGILS[force_charge])          # guarantees a charged, castable spell
    pool = [i for i in range(39) if i not in own]
    rng.shuffle(pool)
    n_extra = rng.randint(2, 5)
    own |= set(pool[:n_extra])
    theirs = set(pool[n_extra:n_extra + rng.randint(3, 7)])
    if not own or not theirs: return None
    b.set_stones(sorted(own), sorted(theirs))
    return None if b.gameover else b

def main():
    npos  = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    nmove = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    rng = random.Random(20260826)
    recs = []
    for k in range(npos):
        # Sweep every sigil position so Syzygy/Blossom/Erupt (position-dependent)
        # get exercised, and leave some positions uncharged for the plain-move path.
        force = (k % 10) if (k % 10) < 9 else None
        b = make_position(rng, force)
        if b is None: continue
        for kind, node, push in b.first_move_variants()[:nmove]:
            conts = b.continuations(node, push, 'red')
            # always include 'pass', then prefer the CAST continuations
            picks = [conts[0]] + [c for c in conts if c[1] == 'cast'][:4] \
                               + [c for c in conts if c[1] == 'dash'][:1]
            for label, ckind, ca, cb, ccc in picks:
                aj, exp = b.emit_choice_actions(node, push, ckind, ca, cb, ccc, 'red')
                recs.append({'sfn': b.to_sfn(), 'actions': json.loads(aj),
                             'expected_sfn': exp})
    if not recs: sys.exit("no records generated")

    kinds, spells = collections.Counter(), collections.Counter()
    for r in recs:
        for a in r['actions']:
            kinds[a['type']] += 1
            if a['type'] == 'cast': spells[a.get('spell')] += 1
    print(f"gate: {len(recs)} (position, turn) pairs -> real applyAITurn")
    print(f"  action types: {dict(kinds.most_common())}")
    print(f"  casts: {sum(spells.values())} over {len(spells)} distinct spells")
    # The 8 Seals are `static: true` and never castable. Surge is additionally
    # skipped by _getCastableSpells in both engines, so it can never be offered
    # through this path - its absence from coverage is by design, not a hole.
    STATIC = {'Seal_of_Lightning','Seal_of_Wind','Seal_of_Summer','Seal_of_Spring',
              'Seal_of_Autumn','Seal_of_Destruction','Seal_of_Stone','Seal_of_Winter',
              'Surge'}
    from ai.config import SPELL_TO_ID
    castable = {n for n, i in SPELL_TO_ID.items() if i < 39} - STATIC
    missing = sorted(castable - set(spells))
    print(f"  castable spells covered: {len(castable) - len(missing)}/{len(castable)}"
          + (f"   NOT COVERED: {missing}" if missing else "   (all)"))

    p = subprocess.run(['node', GATE, ENGINE_DIR],
                       input="\n".join(json.dumps(r) for r in recs),
                       capture_output=True, text=True)
    out = (p.stdout or "").strip().splitlines()
    if not out:
        print("gate produced no output:\n", (p.stderr or "")[:2000]); sys.exit(2)
    res = json.loads(out[-1])
    print(f"  matched   {res['ok']}")
    print(f"  MISMATCH  {res['bad']}")
    for f in res.get('fails', []):
        print("\n  ---")
        for key in ('sfn', 'error', 'want', 'got'):
            if key in f: print(f"    {key}: {f[key]}")
        print(f"    actions: {json.dumps(f.get('actions'))[:320]}")
    sys.exit(1 if res['bad'] else 0)

if __name__ == '__main__':
    main()
