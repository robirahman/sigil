"""Fixed benchmarks on the frozen human-game suites (2026-10 training plan, Step 1).

    python engine/harness/bench_suites.py [--suites ai/data/benchmarks] [--nodes 50000,300000,1500000]
        [--cover 10,24,96,500] [--workers 4] [--json out.json]
        --config shipped:eval=tfit  --config spell:eval=tfit_spell  ...

Every metric is at a FIXED NODE BUDGET or a fixed candidate count, never a clock, so a
change that only spends more nodes cannot flatter itself and the numbers do not depend on
the machine. Each `--config` runs in its own worker processes, because the generator knobs
are process-global setters.

Metrics (per config):

  coverage   HUMAN-TURN COVERAGE: the share of human turns whose result the ordered turn
             stream (`rank_of_result`, the generator the search expands) emits within the
             first N candidates, for each N in --cover. Two sets: `finds` (the confirmed
             crushing human turns, human_finds.json) and `replies` (the opponent replies of
             the surprise cases, almost all human). Exact result match, side-to-move token
             ignored.
  sees       SURPRISE SEES-RATE: for each surprise case, search the position BEFORE the
             reply (`analyze`, node budget B, last completed depth kept) and count it seen
             when its AI-POV value is within 0.5 stones of the frozen depth-6 target or below
             it (surprise_audit.py's definition). Per budget in --nodes.
  final      FINAL-BLOW sees-rate: of the positions where the shipped engine missed a game-
             ending turn one ply ahead (final_blow_misses.json), the share where a node-budget
             search reports a forced win for the mover.

Config spec: `name:key=val;key=val`. Keys:
  eval=<preset>           eval preset name (`se.eval_weights` must know it); default tfit
  width_scale=<int>       default: the engine's DEFAULT_WIDTH_SCALE (ignored while adaptive is on:
                          the adaptive scales replace it, so pair it with adaptive=none)
  adaptive=<p,e,h>        default: the engine's SHIPPED_ADAPTIVE; `adaptive=none` disables
  call=<fn>(<args>)       a sigil_engine setter run once per worker before any work, e.g.
                          call=set_dash_gen(2,16,2); repeatable (separate with ';')
  module=<path.so>        load sigil_engine from this extension module instead (engine-
                          version A/Bs, as ab_version.py's $SIGIL_BASE_MODULE)
"""
import argparse
import ast
import importlib.util
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MATE_V = 20.0
TOLERANCE = 0.5

_se = None
_cfg = None


def parse_config(spec):
    name, _, rest = spec.partition(':')
    cfg = {'name': name, 'eval': 'tfit', 'calls': []}
    for kv in filter(None, (x.strip() for x in rest.split(';'))):
        k, _, v = kv.partition('=')
        if k == 'call':
            fn, _, args = v.partition('(')
            cfg['calls'].append((fn.strip(), ast.literal_eval('(' + args.rstrip(')') + ',)') if args.strip(')') else ()))
        elif k == 'width_scale':
            cfg['width_scale'] = int(v)
        elif k == 'adaptive':
            cfg['adaptive'] = None if v == 'none' else tuple(ast.literal_eval(v))
        elif k in ('eval', 'module'):
            cfg[k] = v
        else:
            raise SystemExit(f'unknown config key {k!r} in {spec!r}')
    return cfg


def _load_engine(module):
    if not module:
        import sigil_engine
        return sigil_engine
    spec = importlib.util.spec_from_file_location('sigil_engine', module)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _init(cfg):
    global _se, _cfg
    _se = _load_engine(cfg.get('module'))
    _cfg = dict(cfg)
    _cfg.setdefault('width_scale', _se.DEFAULT_WIDTH_SCALE)
    if 'adaptive' not in cfg:
        _cfg['adaptive'] = tuple(_se.SHIPPED_ADAPTIVE)
    for fn, args in cfg['calls']:
        getattr(_se, fn)(*args)


def _value(r, pov):
    """`analyze` dict (mover POV) -> clamped stones from `pov`'s side (surprise_audit.py)."""
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


def _search(sfn, history, nodes):
    return _se.analyze(sfn, _cfg['eval'], max_depth=40, time_ms=0, history_sfns=history or [],
                       width_scale=_cfg['width_scale'], adaptive=_cfg['adaptive'], node_limit=nodes)


def job_cover(item):
    sfn, after, cap = item
    try:
        rank, _gen, _acts = _se.rank_of_result(sfn, after, cap)
    except Exception:  # noqa: BLE001 -- a position the engine refuses counts as not covered
        rank = -1
    return rank


