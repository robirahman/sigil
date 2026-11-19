#!/usr/bin/env python3
"""Engine-correlation fair-play scan: a simplified Irwin over a completed_games dump.

For each player's recent RATED games, every turn they played is searched by the
shipped engine and compared with the engine's own choice. Players whose turns match
the engine unusually often, or lose unusually little, compared with players of
similar rating are flagged, with confidence intervals.

FLAGS ARE FOR HUMAN REVIEW. Nothing here suspends anyone and no flag alone justifies
a suspension: a flag says "an admin should open these games". Strong players agree
with the engine more; a short sample is noisy; the engine's own blind spots (it
never generates many human dashes, engine/FINDINGS) shift everyone's numbers. The
admin page (admin.html, "Engine scan") shows the report beside the games.

How Robi runs it (any machine with the Python binding built, ideally a VM: the
scan reads a dump file and never touches the live database itself):

    # 0. the binding (engine/README.md)
    python3 -m venv .venv && .venv/bin/pip install maturin
    cd engine && VIRTUAL_ENV=../.venv ../.venv/bin/maturin develop --release && cd ..
    # 1. the dump: a service-account read of completed_games (eval_games.py)
    python engine/harness/eval_games.py download --since 2026-09-01 \\
        --service-account "<sa.json>" --out work/raw.json
    # 2. each player's last N rated games, replayed to positions (node + the site engine)
    python engine/harness/fair_play_scan.py select --raw work/raw.json --out work/fp_lines.json
    # 3. search every turn those players made (resumable; rerun to continue)
    python engine/harness/fair_play_scan.py eval --lines work/fp_lines.json \\
        --out work/fp_evals.jsonl --depth 4 --workers 4
    # 4. statistics and flags -> JSON report (+ a summary on stdout)
    python engine/harness/fair_play_scan.py report --lines work/fp_lines.json \\
        --evals work/fp_evals.jsonl --out work/fp_report.json
    # 5. either open work/fp_report.json on admin.html ("Engine scan" -> "Open a
    #    report file"; read in the browser, nothing uploaded), or publish it for
    #    every admin: a dry run, then --apply (writes fairplay_reports/<run>)
    python engine/harness/fair_play_scan.py upload --report work/fp_report.json \\
        --service-account "<sa.json>" [--apply]

Cost: one search per turn analysed, plus one a ply shallower for the turns the
engine did not pick and could not score exactly (about half of all turns in the
fixture games). Measured 2026-11-19 on a loaded 4-vCPU box, shipped eval: depth 3
~1 s, depth 4 ~4 s a position. 50 players x 20 games x ~20
turns at depth 4 is ~20,000 positions, ~22 CPU-hours: run it on a VM with --workers
set to its cores, or try depth 3 first (--depth 3, ~5x cheaper).

What is measured, per turn the player made (position i = that turn's sfnBefore):
  * the SHIPPED search (SHIPPED_EVAL, SHIPPED_POLICY / SHIPPED_EXPLORE, the engine's
    width and adaptive constants: what the site's AI plays) to exactly --depth,
    untimed, a fresh table per position, the game so far as repetition history;
  * the played turn is searched FIRST at the root (`probe_first`) and its score
    read from there; when that score is only a fail-low bound, or the root list
    does not hold the turn at all (the engine never generated it), the position
    after it is searched at depth-1 instead and its score negated (not on a game's
    last turn, whose recorded after-position keeps the mover's token: that turn
    then counts only when it matches);
  * match: the turn reaches the same position as the engine's choice (side-to-move
    and turn-counter tokens aside, as the engine's own probe matches it);
  * loss: best score - played score, both clamped to +-cap centistones (STONE = 100),
    never negative;
  * close: loss <= --close centistones (Sigil has many equivalent orders of a turn).
Turns left out: each side's first --opening-turns turns (book and formula), forced
positions (one root turn), positions already decided (|best| >= --decided or a
forced result), and searches that failed.

Per player: match rate (T1), mean loss (ACPL) and close rate, each with a 95%
interval from a bootstrap over GAMES (turns of one game are not independent), and
their mean rating at the time (completed_games <color>EloBefore). Peers: the other
players with enough data whose mean rating is within --band (widened, doubling, until
--min-peers are found; the report says which band). Flags:
  review  the player's T1 interval lies wholly above the peers' 95th percentile, OR
          their ACPL interval lies wholly below the peers' 5th percentile;
  strong  both, against at least --min-peers peers (fewer: at most review; fewer
          than MIN_JUDGED_PEERS: no flag at all);
  insufficient  fewer than --min-games games or --min-turns turns: no verdict.
The site's AI accounts (`__ai_` uids) are analysed in up to --ai-games games each as
ANCHORS: what the engine itself scores on these measures. They are never flagged.

The report (JSON; admin.html reads it, from the file or fairplay_reports/<run>):
  {version, generatedAt, run, engine, depth, params, source{games, players},
   note, players: [player...], anchors: [player...]}
  player = {uid, rating, games, turns, t1{est,lo,hi}, acpl{...}, close{...},
            peers{n, band, t1{mean,sd,p95}, acpl{mean,sd,p05}, close{mean,sd,p95}},
            z{t1, acpl, close}, flag, why[], gameList[{gameId, roomCode, timestamp,
            color, opponentUid, rating, turns, t1, acpl}]}
"""
import argparse
import hashlib
import json
import math
import os
import random
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, REPO)

