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


RUST_UIDS = ('__ai_rust',)          # the engine under audit


def _who(uid):
    if not uid:
        return 'unknown'
    if uid.startswith(RUST_UIDS):
        return 'rust'
    if uid.startswith('__ai'):
        return uid.strip('_')           # an OLDER engine: still a useful source
    return 'human'


def dump_lines(path, batch=150, skip_rust_vs_rust=True, limit=0,
               rust_only=False):
    """Hydrate a raw completed_games dump into per-turn SFN pairs.

    Slim records store INPUT TOKENS, not positions, so they are replayed through
    `ai.replay_bridge.hydrate_records` -> the browser engine's reconstructGameLog.
    That replayer is the authority here: it is the code that actually accepted these
    human inputs, and the repo deliberately keeps no second Python port so the two
    cannot drift. If Rust's `enumerate_turns` cannot reproduce a turn the JS engine
    accepted, that is a proven Rust generator gap.

    Rust-vs-Rust games are skipped: a turn the Rust engine played is a turn it
    generated, so its own games cannot reveal its own missing moves -- the same
    reason self-play is useless for check B.
    """
    from ai.replay_bridge import hydrate_records
    with open(path, encoding='utf-8') as fh:
        games = json.load(fh)
    items = list(games.items()) if isinstance(games, dict) else list(enumerate(games))
    keep = []
    skipped = Counter()
    for key, g in items:
        if not isinstance(g, dict) or not g.get('turns'):
            skipped['no turns'] += 1
            continue
        r, b = _who(g.get('redUid')), _who(g.get('blueUid'))
        # Rust-vs-Rust is normally skipped: the engine cannot play a turn it
        # failed to generate, so those games carry no evidence of a gap.
        # `rust_only` inverts that, and is the CONTROL for this whole audit:
        # every one of those turns CAME OUT of `enumerate_turns`, so after a
        # faithful round-trip through Firebase, the replay bridge and SFN it
        # must come back 100% reachable. Whatever rate it shows instead is
        # harness error, and it is the amount to subtract from the real-game
        # rate before believing any of it.
        if r == 'rust' and b == 'rust':
            if not rust_only:
                skipped['rust vs rust'] += 1
                continue
        elif rust_only:
            skipped['not rust vs rust'] += 1
            continue
        if not g.get('setupSfn') and not (
                isinstance(g['turns'], list) and g['turns'] and g['turns'][0].get('sfnBefore')):
            skipped['no setupSfn'] += 1
            continue
        keep.append((key, g, r, b))
    if limit:
        keep = keep[:limit]
    print(f"  {len(keep)} games to hydrate; skipped {dict(skipped)}", flush=True)

    for start in range(0, len(keep), batch):
        chunk = keep[start:start + batch]
        recs = [{'spellNames': g.get('spellNames') or [],
                 'variant': g.get('variant') or 'standard',
                 'setupSfn': g.get('setupSfn'), 'finalSfn': g.get('finalSfn'),
                 'turns': g['turns']} for _k, g, _r, _b in chunk]
        try:
            res = hydrate_records(recs)
        except Exception as e:
            print(f"  hydration failed for batch at {start}: {e}", flush=True)
            continue
        for (key, g, r, b), out in zip(chunk, res):
            if not isinstance(out, dict) or not out.get('ok'):
                continue
            turns = out.get('turns') or []
            line, movers, pairs = [], [], []
            for t in turns:
                if not (t.get('sfnBefore') and t.get('sfnAfter')):
                    continue
                who = r if t.get('color') == 'red' else b
                line.append((t['sfnBefore'], []))
                movers.append(who)
                # Each turn's OWN before/after pair. Chaining consecutive
                # sfnBefore values instead looked identical to an enumeration
                # gap whenever a record held an intra-turn snapshot or a gap --
                # one smoke flag showed 'r 21 -> r 21', same mover and same turn
                # number, which no single turn can produce.
                pairs.append({'before': t['sfnBefore'], 'after': t['sfnAfter'],
                              'color': t.get('color'), 'turnNumber': t.get('turnNumber'),
                              'playedBy': who,
                              # the replayer's own action list: when the engine
                              # cannot generate the turn, this is the sequence
                              # to hand Robi to re-enter in the real UI.
                              'actions': t.get('actions') or t.get('tokens')})
            if turns and turns[-1].get('sfnAfter'):
                line.append((turns[-1]['sfnAfter'], []))
                movers.append(None)
            if len(line) > 2:
                yield key, line, {'movers': movers, 'red': r, 'blue': b,
                                  'winner': g.get('winner'), 'pairs': pairs}
        print(f"  hydrated {min(start + batch, len(keep))}/{len(keep)} games", flush=True)


