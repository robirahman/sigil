"""Re-score the win-probability starts with the current engine, keeping their results.

    position_rescore.py <out.log> <log> [<log> ...] [--workers N] [--depths 4,5,6] [--limit N]

The position win-probability curve (fit_position_winprob.py) maps a start's
depth-d eval to the result of Very Hard vs Very Hard from that start. When
SHIPPED_EVAL changes, only the eval side of that map moves: the results are a
property of the start, so they need not be replayed (the 2026-10-21 games cost
about 1,900 vCPU-hours; re-scoring costs about 2% of that). This reads the
POSRESULT lines of earlier position_selfplay.py logs (local paths, or gs:// URLs
with wildcards, as fit_position_winprob.py reads them), re-runs
position_selfplay.evals_at on each start with the installed engine (fresh table,
shipped eval, width and adaptive, no history), and writes POSRESULT lines that
keep the original winner, plies and game settings. Each new record names the
eval it was re-scored with (`eval`) and the eval the games were scored with
(`rescored.from`). Feed <out.log> to fit_position_winprob.py.

What this does NOT refresh: the games themselves were played by the original
run's engine (v31 Very Hard for runs_v1). A stronger engine on both sides changes
P(red wins) from a start only through which side converts better, so the fit is
still the curve the rated payoffs need; replay the games (position_selfplay.py)
if the playing strength moves a long way.
"""
import argparse, json, os, sys, time
from concurrent.futures import ProcessPoolExecutor, as_completed

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)


def _init():
    import sigil_engine as se
    se.set_policy(*se.SHIPPED_POLICY)
    se.set_policy_explore(*se.SHIPPED_EXPLORE)


def _score(job):
    rec, depths = job
    import position_selfplay as ps
    t0 = time.time()
    ev = ps.evals_at(rec['sfn'], [], depths)
    out = dict(rec)
    out['rescored'] = dict(fromEval=rec.get('eval'), fromEvals=rec.get('evals'), secs=round(time.time() - t0, 1))
    out['evals'] = ev
    out['eval'] = ps.EVAL
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out')
    ap.add_argument('logs', nargs='+')
    ap.add_argument('--workers', type=int, default=os.cpu_count())
    ap.add_argument('--depths', default='4,5,6')
    ap.add_argument('--limit', type=int, default=0, help='first N starts only (a timing check)')
    a = ap.parse_args()
    from fit_position_winprob import load
    recs = sorted(load(a.logs), key=lambda r: r['i'])
    if a.limit:
        recs = recs[:a.limit]
    depths = [int(x) for x in a.depths.split(',')]
    done = set()
    if os.path.exists(a.out):   # resume
        for line in open(a.out):
            if line.startswith('POSRESULT '):
                done.add(json.loads(line[10:])['i'])
    todo = [r for r in recs if r['i'] not in done]
    import sigil_engine as se
    print(f'RESCORE eval={se.SHIPPED_EVAL} policy={tuple(se.SHIPPED_POLICY)} depths={depths} '
          f'starts={len(recs)} done={len(done)} todo={len(todo)} workers={a.workers}', flush=True)
    t0 = time.time()
    with open(a.out, 'a') as fh, ProcessPoolExecutor(a.workers, initializer=_init) as ex:
        futs = [ex.submit(_score, (r, depths)) for r in todo]
        for k, f in enumerate(as_completed(futs), 1):
            fh.write('POSRESULT ' + json.dumps(f.result(), separators=(',', ':')) + '\n')
            fh.flush()
            if k % 200 == 0 or k == len(todo):
                el = time.time() - t0
                print(f'  {k}/{len(todo)} {el:.0f}s, ~{el / k * (len(todo) - k) / 60:.0f} min left', flush=True)


if __name__ == '__main__':
    main()
