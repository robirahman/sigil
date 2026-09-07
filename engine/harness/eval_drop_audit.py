"""Find where the engine's own evaluation is contradicted by what happens next.

    eval_drop_audit.py --selfplay 200 [--depths 2,4,6] [--stride 1]
    eval_drop_audit.py --games ai/data/completed_games_raw.json [--depths 2,4,6]

Two symptoms prompted this (Robi, 2026-09-07):

  * the engine announced ~+0.5 in its favour and missed a mate-in-one against it;
  * it filled Seal of Destruction and immediately lost, without bordering or
    destroying anything.

CHECK A -- EVAL DROP (Robi's design). Score every position to depth d, fast-forward
d HALF-MOVES along the line actually played, score again, and compare. d is even, so
the same side is to move both times and the two negamax scores share a perspective.
A drop of ~1 stone per turn is not automatically a defect: at low depth the opponent
may be making moves whose payoff lies past the horizon. A drop much larger than that
says the opponent did something good the engine did not know was possible.

CHECK B -- REACHABILITY. For each turn actually played, is the resulting position
reachable by ANY turn `enumerate_turns` produces from the position before it? If
not, the engine cannot generate a move that was legally played, which is a proven
enumeration gap rather than an inference from an eval swing.

WHY BOTH, AND WHY CHECK B NEEDS REAL GAMES: in self-play the engine is both players,
so it only ever plays turns it generated -- a missing turn is never played and never
punished. Self-play can therefore surface EVALUATION errors but NOT enumeration gaps.
Check B is only meaningful on games with a non-engine opponent, i.e. the site's
recorded human games. Run `--selfplay` for check A and `--games` for both.

Flagged positions are written in the schema `tools/gen_unmatched_review.py --cases`
consumes, so anything ambiguous goes straight into the adjudication page.
"""

import argparse
import json
import os
import sys
from collections import Counter, defaultdict

_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(os.path.dirname(_HERE)))

import sigil_engine as se

MERGE_OFF = 1 << 62
MATE = 1_000_000          # |score| above this is a proven win/loss, not a heuristic
STONE = 100               # centistones per stone


def shipped_adaptive():
    """The shipped widening config, from the ENGINE -- never restated here."""
    return tuple(se.SHIPPED_ADAPTIVE) if hasattr(se, 'SHIPPED_ADAPTIVE') else (0.10, 2, 6)


def score_at(sfn, depth, hist, ev='tfit'):
    """Fixed-depth score for the side to move, at the SHIPPED search config.

    Uses play_best because `search()` cannot select an eval and would silently run
    whatever Search::new defaults to -- the restated-default trap this project has
    paid for three times.
    """
    b = se.Board.from_sfn(sfn)
    r = b.play_best(0, depth, 20, 16, se.DEFAULT_WIDTH_SCALE, list(hist), ev,
                    False, MERGE_OFF, adaptive=shipped_adaptive())
    return int(r[5])


def selfplay_lines(n_games, play_ms, ev='tfit'):
    """Play games at the shipped config, recording the SFN at every ply."""
    for g in range(n_games):
        b = se.Board(se.Board.legal_draw(8_000_000 + g), "standard")
        b.setup_initial()
        hist, line = [], []
        for _ply in range(140):
            line.append((b.to_sfn(), list(hist)))
            r = b.play_best(play_ms, 64, 20, 16, se.DEFAULT_WIDTH_SCALE, hist, ev,
                            False, MERGE_OFF, adaptive=shipped_adaptive())
            hist.append(b.key_js)
            if r[3]:
                line.append((b.to_sfn(), list(hist)))
                break
        yield f"selfplay-{g}", line, r[4]


def dump_lines(path):
    """Turn a Firebase-style completed-games dump into (key, line, winner).

    These are the games that matter for check B: the opponent is a human, so a turn
    the engine cannot enumerate can actually appear.
    """
    with open(path, encoding='utf-8') as fh:
        games = json.load(fh)
    for key, g in (games.items() if isinstance(games, dict) else enumerate(games)):
        if not isinstance(g, dict):
            continue
        turns = g.get('turns')
        if isinstance(turns, dict):
            turns = [v for _k, v in sorted(turns.items(), key=lambda kv: int(kv[0]))]
        if not turns:
            continue
        line = []
        for t in turns:
            if t.get('sfnBefore'):
                line.append((t['sfnBefore'], []))
        last = turns[-1]
        if last.get('sfnAfter'):
            line.append((last['sfnAfter'], []))
        if len(line) > 2:
            yield key, line, g.get('winner')


