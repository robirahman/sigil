#!/usr/bin/env python3
"""Final winning-turn verdicts: root-table verdicts plus the playout rule
(SigilBench v3; Robi, 2026-11-08).

    python3 bench/tools/win_select.py verdicts.jsonl playouts.jsonl [--out final.jsonl] \
        [--key-min 0.85] [--alt-max 0.50] [--min-games 6]

A position passes when bench/tools/win_puzzle.py called it a puzzle AND the
Very Hard playouts (bench/tools/win_playouts.py) separate the solution from
everything else: the key idea's played executions win at least --key-min of
their games, and every played alternative (the best execution of each of the
strongest other ideas) wins at most --alt-max. The 2026-11-08 measurement is
why: other ideas the calibrated scale put at P 0.6-0.8 still won 88% of their
playouts, so a P gap alone does not mean the alternatives fail.

A position with no other idea in its deep set has no alternative to play;
it passes on the keys alone and is marked alt_untested.
"""
import argparse
import json
from collections import defaultdict


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('verdicts')
    ap.add_argument('playouts')
    ap.add_argument('--out')
    ap.add_argument('--key-min', type=float, default=0.85)
    ap.add_argument('--alt-max', type=float, default=0.50)
    ap.add_argument('--min-games', type=int, default=6)
    a = ap.parse_args()
    games = defaultdict(list)
    for line in open(a.playouts):
        g = json.loads(line)
        games[(g['id'], g['after'])].append(g)
    outs = []
    for line in open(a.verdicts):
        v = json.loads(line)
        res = {'id': v['id'], 'table_verdict': v['verdict'], 'ideas': v.get('ideas'),
               'execution_matters': v.get('execution_matters'), 'idea_gap': v.get('idea_gap')}
        rates = {'key': [], 'alt': []}
        n_games = {'key': 0, 'alt': 0}
        for c in v.get('playout') or []:
            gs = [g for g in games.get((v['id'], c['after']), []) if g['winner'] is not None]
            if not gs:
                continue
            w = sum(1 for g in gs if g['winner'] == g['mover']) / len(gs)
            rates[c['role']].append({'idea': c.get('idea'), 'p': c.get('p'), 'win_rate': round(w, 3), 'games': len(gs)})
            n_games[c['role']] += len(gs)
        res['playouts'] = rates
        kr = [x['win_rate'] for x in rates['key']]
        ar = [x['win_rate'] for x in rates['alt']]
        res['key_win_rate'] = round(min(kr), 3) if kr else None
        res['best_alt_win_rate'] = round(max(ar), 3) if ar else None
        if v['verdict'] != 'puzzle':
            res['verdict'] = 'table: ' + v['verdict']
        elif not kr or min(x['games'] for x in rates['key']) < a.min_games:
            res['verdict'] = 'playouts missing'
        elif min(kr) < a.key_min:
            res['verdict'] = 'key does not convert'
        elif ar and max(ar) > a.alt_max:
            res['verdict'] = 'an alternative also wins'
        else:
            res['verdict'] = 'puzzle'
            res['alt_untested'] = not ar
        outs.append(res)
        print(json.dumps({k: res[k] for k in ('id', 'verdict', 'key_win_rate', 'best_alt_win_rate', 'ideas')}))
    from collections import Counter
    print('final', dict(Counter(o['verdict'] for o in outs)))
    if a.out:
        with open(a.out, 'w') as f:
            for o in outs:
                f.write(json.dumps(o) + '\n')


if __name__ == '__main__':
    main()
