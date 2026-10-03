#!/usr/bin/env python3
"""Post-game weakness review of the Rust AI's recorded games, chess style.

Question (Robi, 2026-10-03): in every game the Rust AI played since it last
changed, find where the engine's value of its own position falls later in the
game; for each fall, does a deeper search (depth 8) pick a better move, or is
the engine systematically overlooking / misjudging a good move by its opponent?

Pipeline (each stage resumable; `engine/gcp/runner_deep_review.sh` runs it on a VM):

    # 1. every position at depth 6, each game walked BACKWARDS on one table:
    python engine/harness/eval_games.py eval --walk backward --depth 6 --lines lines.json --out scan.jsonl
    # 2. the turns across which that value fell against the AI:
    python engine/harness/deep_review.py flag --lines lines.json --evals scan.jsonl --out cases.json
    # 3. fresh depth-8 searches (and the cheap stream / list probes) of each case:
    python engine/harness/deep_review.py probe --lines lines.json --cases cases.json --out probes.jsonl
    # 4. classify:
    python engine/harness/deep_review.py report --lines lines.json --evals scan.jsonl \\
        --cases cases.json --probes probes.jsonl --md report.md --json rows.json

Why the scan walks backwards. Position i+1 is one ply below position i, so on a
shared table the search of i finds the deeper result for the move actually
played already stored, and orders it first. The values become consistent
along the game line, the way a chess engine's post-game review is: a fall in
value sits on the turn that caused it, not on a later turn where the horizon
happened to clear. Consequences for reading the falls:
  * OWN turn (the AI moved at i): the scan of i knew the played move's value
    from i+1 and still valued i higher, so depth 6 with hindsight prefers
    another move by more than the threshold -- an AI mistake.
  * OPPONENT turn (the opponent moved at i): had the search of i expanded the
    opponent's actual turn, the stored entry would have pulled V(i) down to
    V(i+1). A fall here therefore means the reply was NOT searched at full depth
    at the root of i -- never generated, past the width, or reduced (LMR band).
    The scan row's root probe tells which.
  A one-ply horizon (the reply searched, its consequence misjudged) does not
  show up as a fall on the opponent's turn here; it shows up on the AI's
  previous turn, as the mistake it caused. `report` traces each own-turn fall
  to the opponent's best reply (depth 8) and asks whether that reply was in
  the AI's own ply-1 list.

Values: stones from the AI's point of view, `search::report`'s even-game offset
applied, a forced result counted as +/-MATE_V, clamped (surprise_audit.py's
conventions). A game that ended on the board ends with its result; a game
that ended by resignation or the clock has no value after its last turn.

Probes (all FRESH tables: what the engine sees without the game's hindsight;
the shipped search, `se.DEFAULT_WIDTH_SCALE` / `se.SHIPPED_ADAPTIVE`):
  D       depth --depth (8) at every position a case touches (i and i+1), with
          the turn actually played as the root probe. D(i+1) is a case's
          TARGET; D(i) says whether depth 8 sees the fall / picks another move.
  S       depth 6 (--scan-depth) at the AI's own decision positions: the engine's choice
          without hindsight at the scan depth (the recorded move was chosen by
          an older engine version on a 10 s clock).
  alt     the alternative depth 8 picked at an AI decision, searched at depth
          --depth - 1 from the opponent's side: is it really better?
  salt    the same for the alternative S picked: would the current engine at
          the scan depth, without hindsight, really have played better?
  ref     the opponent's best reply to the AI's move (D(i+1)'s choice): where it
          sits in the ordered stream (`rank_of_result`) and in the list the
          AI's own search expands one ply down (`node_list_rank`, 5 plies left
          as in a depth-6 search, 7 as in depth 8), and whether it was played.
  gap     the opponent's ACTUAL turn at an opponent-turn fall: same stream /
          list ranks, and for a turn outside the stream the exhaustive
          enumeration (`rank_of_landing`).
Tasks are per position, sharded by (game, position) so many VMs can split one
corpus (`--shard k/n`); a follow-up (alt, ref) runs on the shard that owns
the position it depends on.
"""
import argparse
import json
import os
import statistics
import sys
import time
import zlib
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, wait, FIRST_COMPLETED

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from eval_games import load_rows, position_key, EVAL_NAME  # noqa: E402
from surprise_audit import MATE_V, rust_color, value_red, value_of_report, turn_kind  # noqa: E402