def check_reachability(line):
    """CHECK B: was each played position reachable by an enumerated turn?

    Compares STONE LAYOUT, because that is what a turn's actions determine; turn
    bookkeeping differs by convention between the recorder and the engine and is not
    what is in dispute.
    """
    misses = []
    for i in range(len(line) - 1):
        before, after = line[i][0], line[i + 1][0]
        try:
            b = se.Board.from_sfn(before)
            mover = 'red' if before.split()[1] == 'r' else 'blue'
            st = b.enum_stats()
            if st[2]:                     # truncated: not a complete reference
                continue
            want = after.split('/')[0]
            reachable = False
            for t in b.enumerate_turns():
                a = se.Board.from_sfn(before)
                try:
                    a.apply_turn_tuples(t, mover)
                except Exception:
                    continue
                if a.to_sfn().split('/')[0] == want:
                    reachable = True
                    break
            if not reachable:
                misses.append({'ply': i, 'mover': mover,
                               'sfnBefore': before, 'sfnAfter': after,
                               'nEnumerated': st[0]})
        except Exception as e:
            misses.append({'ply': i, 'error': str(e), 'sfnBefore': before})
    return misses


def check_eval_drops(line, depths, stride, per_ply_limit):
    """CHECK A: score at ply i and ply i+d, same side to move, and compare."""
    out = []
    for d in depths:
        for i in range(0, len(line) - d, stride):
            sfn0, h0 = line[i]
            sfn1, h1 = line[i + d]
            if sfn0.split()[1] != sfn1.split()[1]:
                continue              # not the same side to move; d must be even
            try:
                s0 = score_at(sfn0, d, h0)
                s1 = score_at(sfn1, d, h1)
            except Exception:
                continue
            drop = s0 - s1
            rec = {'ply': i, 'depth': d, 'score0': s0, 'score1': s1,
                   'drop': drop, 'dropPerPly': drop / d / STONE,
                   'sfnBefore': sfn0, 'sfnAfter': sfn1,
                   'mover': 'red' if sfn0.split()[1] == 'r' else 'blue'}
            # A swing from "I am fine" into a PROVEN loss is the mate-in-one shape.
            rec['mateFlip'] = bool(s0 > -MATE and s1 <= -MATE)
            if rec['mateFlip'] or rec['dropPerPly'] > per_ply_limit:
                out.append(rec)
    return out


def cast_between(sfn0, sfn1):
    """Which side's spell counter moved, as a cheap 'what was cast' signal.

    Robi reports Seal of Destruction specifically, so grouping flags by the spell
    involved is what turns a list of swings into a diagnosis.
    """
    try:
        a, b = sfn0.split(), sfn1.split()
        ca, cb = a[3].split(':'), b[3].split(':')
        la, lb = a[4].split(':'), b[4].split(':')
        changed = []
        for i, side in ((0, 'red'), (1, 'blue')):
            if int(cb[i]) != int(ca[i]):
                changed.append(f"{side} cast (counter {ca[i]}->{cb[i]})")
            if la[i] != lb[i]:
                changed.append(f"{side} lock {la[i]}->{lb[i]}")
        return '; '.join(changed) or 'no cast'
    except Exception:
        return '?'


