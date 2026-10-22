#!/usr/bin/env python3
"""Generate the Puzzles page's mate-in-1 / mate-in-2 set from real games.

    # one-off: pull the games (service account) and hydrate them
    python tools/gen_mate_puzzles.py --download --service-account sa.json \
        --hydrated /tmp/hydrated.json --work /tmp/mates.jsonl \
        --out docs/static/puzzles/mate_puzzles.json

    # rerun from a hydrated dump (resumes from --work if present)
    python tools/gen_mate_puzzles.py --hydrated /tmp/hydrated.json \
        --work /tmp/mates.jsonl --out docs/static/puzzles/mate_puzzles.json

Every position a player faced in a completed game is handed to
`sigil_engine.solve_mates` (engine/src/mate.rs). Mate-in-1 is EXHAUSTIVE: the
root is enumerated in full, so the winning set is complete and "no mate-in-1"
is a proof. Mate-in-2 is nominate-then-prove: candidate first turns come from
the strength engine's mate-scored root moves and from the turn actually played
when the mover won soon after; each candidate is then proven against EVERY
legal reply, with the mover's mate-in-1 after each reply established by a full
enumeration when the fast ordered probe does not find one. Nothing is ever
inferred from a truncated enumeration (the position is skipped instead). So a
puzzle the opponent can escape on the live page is evidence of a rules
disagreement between the Rust engine and the browser engine -- which is what
the page is for. Positions with no reported mate-in-2 may still hold one the
nominator missed.

Output schema (docs/static/puzzles/mate_puzzles.json):

    { "generated": ISO-8601, "engine": {...}, "count": N,
      "puzzles": [ {
          "id": "<gameId>-t<turnNumber>", "mate": 1|2, "mover": "red"|"blue",
          "sfn": "<position, side to move = mover>", "variant": "standard",
          "turn": <turnNumber>, "game": {"id","red","blue","winner","date"},
          "played": true|false,        # did the mover find a winning turn in the game?
          "win_fraction": 0.0-1.0,     # winning first turns / distinct first turns
          "root_successors": N,
          "solution_keys": ["<partial SFN>", ...],   # every winning first turn, by position
          "solutions": [ { "actions": [...applyAITurn actions...], "after": "<sfn>", "key": "...",
                           "defence": {"actions": [...], "after": "<sfn>"},   # mate-in-2 only
                           "mates_after_defence": N, "replies": N } ]
      } ] }

A player's turn is matched by the POSITION it produces (`sfn_key`: stones,
spell counters, locks, springlocks), never by the tokens typed, because many
click sequences reach the same board.
"""

import argparse
import glob
import hashlib
import json
import os
import subprocess
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, 'tools'))
import winning_turns  # noqa: E402

DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'


# ---------------------------------------------------------------- corpus ----

def download_raw(service_account, out_path):
    import requests
    import google.auth.transport.requests
    from google.oauth2 import service_account as sa
    creds = sa.Credentials.from_service_account_file(
        service_account,
        scopes=['https://www.googleapis.com/auth/firebase.database',
                'https://www.googleapis.com/auth/userinfo.email'])
    creds.refresh(google.auth.transport.requests.Request())
    r = requests.get(DB_URL + '/completed_games.json',
                     params={'access_token': creds.token}, timeout=900)
    r.raise_for_status()
    data = r.json() or {}
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(data, fh)
    print(f'downloaded {len(data)} games -> {out_path}', flush=True)
    return data


