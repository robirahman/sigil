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
        recs = [{'spellNames': g.get('spellNames') or [],
                 'variant': g.get('variant') or 'standard',
                 'setupSfn': g.get('setupSfn'), 'finalSfn': g.get('finalSfn'),
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
    return ' '.join([p[0].split('/')[0], p[3], p[4], p[5]])   # spells dropped: constant per puzzle


def _solve_one(item):
    key, sfn, budget, time_ms, hints = item
    import sigil_engine
    r = json.loads(sigil_engine.solve_mates(sfn, budget, time_ms, hints))
    return key, r


def who(uid):
    """Public-safe player label. Real accounts are 'Human'; AI accounts are
    named by tier (`__ai_rust_hard__` -> 'AI (rust hard)')."""
    if not uid:
        return 'Unknown'
    if uid.startswith('__ai_'):
        return 'AI (' + uid.strip('_')[3:].replace('_', ' ') + ')'
    return 'Human'


def iter_positions(hyd, min_turn):
    """Yield (gameId, turn, sfnBefore, hints). `hints` are after-positions
    the solver should nominate as mate-in-2 candidates besides the engine's
    own: the turn the mover actually played, when the mover went on to win
    within their next two turns (so the recorded line may well be the mate)."""
    for gid, g in hyd.items():
        if 'duplicates' in (g.get('variant') or ''):
            continue                      # draw variant the engine does not model
        turns = g['turns']
        last = turns[-1]['turnNumber'] if turns else 0
        for t in turns:
            s = t.get('sfnBefore')
            if not s:
                continue
            toks = s.split()
            if any(x.startswith(('pm:', 'ab:', 'sn:')) for x in toks) or 'x' in toks[0]:
                continue                  # deferred-pack state
            if int(toks[2]) < min_turn:
                continue
            hints = []
            if (g.get('winner') == t.get('color') and t.get('sfnAfter')
                    and last - t['turnNumber'] <= 3):
                hints.append(t['sfnAfter'])
            yield gid, t, s, hints


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--download', action='store_true', help='fetch completed_games first')
    ap.add_argument('--service-account', default=os.environ.get('SIGIL_FIREBASE_SA'))
    ap.add_argument('--raw', default=None, help='raw completed_games dump (json)')
    ap.add_argument('--hydrated', required=True, help='hydrated per-turn dump (read, or written by --raw/--download)')
    ap.add_argument('--work', required=True, help='jsonl of per-position solver results (resumable)')
    ap.add_argument('--out', default=os.path.join(REPO, 'docs', 'static', 'puzzles', 'mate_puzzles.json'))
    ap.add_argument('--budget', type=int, default=400_000_000, help='apply_turn calls (+ generated turns) per position')
    ap.add_argument('--time-ms', type=int, default=20_000, help='wall-clock cap per position (0 = none)')
    ap.add_argument('--min-turn', type=int, default=6)
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--limit', type=int, default=0, help='solve at most this many new positions')
    ap.add_argument('--no-solve', action='store_true', help='assemble from --work only (a partial set while a run is in progress)')
    ap.add_argument('--max-win-fraction', type=float, default=0.34,
                    help='drop mate-in-1 puzzles where more than this share of first turns win')
    ap.add_argument('--max-solutions-stored', type=int, default=12)
    ap.add_argument('--max-winning', type=int, default=40,
                    help='drop mate-in-1 puzzles with more distinct winning positions than this (not a puzzle)')
    args = ap.parse_args()

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

    # ---- solve (resumable)
    done = {}
    if os.path.exists(args.work):
        with open(args.work, encoding='utf-8') as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                    done[rec['key']] = rec['result']
                except (ValueError, KeyError):
                    continue
    todo, seen_pos = [], set()
    last_turn = {gid: (g['turns'][-1]['turnNumber'] if g['turns'] else 0) for gid, g in hyd.items()}
    order = []
    for gid, t, s, hints in iter_positions(hyd, args.min_turn):
        key = f"{gid}:t{t['turnNumber']}"
        pk = (sfn_key(s), s.split()[1])
        if key in done or pk in seen_pos:
            continue
        seen_pos.add(pk)
        # Mates live at the ends of games: solve positions in order of distance
        # from the final turn so a partial run already holds most of the set.
        order.append((last_turn.get(gid, 0) - t['turnNumber'], key, s, hints))
    order.sort(key=lambda x: x[0])
    todo = [(key, s, args.budget, args.time_ms, hints) for _d, key, s, hints in order]
    if args.limit:
        todo = todo[:args.limit]
    if args.no_solve:
        todo = []
    print(f'{len(done)} positions already solved, {len(todo)} to solve with {args.workers} workers',
          flush=True)
    t0 = time.time()
    n = 0
    # Results are streamed to --work and NOT kept in memory (an early version
    # held them all and the main process reached 7.5 GB); the assembly below
    # re-reads the file. Tasks are submitted in chunks so the executor's queue
    # stays small too.
    done = None
    chunk = max(8, 16 * args.workers)
    with open(args.work, 'a', encoding='utf-8') as wf, \
            ProcessPoolExecutor(max_workers=args.workers) as ex:
        for start in range(0, len(todo), chunk):
            futs = [ex.submit(_solve_one, it) for it in todo[start:start + chunk]]
            for f in as_completed(futs):
                key, r = f.result()
                wf.write(json.dumps({'key': key, 'result': r}) + '\n')
                n += 1
                if n % 50 == 0:
                    wf.flush()
                    el = time.time() - t0
                    print(f'  {n}/{len(todo)} solved, {el:.0f}s, {el / n:.2f}s/pos', flush=True)
            wf.flush()
    done = {}
    with open(args.work, encoding='utf-8') as fh:
        for line in fh:
            try:
                rec = json.loads(line)
                done[rec['key']] = rec['result']
            except (ValueError, KeyError):
                continue

    # ---- assemble puzzles
    outcomes = Counter()
    puzzles = []
    seen_pos = set()
    # Recorded game-winning turns the solver could NOT reproduce as a mate-in-1:
    # either a rules disagreement between the Rust engine and the browser, or a
    # corrupt transcript (the 2026-09 enumeration audit found 237 fat records and
    # 134 no-op sacrifices that make an after-state illegal). Listed for review.
    unreproduced = []
    for gid, t, s, _hints in iter_positions(hyd, args.min_turn):
        key = f"{gid}:t{t['turnNumber']}"
        r = done.get(key)
        if not r:
            continue
        if not r.get('ok'):
            outcomes[r.get('error', 'error')] += 1
            continue
        lines = r['mate1'] or r['mate2']
        g = hyd[gid]
        if not lines:
            outcomes['no mate'] += 1
            after = (t.get('sfnAfter') or '').split()
            if (len(after) > 6 and after[6] in ('r3', 'b3') and g.get('winner') == t.get('color')
                    and g['turns'] and g['turns'][-1]['turnNumber'] == t['turnNumber']):
                unreproduced.append({'game': gid, 'turn': t['turnNumber'], 'mover': t.get('color'),
                                     'fat_record': bool(t.get('fat')), 'sfnBefore': s,
                                     'sfnAfter': t.get('sfnAfter'), 'root_successors': r['root_successors']})
            continue
        mate = 1 if r['mate1'] else 2
        pk = (sfn_key(s), s.split()[1])
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
            continue
        if mate == 1 and (frac > args.max_win_fraction or total > len(lines) or total > args.max_winning):
            # Too many winning turns to be a puzzle (or more than the solver
            # emits, so the page could not judge every winning move).
            outcomes['mate-in-1 too easy'] += 1
            continue
        keys = [sfn_key(l['after']) for l in lines]
        played = sfn_key(t['sfnAfter']) in set(keys) if t.get('sfnAfter') else None
        # Store full lines for the hardest defences first (fewest mates after
        # the defence), so the page's "show solution" picks a real puzzle line.
        lines_sorted = sorted(lines, key=lambda l: (l.get('mates_after_defence', 0), len(l['actions'])))
        sols = []
        keep_n = len(lines_sorted) if mate == 2 else args.max_solutions_stored
        for l in lines_sorted[:keep_n]:
            sol = {'actions': l['actions'], 'after': l['after'], 'key': sfn_key(l['after'])}
            if 'defence' in l:
                sol['defence'] = l['defence']
                sol['finish'] = l.get('finish')
                sol['mates_after_defence'] = l.get('mates_after_defence')
                sol['replies'] = l.get('replies')
            sols.append(sol)
        ts = g.get('timestamp')
        date = None
        if isinstance(ts, (int, float)) and ts > 0:
            date = datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc).strftime('%Y-%m-%d')
        puzzles.append({
            'id': f"{gid}-t{t['turnNumber']}",
            'mate': mate,
            'mover': r['mover'],
            'sfn': s,
            'variant': g.get('variant') or 'standard',
            'turn': t['turnNumber'],
            'game': {'id': gid, 'red': who(g.get('redUid')), 'blue': who(g.get('blueUid')),
                     'winner': g.get('winner'), 'date': date},
            'played': played,
            'win_fraction': round(frac, 4),
            'root_successors': r['root_successors'],
            'solution_keys': keys,
            'solutions': sols,
        })
        outcomes[f'mate-in-{mate}'] += 1

    # Harder first within each class: fewer winning first turns, then a
    # mate-in-2 whose chosen defence leaves the fewest mating replies.
    puzzles.sort(key=lambda p: (p['mate'], p['win_fraction'],
                                min([s.get('mates_after_defence', 0) or 0 for s in p['solutions']] or [0])))
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
    engine['solver'] = ('engine/src/mate.rs: mate-in-1 exhaustive at the root; mate-in-2 nominated by the '
                        'engine / recorded line and proven against every reply; budget %d, %d ms per position'
                        % (args.budget, args.time_ms))
    out = {'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
           'engine': engine, 'count': len(puzzles),
           'positions_examined': sum(outcomes.values()),
           'outcomes': dict(outcomes), 'unreproduced_wins': unreproduced, 'puzzles': puzzles}
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, separators=(',', ':'))
    print(f'wrote {len(puzzles)} puzzles -> {args.out} ({os.path.getsize(args.out)} bytes)')
    print('outcomes:', dict(outcomes))
    print(f'{len(unreproduced)} recorded game-winning turns not reproducible as a mate-in-1 '
          f'(see "unreproduced_wins" in the output)')


if __name__ == '__main__':
    main()
