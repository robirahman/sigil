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
    a = ap.parse_args()
    man = load_json(os.path.join(BENCH, 'leaderboard', 'runs.json'))
    dev = load_json(os.path.join(BENCH, 'dev', 'dev_set.json'))
    entries = []
    for r in man['runs']:
        d = os.path.join(a.runs_root, r['gcs'].split('/', 1)[1] if r['gcs'].startswith('dev-runs/') else r['gcs'])
        meta = load_json(os.path.join(d, 'run.json'))
        rows = load(d)
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
        # Answers that needed the one reminder (the first response ended
        # without a submit_answer call -- in practice the output cap): they
        # got a second response's worth of tokens.
        rem = rem_ok = 0
        tdir = os.path.join(d, 'transcripts')
        for x in rows:
            path = os.path.join(tdir, x['puzzle_id'] + '.json')
            if not os.path.exists(path):
                continue
            t = load_json(path).get('transcript') or []
            if sum(1 for m in t if m.get('role') in ('assistant', 'model')) > 1:
                rem += 1
                rem_ok += bool(x['correct'])
        entries.append(dict(
            id=os.path.basename(d.rstrip('/')), kind='model', label=r['label'], config=r['config'],
            provider=meta['provider'], model=meta['model'], settings=meta.get('settings'),
            date=meta['started'][:4] + '-' + meta['started'][4:6] + '-' + meta['started'][6:8],
            git_commit=(meta.get('git_commit') or '')[:7],
            approved_no_training=bool(meta.get('approval')),
            overall=acc(sum(x['correct'] for x in rows), len(rows)), by_n=by_n, status_counts=st,
            tokens={'input_per_puzzle': round(tin / len(rows)), 'output_per_puzzle': round(tout / len(rows))},
            median_seconds=secs[len(secs) // 2],
            reminded={'answers': rem, 'correct': rem_ok},
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
        'split_counts': dev['counts'],
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
