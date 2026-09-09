"""Localise the Check B misses: how CLOSE did enumeration get, and did a
resolver truncate?

`layout_reachable` answered yes/no over 62,000 real turns and found 1,855 the
shipped engine cannot generate. That says a gap exists but not what it is. This
runs `layout_nearest` on a stratified sample and reports, per bucket:

  * the Hamming distance to the nearest layout enumeration DID produce -- 1 or 2
    means the turn is right but for a single choice, large means a missing shape;
  * `resolver_truncated`, which the audit never saw. The audit guards the 250k
    TURN cap, but a per-cast outcome cap is invisible to it, so a capped
    resolution is indistinguishable from a complete enumeration that found
    nothing. If this is set the "gap" is a cap and the fix is a bigger budget.
  * the nearest turn's own action list beside the one actually recorded.
"""
import collections, json, os, sys, urllib.parse, urllib.request

import sigil_engine as se

BUCKET = 'focus-surfer-494820-g0-sigil'
OBJ = 'data/reach_cases.json'
CAP = 250_000                      # the audit's cap, so results are comparable


def fetch(bucket, obj):
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/"
        "service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"})))["access_token"]
    u = (f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/"
         + urllib.parse.quote(obj, safe='') + "?alt=media")
    return json.loads(urllib.request.urlopen(urllib.request.Request(
        u, headers={"Authorization": "Bearer " + tok})).read())


def fmt(log):
    out = []
    for kind, node, push_to, sacs, pos in log:
        if kind == 'cast':
            out.append(f'cast(pos={pos},outcome={node})')
        elif kind == 'dash':
            out.append(f'dash({node}<-{list(sacs)}'
                       + (f',push {push_to}' if push_to >= 0 else '') + ')')
        elif kind == 'pass':
            out.append('pass')
        else:
            out.append(f'{kind}({node}'
                       + (f',push {push_to}' if push_to >= 0 else '') + ')')
    return ' '.join(out)


def main():
    cases = fetch(BUCKET, OBJ)
    print(f'{len(cases)} cases, cap {CAP}\n', flush=True)
    by_bucket = collections.defaultdict(collections.Counter)
    trunc_res = collections.Counter()
    trunc_turn = collections.Counter()
    rows = []
    for i, c in enumerate(cases):
        b = se.Board.from_sfn(c['sfnBefore'])
        tgt = se.Board.from_sfn(c['sfnAfter']).stones
        dist, br, bb, log, n, tt, tr = b.layout_nearest(
            c['mover'], tgt[0], tgt[1], CAP)
        by_bucket[c['bucket']][dist] += 1
        if tr:
            trunc_res[c['bucket']] += 1
        if tt:
            trunc_turn[c['bucket']] += 1
        rec = c['actions']
        played = ' '.join(a.get('type', '?') for a in rec if isinstance(a, dict))
        rows.append((c['bucket'], dist, n, tt, tr, c['game'], c['turnNumber']))
        print(f"[{i:3d}] {c['bucket']:15s} dist={dist:2d} enum={n:7d}"
              f" turn_trunc={int(tt)} resolver_trunc={int(tr)}"
              f"  {c['game']} t{c['turnNumber']} by {c['playedBy']}", flush=True)
        if dist:
            print(f"        played  : {played}")
            print(f"        nearest : {fmt(log)}")

    print('\n=== nearest-layout distance, by bucket ===')
    for bk in sorted(by_bucket):
        d = by_bucket[bk]
        tot = sum(d.values())
        order = ' '.join(f'{k}:{v}' for k, v in sorted(d.items()))
        print(f'  {bk:15s} n={tot:3d}  dist->count  {order}')
    print('\n=== truncation (the alternative explanation) ===')
    for bk in sorted(by_bucket):
        tot = sum(by_bucket[bk].values())
        print(f'  {bk:15s} resolver_truncated {trunc_res[bk]:3d}/{tot:3d}'
              f'   turn_cap_truncated {trunc_turn[bk]:3d}/{tot:3d}')
    zero = sum(v for bk in by_bucket for k, v in by_bucket[bk].items() if k == 0)
    print(f'\ncases now reachable (dist 0): {zero}/{len(cases)}'
          '  -- must be 0; anything else means the audit and this disagree')


if __name__ == '__main__':
    main()
