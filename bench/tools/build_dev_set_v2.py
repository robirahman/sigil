#!/usr/bin/env python3
"""Build the public SigilBench dev set v2: mate-in-1..4, every spell in scope.

    python3 bench/tools/build_dev_set_v2.py --mate4 <mined.json> [--per 25,25,25,25] [--seed 20261101]

Differences from v1 (build_dev_set.py):
  * mate-in-4 puzzles, mined for v2 (bench/tools/mine_mate4.py) from the
    position two plies before a known mate-in-3 in the same game. They were
    never on the Puzzles page; this file publishes them, so the private test
    set must not reuse their positions (`source` says where each came from);
  * no spell is excluded: grading enumerates the full browser rules
    (cast_enum::set_full_rules), and every puzzle is re-proven under them,
    so a stored line the wider rules refute (Rock Slide, Corrupt, Comet,
    Erupt defences) fails the self-test and is skipped;
  * every one of the 45 spells appears on at least one board when the pool
    allows it (greedy cover inside each N, then rating spread).

Selection per N (deterministic for a seed): forced mates from the published
set (N<=3) or the mined file (N=4), variants standard/competitive, at most one
puzzle per source game; every pick passes the grader self-test (stored first
turns replay in the browser rules to their stored position; bench_grade proves
the first one within N); shortest-mate check: no stored first turn of an
N-puzzle forces mate within N-1 (graded by bench_grade). For N=2 "no
mate-in-1" is an exhaustive proof; for N=3 and N=4 a shorter mate is only
not found (nominate-then-prove), as recorded in `shortest_mate`.
"""
import argparse
import collections
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import BENCH, CANARY, REPO  # noqa: E402
from sigilbench.grader import Grader  # noqa: E402
from sigilbench.render import parse_sfn  # noqa: E402

SRC = os.path.join(REPO, 'docs', 'static', 'puzzles', 'mate_puzzles.json')
OUT = os.path.join(BENCH, 'dev', 'dev_set_v2.json')
SHORTEST = {
    1: 'mate in 1 (complete enumeration)',
    2: 'mate in 2; no mate in 1 (exhaustive proof)',
    3: 'mate in 3; no mate in 1 (exhaustive proof); no stored first turn mates in 2, but a mate in 2 is NOT excluded',
    4: 'mate in 4; no mate in 1 (exhaustive proof); no mate in 2 or 3 found by the solver or by any stored first turn, '
       'but a shorter mate is NOT excluded',
}


def spells(p):
    return set(parse_sfn(p['sfn'])['spells'])


def self_test(g, p, n):
    sols = p['solutions']
    for s in sols[:5]:
        r = g.replay(p['sfn'], s['actions'])
        if not r.get('ok') or r['key'] != s['key'] or r['key'] not in p['solution_keys']:
            return False, f'stored solution does not replay: {r}'
    r = g.replay(p['sfn'], sols[0]['actions'])
    v = g.rust.ask(f"{n}\t{p['sfn']}\t{r['after']}")
    if v.get('verdict') != 'mate':
        return False, f'bench_grade did not prove the stored solution under the full rules: {v}'
    return True, v


