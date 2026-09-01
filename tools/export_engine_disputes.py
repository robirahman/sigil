"""Turn the engine's two open rules disputes into reviewable before/after cases.

    python -m tools.export_engine_disputes [--out ai/data/engine_disputes.json]
                                           [--inplay-games 200] [--max-cases 200]

Two invariants in `engine/src/tests.rs` fail once `legal_draw` is fixed:

  * **Fury** -- `resolve_outcomes` does not contain the position
    `resolve_spell_at` (the shipped greedy resolver) produces. Either the
    enumeration is missing a legal branch, in which case **the search is blind to a
    legal move**, or the greedy resolver produces an illegal position, which is
    player-visible.
  * **key_dash** -- `turns_ordered_reasons` promotes dash turns that full
    enumeration rejects. Latent, since `key_dash_reasons` ships at 0, but it blocks
    ever enabling the filter.

Neither can be settled by the engine, because both sides of each disagreement are
engine code. The decider is Robi replaying the transition by hand in the real UI,
which IS the rules oracle. This script prepares that question -- and, first, tries
hard not to ask it:

  TRIAGE 1  the draw itself must be legal (`draw_is_legal`), or the position is
            out of scope for the ruleset;
  TRIAGE 2  the spell must actually be CASTABLE by that colour in that position.
            `tests.rs` calls `cast_clear_and_refill` unconditionally, so the
            invariant is asserted even where the cast is illegal -- such a
            disagreement is vacuous and the TEST is what needs fixing;
  TRIAGE 3  the enumeration must not have hit `OUTCOME_CAP`. A truncated list
            legitimately omits outcomes, so again there is no rules question.

and then measures how often each invariant fails in positions that ACTUALLY OCCUR,
because `tests.rs` assigns random stone masks and a disagreement in an unreachable
position costs nothing. That frequency, not the synthetic count, is what sizes the
bug.

Why the draws are recomputed here: these failures appear only under the FIXED
`legal_draw` (SplitMix64 seeding). The old `seed | 1` made seeds 2n and 2n+1
identical and left half the draw space unreachable, which is what hid these bugs.
Deriving the fixed draw in Python lets this run against the engine as shipped on
`main`, without depending on the unmerged fix branch.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sigil_engine as se
from notation import NODE_ORDER

M64 = (1 << 64) - 1
ALL39 = (1 << 39) - 1

# engine/src/spells_meta.rs
RITUALS = [0, 1, 2, 3, 4, 15, 18, 21, 24, 27, 30, 33, 36]
SORCERIES = [5, 6, 7, 8, 9, 16, 19, 22, 25, 28, 31, 34, 37]
CHARMS = [10, 11, 12, 13, 14, 17, 20, 23, 26, 29, 32, 35, 38]


def _xorshift(state):
    """The engine's xorshift64, as a generator of successive states."""
    s = state
    while True:
        s ^= (s << 13) & M64
        s ^= s >> 7
        s ^= (s << 17) & M64
        s &= M64
        yield s


def _splitmix_state(seed):
    """The FIXED `legal_draw` seeding: SplitMix64's finalizer, all 64 bits."""
    s = (seed + 0x9E3779B97F4A7C15) & M64
    s = ((s ^ (s >> 30)) * 0xBF58476D1CE4E5B9) & M64
    s = ((s ^ (s >> 27)) * 0x94D049BB133111EB) & M64
    s ^= s >> 31
    return s or 0x9E3779B97F4A7C15


def fixed_legal_draw(seed):
    """`Board::legal_draw(seed)` as it behaves AFTER the seeding fix."""
    nx = _xorshift(_splitmix_state(seed))
    out = [0] * 9
    for slot, pool in ((0, RITUALS), (3, SORCERIES), (6, CHARMS)):
        p = list(pool)
        for i in range(len(p) - 1, 0, -1):
            j = next(nx) % (i + 1)
            p[i], p[j] = p[j], p[i]
        out[slot:slot + 3] = p[:3]
    return out


def make_sfn(red, blue, spell_ids, to_move):
    """Build an SFN for a synthetic position, then let the ENGINE canonicalise it."""
    chars = []
    for i in range(39):
        chars.append('r' if (red >> i) & 1 else ('b' if (blue >> i) & 1 else '.'))
    names = ','.join(se.SPELL_NAMES[i].replace(' ', '_') for i in spell_ids)
    sfn = f"{''.join(chars)}/{names} {'r' if to_move == 'red' else 'b'} 0 0:0 -:- -:- b1"
    b = se.Board.from_sfn(sfn)
    got = b.stones
    if got != (red, blue):
        raise AssertionError(
            f"SFN round-trip changed the stones: wrote {(red, blue)}, read {got}. "
            "Bit order and NODE_ORDER have diverged; fix that before trusting any "
            "case emitted here.")
    return b.to_sfn(), b


