#!/usr/bin/env python3
"""Where does the Rust AI's evaluation fall across its OPPONENT's turn, and why?

Question (Robi, 2026-09-26): in every recorded game the Rust AI played, find the
turns where the evaluation declines against it in a way that surprises the
engine; re-search the position before the opponent's move deeper; does the
deeper search see the opponent's good move, or is the engine systematically
unable to see certain moves? Would more width at low depth fix it?

Pipeline (each stage resumable):

    # 1. every position at depth 4 (shipped search), with eval_games.py:
    python engine/harness/eval_games.py eval --lines lines.json --depth 4 --out d4.jsonl --split 6
    # 2. the opponent turns where the depth-4 value fell against the AI:
    python engine/harness/surprise_audit.py flag --lines lines.json --evals d4.jsonl --out cases.json
    # 3. re-search every flagged case (depth 5/6, wider depth 4, stream rank):
    python engine/harness/surprise_audit.py probe --lines lines.json --cases cases.json --out probes.jsonl
    # 4. classify:
    python engine/harness/surprise_audit.py report --cases cases.json --probes probes.jsonl

Positions and values. Position i is the one the opponent faced (opponent to
move); i+1 is the one its turn produced (AI to move); i-1 is where the AI chose
the move that led to i. All values are stones from the AI's point of view,
`search::report`'s even-game offset applied, a forced result counted as
+/-MATE_V (a lost/won game is never "only" a few stones), everything clamped
to +/-MATE_V. A game-ending opponent turn has a target of -MATE_V.

A case is FLAGGED when V4(i) - V4(i+1) > --threshold: at depth 4 the engine,
searching the opponent's own position with the opponent to move, did not
expect the reply it got. It is CONFIRMED when the depth-6 value of the
position the reply produced agrees it is bad (V4(i) - V6(i+1) > threshold),
i.e. the fall was not depth-4 misjudging i+1. For a confirmed case a probe
"SEES" the reply when its value of i is within --tolerance of the target
V6(i+1) or below it.

Probes of position i (all the SHIPPED search, `se.DEFAULT_WIDTH_SCALE` and
`se.SHIPPED_ADAPTIVE`, never restated, unless named):
  d5, d6        deeper; NOTE depth also widens (the root is 3 x width_for_depth,
                72 x scale at depth 4 but 120 x scale at depth 6), so d6 alone
                cannot separate depth from width -- hence:
  d4_w2         depth 4 at twice the width everywhere (scale and both adaptive
                scales doubled)
  d4_leaf       depth 4 with the leaf-floor width shape (WIDTH_SHAPES[6]: the
                low-remaining-depth buckets raised to 16 x scale, deep unchanged)
  rank          where the opponent's actual turn sits in the ordered turn
                stream of i (`rank_of_result`, cap 5000), against the widths the
                search gives it: at the root of a depth-4 search of i
                (3 x 24 x scale) and at ply 1 of the AI's own depth-4/5 search
                of i-1 (16 / 24 x scale), where it had to be seen in play.
  landing       for a reply outside the stream: is it in the exhaustive
                enumeration at all (`rank_of_landing`, enum cap), and does a
                turn with the same first move and dash landing appear?
  d6_prev       the AI's own decision position i-1 at depth 6: does it still
                choose the move it played, and what does it think of it.
"""
import argparse
import json
import os
import statistics
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from eval_games import load_rows, position_key, EVAL_NAME, engine_eval, AUDIT_SHIPPED  # noqa: E402

MATE_V = 20.0
LEAF_SHAPE = 6


def rust_color(g):
    r, b = g.get('redUid') or '', g.get('blueUid') or ''
    if 'rust' in r and 'rust' not in b:
        return 'red'
    if 'rust' in b and 'rust' not in r:
        return 'blue'
    return None


def value_red(row):
    """Row (eval_games.py, red POV) -> clamped stones, mate as +/-MATE_V."""
    if row is None or row.get('stones') is None and row.get('mate') is None:
        return None
    if row.get('mate'):
        return MATE_V if row['mate'] > 0 else -MATE_V
    return max(-MATE_V, min(MATE_V, row['stones']))