REPORT_VERSION = 1
TT_BITS = 20
# Fewer comparable players than this and no player is flagged at all: their
# percentiles mean nothing. Below --min-peers a flag is at most 'review'.
MIN_JUDGED_PEERS = 4
DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'
NOTE = ('Flags are for human review only. A flag means: open these games and look. '
        'Never suspend on a flag alone; strong players agree with the engine more, '
        'and a short sample is noisy.')


def _ai(uid):
    return isinstance(uid, str) and uid.startswith('__ai_')


def _human(uid):
    return isinstance(uid, str) and bool(uid) and not _ai(uid) and uid != 'deleted'


def position_key(sfn):
    """The position without the side-to-move and turn-counter tokens (the engine's
    search::probe_key): the recorded final position keeps the mover's token
    (eval_games.position_key), so neither may decide a match."""
    return ' '.join(t for i, t in enumerate(sfn.split()) if i not in (1, 2))


# ------------------------------------------------------------------ select ---

def rated(g):
    """A game the server rated (functions/rating.js ratingUpdates wrote the ratings
    before it); unrated records carry unratedReason instead."""
    return (isinstance(g, dict) and g.get('eloProcessed') is True and not g.get('unratedReason')
            and isinstance(g.get('redEloBefore'), (int, float)) and isinstance(g.get('blueEloBefore'), (int, float)))


def choose_games(raw, per_player, ai_games, since_ms=0):
    """{gameId: set of colours to analyse}: each human's last `per_player` rated games
    (their own colour), and each AI account's last `ai_games` (as an anchor)."""
    by_uid = defaultdict(list)
    for gid, g in raw.items():
        if not rated(g) or (g.get('timestamp') or 0) < since_ms:
            continue
        v = g.get('variant') or 'standard'
        if 'pentagon' in v or 'duplicates' in v:
            continue
        for c in ('red', 'blue'):
            u = g.get(c + 'Uid')
            if _human(u) or _ai(u):
                by_uid[u].append((g.get('timestamp') or 0, gid, c))
    pick = defaultdict(set)
    for u, games in by_uid.items():
        games.sort(reverse=True)
        for _ts, gid, c in games[:(ai_games if _ai(u) else per_player)]:
            pick[gid].add(c)
    return pick


