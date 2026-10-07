"""Summarise tools/browser-depth.js output (round-3 gate report, 2026-10).

    python engine/harness/browser_depth_report.py --dir <run>/live [--speed 0.5,0.75,1,1.5,2,3]

Reads games10.jsonl / games10p.jsonl (game replays, 10 s per AI move, persistent table;
`p` = with 10 s ponder per human move) and the fresh-table case probes guest_pre /
guest_sfn / own_sfn / surprise_pre (30 s cap, per-depth completion ticks).

A machine `speed` times as fast as the probe machine completes depth d within 10 s iff the
probe completed it within 10 s * speed (the search is single threaded and spends exactly its
budget, `exact_clock`, so iterative deepening is cut by wall time alone). The 30 s case
probes therefore give the 10 s depth for speed <= 3.

Every table splits the competitive variant (`competitive`, `competitive_deathmatch`) from
the standard one: the variant is the SFN's last token when it names one.
"""
import argparse
import collections
import json
import os


def variant(sfn):
    last = (sfn or '').split(' ')[-1]
    return 'competitive' if last.startswith('competitive') else 'standard'


def load(path):
    if not os.path.exists(path):
        return []
    return [json.loads(x) for x in open(path, encoding='utf-8') if x.strip()]


def depth_at(r, ms):
    d = 0
    for depth, t, _nodes in r.get('ticks') or []:
        if t <= ms:
            d = max(d, depth)
    return d


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else None


def dist(ds):
    c = collections.Counter(ds)
    n = len(ds)
    return {'n': n, 'median': pct(ds, 0.5), '>=4': sum(v for k, v in c.items() if k >= 4) / n if n else None,
            '>=5': sum(v for k, v in c.items() if k >= 5) / n if n else None,
            '>=6': sum(v for k, v in c.items() if k >= 6) / n if n else None,
            '>=7': sum(v for k, v in c.items() if k >= 7) / n if n else None,
            'hist': dict(sorted(c.items()))}


def fmt(d):
    if not d['n']:
        return 'n=0'
    return (f"n={d['n']} median d{d['median']} >=d4 {d['>=4']:.0%} >=d5 {d['>=5']:.0%} "
            f">=d6 {d['>=6']:.0%} >=d7 {d['>=7']:.0%} hist {d['hist']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True)
    ap.add_argument('--suites', default=os.path.join(os.path.dirname(__file__), '..', '..', 'ai', 'data', 'benchmarks'))
    ap.add_argument('--speed', default='0.5,0.75,1,1.5,2,3')
    ap.add_argument('--json')
    a = ap.parse_args()
    speeds = [float(x) for x in a.speed.split(',')]
    out = {}
    guest = json.load(open(os.path.join(a.suites, 'guest_2026-10_cases.json')))
    own = json.load(open(os.path.join(a.suites, 'guest_2026-10_own.json')))
    # decisive AI decision positions: before each guest reply (i-1), and the own blunders (i)
    decisive_pre = {(c['g'], c['i'] - 1): c for c in guest}
    decisive_mate = {(c['g'], c['i'] - 1) for c in guest if c['target'] <= -19.5 and not c.get('ai_won')}
    decisive_own = {(c['g'], c['i']): c for c in own}
    for name in ('games10', 'games10p'):
        rows = [r for r in load(os.path.join(a.dir, name + '.jsonl')) if r.get('ok')]
        if not rows:
            continue
        sec = {}
        for v in ('competitive', 'standard'):
            rv = [r for r in rows if variant(r.get('played') or r.get('expected')) == v]
            if rv:
                sec[v] = {'depth': dist([r['depth'] for r in rv]),
                          'knps_median': pct([r['knps'] for r in rv], 0.5),
                          'knps_p10': pct([r['knps'] for r in rv], 0.1),
                          'knps_p90': pct([r['knps'] for r in rv], 0.9),
                          'nodes_median': pct([r['nodes'] for r in rv], 0.5)}
        mid = [r for r in rows if r['i'] >= 6]
        sec['midgame (ply >= 6)'] = {'depth': dist([r['depth'] for r in mid])}
        by = {(r['g'], r['i']): r for r in rows}
        sec['decisive: before a guest reply'] = {'depth': dist([by[k]['depth'] for k in decisive_pre if k in by])}
        sec['decisive: before a MATE blow in a loss'] = {
            'depth': dist([by[k]['depth'] for k in decisive_mate if k in by]),
            'cases': {f'{k[0][:8]} i{k[1]}': by[k]['depth'] for k in sorted(decisive_mate) if k in by}}
        sec['decisive: own blunder positions'] = {
            'depth': dist([by[k]['depth'] for k in decisive_own if k in by]),
            'cases': {f'{k[0][:8]} i{k[1]}': by[k]['depth'] for k in sorted(decisive_own) if k in by}}
        out[name] = sec
        print(f'== {name}: {len(rows)} AI searches')
        for k, s in sec.items():
            extra = ''.join(f" {x} {s[x]}" for x in ('knps_p10', 'knps_median', 'knps_p90', 'nodes_median') if x in s)
            print(f'  {k}: {fmt(s["depth"])}{extra}')
            if 'cases' in s:
                print(f'     {s["cases"]}')
    for name in ('guest_pre', 'guest_sfn', 'own_sfn', 'surprise_pre'):
        rows = [r for r in load(os.path.join(a.dir, name + '.jsonl')) if r.get('ok')]
        if not rows:
            continue
        sec = {}
        for v in ('competitive', 'standard', 'all'):
            rv = [r for r in rows if v == 'all' or variant(r.get('expected')) == v]
            if not rv:
                continue
            sec[v] = {f'x{s:g}': dist([depth_at(r, 10000 * s) for r in rv]) for s in speeds}
            sec[v]['knps_median_30s'] = pct([r['knps'] for r in rv], 0.5)
        out[name] = sec
        print(f'== {name}: {len(rows)} fresh-table searches (10 s depth at machine speed x)')
        for v, s in sec.items():
            print(f'  [{v}] knps(30 s) median {s["knps_median_30s"]}')
            for sp in speeds:
                print(f'    x{sp:g}: {fmt(s[f"x{sp:g}"])}')
    if a.json:
        json.dump(out, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