def value_of_report(r, pov):
    """`se.analyze` dict (mover POV) -> clamped stones from `pov`'s side."""
    if r.get('over'):
        w = r.get('winner')
        return 0.0 if w is None else (MATE_V if w == pov else -MATE_V)
    if r.get('mate_in_turns'):
        v = MATE_V if r['mate_in_turns'] > 0 else -MATE_V
    elif r.get('stones') is None:
        return None
    else:
        v = max(-MATE_V, min(MATE_V, r['stones']))
    return v if r['mover'] == pov else -v


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
        sign = 1 if ai == 'red' else -1
        winner = g.get('winner')
        for i in range(n):
            mover = pos[i].split()[1]
            mover = 'red' if mover == 'r' else 'blue'
            if (mover == ai) != (a.side == 'own'):
                continue
            stats['own turns' if a.side == 'own' else 'opponent turns'] += 1
            v_i = value_red(rows.get((gid, i)))
            if i + 1 < n:
                v_j = value_red(rows.get((gid, i + 1)))
            else:                              # the opponent's turn ended the game
                v_j = None if winner not in ('red', 'blue') else (MATE_V if winner == 'red' else -MATE_V)
            if v_i is None or v_j is None:
                stats['missing eval'] += 1
                continue
            v_i, v_j = sign * v_i, sign * v_j
            drop = v_i - v_j
            if drop > a.threshold:
                stats['flagged'] += 1
                cases.append({'g': gid, 'i': i, 'ai': ai, 'side': a.side, 'v4_i': v_i, 'v4_j': v_j, 'drop4': round(drop, 3),
                              'terminal': i + 1 == n, 'room': g.get('roomCode'),
                              'opp_uid': g.get('blueUid') if ai == 'red' else g.get('redUid'),
                              'ai_uid': g.get('redUid') if ai == 'red' else g.get('blueUid'),
                              'winner': winner})
    print(dict(stats))
    bands = Counter(('mate' if c['v4_j'] <= -MATE_V + 1e-9 else '>3' if c['drop4'] > 3 else '1-3') for c in cases)
    print('flagged by band:', dict(bands))
    json.dump(cases, open(a.out, 'w', encoding='utf-8'))


# ------------------------------------------------------------------- probe ---

def _analyze(se, sfn, hist, depth, time_ms, **over):
    kw = dict(max_depth=depth, time_ms=time_ms, tt_bits=20, history_sfns=hist,
              width_scale=se.DEFAULT_WIDTH_SCALE, adaptive=se.SHIPPED_ADAPTIVE)
    kw.update(over)
    t0 = time.time()
    r = se.analyze(sfn, engine_eval(se), **kw)
    return r, time.time() - t0


def _summ(r, dt, pov):
    out = {'v': value_of_report(r, pov), 'depth': r.get('depth'), 'nodes': r.get('nodes'),
           'sec': round(dt, 2), 'mate': r.get('mate_in_turns'), 'proven': r.get('proven'),
           'expected': r.get('expected_sfn'), 'raw': r.get('score')}
    if r.get('probe') is not None:
        # (iteration, index in the root list, list length, score from the root
        # mover's side in centistones, alpha it was searched against)
        out['probe'] = list(r['probe'])
    return out


def probe_own(item):
    """A fall across the AI's OWN turn: position i is the AI's decision, i+1
    the position its move produced (opponent to move), and the depth-4 value
    of i+1 is below that of i -- the search of i+1 finds an opponent reply the
    AI's search of i did not. Probes of i (the AI's position), each with the
    PLAYED move as the root probe: value, chosen move, the played move's root
    index and score. The killer reply is depth 6's choice at i+1; where it sits
    in the ply-1 list the AI's own search expanded (position i+1, 3 / 4 plies
    left) is the width question."""
    case, positions, time_ms, _enum_cap, which = item
    import sigil_engine as se
    i, ai = case['i'], case['ai']
    pos_i, hist_i, played = positions[i], positions[:i], positions[i + 1]
    out = {'g': case['g'], 'i': i, 'side': 'own'}
    try:
        out['scale_i'] = se.adaptive_scale(pos_i)
        out['scale_j'] = se.adaptive_scale(played)
        r, dt = _analyze(se, played, positions[:i + 1], 6, time_ms)
        out['d6_j'] = _summ(r, dt, ai)
        out['reply_acts'] = json.loads(r['actions_json']) if r.get('actions_json') else None
        reply = r.get('expected_sfn')
        if reply:
            out['ply1'] = {str(rem): list(se.node_list_rank(played, reply, rem, 1)) for rem in (3, 4)}
            rank, gen, _ = se.rank_of_result(played, reply, cap=5000)
            out['reply_rank'] = {'rank': rank, 'generated': gen}
            r4, dt4 = _analyze(se, played, positions[:i + 1], 4, time_ms, probe_sfn=reply)
            out['d4_j'] = _summ(r4, dt4, ai)
        runs = [('d4_i', 4, {}), ('d5_i', 5, {}), ('d6_i', 6, {}),
                ('d4w2_i', 4, dict(width_scale=se.DEFAULT_WIDTH_SCALE * 2,
                                   adaptive=(se.SHIPPED_ADAPTIVE[0], se.SHIPPED_ADAPTIVE[1] * 2,
                                             se.SHIPPED_ADAPTIVE[2] * 2))),
                ('d4leaf_i', 4, dict(width_shape=LEAF_SHAPE))]
        for key, d, over in runs:
            r, dt = _analyze(se, pos_i, hist_i, d, time_ms, probe_sfn=played, **over)
            sm = _summ(r, dt, ai)
            sm['same_move'] = (r.get('expected_sfn') is not None
                               and position_key(r['expected_sfn']) == position_key(played))
            out[key] = sm
            if not sm['same_move'] and r.get('expected_sfn') and d == 6:
                # What depth 6 thinks of ITS alternative, checked from the
                # other side at depth 6 (the alternative's own position).
                alt = r['expected_sfn']
                ra, dta = _analyze(se, alt, positions[:i + 1], 6, time_ms)
                out['d6_alt'] = _summ(ra, dta, ai)
    except Exception as e:  # noqa: BLE001
        out['error'] = f'{type(e).__name__}: {e}'
    return out


