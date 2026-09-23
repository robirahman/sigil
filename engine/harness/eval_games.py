#!/usr/bin/env python3
"""Per-position engine evaluation of recorded games -> `game_evals/<roomCode>`.

Four stages, each resumable and dry-run by default where it writes to Firebase:

    python engine/harness/eval_games.py download --since 2026-08-26 \
        --service-account "<sa.json>" --out work/raw.json
    python engine/harness/eval_games.py hydrate --raw work/raw.json --out work/lines.json
    python engine/harness/eval_games.py eval --lines work/lines.json --depth 6 \
        --workers 4 --out work/evals.jsonl           [--time-only --sample 50]
    python engine/harness/eval_games.py upload --lines work/lines.json \
        --evals work/evals.jsonl --service-account "<sa.json>" [--apply]

What is evaluated: every position of every game, i.e. the position BEFORE each
recorded turn plus the final position. Position i (i < N) is turn i+1's
`sfnBefore`: the browser records a turn's after-state with the mover still
marked to move, so `sfnAfter` must never be fed to the engine as a position to
search (tools/gen_mate_puzzles.py has the same note). The final position is
recorded as the game's terminal result, not searched.

How: `sigil_engine.analyze(sfn, 'tfit', max_depth=D, time_ms=0, ...)` -- the
SHIPPED search (progressive widening at the engine's default width, the
stone-lead pre-pass, the mate guard) deepened to exactly D plies, untimed, on a
fresh table per position so results do not depend on the walk order. The
widening and adaptive knobs are the engine's exported constants, never
literals restated here. `history_sfns` carries the game so far so threefold
repetition is scored as in live play.

What is stored (red POV, so the review panel needs no flipping):
  evalPerPly[i]   stones with the even-game offset applied (search::report);
                  an even game reads 0.0, blue's +1 token and the mover's tempo
                  are removed. null where the position was skipped.
  matePerPly[i]   forced result in the WINNER's own turns, + red wins, - blue
                  wins, null if none. provenPerPly[i] false = the search was
                  width- or window-limited ("likely").
  bestPerPly[i]   the engine's chosen turn as an applyAITurn action list.
  depthPerPly / nodesPerPly, moverPerPly, terminal {winner}, finalSfn, gameId.

Room codes are the review flows' key but are NOT unique across history (7
duplicates in 2,591 games), so the document carries `finalSfn` and the client
checks it; `upload` refuses to overwrite a document written for another gameId.
"""
import argparse
import json
import os
import statistics
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, REPO)

DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'
EVAL_NAME = 'tfit'
ENGINE_TAG = 'rust-v10'
DEFERRED_PREFIXES = ('pm:', 'ab:', 'sn:')


# ---------------------------------------------------------------- firebase ---

def db_token(service_account):
    import google.auth.transport.requests
    from google.oauth2 import service_account as sa
    creds = sa.Credentials.from_service_account_file(
        service_account,
        scopes=['https://www.googleapis.com/auth/firebase.database',
                'https://www.googleapis.com/auth/userinfo.email'])
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def cmd_download(a):
    import requests
    tok = db_token(a.service_account)
    r = requests.get(DB_URL + '/completed_games.json', params={'access_token': tok}, timeout=900)
    r.raise_for_status()
    data = r.json() or {}
    cut = datetime.fromisoformat(a.since).replace(tzinfo=timezone.utc).timestamp() * 1000 if a.since else 0
    keep = {k: g for k, g in data.items() if isinstance(g, dict) and (g.get('timestamp') or 0) >= cut}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as fh:
        json.dump(keep, fh)
    print(f'downloaded {len(data)} games, kept {len(keep)} since {a.since or "the beginning"} -> {a.out}')


# ----------------------------------------------------------------- hydrate ---

def _deferred(sfn):
    toks = sfn.split()
    return any(t.startswith(DEFERRED_PREFIXES) for t in toks) or 'x' in toks[0]


def position_key(sfn):
    """Position identity without the side-to-move token. Records written after
    2026-08-30 store `finalSfn` with the NEXT mover's token while the replayer's
    after-state keeps the mover's (same convention as puzzle keys), so the
    byte-for-byte check inside hydrateGameLog rejects ~50 perfectly good games;
    the comparison is done here instead, on everything but that token."""
    p = sfn.split()
    return ' '.join(p[:1] + p[2:])


