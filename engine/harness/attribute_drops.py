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

  CORRUPT RECORD   some turn between ply i and ply i+d is one Check B says
                   the engine cannot generate. This bucket was called
                   ENUMERATION GAP and read as "the search never saw the move
                   that caused the drop". Adjudication killed that reading:
                   genuine gaps are ZERO, and all 432 unreachable turns are
                   record damage. A window straddling one DID NOT HAPPEN, so
                   the envelope does not apply to it and the flag carries no
                   information about the engine. EXCLUDE, do not attribute.

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
sharpest form of the original complaint (an eval of +0.5 into a mate-in-one).
It is NOT expected to be empty now that enumeration is complete, and the
first campaign's prediction that it would be was wrong: enumeration is closed
at zero genuine gaps and these persist. Two other causes remain -- the mate
guard, which reports a mate from a budget-limited search as a proof, and the
eval itself.

READ THIS BUCKET WITH THE GUARD IN MIND. `UNPROVEN_MATE` is 5,000
centistones, so a guarded engine's "mate" is finite and `score1 <= -MATE`
stops matching: mate flips fall toward zero WITHOUT the eval improving at
all. The gradual metric is unaffected -- eval_drop_audit clamps at +-20
stones (2,000 centistones) and both 1e7 and 5,000 clamp to the same bound, so
dropPerPly is identical either way. So compare gradual drops across runs, and
treat a fall in mate flips as the guard working, never as the eval improving.
"""
import argparse
import collections
import glob
import json

# Centistones per stone, and it MUST match eval_drop_audit.py, which produces
# the flags this script reads. A local `STONE = 4096` used to shadow it inside
# the mate-flip test: `--mate-from -0.5` then compared score0 against -2048
# centistones, i.e. -20.5 stones, so every position the engine was already
# losing by up to 20 stones counted as "scored not-losing, then lost". That is
# the 41x units error, and it inflated mate flips from ~10 to 203 of 3,106.
STONE = 100


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


def fmt_score(v):
    """Mate is +-1e7; dividing that by STONE prints a nonsense +2441.41."""
    if v >= 1_000_000:
        return '  +MATE'
    if v <= -1_000_000:
        return '  -MATE'
    return f'{v / 4096:+7.2f}'


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
    ap.add_argument('--identities', default=None,
                    help="hydrated_lines json. Check A re-scores a position "
                         "after the ACTUAL continuation, so a decline means the "
                         "MOVER's position got worse -- either the opponent "
                         "found something the engine could not see (the bug) or "
                         "THE MOVER BLUNDERED, which the engine is scoring "
                         "correctly. The original design said 'games played by "
                         "the new engine', where the mover IS the engine. On a "
                         "human/old-AI corpus 94.8% of flags have someone else "
                         "to move and are not evidence about the engine. Pass "
                         "this plus --mover to restrict to an interpretable "
                         "slice.")
    ap.add_argument('--mover', default=None,
                    help="keep only flags where this agent was to move, "
                         "e.g. 'rust'")
    ap.add_argument('--mate-from', type=float, default=-0.5,
                    help="score (in stones) at or above which a flip into a "
                         "proven loss counts as a SURPRISE. The audit's own "
                         "`surprise_from` defaults to 0.0, which does not count "
                         "a position scored -0.014 -- dead even -- flipping to "
                         "a proven loss, and that is exactly the reported bug.")
    args = ap.parse_args()

    drops = load_flags(args.drops, 'drop')
    reach = load_reach(args.reach)
    if args.identities and args.mover:
        ident = {}
        for g in json.load(open(args.identities, encoding='utf-8')):
            m = g.get('meta') or {}
            ident[g['key']] = (m.get('red'), m.get('blue'))
        before = len(drops)
        keep = []
        for d in drops:
            r, b = ident.get(d.get('game'), (None, None))
            if (r if d.get('mover') == 'red' else b) == args.mover:
                keep.append(d)
        drops = keep
        print(f'restricted to {args.mover} to move: {len(drops)} of {before} '
              f'({100.0 * len(drops) / max(1, before):.1f}%)')
    print(f'eval-drop flags: {len(drops)}')
    print(f'unreachable turns known from Check B: {len(reach)}\n')
    if not drops:
        print('no eval-drop flags -- the engine never declined faster than '
              f'{args.limit}/half-move on this corpus')
        return

    # The deepening test compares the SAME (game, ply, WINDOW) at a greater
    # search depth. Keying on depth alone silently compared a 2-half-move
    # window searched 2 deep against a 4-half-move window searched 4 deep --
    # two different questions, so absence proved nothing and the HORIZON
    # bucket was meaningless. A run whose windows are not decoupled from its
    # depths cannot answer this, and says so instead of guessing.
    by_dw = collections.defaultdict(set)
    windows = set()
    for d in drops:
        w = d.get('window', d['depth'])
        windows.add(w)
        by_dw[(d['depth'], w)].add((d.get('game'), d.get('ply')))
    depths = sorted({k[0] for k in by_dw})
    coupled = all(d.get('window', d['depth']) == d['depth'] for d in drops)
    if coupled:
        print('NOTE: this run has window == depth for every flag, so the '
              'deepening test is NOT AVAILABLE.\n      Re-run with --windows '
              'to score the same window at several depths.\n')

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
            spanned = {(g, tc + k) for k in range(d.get('window', dep))}
        w = d.get('window', dep)
        deeper = [x for x in depths if x > dep]
        # Same window, greater depth. Keying on depth alone compared different
        # windows and made this bucket meaningless.
        cured = (not coupled) and deeper and all(
            (g, ply) not in by_dw[(x, w)] for x in deeper)

        if spanned & reach:
            # NOT an enumeration gap, despite what this bucket was called for
            # the whole first campaign. Robi adjudicated the survivors through
            # the real UI and the count of GENUINE gaps is ZERO: the 432
            # unreachable turns are 237 fat records (after-state is a stored
            # snapshot, never derived from actions), 134 no-op sacrifices (a
            # `sacrifice` names a sigil node the cast already cleared, so a
            # mandatory cost goes unpaid), and 61 transcription glitches ruled
            # unreachable by any legal turn. `applyAITurn` applies a stored
            # action list WITHOUT validating legality, so a corrupt transcript
            # replays "cleanly" and its after-state gets stored.
            #
            # So a window straddling one of these did not happen. The
            # 0.5-stones-per-half-move envelope is a statement about a real
            # half-move sequence; across an illegal jump an arbitrarily large
            # drop is consistent with a perfect eval AND perfect enumeration.
            # These flags must be EXCLUDED, not attributed -- they were 37.9%
            # of the first run's flags, and calling them enumeration gaps
            # blamed the enumerator for the recorder.
            #
            # If this bucket ever exceeds the known record damage, THAT is new
            # engine behaviour and worth investigating.
            b = 'CORRUPT RECORD (window never happened; excluded)'
        elif cured:
            b = 'HORIZON EFFECT (deepening cured it)'
        elif coupled:
            b = 'UNATTRIBUTED (no deepening test in this run)'
        else:
            b = 'OTHER (eval wrong, not blind)'
        buckets[b] += 1
        per_depth[dep][b] += 1
        # Recomputed here, not taken from the flag: see --mate-from.
        MATE = 1_000_000
        if d['score1'] <= -MATE and d['score0'] >= args.mate_from * STONE:
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
              f"{fmt_score(d['score0'])} -> lost   {d.get('game')} ply {d.get('ply')}")
    # Magnitude matters: a flag at 0.51/half-move is at the envelope's edge,
    # one at 9.71 is not the same animal.
    print('\n=== by magnitude x cause ===')
    mag = collections.defaultdict(collections.Counter)
    for dp, b, d in worst:
        if d['score1'] <= -1_000_000:
            band = 'flip to proven loss'
        elif dp < 0.75:
            band = '0.50-0.75 (envelope edge)'
        elif dp < 1.0:
            band = '0.75-1.00'
        elif dp < 2.0:
            band = '1.00-2.00'
        else:
            band = '>2.00'
        mag[band][b] += 1
    order = ['0.50-0.75 (envelope edge)', '0.75-1.00', '1.00-2.00', '>2.00',
             'flip to proven loss']
    for band in order:
        if band not in mag:
            continue
        row = mag[band]
        n = sum(row.values())
        print(f'  {band:26s} n={n:6d}  ' +
              '  '.join(f'{k.split()[0]}={v}' for k, v in row.most_common()))

    print('\n=== worst declines ===')
    worst.sort(key=lambda x: -x[0])
    for dp, b, d in worst[:12]:
        print(f"  {dp:+7.2f}/half-move  [{b.split()[0]:11s}] depth {d['depth']} "
              f"{fmt_score(d['score0'])} -> {fmt_score(d['score1'])}  "
              f"{d.get('game')} ply {d.get('ply')}")


if __name__ == '__main__':
    main()