def job_sees(item):
    case, nodes = item
    r = _search(case['sfn'], case.get('history'), nodes)
    v = _value(r, case['ai'])
    return {'sees': v is not None and v <= case['target'] + TOLERANCE, 'v': v,
            'depth': r.get('depth'), 'nodes': r.get('nodes')}


def job_final(item):
    case, nodes = item
    r = _search(case['sfn'], case.get('history'), nodes)
    m = r.get('mate_in_turns')
    return {'sees': bool(m and m > 0), 'depth': r.get('depth'), 'nodes': r.get('nodes')}


def run_config(cfg, suites, a):
    out = {'config': {k: v for k, v in cfg.items() if k != 'calls'} | {'calls': [f'{f}{a_}' for f, a_ in cfg['calls']]}}
    cap = max(a.cover)
    with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(cfg,)) as ex:
        cov = {}
        for setname, cases in (('finds', suites['finds']), ('replies', suites['surprise'])):
            items = [(c['sfn'], c['sfn_after'], cap) for c in cases if c.get('sfn_after')]
            ranks = list(ex.map(job_cover, items, chunksize=4))
            n = len(ranks)
            cov[setname] = {'n': n, **{f'w{k}': round(sum(0 <= r < k for r in ranks) / n, 4) if n else None
                                       for k in a.cover}}
        out['coverage'] = cov
        sees, final = {}, {}
        for nodes in a.nodes:
            t = time.time()
            rs = list(ex.map(job_sees, [(c, nodes) for c in suites['surprise']], chunksize=1))
            n = len(rs)
            sees[str(nodes)] = {'n': n, 'rate': round(sum(r['sees'] for r in rs) / n, 4) if n else None,
                                'mean_depth': round(sum(r['depth'] or 0 for r in rs) / max(n, 1), 2),
                                'secs': round(time.time() - t, 1)}
            if suites['final']:
                rf = list(ex.map(job_final, [(c, nodes) for c in suites['final']], chunksize=1))
                final[str(nodes)] = {'n': len(rf), 'rate': round(sum(r['sees'] for r in rf) / len(rf), 4)}
        out['sees'] = sees
        out['final'] = final
    return out


def load_suites(d, limit=0):
    def ld(name):
        p = os.path.join(d, name)
        x = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else []
        return x[:limit] if limit else x
    return {'surprise': ld('surprise_cases.json'), 'finds': ld('human_finds.json'),
            'final': ld('final_blow_misses.json')}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--suites', default=os.path.join(ROOT, 'ai', 'data', 'benchmarks'))
    ap.add_argument('--config', action='append', default=[])
    ap.add_argument('--nodes', default='50000,300000,1500000')
    ap.add_argument('--cover', default='10,24,96,500')
    ap.add_argument('--workers', type=int, default=os.cpu_count() or 2)
    ap.add_argument('--limit', type=int, default=0, help='first N cases of each suite (smoke runs)')
    ap.add_argument('--json')
    a = ap.parse_args()
    a.nodes = [int(x) for x in a.nodes.split(',') if x]
    a.cover = [int(x) for x in a.cover.split(',') if x]
    cfgs = [parse_config(s) for s in (a.config or ['shipped:eval=tfit'])]
    suites = load_suites(a.suites, a.limit)
    print(f"suites: {len(suites['surprise'])} surprise, {len(suites['finds'])} human finds, "
          f"{len(suites['final'])} final-blow misses; nodes {a.nodes}; cover {a.cover}", flush=True)
    results = []
    for cfg in cfgs:
        t = time.time()
        r = run_config(cfg, suites, a)
        r['secs'] = round(time.time() - t, 1)
        results.append(r)
        cov = '  '.join(f"{k} " + ' '.join(f"{w}={v:.3f}" for w, v in c.items() if w != 'n')
                        for k, c in r['coverage'].items())
        sees = '  '.join(f"{n}:{s['rate']:.3f}(d{s['mean_depth']})" for n, s in r['sees'].items())
        fin = '  '.join(f"{n}:{s['rate']:.3f}" for n, s in r['final'].items())
        print(f"[{cfg['name']}] coverage {cov}\n[{cfg['name']}] sees {sees}   final {fin}   ({r['secs']}s)",
              flush=True)
    if a.json:
        tmp = a.json + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump(results, fh, indent=1)
        os.replace(tmp, a.json)


if __name__ == '__main__':
    main()