def cmd_hydrate(a):
    from ai.replay_bridge import hydrate_records, _normalize_turns
    raw = json.load(open(a.raw, encoding='utf-8'))
    keep, skipped = [], Counter()
    for k, g in raw.items():
        if not isinstance(g, dict) or not g.get('turns'):
            skipped['no turns'] += 1; continue
        if 'duplicates' in (g.get('variant') or ''):
            skipped['duplicates variant'] += 1; continue
        if not a.analysis and (g.get('autoArena') or g.get('isAiArena')):
            skipped['arena flag'] += 1; continue
        if not a.analysis and not g.get('roomCode'):
            skipped['no roomCode'] += 1; continue
        t = _normalize_turns(g['turns'])
        if not t:
            skipped['bad turns'] += 1; continue
        if not g.get('setupSfn') and not t[0].get('sfnBefore'):
            skipped['no setupSfn'] += 1; continue
        keep.append((k, g, t))
    out = {}
    for s in range(0, len(keep), a.batch):
        chunk = keep[s:s + a.batch]
        # finalSfn deliberately NOT passed: see position_key.
        recs = [{'spellNames': g.get('spellNames') or [], 'variant': g.get('variant') or 'standard',
                 'setupSfn': g.get('setupSfn'), 'finalSfn': None, 'turns': t}
                for _k, g, t in chunk]
        try:
            res = hydrate_records(recs)
        except Exception as e:  # noqa: BLE001
            print(f'  batch {s} failed: {str(e)[:200]}', flush=True)
            skipped['bridge error'] += len(chunk); continue
        for (k, g, t), r in zip(chunk, res):
            if not isinstance(r, dict) or not r.get('ok'):
                skipped['hydrate fail'] += 1; continue
            turns = r['turns']
            positions = [x.get('sfnBefore') for x in turns] + [turns[-1].get('sfnAfter')]
            if any(not p for p in positions):
                skipped['missing sfn'] += 1; continue
            if g.get('finalSfn') and position_key(positions[-1]) != position_key(g['finalSfn']):
                skipped['final position mismatch'] += 1; continue
            if any(_deferred(p) for p in positions):
                skipped['deferred pack'] += 1; continue
            out[k] = {
                'roomCode': g.get('roomCode'), 'redUid': g.get('redUid'), 'blueUid': g.get('blueUid'),
                'winner': g.get('winner'), 'timestamp': g.get('timestamp'),
                'variant': g.get('variant') or 'standard', 'finalSfn': g.get('finalSfn'),
                'setupSfn': g.get('setupSfn'),
                'turnNumbers': [x.get('turnNumber') for x in turns],
                'positions': positions,
            }
        print(f'  hydrated {min(s + a.batch, len(keep))}/{len(keep)}', flush=True)
    n_pos = sum(len(g['positions']) for g in out.values())
    print(f'hydrated {len(out)} games / {n_pos} positions; skipped {dict(skipped)}')
    with open(a.out, 'w', encoding='utf-8') as fh:
        json.dump(out, fh)


# -------------------------------------------------------------------- eval ---

def _analyze_kwargs(se, depth, time_ms):
    # The engine's own exported constants: the shipped search, never restated.
    return dict(max_depth=depth, time_ms=time_ms, tt_bits=20,
                width_scale=se.DEFAULT_WIDTH_SCALE, adaptive=se.SHIPPED_ADAPTIVE)


def _red_pov(mover, v):
    if v is None:
        return None
    return v if mover == 'red' else -v


def eval_game(item):
    """Evaluate every non-final position of one game; returns the rows."""
    gid, game, depth, time_ms = item[:4]
    lo, hi = (item[4], item[5]) if len(item) > 4 else (0, None)
    import sigil_engine as se
    kw = _analyze_kwargs(se, depth, time_ms)
    rows = []
    positions = game['positions']
    for i, sfn in enumerate(positions[:-1]):
        if i < lo or (hi is not None and i >= hi):
            continue
        t0 = time.time()
        try:
            r = se.analyze(sfn, EVAL_NAME, history_sfns=positions[:i], **kw)
        except Exception as e:  # noqa: BLE001
            rows.append({'g': gid, 'i': i, 'error': f'{type(e).__name__}: {e}'})
            continue
        mover = r['mover']
        row = {'g': gid, 'i': i, 'mover': mover, 'over': bool(r['over']),
               'stones': _red_pov(mover, r['stones']),
               'mate': _red_pov(mover, r['mate_in_turns']),
               'proven': bool(r['proven']), 'score': r['score'],
               'depth': r['depth'], 'nodes': r['nodes'], 'seconds': round(time.time() - t0, 3),
               'best': json.loads(r['actions_json']) if r.get('actions_json') else None}
        rows.append(row)
    return gid, rows


def _done_keys(path):
    done = set()
    if os.path.exists(path):
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if 'error' not in d:
                    done.add((d['g'], d['i']))
    return done


def _engine_supports(se, game):
    """False for draws with spells the engine does not model (Tectonic,
    Providence, Aftershock, Ambush, Panda, Experimental): Board.from_sfn refuses
    them with 'unknown or out-of-scope spell'."""
    try:
        se.Board.from_sfn(game['positions'][0])
        return True
    except ValueError:
        return False