def cmd_select(a):
    from ai.replay_bridge import hydrate_records, _normalize_turns
    raw = json.load(open(a.raw, encoding='utf-8'))
    since = datetime.fromisoformat(a.since).replace(tzinfo=timezone.utc).timestamp() * 1000 if a.since else 0
    pick = choose_games(raw, a.games_per_player, a.ai_games, since)
    keep, skipped = [], Counter()
    for gid in sorted(pick):
        g = raw[gid]
        t = _normalize_turns(g.get('turns'))
        if not t:
            skipped['no turns'] += 1
            continue
        if not g.get('setupSfn') and not t[0].get('sfnBefore') and g.get('startPos'):
            skipped['from a position without setupSfn'] += 1
            continue
        keep.append((gid, g, t))
    out = {}
    for s in range(0, len(keep), a.batch):
        chunk = keep[s:s + a.batch]
        recs = [{'spellNames': g.get('spellNames') or [], 'variant': g.get('variant') or 'standard',
                 'setupSfn': g.get('setupSfn'), 'finalSfn': None, 'turns': t} for _k, g, t in chunk]
        try:
            res = hydrate_records(recs)
        except Exception as e:  # noqa: BLE001
            print(f'  batch {s} failed: {str(e)[:200]}', flush=True)
            skipped['bridge error'] += len(chunk)
            continue
        for (gid, g, _t), r in zip(chunk, res):
            if not isinstance(r, dict) or not r.get('ok'):
                skipped['replay failed'] += 1
                continue
            turns = r['turns']
            positions = [x.get('sfnBefore') for x in turns] + [turns[-1].get('sfnAfter')]
            if any(not p for p in positions):
                skipped['missing sfn'] += 1
                continue
            if any(tok.startswith(('ab:', 'sn:')) for p in positions for tok in p.split()):
                skipped['retired spell tokens'] += 1
                continue
            out[gid] = {
                'roomCode': g.get('roomCode'), 'timestamp': g.get('timestamp'), 'winner': g.get('winner'),
                'variant': g.get('variant') or 'standard', 'endReason': g.get('endReason') or 'play',
                'uids': {'red': g.get('redUid'), 'blue': g.get('blueUid')},
                'ratings': {'red': g.get('redEloBefore'), 'blue': g.get('blueEloBefore')},
                'analyze': sorted(pick[gid]),
                'movers': [x.get('color') for x in turns],
                'positions': positions,
            }
        print(f'  replayed {min(s + a.batch, len(keep))}/{len(keep)}', flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as fh:
        json.dump(out, fh)
    players = {g['uids'][c] for g in out.values() for c in g['analyze']}
    n_turns = sum(sum(1 for m in g['movers'] if m in g['analyze']) for g in out.values())
    print(f'{len(out)} games, {len(players)} players, {n_turns} turns to search; skipped {dict(skipped)} -> {a.out}')


# -------------------------------------------------------------------- eval ---

def _engine_tag():
    try:
        from eval_games import ENGINE_TAG
        return ENGINE_TAG
    except Exception:  # noqa: BLE001
        return 'rust-unknown'


def _shipped(se):
    """The site's own search configuration (eval_games.engine_eval under
    SIGIL_AUDIT_ENGINE=shipped): its eval, and the generator policy, which is
    thread-local and off by default in Python, so it is set before every search."""
    if hasattr(se, 'SHIPPED_POLICY') and hasattr(se, 'set_policy'):
        se.set_policy(*se.SHIPPED_POLICY)
    if hasattr(se, 'SHIPPED_EXPLORE') and hasattr(se, 'set_policy_explore'):
        se.set_policy_explore(*se.SHIPPED_EXPLORE)
    return getattr(se, 'SHIPPED_EVAL', 'tfit')


def analyse_turn(se, positions, i, depth, time_ms, tt_bits=TT_BITS):
    """One turn: the search of position i with the played turn (position i+1)
    probed first. Returns the row's measured fields."""
    ev = _shipped(se)
    kw = dict(max_depth=depth, time_ms=time_ms, width_scale=se.DEFAULT_WIDTH_SCALE, adaptive=se.SHIPPED_ADAPTIVE)
    t0 = time.time()
    r = se.SearchSession(tt_bits).analyze(positions[i], ev, history_sfns=positions[:i],
                                          probe_sfn=positions[i + 1], probe_first=True, **kw)
    if r['over']:
        return {'over': True}
    row = {'over': False, 'score': r['score'], 'mate': r['mate_in_turns'], 'depth': r['depth'], 'nodes': r['nodes'],
           'match': bool(r.get('expected_sfn')) and position_key(r['expected_sfn']) == position_key(positions[i + 1]),
           'eval': ev}
    probe = r.get('probe')
    ix = n = v = alpha = None
    if probe is not None:
        _pd, ix, n, v, alpha = probe
    if row['match']:
        # The engine's own choice: no loss, whatever bound the probe had.
        row.update(played=r['score'], exact=True, ix=ix, n=n, fallback=False)
    elif probe is not None and v > alpha:
        row.update(played=v, exact=True, ix=ix, n=n, fallback=False)
    elif i + 1 >= len(positions) - 1:
        # The game's last turn: its after-position is the recorded final one,
        # which keeps the mover's token, so it is not searched (no loss).
        row.update(played=None, exact=False, ix=ix, n=n, fallback=False)
    else:
        # The root list never held the played turn, or its score there failed
        # low (an upper bound only, which would understate the loss): its
        # value from the position it reached, one ply shallower, from the
        # mover's side.
        kw['max_depth'] = max(1, depth - 1)
        _shipped(se)
        ra = se.SearchSession(tt_bits).analyze(positions[i + 1], ev, history_sfns=positions[:i + 1], **kw)
        if ra['over']:
            won = ra.get('winner') == row_mover(positions[i])
            played = 10 ** 7 if won else -10 ** 7
        else:
            played = -ra['score'] if ra['score'] is not None else None
        row.update(played=played, exact=True, ix=ix, n=n, fallback=True)
    row['sec'] = round(time.time() - t0, 3)
    return row


def row_mover(sfn):
    return 'red' if sfn.split()[1] == 'r' else 'blue'


def eval_game(item):
    gid, game, idx, depth, time_ms, tag = item
    import sigil_engine as se
    rows = []
    for i in idx:
        base = {'g': gid, 'i': i, 'mover': game['movers'][i], 'd': depth, 'engine': tag}
        try:
            base.update(analyse_turn(se, game['positions'], i, depth, time_ms))
        except Exception as e:  # noqa: BLE001
            base['error'] = f'{type(e).__name__}: {e}'
        rows.append(base)
    return gid, rows


def _done(path, depth, tag):
    done = set()
    if not os.path.exists(path):
        return done
    for line in open(path, encoding='utf-8'):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get('d') == depth and r.get('engine') == tag and 'error' not in r:
            done.add((r['g'], r['i']))
    return done


def cmd_eval(a):
    lines = json.load(open(a.lines, encoding='utf-8'))
    tag = _engine_tag()
    done = _done(a.out, a.depth, tag)
    items = []
    for gid, g in sorted(lines.items()):
        n = len(g['positions']) - 1
        idx = [i for i in range(n) if g['movers'][i] in g['analyze'] and (gid, i) not in done]
        if idx:
            items.append((gid, g, idx, a.depth, a.time_ms, tag))
    total = sum(len(it[2]) for it in items)
    print(f'{total} turns in {len(items)} games to search at depth {a.depth} ({len(done)} done) with {a.workers} workers', flush=True)
    t0, n_done = time.time(), 0
    with open(a.out, 'a', encoding='utf-8') as fh:
        if a.workers <= 1:
            results = map(eval_game, items)
        else:
            pool = ProcessPoolExecutor(a.workers)
            results = (f.result() for f in as_completed([pool.submit(eval_game, it) for it in items]))
        for _gid, rows in results:
            for r in rows:
                fh.write(json.dumps(r) + '\n')
            fh.flush()
            n_done += len(rows)
            rate = n_done / max(1e-9, time.time() - t0)
            print(f'  {n_done}/{total} turns, {rate:.2f}/s, ~{(total - n_done) / max(rate, 1e-9) / 60:.0f} min left', flush=True)
    print(f'done -> {a.out}')


# ------------------------------------------------------------------ report ---

def load_rows(path, depth=None):
    """The newest row per (game, index), optionally of one depth."""
    rows = {}
    for line in open(path, encoding='utf-8'):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if depth is not None and r.get('d') != depth:
            continue
        rows[(r['g'], r['i'])] = r
    return rows


def turn_measure(row, opts):
    """(match, loss, close) for an analysed turn, or None when it is left out."""
    if not row or row.get('error') or row.get('over'):
        return None
    if row.get('score') is None or row.get('played') is None or row.get('exact') is False:
        return None
    if row.get('mate') is not None or abs(row['score']) >= opts['decided']:
        return None
    if row.get('n') is not None and row['n'] <= 1:
        return None
    cap = opts['cap']
    best = max(-cap, min(cap, row['score']))
    played = max(-cap, min(cap, row['played']))
    loss = max(0, best - played)
    return (1 if row.get('match') else 0, loss, 1 if loss <= opts['close'] else 0)


def percentile(xs, q):
    """Linear interpolation between order statistics (numpy's default)."""
    s = sorted(xs)
    if not s:
        return None
    k = (len(s) - 1) * q
    f = math.floor(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def _mean_sd(xs):
    if not xs:
        return None, None
    m = sum(xs) / len(xs)
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1)) if len(xs) > 1 else 0.0
    return m, sd