def hydrate(raw, out_path, batch=200):
    """Replay slim transcripts into per-turn SFNs through the browser engine
    (ai.replay_bridge -> reconstructGameLog); the ONE canonical replayer."""
    from ai.replay_bridge import hydrate_records, _normalize_turns
    keep, skipped = [], Counter()
    for k, g in raw.items():
        if not isinstance(g, dict) or not g.get('turns'):
            skipped['no turns'] += 1
            continue
        t = _normalize_turns(g['turns'])
        if not t:
            skipped['bad turns'] += 1
            continue
        if not g.get('setupSfn') and not t[0].get('sfnBefore'):
            skipped['no setupSfn'] += 1
            continue
        keep.append((k, g, t))
    out = {}
    for s in range(0, len(keep), batch):
        chunk = keep[s:s + batch]
        # The bridge's own final-position check compares the SFN byte for
        # byte, and recorded finalSfns often carry the other side-to-move
        # token (284 of 306 'mismatches' in the 2026-10 corpus differed in that
        # token alone). Replay unchecked, then compare positions by sfn_key.
        recs = [{'spellNames': g.get('spellNames') or [],
                 'variant': g.get('variant') or 'standard',
                 'setupSfn': g.get('setupSfn'), 'finalSfn': None,
                 'turns': t} for _k, g, t in chunk]
        try:
            res = hydrate_records(recs)
        except Exception as e:  # noqa: BLE001
            print(f'  batch {s} failed: {str(e)[:200]}', flush=True)
            skipped['bridge error'] += len(chunk)
            continue
        for (k, g, t), r in zip(chunk, res):
            if not isinstance(r, dict) or not r.get('ok'):
                skipped['hydrate fail'] += 1
                continue
            fin = g.get('finalSfn')
            if fin and r['turns'] and len(fin.split()) >= 6 and sfn_key(r['turns'][-1]['sfnAfter']) != sfn_key(fin):
                skipped['final position mismatch'] += 1
                continue
            out[k] = {
                'redUid': g.get('redUid'), 'blueUid': g.get('blueUid'),
                'winner': g.get('winner'), 'timestamp': g.get('timestamp'),
                'variant': g.get('variant') or 'standard',
                'spellNames': g.get('spellNames'),
                'turns': [{'color': x.get('color'), 'turnNumber': x.get('turnNumber'),
                           'sfnBefore': x.get('sfnBefore'), 'sfnAfter': x.get('sfnAfter'),
                           'fat': not bool(o.get('actions'))}
                          for x, o in zip(r['turns'], t)],
            }
        print(f'  hydrated {min(s + batch, len(keep))}/{len(keep)}', flush=True)
    print(f'hydrated {len(out)} games; skipped {dict(skipped)}', flush=True)
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh)
    return out


# ---------------------------------------------------------------- solving ---

def sfn_key(sfn):
    """Position identity independent of the turn counter and side-to-move
    token: the JS records a turn's after-state with the mover still marked
    to move, the engine with the side flipped; both share these tokens."""
    p = sfn.split()
    key = ' '.join([p[0].split('/')[0], p[3], p[4], p[5]])   # spells dropped: constant per puzzle
    # Providence banks (`pm:r:b`) are game state the stone field does not show.
    pm = next((t for t in p[6:] if t.startswith('pm:')), None)
    return key + ' ' + pm if pm else key


def _solve_one(item):
    key, sfn, budget, time_ms, hints, max_mate = item
    import sigil_engine
    r = json.loads(sigil_engine.solve_mates(sfn, budget, time_ms, hints, max_mate))
    return key, r


def who(uid):
    """Public-safe player label. Real accounts are 'Human'; AI accounts are
    named by tier (`__ai_rust_hard__` -> 'AI (rust hard)')."""
    if not uid:
        return 'Unknown'
    if uid.startswith('__ai_'):
        return 'AI (' + uid.strip('_')[3:].replace('_', ' ') + ')'
    return 'Human'


def in_shard(gid, shard):
    """`shard` = (i, n): this VM's slice of the corpus, by a stable hash of
    the game id (Python's hash() is salted per process)."""
    if not shard:
        return True
    i, n = shard
    return int(hashlib.sha1(gid.encode()).hexdigest(), 16) % n == i


def iter_positions(hyd, min_turn, shard=None):
    """Yield (gameId, turn, sfnBefore, hints). `hints` are after-positions
    the solver should nominate as mate-in-2 candidates besides the engine's
    own: the turn the mover actually played, when the mover went on to win
    within their next two turns (so the recorded line may well be the mate)."""
    for gid, g in hyd.items():
        if not in_shard(gid, shard):
            continue
        if 'scramble' in (g.get('variant') or ''):
            continue                      # sixth-spell win rule: the engine reads it as Standard
        if 'duplicates' in (g.get('variant') or ''):
            continue                      # draw variant the engine does not model
        if 'pentagon' in (g.get('variant') or ''):
            continue                      # 65-node Cataclysm board: engine is core-only
        turns = g['turns']
        last = turns[-1]['turnNumber'] if turns else 0
        for t in turns:
            s = t.get('sfnBefore')
            if not s:
                continue
            toks = s.split()
            if any(x.startswith(('ab:', 'sn:')) for x in toks):
                continue                  # retired packs (Aftershock, Ambush)
            if int(toks[2]) < min_turn:
                continue
            hints = []
            if (g.get('winner') == t.get('color') and t.get('sfnAfter')
                    and last - t['turnNumber'] <= 5):
                hints.append(t['sfnAfter'])
            yield gid, t, s, hints


