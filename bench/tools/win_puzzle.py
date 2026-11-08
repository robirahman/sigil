#!/usr/bin/env python3
"""Winning-turn puzzle verdicts from two-stage root tables (SigilBench v3).

    python3 bench/tools/win_puzzle.py tables.jsonl [--out verdicts.jsonl] [thresholds...]

Input: engine/examples/win_table2 output, one JSON line per position, with
"id" (and, for published puzzles, "solution_keys") added by the caller.

For every deep-searched child, the shipped net's score at each deep depth is
turned into P(mover wins) with the PR #28 calibration
(docs/static/data/position-winprob.json; depths 4-6; a proven mate is 0 or 1),
the same conversion tools/winning_turns.py and the site use. At the deepest
depth every child reached (D):

  * the keys are the children with P >= --win-p and within --band of the best;
  * a PUZZLE needs, at once:
      - 1 to --max-keys keys;
      - every other deep child at least --gap below the weakest key;
      - the same key set at every deep depth (depth stability);
      - the other evaluators agree: under each, the best child is a key and
        the best key leads the best non-key by at least --stone-gap stones;
      - the screen's random sample holds: no sampled child (ranked low by the
        depth-2 screen) comes within --gap of the keys at the first deep depth.
  * otherwise the verdict names the first failed rule.

Every rule's measurement is kept, so the thresholds can be tuned on a sample
before mining (V3_PLAN phase 0). The verdict is engine-judged, never a proof;
the playouts (bench/tools/win_playouts.py) and expert review follow.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'tools'))
import winning_turns as WT  # noqa: E402

SHIPPED = 'nnue_mt256'


def mover_of(sfn):
    return 'red' if sfn.split()[1] == 'r' else 'blue'


def p_of(child, mover, ev, depth):
    """Calibrated P(mover wins) for one child's search result, or None."""
    if child.get('over'):
        return None
    e = ((child.get('evals') or {}).get(SHIPPED) or {}).get(str(depth))
    if not e:
        return None
    sign = 1 if mover == 'red' else -1
    pr = WT.red_win_prob(child['after'], e['depth'], e['stones'] * sign,
                         None if not e.get('mate') else e['mate'] * sign, bool(e.get('proven')))
    if pr is None:
        return None
    return pr if mover == 'red' else 1 - pr


def stones_of(child, ev, depth):
    e = ((child.get('evals') or {}).get(ev) or {}).get(str(depth))
    if not e:
        return None
    if e.get('mate'):
        return 99.0 if e['mate'] > 0 else -99.0
    return e['stones']


