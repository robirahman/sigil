#!/usr/bin/env python3
"""Build docs/static/data/sigilbench/leaderboard*.json from graded runs.

    gcloud storage cp -r gs://focus-surfer-494820-g0-sigilbench-private/dev-runs <root>/
    python3 bench/tools/build_leaderboard.py --runs-root <root>              # dev set v1
    python3 bench/tools/build_leaderboard.py --set v2 --runs-root <root>     # dev set v2 (v2.1 categories)
    python3 bench/tools/build_leaderboard.py --set v3 --runs-root <root>     # dev set v3

Reads a manifest (bench/leaderboard/runs*.json). For each run: the last graded
record per puzzle in results.jsonl, the settings in run.json. Publishes
aggregates only (accuracy, 95% Wilson interval, per-N or per-category
accuracy, outcome counts, tokens) -- never answers or transcripts.

--set picks the manifest, dev set, output and (v2) category file of a dev
set; any of them can still be given explicitly. A dev set whose puzzles carry
a `category` (v3: "m1".."m5" by proven shortest mate, "win" for winning-turn
puzzles) is reported by category: each entry gets `by_category` instead of
`by_n`, and the document lists its `categories` in column order. --runs-root
is needed only when the manifest lists runs; with none, the page shows the
set with no entries.
"""
import argparse
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import BENCH, CANARY, REPO, bench_version, load_json  # noqa: E402
from sigilbench.report import load, wilson  # noqa: E402

DATA = os.path.join(REPO, 'docs', 'static', 'data', 'sigilbench')
OUT = os.path.join(DATA, 'leaderboard.json')
# Dev sets the site shows: manifest, dev set, output, per-puzzle shortest-mate file.
SETS = {
    'v1': dict(manifest=os.path.join(BENCH, 'leaderboard', 'runs.json'),
               dev_set=os.path.join(BENCH, 'dev', 'dev_set.json'), out=OUT, categories=None),
    'v2': dict(manifest=os.path.join(BENCH, 'leaderboard', 'runs_dev_v2.json'),
               dev_set=os.path.join(BENCH, 'dev', 'dev_set_v2.json'),
               out=os.path.join(DATA, 'leaderboard_dev_v2.json'),
               categories=os.path.join(BENCH, 'dev', 'dev_set_v2_shortest.json')),
    'v3': dict(manifest=os.path.join(BENCH, 'leaderboard', 'runs_dev_v3.json'),
               dev_set=os.path.join(BENCH, 'dev', 'dev_set_v3.json'),
               out=os.path.join(DATA, 'leaderboard_dev_v3.json'), categories=None),
}
# v3 categories, in column order (bench/tools/select_v3.py CATS).
CATEGORY_LABELS = {'m1': 'Mate in 1', 'm2': 'Mate in 2', 'm3': 'Mate in 3', 'm4': 'Mate in 4',
                   'm5': 'Mate in 5', 'win': 'Winning turn'}
CATEGORY_ORDER = list(CATEGORY_LABELS)


def category_order(cats):
    return sorted(cats, key=lambda c: (CATEGORY_ORDER.index(c) if c in CATEGORY_ORDER else len(CATEGORY_ORDER), c))


def test_set_sha256():
    """The published SHA-256 of the private test set (bench/TEST_SET_SHA256), if any."""
    path = os.path.join(BENCH, 'TEST_SET_SHA256')
    if not os.path.exists(path):
        return None
    words = open(path).read().split()
    return words[0] if words else None


