#!/usr/bin/env python3
"""Engine difficulty ladder for SigilBench v3 candidates (V3_PLAN "harder positions").

    python3 bench/tools/ladder_v3.py items.json --out ladder.jsonl [--workers N]
        [--depths 1,2,3,4,5,6] [--times 1000,10000]

items.json: {"items": [{"id", "kind": "mate"|"win", "sfn", "n", "keys": [answer sfn_keys]}]}.
Each puzzle is searched by the shipped engine (sigil_engine.analyze, shipped
eval and policy) at every fixed depth in --depths and for every time budget in
--times (ms, no depth limit: the Very Hard tier's setting is 10 s). A rung is
SOLVED when the engine's chosen turn reaches an answer key, or, for a mate
puzzle, when its own search proves a mate within N for that turn. The record
keeps every rung; `difficulty` = how many rungs failed (0 = every rung solved,
len(depths) + len(times) = none), and `first_solved` = the first rung that
solved it. Results are written as they finish; a rerun skips finished ids.
Needs the Python binding.
"""
import argparse
import concurrent.futures as cf
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))


def skey(sfn):
    t = sfn.split()
    pm = [x for x in t[6:] if x.startswith('pm:')]
    return ' '.join([t[0].split('/')[0]] + t[3:6] + pm)


def one(job):
    x, depths, times = job
    import sigil_engine as se
    if hasattr(se, 'SHIPPED_POLICY'):
        se.set_policy(*se.SHIPPED_POLICY)
    if hasattr(se, 'SHIPPED_EXPLORE'):
        se.set_policy_explore(*se.SHIPPED_EXPLORE)
    se.set_full_rules(True)
    ev = se.SHIPPED_EVAL
    keys = set(x.get('keys') or [])
    rungs = []
    for kind, val in [('depth', d) for d in depths] + [('ms', t) for t in times]:
        try:
            if kind == 'depth':
                a = se.analyze(x['sfn'], ev, max_depth=val, time_ms=0)
            else:
                a = se.analyze(x['sfn'], ev, max_depth=64, time_ms=val)
        except Exception as e:  # noqa: BLE001
            rungs.append({'rung': f'{kind}{val}', 'error': str(e)[:200]})
            continue
        after = a.get('expected_sfn')
        hit = bool(after) and skey(after) in keys
        mate = a.get('mate_in_turns')
        proved = (x['kind'] == 'mate' and mate is not None and 0 < mate <= x['n'] and bool(a.get('proven')))
        rungs.append({'rung': f'{kind}{val}', 'solved': hit or proved, 'key_hit': hit, 'mate': mate,
                      'proven': a.get('proven'), 'depth': a.get('depth'), 'stones': a.get('stones'),
                      'seconds': round(a.get('seconds') or 0, 2)})
    failed = sum(1 for r in rungs if not r.get('solved'))
    first = next((r['rung'] for r in rungs if r.get('solved')), None)
    return {'id': x['id'], 'kind': x['kind'], 'n': x['n'], 'rungs': rungs, 'difficulty': failed, 'first_solved': first}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('items')
    ap.add_argument('--out', required=True)
    ap.add_argument('--workers', type=int, default=os.cpu_count() or 1)
    ap.add_argument('--depths', default='1,2,3,4,5,6')
    ap.add_argument('--times', default='1000,10000')
    a = ap.parse_args()
    items = json.load(open(a.items))['items']
    depths = [int(x) for x in a.depths.split(',') if x]
    times = [int(x) for x in a.times.split(',') if x]
    done = set()
    if os.path.exists(a.out):
        done = {json.loads(l)['id'] for l in open(a.out) if l.strip()}
    todo = [x for x in items if x['id'] not in done]
    print(f'{len(items)} items, {len(todo)} to do', flush=True)
    import multiprocessing as mp
    with cf.ProcessPoolExecutor(a.workers, mp_context=mp.get_context('spawn')) as ex, open(a.out, 'a') as f:
        futs = [ex.submit(one, (x, depths, times)) for x in todo]
        for fu in cf.as_completed(futs):
            r = fu.result()
            f.write(json.dumps(r) + '\n')
            f.flush()
            print(r['id'], r['difficulty'], r['first_solved'], flush=True)


if __name__ == '__main__':
    main()