def load_work(paths):
    """{key: result} from one or more jsonl work files (later lines win)."""
    done = {}
    for path in paths:
        if not os.path.exists(path):
            continue
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                    done[rec['key']] = rec['result']
                except (ValueError, KeyError):
                    continue
    return done


def work_paths(spec):
    """--work / --winning-work may name several files (comma-separated or a
    glob) when assembling a fleet's results; solving appends to the first."""
    out = []
    for part in spec.split(','):
        hits = sorted(glob.glob(part))
        out.extend(hits if hits else [part])
    return out


def collect_positions(hyd, args, old):
    """Every position to examine: the corpus (this shard), then the previous
    set's puzzles whose position the corpus no longer holds (a purged game, a
    replay that now fails), so every old puzzle is re-proven under today's
    rules. Each old puzzle's solutions also become nomination hints for its
    position. Returns dicts {key, gid, turn, sfn, hints, after, game, mover_uid,
    old_id, dist}."""
    old_by_pos = {}
    for p in (old or {}).get('puzzles', []):
        old_by_pos[(sfn_key(p['sfn']), p['sfn'].split()[1])] = p
    out, seen_pos = [], set()
    last_turn = {gid: (g['turns'][-1]['turnNumber'] if g['turns'] else 0) for gid, g in hyd.items()}
    for gid, t, s, hints in iter_positions(hyd, args.min_turn, args.shard):
        pk = (sfn_key(s), s.split()[1])
        if pk in seen_pos:
            continue
        seen_pos.add(pk)
        g = hyd[gid]
        op = old_by_pos.get(pk)
        if op:
            hints = hints + [x['after'] for x in op.get('solutions', []) if x.get('after')]
        out.append({'key': f"{gid}:t{t['turnNumber']}", 'gid': gid, 'turn': t['turnNumber'], 'sfn': s,
                    'hints': hints, 'after': t.get('sfnAfter'), 'fat': bool(t.get('fat')),
                    'game': g, 'mover_uid': g.get((t.get('color') or '') + 'Uid'),
                    'old_id': op['id'] if op else None,
                    'dist': last_turn.get(gid, 0) - t['turnNumber'],
                    'last': bool(g['turns']) and g['turns'][-1]['turnNumber'] == t['turnNumber'],
                    # The mover went on to win soon (whether or not the record
                    # holds the after-position: self-play shards miss the last one).
                    'won_soon': g.get('winner') == t.get('color') and last_turn.get(gid, 0) - t['turnNumber'] <= 5})
    for pk, op in old_by_pos.items():
        if pk in seen_pos or not in_shard(op['game']['id'], args.shard):
            continue
        seen_pos.add(pk)
        out.append({'key': 'old:' + op['id'], 'gid': op['game']['id'], 'turn': op['turn'], 'sfn': op['sfn'],
                    'hints': [x['after'] for x in op.get('solutions', []) if x.get('after')],
                    'after': None, 'fat': False, 'game': None, 'old_game': op['game'],
                    'variant': op.get('variant'), 'mover_uid': None, 'old_id': op['id'],
                    'dist': 0, 'last': False, 'won_soon': True})
    return out


def _winning_one(item):
    key, sfn, after = item
    import winning_turns
    return key, winning_turns.analyze_position(sfn, after)


def run_pool(fn, items, work_path, workers, label):
    """Run `fn` over `items` in a process pool, streaming {key, result} lines
    to `work_path` (never holding results in memory: an early version did and
    reached 7.5 GB)."""
    t0 = time.time()
    n = 0
    chunk = max(8, 16 * workers)
    with open(work_path, 'a', encoding='utf-8') as wf, \
            ProcessPoolExecutor(max_workers=workers) as ex:
        for start in range(0, len(items), chunk):
            futs = [ex.submit(fn, it) for it in items[start:start + chunk]]
            for f in as_completed(futs):
                key, r = f.result()
                wf.write(json.dumps({'key': key, 'result': r}) + '\n')
                n += 1
                if n % 50 == 0:
                    wf.flush()
                    el = time.time() - t0
                    print(f'  {label}: {n}/{len(items)}, {el:.0f}s, {el / n:.2f}s/pos', flush=True)
            wf.flush()


