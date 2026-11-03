"""Summarize a run directory: python3 -m sigilbench.report bench/runs/<run>"""
import collections
import json
import math
import os
import sys


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def load(run_dir):
    rows = {}
    with open(os.path.join(run_dir, 'results.jsonl')) as f:
        for line in f:
            r = json.loads(line)
            if 'puzzle_id' in r:
                rows[r['puzzle_id']] = r      # last record per puzzle wins (re-runs)
    return list(rows.values())


def summarize(run_dir):
    meta = json.load(open(os.path.join(run_dir, 'run.json')))
    rows = load(run_dir)
    out = {'run': os.path.basename(run_dir.rstrip('/')), 'provider': meta['provider'], 'model': meta['model'],
           'settings': meta.get('settings'), 'split': meta['split'], 'n_puzzles': len(rows)}

    def acc(rs):
        k = sum(1 for r in rs if r['correct'])
        lo, hi = wilson(k, len(rs))
        return {'correct': k, 'total': len(rs), 'accuracy': round(k / len(rs), 4) if rs else None,
                'ci95': [round(lo, 4), round(hi, 4)]}

    out['overall'] = acc(rows)
    out['by_n'] = {str(n): acc([r for r in rows if r['n'] == n]) for n in sorted({r['n'] for r in rows})}
    out['status_counts'] = dict(collections.Counter(r['status'] for r in rows))
    tin = sum((r.get('usage') or {}).get('input_tokens', 0) for r in rows)
    tout = sum((r.get('usage') or {}).get('output_tokens', 0) for r in rows)
    out['tokens'] = {'input': tin, 'output': tout}
    pi, po = meta.get('price_in_per_mtok'), meta.get('price_out_per_mtok')
    if pi is not None and po is not None:
        out['cost_usd'] = round(tin / 1e6 * pi + tout / 1e6 * po, 2)
    out['flagged_for_recheck'] = [r['puzzle_id'] for r in rows if r['status'] in ('unproven', 'grader_error')]
    return out


if __name__ == '__main__':
    print(json.dumps(summarize(sys.argv[1]), indent=1))
