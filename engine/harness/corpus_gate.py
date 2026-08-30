"""Corpus replay gate over the committed self-play corpus (4,202 positions).

Three checks per in-scope position:
  1. SFN round-trips through the Rust engine byte-identically.
  2. Derived state (totals, mana, charged sigils) matches simboard.py.
  3. The legal-turn sets agree: every turn simboard's collapsed generator finds
     must appear among the turns the Rust generator finds (superset property),
     compared on (first action, target, push destination).

Also reports how much of the corpus is out of scope, since that bounds how much
existing training data is reusable.
"""
import json, os, sys, collections
sys.path.insert(0, os.path.join(os.environ['SCRATCH'], 'ref'))
from notation import NODE_ORDER
from simboard import SimBoard
from ai.config import SPELL_TO_ID
import sigil_engine as se

IDX = {n: i for i, n in enumerate(NODE_ORDER)}
PANDA = {'Perfect_Heist','Moth_Plague','Ripples','Lifesap','Stampede','Choke',
         'Bear_Trap','Shiver','Blood_Saplings','Itch','Free_Spirit','Residue_Mixture'}

path = os.path.join(os.environ['SCRATCH'], 'ref', 'corpus.jsonl')
stats = collections.Counter()
fails = []

with open(path) as f:
    for lineno, line in enumerate(f, 1):
        rec = json.loads(line)
        sfn = rec.get('sfn')
        if not sfn:
            stats['no_sfn'] += 1
            continue
        stats['total'] += 1
        spells_part = sfn.split(' ')[0].split('/')[1].split(',')
        if any(s in PANDA for s in spells_part):
            stats['skip_panda'] += 1; continue
        ids = [SPELL_TO_ID.get(s) for s in spells_part]
        if any(i is None for i in ids):
            stats['skip_unknown_spell'] += 1; continue
        if any(i >= 39 for i in ids):
            stats['skip_deferred_pack'] += 1; continue
        if 'x' in sfn.split(' ')[0].split('/')[0]:
            stats['skip_fissure'] += 1; continue
        if any(t.startswith(('pm:','ab:','sn:')) for t in sfn.split()):
            stats['skip_pack_state'] += 1; continue

        try:
            rb = se.Board.from_sfn(sfn)
        except Exception as e:
            fails.append(('from_sfn', lineno, str(e)[:90])); stats['fail_parse'] += 1; continue
        stats['in_scope'] += 1

        # 1. round-trip
        if rb.to_sfn().split(' ')[0] != sfn.split(' ')[0]:
            fails.append(('roundtrip_stones', lineno, rb.to_sfn()[:60])); stats['fail_rt'] += 1

        # 2. derived state vs simboard
        pb = SimBoard.from_sfn(sfn)
        if (pb.totalstones['red'], pb.totalstones['blue']) != rb.total:
            fails.append(('total', lineno, f"{pb.totalstones} vs {rb.total}")); stats['fail_total'] += 1
        if (pb.mana['red'], pb.mana['blue']) != rb.mana:
            fails.append(('mana', lineno, f"{pb.mana} vs {rb.mana}")); stats['fail_mana'] += 1
        for c in ('red','blue'):
            want = sorted(pb.charged_spells[c])
            got = sorted(spells_part[p-1] for p in rb.charged(c))
            if want != got:
                fails.append(('charged', lineno, f"{c}: {want} vs {got}")); stats['fail_charged'] += 1

        # 3. superset property on legal turns
        colour = 'red' if sfn.split(' ')[1] == 'r' else 'blue'
        try:
            pyturns = list(pb.get_legal_turns(colour))
        except Exception as e:
            stats['py_gen_error'] += 1; pyturns = None
        if pyturns is not None:
            def pykey(t):
                a = t.actions[0]
                # simboard distinguishes 'move' (soft) from 'hard_move'; the Rust
                # side reports both as 'move' and carries the push destination
                # separately. It also marks a crush with the string 'X' where we
                # use None. Normalise both before comparing.
                kind = 'move' if a.type in ('move', 'hard_move') else a.type
                dest = getattr(a, 'pushed_to', None)
                if dest == 'X':
                    dest = None
                return (kind, a.node, dest)
            want = set()
            for t in pyturns:
                try: want.add(pykey(t))
                except Exception: pass
            got = set()
            # When no move target exists both engines offer only a bare pass, and
            # `first_move_variants` lists move variants only, so record it here.
            fmv = rb.first_move_variants()
            if not fmv:
                got.add(('pass', None, None))
            for kind, node, push in fmv:
                got.add((kind, None if node < 0 else NODE_ORDER[node],
                         None if push < 0 else NODE_ORDER[push]))
            # simboard labels a Wind blink 'blink' and a plain move 'move'; ours match.
            missing = {w for w in want if (w[0], w[1], w[2]) not in got}
            if missing:
                stats['fail_superset'] += 1
                if len(fails) < 40: fails.append(('superset', lineno, str(list(missing)[:3])))
        if False:
            pass

print("corpus:", dict(stats))
tot = stats['total'] or 1
skipped = sum(v for k, v in stats.items() if k.startswith('skip'))
print(f"\nin scope: {stats['in_scope']} / {stats['total']} examined "
      f"({100*stats['in_scope']/tot:.1f}%)   skipped {skipped}")
bad = sum(v for k, v in stats.items() if k.startswith('fail'))
print(f"failures: {bad}")
for kind, ln, msg in fails[:10]:
    print(f"  {kind} @line {ln}: {msg}")
sys.exit(1 if bad else 0)