def probe_case(item):
    if item[0].get('side') == 'own':
        return probe_own(item)
    case, positions, time_ms, enum_cap, which = item
    import sigil_engine as se
    i, ai = case['i'], case['ai']
    pos_i, hist_i = positions[i], positions[:i]
    out = {'g': case['g'], 'i': i}
    try:
        scale_ = se.adaptive_scale(pos_i) if hasattr(se, 'adaptive_scale') else None
        scale_prev = se.adaptive_scale(positions[i - 1]) if i >= 1 and hasattr(se, 'adaptive_scale') else None
        out['scale_i'], out['scale_prev'] = scale_, scale_prev
        if 'd6j' in which and not case['terminal']:
            r, dt = _analyze(se, positions[i + 1], positions[:i + 1], 6, time_ms)
            out['d6_j'] = _summ(r, dt, ai)
        for d in (5, 6):
            if f'd{d}' in which:
                r, dt = _analyze(se, pos_i, hist_i, d, time_ms, probe_sfn=positions[i + 1])
                out[f'd{d}_i'] = _summ(r, dt, ai)
                out[f'd{d}_i']['found_reply'] = (r.get('expected_sfn') is not None and position_key(r['expected_sfn'])
                                                 == position_key(positions[i + 1]))
        if 'w2' in which:
            e, h = se.SHIPPED_ADAPTIVE[1] * 2, se.SHIPPED_ADAPTIVE[2] * 2
            r, dt = _analyze(se, pos_i, hist_i, 4, time_ms, width_scale=se.DEFAULT_WIDTH_SCALE * 2,
                             adaptive=(se.SHIPPED_ADAPTIVE[0], e, h), probe_sfn=positions[i + 1])
            out['d4w2_i'] = _summ(r, dt, ai)
        if 'leaf' in which:
            r, dt = _analyze(se, pos_i, hist_i, 4, time_ms, width_shape=LEAF_SHAPE, probe_sfn=positions[i + 1])
            out['d4leaf_i'] = _summ(r, dt, ai)
        if 'd4' in which:
            r, dt = _analyze(se, pos_i, hist_i, 4, time_ms, probe_sfn=positions[i + 1])
            out['d4_i'] = _summ(r, dt, ai)
            out['d4_i']['found_reply'] = (r.get('expected_sfn') is not None and position_key(r['expected_sfn'])
                                          == position_key(positions[i + 1]))
        if 'rank' in which:
            t0 = time.time()
            rank, gen, _acts = se.rank_of_result(pos_i, positions[i + 1], cap=5000)
            out['rank'] = {'rank': rank, 'generated': gen, 'sec': round(time.time() - t0, 2)}
            # A build that searches with the learned generator policy (v25+, when
            # auditing its shipped config) generates in the POLICY stream, so that
            # rank is the one its search actually faces.
            pol = getattr(se, 'SHIPPED_POLICY', None) if AUDIT_SHIPPED else None
            if hasattr(se, 'policy_rank_of_result') and pol and pol[0]:
                pr = se.policy_rank_of_result(pos_i, positions[i + 1], cap=5000)
                out['policy_rank'] = {'rank': pr[0], 'generated': pr[1]}
            # Position i is ply 1 of the AI's own search of i-1: was the reply
            # inside that node's list with 3 (depth-4 search) or 4 (depth-5)
            # plies left? (index, full-depth width, LMR-band pull, length)
            out['ply1'] = {str(rem): list(se.node_list_rank(pos_i, positions[i + 1], rem, 1)) for rem in (3, 4)}
            if rank < 0:
                t0 = time.time()
                rx, rl, gen2, hacts, _kx, _kl = se.rank_of_landing(pos_i, positions[i + 1], cap=5000,
                                                                     enum_cap=enum_cap)
                out['landing'] = {'rank_exact': rx, 'rank_landing': rl, 'in_enum': bool(hacts),
                                  'acts': json.loads(hacts) if hacts else None,
                                  'sec': round(time.time() - t0, 2)}
            else:
                out['acts'] = json.loads(_acts) if _acts else None
        if 'prev' in which and i >= 1:
            r, dt = _analyze(se, positions[i - 1], positions[:i - 1], 6, time_ms)
            s = _summ(r, dt, ai)
            s['same_move'] = (r.get('expected_sfn') is not None
                              and position_key(r['expected_sfn']) == position_key(positions[i]))
            out['d6_prev'] = s
            r, dt = _analyze(se, positions[i - 1], positions[:i - 1], 4, time_ms)
            s = _summ(r, dt, ai)
            s['same_move'] = (r.get('expected_sfn') is not None
                              and position_key(r['expected_sfn']) == position_key(positions[i]))
            out['d4_prev'] = s
    except Exception as e:  # noqa: BLE001
        out['error'] = f'{type(e).__name__}: {e}'
    return out