def cmd_eval(a):
    import sigil_engine as se
    lines = json.load(open(a.lines, encoding='utf-8'))
    items = sorted(lines.items(), key=lambda kv: kv[1].get('timestamp') or 0)
    unsupported = [k for k, g in items if not _engine_supports(se, g)]
    items = [(k, g) for k, g in items if k not in set(unsupported)]
    print(f'{len(unsupported)} games use spells the engine does not model; skipped', flush=True)
    if a.exclude:
        done_elsewhere = set()
        for path in a.exclude:
            done_elsewhere |= set(json.load(open(path, encoding='utf-8')).keys())
        items = [(k, g) for k, g in items if k not in done_elsewhere]
        print(f'{len(done_elsewhere)} games excluded (covered by another corpus); {len(items)} remain', flush=True)
    if a.shard:
        k, n = (int(x) for x in a.shard.split('/'))
        items = [it for i, it in enumerate(items) if i % n == k]
        print(f'shard {k}/{n}: {len(items)} games', flush=True)
    if a.limit_games:
        items = items[:a.limit_games]
    if a.time_only:
        kw = _analyze_kwargs(se, a.depth, a.time_ms)
        sample = [(g['positions'][i], g['positions'][:i]) for _k, g in items for i in range(len(g['positions']) - 1)]
        step = max(1, len(sample) // a.sample)
        sample = sample[::step][:a.sample]
        secs = []
        for sfn, hist in sample:
            t0 = time.time(); r = se.analyze(sfn, EVAL_NAME, history_sfns=hist, **kw); secs.append(time.time() - t0)
            print(f'  {secs[-1]:6.2f}s depth {r["depth"]} nodes {r["nodes"]:>9,} stones {r["stones"]} mate {r["mate_in_turns"]}', flush=True)
        total = sum(len(g['positions']) - 1 for _k, g in items)
        print(f'depth {a.depth}: n={len(secs)} mean {statistics.mean(secs):.2f}s median {statistics.median(secs):.2f}s '
              f'max {max(secs):.2f}s; {total} positions -> ~{total * statistics.mean(secs) / 3600:.1f} CPU-hours')
        return
    done = _done_keys(a.out)
    todo = []
    for gid, g in items:
        n = len(g['positions']) - 1
        if all((gid, i) in done for i in range(n)):
            continue
        if a.split > 0:
            # Position-level work items: a 117-position game no longer pins one
            # worker for two hours while the other 87 sit idle.
            for lo in range(0, n, a.split):
                if not all((gid, i) in done for i in range(lo, min(n, lo + a.split))):
                    todo.append((gid, g, a.depth, a.time_ms, lo, min(n, lo + a.split)))
        else:
            todo.append((gid, g, a.depth, a.time_ms))
    print(f'{len(items)} games, {len(done)} positions already done, {len(todo)} games to evaluate', flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or '.', exist_ok=True)
    t_start = time.time(); n_rows = 0
    with open(a.out, 'a', encoding='utf-8') as fh, ProcessPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(eval_game, it): it[0] for it in todo}
        for k, fut in enumerate(as_completed(futs), 1):
            gid, rows = fut.result()
            for row in rows:
                if (row['g'], row['i']) in done:
                    continue
                fh.write(json.dumps(row, separators=(',', ':')) + '\n'); n_rows += 1
            fh.flush()
            if k % 10 == 0 or k == len(futs):
                print(f'  {k}/{len(futs)} games, {n_rows} positions, {time.time() - t_start:.0f}s', flush=True)


# ------------------------------------------------------------------ upload ---

def load_rows(evals_paths):
    """Pool one or more evals.jsonl files (shards / resumed runs) -> {(gid, i): row}."""
    rows, errors = {}, Counter()
    for path in ([evals_paths] if isinstance(evals_paths, str) else evals_paths):
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                d = json.loads(line)
                if 'error' in d:
                    errors[d['g']] += 1; continue
                rows[(d['g'], d['i'])] = d
    return rows, errors