def bootstrap(games, draws, seed):
    """95% intervals of the pooled rates over a player's games, resampling GAMES.
    `games`: [(n, matches, loss_sum, close)]. Returns {t1, acpl, close: (lo, hi)}."""
    rng = random.Random(seed)
    k = len(games)
    est = {'t1': [], 'acpl': [], 'close': []}
    for _ in range(draws):
        n = m = loss = cl = 0
        for _j in range(k):
            g = games[rng.randrange(k)]
            n += g[0]; m += g[1]; loss += g[2]; cl += g[3]
        if n:
            est['t1'].append(m / n); est['acpl'].append(loss / n); est['close'].append(cl / n)
    return {key: (percentile(v, 0.025), percentile(v, 0.975)) for key, v in est.items()}


def _r(x, nd=4):
    return None if x is None else round(x, nd)


def player_stats(lines, rows, opts):
    """Per uid: rating, per-game sums and the game list."""
    per = defaultdict(lambda: {'games': [], 'ratings': [], 'list': []})
    for gid, g in lines.items():
        n_pos = len(g['positions']) - 1
        seen = Counter()
        sums = {c: [0, 0, 0, 0] for c in g['analyze']}
        for i in range(n_pos):
            c = g['movers'][i]
            seen[c] += 1
            if c not in sums or seen[c] <= opts['opening_turns']:
                continue
            tm = turn_measure(rows.get((gid, i)), opts)
            if tm is None:
                continue
            s = sums[c]
            s[0] += 1; s[1] += tm[0]; s[2] += tm[1]; s[3] += tm[2]
        for c, s in sums.items():
            uid = g['uids'][c]
            if s[0] == 0 or not isinstance(uid, str):
                continue
            p = per[uid]
            p['games'].append(tuple(s))
            if isinstance(g['ratings'].get(c), (int, float)):
                p['ratings'].append(g['ratings'][c])
            other = 'blue' if c == 'red' else 'red'
            p['list'].append({'gameId': gid, 'roomCode': g.get('roomCode'), 'timestamp': g.get('timestamp'),
                              'color': c, 'opponentUid': g['uids'].get(other), 'rating': g['ratings'].get(c),
                              'turns': s[0], 't1': _r(s[1] / s[0]), 'acpl': _r(s[2] / s[0], 1)})
    return per


