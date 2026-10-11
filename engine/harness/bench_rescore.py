"""Re-score the frozen surprise suite's targets with the SHIPPED engine (2026-10 round 2).

    python engine/harness/bench_rescore.py [--suites ai/data/benchmarks] [--workers N]
        [--time-ms 300000] --out-all rescore.json --out-suite surprise_cases_v25.json

`surprise_cases.json` carries targets scored by the engines of its source runs (the
September `tfit` engine for 284 cases, v23 for 33). A sees-rate against those targets is
unfair to an eval change: a different eval can land within 0.5 stones of an old-eval
number, or miss it, for reasons that say nothing about seeing the reply. This scores
every case again with the engine as it ships (`se.SHIPPED_EVAL`, the generator policy
`se.SHIPPED_POLICY` set explicitly -- it is thread-local and off by default in Python,
`DEFAULT_WIDTH_SCALE`, `SHIPPED_ADAPTIVE`), the definitions of `surprise_audit.py`:

  target_new = depth-6 value of the after-position (`sfn_after`, history + [sfn]),
               from the AI's side, mates clamped to +/-MATE_V
  v4_i_new   = depth-4 value of the position before the reply (history), AI's side
  confirmed  = v4_i_new - target_new > --threshold (1.0): the reply is a surprise the
               shipped engine also confirms

`--out-all` keeps every case with both scorings. `--out-suite` is the new frozen suite:
EVERY case with a new target, `target` replaced by it and the old one kept as `target_old`
/ `v4_i_old`, plus `confirmed_v25`, so `bench_suites.py --surprise-file` scores it
unchanged. The suite is not cut to the confirmed cases on purpose: `confirmed` uses the
shipped engine's OWN depth-4 value, so the confirmed subset is by construction the cases
that engine misses at depth 4, and a sees-rate over it would be biased against it. The
case selection stays the original (older-engine) flags; only the targets change.
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from bench_suites import _value  # noqa: E402  (same clamping and POV rules)

_se = None
_tms = 0


def _init(time_ms):
    global _se, _tms
    import sigil_engine
    _se = sigil_engine
    _tms = time_ms
    on, w = _se.SHIPPED_POLICY
    _se.set_policy(bool(on), int(w))


def _analyze(sfn, hist, depth):
    return _se.analyze(sfn, _se.SHIPPED_EVAL, max_depth=depth, time_ms=_tms, tt_bits=20,
                       history_sfns=hist, width_scale=_se.DEFAULT_WIDTH_SCALE,
                       adaptive=tuple(_se.SHIPPED_ADAPTIVE))


def job(case):
    t = time.time()
    hist = list(case.get('history') or [])
    r6 = _analyze(case['sfn_after'], hist + [case['sfn']], 6)
    r4 = _analyze(case['sfn'], hist, 4)
    return {'target_new': _value(r6, case['ai']), 'v4_i_new': _value(r4, case['ai']),
            'd6_depth': r6.get('depth'), 'd6_nodes': r6.get('nodes'),
            'd4_nodes': r4.get('nodes'), 'secs': round(time.time() - t, 1)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--suites', default=os.path.join(ROOT, 'ai', 'data', 'benchmarks'))
    ap.add_argument('--workers', type=int, default=os.cpu_count() or 2)
    ap.add_argument('--time-ms', type=int, default=300000, help='per-search cap (surprise_audit probe default)')
    ap.add_argument('--threshold', type=float, default=1.0)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--out-all', required=True)
    ap.add_argument('--out-suite', required=True)
    a = ap.parse_args()
    cases = json.load(open(os.path.join(a.suites, 'surprise_cases.json'), encoding='utf-8'))
    if a.limit:
        cases = cases[:a.limit]
    import sigil_engine as se
    print(f"rescoring {len(cases)} cases: eval {se.SHIPPED_EVAL}, policy {tuple(se.SHIPPED_POLICY)}, "
          f"width {se.DEFAULT_WIDTH_SCALE}, adaptive {tuple(se.SHIPPED_ADAPTIVE)}, cap {a.time_ms} ms", flush=True)
    t0 = time.time()
    with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(a.time_ms,)) as ex:
        res = list(ex.map(job, cases, chunksize=1))
    allrows, suite = [], []
    for c, r in zip(cases, res):
        tn, vn = r['target_new'], r['v4_i_new']
        conf = tn is not None and vn is not None and vn - tn > a.threshold
        row = {k: c[k] for k in ('src', 'g', 'i', 'room', 'ai', 'kind', 'cls') if k in c}
        row.update({'target_old': c['target'], 'v4_i_old': c.get('v4_i'), **r, 'confirmed_new': conf,
                    'engine': {'eval': se.SHIPPED_EVAL, 'policy': list(se.SHIPPED_POLICY)}})
        allrows.append(row)
        if tn is not None:
            n = dict(c)
            n.update({'target_old': c['target'], 'v4_i_old': c.get('v4_i'), 'target': tn, 'v4_i': vn,
                      'nodes_d6': r['d6_nodes'], 'confirmed_v25': conf, 'src_target': f"rescore {se.SHIPPED_EVAL} policy {list(se.SHIPPED_POLICY)}"})
            suite.append(n)
    for path, obj in ((a.out_all, allrows), (a.out_suite, suite)):
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump(obj, fh, indent=1 if path == a.out_all else None)
        os.replace(tmp, path)
    old_conf = sum(1 for c in cases if c.get('v4_i') is not None and c['v4_i'] - c['target'] > a.threshold)
    nconf = sum(r['confirmed_new'] for r in allrows)
    print(f"done in {time.time() - t0:.0f}s: {len(suite)} cases kept with a new target, {nconf} of {len(cases)} "
          f"confirmed under the shipped engine "
          f"(old targets: {old_conf}); mean |target_new - target_old| "
          f"{sum(abs((r['target_new'] or 0) - r['target_old']) for r in allrows) / max(len(allrows), 1):.2f} stones",
          flush=True)


if __name__ == '__main__':
    main()
