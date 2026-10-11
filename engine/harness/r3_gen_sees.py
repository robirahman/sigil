"""Round 3: fixed-DEPTH sees-rate on a surprise suite, v27 vs exploration-tail settings.

    python engine/harness/r3_gen_sees.py --depths 4,5,6 --explore off --explore 3,64,128,8,48,256,8
        [--cases ai/data/benchmarks/guest_2026-10_cases.json] [--workers 7] [--json out.json]

The surprise audit's question ("does a depth-d search from the position before the human's reply
already value it within 0.5 stones of the depth-6 target?") at d = 4 / 5 / 6, with the shipped
engine (SHIPPED_EVAL, SHIPPED_POLICY, SHIPPED_ADAPTIVE, width scale 4) and the round 3 tail
(`set_policy_explore`). Reports the rate, by reply kind, and the summed nodes per depth (fixed-depth
node cost on these positions).
"""
import argparse
import json
import os
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MATE_V, TOL = 20.0, 0.5
_se = None


def _init(ex):
    global _se
    import sigil_engine as se
    _se = se
    se.set_policy(*se.SHIPPED_POLICY)
    se.set_policy_explore(*([int(x) for x in ex.split(',')] if ex != 'off' else [0]))


def _value(r, pov):
    if r.get('over'):
        w = r.get('winner')
        return 0.0 if w is None else (MATE_V if w == pov else -MATE_V)
    if r.get('mate_in_turns'):
        v = MATE_V if r['mate_in_turns'] > 0 else -MATE_V
    elif r.get('stones') is None:
        return None
    else:
        v = max(-MATE_V, min(MATE_V, r['stones']))
    return v if r['mover'] == pov else -v


def job(item):
    case, d = item
    r = _se.analyze(case['sfn'], _se.SHIPPED_EVAL, max_depth=d, time_ms=0, history_sfns=case.get('history') or [],
                    width_scale=_se.DEFAULT_WIDTH_SCALE, adaptive=tuple(_se.SHIPPED_ADAPTIVE))
    v = _value(r, case['ai'])
    return {'sees': v is not None and v <= case['target'] + TOL, 'v': v, 'nodes': r.get('nodes'), 'depth': r.get('depth')}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cases', default=os.path.join(ROOT, 'ai', 'data', 'benchmarks', 'guest_2026-10_cases.json'))
    ap.add_argument('--explore', action='append', default=[])
    ap.add_argument('--depths', default='4,5,6')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--json')
    a = ap.parse_args()
    cases = json.load(open(a.cases, encoding='utf-8'))
    depths = [int(x) for x in a.depths.split(',')]
    out = {}
    for ex in a.explore or ['off']:
        out[ex] = {}
        with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(ex,)) as pool:
            for d in depths:
                rs = list(pool.map(job, [(c, d) for c in cases], chunksize=1))
                by = defaultdict(lambda: [0, 0])
                for c, r in zip(cases, rs):
                    for k in (c.get('kind', '?'), 'ALL', 'MATE' if c['target'] <= -MATE_V + 1e-6 else 'non-mate'):
                        by[k][0] += r['sees']; by[k][1] += 1
                nodes = sum(r['nodes'] or 0 for r in rs)
                print(f"[{ex}] d{d}: " + '  '.join(f"{k} {s}/{n}" for k, (s, n) in sorted(by.items()))
                      + f"  nodes {nodes}", flush=True)
                out[ex][d] = {'sees': [r['sees'] for r in rs], 'v': [r['v'] for r in rs], 'nodes': nodes}
    if a.json:
        json.dump(out, open(a.json, 'w', encoding='utf-8'))


if __name__ == '__main__':
    main()
