#!/usr/bin/env python3
"""Add puzzles from a second generator run to a published set.

    merge_puzzle_sets.py --base docs/static/puzzles/mate_puzzles.json \\
        --add selfplay_candidates.json --ids keep.txt --meta-work meta.jsonl \\
        --out docs/static/puzzles/mate_puzzles.json

The base set keeps every puzzle; from --add only the ids listed in --ids are
taken (positions already in the base set are skipped). Difficulty is then
re-binned over the union (gen_mate_puzzles.difficulty_bins: quintiles per class
of the shallowest depth at which the shipped search finds a solution, then the
solution's stream rank), with the searches cached in --meta-work, and the set
is re-sorted and re-indexed. The header records where the additions came from.
"""
import argparse, json, os, sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_mate_puzzles as G


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--base', required=True)
    ap.add_argument('--add', required=True)
    ap.add_argument('--ids', required=True, help='puzzle ids to take from --add, one per line')
    ap.add_argument('--meta-work', required=True)
    ap.add_argument('--note', default='', help='a line for the header about the additions')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    with open(args.base, encoding='utf-8') as fh:
        base = json.load(fh)
    with open(args.add, encoding='utf-8') as fh:
        add = json.load(fh)
    with open(args.ids, encoding='utf-8') as fh:
        want = {ln.strip() for ln in fh if ln.strip()}
    have = {(G.sfn_key(p['sfn']), p['sfn'].split()[1]) for p in base['puzzles']}
    added = []
    for p in add['puzzles']:
        pk = (G.sfn_key(p['sfn']), p['sfn'].split()[1])
        if p['id'] in want and pk not in have:
            have.add(pk)
            added.append(p)
    puzzles = base['puzzles'] + added
    meta = G.load_work([args.meta_work])
    todo = [(p['id'], p['sfn'], set(p['solution_keys']),
             next((x['after'] for x in p['solutions'] if x.get('actions')), None))
            for p in puzzles if p['id'] not in meta]
    if todo:
        print(f'difficulty searches: {len(todo)} puzzles', flush=True)
        G.run_pool(G._meta_one, todo, args.meta_work, args.workers, 'meta')
        meta = G.load_work([args.meta_work])
    G.difficulty_bins(puzzles, meta)
    for p in puzzles:
        p['tags'] = G.puzzle_tags(p)
        p['found_depth'] = (meta.get(p['id']) or {}).get('found_depth')
    puzzles.sort(key=lambda p: (p['mate'] or 9, p['difficulty'], p['id']))
    for i, p in enumerate(puzzles):
        p['index'] = i
    out = dict(base)
    out['puzzles'] = puzzles
    out['count'] = len(puzzles)
    out['merged'] = {'at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                     'base_count': len(base['puzzles']), 'added': len(added), 'from': add.get('generated'),
                     'note': args.note}
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, separators=(',', ':'))
    print(f'{len(base["puzzles"])} + {len(added)} = {len(puzzles)} puzzles -> {args.out} '
          f'({os.path.getsize(args.out)} bytes)')


if __name__ == '__main__':
    main()