TT_BITS = 22
# When each wasm engine version reached the site (commit times, UTC; the site
# serves main's docs/ through Pages, so a game minutes after a cut may still
# have run the older engine). Only for grouping games by the engine that chose
# the recorded moves.
ENGINE_ERAS = [('v1-v5', '2026-08-30T00:00'), ('v6-v7', '2026-09-18T16:09'), ('v8-v10', '2026-09-20T21:59'),
               ('v11-v15', '2026-09-21T19:58'), ('v16-v17', '2026-09-23T20:53'), ('v18-v21', '2026-09-28T22:13')]


def engine_era(ts):
    from datetime import datetime, timezone
    era = ENGINE_ERAS[0][0]
    for name, cut in ENGINE_ERAS:
        if (ts or 0) >= datetime.fromisoformat(cut).replace(tzinfo=timezone.utc).timestamp() * 1000:
            era = name
    return era


def mover_of(sfn):
    return 'red' if sfn.split()[1] == 'r' else 'blue'


def final_value_red(g):
    """The value after the last turn: the result when the game ended on the
    board, else None (resignation / timeout: the position is unfinished)."""
    w = g.get('winner')
    if w not in ('red', 'blue'):
        return None
    try:
        import sigil_engine as se
        if se.analyze(g['positions'][-1], EVAL_NAME, max_depth=1, tt_bits=10)['over']:
            return MATE_V if w == 'red' else -MATE_V
    except (ImportError, ValueError):
        pass
    return None


# -------------------------------------------------------------------- flag ---

def cmd_flag(a):
    lines = json.load(open(a.lines, encoding='utf-8'))
    rows, _err = load_rows(a.evals)
    cases, stats = [], Counter()
    for gid, g in lines.items():
        ai = rust_color(g)
        if ai is None:
            stats['no single rust side'] += 1
            continue
        pos = g['positions']
        n = len(pos) - 1
        if (gid, 0) not in rows:
            stats['games not scanned'] += 1
            continue
        stats['games'] += 1
        sign = 1 if ai == 'red' else -1
        v_final = final_value_red(g)
        for i in range(n):
            side = 'own' if mover_of(pos[i]) == ai else 'opp'
            stats[side + ' turns'] += 1
            v_i = value_red(rows.get((gid, i)))
            v_j = value_red(rows.get((gid, i + 1))) if i + 1 < n else v_final
            if v_i is None or v_j is None:
                stats['no value'] += 1
                continue
            drop = sign * (v_i - v_j)
            if drop > a.threshold:
                stats[side + ' falls'] += 1
                r = rows[(gid, i)]
                cases.append({'g': gid, 'i': i, 'ai': ai, 'side': side,
                              'v_i': sign * v_i, 'v_j': sign * v_j, 'drop': round(drop, 3),
                              'terminal': i + 1 == n, 'scan_probe': r.get('probe'),
                              'scan_best_is_played': (r.get('exp') is not None and
                                                      position_key(r['exp']) == position_key(pos[i + 1])),
                              'turn': g['turnNumbers'][i] if g.get('turnNumbers') else None,
                              'room': g.get('roomCode'), 'ts': g.get('timestamp'), 'winner': g.get('winner'),
                              'opp_uid': g.get('blueUid') if ai == 'red' else g.get('redUid'),
                              'ai_uid': g.get('redUid') if ai == 'red' else g.get('blueUid')})
    print(dict(stats))
    for side in ('own', 'opp'):
        cs = [c for c in cases if c['side'] == side]
        bands = Counter('mate' if c['v_j'] <= -MATE_V + 1e-9 else '>3' if c['drop'] > 3 else '1-3' for c in cs)
        print(f'{side} falls by size: {dict(bands)}')
    json.dump(cases, open(a.out, 'w', encoding='utf-8'))


# ------------------------------------------------------------------- probe ---

def _kw(se, depth, time_ms):
    return dict(max_depth=depth, time_ms=time_ms, tt_bits=TT_BITS,
                width_scale=se.DEFAULT_WIDTH_SCALE, adaptive=se.SHIPPED_ADAPTIVE)