def check_reachability(pairs, enum_cap=250_000):
    """CHECK B: was each played turn reproducible by `enumerate_turns`?

    Walks each turn's OWN before/after pair, and screens out record artefacts the
    same way tools/gen_unmatched_review.py does -- otherwise a recording gap is
    indistinguishable from a missing move:

      * the mover's own actions can never ADD enemy stones, so a growth in the
        enemy count means the pair spans more than one turn;
      * a pair whose two halves disagree about whose turn it is, or that share a
        turn number, is not one turn of play.

    Compares STONE LAYOUT only: that is what a turn's actions determine, and the
    replayer's turn bookkeeping follows its own convention.
    """
    misses = []
    for p in pairs:
        before, after = p['before'], p['after']
        try:
            bt, at = before.split(), after.split()
            mover = 'red' if bt[1] == 'r' else 'blue'
            enemy = 'b' if mover == 'red' else 'r'
            bs, as_ = before.split('/')[0], after.split('/')[0]
            if as_.count(enemy) > bs.count(enemy):
                continue                      # spans more than one turn
            b = se.Board.from_sfn(before)
            # One native call: enumerate AND compare in Rust. Looping in Python
            # cost ~5 s per position, because full enumeration expands every cast
            # outcome and a midgame position yields 9,000-54,000 turns.
            tgt = se.Board.from_sfn(after).stones
            reachable, n_turns, trunc = b.layout_reachable(
                mover, tgt[0], tgt[1], enum_cap)
            if trunc:
                continue                      # truncated: not a complete reference
            if not reachable:
                # WHO played it decides what a miss means: a turn played by a HUMAN
                # or an OLDER JS engine that Rust cannot generate is a Rust
                # generator gap; one played by Rust points at replay/identity.
                mi = 0 if mover == 'red' else 1
                # How many spells the mover cast in this ONE turn. The replay
                # bridge reports counter jumps of 2 and 3, so the real rules
                # allow multiple casts per turn; if Rust only ever emits one,
                # that is a systematic gap rather than a per-spell bug.
                try:
                    n_casts = (int(at[3].split(':')[mi])
                               - int(bt[3].split(':')[mi]))
                except Exception:
                    n_casts = None
                misses.append({'turnNumber': p.get('turnNumber'), 'mover': mover,
                               'playedBy': p.get('playedBy', 'unknown'),
                               'sfnBefore': before, 'sfnAfter': after,
                               'nCasts': n_casts, 'actions': p.get('actions'),
                               'nEnumerated': n_turns})
        except Exception as e:
            misses.append({'turnNumber': p.get('turnNumber'), 'error': str(e),
                           'sfnBefore': before})
    return misses