def cmd_probe(a):
    lines = json.load(open(a.lines, encoding='utf-8'))
    cases = json.load(open(a.cases, encoding='utf-8'))
    which = set(a.which.split(','))
    done = set()
    if os.path.exists(a.out):
        for ln in open(a.out, encoding='utf-8'):
            try:
                d = json.loads(ln)
            except ValueError:
                continue
            if 'error' not in d:
                done.add((d['g'], d['i']))
    todo = [c for c in cases if (c['g'], c['i']) not in done]
    if a.limit:
        todo = todo[:a.limit]
    print(f'{len(cases)} cases, {len(done)} done, {len(todo)} to probe ({sorted(which)})', flush=True)
    t0 = time.time()
    with open(a.out, 'a', encoding='utf-8') as fh, ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(probe_case, (c, lines[c['g']]['positions'], a.time_ms, a.enum_cap, which))
                for c in todo]
        for k, f in enumerate(as_completed(futs), 1):
            fh.write(json.dumps(f.result(), separators=(',', ':')) + '\n')
            fh.flush()
            if k % 10 == 0 or k == len(futs):
                print(f'  {k}/{len(futs)} {time.time() - t0:.0f}s', flush=True)


# ------------------------------------------------------------------ report ---

def classify(r):
    """Why the engine missed a confirmed reply, from the depth-4 root probe and
    the stream ranks. PREDICTED: the reply was the engine's own choice (or
    scored within 0.25 stones of it) -- the fall came from what follows it,
    i.e. depth, not the reply. MISJUDGED: the root searched the reply and
    scored it clearly below its best. UNSEEN-*: the root never searched it."""
    pr = r.get('probe4')
    if pr is not None:
        _d, ix, _n, v, _al = pr
        best = r.get('score4_best')
        clamp = lambda x: max(-5000, min(5000, x))   # UNPROVEN_MATE: the reported score is clamped
        if ix == 0 or (best is not None and clamp(v) >= clamp(best) - 25):
            return 'predicted'
        return 'misjudged'
    if r['rank'] is not None and r['rank'] >= 0:
        return 'unseen: in stream, past the root width'
    if r.get('rank_landing') is not None and r['rank_landing'] >= 0:
        return 'unseen: landing generated, other sacrifice'
    if r.get('in_enum'):
        return 'unseen: never generated by the stream'
    return 'unseen: not found in the capped enumeration'