def _summ(r, dt, pov):
    out = {'v': value_of_report(r, pov), 'depth': r.get('depth'), 'nodes': r.get('nodes'),
           'sec': round(dt, 2), 'mate': r.get('mate_in_turns'), 'proven': r.get('proven'),
           'exp': r.get('expected_sfn'), 'raw': r.get('score'),
           'acts': json.loads(r['actions_json']) if r.get('actions_json') else None}
    if r.get('probe') is not None:
        out['probe'] = list(r['probe'])
    return out


def run_task(t):
    """One task -> its result row. t = dict(kind, g, p, ai, depth, time_ms, ...)."""
    import sigil_engine as se
    pos = t['positions']
    p, ai = t['p'], t['ai']
    out = {'g': t['g'], 'p': p, 'kind': t['kind']}
    t0 = time.time()
    try:
        if t['kind'] in ('D', 'S'):
            probe = pos[p + 1] if p + 1 < len(pos) else None
            r = se.analyze(pos[p], EVAL_NAME, history_sfns=pos[:p], probe_sfn=probe,
                           **_kw(se, t['depth'], t['time_ms']))
            out.update(_summ(r, time.time() - t0, ai))
            out['played'] = (probe is not None and r.get('expected_sfn') is not None
                             and position_key(r['expected_sfn']) == position_key(probe))
        elif t['kind'] in ('alt', 'salt'):
            # the alternative's own position (opponent to move), its history = the game to p
            r = se.analyze(t['sfn'], EVAL_NAME, history_sfns=pos[:p + 1], **_kw(se, t['depth'], t['time_ms']))
            out.update(_summ(r, time.time() - t0, ai))
        elif t['kind'] in ('ref', 'gap'):
            target = t['sfn']
            rank, gen, acts = se.rank_of_result(pos[p], target, cap=5000)
            out['rank'], out['generated'] = rank, gen
            out['acts'] = json.loads(acts) if acts else None
            # position p is ply 1 of the AI's own search of p-1: was the turn in
            # that node's list with 5 (depth 6) / 7 (depth 8) plies left?
            # (index or -1, full-depth width, LMR-band pull, list length)
            out['ply1'] = {str(rem): list(se.node_list_rank(pos[p], target, rem, 1)) for rem in (5, 7)}
            out['scale'] = se.adaptive_scale(pos[p])
            out['played'] = p + 1 < len(pos) and position_key(target) == position_key(pos[p + 1])
            if rank < 0 and t['kind'] == 'gap':
                rx, rl, _gen2, hacts, _kx, _kl = se.rank_of_landing(pos[p], target, cap=5000,
                                                                     enum_cap=t['enum_cap'])
                out['landing'] = {'rank_exact': rx, 'rank_landing': rl, 'in_enum': bool(hacts)}
                if hacts:
                    out['acts'] = json.loads(hacts)
            out['sec'] = round(time.time() - t0, 2)
    except Exception as e:  # noqa: BLE001
        out['error'] = f'{type(e).__name__}: {e}'
    return out


def _owner(g, p, n):
    return zlib.crc32(f'{g}:{p}'.encode()) % n


def plan_tasks(lines, cases, depth, time_ms, enum_cap, scan_depth=6):
    """Independent tasks keyed (g, p, kind); follow-ups are created from results."""
    tasks = {}
    meta = defaultdict(set)                  # (g, p) -> roles: own_i, own_j, opp_i, opp_j
    for c in cases:
        g, i, n = c['g'], c['i'], len(lines[c['g']]['positions']) - 1
        meta[(g, i)].add(c['side'] + '_i')
        if i + 1 < n:
            meta[(g, i + 1)].add(c['side'] + '_j')
    for (g, p), roles in meta.items():
        pos = lines[g]['positions']
        ai = rust_color(lines[g])
        base = dict(g=g, p=p, ai=ai, positions=pos, time_ms=time_ms, enum_cap=enum_cap)
        tasks[(g, p, 'D')] = dict(base, kind='D', depth=depth)
        if 'own_i' in roles:
            tasks[(g, p, 'S')] = dict(base, kind='S', depth=scan_depth)
        if 'opp_i' in roles:
            tasks[(g, p, 'gap')] = dict(base, kind='gap', sfn=pos[p + 1])
    return tasks, meta


