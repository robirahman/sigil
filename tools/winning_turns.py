"""Winning-turn puzzles: positions where exactly one turn (or a few that reach
the same verdict) keeps a winning game and every other candidate lets it go.

Win chances are P(mover wins) under the PR #28 calibration
(docs/static/data/position-winprob.json, the curves the site's
position-rating.js uses): a search's stones at depth d -> P(red wins) by the
fitted curve for that depth and game phase. The page judges a player's turn
the same way (search the after-position, convert), so the generator and the
judge read one scale.

    screen   analyze(position, depth 4): P(best) >= SCREEN_P, no proven mate
             within MAX_MATE turns (those are mate puzzles)
    rank     root_scores_and_play(depth 3, exact): every expanded root turn
             with an exact score; the top RANK_TOP distinct results, plus the
             turn actually played, go on
    judge    analyze(child, depth 4) on each, best root score first: P for
             the mover; stops at the first grey verdict or once more than
             MAX_SOLUTIONS results win
    confirm  analyze(child, depth 5) on the winners and the best CONFIRM_TOP
             losers; the verdict must hold at both depths

A puzzle needs a best result at P >= WIN_P, at most MAX_SOLUTIONS results
within BAND of it (the solutions), and every other candidate at least GAP
below it, so nothing sits in the grey zone between. Winning positions in
Sigil usually have many good turns; the gap is what makes one a puzzle. Turns the
root search never expanded are not judged here -- the page judges any turn
off the stored solutions live, so an unlisted winning turn still counts.
"""

import json
import math
import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(REPO, 'docs', 'static', 'data', 'position-winprob.json')

SCREEN_P = 0.72
WIN_P = 0.75
GAP = 0.25
BAND = 0.05
RANK_TOP = 12
RANK_DEPTH = 3
CHILD_DEPTH = 4       # each candidate's child position, searched by analyze()
CONFIRM_DEPTH = 5     # the confirmation re-search of the winners and the best losers
CHILD_MS = 30_000
CONFIRM_TOP = 4
MAX_SOLUTIONS = 3
MAX_MATE = 3

_model = None


def model():
    global _model
    if _model is None:
        with open(MODEL_PATH, encoding='utf-8') as fh:
            _model = json.load(fh)
    return _model


def red_win_prob(sfn, depth, stones_red, mate_red=None, proven=False):
    """positionRedWinProb (position-rating.js) in Python: `stones_red` and
    `mate_red` (winner's turns, + = red) from red's side."""
    if mate_red:
        if proven:
            return 1.0 if mate_red > 0 else 0.0
    ds = sorted(int(d) for d in model()['depths'])
    pick = None
    for d in ds:
        if d <= depth:
            pick = d
    if pick is None:
        return None
    c = model()['depths'][str(pick)]
    if mate_red:
        return c['likelyMateWin'] if mate_red > 0 else 1 - c['likelyMateWin']
    if stones_red is None:
        return None
    p = sfn.split()
    ph = min(int(p[2]), 60) / 60
    z = (c['a'] + c['b'] * stones_red + (c['c'] if p[1] == 'r' else 0)
         + ph * (c.get('aPhase', 0) + c.get('bPhase', 0) * stones_red))
    return 1 / (1 + math.exp(-z))


def mover_prob(E, sfn, mover, depth, time_ms=0):
    """P(`mover` wins) at `sfn` (any side to move) by a fixed-depth search.
    Returns (p, info) with info the raw analysis summary."""
    a = E.analyze(sfn, E.SHIPPED_EVAL, max_depth=depth, time_ms=time_ms)
    if a.get('over'):
        w = a.get('winner')
        return (1.0 if w == mover else 0.0), {'over': True}
    to_move = 'red' if sfn.split()[1] == 'r' else 'blue'
    sign = 1 if to_move == 'red' else -1
    stones = a.get('stones')
    mate = a.get('mate_in_turns')
    pr = red_win_prob(sfn, a.get('depth') or 0,
                      None if stones is None else stones * sign,
                      None if not mate else mate * sign, bool(a.get('proven')))
    if pr is None:
        return None, {'depth': a.get('depth')}
    p = pr if mover == 'red' else 1 - pr
    info = {'depth': a.get('depth'), 'stones': stones, 'mate': mate, 'proven': bool(a.get('proven'))}
    return p, info


def key_of(sfn):
    """Position identity (stones, counters, locks, springlocks, Providence
    banks), as gen_mate_puzzles.sfn_key and the page's puzzleSfnKey."""
    p = sfn.split()
    key = ' '.join([p[0].split('/')[0], p[3], p[4], p[5]])
    pm = next((t for t in p[6:] if t.startswith('pm:')), None)
    return key + ' ' + pm if pm else key