def report_own(a, cases, probes):
    T, tol = a.threshold, a.tolerance
    rows = []
    for key, c in cases.items():
        p = probes.get(key)
        if not p or (p.get('d6_j') or {}).get('v') is None:
            continue
        r = dict(c)
        tgt = p['d6_j']['v']
        r['target'] = tgt
        r['confirmed'] = c['v4_i'] - tgt > T
        for k in ('d4_i', 'd5_i', 'd6_i', 'd4w2_i', 'd4leaf_i'):
            q = p.get(k) or {}
            r[k] = q.get('v')
            r['same_' + k] = q.get('same_move')
            # sees the danger and keeps the move (no escape it can find), or avoids it
            r['sees_' + k] = None if q.get('v') is None else (q.get('same_move') and q['v'] - tgt <= tol)
            r['avoids_' + k] = None if q.get('same_move') is None else (not q['same_move'])
            r['probe_' + k] = q.get('probe')
        alt = p.get('d6_alt') or {}
        r['alt6_v'] = alt.get('v')
        r['ply1'] = p.get('ply1')
        r['reply_rank'] = (p.get('reply_rank') or {}).get('rank')
        r['kind'] = turn_kind(p.get('reply_acts'))
        r['scale_j'] = p.get('scale_j')
        pr = r['probe_d4_i']
        r['played_d4'] = None if pr is None else ('chosen' if pr[1] == 0 or r['same_d4_i'] else 'searched, not chosen')
        if pr is None:
            r['played_d4'] = 'not in the depth-4 root list'
        r['nodes'] = {k: (p.get(k) or {}).get('nodes') for k in ('d4_i', 'd4w2_i', 'd4leaf_i', 'd5_i', 'd6_i')}
        rows.append(r)
    conf = [r for r in rows if r['confirmed']]
    out = []
    say = out.append

    def pct(n, d):
        return f'{n}/{d} ({100 * n / d:.0f}%)' if d else '0/0'
    say(f'OWN-TURN falls: {len(rows)} probed; {len(conf)} CONFIRMED (depth 6 of the position the AI\'s move '
        f'produced is > {T} stones below depth 4\'s value of the AI\'s position)')
    bands = Counter('mate' if r['target'] <= -MATE_V + 1e-9 else '>3' if r['v4_i'] - r['target'] > 3 else '1-3'
                    for r in conf)
    say(f'  by size: {dict(bands)}')
    say(f'  the played move at depth 4: ' + ', '.join(f'{k}: {v}' for k, v in Counter(r['played_d4'] for r in conf).most_common()))
    say('\nWhat each search of the AI\'s position does (confirmed): keeps the played move and SEES the fall '
        '(no escape) / keeps it and does not see it / picks another move')
    for k in ('d4_i', 'd5_i', 'd6_i', 'd4w2_i', 'd4leaf_i'):
        s_ = [r for r in conf if r['same_' + k] is not None]
        sees = sum(bool(r['sees_' + k]) for r in s_)
        blind = sum(1 for r in s_ if r['same_' + k] and not r['sees_' + k])
        other = sum(1 for r in s_ if not r['same_' + k])
        say(f'  {k:9s} sees {sees:4d}   blind {blind:4d}   other move {other:4d}   of {len(s_)}')
    alts = [r for r in conf if r['alt6_v'] is not None]
    better = [r for r in alts if r['alt6_v'] - r['target'] > T]
    say(f'  depth 6\'s alternative, re-searched at depth 6: better than the played move by > {T} in '
        f'{pct(len(better), len(alts))}; median gain {statistics.median([r["alt6_v"] - r["target"] for r in alts]) if alts else 0:+.2f}')
    say('\nThe opponent\'s best reply (depth 6 at i+1) inside the AI\'s ply-1 list?')
    for rem in ('3', '4'):
        c_ = Counter()
        for r in conf:
            p1 = (r['ply1'] or {}).get(rem)
            if not p1:
                c_['no reply'] += 1
                continue
            ix, w, pull, _n = p1
            c_['full width' if 0 <= ix < w else 'LMR band (reduced depth)' if 0 <= ix < pull else 'not in the list'] += 1
        say(f'  {rem} plies left: {dict(c_)}')
    rk = Counter('not in stream (cap 5000)' if r['reply_rank'] is not None and r['reply_rank'] < 0
                 else 'n/a' if r['reply_rank'] is None else f'stream rank < 100' if r['reply_rank'] < 100
                 else 'stream rank 100-999' if r['reply_rank'] < 1000 else 'stream rank >= 1000' for r in conf)
    say(f'  stream rank of that reply: {dict(rk)}')
    say('  kind of reply: ' + ', '.join(f'{k}: {v}' for k, v in Counter(r['kind'] for r in conf).most_common()))
    # cross: blind at d4 but the reply was inside ply-1 width -> misjudged below, not unseen
    blind4 = [r for r in conf if r['same_d4_i'] and not r['sees_d4_i']]
    inw = sum(1 for r in blind4 if (r['ply1'] or {}).get('3') and 0 <= r['ply1']['3'][0] < r['ply1']['3'][2])
    say(f'\nDepth 4 keeps the move and misses the fall in {len(blind4)} cases; the reply was inside its ply-1 '
        f'list (full or LMR band) in {inw} of them.')
    cost = defaultdict(list)
    for r in rows:
        for k, v in r['nodes'].items():
            if v:
                cost[k].append(v)
    say('median nodes: ' + ', '.join(f'{k} {statistics.median(v):,.0f}' for k, v in cost.items()))
    text = '\n'.join(out)
    print(text)
    if a.md:
        open(a.md, 'w', encoding='utf-8').write(text + '\n')
    if a.json:
        json.dump(rows, open(a.json, 'w', encoding='utf-8'))