def fury_cases(seeds=range(1, 60)):
    """Reproduce the greedy-vs-enumeration invariant, with triage."""
    out = []
    for seed in seeds:
        draw = fixed_legal_draw(seed)
        nx = _xorshift(seed | 1)          # the TEST's own stone randomisation
        r = next(nx) & ALL39
        bl = next(nx) & ALL39 & ~r
        try:
            sfn, base = make_sfn(r, bl, draw, 'red')
        except Exception as e:
            out.append({'kind': 'fury', 'seed': seed, 'verdict': f'unbuildable: {e}'})
            continue
        for pos in range(9):
            for colour in ('red', 'blue'):
                rec = {'kind': 'fury', 'seed': seed, 'pos': pos, 'colour': colour,
                       'spell': se.SPELL_NAMES[draw[pos]], 'sfnBefore': sfn,
                       'spellIds': draw}
                b = se.Board.from_sfn(sfn)
                if not b.draw_is_legal():
                    rec['verdict'] = 'vacuous: draw out of scope'
                    out.append(rec); continue
                # TRIAGE 2 -- is this cast even legal here?
                if draw[pos] not in b.castable(colour, True, True, False):
                    rec['verdict'] = 'vacuous: spell not castable in this position'
                    out.append(rec); continue
                enum = se.Board.from_sfn(sfn).cast_outcomes(pos, colour)
                # TRIAGE 3 -- a truncated enumeration legitimately omits outcomes
                if len(enum) >= se.OUTCOME_CAP:
                    rec['verdict'] = f'vacuous: enumeration truncated at {len(enum)}'
                    out.append(rec); continue
                g = se.Board.from_sfn(sfn)
                g.cast_clear_and_refill(pos, colour)
                g.resolve_spell_at(pos, colour)
                greedy = g.stones
                rec['nOutcomes'] = len(enum)
                if greedy in enum:
                    rec['verdict'] = 'ok'
                else:
                    rec['verdict'] = 'GENUINE'
                    rec['sfnAfter'] = g.to_sfn()
                out.append(rec)
    return out


def keydash_cases(seeds=range(0, 24)):
    """Reproduce the key_dash promotion invariant, with triage."""
    out = []
    for seed in seeds:
        draw = fixed_legal_draw(seed)
        r = (0b1010110110101 ^ ((seed * 2654435761) & M64)) & ALL39
        bl = ((0b0101001001010 << 13) ^ ((seed * 40503) & M64)) & ALL39 & ~r
        try:
            sfn, base = make_sfn(r, bl, draw, 'red')
        except Exception as e:
            out.append({'kind': 'keydash', 'seed': seed, 'verdict': f'unbuildable: {e}'})
            continue
        b = se.Board.from_sfn(sfn)
        if not b.draw_is_legal():
            out.append({'kind': 'keydash', 'seed': seed, 'sfnBefore': sfn,
                        'verdict': 'vacuous: draw out of scope'})
            continue
        turns, stats = b.enumerate_turns(), b.enum_stats()
        if stats[2]:                      # EnumStats.truncated
            out.append({'kind': 'keydash', 'seed': seed, 'sfnBefore': sfn,
                        'verdict': 'vacuous: full enumeration truncated'})
            continue
        legal = {json.dumps(t) for t in turns}
        promoted = b.turns_ordered_reasons('red', 24, se.REASONS_ALL, 40)
        for t in promoted:
            if not any(a[0] == 'dash' for a in t):
                continue
            rec = {'kind': 'keydash', 'seed': seed, 'colour': 'red',
                   'sfnBefore': sfn, 'spellIds': draw, 'actions': t}
            if json.dumps(t) in legal:
                rec['verdict'] = 'ok'
            else:
                rec['verdict'] = 'GENUINE'
                # the position the disputed turn claims to reach
                a = se.Board.from_sfn(sfn)
                try:
                    a.apply_turn_tuples(t, 'red')
                    rec['sfnAfter'] = a.to_sfn()
                except Exception as e:
                    rec['sfnAfter'] = None
                    rec['applyError'] = str(e)
            out.append(rec)
    return out


def inplay_frequency(n_games, play_ms=200):
    """How often does each invariant fail in positions that ACTUALLY OCCUR?

    `tests.rs` uses random stone masks. A resolver disagreement in a position no
    game can reach costs nothing, so this is the number that sizes the bugs.
    """
    fury_fail = keydash_fail = positions = 0
    for g in range(n_games):
        b = se.Board(se.Board.legal_draw(7_000_000 + g), "standard")
        b.setup_initial()
        hist = []
        for _ply in range(140):
            positions += 1
            side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
            sfn = b.to_sfn()
            probe0 = se.Board.from_sfn(sfn)
            castable_ids = set(probe0.castable(side, True, True, False))
            slot_ids = probe0.spell_ids()
            for pos in range(9):
                if slot_ids[pos] not in castable_ids:
                    continue
                enum = se.Board.from_sfn(sfn).cast_outcomes(pos, side)
                if len(enum) >= se.OUTCOME_CAP:
                    continue
                gg = se.Board.from_sfn(sfn)
                gg.cast_clear_and_refill(pos, side)
                gg.resolve_spell_at(pos, side)
                if gg.stones not in enum:
                    fury_fail += 1
            probe = se.Board.from_sfn(sfn)
            st = probe.enum_stats()
            if not st[2]:
                legal = {json.dumps(t) for t in probe.enumerate_turns()}
                for t in probe.turns_ordered_reasons(side, 24, se.REASONS_ALL, 40):
                    if any(a[0] == 'dash' for a in t) and json.dumps(t) not in legal:
                        keydash_fail += 1
                        break
            r = b.play_best(play_ms, 64, 20, 16, 4, hist, "tfit", False, 1 << 62)
            hist.append(b.key_js)
            if r[3]:
                break
    return {'games': n_games, 'positions': positions,
            'fury_failures': fury_fail, 'keydash_failures': keydash_fail}


