#!/usr/bin/env python3
"""Attribute every Check A eval-drop flag to a CAUSE.

    attribute_drops.py --drops '<glob>' --reach <checkb_flags.jsonl> [--reach2 ...]

Robi's bound: in Sigil every move places a stone, so the material swing an
ENUMERABLE opponent plan can produce is capped, and a horizon effect can cost
at most about one stone per turn -- 0.5 per half-move. A decline FASTER than
that is not a horizon effect; it means the opponent played something the
search could not generate. So `--per-ply-limit 0.5` is not an arbitrary
threshold, it is the envelope, and every flag above it wants a cause.

Three buckets, each with its own test rather than a judgement:

  ENUMERATION GAP  some turn between ply i and ply i+d is one Check B says
                   the engine cannot generate. Then the search never saw the
                   move that caused the drop, which is the reported bug.

  HORIZON EFFECT   the same position is flagged at a SHALLOWER depth and not
                   at a deeper one. Deepening curing it is what a horizon
                   effect means, and by the bound above these should be rare
                   above 0.5/half-move rather than the default explanation.

  OTHER            neither. The search could generate every move played and
                   still mis-scored the position by more than the envelope, so
                   this is the evaluation being wrong, not blind -- and it is
                   the bucket with no fix in hand.

MATE FLIPS are reported separately regardless of bucket: the engine scored a
position as not-losing and then lost within d half-moves. That is the
sharpest form of the original complaint (an eval of +0.5 into a mate-in-one)
and should be empty once enumeration is complete.
"""
import argparse
import collections
import glob
import json


def load_flags(pattern, kind):
    out = []
    for path in glob.glob(pattern):
        with open(path, encoding='utf-8', errors='replace') as fh:
            for ln in fh:
                if not ln.startswith('FLAG '):
                    continue
                d = json.loads(ln[5:])
                if d.get('kind') == kind and 'error' not in d:
                    out.append(d)
    return out


def load_reach(paths):
    """(game, turnNumber) the engine could not generate."""
    s = set()
    for p in paths:
        for path in glob.glob(p):
            with open(path, encoding='utf-8', errors='replace') as fh:
                for ln in fh:
                    if ln.startswith('FLAG '):
                        ln = ln[5:]
                    try:
                        d = json.loads(ln)
                    except Exception:
                        continue
                    if d.get('kind') == 'reach' and 'error' not in d:
                        s.add((d.get('game'), d.get('turnNumber')))
    return s


def turn_of(sfn):
    try:
        return int(sfn.split()[2])
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--drops', required=True, help='glob of shard logs')
    ap.add_argument('--reach', action='append', default=[],
                    help='Check B flag file(s); repeatable')
    ap.add_argument('--limit', type=float, default=0.5,
                    help="the horizon-effect envelope, stones per half-move")
    args = ap.parse_args()

    drops = load_flags(args.drops, 'drop')
    reach = load_reach(args.reach)
    print(f'eval-drop flags: {len(drops)}')
    print(f'unreachable turns known from Check B: {len(reach)}\n')
    if not drops:
        print('no eval-drop flags -- the engine never declined faster than '
              f'{args.limit}/half-move on this corpus')
        return

    # Which (game, ply) are flagged at each depth, for the deepening test.
    by_depth = collections.defaultdict(set)
    for d in drops:
        by_depth[d['depth']].add((d.get('game'), d.get('ply')))
    depths = sorted(by_depth)

    buckets = collections.Counter()
    per_depth = collections.defaultdict(collections.Counter)
    mate_flips = []
    worst = []
    for d in drops:
        g, ply, dep = d.get('game'), d.get('ply'), d['depth']
        tc = turn_of(d.get('sfnBefore', ''))
        # Every turn PLAYED between the two scored positions. Position i has
        # turn counter tc and position i+d has tc+d, and each turn advances one
        # position, so the turns in between are tc .. tc+d-1 -- d of them, not
        # d+1. Including tc+d would credit a later turn's unreachability to
        # this drop and inflate the ENUMERATION GAP bucket.
        spanned = set()
        if tc is not None:
            spanned = {(g, tc + k) for k in range(dep)}
        deeper = [x for x in depths if x > dep]
        cured = deeper and all((g, ply) not in by_depth[x] for x in deeper)

        if spanned & reach:
            b = 'ENUMERATION GAP'
        elif cured:
            b = 'HORIZON EFFECT (deepening cured it)'
        else:
            b = 'OTHER (eval wrong, not blind)'
        buckets[b] += 1
        per_depth[dep][b] += 1
        if d.get('mateFlip'):
            mate_flips.append((b, d))
        worst.append((d.get('dropPerPly', 0), b, d))

    print('=== attribution ===')
    tot = sum(buckets.values())
    for b, n in buckets.most_common():
        print(f'  {n:6d} ({100.0 * n / tot:5.1f}%)  {b}')
    print('\n=== by search depth ===')
    for dep in depths:
        row = per_depth[dep]
        print(f'  depth {dep}: ' + '  '.join(f'{k.split()[0]}={v}'
                                             for k, v in row.most_common()))
    print(f'\n=== MATE FLIPS (scored not-losing, then lost): {len(mate_flips)} ===')
    for b, d in mate_flips[:12]:
        print(f"  [{b.split()[0]:11s}] depth {d['depth']} "
              f"{d['score0'] / 4096:+.2f} -> lost   {d.get('game')} ply {d.get('ply')}")
    print('\n=== worst declines ===')
    worst.sort(key=lambda x: -x[0])
    for dp, b, d in worst[:12]:
        print(f"  {dp:+7.2f}/half-move  [{b.split()[0]:11s}] depth {d['depth']} "
              f"{d['score0'] / 4096:+.2f} -> {d['score1'] / 4096:+.2f}  "
              f"{d.get('game')} ply {d.get('ply')}")


if __name__ == '__main__':
    main()