def cmd_report(a):
    cases = {(c['g'], c['i']): c for c in json.load(open(a.cases, encoding='utf-8'))}
    probes = {}
    for path in a.probes:
        for ln in open(path, encoding='utf-8'):
            d = json.loads(ln)
            if 'error' in d:
                print('error', d['g'], d['i'], d['error'][:120])
                continue
            probes.setdefault((d['g'], d['i']), {}).update(d)
    if any(c.get('side') == 'own' for c in cases.values()):
        return report_own(a, cases, probes)
    T, tol = a.threshold, a.tolerance
    rows = []
    for key, c in cases.items():
        p = probes.get(key)
        if not p:
            continue
        tgt = -MATE_V if c['terminal'] else (p.get('d6_j') or {}).get('v')
        if tgt is None:
            continue
        r = dict(c)
        r['target'] = tgt
        r['confirmed'] = c['v4_i'] - tgt > T
        for k in ('d4_i', 'd5_i', 'd6_i', 'd4w2_i', 'd4leaf_i'):
            v = (p.get(k) or {}).get('v')
            r['sees_' + k] = None if v is None else (v - tgt <= tol)
            r[k] = v
            r['probe_' + k] = (p.get(k) or {}).get('probe')
        d4 = p.get('d4_i') or {}
        r['probe4'] = d4.get('probe')
        # the root's best score from the mover's (the opponent's) side, centistones:
        # the probe's v is on the same raw scale, so compare raw to raw.
        r['score4_best'] = d4.get('raw')
        r['found4'] = d4.get('found_reply')
        r['found6'] = (p.get('d6_i') or {}).get('found_reply')
        rk = (p.get('rank') or {}).get('rank')
        r['rank'] = rk
        r['ply1'] = p.get('ply1')
        r['scale_i'], r['scale_prev'] = p.get('scale_i'), p.get('scale_prev')
        ld = p.get('landing') or {}
        r['in_enum'] = ld.get('in_enum') if rk is not None and rk < 0 else True
        r['rank_landing'] = ld.get('rank_landing')
        r['kind'] = turn_kind(p.get('acts') or ld.get('acts'))
        pr = p.get('d6_prev') or {}
        r['prev6_same'], r['prev6_v'] = pr.get('same_move'), pr.get('v')
        r['prev4_same'] = (p.get('d4_prev') or {}).get('same_move')
        r['nodes'] = {k: (p.get(k) or {}).get('nodes') for k in ('d4_i', 'd4w2_i', 'd4leaf_i', 'd5_i', 'd6_i')}
        r['secs'] = {k: (p.get(k) or {}).get('sec') for k in ('d4_i', 'd4w2_i', 'd4leaf_i', 'd5_i', 'd6_i')}
        r['cls'] = classify(r)
        rows.append(r)
    conf = [r for r in rows if r['confirmed']]
    out = []
    say = out.append
    say(f'{len(rows)} probed cases; {len(conf)} CONFIRMED (depth 6 of the resulting position agrees it is '
        f'> {T} stones worse than depth 4 thought; tolerance {tol})')
    bands = Counter('mate' if r['target'] <= -MATE_V + 1e-9 else '>3' if r['v4_i'] - r['target'] > 3 else '1-3'
                    for r in conf)
    say(f'  confirmed by size: {dict(bands)}')

    def pct(n, d):
        return f'{n}/{d} ({100 * n / d:.0f}%)' if d else '0/0'
    say('\nWhich searches of the opponent\'s position already see the reply (value within tolerance of the target):')
    for k in ('d4_i', 'd5_i', 'd6_i', 'd4w2_i', 'd4leaf_i'):
        s_ = [r for r in conf if r['sees_' + k] is not None]
        say(f'  {k:9s} {pct(sum(r["sees_" + k] for r in s_), len(s_))}')
    both = [r for r in conf if r['sees_d6_i'] is not None and r['sees_d4w2_i'] is not None]
    say('  (d6 sees, d4 at 2x width sees) crosstab: '
        + ', '.join(f'{k}: {v}' for k, v in sorted(Counter((r['sees_d6_i'], r['sees_d4w2_i']) for r in both).items())))
    say('\nWhy depth 4 missed it (confirmed cases):')
    for cl, n in Counter(r['cls'] for r in conf).most_common():
        sub = [r for r in conf if r['cls'] == cl]
        say(f'  {cl:45s} {n:4d}   d5 {sum(bool(r["sees_d5_i"]) for r in sub):3d}  d6 {sum(bool(r["sees_d6_i"]) for r in sub):3d}'
            f'  2x width {sum(bool(r["sees_d4w2_i"]) for r in sub):3d}  leaf-floor {sum(bool(r["sees_d4leaf_i"]) for r in sub):3d}')
    say('\nWas the reply inside the AI\'s own search at ply 1 (position i, 3 / 4 plies left)?')
    for rem in ('3', '4'):
        c_ = Counter()
        for r in conf:
            p1 = (r['ply1'] or {}).get(rem)
            if not p1:
                continue
            ix, w, pull, _n = p1
            c_['full width' if 0 <= ix < w else 'LMR band (reduced depth)' if 0 <= ix < pull else 'not in the list'] += 1
        say(f'  {rem} plies left: {dict(c_)}')
    say('\nKind of reply (confirmed):')
    for kd, n in Counter(r['kind'] for r in conf).most_common():
        sub = [r for r in conf if r['kind'] == kd]
        say(f'  {kd:12s} {n:4d}  ' + ', '.join(f'{k}: {v}' for k, v in Counter(r['cls'] for r in sub).most_common()))
    say('\nThe AI\'s own decision at i-1 (confirmed): depth 6 keeps the move it played '
        f'{sum(bool(r["prev6_same"]) for r in conf)}/{sum(r["prev6_same"] is not None for r in conf)}; '
        f'depth 4 keeps it {sum(bool(r["prev4_same"]) for r in conf)}/{sum(r["prev4_same"] is not None for r in conf)}')
    cost = defaultdict(list)
    tsec = defaultdict(list)
    for r in rows:
        for k, v in r['nodes'].items():
            if v:
                cost[k].append(v)
        for k, v in r['secs'].items():
            if v is not None:
                tsec[k].append(v)
    say('\nCost over all probed cases: ' + '; '.join(
        f'{k} median {statistics.median(cost[k]):,.0f} nodes, mean {statistics.mean(tsec[k]):.1f} s'
        for k in cost))
    text = '\n'.join(out)
    print(text)
    if a.md:
        open(a.md, 'w', encoding='utf-8').write(text + '\n')
    if a.json:
        json.dump(rows, open(a.json, 'w', encoding='utf-8'))


