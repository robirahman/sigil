#!/usr/bin/env python3
"""Build docs/static/data/sigilbench/leaderboard.json from graded runs.

    gcloud storage cp -r gs://focus-surfer-494820-g0-sigilbench-private/dev-runs <root>/
    python3 bench/tools/build_leaderboard.py --runs-root <root>

Reads bench/leaderboard/runs.json. For each run: the last graded record per
puzzle in results.jsonl, the settings in run.json. Publishes aggregates only
(accuracy, 95% Wilson interval, per-N accuracy, outcome counts, tokens) --
never answers or transcripts.
"""
import argparse
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import BENCH, CANARY, REPO, bench_version, load_json  # noqa: E402
from sigilbench.report import load, wilson  # noqa: E402

OUT = os.path.join(REPO, 'docs', 'static', 'data', 'sigilbench', 'leaderboard.json')


def acc(k, n):
    lo, hi = wilson(k, n)
    return {'correct': k, 'total': n, 'accuracy': round(k / n, 4) if n else None,
            'ci95': [round(lo, 4), round(hi, 4)]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs-root', required=True)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--manifest', default=os.path.join(BENCH, 'leaderboard', 'runs.json'))
    ap.add_argument('--dev-set', default=os.path.join(BENCH, 'dev', 'dev_set.json'))
    ap.add_argument('--first-pass', action='store_true',
                    help='ignore resolver records (use when the resolver did not finish every run alike)')
    a = ap.parse_args()
    man = load_json(a.manifest)
    dev = load_json(a.dev_set)
    entries = []
    for r in man['runs']:
        d = os.path.join(a.runs_root, r['gcs'])
        if not os.path.exists(d):      # --runs-root may hold the contents of dev-runs/ itself
            d = os.path.join(a.runs_root, r['gcs'].split('/', 1)[1])
        meta = load_json(os.path.join(d, 'run.json'))
        rows = load(d)
        if a.first_pass:
            # Last NON-resolver record per puzzle, so every run is graded alike.
            keep = {}
            for line in open(os.path.join(d, 'results.jsonl')):
                x = json.loads(line)
                if 'puzzle_id' in x and not (x.get('grade') or {}).get('resolved_from'):
                    keep[x['puzzle_id']] = x
            rows = list(keep.values())
        if len(rows) != len(dev['puzzles']):
            sys.exit(f"{r['gcs']}: {len(rows)} graded puzzles, expected {len(dev['puzzles'])}")
        st = {}
        for x in rows:
            st[x['status']] = st.get(x['status'], 0) + 1
        by_n = {}
        for n in sorted({x['n'] for x in rows}):
            rs = [x for x in rows if x['n'] == n]
            by_n[str(n)] = acc(sum(x['correct'] for x in rs), len(rs))
        tin = sum((x.get('usage') or {}).get('input_tokens', 0) for x in rows)
        tout = sum((x.get('usage') or {}).get('output_tokens', 0) for x in rows)
        secs = sorted(x.get('seconds') or 0 for x in rows)
        # The same run as originally graded, with the old one-reminder
        # protocol (shown for reference only).
        orig = d[:-len('_noreminder')] if d.rstrip('/').endswith('_noreminder') else None
        with_reminder = None
        if orig and os.path.exists(os.path.join(orig, 'results.jsonl')):
            o = load(orig)
            with_reminder = acc(sum(x['correct'] for x in o), len(o))
        entries.append(dict(
            id=os.path.basename(d.rstrip('/')), kind=r.get('kind', 'model'), label=r['label'], config=r['config'],
            provider=meta['provider'], model=meta['model'], settings=meta.get('settings'),
            date=meta['started'][:4] + '-' + meta['started'][4:6] + '-' + meta['started'][6:8],
            git_commit=(meta.get('git_commit') or '')[:7],
            approved_no_training=bool(meta.get('approval')),
            overall=acc(sum(x['correct'] for x in rows), len(rows)), by_n=by_n, status_counts=st,
            tokens={'input_per_puzzle': round(tin / len(rows)), 'output_per_puzzle': round(tout / len(rows)),
                    'estimated': any(x.get('usage_estimated') for x in rows)},
            resolved=sum(1 for x in rows if (x.get('grade') or {}).get('resolved_from')),
            with_reminder=with_reminder,
            median_seconds=secs[len(secs) // 2],
        ))
    for b in man['baselines']:
        if b.get('pending'):
            entries.append({'id': b['id'], 'kind': 'baseline', 'label': b['label'], 'config': b['config'], 'pending': True})
            continue
        entries.append({'id': b['id'], 'kind': 'baseline', 'label': b['label'], 'config': b['config'],
                        'date': b['date'], 'git_commit': b['git_commit'],
                        'overall': acc(b['correct'], b['total']),
                        'by_n': {k: acc(*v) for k, v in b['by_n'].items()},
                        'status_counts': b['status_counts']})
    doc = {
        'canary': CANARY,
        'benchmark': bench_version(),
        'split': man['split'],
        'set_id': man.get('set_id', 'dev_v1'),
        'set_label': man.get('set_label', 'Dev set v1'),
        'split_counts': dev['counts'],
        'resolver': 'not applied (first-pass grading for every run)' if a.first_pass else 'applied',
        'generated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d'),
        'entries': entries,
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    print(f'wrote {a.out}: {len(entries)} entries')


if __name__ == '__main__':
    main()