def followups(res, tasks, meta, lines, depth, time_ms):
    """Tasks that need a finished result: alt (own decision, D picked another
    move), salt (the same for S: is the scan-depth engine's own choice really
    better?) and ref (opponent position after an AI move: its best reply)."""
    if res['kind'] not in ('D', 'S') or res.get('error') or not res.get('exp'):
        return []
    g, p = res['g'], res['p']
    roles = meta[(g, p)]
    base = tasks[(g, p, 'D')]
    if res['kind'] == 'S':
        return [] if res.get('played') else [dict(base, kind='salt', depth=depth - 1, sfn=res['exp'])]
    out = []
    if 'own_i' in roles and not res.get('played'):
        out.append(dict(base, kind='alt', depth=depth - 1, sfn=res['exp']))
    if 'own_j' in roles:
        out.append(dict(base, kind='ref', sfn=res['exp']))
    return out


def cmd_probe(a):
    lines = json.load(open(a.lines, encoding='utf-8'))
    cases = json.load(open(a.cases, encoding='utf-8'))
    tasks, meta = plan_tasks(lines, cases, a.depth, a.time_ms, a.enum_cap, a.scan_depth)
    k, n = (int(x) for x in a.shard.split('/')) if a.shard else (0, 1)
    done = {}
    if os.path.exists(a.out):
        for ln in open(a.out, encoding='utf-8'):
            try:
                d = json.loads(ln)
            except ValueError:
                continue
            if 'error' not in d:
                done[(d['g'], d['p'], d['kind'])] = d
    mine = {key: t for key, t in tasks.items() if _owner(key[0], key[1], n) == k}
    todo = [t for key, t in mine.items() if key not in done]
    # follow-ups of D results already on disk
    for key, d in list(done.items()):
        if key in mine:
            for f in followups(d, tasks, meta, lines, a.depth, a.time_ms):
                if (f['g'], f['p'], f['kind']) not in done:
                    todo.append(f)
    if a.kinds:
        keep = set(a.kinds.split(','))
        todo = [t for t in todo if t['kind'] in keep]
    todo.sort(key=lambda t: {'D': 0, 'S': 1, 'gap': 2, 'alt': 3, 'salt': 3, 'ref': 4}[t['kind']])
    print(f'{len(cases)} cases, {len(tasks)} tasks ({len(mine)} on shard {k}/{n}), {len(done)} done, '
          f'{len(todo)} to run: {dict(Counter(t["kind"] for t in todo))}', flush=True)
    t0 = time.time(); nres = 0
    with open(a.out, 'a', encoding='utf-8') as fh, ProcessPoolExecutor(max_workers=a.workers) as ex:
        pending = {ex.submit(run_task, t) for t in todo}
        while pending:
            fin, pending = wait(pending, return_when=FIRST_COMPLETED)
            for f in fin:
                res = f.result()
                fh.write(json.dumps(res, separators=(',', ':')) + '\n'); fh.flush(); nres += 1
                for t in followups(res, tasks, meta, lines, a.depth, a.time_ms):
                    if not a.kinds or t['kind'] in a.kinds.split(','):
                        pending.add(ex.submit(run_task, t))
                if nres % 10 == 0:
                    print(f'  {nres} results, {len(pending)} pending, {time.time() - t0:.0f}s', flush=True)
    print(f'done: {nres} results in {time.time() - t0:.0f}s', flush=True)


# ------------------------------------------------------------------ report ---

def _ply1_cls(p1):
    if not p1:
        return 'n/a'
    ix, w, pull, _n = p1
    return 'full width' if 0 <= ix < w else 'LMR band' if 0 <= ix < pull else 'not in the list'


def _rank_cls(rank):
    if rank is None:
        return 'n/a'
    if rank < 0:
        return 'not in stream (cap 5000)'
    return 'rank < 100' if rank < 100 else 'rank 100-999' if rank < 1000 else 'rank >= 1000'


def _spells(acts):
    return sorted({x.get('spell') for x in (acts or []) if isinstance(x, dict) and x.get('type') == 'cast'
                   and x.get('spell')})


def _scan_probe_cls(pr):
    """Root probe of the backward scan at the opponent's position: (depth,
    index, list length, score, alpha) or None (never searched at the root)."""
    if pr is None:
        return 'not searched at the root'
    return 'searched at the root'