def to_cases(recs, kind):
    cases = []
    for i, r in enumerate(recs):
        sfn = r['sfnBefore']
        spells = [s.replace('_', ' ') for s in sfn.split('/')[1].split()[0].split(',')]
        if kind == 'reach':
            sig = (f"UNREACHABLE: the position played at ply {r['ply']} is not "
                   f"produced by any of the {r.get('nEnumerated','?')} enumerated "
                   f"turns — the engine cannot generate a move that was played")
        else:
            sig = (f"EVAL DROP: depth {r['depth']} score {r['score0']/STONE:+.2f} -> "
                   f"{r['score1']/STONE:+.2f} over {r['depth']} half-moves "
                   f"({r['dropPerPly']:+.2f}/ply)"
                   + (" — FLIPPED INTO A PROVEN LOSS" if r.get('mateFlip') else ""))
        cases.append({
            'key': f"{kind}-{i}", 'turnNumber': int(sfn.split()[2]),
            'color': r['mover'], 'sfnBefore': sfn, 'sfnAfter': r['sfnAfter'],
            'spellNames': spells, 'variant': 'standard', 'cast': None,
            'redPlayer': 'audit', 'bluePlayer': 'audit',
            'stateBefore': cast_between(sfn, r['sfnAfter']), 'stateAfter': sig,
            'matchOn': 'stones', 'flagAs': 'unreachable',
            'cluster': 1 if kind == 'reach' else 2, 'clusterSize': len(recs),
            'memberIndex': i + 1, 'signature': sig,
        })
    return cases


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--selfplay', type=int, default=0)
    ap.add_argument('--games', default=None)
    ap.add_argument('--play-ms', type=int, default=200)
    ap.add_argument('--depths', default='2,4,6')
    ap.add_argument('--stride', type=int, default=1)
    ap.add_argument('--per-ply-limit', type=float, default=0.5,
                    help='stones per HALF-MOVE that count as a defect. 0.5 = one '
                         'stone per full move (both sides). Raise to 1.0 to read '
                         '"1 per half-move" instead.')
    ap.add_argument('--out', default='ai/data/eval_drop_audit.json')
    args = ap.parse_args()
    depths = [int(x) for x in args.depths.split(',')]
    assert all(d % 2 == 0 for d in depths), "depths must be EVEN so the side to move matches"

    if args.games:
        src = dump_lines(args.games)
        label = f"real games from {args.games}"
        do_reach = True
    else:
        src = selfplay_lines(args.selfplay, args.play_ms)
        label = f"{args.selfplay} self-play games at {args.play_ms}ms"
        do_reach = False
        print("NOTE: self-play cannot surface enumeration gaps -- the engine is both\n"
              "      players, so it never plays a turn it failed to generate. Check B\n"
              "      is skipped; use --games with recorded human games for that.\n")

    print(f"auditing {label}, depths {depths}, "
          f"flagging drops over {args.per_ply_limit} stones/half-move\n")
    drops, misses, n_lines, n_plies = [], [], 0, 0
    for key, line, _winner in src:
        n_lines += 1
        n_plies += len(line)
        if do_reach:
            for m in check_reachability(line):
                m['game'] = key
                misses.append(m)
        for r in check_eval_drops(line, depths, args.stride, args.per_ply_limit):
            r['game'] = key
            drops.append(r)
        if n_lines % 20 == 0:
            print(f"  {n_lines} lines, {n_plies} plies, "
                  f"{len(drops)} eval flags, {len(misses)} unreachable", flush=True)

    print(f"\n=== {n_lines} lines, {n_plies} positions ===")
    if do_reach:
        print(f"CHECK B unreachable played positions: {len(misses)}")
        for m in misses[:10]:
            print(f"  {m.get('game')} ply {m.get('ply')} {m.get('mover','?')}: "
                  f"{m.get('nEnumerated','?')} turns enumerated, none match")
        if not misses:
            print("  => every played turn IS enumerable; no enumeration gap here")

    print(f"\nCHECK A eval-drop flags: {len(drops)}")
    mate = [r for r in drops if r['mateFlip']]
    print(f"  of which flipped into a PROVEN LOSS: {len(mate)}  <- the mate-in-one shape")
    by_depth = Counter(r['depth'] for r in drops)
    print(f"  by depth: {dict(sorted(by_depth.items()))}")
    if drops:
        worst = sorted(drops, key=lambda r: -r['dropPerPly'])[:10]
        print("  worst:")
        for r in worst:
            print(f"    d{r['depth']} ply {r['ply']:3d} {r['mover']:5s} "
                  f"{r['score0']/STONE:+8.2f} -> {r['score1']/STONE:+8.2f} "
                  f"({r['dropPerPly']:+.2f}/ply)  [{cast_between(r['sfnBefore'], r['sfnAfter'])}]")
        # Robi named Seal of Destruction; group so a culprit spell is visible.
        g = defaultdict(int)
        for r in drops:
            g[cast_between(r['sfnBefore'], r['sfnAfter'])] += 1
        print("  flags by what changed in between:")
        for k, v in sorted(g.items(), key=lambda kv: -kv[1])[:8]:
            print(f"    {v:5d}  {k}")

    cases = to_cases(misses, 'reach') + to_cases(
        sorted(drops, key=lambda r: -r['dropPerPly'])[:60], 'drop')
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump({'cases': cases, 'totalUnmatched': len(cases),
                   'drops': drops, 'unreachable': misses,
                   'lines': n_lines, 'positions': n_plies}, fh, indent=1)
    print(f"\nwrote {len(cases)} review case(s) -> {args.out}")


if __name__ == '__main__':
    main()
