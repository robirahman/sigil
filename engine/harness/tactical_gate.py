#!/usr/bin/env python3
"""Tactical regression gate for the two human wins that motivated engine v35
(docs/designs/superhuman-desktop-engine.md; training plan code to-do C1).

    tactical_gate.py [--depths 2,3,4,5,6] [--time-ms 10000] [--eval NAME]
                     [--module PATH] [--json OUT]

Plays the SHIPPED configuration of the `sigil_engine` module it imports, or of
the build at --module (a libsigil_engine.so, as ab_version.py loads a base):
eval `SHIPPED_EVAL`, generator policy `SHIPPED_POLICY`, exploration tail
`SHIPPED_EXPLORE`, widening `SHIPPED_ADAPTIVE`. The history passed to each
search is every earlier position plus the root, as rust-ai.js sends it.

GWSMF5 (engine/data/benchmarks/gwsmf5_hydrated.json), Blue to move on turn 26:
  G1  threat: after Blue's recorded blunder (b11, Charge, b6->b12), Red's own
      search at depth 3, 4 and 5 values the position at least as high (within
      0.5 stones) as the recorded refutation (b6, dash sac c3,c5, Flourish)
      searched one ply shallower. Also reported, not gated: where that exact
      turn sits in the interior node's list (`node_list_rank`, -1 = absent;
      Flourish has many resolutions, so the exact one is often absent).
  G2  search: at depth 5 (and 6 with --deep) and at --time-ms, the engine's
      turn is not the recorded blunder.
QJLGQR (engine/data/benchmarks/qjlgqr_hydrated.json, replayed from
qjlgqr_room.json):
  Q1  Red to move on turn 25, the position on the board for the 2nd time: at
      every depth in --depths and at --time-ms, the engine's turn is not the
      recorded blunder, and Blue has no mate in 1 after it (no reply that
      repeats the position a 3rd time).
  Q2  Blue to move on turn 26: a depth-2 search finds the 3rd-repetition win,
      mate in 1 ply, reaching the repeated position.

Exit status 0 when every check passes, 1 otherwise. Single-threaded: the
browser's Hard tier searches 10 s on 4 threads, so --time-ms 10000 here is a
weaker search than the site's.
"""
import argparse
import importlib.machinery
import importlib.util
import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.join(os.path.dirname(_HERE), 'data', 'benchmarks')


