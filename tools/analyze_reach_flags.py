#!/usr/bin/env python3
"""Turn Check B's raw `FLAG` lines into a root cause.

`engine/harness/eval_drop_audit.py --checks b` answers, for every turn in the
Firebase history, "can the engine generate this?" -- and over 62,434 real
positions it said no to 1,855. That localises nothing on its own. This script
joins those flags to the RECORDED ACTION LISTS in `completed_games` and to the
board state at the start of the turn, which is what actually names the bug.

It reproduces, from data alone, the four findings that identified the cast
refill gap:

  1. THE CONTROL. Turns played by the Rust engine itself must come back 100%
     reachable, because they came out of the enumerator. 0 of 2,305 were
     flagged, so the Firebase -> replay bridge -> SFN -> enumerate_turns
     pipeline is faithful and the flags are not the harness's doing. The rate
     then orders itself by how much of the move space a player uses.
  2. OUT OF SCOPE IS NOT A BUG. 5,352 of 7,207 raw flags were games using
     spell pools the engine does not implement, or state SFN cannot carry.
     Mixing them in reports 12% of turns unreachable instead of 3%.
  3. WHERE IT IS. Cross-tabbing dash against cast: dash-without-cast is
     0/5,671, no-dash-no-cast 0.4%, cast 11.7%, cast-with-dash 20.2%. The gap
     is only in cast turns.
  4. WHAT IT IS. Casting clears the spell's sigil and the caster keeps `mana`
     of its stones, CHOOSING which -- `game-controller.js` prompts for it.
     `sim-board.js:_castClearAndRefill` applies one fixed priority order
     instead, and `engine/src/cast.rs` mirrors it. Every engine therefore
     keeps by priority in ~100% of its casts while humans keep differently in
     69%, and the misses land almost entirely on the latter: 3.4% against
     60.9%. That is a natural experiment, not a correlation -- the two groups
     differ by which code path chose the keep.

Usage:
    python3 tools/analyze_reach_flags.py \
        --raw completed_games_raw.json \
        --hydrated hydrated_lines_v2.json \
        --logs 'runs/<RUN>/live/*.log'

`--raw` is a dump of the RTDB `completed_games` node; `--hydrated` is what
`eval_drop_audit.py --hydrate-out` writes; `--logs` are the fleet's shard logs,
whose `FLAG {json}` lines carry the flags (they go to stdout because the fleet
runner uploads `.log` and `.npz` but not `.json`).
"""
import argparse
import collections
import glob
import json

# Sigil positions, 0-based to match `spellNames.index(spell)`.
POSITIONS = {
    0: ['a2', 'a3', 'a4', 'a5', 'a6'],
    1: ['b2', 'b3', 'b4', 'b5', 'b6'],
    2: ['c2', 'c3', 'c4', 'c5', 'c6'],
    3: ['a8', 'a9', 'a10'],
    4: ['b8', 'b9', 'b10'],
    5: ['c8', 'c9', 'c10'],
    6: ['a7'], 7: ['b7'], 8: ['c7'],
}
# sim-board.js:1647 and engine/src/cast.rs, which mirrors it.
PRIORITY = {5: [2, 3, 4, 0, 1], 3: [2, 1, 0], 1: [0]}
NODE_ORDER = [f'{z}{n}' for z in 'abc' for n in range(1, 14)]
NODE_IX = {n: i for i, n in enumerate(NODE_ORDER)}
MOVEY = {'move', 'hard_move', 'blink', 'dash', 'dash_lightning'}


def priority_keep(pos, k):
    """The stones the fixed-priority refill would leave, as a sorted tuple."""
    nodes = POSITIONS[pos]
    return tuple(sorted(nodes[i] for i in PRIORITY[len(nodes)][:k]))


def load(raw_path, hyd_path, log_glob):
    raw = json.load(open(raw_path, encoding='utf-8'))
    hyd = json.load(open(hyd_path, encoding='utf-8'))

    # Every audited turn -> who played it and the board at its start. Keyed by
    # (game, turnNumber), which is how the flags identify themselves.
    who, before = {}, {}
    for g in hyd:
        for p in ((g.get('meta') or {}).get('pairs') or []):
            k = (g['key'], p.get('turnNumber'))
            who[k] = p.get('playedBy')
            before[k] = p['before']

    flagged, errors = set(), collections.Counter()
    for path in glob.glob(log_glob):
        with open(path, encoding='utf-8', errors='replace') as fh:
            for ln in fh:
                if not ln.startswith('FLAG '):
                    continue
                r = json.loads(ln[5:])
                if 'error' in r:
                    errors[r['error']] += 1
                else:
                    flagged.add((r['game'], r['turnNumber']))
    return raw, who, before, flagged, errors


def turn_rows(raw, who):
    """(key, playedBy, action-type list) for every audited turn with a record."""
    for game, g in raw.items():
        if not isinstance(g, dict):
            continue
        for t in (g.get('turns') or []):
            if not isinstance(t, dict):
                continue
            k = (game, t.get('turnNumber'))
            if k not in who:
                continue
            acts = t.get('actions')
            if not isinstance(acts, list) or not acts:
                continue
            yield k, who[k], [a.get('type') for a in acts if isinstance(a, dict)]


def cast_rows(raw, who):
    """One row per audited cast that names a sigil position and a keep set."""
    for game, g in raw.items():
        if not isinstance(g, dict):
            continue
        names = g.get('spellNames') or []
        for t in (g.get('turns') or []):
            if not isinstance(t, dict):
                continue
            k = (game, t.get('turnNumber'))
            if k not in who:
                continue
            for a in (t.get('actions') or []):
                if not isinstance(a, dict) or a.get('type') != 'cast':
                    continue
                kept = a.get('kept')
                if kept is None:
                    continue
                try:
                    pos = names.index(a.get('spell'))
                except ValueError:
                    continue
                if pos not in POSITIONS or len(kept) > len(POSITIONS[pos]):
                    continue
                yield k, who[k], pos, tuple(sorted(kept)), t.get('color')


