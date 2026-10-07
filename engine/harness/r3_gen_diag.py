"""Round 3 generator diagnosis: why a recorded reply is (not) in the policy stream.

    python engine/harness/r3_gen_diag.py [--cases ai/data/benchmarks/guest_2026-10_cases.json]
        [--only-kind cast,dash+cast,dash] [--workers 6] [--json out.json] [--cap 20000]

For each case (position `sfn`, the recorded reply's result `sfn_after`):

  * every exhaustively enumerated turn that produces the reply (`policy_diag`), and for
    the best of them the policy path: per choice level the option count, the target's
    index and its log-probability. A level with index -1 means the CANDIDATE SET lacks the
    target (pruned before the policy: cast window/keep window, dash landing cap, dash
    sacrifice-pair selection); otherwise the turn is buildable and only its probability
    (`logp`, 1/256 nat) decides its rank;
  * its rank in the policy stream (`policy_rank_of_result`, cap --cap) and in the shipped
    stream at the search's budgets (window 16, keep 2), the stream the search uses at
    nodes narrower than the policy's min width;
  * where it sits in the lists the SHIPPED search expands for this position as a ply-1
    reply (`node_list_rank`, remaining 3 / 4 / 5 = the AI's depth-4 / 5 / 6 iterations)
    and as a root move (root width = 3 x the depth's width).

Generator knobs are thread-local: `--call set_x(args)` runs setters in each worker (e.g.
the round 3 `set_policy_explore`), so a fix's effect is the same command with one flag.
"""
import argparse
import ast
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
LEVELS = ['M', 'P', 'S', 'D', 'P2', 'S2', 'C', 'Z', 'S3']

_se = None


def _init(calls):
    global _se
    import sigil_engine as se
    _se = se
    se.set_policy(*se.SHIPPED_POLICY)
    for fn, args in calls:
        getattr(se, fn)(*args)


def _kind(packed):
    tags = [p & 7 for p in packed]
    k = []
    if 3 in tags:
        k.append('dash')
    if 4 in tags:
        k.append('cast')
    return '+'.join(k) or 'move-only'


def job(item):
    idx, case, cap, enum_cap = item
    se = _se
    sfn, after = case['sfn'], case['sfn_after']
    out = {'idx': idx, 'g': case.get('g'), 'i': case.get('i'), 'target': case.get('target'),
           'cls': case.get('cls')}
    try:
        wit = json.loads(se.policy_diag(sfn, after, enum_cap, 64))
    except Exception as e:  # noqa: BLE001
        out['error'] = str(e)
        wit = []
    out['n_witness'] = len(wit)
    if wit:
        def score(w):
            d = w['diag']
            if d.get('fallback'):
                return (-2, 0)
            if d['broken'] is None:
                return (1, d['logp'])
            return (0, len(d['levels']))
        best = max(wit, key=score)
        out['kind'] = _kind(best['packed'])
        out['packed'] = best['packed']
        out['diag'] = best['diag']
        out['n_buildable'] = sum(1 for w in wit if not w['diag'].get('fallback') and w['diag']['broken'] is None)
    else:
        out['kind'] = case.get('kind', 'unknown')
    try:
        r, gen, exp = se.policy_rank_of_result(sfn, after, cap)
        out['policy_rank'] = r
        out['policy_generated'] = gen
    except Exception as e:  # noqa: BLE001
        out['policy_rank'] = None
    try:
        out['stream16_rank'] = se.rank_of_result_budget(sfn, after, 16, 2, 5000)[0]
    except Exception:  # noqa: BLE001
        out['stream16_rank'] = None
    out['scale'] = se.adaptive_scale(sfn)
    nl = {}
    for rem in (3, 4, 5):
        try:
            ix, w, pull, n = se.node_list_rank(sfn, after, rem, 1)
            nl[str(rem)] = [ix, w]
        except Exception:  # noqa: BLE001
            nl[str(rem)] = None
    out['ply1'] = nl
    return out


def fmt_path(d):
    if not d or d.get('fallback'):
        return 'fallback'
    parts = []
    for lv, n, t, lp, best in d['levels']:
        name = LEVELS[lv]
        parts.append(f"{name}:{'MISSING' if t < 0 else t}/{n}" + ('' if t < 0 else f"({lp / 256:.1f})"))
    return ' '.join(parts)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cases', default=os.path.join(ROOT, 'ai', 'data', 'benchmarks', 'guest_2026-10_cases.json'))
    ap.add_argument('--only-kind', default='')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--cap', type=int, default=20000)
    ap.add_argument('--enum-cap', type=int, default=2_000_000)
    ap.add_argument('--call', action='append', default=[])
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--json')
    a = ap.parse_args()
    calls = []
    for c in a.call:
        fn, _, args = c.partition('(')
        calls.append((fn.strip(), ast.literal_eval('(' + args.rstrip(')') + ',)') if args.strip(')') else ()))
    cases = json.load(open(a.cases, encoding='utf-8'))
    if a.limit:
        cases = cases[:a.limit]
    kinds = set(filter(None, a.only_kind.split(',')))
    items = [(k, c, a.cap, a.enum_cap) for k, c in enumerate(cases)
             if c.get('sfn_after') and (not kinds or c.get('kind') in kinds)]
    with ProcessPoolExecutor(a.workers, initializer=_init, initargs=(calls,)) as ex:
        res = list(ex.map(job, items, chunksize=1))
    res.sort(key=lambda r: r['idx'])
    print(f"{'#':>3} {'kind':10} {'tgt':>6} {'pol':>6} {'s16':>5} sc  ply1 r3/r4/r5        path")
    for r in res:
        p1 = ' '.join('-' if v is None else f"{v[0]}/{v[1]}" for v in r['ply1'].values())
        print(f"{r['idx']:3d} {r.get('kind', '?'):10} {r['target'] if r['target'] is not None else 0:6.2f} "
              f"{r.get('policy_rank')!s:>6} {r.get('stream16_rank')!s:>5} {r['scale']}  {p1:18} "
              f"{fmt_path(r.get('diag'))} {json.dumps({k: r['diag'][k] for k in ('dash', 'cast') if r.get('diag') and k in r['diag']})}",
              flush=True)
    if a.json:
        json.dump(res, open(a.json, 'w', encoding='utf-8'), indent=1)


if __name__ == '__main__':
    main()