def load_module(path):
    if not path:
        import sigil_engine
        return sigil_engine
    loader = importlib.machinery.ExtensionFileLoader('sigil_engine', path)
    spec = importlib.util.spec_from_file_location('sigil_engine', path, loader=loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def key(sfn):
    """Board + mana, the identity node_list_rank / rank_of_result match on."""
    p = (sfn or '').split()
    return f"{p[0]} {p[3]}" if len(p) >= 4 else (sfn or '')


def board(sfn):
    return (sfn or '').split('/')[0]


def value(r, mate=99.0):
    """An analyze() result's value for the side to move, in stones; a found
    mate counts as +/-`mate`."""
    if r.get('mate_in_turns') is not None:
        return mate if r['mate_in_turns'] > 0 else -mate
    return float(r['stones']) if r.get('stones') is not None else 0.0


class Gate:
    def __init__(self, se, ev):
        self.se = se
        self.ev = ev
        self.adaptive = tuple(se.SHIPPED_ADAPTIVE)
        se.set_policy(*se.SHIPPED_POLICY)
        if hasattr(se, 'SHIPPED_EXPLORE'):
            se.set_policy_explore(*se.SHIPPED_EXPLORE)
        self.rows = []

    def analyze(self, sfn, hist, depth=64, time_ms=0):
        return self.se.analyze(sfn, self.ev, max_depth=depth, time_ms=time_ms,
                               history_sfns=list(hist), adaptive=self.adaptive)

    def record(self, check, label, ok, **info):
        self.rows.append(dict(check=check, label=label, ok=bool(ok), **info))
        extra = ' '.join(f"{k}={v}" for k, v in info.items())
        print(f"  {'PASS' if ok else 'FAIL'}  {check} {label}  {extra}", flush=True)


def gwsmf5(g, depths, time_ms, deep=False):
    h = json.load(open(os.path.join(BENCH, 'gwsmf5_hydrated.json')))['hydrated']['turns']
    i26 = next(i for i, t in enumerate(h) if t['turnNumber'] == 26)
    # A hydrated sfnAfter still carries the mover's side token, so the position
    # after a turn is the NEXT turn's sfnBefore (Red to move here).
    root, blunder = h[i26]['sfnBefore'], h[i26 + 1]['sfnBefore']
    refute = h[i26 + 1]['sfnAfter']
    assert board(h[i26]['sfnAfter']) == board(blunder), 'fixture: turn 27 does not start where turn 26 ended'
    refute_pos = h[i26 + 2]['sfnBefore']          # Blue to move after Red's refutation
    assert board(refute_pos) == board(refute)
    hist = [t['sfnBefore'] for t in h[:i26]] + [root]
    print("GWSMF5 b 26", flush=True)
    for rem in (3, 4, 5):
        # Does Red, searching the position after the blunder, find an attack at
        # least as strong as the one played? The exact refutation (one of many
        # Flourish resolutions) need not be in the list for that.
        vp = g.analyze(blunder, hist + [blunder], depth=rem)
        vr = g.analyze(refute_pos, hist + [blunder, refute_pos], depth=rem - 1)
        v_red, v_ref = value(vp), -value(vr)
        ix, w, pull, n = g.se.node_list_rank(blunder, refute, rem, 1)
        g.record('G1', f'depth={rem}', v_red >= v_ref - 0.5, red_value=v_red, refutation_value=v_ref,
                 exact_refutation_index=ix, pull=pull)
    for d in [d for d in depths if d >= 5 and (deep or d == 5)] + ['time']:
        t0 = time.time()
        r = g.analyze(root, hist, depth=64 if d == 'time' else d, time_ms=time_ms if d == 'time' else 0)
        lab = f'{time_ms} ms' if d == 'time' else f'depth={d}'
        g.record('G2', lab, key(r['expected_sfn']) != key(blunder), depth=r['depth'],
                 stones=r['stones'], played=board(r['expected_sfn']), secs=round(time.time() - t0, 1))


def qjlgqr(g, depths, time_ms):
    h = json.load(open(os.path.join(BENCH, 'qjlgqr_hydrated.json')))['turns']
    i25 = next(i for i, t in enumerate(h) if t['turnNumber'] == 25)
    r25, blunder = h[i25]['sfnBefore'], h[i25 + 1]['sfnBefore']
    b26, win26 = h[i25 + 1]['sfnBefore'], h[i25 + 1]['sfnAfter']
    assert board(h[i25]['sfnAfter']) == board(blunder), 'fixture: turn 26 does not start where turn 25 ended'
    assert board(win26) == board(r25), 'fixture: Blue\'s turn 26 does not repeat the position'
    hist25 = [t['sfnBefore'] for t in h[:i25]] + [r25]
    reps = sum(board(s) == board(r25) for s in hist25)
    print(f"QJLGQR r 25 (position on the board {reps} times including now)", flush=True)
    for d in list(depths) + ['time']:
        t0 = time.time()
        r = g.analyze(r25, hist25, depth=64 if d == 'time' else d, time_ms=time_ms if d == 'time' else 0)
        lab = f'{time_ms} ms' if d == 'time' else f'depth={d}'
        child = r['expected_sfn']
        reply = g.analyze(child, hist25 + [child], depth=2) if child else None
        blue_mates = bool(reply and reply['mate_in_turns'] is not None and reply['mate_in_turns'] > 0
                          and reply['mate_plies'] <= 1)
        g.record('Q1', lab, child is not None and key(child) != key(blunder) and not blue_mates,
                 depth=r['depth'], stones=r['stones'], played=board(child), blue_mate_in_1=blue_mates,
                 secs=round(time.time() - t0, 1))
    print("QJLGQR b 26", flush=True)
    hist26 = hist25 + [b26]
    r = g.analyze(b26, hist26, depth=2)
    g.record('Q2', 'depth=2', r['mate_plies'] == 1 and board(r['expected_sfn']) == board(r25),
             mate_plies=r['mate_plies'], mate_in_turns=r['mate_in_turns'], played=board(r['expected_sfn']))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--depths', default='2,3,4,5,6')
    ap.add_argument('--time-ms', type=int, default=10000)
    ap.add_argument('--eval', default='', help='default: the module\'s SHIPPED_EVAL')
    ap.add_argument('--module', default='', help='a libsigil_engine.so to test instead of the installed module')
    ap.add_argument('--deep', action='store_true',
                    help='G2 at depth 6 too (single-threaded, GWSMF5 b 26 at depth 6 takes over 5 minutes)')
    ap.add_argument('--json', default='')
    a = ap.parse_args()
    se = load_module(a.module)
    ev = a.eval or se.SHIPPED_EVAL
    depths = [int(x) for x in a.depths.split(',') if x]
    print(f"tactical gate: module={getattr(se, '__file__', a.module)} eval={ev} policy={tuple(se.SHIPPED_POLICY)} "
          f"adaptive={tuple(se.SHIPPED_ADAPTIVE)}", flush=True)
    g = Gate(se, ev)
    gwsmf5(g, depths, a.time_ms, a.deep)
    qjlgqr(g, depths, a.time_ms)
    failed = [r for r in g.rows if not r['ok']]
    print(f"{len(g.rows) - len(failed)}/{len(g.rows)} checks pass", flush=True)
    if a.json:
        json.dump({'eval': ev, 'policy': list(se.SHIPPED_POLICY), 'rows': g.rows}, open(a.json, 'w'), indent=1)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
