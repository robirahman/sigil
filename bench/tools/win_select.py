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

Near misses (Robi, 2026-11-18, option (a)): a position the table rejected
only because the key idea's lead was short -- verdict "no gap" with a single
winning idea and an idea gap of at least --near-gap, or "unstable across
depths" with a single winning idea -- is admitted when the playouts separate
it on stronger evidence than a table puzzle needs: at least --near-games
games per played turn, the key's executions winning at least --key-min, and
every played alternative winning at most --near-alt-max. A near miss that
passes the ordinary rule on fewer games is marked "near miss: confirm" (play
it to --near-games with win_playouts.py --ids, then run this again).
Admitted positions carry admission = "playouts"; table puzzles "table".
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
    ap.add_argument('--near-gap', type=float, default=0.10)
    ap.add_argument('--near-games', type=int, default=12)
    ap.add_argument('--near-alt-max', type=float, default=1 / 3)
    ap.add_argument('--confirm-out', help='write the ids marked "near miss: confirm" here, one per line')
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
        kg = min((x['games'] for x in rates['key']), default=0)
        ag = min((x['games'] for x in rates['alt']), default=0)
        if v['verdict'] != 'puzzle':
            res['verdict'] = 'table: ' + v['verdict']
            if near_miss(v, a.near_gap) and kr and ar:
                if kg >= a.near_games and ag >= a.near_games and min(kr) >= a.key_min and max(ar) <= a.near_alt_max:
                    res['verdict'] = 'puzzle'
                    res['admission'] = 'playouts'
                    res['alt_untested'] = False
                elif kg < a.near_games and kg >= a.min_games and min(kr) >= a.key_min and max(ar) <= a.alt_max:
                    res['verdict'] = 'near miss: confirm'
        elif not kr or kg < a.min_games:
            res['verdict'] = 'playouts missing'
        elif min(kr) < a.key_min:
            res['verdict'] = 'key does not convert'
        elif ar and max(ar) > a.alt_max:
            res['verdict'] = 'an alternative also wins'
        else:
            res['verdict'] = 'puzzle'
            res['admission'] = 'table'
            res['alt_untested'] = not ar
        outs.append(res)
        print(json.dumps({k: res[k] for k in ('id', 'verdict', 'key_win_rate', 'best_alt_win_rate', 'ideas')}))
    from collections import Counter
    print('final', dict(Counter(o['verdict'] for o in outs)))
    if a.out:
        with open(a.out, 'w') as f:
            for o in outs:
                f.write(json.dumps(o) + '\n')
    if a.confirm_out:
        with open(a.confirm_out, 'w') as f:
            for o in outs:
                if o['verdict'] == 'near miss: confirm':
                    f.write(o['id'] + '\n')


def near_miss(v, near_gap):
    """A table rejection that only says the key idea's lead was short."""
    if v.get('n_ideas') != 1:
        return False
    if v['verdict'] == 'no gap':
        return (v.get('idea_gap') or 0) >= near_gap
    return v['verdict'] == 'unstable across depths'


if __name__ == '__main__':
    main()