def acc(k, n):
    lo, hi = wilson(k, n)
    return {'correct': k, 'total': n, 'accuracy': round(k / n, 4) if n else None,
            'ci95': [round(lo, 4), round(hi, 4)]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--set', choices=sorted(SETS), default='v1',
                    help='dev set: the defaults for --manifest, --dev-set, --out and --categories (default v1)')
    ap.add_argument('--runs-root', default=None, help='local copy of the bucket (needed when the manifest lists runs)')
    ap.add_argument('--out', default=None)
    ap.add_argument('--manifest', default=None)
    ap.add_argument('--dev-set', default=None)
    ap.add_argument('--categories', default=None,
                    help='per-puzzle shortest-mate file (bench/dev/dev_set_v2_shortest.json): group the per-N '
                         'columns by proven shortest mate instead of the stated N')
    ap.add_argument('--by-category', action='store_true',
                    help="group by each puzzle's own `category` field (v3; on by default when the dev set has one)")
    ap.add_argument('--first-pass', action='store_true',
                    help='ignore resolver records (use when the resolver did not finish every run alike)')
    a = ap.parse_args()
    preset = SETS[a.set]
    for k in ('out', 'manifest', 'dev_set', 'categories'):
        if getattr(a, k) is None:
            setattr(a, k, preset[k])
    man = load_json(a.manifest)
    if man['runs'] and not a.runs_root:
        sys.exit(f'{a.manifest} lists runs: give --runs-root')
    if os.path.exists(a.dev_set):
        dev = load_json(a.dev_set)
    elif man['runs'] or any(not b.get('pending') for b in man['baselines']):
        sys.exit(f'{a.dev_set} not found')
    else:
        # Nothing graded yet (v3 before its dev set is built): the page shows
        # the set's columns with no entries and no counts.
        print(f'note: {a.dev_set} not found; writing a document with no counts', file=sys.stderr)
        dev = None
    tagged = [p for p in (dev or {}).get('puzzles', []) if p.get('category')]
    if dev and tagged and len(tagged) != len(dev['puzzles']):
        sys.exit(f"{a.dev_set}: {len(dev['puzzles']) - len(tagged)} puzzles have no category")
    by_cat = a.by_category or a.set == 'v3' or bool(dev and tagged)
    if by_cat and a.categories:
        sys.exit('--categories (v2 shortest-mate file) and a dev set with its own categories do not mix')
    cat = None
    rec = {}
    if by_cat:
        cat = {p['id']: p['category'] for p in dev['puzzles']} if dev else {}
    elif a.categories:
        rec = load_json(a.categories)['puzzles']
        cat = {pid: v['category'] for pid, v in rec.items()}
        if set(cat) != {p['id'] for p in dev['puzzles']}:
            sys.exit('--categories does not cover the dev set exactly')
    col = (lambda x: cat[x['puzzle_id']]) if cat is not None else (lambda x: x['n'])
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
        if cat is not None and {x['puzzle_id'] for x in rows} != set(cat):
            sys.exit(f"{r['gcs']}: its puzzle ids are not the dev set's")
        if by_cat:
            # run.py records each puzzle's category; it must be the dev set's.
            bad = [x['puzzle_id'] for x in rows if x.get('category') and x['category'] != cat[x['puzzle_id']]]
            if bad:
                sys.exit(f"{r['gcs']}: category differs from the dev set for {', '.join(sorted(bad)[:5])}")
        st = {}
        for x in rows:
            st[x['status']] = st.get(x['status'], 0) + 1
        groups = category_order({col(x) for x in rows}) if by_cat else sorted({col(x) for x in rows})
        by_n = {}
        for n in groups:
            rs = [x for x in rows if col(x) == n]
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
            overall=acc(sum(x['correct'] for x in rows), len(rows)),
            **({'by_category': by_n} if by_cat else {'by_n': by_n}), status_counts=st,
            tokens={'input_per_puzzle': round(tin / len(rows)), 'output_per_puzzle': round(tout / len(rows)),
                    'estimated': any(x.get('usage_estimated') for x in rows)},
            resolved=sum(1 for x in rows if (x.get('grade') or {}).get('resolved_from')),
            with_reminder=with_reminder,
            median_seconds=secs[len(secs) // 2],
        ))
    for b in man['baselines']:
        if cat is not None and b.get('by_n'):
            # A baseline's per-N cells are aggregates by stated N; they cannot be
            # regrouped by category without per-puzzle results.
            sys.exit(f"baseline {b['id']} has a stated-N by_n breakdown, which categories cannot regroup"
                     + (' (give by_category instead)' if by_cat else ''))
        if b.get('by_category') and not by_cat:
            sys.exit(f"baseline {b['id']} has by_category, but this dev set has no categories")
        if b.get('pending'):
            entries.append({'id': b['id'], 'kind': 'baseline', 'label': b['label'], 'config': b['config'], 'pending': True})
            continue
        if by_cat:
            unknown = set(b.get('by_category') or {}) - set(cat.values())
            if unknown:
                sys.exit(f"baseline {b['id']}: categories {sorted(unknown)} are not in the dev set")
        cells = b.get('by_category') if by_cat else b.get('by_n')
        entries.append({'id': b['id'], 'kind': 'baseline', 'label': b['label'], 'config': b['config'],
                        'date': b['date'], 'git_commit': b['git_commit'],
                        'overall': acc(b['correct'], b['total']),
                        # A baseline may report an overall score only (the human
                        # experts' 2026-11 run): no per-N cells, no outcome counts.
                        ('by_category' if by_cat else 'by_n'):
                            {k: acc(*(cells or {})[k]) for k in
                             (category_order(cells or {}) if by_cat else (cells or {}))},
                        'status_counts': b.get('status_counts') or {}})
    if by_cat:
        present = category_order(set(cat.values())) if dev else list(CATEGORY_ORDER)
        split_counts = {c: sum(1 for v in cat.values() if v == c) for c in present} if dev else {}
    else:
        split_counts = ({str(n): sum(1 for v in cat.values() if v == n) for n in sorted(set(cat.values()))}
                        if cat else dev['counts'])
    doc = {
        'canary': CANARY,
        'benchmark': bench_version(),
        'split': man['split'],
        'set_id': man.get('set_id', 'dev_v1'),
        'set_label': man.get('set_label', 'Dev set v1'),
        'split_counts': split_counts,
        # 'stated_n': columns by each puzzle's N. 'shortest_mate': each puzzle
        # under the shortest forced win proven for it (its category);
        # 'unresolved' counts those where a still shorter mate is not excluded
        # (exact false), so their column is an upper bound. 'category': the
        # dev set's own categories (v3), in the order of 'categories'.
        'columns': 'category' if by_cat else ('shortest_mate' if cat else 'stated_n'),
    }
    if by_cat:
        doc['categories'] = [[c, CATEGORY_LABELS.get(c, c)] for c in present]
        if dev is None:
            doc['set_pending'] = True
    else:
        doc['recategorized'] = sum(1 for p in dev['puzzles'] if cat[p['id']] != p['n']) if cat else 0
        doc['unresolved'] = sum(1 for v in rec.values() if not v.get('exact')) if cat else 0
    doc['resolver'] = 'not applied (first-pass grading for every run)' if a.first_pass else 'applied'
    doc['generated'] = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d')
    sha = test_set_sha256()
    if sha:
        doc['test_set_sha256'] = sha
    doc['entries'] = entries
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    with open(a.out, 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    print(f'wrote {a.out}: {len(entries)} entries')


if __name__ == '__main__':
    main()