def turn_kind(acts):
    if not acts:
        return 'unknown'
    kinds = []
    for x in acts:
        t = x.get('type') if isinstance(x, dict) else (x[0] if isinstance(x, (list, tuple)) and x else x)
        kinds.append(str(t))
    ks = set(kinds)
    tag = []
    if any('dash' in k.lower() for k in ks):
        tag.append('dash')
    if any('cast' in k.lower() or 'spell' in k.lower() for k in ks):
        tag.append('cast')
    if not tag:
        tag.append('move-only')
    return '+'.join(tag)


# -------------------------------------------------------------------- gaps ---

BUDGETS = {   # (cast-outcome window, keep window, dash sacrifice pairs per landing)
    'search budgets (16, 2, 2)': (16, 2, 2),
    'dash pairs 4': (16, 2, 4), 'dash pairs 8': (16, 2, 8), 'dash pairs 16': (16, 2, 16),
    'cast window 64': (64, 2, 2), 'cast window 256': (256, 2, 2), 'keep 8': (16, 8, 2),
    'pairs 8 + window 64 + keep 8': (64, 8, 8),
}


def _gap_one(item):
    """For one confirmed reply the depth-4 root never searched: what part of it
    the ordered stream lacks, and whether wider generator budgets reach it."""
    r, positions, acts = item
    import sigil_engine as se
    names = list(se.NODE_NAMES)
    ix = {n: k for k, n in enumerate(names)}
    sfn, after = positions[r['i']], positions[r['i'] + 1]
    b = se.Board.from_sfn(sfn)
    c = 'red' if sfn.split()[1] == 'r' else 'blue'
    out = {'g': r['g'], 'i': r['i'], 'cls': r['cls'], 'kind': r['kind'], 'd6_sees': bool(r.get('sees_d6_i'))}
    gap = None
    if acts and 'past the root' not in r['cls']:
        f = acts[0]
        first = (ix[f['node']], ix[f['pushed_to']] if f.get('pushed_to') else -1)
        dk = [k for k, a in enumerate(acts) if a['type'].startswith('dash')]
        casts = [a for a in acts if a['type'] == 'cast']
        stream = b.turns_ordered_reasons(c, 16, 0, 5000)
        if dk:
            k = dk[0]
            land_a = acts[k + 1]
            land = (ix[land_a['node']], ix[land_a['pushed_to']] if land_a.get('pushed_to') else -1)
            sacs = sorted(ix[x] for x in acts[k].get('sacrificed', []))
            same_land = same_sac = False
            for t in stream:
                if (t[0][1], t[0][2]) != first:
                    continue
                d = [a for a in t if a[0] == 'dash']
                if d and (d[0][1], d[0][2]) == land:
                    same_land = True
                    same_sac = same_sac or sorted(d[0][3]) == sacs
            gap = ('cast resolution after the dash' if same_sac else 'dash sacrifice pair' if same_land
                   else 'dash landing')
        elif casts:
            spell = casts[0]['spell']
            same = any((t[0][1], t[0][2]) == first and any(a[0] == 'cast' and 0 <= a[4] < 9
                                                         and b.spell_names[a[4]] == spell for a in t)
                       for t in stream)
            gap = 'cast resolution' if same else 'cast (spell never cast after this move)'
        else:
            gap = 'plain move'
    elif 'past the root' in r['cls']:
        gap = 'ranked past the root width'
    else:
        gap = 'not in the capped enumeration'
    out['gap'] = gap
    ranks = {}
    d = se.search_defaults()   # read BEFORE the sweep changes the thread-local knob
    for name, (w, kw, pt) in BUDGETS.items():
        se.set_dash_gen(1, 0, pt)
        ranks[name] = list(se.rank_of_result_budget(sfn, after, w, kw, 5000))
    se.set_dash_gen(d['dash_gen_mode'], d['dash_gen_width'], d['dash_gen_per_target'])
    out['budgets'] = ranks
    return out