def build_report(lines, rows, opts):
    per = player_stats(lines, rows, opts)
    base = {}
    for uid, p in per.items():
        n = sum(g[0] for g in p['games'])
        seed = int(hashlib.sha256(uid.encode()).hexdigest()[:8], 16)
        ci = bootstrap(p['games'], opts['bootstrap'], seed)
        base[uid] = {
            'uid': uid,
            'rating': _r(sum(p['ratings']) / len(p['ratings']), 1) if p['ratings'] else None,
            'games': len(p['games']), 'turns': n,
            't1': {'est': _r(sum(g[1] for g in p['games']) / n), 'lo': _r(ci['t1'][0]), 'hi': _r(ci['t1'][1])},
            'acpl': {'est': _r(sum(g[2] for g in p['games']) / n, 2), 'lo': _r(ci['acpl'][0], 2), 'hi': _r(ci['acpl'][1], 2)},
            'close': {'est': _r(sum(g[3] for g in p['games']) / n), 'lo': _r(ci['close'][0]), 'hi': _r(ci['close'][1])},
            'gameList': sorted(p['list'], key=lambda e: -(e['timestamp'] or 0)),
        }
    enough = lambda b: b['games'] >= opts['min_games'] and b['turns'] >= opts['min_turns']  # noqa: E731
    pool = [b for u, b in base.items() if not _ai(u) and enough(b) and b['rating'] is not None]
    players, anchors = [], []
    for uid, b in base.items():
        if _ai(uid):
            b['flag'] = 'anchor'
            b['why'] = ['The site\'s own AI: what the engine scores on these measures.']
            anchors.append(b)
            continue
        if not enough(b) or b['rating'] is None:
            b['flag'] = 'insufficient'
            b['why'] = [f"{b['games']} games / {b['turns']} turns analysed: below {opts['min_games']} / {opts['min_turns']}."]
            b['peers'] = None
            b['z'] = None
            players.append(b)
            continue
        others = [o for o in pool if o['uid'] != uid]
        band = opts['band']
        while True:
            peers = [o for o in others if abs(o['rating'] - b['rating']) <= band]
            if len(peers) >= opts['min_peers'] or len(peers) == len(others):
                break
            band *= 2
        pk = {}
        for key, tail in (('t1', 'p95'), ('acpl', 'p05'), ('close', 'p95')):
            xs = [o[key]['est'] for o in peers]
            m, sd = _mean_sd(xs)
            pk[key] = {'mean': _r(m, 4), 'sd': _r(sd, 4), tail: _r(percentile(xs, 0.95 if tail == 'p95' else 0.05), 4)}
        b['peers'] = {'n': len(peers), 'band': band, **pk}
        b['z'] = {key: (_r((b[key]['est'] - pk[key]['mean']) / pk[key]['sd'], 2)
                        if pk[key]['sd'] else None) for key in ('t1', 'acpl', 'close')}
        why = []
        judged = len(peers) >= MIN_JUDGED_PEERS
        hit_t1 = judged and b['t1']['lo'] is not None and b['t1']['lo'] > pk['t1']['p95']
        hit_acpl = judged and b['acpl']['hi'] is not None and b['acpl']['hi'] < pk['acpl']['p05']
        if hit_t1:
            why.append(f"Engine match {b['t1']['est']:.0%} [{b['t1']['lo']:.0%}, {b['t1']['hi']:.0%}]: the whole interval is above "
                       f"the 95th percentile of {len(peers)} players within {band:g} rating ({pk['t1']['p95']:.0%}).")
        if hit_acpl:
            why.append(f"Average loss {b['acpl']['est']:.1f} [{b['acpl']['lo']:.1f}, {b['acpl']['hi']:.1f}] centistones: the whole interval "
                       f"is below the 5th percentile of {len(peers)} players within {band:g} rating ({pk['acpl']['p05']:.1f}).")
        thin = len(peers) < opts['min_peers']
        if not judged:
            why.append(f"No verdict: only {len(peers)} comparable players (at least {MIN_JUDGED_PEERS} needed).")
        elif thin:
            why.append(f"Thin reference: only {len(peers)} comparable players, so at most 'review'.")
        b['flag'] = ('strong' if (hit_t1 and hit_acpl and not thin) else 'review' if (hit_t1 or hit_acpl) else 'none')
        b['why'] = why
        players.append(b)
    order = {'strong': 0, 'review': 1, 'none': 2, 'insufficient': 3}
    players.sort(key=lambda b: (order[b['flag']], -(b['z']['t1'] if b.get('z') and b['z'].get('t1') is not None else -99)))
    anchors.sort(key=lambda b: b['uid'])
    return players, anchors


