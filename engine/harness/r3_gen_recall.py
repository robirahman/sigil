"""Round 3: policy-stream recall of recorded replies under exploration-tail settings.

    python engine/harness/r3_gen_recall.py --explore off --explore 3,32,64,4,32,256,16 ...
        [--cases ai/data/benchmarks/guest_2026-10_cases.json] [--cases ...surprise_cases.json]
        [--widths 96,192,480] [--cap 2000] [--workers 7]

`--explore` is `off` or the arguments of `se.set_policy_explore` (mode, cast_window,
dash_limit, dash_per, dash_tried, base, step). For each setting: the share of replies the
policy stream (search budgets: window 16, keep 2, the compiled weights) emits within each
width, split by reply kind (cast / dash / dash+cast / move-only), and the stream's cost to
produce its first w turns (µs per call, internal expansions), on the same positions.
"""
import argparse
import json
import os
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
_se = None


def _init(ex):
    global _se
    import sigil_engine as se
    _se = se
    se.set_policy(*se.SHIPPED_POLICY)
    if ex != 'off':
        se.set_policy_explore(*[int(x) for x in ex.split(',')])


def job(item):
    sfn, after, cap, widths = item
    try:
        r, gen, exp = _se.policy_rank_of_result(sfn, after, cap)
    except Exception:  # noqa: BLE001
        r = -1
    cost = {}
    for w in widths:
        t = time.perf_counter()
        n = 0
        while time.perf_counter() - t < 0.02 or n < 3:
            _, g, e = _se.policy_rank_of_result(sfn, '-', w)
            n += 1
        cost[w] = ((time.perf_counter() - t) / n * 1e6, e)
    return r, cost


def kind_of(c):
    k = c.get('kind') or 'unknown'
    return k


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cases', action='append', default=[])
    ap.add_argument('--explore', action='append', default=[])
    ap.add_argument('--widths', default='96,192,480')
    ap.add_argument('--cap', type=int, default=2000)
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--json')
    a = ap.parse_args()
    widths = [int(x) for x in a.widths.split(',')]
    files = a.cases or [os.path.join(ROOT, 'ai', 'data', 'benchmarks', 'guest_2026-10_cases.json')]
    cases = []
    for f in files:
        cases += [dict(c, _src=os.path.basename(f)) for c in json.load(open(f, encoding='utf-8')) if c.get('sfn_after')]
    out = {}
    for ex in a.explore or ['off']:
        with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(ex,)) as pool:
            res = list(pool.map(job, [(c['sfn'], c['sfn_after'], a.cap, widths) for c in cases], chunksize=1))
        by = defaultdict(list)
        for c, (r, _) in zip(cases, res):
            by[kind_of(c)].append(r)
            by['ALL'].append(r)
        line = []
        for k in sorted(by):
            rs = by[k]
            line.append(f"{k}(n={len(rs)}) " + '/'.join(f"{sum(0 <= r < w for r in rs)}" for w in widths))
        cost = {w: (sum(x[1][w][0] for x in res) / len(res), sum(x[1][w][1] for x in res) / len(res)) for w in widths}
        print(f"[{ex}] within {widths}: " + '  '.join(line))
        print(f"[{ex}] cost us/exp per call: " + '  '.join(f"w{w}: {cost[w][0]:.0f}us/{cost[w][1]:.0f}" for w in widths), flush=True)
        out[ex] = {'ranks': [r for r, _ in res], 'cost': cost,
                   'cases': [(c['_src'], c.get('g'), c.get('i'), kind_of(c), c.get('target')) for c in cases]}
    if a.json:
        json.dump(out, open(a.json, 'w', encoding='utf-8'))


if __name__ == '__main__':
    main()