def analyze_position(sfn, played_after=None, diag=False):
    """The winning-turn verdict for one position (mover = side to move).
    Returns a JSON-able dict with 'verdict' in {'puzzle', 'not winning',
    'mate', 'no gap', 'grey', 'too many', 'unconfirmed', 'error'}."""
    import sigil_engine as E
    mover = 'red' if sfn.split()[1] == 'r' else 'blue'
    out = {'mover': mover}
    try:
        a = E.analyze(sfn, E.SHIPPED_EVAL, max_depth=4)
    except Exception as e:  # noqa: BLE001
        return {'verdict': 'error', 'error': str(e)[:200]}
    if a.get('over'):
        return {'verdict': 'error', 'error': 'game over'}
    mate = a.get('mate_in_turns')
    if mate and mate > 0 and a.get('proven') and mate <= MAX_MATE:
        return {'verdict': 'mate', 'mate_in': mate}
    sign = 1 if mover == 'red' else -1
    stones = a.get('stones')
    pr = red_win_prob(sfn, a.get('depth') or 0, None if stones is None else stones * sign,
                      None if not mate else mate * sign, bool(a.get('proven')))
    if pr is None:
        return {'verdict': 'error', 'error': 'shallow screen'}
    p0 = pr if mover == 'red' else 1 - pr
    out['p_screen'] = round(p0, 4)
    if p0 < SCREEN_P:
        out['verdict'] = 'not winning'
        return out

    b = E.Board.from_sfn(sfn)
    r = b.root_scores_and_play(max_depth=RANK_DEPTH, eval_name=E.SHIPPED_EVAL, exact=True, play=False)
    cands = sorted(r[5], key=lambda c: -c[2])
    out['root_expanded'] = len(cands)
    seen, picks = set(), []
    for c in cands:
        acts, after = E.turn_after(sfn, list(c[0]))
        k = key_of(after)
        if k in seen:
            continue
        seen.add(k)
        picks.append({'actions': json.loads(acts), 'after': after, 'key': k, 'root': c[2]})
        if len(picks) >= RANK_TOP:
            break
    if played_after:
        pk = key_of(played_after)
        if pk not in seen:
            picks.append({'actions': None, 'after': played_after, 'key': pk, 'root': None})
    judged = []
    for c in picks:
        c['p4'], c['i4'] = mover_prob(E, c['after'], mover, CHILD_DEPTH, CHILD_MS)
        if c['p4'] is None:
            continue
        judged.append(c)
        if diag:
            continue
        # Early exits, valid whatever the remaining candidates score: two
        # results both >= WIN_P but more than BAND apart leave the lower one
        # in the grey zone (best <= 1, so best - GAP <= WIN_P), and more than
        # MAX_SOLUTIONS results within BAND of each other at >= WIN_P are
        # too many winners for a puzzle.
        hi = [x['p4'] for x in judged if x['p4'] >= WIN_P]
        if hi and max(hi) - min(hi) > BAND:
            out['verdict'] = 'grey'
            return out
        if len(hi) > MAX_SOLUTIONS:
            out['verdict'] = 'too many'
            return out
    if diag:
        out['verdict'] = 'diag'
        out['p4s'] = [round(c['p4'], 3) for c in judged]
        return out
    out['candidates'] = len(judged)
    verdict, win, rest = split(judged, 'p4')
    if verdict:
        out['verdict'] = verdict
        out['p_best'] = round(max([c['p4'] for c in judged] or [0]), 4)
        return out
    # Confirm one ply deeper: the winners stay winning, the best losers stay
    # at least GAP behind.
    rest.sort(key=lambda c: -c['p4'])
    deep = win + rest[:CONFIRM_TOP]
    for c in deep:
        c['p5'], c['i5'] = mover_prob(E, c['after'], mover, CONFIRM_DEPTH, CHILD_MS)
    for c in rest[CONFIRM_TOP:]:
        c['p5'] = c['p4']
    verdict, win5, rest5 = split([c for c in judged if c.get('p5') is not None], 'p5')
    if verdict or any(c.get('p5') is None for c in deep) or {c['key'] for c in win5} != {c['key'] for c in win}:
        out['verdict'] = 'unconfirmed'
        out['confirm'] = [[round(c['p4'], 3), None if c.get('p5') is None else round(c['p5'], 3)] for c in deep]
        return out
    if all(c['actions'] is None for c in win):
        out['verdict'] = 'unconfirmed'     # only the played turn wins, and the engine never expanded it
        return out
    # A winner the root search never expanded (the played turn) is still a
    # solution by its key; it has no stored actions to show.
    sols = [{'actions': c['actions'], 'after': c['after'], 'key': c['key'],
             'p': round(min(c['p4'], c['p5']), 4)}
            for c in sorted(win, key=lambda c: (c['actions'] is None, -c['p5']))]
    p_best = min(c['p5'] for c in win)
    p_second = max([max(c['p4'], c['p5']) for c in rest] or [0.0])
    out.update(verdict='puzzle', solutions=sols, p_best=round(p_best, 4), p_second=round(p_second, 4),
               accept_p=round((p_best + p_second) / 2, 4),
               played=bool(played_after) and key_of(played_after) in {c['key'] for c in win})
    return out


def split(judged, k):
    """(verdict or None, winners, rest) by the gap rule on field `k`."""
    if not judged:
        return 'no gap', [], []
    best = max(c[k] for c in judged)
    if best < WIN_P:
        return 'not winning', [], []
    win = [c for c in judged if c[k] >= best - BAND]
    rest = [c for c in judged if c[k] < best - BAND]
    if len(win) > MAX_SOLUTIONS:
        return 'too many', win, rest
    if any(c[k] > best - GAP for c in rest):
        return 'grey', win, rest
    return None, win, rest