def cmd_gaps(a):
    lines = json.load(open(a.lines, encoding='utf-8'))
    rows = json.load(open(a.rows, encoding='utf-8'))
    probes = {}
    for ln in open(a.probes, encoding='utf-8'):
        d = json.loads(ln)
        probes[(d['g'], d['i'])] = d
    todo = []
    for r in rows:
        if not r.get('confirmed') or not r['cls'].startswith('unseen'):
            continue
        p = probes[(r['g'], r['i'])]
        acts = (p.get('landing') or {}).get('acts') or p.get('acts')
        todo.append((r, lines[r['g']]['positions'], acts))
    res = []
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for f in as_completed([ex.submit(_gap_one, it) for it in todo]):
            res.append(f.result())
    print(f'{len(res)} confirmed replies the depth-4 root never searched')
    for g, n in Counter(x['gap'] for x in res).most_common():
        print(f'  {g:42s} {n:4d}   depth 6 still blind in {sum(1 for x in res if x["gap"] == g and not x["d6_sees"])}')
    print('\nexact reply reached by the ordered stream (cap 5000) under wider generator budgets:')
    for name in BUDGETS:
        got = [x for x in res if x['budgets'][name][0] >= 0]
        by = Counter(x['gap'] for x in got)
        print(f'  {name:30s} {len(got):4d}/{len(res)}  stream median {statistics.median(x["budgets"][name][1] for x in res):5.0f}  '
              + ', '.join(f'{k}: {v}' for k, v in by.most_common()))
    if a.json:
        json.dump(res, open(a.json, 'w', encoding='utf-8'))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    f = sub.add_parser('flag'); f.add_argument('--lines', required=True); f.add_argument('--evals', required=True, action='append')
    f.add_argument('--threshold', type=float, default=1.0); f.add_argument('--out', required=True)
    f.add_argument('--side', choices=('opp', 'own'), default='opp',
                   help="opp: the fall is across the opponent's turn; own: across the AI's own turn")
    q = sub.add_parser('probe'); q.add_argument('--lines', required=True); q.add_argument('--cases', required=True)
    q.add_argument('--out', required=True); q.add_argument('--workers', type=int, default=os.cpu_count() or 2)
    q.add_argument('--time-ms', type=int, default=300000); q.add_argument('--enum-cap', type=int, default=500000)
    q.add_argument('--which', default='d6j,d4,d5,d6,w2,leaf,rank,prev'); q.add_argument('--limit', type=int, default=0)
    r = sub.add_parser('report'); r.add_argument('--cases', required=True); r.add_argument('--probes', required=True, action='append')
    r.add_argument('--threshold', type=float, default=1.0); r.add_argument('--tolerance', type=float, default=0.5)
    r.add_argument('--json'); r.add_argument('--md')
    g = sub.add_parser('gaps'); g.add_argument('--lines', required=True); g.add_argument('--rows', required=True, help='report --json output (opponent side)')
    g.add_argument('--probes', required=True); g.add_argument('--workers', type=int, default=os.cpu_count() or 2); g.add_argument('--json')
    a = p.parse_args()
    {'flag': cmd_flag, 'probe': cmd_probe, 'report': cmd_report, 'gaps': cmd_gaps}[a.cmd](a)


if __name__ == '__main__':
    main()