def rate(missed, total):
    return f'{100.0 * missed / total:5.1f}%' if total else '    -'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', required=True)
    ap.add_argument('--hydrated', required=True)
    ap.add_argument('--logs', required=True)
    args = ap.parse_args()

    raw, who, before, flagged, errors = load(args.raw, args.hydrated, args.logs)
    print(f'audited turns: {len(who)};  genuine reach flags: {len(flagged)};  '
          f'out-of-scope flags: {sum(errors.values())}\n')

    print('=== 2. OUT OF SCOPE (not engine bugs) ===')
    for k, v in errors.most_common(10):
        print(f'  {v:6d}  {k}')

    print('\n=== 1. THE CONTROL: unreachable rate by who played the turn ===')
    print('  rust must be 0.00% -- those turns came out of the enumerator, so')
    print('  any rate there is harness error, not an engine gap.\n')
    den = collections.Counter(who.values())
    num = collections.Counter(who[k] for k in flagged if k in who)
    print(f"  {'played by':16s} {'flags':>7s} {'turns':>8s}   rate")
    for w in sorted(den, key=lambda x: -den[x]):
        mark = '   <-- CONTROL' if w == 'rust' else ''
        print(f'  {str(w):16s} {num.get(w, 0):7d} {den[w]:8d}  '
              f'{rate(num.get(w, 0), den[w])}{mark}')

    print('\n=== 3. WHERE IT IS: dash x cast ===')
    cells = collections.defaultdict(lambda: [0, 0])
    for k, _w, kinds in turn_rows(raw, who):
        cell = (('dash' in kinds), ('cast' in kinds))
        cells[cell][0 if k in flagged else 1] += 1
    print(f"  {'cell':26s} {'flags':>7s} {'turns':>8s}   rate")
    for (d, c) in sorted(cells):
        m, o = cells[(d, c)]
        print(f'  dash={str(d):5s} cast={str(c):5s}       {m:7d} {m + o:8d}  '
              f'{rate(m, m + o)}')

    print('\n=== 4. WHAT IT IS: the keep choice, against who chose it ===')
    print('  An engine has no chooser, so it keeps by sim-board priority; a')
    print('  human is prompted by game-controller and keeps what it likes.\n')
    tab = collections.defaultdict(lambda: [0, 0])
    for k, w, pos, kept, _col in cast_rows(raw, who):
        same = kept == priority_keep(pos, len(kept))
        tab[(w, same)][0 if k in flagged else 1] += 1
    agents = sorted({a for a, _ in tab},
                    key=lambda x: -(sum(tab[(x, True)]) + sum(tab[(x, False)])))
    print(f"  {'played by':16s} {'by priority':>26s} {'differently':>26s}")
    for w in agents:
        a, b = tab.get((w, True), [0, 0]), tab.get((w, False), [0, 0])
        if sum(a) + sum(b) < 15:
            continue
        sa, sb = sum(a), sum(b)
        print(f'  {str(w):16s} '
              f'{a[0]:6d}/{sa:<6d} {rate(a[0], sa):>10s} '
              f'{b[0]:6d}/{sb:<6d} {rate(b[0], sb):>10s}')

    print('\n  pooled:')
    for same in (True, False):
        m = sum(tab[(w, same)][0] for w in agents)
        n = sum(sum(tab[(w, same)]) for w in agents)
        lbl = 'keeps by priority' if same else 'keeps differently'
        print(f'    {lbl:20s} {m:6d} / {n:6d} = {rate(m, n)}')

    print('\n=== the keep is a CHOICE, not forced ===')
    print('  Only counts casts that OPEN the turn, where the sigil contents at')
    print('  cast time are exactly the turn-start contents -- with an earlier')
    print('  move in the turn the sigil may have changed.\n')
    d = collections.Counter()
    for game, g in raw.items():
        if not isinstance(g, dict):
            continue
        names = g.get('spellNames') or []
        for t in (g.get('turns') or []):
            if not isinstance(t, dict):
                continue
            acts = t.get('actions') or []
            if not acts or not isinstance(acts[0], dict):
                continue
            if acts[0].get('type') != 'cast':
                continue
            kept = acts[0].get('kept')
            sfn = before.get((game, t.get('turnNumber')))
            if kept is None or not sfn:
                continue
            try:
                pos = names.index(acts[0].get('spell'))
            except ValueError:
                continue
            if pos not in POSITIONS:
                continue
            stones = sfn.split('/')[0]
            ch = 'r' if t.get('color') == 'red' else 'b'
            mine = sum(1 for n in POSITIONS[pos] if stones[NODE_IX[n]] == ch)
            d[(mine, len(kept))] += 1
    tot = sum(d.values())
    forced = sum(v for (m, k), v in d.items() if m == k)
    for (m, k), v in sorted(d.items()):
        tag = 'all kept (forced)' if m == k else 'a strict SUBSET'
        print(f'  sigil holds {m} of mine, kept {k}: {v:4d}   {tag}')
    if tot:
        print(f'\n  a strict subset: {tot - forced}/{tot} '
              f'({100.0 * (tot - forced) / tot:.1f}%)')
        print('  NOTE: a strict subset alone does NOT prove a choice -- a fixed')
        print('  priority keep is also a strict subset. What proves it is the')
        print('  game-controller prompt plus the by-agent split above.')


if __name__ == '__main__':
    main()