def faster_mate(g, p, n):
    if n <= 2:
        return False                    # N=2: no mate-in-1 is already an exhaustive proof
    for s in p['solutions'][:8]:
        r = g.replay(p['sfn'], s['actions'])
        v = g.rust.ask(f"{n - 1}\t{p['sfn']}\t{r['after']}")
        if v.get('verdict') == 'mate':
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mate4', required=True, help='mined mate-in-4 puzzles (mine_mate4.py --assemble output)')
    ap.add_argument('--per', default='25,25,25,25')
    ap.add_argument('--seed', type=int, default=20261101)
    ap.add_argument('--out', default=OUT)
    a = ap.parse_args()
    quota = dict(zip((1, 2, 3, 4), (int(x) for x in a.per.split(','))))
    rng = random.Random(a.seed)
    pub = json.load(open(SRC))
    mined = json.load(open(a.mate4))
    pool = [dict(p, source='published') for p in pub['puzzles'] if p['kind'] == 'mate' and p['mate'] in (1, 2, 3)]
    pool += [dict(p, source=p.get('source', 'mined-v2')) for p in mined['puzzles'] if p.get('mate') == 4]
    pool = [p for p in pool if p['variant'] in ('standard', 'competitive')]
    rng.shuffle(pool)
    g = Grader()
    chosen, games, log = {n: [] for n in quota}, set(), collections.Counter()
    covered = set()
    for n in (4, 3, 2, 1):                       # scarcest first, so its games are not taken
        cand = [p for p in pool if p['mate'] == n]
        by_level = collections.defaultdict(list)
        for p in cand:
            by_level[p.get('rating', 0)].append(p)
        levels = sorted(by_level)
        i = 0
        while len(chosen[n]) < quota[n] and any(by_level.values()):
            # Prefer a puzzle that brings an uncovered spell; else round-robin over rating levels.
            pick = None
            gain = [p for p in cand if p['game']['id'] not in games and (spells(p) - covered)]
            if gain:
                pick = max(gain, key=lambda p: len(spells(p) - covered))
                cand.remove(pick)
                for lvl in by_level:
                    if pick in by_level[lvl]:
                        by_level[lvl].remove(pick)
            else:
                lvl = levels[i % len(levels)]
                i += 1
                if not by_level[lvl]:
                    continue
                pick = by_level[lvl].pop()
                if pick in cand:
                    cand.remove(pick)
            if pick['game']['id'] in games:
                log['skip: same source game'] += 1
                continue
            ok, why = self_test(g, pick, n)
            if not ok:
                log[f'skip N={n}: self-test failed'] += 1
                print('self-test FAIL', pick['id'], why, file=sys.stderr)
                continue
            if faster_mate(g, pick, n):
                log[f'skip N={n}: a stored turn mates faster'] += 1
                continue
            games.add(pick['game']['id'])
            covered |= spells(pick)
            chosen[n].append(pick)
            print(f"N={n} {len(chosen[n])}/{quota[n]} {pick['id']} spells covered {len(covered)}", file=sys.stderr)
    g.close()
    out = []
    for n in (1, 2, 3, 4):
        for p in chosen[n]:
            out.append({
                'source_puzzle_id': p['id'], 'source': p['source'], 'n': n, 'shortest_mate': SHORTEST[n],
                'mover': p['mover'], 'sfn': p['sfn'], 'variant': p['variant'], 'rating': p.get('rating'),
                'tags': p.get('tags', []), 'solution_keys': p['solution_keys'],
                'reference_solution': p['solutions'][0]['actions'],
                'source_game': {'id': p['game']['id'], 'date': p['game'].get('date')},
            })
    rng.shuffle(out)
    out = [dict([('id', f'sbdev2-{i:03d}')] + list(q.items())) for i, q in enumerate(out, 1)]
    all_spells = set()
    for p in pool:
        all_spells |= spells(p)
    doc = {
        'canary': CANARY,
        'name': 'SigilBench public dev set v2',
        'description': ('Forced mates in 1-4 turns. N<=3 from the published Sigil Puzzles set; N=4 mined for v2 '
                        '(never on the Puzzles page; now public through this file). Every spell in scope may appear. '
                        'For prompt, parser and harness development only; never use it to report a model score.'),
        'seed': a.seed, 'counts': {str(n): len(chosen[n]) for n in chosen},
        'spells_covered': sorted(covered), 'spells_missing': sorted(all_spells - covered),
        'selection_log': dict(log), 'puzzles': out,
    }
    with open(a.out, 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    print(json.dumps(doc['counts']), 'spells', len(covered), dict(log), file=sys.stderr)


if __name__ == '__main__':
    main()
