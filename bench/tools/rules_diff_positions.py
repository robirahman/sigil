#!/usr/bin/env python3
"""Positions for the rules differential test (tools/rules-diff.py), CHECKLIST §1.

Collects every puzzle root and every stored line position (after a solution
turn, after a defence, ...) from the published Puzzles set and the dev sets,
deduplicates them, measures each one's Rust turn count with
engine/examples/rules_children, and writes a sample stratified so every spell
on the boards, every variant and the special mechanics are covered:

    python3 bench/tools/rules_diff_positions.py --rust <target>/release/examples/rules_children \
        --out positions.txt [--n 3000] [--max-turns 20000] [--seed 20261103] [--jobs 4]

Each spell gets up to n / 45 positions where it is on the board (fewest
children first within a random shuffle, so the JS walk stays affordable);
the rest are drawn uniformly. The output is one SFN per line; a sidecar
<out>.meta.json records the child counts and spells.
"""
import argparse
import json
import os
import random
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import BENCH  # noqa: E402

REPO = os.path.dirname(BENCH)
SOURCES = [
    os.path.join(REPO, 'docs', 'static', 'puzzles', 'mate_puzzles.json'),
    os.path.join(BENCH, 'dev', 'dev_set.json'),
    os.path.join(BENCH, 'dev', 'dev_set_v2.json'),
    os.path.join(BENCH, 'dev', 'dev_set_v2_lines.json'),
]


def walk(node, out):
    if isinstance(node, dict):
        for k, v in node.items():
            if k in ('sfn', 'after') and isinstance(v, str) and '/' in v and len(v.split()) >= 6:
                out.add(v.strip())
            else:
                walk(v, out)
    elif isinstance(node, list):
        for v in node:
            walk(v, out)


def spells_of(sfn):
    return sfn.split()[0].split('/')[1].split(',')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--rust', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--n', type=int, default=3000)
    ap.add_argument('--max-turns', type=int, default=20000)
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 1)
    ap.add_argument('--seed', type=int, default=20261103)
    a = ap.parse_args()
    pos = set()
    for src in SOURCES:
        if os.path.exists(src):
            walk(json.load(open(src)), pos)
    pos = sorted(pos)
    print(f'{len(pos)} distinct positions', file=sys.stderr)
    env = dict(os.environ, RULES_CHILDREN_COUNT='1')
    chunks = [pos[i::a.jobs] for i in range(a.jobs)]
    procs = [subprocess.Popen([a.rust], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
             for _ in chunks]
    outs = [p.communicate('\n'.join(ch) + '\n')[0] for p, ch in zip(procs, chunks)]
    count = {}
    for line in ''.join(outs).splitlines():
        r = json.loads(line)
        if 'error' in r or r.get('truncated'):
            continue
        n = r['turns']
        # A finished game (no turn to play) is not a useful sample. Turns, not
        # distinct children (~1/3 as many), keep this pass cheap.
        if 0 < n <= a.max_turns:
            count[r['sfn']] = n
    print(f'{len(count)} within {a.max_turns} turns', file=sys.stderr)
    rng = random.Random(a.seed)
    cand = list(count)
    rng.shuffle(cand)
    per = max(1, a.n // 45)
    chosen = []
    taken = set()
    by_spell = {}
    for s in cand:
        for sp in spells_of(s):
            by_spell.setdefault(sp, []).append(s)
    for sp in sorted(by_spell):
        for s in by_spell[sp][:per]:
            if s not in taken and len(chosen) < a.n:
                taken.add(s)
                chosen.append(s)
    for s in cand:
        if len(chosen) >= a.n:
            break
        if s not in taken:
            taken.add(s)
            chosen.append(s)
    with open(a.out, 'w') as f:
        f.write('\n'.join(chosen) + '\n')
    meta = {'n': len(chosen), 'seed': a.seed, 'max_turns': a.max_turns,
            'turns_total': sum(count[s] for s in chosen),
            'spell_coverage': {sp: sum(1 for s in chosen if sp in spells_of(s)) for sp in sorted(by_spell)}}
    json.dump(meta, open(a.out + '.meta.json', 'w'), indent=1)
    print(json.dumps({k: meta[k] for k in ('n', 'turns_total')}), file=sys.stderr)


if __name__ == '__main__':
    main()