def judge(r, a):
    mover = mover_of(r['sfn'])
    out = {'id': r.get('id'), 'sfn': r['sfn'], 'children': r['children'], 'deep_count': r['deep_count'],
           'seconds': r['seconds']}
    deep = [c for c in r['deep'] if not c.get('sample') and not c.get('over')]
    sample = [c for c in r['deep'] if c.get('sample')]
    wins_now = [c for c in r['deep'] if c.get('over') and c.get('screen', 0) > 0]
    if wins_now:
        out['verdict'] = 'mate in 1'
        return out
    depths = sorted({int(d) for c in deep for d in ((c.get('evals') or {}).get(SHIPPED) or {})})
    if not depths:
        out['verdict'] = 'no deep results'
        return out
    # Deepest depth every deep child completed.
    D = max(d for d in depths if all(p_of(c, mover, SHIPPED, d) is not None for c in deep)) \
        if any(all(p_of(c, mover, SHIPPED, d) is not None for c in deep) for d in depths) else None
    if D is None:
        out['verdict'] = 'deep searches incomplete'
        return out
    out['depth'] = D

    def keys_at(d):
        ps = {c['after']: p_of(c, mover, SHIPPED, d) for c in deep}
        ps = {k: v for k, v in ps.items() if v is not None}
        best = max(ps.values())
        keys = sorted(k for k, v in ps.items() if v >= a.win_p and v >= best - a.band)
        return keys, ps, best
    keys, ps, best = keys_at(D)
    out['p_best'] = round(best, 4)
    out['keys'] = [WT.key_of(k) for k in keys]
    out['n_keys'] = len(keys)
    others = [v for k, v in ps.items() if k not in keys]
    out['p_second'] = round(max(others), 4) if others else None
    if keys:
        out['gap'] = round(min(ps[k] for k in keys) - (max(others) if others else 0.0), 4)
    # Depth stability.
    stable = {}
    for d in depths:
        if d > D:
            continue
        kd, _, _ = keys_at(d)
        stable[str(d)] = (kd == keys)
    out['stable'] = stable
    # Other evaluators (stones; no calibration).
    agree = {}
    for ev in sorted({e for c in deep for e in (c.get('evals') or {})} - {SHIPPED}):
        sc = {c['after']: stones_of(c, ev, D) for c in deep}
        sc = {k: v for k, v in sc.items() if v is not None}
        if not sc or not keys:
            continue
        top = max(sc, key=sc.get)
        kmax = max((sc[k] for k in keys if k in sc), default=None)
        omax = max((v for k, v in sc.items() if k not in keys), default=None)
        agree[ev] = {'top_is_key': top in keys,
                     'stone_gap': None if kmax is None or omax is None else round(kmax - omax, 3)}
    out['agree'] = agree
    # The screen's sample at the first deep depth.
    d0 = depths[0]
    if keys and sample:
        kmin0 = min((p_of(c, mover, SHIPPED, d0) for c in deep if c['after'] in keys), default=None)
        sp = [p_of(c, mover, SHIPPED, d0) for c in sample]
        sp = [v for v in sp if v is not None]
        out['sample_max_p'] = round(max(sp), 4) if sp else None
        out['sample_ok'] = (kmin0 is None) or all(v <= kmin0 - a.gap for v in sp)
    if r.get('solution_keys'):
        pub = set(r['solution_keys'])
        out['published_in_keys'] = bool(pub & set(out['keys']))
        out['published_is_keys'] = set(out['keys']) <= pub and bool(out['keys'])

    # Verdict: the first failed rule.
    if best < a.win_p:
        v = 'not winning'
    elif not keys or len(keys) > a.max_keys:
        v = 'too many keys'
    elif out.get('gap') is not None and out['gap'] < a.gap:
        v = 'no gap'
    elif not all(stable.values()):
        v = 'unstable across depths'
    elif any(not x['top_is_key'] or (x['stone_gap'] is not None and x['stone_gap'] < a.stone_gap) for x in agree.values()):
        v = 'evaluators disagree'
    elif out.get('sample_ok') is False:
        v = 'screen sample missed a contender'
    else:
        v = 'puzzle'
    out['verdict'] = v
    # The playout set: the keys and the best alternatives.
    alts = sorted((k for k in ps if k not in keys), key=lambda k: -ps[k])[:a.alts]
    out['playout'] = [{'after': k, 'role': 'key', 'p': round(ps[k], 4)} for k in keys] + \
                     [{'after': k, 'role': 'alt', 'p': round(ps[k], 4)} for k in alts]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('tables')
    ap.add_argument('--out')
    ap.add_argument('--win-p', type=float, default=0.80)
    ap.add_argument('--gap', type=float, default=0.30)
    ap.add_argument('--band', type=float, default=0.05)
    ap.add_argument('--max-keys', type=int, default=3)
    ap.add_argument('--stone-gap', type=float, default=0.75)
    ap.add_argument('--alts', type=int, default=3)
    a = ap.parse_args()
    outs = []
    for line in open(a.tables):
        r = json.loads(line)
        if not r.get('deep'):
            continue
        outs.append(judge(r, a))
    from collections import Counter
    for o in outs:
        print(json.dumps({k: v for k, v in o.items() if k not in ('playout', 'sfn', 'keys')}))
    print('verdicts', dict(Counter(o['verdict'] for o in outs)))
    if a.out:
        with open(a.out, 'w') as f:
            for o in outs:
                f.write(json.dumps(o) + '\n')


if __name__ == '__main__':
    main()