def build_docs(lines, evals_paths):
    rows, errors = load_rows(evals_paths)
    docs, incomplete = {}, []
    for gid, g in lines.items():
        if not g.get('roomCode'):
            continue                      # analysis-only corpus entry; nothing to key the document by
        n = len(g['positions']) - 1
        got = [rows.get((gid, i)) for i in range(n)]
        if any(r is None for r in got):
            incomplete.append((gid, sum(r is None for r in got), n)); continue
        movers = [r['mover'] for r in got]
        last_tok = g['positions'][-1].split()[1]
        # The final position's side-to-move token is the mover's (browser convention);
        # the side to move in the position proper is the other one.
        movers.append('blue' if last_tok == 'r' else 'red')
        winner = g.get('winner') if g.get('winner') in ('red', 'blue') else None
        docs[gid] = {
            'gameId': gid, 'roomCode': g['roomCode'], 'finalSfn': g['finalSfn'],
            'engine': ENGINE_TAG, 'eval': EVAL_NAME, 'depth': max(r['depth'] for r in got),
            'computedAt': int(time.time() * 1000), 'plies': n,
            'moverPerPly': movers,
            'evalPerPly': [r['stones'] for r in got] + [None],
            'matePerPly': [r['mate'] for r in got] + [None],
            'provenPerPly': [r['proven'] for r in got] + [True],
            'bestPerPly': [r['best'] for r in got] + [None],
            'depthPerPly': [r['depth'] for r in got] + [0],
            'nodesPerPly': [r['nodes'] for r in got] + [0],
            'terminal': {'winner': winner},
        }
    return docs, incomplete, errors


def cmd_upload(a):
    import requests
    lines = json.load(open(a.lines, encoding='utf-8'))
    docs, incomplete, errors = build_docs(lines, a.evals)
    print(f'{len(docs)} complete documents; {len(incomplete)} incomplete games; {sum(errors.values())} errored positions')
    for gid, missing, n in incomplete[:10]:
        print(f'  incomplete {gid}: {missing}/{n} positions missing')
    tok = {'access_token': db_token(a.service_account)}
    by_room = Counter(d['roomCode'] for d in docs.values())
    dupes = {rc for rc, c in by_room.items() if c > 1}
    if dupes:
        print(f'  WARNING duplicate room codes among documents: {sorted(dupes)} -- the newer game wins')
    written = skipped = 0
    for gid, d in sorted(docs.items(), key=lambda kv: lines[kv[0]].get('timestamp') or 0):
        rc = d['roomCode']
        cur = requests.get(f'{DB_URL}/game_evals/{rc}.json', params=dict(tok, shallow='true'), timeout=60).json()
        if cur is not None and not a.overwrite:
            cur_gid = requests.get(f'{DB_URL}/game_evals/{rc}/gameId.json', params=tok, timeout=60).json()
            if cur_gid != gid and rc not in dupes:
                print(f'  {rc}: exists for another game {cur_gid}; skipping (pass --overwrite to replace)')
                skipped += 1; continue
            if cur_gid == gid and not a.overwrite:
                skipped += 1; continue
        mates = sum(1 for m in d['matePerPly'] if m)
        print(f"  {'PUT' if a.apply else 'would PUT'} game_evals/{rc}  {gid}  {d['plies']} plies, {mates} forced-result positions")
        if a.apply:
            r = requests.put(f'{DB_URL}/game_evals/{rc}.json', params=tok, data=json.dumps(d), timeout=120)
            r.raise_for_status(); written += 1
    print(f"{'wrote' if a.apply else 'would write'} {written if a.apply else len(docs) - skipped}, skipped {skipped}"
          + ('' if a.apply else '; dry run, pass --apply to write'))


# -------------------------------------------------------------------- main ---

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    d = sub.add_parser('download'); d.add_argument('--since', default='2026-08-26'); d.add_argument('--service-account', required=True); d.add_argument('--out', required=True)
    h = sub.add_parser('hydrate'); h.add_argument('--raw', required=True); h.add_argument('--out', required=True); h.add_argument('--batch', type=int, default=150)
    h.add_argument('--analysis', action='store_true', help='keep AI-arena games and games without a roomCode (for offline analysis; upload skips them)')
    e = sub.add_parser('eval'); e.add_argument('--lines', required=True); e.add_argument('--out', required=True)
    e.add_argument('--depth', type=int, default=6); e.add_argument('--time-ms', type=int, default=0, help='0 = untimed fixed depth')
    e.add_argument('--workers', type=int, default=os.cpu_count() or 2); e.add_argument('--limit-games', type=int, default=0)
    e.add_argument('--split', type=int, default=0, help='work items of this many positions instead of whole games (0 = whole games)')
    e.add_argument('--time-only', action='store_true'); e.add_argument('--sample', type=int, default=50)
    e.add_argument('--shard', default='', help='k/n: evaluate every n-th game starting at k (games sorted by timestamp)')
    e.add_argument('--exclude', action='append', default=[], help='lines.json of a corpus already evaluated; its games are skipped')
    u = sub.add_parser('upload'); u.add_argument('--lines', required=True); u.add_argument('--evals', required=True, action='append')
    u.add_argument('--service-account', required=True); u.add_argument('--apply', action='store_true'); u.add_argument('--overwrite', action='store_true')
    a = p.parse_args()
    {'download': cmd_download, 'hydrate': cmd_hydrate, 'eval': cmd_eval, 'upload': cmd_upload}[a.cmd](a)


if __name__ == '__main__':
    main()
