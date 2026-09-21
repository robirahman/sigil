#!/usr/bin/env python3
"""Did the engine see the game-ending blow coming?

For every recorded game with a winner, take the position BEFORE the winner's
final turn (the winner to move) and ask the exhaustive solver how many of the
mover's legal turns win on the spot, and a shallow shipped search (depth 1 and
depth 2, untimed) whether it reports a forced win for the mover at all. The
stone-lead pre-pass (`decisive_lead_turns`) is asked too, at its shipped cap and
at 50,000 boards, so a miss can be attributed to budget or to shape.

    python engine/harness/final_blow_probe.py --lines lines_all.json --out final_probe.jsonl [--workers 4]

One JSON line per game: {g, i, sfn, mover, mate1_total, root_successors,
d1_sees, d2_sees, d1_stones, d2_stones, prepass2k, prepass50k, solver_s}.
weakness_report.py folds this in as Part 3, "final-blow detection": the share of
real winning turns the generator-ordered search could not see one ply before
they were played, split by how many of the mover's turns won (a position with
hundreds of winning turns that the search misses is an ordering/window failure,
not a hard tactic).
"""
import argparse
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

EVAL_NAME = 'tfit'


def probe(item):
    gid, i, sfn, hist, budget_ms = item
    import sigil_engine as se
    kw = dict(width_scale=se.DEFAULT_WIDTH_SCALE, adaptive=se.SHIPPED_ADAPTIVE)
    t0 = time.time()
    try:
        sol = json.loads(se.solve_mates(sfn, 50_000_000, budget_ms, [], 1))
    except Exception as e:  # noqa: BLE001
        return {'g': gid, 'i': i, 'sfn': sfn, 'error': f'{type(e).__name__}: {e}'}
    out = {'g': gid, 'i': i, 'sfn': sfn, 'mover': sfn.split()[1],
           'mate1_total': sol.get('mate1_total') if sol.get('mate1_total') is not None else len(sol.get('mate1') or []),
           'root_successors': sol.get('root_successors'), 'solver_s': round(time.time() - t0, 2),
           'solver_ok': bool(sol.get('ok'))}
    for d in (1, 2):
        r = se.analyze(sfn, EVAL_NAME, max_depth=d, time_ms=0, history_sfns=hist, **kw)
        m = r['mate_in_turns']
        out[f'd{d}_sees'] = bool(m and m > 0)
        out[f'd{d}_stones'] = r['stones']
    if out['mate1_total']:
        b = se.Board.from_sfn(sfn)
        col = 'red' if out['mover'] == 'r' else 'blue'
        out['prepass2k'] = len(b.decisive_lead_turns(col, 2000))
        out['prepass50k'] = len(b.decisive_lead_turns(col, 50000))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--lines', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--workers', type=int, default=os.cpu_count() or 2)
    ap.add_argument('--budget-ms', type=int, default=20000, help='solver wall-clock cap per position')
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    import sigil_engine as se
    lines = json.load(open(a.lines, encoding='utf-8'))
    done = set()
    if os.path.exists(a.out):
        for line in open(a.out, encoding='utf-8'):
            try:
                done.add(json.loads(line)['g'])
            except (ValueError, KeyError):
                pass
    items = []
    for gid, g in sorted(lines.items(), key=lambda kv: kv[1].get('timestamp') or 0):
        if gid in done or g.get('winner') not in ('red', 'blue'):
            continue
        pos = g['positions']
        n = len(pos) - 1
        if n < 1:
            continue
        sfn = pos[n - 1]
        if sfn.split()[1] != g['winner'][0]:
            continue                      # the last recorded turn was not the winner's (Seal, forfeit, sixth cast...)
        try:
            se.Board.from_sfn(sfn)
        except ValueError:
            continue                      # spells the engine does not model
        items.append((gid, n - 1, sfn, pos[:n - 1], a.budget_ms))
    if a.limit:
        items = items[:a.limit]
    print(f'{len(items)} final positions to probe ({len(done)} already done)', flush=True)
    t0 = time.time()
    with open(a.out, 'a', encoding='utf-8') as fh, ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(probe, it) for it in items]
        for k, fut in enumerate(as_completed(futs), 1):
            fh.write(json.dumps(fut.result(), separators=(',', ':')) + '\n'); fh.flush()
            if k % 50 == 0 or k == len(futs):
                print(f'  {k}/{len(futs)} in {time.time() - t0:.0f}s', flush=True)


if __name__ == '__main__':
    main()