def check_eval_drops(line, depths, stride, per_ply_limit, surprise_from):
    """CHECK A: score at ply i and ply i+d, same side to move, and compare.

    Two calibration lessons from the first run, which flagged 22 cases in 6 games
    and was almost all noise:

    * MATE SCORES ARE +-1e7, so leaving them in the arithmetic produced drops of
      50,000 stones/ply and swamped everything. They are clamped for the gradual
      metric and handled separately.
    * A GAME ENDING IS NOT A DEFECT. A position already scored at -1.5 that becomes
      a proven loss two plies later is an ordinary horizon effect. The reported
      symptom is narrower and much more specific: the engine said it was FINE or
      WINNING and then lost. So a mate flip only counts when the earlier score was
      at least `surprise_from` stones -- default 0, i.e. the engine was not behind.
    """
    out = []
    clamp = 20 * STONE          # ignore magnitudes past +-20 stones for the slope
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
            # the engine thought it was OK, and then it was lost: the reported bug
            mate_flip = (s1 <= -MATE) and (s0 >= surprise_from * STONE)
            c0, c1 = max(-clamp, min(clamp, s0)), max(-clamp, min(clamp, s1))
            drop_per_ply = (c0 - c1) / d / STONE
            if not (mate_flip or drop_per_ply > per_ply_limit):
                continue
            out.append({'ply': i, 'depth': d, 'score0': s0, 'score1': s1,
                        'drop': s0 - s1, 'dropPerPly': drop_per_ply,
                        'clampedFrom': c0 / STONE, 'clampedTo': c1 / STONE,
                        'mateFlip': mate_flip,
                        'sfnBefore': sfn0, 'sfnAfter': sfn1,
                        'mover': 'red' if sfn0.split()[1] == 'r' else 'blue'})
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
    # Rows recording an exception (an out-of-scope spell, unrepresentable
    # state) have no 'mover' and no 'sfnAfter'. Indexing them raised
    # KeyError AFTER every flag had printed, so 70 of 88 shards wrote no
    # JSON at all. They are not adjudicable positions -- drop them here.
    recs = [r for r in recs if r.get('mover') and r.get('sfnAfter')]
    for i, r in enumerate(recs):
        sfn = r['sfnBefore']
        spells = [s.replace('_', ' ') for s in sfn.split('/')[1].split()[0].split(',')]
        if kind == 'reach':
            sig = (f"UNREACHABLE: the position played at turn "
                   f"{r.get('turnNumber', r.get('ply', '?'))} is not produced by any "
                   f"of the {r.get('nEnumerated','?')} enumerated turns — the engine "
                   f"cannot generate a move that WAS legally played "
                   f"(by {r.get('playedBy','?')})")
        else:
            sig = (f"EVAL DROP: depth {r['depth']} score {r['score0']/STONE:+.2f} -> "
                   f"{r['score1']/STONE:+.2f} over {r['depth']} half-moves "
                   f"({r['dropPerPly']:+.2f}/ply)"
                   + (" — FLIPPED INTO A PROVEN LOSS" if r.get('mateFlip') else ""))
        cases.append({
            'key': f"{kind}-{r.get('playedBy','?')}-{i}",
            'turnNumber': int(sfn.split()[2]),
            'color': r['mover'], 'sfnBefore': sfn, 'sfnAfter': r['sfnAfter'],
            'spellNames': spells, 'variant': 'standard', 'cast': None,
            'redPlayer': 'audit', 'bluePlayer': 'audit',
            'stateBefore': cast_between(sfn, r['sfnAfter']), 'stateAfter': sig,
            'matchOn': 'stones', 'flagAs': 'unreachable',
            'cluster': 1 if kind == 'reach' else 2, 'clusterSize': len(recs),
            'memberIndex': i + 1, 'signature': sig,
        })
    return cases


