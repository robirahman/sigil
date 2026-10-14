"""Do the spells the engine ranks against the players change value with depth?

    spell_depth_probe.py <depth>

Re-probes positions already probed at depth 4 by spell_value_probe.py, for a
handful of spells (the largest engine/player disagreements plus controls), at a
deeper search: the position as played, then with the target spell unusable for
the mover, then for the opponent (`PyBoard.set_access`, real rules otherwise).
The plan ($SIGIL_DEPTH_PLAN, default DEFAULT_PLAN) is {"tasks": [{sfn, slot,
spell, d4: [score, self, opp], stratum, ...}], "shards": [...]}; the shard
numbered off // 1000 takes tasks i with i % len(shards) == its index. Shards
not in the plan (the runner's smoke arm) run one task at depth 2.

One `DEPTH {json}` line per task: the task plus d (depth) and score/self/opp at
that depth (mover POV, centistones).
"""
import json, os, sys, time
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import shard_offset
from spell_value_probe import search, _fetch, ALL

DEFAULT_PLAN = 'gs://focus-surfer-494820-g0-sigil/data/spell_values/plan_depth6_2026-10-12.json'


def main():
    depth = int(sys.argv[1])
    se.set_policy(*se.SHIPPED_POLICY)
    se.set_policy_explore(*se.SHIPPED_EXPLORE)
    se.set_opening_book(False)
    off = shard_offset()
    plan = json.loads(_fetch(os.environ.get('SIGIL_DEPTH_PLAN', DEFAULT_PLAN)))
    shards = list(plan['shards'])
    if off // 1000 in shards:
        k = shards.index(off // 1000)
        tasks = [t for i, t in enumerate(plan['tasks']) if i % len(shards) == k]
    else:
        tasks, depth = plan['tasks'][:1], 2
        print(f'shard {off // 1000} not in the plan: smoke at depth 2', flush=True)
    t0 = time.time()
    for t in tasks:
        sfn, p = t['sfn'], t['slot']
        mover_red = sfn.split()[1] == 'r'
        cut = ALL & ~(1 << p)
        t1 = time.time()
        base = search(sfn, depth)
        mine = search(sfn, depth, *((cut, ALL) if mover_red else (ALL, cut)))
        theirs = search(sfn, depth, *((ALL, cut) if mover_red else (cut, ALL)))
        print('DEPTH ' + json.dumps(dict(t, d=depth, score=base, self=mine, opp=theirs,
                                         secs=round(time.time() - t1, 1)), separators=(',', ':')), flush=True)
    print(f'SHARD off={off} tasks={len(tasks)} {time.time() - t0:.0f}s', flush=True)


if __name__ == '__main__':
    main()