def cmd_report(a):
    lines = json.load(open(a.lines, encoding='utf-8'))
    rows = load_rows(a.evals, a.depth)
    opts = dict(opening_turns=a.opening_turns, decided=a.decided, cap=a.cap, close=a.close, band=a.band,
                min_peers=a.min_peers, min_games=a.min_games, min_turns=a.min_turns, bootstrap=a.bootstrap)
    players, anchors = build_report(lines, rows, opts)
    depths = Counter(r.get('d') for r in rows.values())
    engines = Counter(r.get('engine') for r in rows.values())
    now = int(time.time() * 1000)
    report = {
        'version': REPORT_VERSION, 'generatedAt': now,
        'run': datetime.fromtimestamp(now / 1000, timezone.utc).strftime('%Y%m%dT%H%M%SZ'),
        'engine': engines.most_common(1)[0][0] if engines else None,
        'depth': depths.most_common(1)[0][0] if depths else None,
        'evalName': next((r.get('eval') for r in rows.values() if r.get('eval')), None),
        'params': opts,
        'source': {'games': len(lines), 'rows': len(rows), 'lines': os.path.basename(a.lines)},
        'note': NOTE,
        'players': players, 'anchors': anchors,
    }
    with open(a.out, 'w', encoding='utf-8') as fh:
        json.dump(report, fh, indent=1)
    flags = Counter(p['flag'] for p in players)
    print(f"{len(players)} players ({dict(flags)}), {len(anchors)} AI anchors -> {a.out}")
    print(f"{'flag':<13}{'uid':<30}{'rating':>7}{'games':>6}{'turns':>6}  {'T1 [95%]':<18}{'ACPL [95%]':<20}{'peers':>6}")
    for b in players + anchors:
        t1, ac = b['t1'], b['acpl']
        print(f"{b['flag']:<13}{b['uid'][:29]:<30}{b['rating'] if b['rating'] is not None else '-':>7}{b['games']:>6}{b['turns']:>6}  "
              f"{t1['est']:.2f} [{t1['lo']:.2f},{t1['hi']:.2f}]  {ac['est']:6.1f} [{ac['lo']:.1f},{ac['hi']:.1f}]  "
              f"{(b.get('peers') or {}).get('n', '-'):>6}")
    print(NOTE)