def time_depths(depths, n=6, ev='tfit'):
    """Cost per position at each depth, so the run is SIZED and not guessed.

    Sizing E1 off an unmeasured rate cost this project a full restart; the depth
    numbers here are what decide whether depth 8 is affordable at all.
    """
    import time
    b = se.Board(se.Board.legal_draw(4242), "standard")
    b.setup_initial()
    hist = []
    for _ in range(8):                  # get off the opening
        r = b.play_best(80, 64, 20, 16, se.DEFAULT_WIDTH_SCALE, hist, ev, False,
                        MERGE_OFF, adaptive=shipped_adaptive())
        hist.append(b.key_js)
        if r[3]:
            break
    sfn = b.to_sfn()
    print("cost per position, shipped width_scale/adaptive:")
    per = {}
    for d in depths:
        t0 = time.perf_counter()
        for _ in range(n):
            score_at(sfn, d, hist, ev)
        dt = (time.perf_counter() - t0) / n
        per[d] = dt
        print(f"  depth {d}: {dt:8.3f} s/position")
    return per


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--selfplay', type=int, default=0)
    ap.add_argument('--games', default=None)
    ap.add_argument('--play-ms', type=int, default=200)
    ap.add_argument('--depths', default='2,4,6',
                    help="comma OR colon separated. Use COLONS in a cloud arm: "
                         "runner.sh splits arms on spaces and each arm's args on "
                         "commas, so '2,4,6' arrives as three separate arguments.")
    ap.add_argument('--stride', type=int, default=1)
    ap.add_argument('--checks', default='ab', choices=['a', 'b', 'ab'],
                    help="which checks to run. 'b' (reachability) is cheap and is "
                         "the decisive test of whether the engine can generate a "
                         "played turn; 'a' (eval drop) is dominated by depth-6 "
                         "search at ~17 s/position. Coupling them made the cheap, "
                         "decisive answer wait on the expensive, secondary one.")
    ap.add_argument('--enum-cap', type=int, default=250_000,
                    help='cap on turns enumerated per position for check B. Some '
                         'positions enumerate enormously; past the cap the answer '
                         'is "cannot tell" and the position is skipped, which is '
                         'reported rather than silently counted as reachable.')
    ap.add_argument('--surprise-from', type=float, default=0.0,
                    help='a mate flip only counts if the EARLIER score was at least '
                         'this many stones. 0 = the engine was not behind. This is '
                         'what separates the reported bug from a game simply ending.')
    ap.add_argument('--per-ply-limit', type=float, default=0.5,
                    help='stones per HALF-MOVE that count as a defect. 0.5 = one '
                         'stone per full move (both sides). Raise to 1.0 to read '
                         '"1 per half-move" instead.')
    ap.add_argument('--out', default='ai/data/eval_drop_audit.json')
    ap.add_argument('--time-only', action='store_true',
                    help='just measure cost per position per depth and exit')
    ap.add_argument('--limit-games', type=int, default=0)
    ap.add_argument('--rust-only', action='store_true',
                    help='CONTROL: audit ONLY Rust-vs-Rust games. Those turns\n'
                         'came out of the enumerator, so anything unreachable\n'
                         'there is harness error, not an engine gap.')
    ap.add_argument('--shard', type=int, default=0,
                    help='take every Nth game starting at $SIGIL_SHARD_OFF/1000')
    ap.add_argument('--shards', type=int, default=1)
    ap.add_argument('--hydrate-out', default=None,
                    help='hydrate the dump, write the per-turn SFN lines, and exit. '
                         'Hydration needs node and the browser engine files; doing '
                         'it ONCE centrally means fleet workers need neither, and '
                         'the same games are not replayed hundreds of times.')
    ap.add_argument('--lines', default=None,
                    help='read pre-hydrated lines instead of hydrating')
    args = ap.parse_args()
    depths = [int(x) for x in args.depths.replace(':', ',').split(',') if x]
    assert all(d % 2 == 0 for d in depths), "depths must be EVEN so the side to move matches"
    if args.time_only:
        time_depths(depths)
        return

    if args.hydrate_out:
        out = []
        for key, line, meta in dump_lines(args.games, limit=args.limit_games,
                                          rust_only=args.rust_only):
            out.append({'key': key, 'sfns': [p[0] for p in line], 'meta': meta})
        os.makedirs(os.path.dirname(args.hydrate_out) or '.', exist_ok=True)
        with open(args.hydrate_out, 'w', encoding='utf-8') as fh:
            json.dump(out, fh)
        n = sum(len(x['sfns']) for x in out)
        print(f"hydrated {len(out)} games / {n} positions -> {args.hydrate_out}")
        return

    if args.lines:
        path = args.lines
        if path.startswith('gs://'):
            # Fetch with the VM's own service-account token. Keeps the fleet
            # runner unchanged: no extra sparse-checkout, no node, no new metadata.
            import urllib.request, urllib.parse
            bucket, _, obj = path[5:].partition('/')
            tok = json.load(urllib.request.urlopen(urllib.request.Request(
                "http://metadata.google.internal/computeMetadata/v1/instance/"
                "service-accounts/default/token",
                headers={"Metadata-Flavor": "Google"})))["access_token"]
            u = (f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/"
                 + urllib.parse.quote(obj, safe='') + "?alt=media")
            data = urllib.request.urlopen(urllib.request.Request(
                u, headers={"Authorization": "Bearer " + tok})).read()
            # Per-process path. All ~90 workers on a VM fetch this, and a
            # shared name means one truncates the file while another reads
            # it -- every shard died with JSONDecodeError on an empty file.
            path = f"/tmp/hydrated_{os.environ.get('SIGIL_SHARD_OFF','0')}_{os.getpid()}.json"
            open(path, 'wb').write(data)
            print(f"fetched {args.lines} ({len(data)} bytes)", flush=True)
        with open(path, encoding='utf-8') as fh:
            pre = json.load(fh)
        src = ((x['key'], [(s, []) for s in x['sfns']], x.get('meta')) for x in pre)
        label = f"{len(pre)} pre-hydrated games from {args.lines}"
        do_reach = True
    elif args.games:
        src = dump_lines(args.games, limit=args.limit_games,
                         rust_only=args.rust_only)
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
    shard_i = int(os.environ.get('SIGIL_SHARD_OFF', '0')) // 1000
    seen_games = -1
    for key, line, meta in src:
        seen_games += 1
        if args.shards > 1 and seen_games % args.shards != shard_i % args.shards:
            continue
        n_lines += 1
        n_plies += len(line)
        if do_reach and 'b' in args.checks:
            for m in check_reachability((meta or {}).get('pairs') or [],
                                        args.enum_cap):
                m['game'] = key
                misses.append(m)
        for r in ([] if 'a' not in args.checks else
                  check_eval_drops(line, depths, args.stride,
                                   args.per_ply_limit, args.surprise_from)):
            r['game'] = key
            drops.append(r)
        if n_lines % 5 == 0:
            print(f"  {n_lines} lines, {n_plies} plies, "
                  f"{len(drops)} eval flags, {len(misses)} unreachable", flush=True)

    print(f"\n=== {n_lines} lines, {n_plies} positions ===")
    if do_reach:
        print(f"CHECK B unreachable played positions: {len(misses)}")
        errs = [m for m in misses if m.get('error')]
        real = [m for m in misses if not m.get('error')]
        # Out-of-scope games swamp the real signal: the shipped engine knows
        # one spell pool, and the RTDB holds games from several. Separating
        # them is the difference between 12% of turns and 3%.
        print(f"  of which OUT OF SCOPE (not engine bugs): {len(errs)}")
        if errs:
            from collections import Counter as _C0
            for k, v in _C0(m['error'] for m in errs).most_common(8):
                print(f"    {v:5d}  {k}")
        print(f"  GENUINE unreachable turns: {len(real)}")
        misses_all, misses = misses, real
        for m in misses[:10]:
            print(f"  {m.get('game')} turn {m.get('turnNumber')} "
                  f"{m.get('mover','?')}: {m.get('nEnumerated','?')} turns "
                  f"enumerated, none match")
        if not misses:
            print("  => every played turn IS enumerable; no enumeration gap here")
        else:
            from collections import Counter as _C
            who = _C(m.get('playedBy', '?') for m in misses)
            print(f"  by who played it: {dict(who)}   "
                  f"(human / an OLDER engine => a RUST GENERATOR GAP)")
            what = _C(cast_between(m['sfnBefore'], m['sfnAfter'])
                      for m in misses if m.get('sfnAfter'))
            print("  by what changed in between:")
            for k, v in what.most_common(10):
                print(f"    {v:5d}  {k}")
            # A counter jump above 1 means the turn cast more than once,
            # which the Rust enumerator may simply never emit.
            nc = _C(m.get('nCasts') for m in misses)
            order = sorted(nc.items(), key=lambda x: (x[0] is None, x[0]))
            print("  by casts made in the turn: " + str(dict(order)))

    # dedup: the same (game, ply, depth) must appear once
    seen, uniq = set(), []
    for r in drops:
        k = (r.get('game'), r['ply'], r['depth'])
        if k in seen:
            continue
        seen.add(k); uniq.append(r)
    drops = uniq
    print(f"\nCHECK A eval-drop flags: {len(drops)}")
    mate = [r for r in drops if r['mateFlip']]
    print(f"  MATE FLIPS from a non-losing score (the reported bug): {len(mate)}")
    print(f"  gradual drops over {args.per_ply_limit} stones/half-move: "
          f"{len(drops) - len(mate)}")
    by_depth = Counter(r['depth'] for r in drops)
    print(f"  by depth: {dict(sorted(by_depth.items()))}")
    if drops:
        worst = sorted(drops, key=lambda r: -r['dropPerPly'])[:10]
        print("  worst:")
        for r in worst:
            tag = 'MATE FLIP' if r['mateFlip'] else f"{r['dropPerPly']:+.2f}/ply"
            to = 'LOSS' if r['score1'] <= -MATE else f"{r['clampedTo']:+.2f}"
            print(f"    d{r['depth']} ply {r['ply']:3d} {r['mover']:5s} "
                  f"{r['clampedFrom']:+7.2f} -> {to:>8s}  {tag:>12s}  "
                  f"[{cast_between(r['sfnBefore'], r['sfnAfter'])}]")
        # Robi named Seal of Destruction; group so a culprit spell is visible.
        g = defaultdict(int)
        for r in drops:
            g[cast_between(r['sfnBefore'], r['sfnAfter'])] += 1
        print("  flags by what changed in between:")
        for k, v in sorted(g.items(), key=lambda kv: -kv[1])[:8]:
            print(f"    {v:5d}  {k}")

    # The fleet runner uploads *.log and *.npz, not *.json, so every finding is
    # also printed as a FLAG line. That makes the shard log self-sufficient and
    # survives a watchdog kill, the same reason generation shards checkpoint.
    for m in misses:
        print("FLAG " + json.dumps({'kind': 'reach', **m}), flush=True)
    for r in drops:
        print("FLAG " + json.dumps({'kind': 'drop', **r}), flush=True)

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