def to_review_cases(recs):
    """Emit GENUINE records in the schema `tools/gen_unmatched_review.py` consumes."""
    cases = []
    for i, r in enumerate(x for x in recs if x.get('verdict') == 'GENUINE'):
        if not r.get('sfnAfter'):
            continue
        names = [se.SPELL_NAMES[j] for j in r['spellIds']]
        if r['kind'] == 'fury':
            key = f"fury-s{r['seed']}-p{r['pos']}-{r['colour']}"
            sig = (f"FURY: greedy resolver produced a position the enumeration "
                   f"lacks (spell {r['spell']}, {r['nOutcomes']} outcomes enumerated)")
            question = ("Cast this spell and reach the AFTER board, or flag it "
                        "unreachable.")
        else:
            key = f"keydash-s{r['seed']}-{i}"
            sig = "KEY_DASH: promoted a dash turn full enumeration rejects"
            question = ("Enter EXACTLY the listed actions. If the UI refuses one, "
                        "flag unreachable.")
        cases.append({
            'key': key, 'turnNumber': 1, 'color': r['colour'],
            'sfnBefore': r['sfnBefore'], 'sfnAfter': r['sfnAfter'],
            'spellNames': names, 'variant': 'standard',
            'cast': r.get('spell'), 'redPlayer': 'synthetic', 'bluePlayer': 'synthetic',
            'stateBefore': question, 'stateAfter': sig,
            'disputedActions': r.get('actions'),
            # the answer we actually want when no sequence works
            'flagAs': 'unreachable',
            'cluster': 1 if r['kind'] == 'fury' else 2, 'clusterSize': 0,
            'memberIndex': i + 1, 'signature': sig,
        })
    for c in cases:
        c['clusterSize'] = sum(1 for d in cases if d['cluster'] == c['cluster'])
    return cases


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='ai/data/engine_disputes.json')
    ap.add_argument('--inplay-games', type=int, default=0,
                    help='self-play games to sweep for in-play frequency (slow)')
    ap.add_argument('--max-cases', type=int, default=200)
    args = ap.parse_args()

    print("fixed legal_draw sanity: consecutive seeds must differ")
    d = [tuple(fixed_legal_draw(s)) for s in range(20)]
    assert len(set(d)) == 20, "the recomputed draw still collides"
    print(f"  20/20 distinct, and legal_draw(0) = {[se.SPELL_NAMES[i] for i in d[0]]}")

    recs = fury_cases() + keydash_cases()
    from collections import Counter
    tally = Counter(r['verdict'].split(':')[0] for r in recs)
    print("\ntriage over synthetic test positions")
    for k, v in sorted(tally.items(), key=lambda kv: -kv[1]):
        print(f"  {k:12s} {v}")
    genuine = [r for r in recs if r['verdict'] == 'GENUINE']
    print(f"\n{len(genuine)} case(s) survive triage and need a ruling")
    for r in genuine[:20]:
        tag = (f"pos {r['pos']} {r['spell']}" if r['kind'] == 'fury'
               else f"actions {r.get('actions')}")
        print(f"  {r['kind']:8s} seed {r['seed']:3d} {r.get('colour','-'):5s} {tag}")

    if args.inplay_games:
        print(f"\nsweeping {args.inplay_games} real self-play games ...")
        f = inplay_frequency(args.inplay_games)
        print(f"  {f}")
        if f['positions']:
            print(f"  fury    {f['fury_failures'] / f['positions'] * 10000:.2f} "
                  f"per 10,000 real positions")
            print(f"  keydash {f['keydash_failures'] / f['positions'] * 10000:.2f} "
                  f"per 10,000 real positions")

    cases = to_review_cases(recs)[:args.max_cases]
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump({'cases': cases, 'totalUnmatched': len(cases),
                   'triage': dict(tally), 'records': recs}, fh, indent=1)
    print(f"\nwrote {len(cases)} review case(s) -> {args.out}")
    print("next:  python -m tools.gen_unmatched_review --cases "
          f"{args.out} --out docs/dev/engine-disputes.html")


if __name__ == '__main__':
    main()