# ------------------------------------------------------------------ upload ---

def cmd_upload(a):
    report = json.load(open(a.report, encoding='utf-8'))
    run = report.get('run') or datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    body = json.dumps(report, allow_nan=False)
    dest = f'fairplay_reports/{run}'
    print(f'{dest}: {len(report.get("players", []))} players, {len(body) / 1024:.0f} KB')
    if not a.apply:
        print('dry run: pass --apply to write it (admins read it on admin.html, "Engine scan").')
        return
    import requests
    from eval_games import db_token
    tok = db_token(a.service_account)
    r = requests.put(f'{DB_URL}/{dest}.json', params={'access_token': tok}, data=body, timeout=300)
    r.raise_for_status()
    print(f'written -> {dest}')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('select', help='pick each player\'s recent rated games and replay them')
    s.add_argument('--raw', required=True, help='completed_games dump (eval_games.py download)')
    s.add_argument('--out', required=True)
    s.add_argument('--games-per-player', type=int, default=20)
    s.add_argument('--ai-games', type=int, default=8, help='games per AI account, as anchors (0 = none)')
    s.add_argument('--since', default=None, help='YYYY-MM-DD: only games from then on')
    s.add_argument('--batch', type=int, default=200)
    e = sub.add_parser('eval', help='search every selected turn (resumable)')
    e.add_argument('--lines', required=True)
    e.add_argument('--out', required=True)
    e.add_argument('--depth', type=int, default=4)
    e.add_argument('--time-ms', type=int, default=0, help='a cap per search (0 = untimed, exactly --depth)')
    e.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    r = sub.add_parser('report', help='statistics and flags')
    r.add_argument('--lines', required=True)
    r.add_argument('--evals', required=True)
    r.add_argument('--out', required=True)
    r.add_argument('--depth', type=int, default=None, help='use rows of this depth only')
    r.add_argument('--opening-turns', type=int, default=2, help='each side\'s first turns left out')
    r.add_argument('--decided', type=int, default=600, help='|best score| (centistones) at which a position is decided')
    r.add_argument('--cap', type=int, default=600, help='scores clamped to +-cap before the loss')
    r.add_argument('--close', type=int, default=10, help='a loss up to this counts as close')
    r.add_argument('--band', type=float, default=150, help='peer rating band (widened until --min-peers)')
    r.add_argument('--min-peers', type=int, default=8)
    r.add_argument('--min-games', type=int, default=5)
    r.add_argument('--min-turns', type=int, default=60)
    r.add_argument('--bootstrap', type=int, default=2000)
    u = sub.add_parser('upload', help='publish a report to fairplay_reports/ (admins only)')
    u.add_argument('--report', required=True)
    u.add_argument('--service-account', default=None)
    u.add_argument('--apply', action='store_true')
    a = ap.parse_args()
    {'select': cmd_select, 'eval': cmd_eval, 'report': cmd_report, 'upload': cmd_upload}[a.cmd](a)


if __name__ == '__main__':
    main()
