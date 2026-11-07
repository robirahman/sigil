#!/usr/bin/env python3
"""Per-puzzle shortest-mate record for a dev set (SigilBench v3 label policy).

    python3 bench/tools/build_shortest.py bench/dev/dev_set_v2.json within_a.jsonl [within_b.jsonl ...] \
        --out bench/dev/dev_set_v2_shortest.json

Inputs are `cert_tool within` results ({"id", "k", "result"}): "none" proves
there is no forced win within k, "mate" proves there is one, anything else
(budget, incomplete) proves nothing. A definitive result for (puzzle, k) wins
over an inconclusive one, whichever file it is in.

The label policy (Robi, 2026-11-03): a puzzle keeps its stated N, which is
what the prompt says and what answers are graded against (a faster mate is
always correct). Its CATEGORY, used for per-N reporting, is the shortest mate
the proofs establish:
  * no mate in 1 is always proven (the solver enumerates the root);
  * a proven win within k < N moves the puzzle to the shortest such k still
    consistent with the proofs (exactly k when "none within k-1" is proven or
    k = 2);
  * otherwise the category is N, and `not_excluded` lists the shorter wins no
    proof has ruled out (for N >= 4, "within N-1" may stay open: the
    exhaustive search often does not finish).
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import CANARY  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('dev_set')
    ap.add_argument('within', nargs='+')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    ps = json.load(open(a.dev_set))['puzzles']
    res = {}   # (id, k) -> 'none' | 'mate'
    for f in a.within:
        for line in open(f):
            r = json.loads(line)
            if r.get('result') in ('none', 'mate'):
                key = (r['id'], int(r['k']))
                if key in res and res[key] != r['result']:
                    sys.exit(f'contradictory proofs for {key}')
                res[key] = r['result']
    # Proofs are monotone: a win within k is a win within every larger k, so a
    # "mate" at some k and a "none" at any k' >= k cannot both hold.
    by_id = {}
    for (pid, k), v in res.items():
        by_id.setdefault(pid, {})[k] = v
    for pid, d in by_id.items():
        mates = [k for k, v in d.items() if v == 'mate']
        nones = [k for k, v in d.items() if v == 'none']
        if mates and nones and min(mates) <= max(nones):
            sys.exit(f'contradictory proofs for {pid}: a win within {min(mates)} and none within {max(nones)}')
    out = {}
    for p in ps:
        n = p['n']
        # Proven absent / present wins, for k = 1 .. n-1. No mate in 1 is part of
        # every N >= 2 puzzle's construction (exhaustive root enumeration).
        none = {1} if n >= 2 else set()
        mate = set()
        for k in range(2, n):
            v = res.get((p['id'], k))
            if v == 'none':
                none.update(range(1, k + 1))       # no win within k: none within any smaller k
            elif v == 'mate':
                mate.update(range(k, n))           # a win within k is a win within every larger k
        if mate:
            k = min(mate)
            exact = (k - 1) in none
            cat = k
            note = (f'mate in {k} (a forced win within {k} is proven, none within {k - 1})' if exact
                    else f'a forced win within {k} is proven; none within {max(none)} -- category {k} is an upper bound')
        else:
            cat = n
            note = f'mate in {n}' if n == 1 else f'mate in {n}; no forced win within {max(none)} (proven)'
        not_excluded = [k for k in range(1, cat) if k not in none]
        if not_excluded and not mate:
            note += '; a forced win within ' + ', '.join(map(str, not_excluded)) + ' is NOT excluded'
        out[p['id']] = {'n': n, 'category': cat, 'exact': (cat - 1) in none or cat == 1,
                        'excluded_within': sorted(none), 'not_excluded_within': not_excluded, 'note': note}
    doc = {'canary': CANARY, 'dev_set': os.path.basename(a.dev_set),
           'description': 'Shortest-mate record per puzzle (bench/tools/build_shortest.py). '
                          '"n" is the stated N (prompt and grading); "category" is the proven shortest mate, '
                          'used for per-N reporting.',
           'recategorized': sorted(pid for pid, v in out.items() if v['category'] != v['n']),
           'puzzles': out}
    with open(a.out, 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    from collections import Counter
    print('categories', dict(sorted(Counter(v['category'] for v in out.values()).items())),
          'recategorized', doc['recategorized'],
          'exact', sum(1 for v in out.values() if v['exact']), 'of', len(out))


if __name__ == '__main__':
    main()
