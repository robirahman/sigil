#!/usr/bin/env python3
"""Build the public SigilBench dev set from the already-published Puzzles page set.

    python3 bench/tools/build_dev_set.py [--per 34,33,33] [--seed 20261031]

Selection (deterministic for a seed):
  * forced mates only (kind == "mate"), N in {1,2,3}; variants standard and
    competitive (competitive changes only the opening, so mid-game rules are
    identical); deathmatch excluded;
  * no puzzle with Rock Slide, Corrupt, Comet or Erupt on the board (see
    EXCLUDE_SPELLS: the Rust enumerator is narrower than the browser rules there);
  * at most one puzzle per source game;
  * quotas per N, spread round-robin over the puzzle's published rating levels;
  * every selected puzzle passes the grader self-test: up to 5 stored first
    turns replay in the browser rules to their stored position (apply.js), and
    bench_grade proves the first one a forced win within N;
  * shortest-mate check: for N = 3, every stored first turn (up to 8) is
    graded with N = 2; a puzzle where one already forces mate in 2 is a
    mislabelled mate-in-2 and is skipped (counted in the report).
    For N = 2 "no mate-in-1" is an exhaustive proof from the generator.
"""
import argparse
import collections
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import CANARY, DEV_SET, REPO  # noqa: E402
from sigilbench.grader import Grader  # noqa: E402

SRC = os.path.join(REPO, 'docs', 'static', 'puzzles', 'mate_puzzles.json')

# Spells whose Rust enumeration is NARROWER than the browser rules (found
# 2026-10-31, bench/prompt/VERIFICATION.md): Rock Slide (only best-net push
# assignments), Corrupt (only the largest conversion set), Comet (never
# sacrifices the stone it just blinked), Erupt (fixed resolution order, not
# yet tested). With one of them on the board a legal answer can be graded
# illegal and a defender's escape can be missed, so the proofs are not
# exhaustive under the real rules. Excluded until the enumerator is widened.
EXCLUDE_SPELLS = {'Rock_Slide', 'Corrupt', 'Comet', 'Erupt'}


def self_test(g, p, n):
    sols = p['solutions']
    for s in sols[:5]:
        r = g.replay(p['sfn'], s['actions'])
        if not r.get('ok') or r['key'] != s['key'] or r['key'] not in p['solution_keys']:
            return False, f"stored solution does not replay: {r}"
    # Full Rust proof of the first stored solution (bypassing the stored-key shortcut).
    r = g.replay(p['sfn'], sols[0]['actions'])
    v = g.rust.ask(f"{n}\t{p['sfn']}\t{r['after']}")
    if v.get('verdict') != 'mate':
        return False, f"bench_grade did not prove the stored solution: {v}"
    return True, v


def faster_mate(g, p):
    for s in p['solutions'][:8]:
        r = g.replay(p['sfn'], s['actions'])
        v = g.rust.ask(f"2\t{p['sfn']}\t{r['after']}")
        if v.get('verdict') == 'mate':
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--per', default='34,33,33')
    ap.add_argument('--seed', type=int, default=20261031)
    ap.add_argument('--out', default=DEV_SET)
    a = ap.parse_args()
    quota = dict(zip((1, 2, 3), (int(x) for x in a.per.split(','))))
    data = json.load(open(SRC))
    rng = random.Random(a.seed)
    pool = [p for p in data['puzzles'] if p['kind'] == 'mate' and p['mate'] in quota
            and p['variant'] in ('standard', 'competitive')
            and not (set(p['sfn'].split()[0].split('/')[1].split(',')) & EXCLUDE_SPELLS)]
    rng.shuffle(pool)
    g = Grader()
    chosen, games = {1: [], 2: [], 3: []}, set()
    log = collections.Counter()
    for n in (1, 2, 3):
        buckets = collections.defaultdict(list)
        for p in pool:
            if p['mate'] == n:
                buckets[p['rating']].append(p)
        levels = sorted(buckets)
        i = 0
        while len(chosen[n]) < quota[n] and any(buckets.values()):
            lvl = levels[i % len(levels)]
            i += 1
            if not buckets[lvl]:
                continue
            p = buckets[lvl].pop()
            if p['game']['id'] in games:
                log['skip: same source game'] += 1
                continue
            ok, why = self_test(g, p, n)
            if not ok:
                log['skip: self-test failed'] += 1
                print('self-test FAIL', p['id'], why, file=sys.stderr)
                continue
            if n == 3 and faster_mate(g, p):
                log['skip: mate-in-3 label but a stored turn mates in 2'] += 1
                continue
            games.add(p['game']['id'])
            chosen[n].append(p)
            print(f"N={n} {len(chosen[n])}/{quota[n]} {p['id']} rating {p['rating']}", file=sys.stderr)
    g.close()
    shortest = {
        1: 'mate in 1 (complete enumeration)',
        2: 'mate in 2; no mate in 1 (exhaustive proof)',
        3: 'mate in 3; no mate in 1 (exhaustive proof); no stored first turn mates in 2, but a mate in 2 is NOT excluded',
    }
    out = []
    for n in (1, 2, 3):
        for p in chosen[n]:
            out.append({
                'source_puzzle_id': p['id'], 'n': n, 'shortest_mate': shortest[n], 'mover': p['mover'],
                'sfn': p['sfn'], 'variant': p['variant'], 'rating': p['rating'], 'tags': p.get('tags', []),
                'solution_keys': p['solution_keys'], 'reference_solution': p['solutions'][0]['actions'],
                'source_game': {k: p['game'].get(k) for k in ('id', 'date')},
            })
    rng.shuffle(out)
    for i, q in enumerate(out, 1):
        q['id'] = f'sbdev-{i:03d}'
    out = [dict([('id', q.pop('id'))] + list(q.items())) for q in out]
    doc = {
        'canary': CANARY,
        'name': 'SigilBench public dev set',
        'description': ('100 forced-mate puzzles drawn from the PUBLISHED Sigil Puzzles page set '
                        '(docs/static/puzzles/mate_puzzles.json). Public: for prompt, parser and harness '
                        'development only; never use it to report a model score. Grading is by proof '
                        '(bench/sigilbench/grader.py), so the stored solution keys need not be complete.'),
        'excluded_spells': sorted(EXCLUDE_SPELLS),
        'seed': a.seed, 'source': 'docs/static/puzzles/mate_puzzles.json', 'source_generated': data.get('generated'),
        'counts': {str(n): len(chosen[n]) for n in (1, 2, 3)},
        'selection_log': dict(log),
        'puzzles': out,
    }
    with open(a.out, 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    print(json.dumps(doc['counts']), dict(log), file=sys.stderr)


if __name__ == '__main__':
    main()