# ------------------------------------------------------------ puzzle meta ----

PACKS = {'Fissure': 'Tectonic', 'Rock_Slide': 'Tectonic', 'Bulwark': 'Tectonic',
         'Dividend': 'Providence', 'Annuity': 'Providence', 'Endowment': 'Providence'}
SACRIFICE_SPELLS = {'Fireblast', 'Seal_of_Destruction'}


def puzzle_tags(p):
    """Theme tags from the shown solution (the first stored line) and the
    position: what kind of turn wins, which spells it casts, and the spell
    pack in play."""
    tags = set()
    for sol in p['solutions'][:1]:
        acts = sol.get('actions') or []
        types = {a.get('type') for a in acts}
        if 'dash' in types:
            tags.add('Dash')
        if any(a.get('pushed_to') for a in acts):
            tags.add('Push')
        casts = [a.get('spell') for a in acts if a.get('type') == 'cast' and a.get('spell')]
        for sp in casts:
            tags.add('Cast: ' + sp.replace('_', ' '))
        if any(sp in SACRIFICE_SPELLS for sp in casts) or any(a.get('sacrificed') for a in acts if a.get('type') != 'dash'):
            tags.add('Sacrifice')
        if acts and not casts:
            tags.add('Quiet')
    spells = p['sfn'].split()[0].split('/')[1].split(',')
    for sp in spells:
        if sp in PACKS:
            tags.add(PACKS[sp])
    if p['turn'] >= 40:
        tags.add('Endgame')
    return sorted(tags)


def _meta_one(item):
    """Difficulty inputs for one puzzle: the shallowest shipped-search depth
    that picks a solution (1-4; 5 = none of them), and the solution's rank
    in the ordered turn stream (how far down a human-like scan it sits)."""
    pid, sfn, keys, after = item
    import sigil_engine as E
    found = 5
    for d in (1, 2, 3, 4):
        try:
            a = E.analyze(sfn, E.SHIPPED_EVAL, max_depth=d, time_ms=20_000)
        except Exception:  # noqa: BLE001
            break
        if a.get('expected_sfn') and sfn_key(a['expected_sfn']) in keys:
            found = d
            break
    rank = -1
    if after:
        try:
            rank = E.rank_of_result(sfn, after, cap=5000)[0]
        except Exception:  # noqa: BLE001
            rank = -1
    return pid, {'found_depth': found, 'rank': rank}


def difficulty_bins(puzzles, meta):
    """1-5 by quintile of a hardness score within each class (mate-in-1,
    -2, -3, winning): found depth first, then stream rank, then for mates
    the share of first turns that win (a smaller share is harder)."""
    groups = {}
    for p in puzzles:
        groups.setdefault(p['kind'] + str(p.get('mate') or ''), []).append(p)
    for ps in groups.values():
        def score(p):
            m = meta.get(p['id']) or {}
            r = m.get('rank', -1)
            return (m.get('found_depth', 5), 5000 if r < 0 else r, -(p.get('win_fraction') or 0))
        ps.sort(key=score)
        n = len(ps)
        for i, p in enumerate(ps):
            p['difficulty'] = 1 + (5 * i) // max(1, n)