def cmd_report(a):
    lines = json.load(open(a.lines, encoding='utf-8'))
    rows, _err = load_rows(a.evals)
    cases = json.load(open(a.cases, encoding='utf-8'))
    # The fall semantics above hold for the backward walk only; games scanned
    # on fresh tables (a fallback for games the walk could not finish) are
    # reported apart.
    fresh_games = {gid for (gid, _i), r in rows.items() if r.get('walk', 'fresh') == 'fresh'}
    cases = [c for c in cases if c['g'] not in fresh_games]
    res = {}
    for path in a.probes:
        for ln in open(path, encoding='utf-8'):
            d = json.loads(ln)
            if 'error' in d:
                print('error', d['g'], d['p'], d['kind'], d['error'][:120])
                continue
            res[(d['g'], d['p'], d['kind'])] = d
    T, tol = a.threshold, a.tolerance
    out = []
    say = out.append

    def pct(x, d):
        return f'{x}/{d} ({100 * x / d:.0f}%)' if d else '0/0'

    def target_of(c):
        if c['terminal']:
            return c['v_j']
        return (res.get((c['g'], c['i'] + 1, 'D')) or {}).get('v')

    # ---- corpus
    games = [g for g in lines.values() if rust_color(g)]
    scanned = {gid for (gid, _i) in rows}
    gs = [gid for gid, g in lines.items() if rust_color(g) and gid in scanned and gid not in fresh_games]
    ai_wins = sum(1 for gid in gs if lines[gid].get('winner') == rust_color(lines[gid]))
    tiers = Counter((lines[gid]['redUid'] if rust_color(lines[gid]) == 'red' else lines[gid]['blueUid']) for gid in gs)
    rows_bw = {k: r for k, r in rows.items() if k[0] not in fresh_games}
    secs = [r['seconds'] for r in rows_bw.values() if r.get('seconds') is not None]
    nodes = [r['nodes'] for r in rows_bw.values() if r.get('nodes')]
    say(f'Corpus: {len(gs)} Rust-AI games walked backwards of {len(games)} ({dict(tiers)}); the AI won {pct(ai_wins, len(gs))}.'
        + (f' {len(fresh_games)} games scanned on fresh tables are left out.' if fresh_games else ''))
    if secs:
        sd = Counter(r['depth'] for r in rows_bw.values()).most_common(1)[0][0]
        say(f'Backward depth-{sd} scan: {len(rows_bw)} positions, {sum(secs) / 3600:.1f} CPU-hours, mean {statistics.mean(secs):.1f} s, '
            f'median {statistics.median(nodes):,.0f} nodes.')

    rows_out = []
    # ---- own-turn falls
    own = [c for c in cases if c['side'] == 'own']
    D_ = a.depth
    say(f'\n## Falls across the AI\'s own turn: {len(own)} (the scan, with hindsight, prefers another move by > {T})')
    conf = []
    for c in own:
        g, i = c['g'], c['i']
        D, S = res.get((g, i, 'D')), res.get((g, i, 'S'))
        tgt = target_of(c)
        if D is None or tgt is None:
            continue
        r = dict(c)
        r['target8'] = tgt
        r['v8_i'] = D['v']
        r['d8_played'], r['d6_played'] = D.get('played'), (S or {}).get('played')
        r['v6f_i'] = (S or {}).get('v')
        r['proven_i'] = (rows.get((g, i)) or {}).get('proven')
        r['d8_depth'] = D.get('depth')
        r['gain8'] = None if D['v'] is None else D['v'] - tgt
        alt = res.get((g, i, 'alt'))
        r['alt_v'] = (alt or {}).get('v')
        salt = res.get((g, i, 'salt'))
        r['salt_v'] = (salt or {}).get('v')
        r['salt_better'] = None if r['salt_v'] is None else r['salt_v'] - tgt > T
        ref = res.get((g, i + 1, 'ref')) or {}
        r['ref_played'] = ref.get('played')
        r['ref_rank'] = ref.get('rank')
        r['ref_ply1'] = ref.get('ply1')
        r['ref_kind'] = turn_kind(ref.get('acts'))
        r['ref_spells'] = _spells(ref.get('acts'))
        r['confirmed'] = r['gain8'] is not None and r['gain8'] > T or (not r['d8_played'] and r['alt_v'] is not None
                                                                     and r['alt_v'] - tgt > T)
        if not r['confirmed']:
            r['cls'] = (f'not confirmed: depth {D_} keeps the move' if r['d8_played'] else
                        f'not confirmed: depth {D_} prefers another move by <= {T}')
        elif r['d6_played'] is None or (r['d6_played'] is False and r['salt_better'] is None):
            r['cls'] = 'confirmed (scan-depth probe missing)'
        elif r['d6_played'] is False and r['salt_better']:
            r['cls'] = 'confirmed; the current engine at the scan depth already plays better'
        elif r['d8_played'] is False:
            r['cls'] = f'confirmed; only depth {D_} finds a better move (horizon)'
        else:
            r['cls'] = f'confirmed; depth {D_} plays it too (deeper than {D_})'
        rows_out.append(r)
        conf.append(r)
    say(f'probed {len(conf)}; by what the current engine does at the AI\'s position:')
    for cl, k in Counter(r['cls'] for r in conf).most_common():
        sub = [r for r in conf if r['cls'] == cl]
        mates = sum(1 for r in sub if r['target8'] <= -MATE_V + 1e-9)
        say(f'  {cl:55s} {k:4d}   (into a forced loss: {mates})')
    mw = [r for r in conf if r['v_i'] >= MATE_V - 1e-9]
    if mw:
        say(f'  of which MISSED FORCED WINS (the scan proves a win at the AI\'s position, the move played does not keep it): '
            f'{len(mw)} ({sum(1 for r in mw if r["proven_i"])} proven, the rest width-limited); '
            f'a fresh scan-depth search finds the win in '
            f'{sum(1 for r in mw if (r.get("v6f_i") or 0) >= MATE_V - 1e-9)}, depth {D_} in '
            f'{sum(1 for r in mw if (r["v8_i"] or 0) >= MATE_V - 1e-9)}')
    better = [r for r in conf if r['d8_played'] is False and r['alt_v'] is not None]
    if better:
        gains = [r['alt_v'] - r['target8'] for r in better]
        say(f'depth {D_}\'s alternative, searched from the other side at depth {a.depth - 1}: better than the played move '
            f'by > {T} in {pct(sum(x > T for x in gains), len(gains))}; median gain {statistics.median(gains):+.2f} stones')
    say(f'The opponent\'s best reply to the AI\'s move (depth {D_} at i+1), for the falls depth {D_} confirms:')
    cf = [r for r in conf if r['confirmed']]
    say(f'  confirmed falls: {len(cf)}; the opponent actually played that reply in {pct(sum(bool(r["ref_played"]) for r in cf), len(cf))}')
    for rem in ('5', '7'):
        say(f'  in the AI\'s ply-1 list with {rem} plies left: '
            + ', '.join(f'{k}: {v}' for k, v in Counter(_ply1_cls((r['ref_ply1'] or {}).get(rem)) for r in cf).most_common()))
    say('  stream rank: ' + ', '.join(f'{k}: {v}' for k, v in Counter(_rank_cls(r['ref_rank']) for r in cf).most_common()))
    say('  kind: ' + ', '.join(f'{k}: {v}' for k, v in Counter(r['ref_kind'] for r in cf).most_common()))
    sp = Counter(s for r in cf for s in r['ref_spells'])
    say('  spells cast in the reply: ' + ', '.join(f'{k} {v}' for k, v in sp.most_common(12)))
    say('  by class (refutation in the AI\'s ply-1 list with 5 plies left / kind):')
    for cl, k in Counter(r['cls'] for r in cf).most_common():
        sub = [r for r in cf if r['cls'] == cl]
        say(f'    {cl:62s} {k:4d}  ' + ', '.join(f'{x}: {v}' for x, v in Counter(
            _ply1_cls((r['ref_ply1'] or {}).get('5')) for r in sub).most_common())
            + '  | ' + ', '.join(f'{x}: {v}' for x, v in Counter(r['ref_kind'] for r in sub).most_common(3)))

    # ---- opponent-turn falls
    opp = [c for c in cases if c['side'] == 'opp']
    say(f'\n## Falls across the opponent\'s turn: {len(opp)} (the reply was not searched at full depth at the root, '
        f'even on the backward table)')
    oc = []
    for c in opp:
        g, i = c['g'], c['i']
        D = res.get((g, i, 'D'))
        tgt = target_of(c)
        if D is None or tgt is None:
            continue
        r = dict(c)
        gap = res.get((g, i, 'gap')) or {}
        r['target8'] = tgt
        r['v8_i'] = D['v']
        r['confirmed'] = c['v_i'] - tgt > T
        r['sees8'] = D['v'] is not None and D['v'] - tgt <= tol
        r['found8'] = D.get('played')
        r['scan_root'] = _scan_probe_cls(c.get('scan_probe'))
        r['rank'] = gap.get('rank')
        r['ply1'] = gap.get('ply1')
        ld = gap.get('landing') or {}
        r['in_enum'] = ld.get('in_enum') if r['rank'] is not None and r['rank'] < 0 else True
        r['rank_landing'] = ld.get('rank_landing')
        r['kind'] = turn_kind(gap.get('acts'))
        r['spells'] = _spells(gap.get('acts'))
        if not gap:
            r['cls'] = 'gap probe missing'
        elif r['rank'] is not None and r['rank'] >= 0:
            r['cls'] = 'in the stream, past the root width' if c.get('scan_probe') is None else 'searched at the root, misjudged'
        elif r['rank_landing'] is not None and r['rank_landing'] >= 0:
            r['cls'] = 'never generated: dash landing generated, other sacrifice / resolution'
        elif r['in_enum']:
            r['cls'] = 'never generated by the stream'
        else:
            r['cls'] = 'not in the capped enumeration'
        rows_out.append(r)
        oc.append(r)
    cf = [r for r in oc if r['confirmed']]
    say(f'probed {len(oc)}; CONFIRMED by depth {D_} of the resulting position: {len(cf)} '
        f'(into a forced loss: {sum(1 for r in cf if r["target8"] <= -MATE_V + 1e-9)})')
    say(f'  depth {D_} of the opponent\'s position sees it (within {tol}): {pct(sum(r["sees8"] for r in cf), len(cf))}; '
        f'picks exactly that reply: {pct(sum(bool(r["found8"]) for r in cf), len(cf))}')
    for cl, k in Counter(r['cls'] for r in cf).most_common():
        sub = [r for r in cf if r['cls'] == cl]
        say(f'  {cl:70s} {k:4d}   depth {D_} sees {sum(r["sees8"] for r in sub)}')
    for rem in ('5', '7'):
        say(f'  in the AI\'s ply-1 list with {rem} plies left: '
            + ', '.join(f'{k}: {v}' for k, v in Counter(_ply1_cls((r['ply1'] or {}).get(rem)) for r in cf).most_common()))
    say('  kind: ' + ', '.join(f'{k}: {v}' for k, v in Counter(r['kind'] for r in cf).most_common()))
    sp = Counter(s for r in cf for s in r['spells'])
    say('  spells cast in the reply: ' + ', '.join(f'{k} {v}' for k, v in sp.most_common(12)))

    # ---- where in the game, and the biggest confirmed cases to look at in the review UI
    cf_all = [r for r in rows_out if r.get('confirmed')]
    phase = lambda t: 'turns 1-10' if (t or 0) <= 10 else 'turns 11-20' if t <= 20 else 'turns 21-30' if t <= 30 else 'turns 31+'
    say('\nConfirmed falls by game phase: ' + ', '.join(
        f'{k}: own {sum(1 for r in cf_all if phase(r["turn"]) == k and r["side"] == "own")} / '
        f'opp {sum(1 for r in cf_all if phase(r["turn"]) == k and r["side"] == "opp")}'
        for k in ('turns 1-10', 'turns 11-20', 'turns 21-30', 'turns 31+')))
    lost = [gid for gid in gs if lines[gid].get('winner') not in (None, rust_color(lines[gid]))]
    with_fall = {r['g'] for r in cf_all}
    say(f'AI losses with at least one confirmed fall: {pct(sum(1 for g in lost if g in with_fall), len(lost))}')
    say('\nLargest confirmed falls (room, turn number, side, scan values before -> after, class):')
    for r in sorted(cf_all, key=lambda r: -(r['v_i'] - r['target8']))[:a.examples]:
        say(f'  {r["room"] or r["g"]:>8s} t{r["turn"]:<3} {r["side"]:3s} {r["v_i"]:+6.1f} -> {r["target8"]:+6.1f}  {r["cls"]}'
            + (f'  [{"/".join(r.get("ref_spells") or r.get("spells") or [])}]' if (r.get("ref_spells") or r.get("spells")) else ''))

    # ---- by the engine version that played the game
    say('\nBy the engine version in play (confirmed falls per 100 of that side\'s turns):')
    turns_by = Counter()
    for gid in gs:
        g = lines[gid]
        ai = rust_color(g)
        for i in range(len(g['positions']) - 1):
            turns_by[(engine_era(g['timestamp']), 'own' if mover_of(g['positions'][i]) == ai else 'opp')] += 1
    for era, _cut in ENGINE_ERAS:
        eg = [gid for gid in gs if engine_era(lines[gid]['timestamp']) == era]
        if not eg:
            continue
        w = sum(1 for gid in eg if lines[gid].get('winner') == rust_color(lines[gid]))
        own_c = [r for r in cf_all if r['side'] == 'own' and engine_era(r['ts']) == era]
        opp_c = [r for r in cf_all if r['side'] == 'opp' and engine_era(r['ts']) == era]
        fixed = sum(1 for r in own_c if 'already plays better' in r['cls'])
        say(f'  {era:8s} {len(eg):4d} games, AI won {pct(w, len(eg))}; own {100 * len(own_c) / max(1, turns_by[(era, "own")]):.1f} '
            f'(the current engine at the scan depth already plays better in {fixed}/{len(own_c)}), opp {100 * len(opp_c) / max(1, turns_by[(era, "opp")]):.1f}')

    # ---- cost
    cost = defaultdict(list)
    for (g, p, kind), d in res.items():
        if d.get('sec') is not None:
            cost[kind].append(d['sec'])
    say('\nProbe cost: ' + '; '.join(f'{k} n={len(v)} mean {statistics.mean(v):.0f} s, max {max(v):.0f} s'
                                    for k, v in sorted(cost.items())))
    d8 = [d for (g, p, kind), d in res.items() if kind == 'D']
    say(f'depth reached by the D probes: {dict(Counter(d.get("depth") for d in d8))}')
    text = '\n'.join(out)
    print(text)
    if a.md:
        open(a.md, 'w', encoding='utf-8').write(text + '\n')
    if a.json:
        json.dump(rows_out, open(a.json, 'w', encoding='utf-8'))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    f = sub.add_parser('flag'); f.add_argument('--lines', required=True); f.add_argument('--evals', required=True, action='append')
    f.add_argument('--threshold', type=float, default=1.0); f.add_argument('--out', required=True)
    q = sub.add_parser('probe'); q.add_argument('--lines', required=True); q.add_argument('--cases', required=True)
    q.add_argument('--out', required=True); q.add_argument('--workers', type=int, default=os.cpu_count() or 2)
    q.add_argument('--depth', type=int, default=8)
    q.add_argument('--scan-depth', type=int, default=6, help='depth of the S probe (the scan\'s depth, fresh table)')
    q.add_argument('--time-ms', type=int, default=1800000, help='cap per search (0 = untimed)')
    q.add_argument('--enum-cap', type=int, default=500000)
    q.add_argument('--shard', default='', help='k/n: run the tasks whose (game, position) hash is k mod n')
    q.add_argument('--kinds', default='', help='comma list: run only these task kinds (e.g. salt after a resume)')
    r = sub.add_parser('report'); r.add_argument('--lines', required=True); r.add_argument('--evals', required=True, action='append')
    r.add_argument('--cases', required=True); r.add_argument('--probes', required=True, action='append')
    r.add_argument('--threshold', type=float, default=1.0); r.add_argument('--tolerance', type=float, default=0.5)
    r.add_argument('--depth', type=int, default=8); r.add_argument('--examples', type=int, default=25)
    r.add_argument('--json'); r.add_argument('--md')
    a = p.parse_args()
    {'flag': cmd_flag, 'probe': cmd_probe, 'report': cmd_report}[a.cmd](a)


if __name__ == '__main__':
    main()