# ------------------------------------------------------------------ main ----

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--download', action='store_true', help='fetch completed_games first')
    ap.add_argument('--service-account', default=os.environ.get('SIGIL_FIREBASE_SA'))
    ap.add_argument('--raw', default=None, help='raw completed_games dump (json)')
    ap.add_argument('--hydrated', required=True, help='hydrated per-turn dump (read, or written by --raw/--download)')
    ap.add_argument('--work', required=True,
                    help='jsonl of per-position mate-solver results (resumable); several (comma/glob) when assembling')
    ap.add_argument('--winning-work', default=None,
                    help='jsonl of winning-turn verdicts (tools/winning_turns.py); written by --winning, read at assembly')
    ap.add_argument('--meta-work', default=None, help='jsonl cache of per-puzzle difficulty inputs (assembly)')
    ap.add_argument('--old', default=None, help='the previous puzzle set: every puzzle in it is re-proven and reported on')
    ap.add_argument('--report', default=None, help='write a JSON report (funnels, re-verification of --old)')
    ap.add_argument('--out', default=os.path.join(REPO, 'docs', 'static', 'puzzles', 'mate_puzzles.json'))
    ap.add_argument('--drop', action='append', default=[],
                    help='ID=REASON: leave this puzzle out (a stored line the browser rejects; see tools/puzzle-smoke.js)')
    ap.add_argument('--shard', default=None, help='i/n: solve only this slice of the games (one per VM)')
    ap.add_argument('--budget', type=int, default=400_000_000, help='apply_turn calls (+ generated turns) per position')
    ap.add_argument('--time-ms', type=int, default=20_000, help='wall-clock cap per position (0 = none)')
    ap.add_argument('--max-mate', type=int, default=3, choices=[1, 2, 3], help='deepest mate to look for')
    ap.add_argument('--only-promising', action='store_true',
                    help='solve only positions where the mover went on to win within 4 plies (fast route to mate-in-2/3 puzzles)')
    ap.add_argument('--winning', action='store_true',
                    help='after the mate pass, run the winning-turn analysis on every position without a mate puzzle')
    ap.add_argument('--min-turn', type=int, default=6)
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--limit', type=int, default=0, help='solve at most this many new positions')
    ap.add_argument('--no-solve', action='store_true', help='assemble from the work files only')
    ap.add_argument('--no-assemble', action='store_true', help='solve only (fleet VMs; assembly is local)')
    ap.add_argument('--max-win-fraction', type=float, default=0.34,
                    help='drop mate-in-1 puzzles where more than this share of first turns win')
    ap.add_argument('--max-solutions-stored', type=int, default=12, help='full mate-in-1 lines stored per puzzle')
    ap.add_argument('--max-lines-stored', type=int, default=8, help='full mate-in-2/3 lines stored per puzzle (keys are kept for all)')
    ap.add_argument('--max-continuations-stored', type=int, default=6, help='proven second turns stored per mate-in-3 line')
    ap.add_argument('--retry', choices=['none', 'promising'], default='none',
                    help="re-solve already-solved positions: 'promising' = mover won within 4 plies and the stored "
                         "result was no mate / budget exceeded (a bigger --time-ms gives the nominator more room)")
    ap.add_argument('--max-winning', type=int, default=40,
                    help='drop mate-in-1 puzzles with more distinct winning positions than this (not a puzzle)')
    args = ap.parse_args()
    if args.shard:
        i, n = args.shard.split('/')
        args.shard = (int(i), int(n))

    # ---- corpus
    if args.download:
        if not args.service_account:
            sys.exit('--download needs --service-account (or SIGIL_FIREBASE_SA)')
        raw_path = args.raw or (args.hydrated + '.raw.json')
        raw = download_raw(args.service_account, raw_path)
        hyd = hydrate(raw, args.hydrated)
    elif args.raw:
        with open(args.raw, encoding='utf-8') as fh:
            raw = json.load(fh)
        hyd = hydrate(raw, args.hydrated)
    else:
        with open(args.hydrated, encoding='utf-8') as fh:
            hyd = json.load(fh)
    old = None
    if args.old:
        with open(args.old, encoding='utf-8') as fh:
            old = json.load(fh)
    positions = collect_positions(hyd, args, old)
    work = work_paths(args.work)
    win_work = work_paths(args.winning_work) if args.winning_work else []

    # ---- mate pass (resumable)
    done = load_work(work)
    n_retry = 0
    order = []
    for pos in positions:
        key = pos['key']
        if key in done and args.retry == 'promising' and pos['won_soon'] and pos['dist'] <= 4:
            r = done[key]
            empty = r.get('ok') and not (r.get('mate1') or r.get('mate2') or r.get('mate3'))
            if empty or r.get('error') == 'budget exceeded':
                del done[key]          # the later result wins at assembly
                n_retry += 1
        if key in done:
            continue
        # Mates live at the ends of games: solve positions in order of distance
        # from the final turn so a partial run already holds most of the set.
        # Positions where the MOVER went on to win 2 or 4 plies later come
        # first of all -- that is where mate-in-2 / mate-in-3 puzzles are --
        # and so do the previous set's puzzles.
        promising = pos['won_soon'] and pos['dist'] in (0, 2, 4) or bool(pos['old_id'])
        if args.only_promising and not ((pos['won_soon'] and pos['dist'] <= 4) or pos['old_id']):
            continue
        order.append((0 if promising else 1, pos['dist'], pos))
    order.sort(key=lambda x: (x[0], x[1]))
    todo = [(pos['key'], pos['sfn'], args.budget, args.time_ms, pos['hints'], args.max_mate) for _p, _d, pos in order]
    if args.limit:
        todo = todo[:args.limit]
    if args.no_solve:
        todo = []
    print(f'{len(done)} positions already solved, {len(todo)} to solve with {args.workers} workers'
          + (f' ({n_retry} retried)' if n_retry else ''), flush=True)
    done = None
    if todo:
        run_pool(_solve_one, todo, work[0], args.workers, 'mates')
    done = load_work(work)

    # ---- winning-turn pass (resumable): every position whose mate pass
    # produced no mate puzzle -- including those the solver could not finish.
    if args.winning and not args.no_solve:
        if not win_work:
            sys.exit('--winning needs --winning-work')
        wdone = load_work(win_work)
        wtodo = []
        for pos in positions:
            r = done.get(pos['key'])
            if r is None or pos['key'] in wdone:
                continue
            if r.get('ok') and (r.get('mate1') or r.get('mate2') or r.get('mate3')):
                continue
            wtodo.append((pos['key'], pos['sfn'], pos['after']))
        if args.limit:
            wtodo = wtodo[:args.limit]
        print(f'winning pass: {len(wdone)} done, {len(wtodo)} to analyze', flush=True)
        wdone = None
        if wtodo:
            run_pool(_winning_one, wtodo, win_work[0], args.workers, 'winning')
    if args.no_assemble:
        return
    wdone = load_work(win_work) if win_work else {}

    # ---- assemble puzzles
    outcomes = Counter()
    win_outcomes = Counter()
    puzzles = []
    seen_pos = set()
    # Recorded game-winning turns the solver could NOT reproduce as a mate-in-1:
    # either a rules disagreement between the Rust engine and the browser, or a
    # corrupt transcript (the 2026-09 enumeration audit found 237 fat records and
    # 134 no-op sacrifices that make an after-state illegal). Listed for review.
    unreproduced = []
    by_pos = {}             # position -> the puzzle made there (for the --old report)

    def game_fields(pos):
        if pos['game'] is None:
            return pos['old_game'], pos.get('variant') or 'standard'
        g = pos['game']
        ts = g.get('timestamp')
        date = None
        if isinstance(ts, (int, float)) and ts > 0:
            date = datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc).strftime('%Y-%m-%d')
        return ({'id': pos['gid'], 'red': who(g.get('redUid')), 'blue': who(g.get('blueUid')),
                 'winner': g.get('winner'), 'date': date}, g.get('variant') or 'standard')

    for pos in positions:
        key, s = pos['key'], pos['sfn']
        r = done.get(key)
        if not r:
            continue
        if not r.get('ok'):
            outcomes[r.get('error', 'error')] += 1
            lines = []
        else:
            lines = r['mate1'] or r['mate2'] or r.get('mate3') or []
        pk = (sfn_key(s), s.split()[1])
        game, variant = game_fields(pos)
        mover_human = who(pos['mover_uid']) == 'Human' if pos['mover_uid'] else None
        if r.get('ok') and not lines:
            outcomes['no mate'] += 1
            after = (pos['after'] or '').split()
            g = pos['game'] or {}
            if (len(after) > 6 and after[6] in ('r3', 'b3') and g.get('winner') == r.get('mover') and pos['last']):
                unreproduced.append({'game': pos['gid'], 'turn': pos['turn'], 'mover': r.get('mover'),
                                     'fat_record': pos['fat'], 'sfnBefore': s,
                                     'sfnAfter': pos['after'], 'root_successors': r['root_successors']})
        if not lines:
            w = wdone.get(key)
            if w is None:
                continue
            win_outcomes[w.get('verdict', 'error')] += 1
            if w.get('verdict') != 'puzzle':
                continue
            sols = [x for x in w['solutions'] if x.get('actions')]
            p = {'id': f"{pos['gid']}-t{pos['turn']}", 'kind': 'winning', 'mate': None,
                 'mover': w['mover'], 'sfn': s, 'variant': variant, 'turn': pos['turn'], 'game': game,
                 'played': w.get('played') if pos['after'] else None, 'mover_human': mover_human,
                 'p_best': w['p_best'], 'p_second': w['p_second'], 'accept_p': w['accept_p'],
                 'solution_keys': [sfn_key(x['after']) for x in w['solutions']],
                 'solutions': [{'actions': x['actions'], 'after': x['after'], 'key': sfn_key(x['after']), 'p': x['p']}
                               for x in sols]}
            puzzles.append(p)
            by_pos[pk] = p
            outcomes['winning turn'] += 1
            continue
        mate = 1 if r['mate1'] else (2 if r['mate2'] else 3)
        if pk in seen_pos:
            outcomes['duplicate position'] += 1
            continue
        seen_pos.add(pk)
        total = r.get('mate1_total', len(lines)) if mate == 1 else len(lines)
        frac = total / max(1, r['root_successors'])
        score_tok = s.split()[6] if len(s.split()) > 6 else ''
        if mate == 1 and score_tok == r['mover'][0] + '2':
            # Already two ahead: placing any stone wins, so nothing to find.
            outcomes['mate-in-1 too easy'] += 1
            by_pos[pk] = 'too easy'
            continue
        if mate == 1 and (frac > args.max_win_fraction or total > len(lines) or total > args.max_winning):
            # Too many winning turns to be a puzzle (or more than the solver
            # emits, so the page could not judge every winning move).
            outcomes['mate-in-1 too easy'] += 1
            by_pos[pk] = 'too easy'
            continue
        keys = [sfn_key(l['after']) for l in lines]
        played = sfn_key(pos['after']) in set(keys) if pos['after'] else None
        # Store full lines for the hardest defences first (fewest mates after
        # the defence), so the page's "show solution" picks a real puzzle line.
        lines_sorted = sorted(lines, key=lambda l: (l.get('mates_after_defence', 0), len(l['actions'])))
        # Every winning first turn is kept as a KEY (the page must accept them
        # all); full lines (actions, defence, finish, continuations) are stored
        # for the hardest few only, to keep the set small.
        keep_n = args.max_lines_stored if mate >= 2 else args.max_solutions_stored

        def pack(l, depth=0):
            sol = {'actions': l['actions'], 'after': l['after'], 'key': sfn_key(l['after'])}
            if 'defence' in l:
                sol['defence'] = l['defence']
                sol['finish'] = l.get('finish')
                sol['mates_after_defence'] = l.get('mates_after_defence')
                sol['replies'] = l.get('replies')
            if l.get('continuations'):
                # mate-in-3: the proven second turns against the defence, each
                # with its own defence/finish, keyed by the position they reach.
                conts = sorted(l['continuations'], key=lambda x: (x.get('mates_after_defence', 0), len(x['actions'])))
                sol['continuations'] = [pack(x, depth + 1) for x in conts[:args.max_continuations_stored]]
                sol['continuations_total'] = len(l['continuations'])
            return sol
        sols = [pack(l) for l in lines_sorted[:keep_n]]
        p = {'id': f"{pos['gid']}-t{pos['turn']}", 'kind': 'mate', 'mate': mate,
             'mover': r['mover'], 'sfn': s, 'variant': variant, 'turn': pos['turn'], 'game': game,
             'played': played, 'mover_human': mover_human,
             'win_fraction': round(frac, 4), 'root_successors': r['root_successors'],
             'solution_keys': keys, 'solutions': sols}
        puzzles.append(p)
        by_pos[pk] = p
        outcomes[f'mate-in-{mate}'] += 1

    drops = dict(d.split('=', 1) if '=' in d else (d, 'dropped') for d in args.drop)
    if drops:
        dropped = [p for p in puzzles if p['id'] in drops]
        for p in dropped:
            outcomes['dropped: ' + drops[p['id']]] += 1
            outcomes['winning turn' if p['kind'] == 'winning' else f"mate-in-{p['mate']}"] -= 1
        puzzles = [p for p in puzzles if p['id'] not in drops]

    # ---- difficulty inputs (cached) and tags
    meta = load_work([args.meta_work]) if args.meta_work else {}
    mtodo = [(p['id'], p['sfn'], set(p['solution_keys']),
              next((x['after'] for x in p['solutions'] if x.get('actions')), None))
             for p in puzzles if p['id'] not in meta]
    if mtodo and not args.meta_work:
        sys.exit('assembly needs --meta-work (a cache file for the difficulty searches)')
    if mtodo:
        print(f'difficulty searches: {len(mtodo)} puzzles', flush=True)
        run_pool(_meta_one, mtodo, args.meta_work, args.workers, 'meta')
        meta = load_work([args.meta_work])
    difficulty_bins(puzzles, meta)
    for p in puzzles:
        p['tags'] = puzzle_tags(p)
        m = meta.get(p['id']) or {}
        p['found_depth'] = m.get('found_depth')

    # Classes in page order (mate-in-1, 2, 3, winning turns); easier first
    # within each.
    puzzles.sort(key=lambda p: (p['mate'] or 9, p['difficulty'], p['id']))
    for i, p in enumerate(puzzles):
        p['index'] = i

    engine = {}
    try:
        with open(os.path.join(REPO, 'docs', 'static', 'scripts', 'engine', 'rust-ai.js'), encoding='utf-8') as fh:
            for line in fh:
                if line.startswith('const RUST_ENGINE_VERSION'):
                    engine['rust_engine_version'] = int(line.split('=')[1].strip(' ;\n'))
                    break
        engine['commit'] = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=REPO,
                                          capture_output=True, text=True).stdout.strip()
    except Exception:  # noqa: BLE001
        pass
    engine['solver'] = ('engine/src/mate.rs: mate-in-1 exhaustive at the root; mate-in-2/3 nominated by the '
                        'engine / recorded line and proven against every reply; budget %d, %d ms per position, max mate %d'
                        % (args.budget, args.time_ms, args.max_mate))
    engine['winning'] = ('tools/winning_turns.py: best turn P >= %.2f (position-winprob.json curves), every other '
                         'candidate >= %.2f below it; root candidates ranked at depth %d, each child searched to '
                         'depth %d and confirmed at depth %d'
                         % (winning_turns.WIN_P, winning_turns.GAP, winning_turns.RANK_DEPTH,
                            winning_turns.CHILD_DEPTH, winning_turns.CONFIRM_DEPTH))
    out = {'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
           'engine': engine, 'count': len(puzzles),
           'positions_examined': len([1 for pos in positions if pos['key'] in done]),
           'outcomes': dict(outcomes), 'winning_outcomes': dict(win_outcomes),
           'unreproduced_wins': unreproduced, 'puzzles': puzzles}
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, separators=(',', ':'))
    print(f'wrote {len(puzzles)} puzzles -> {args.out} ({os.path.getsize(args.out)} bytes)')
    print('outcomes:', dict(outcomes))
    print('winning-turn verdicts:', dict(win_outcomes))
    print(f'{len(unreproduced)} recorded game-winning turns not reproducible as a mate-in-1 '
          f'(see "unreproduced_wins" in the output)')

    if args.report:
        rep = {'outcomes': dict(outcomes), 'winning_outcomes': dict(win_outcomes),
               'counts': dict(Counter(f"{p['kind']}{p['mate'] or ''}" for p in puzzles)),
               'difficulty': dict(Counter(f"{p['kind']}{p['mate'] or ''}:{p['difficulty']}" for p in puzzles)),
               'tags': dict(Counter(t for p in puzzles for t in p['tags']).most_common()),
               'played': dict(Counter(f"{p['kind']}{p['mate'] or ''}:{'human' if p['mover_human'] else 'ai'}:{p['played']}"
                                      for p in puzzles))}
        if old:
            res = Counter()
            rows = []
            key_at = {(sfn_key(pos['sfn']), pos['sfn'].split()[1]): pos['key'] for pos in positions}
            for op in old['puzzles']:
                pk = (sfn_key(op['sfn']), op['sfn'].split()[1])
                np_ = by_pos.get(pk)
                pos_key = key_at.get(pk)
                r = done.get(pos_key) if pos_key else None
                if r is None:
                    st = 'not solved'
                elif not r.get('ok'):
                    st = 'unsolvable now: ' + str(r.get('error'))[:60]
                elif np_ == 'too easy':
                    st = 'mate, now filtered as too easy'
                elif isinstance(np_, dict) and np_['kind'] == 'mate':
                    if np_['mate'] != op['mate']:
                        st = f"mate depth changed {op['mate']}->{np_['mate']}"
                    elif set(np_['solution_keys']) == set(op['solution_keys']):
                        st = 'kept, same solutions'
                    else:
                        st = 'kept, solutions changed'
                else:
                    st = 'refuted (no forced mate found)'
                res[st] += 1
                if not st.startswith('kept'):
                    rows.append({'id': op['id'], 'mate': op['mate'], 'status': st, 'sfn': op['sfn']})
            rep['old_set'] = {'total': len(old['puzzles']), 'status': dict(res), 'changed': rows}
        with open(args.report, 'w', encoding='utf-8') as fh:
            json.dump(rep, fh, indent=1)
        print('report ->', args.report)


if __name__ == '__main__':
    main()
