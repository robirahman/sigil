#!/usr/bin/env python3
"""Find completed_games turns where Fireblast was cast and its sacrifice never paid.

    python tools/scan_fireblast_sacrifice.py --raw completed_games.json --out scan.json [--workers 4]
    python tools/scan_fireblast_sacrifice.py --out scan.json --delete --service-account sa.json

Every game is hydrated through the browser replayer (ai.replay_bridge); for each
turn whose mover cast Fireblast (lock token flips to Fireblast, or the transcript
has a fireblast action) the Rust enumerator answers, in ONE pass, whether the
recorded after-state is reachable by a legal turn and, if not, whether removing
exactly ONE of the caster's stones makes it reachable with the enemy stones
matching -- the fingerprint of an unpaid sacrifice
(`Board.layout_reachable_minus_one`). Games with such a turn are listed with
whether it was the final turn (a wrongly adjudicated win when the paid position
is not a win) or a mid-game turn (the game continued from an illegal position).
`--delete` removes those records and their user_games index entries.

Both engines skip the sacrifice when the destruction eliminates the opponent, so
those turns are reachable and never flagged.
"""
import argparse, json, os, sys, time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
DB = 'https://sigil-js-default-rtdb.firebaseio.com'
NODES = None


def stones(sfn):
    return sfn.split()[0].split('/')[0]


def fireblast_turns(hyd):
    """(game, turn, mover, final, kind, sfnBefore, sfnAfter, winner) for every Fireblast cast."""
    out = []
    for k, (g, rawturns, turns) in hyd.items():
        if not turns:
            continue
        last = turns[-1]['turnNumber']
        rawby = {x.get('turnNumber'): x for x in rawturns}
        for x in turns:
            sb, sa = x.get('sfnBefore'), x.get('sfnAfter')
            if not sb or not sa:
                continue
            mover = x['color']
            i = 0 if mover == 'red' else 1
            lock_b = sb.split()[4].split(':')[i]
            lock_a = sa.split()[4].split(':')[i]
            acts = rawby.get(x['turnNumber'], {}).get('actions') or []
            types = [a.get('type') if isinstance(a, dict) else a for a in acts]
            if not ((lock_a == 'Fireblast' and lock_b != 'Fireblast') or 'fireblast' in types or 'Fireblast' in types):
                continue
            out.append({'game': k, 'turn': x['turnNumber'], 'mover': mover, 'final': x['turnNumber'] == last,
                        'kind': rawby.get(x['turnNumber'], {}).get('kind'), 'sfnBefore': sb, 'sfnAfter': sa,
                        'winner': g.get('winner'), 'ranked': g.get('ranked'), 'ts': g.get('timestamp'),
                        'redUid': g.get('redUid'), 'blueUid': g.get('blueUid')})
    return out


def check(item):
    import sigil_engine as se
    sb, sa, mover = item['sfnBefore'], item['sfnAfter'], item['mover']
    if any(tok in sb for tok in ('pm:', 'ab:', 'sn:')) or 'x' in stones(sb):
        return dict(item, status='unverifiable', why='deferred-pack state')
    try:
        b = se.Board.from_sfn(sb)
        tgt = se.Board.from_sfn(sa).stones
    except Exception as e:  # noqa: BLE001
        return dict(item, status='unverifiable', why=str(e)[:80])
    reach, fixes, n, trunc = b.layout_reachable_minus_one(mover, tgt[0], tgt[1], 1 << 20)
    if reach:
        return dict(item, status='ok', n_turns=n)
    if trunc:
        return dict(item, status='unverifiable', why='enumeration truncated', n_turns=n)
    me, them = ('r', 'b') if mover == 'red' else ('b', 'r')
    my_after, their_after = stones(sa).count(me), stones(sa).count(them)
    red_s = (my_after - 1) if mover == 'red' else their_after
    blue_s = (their_after if mover == 'red' else my_after - 1) + 1
    lead = (red_s - blue_s) if mover == 'red' else (blue_s - red_s)
    return dict(item, status=('unpaid_sacrifice' if fixes else 'unreachable_other'),
                fixes=[se.NODE_NAMES[f] for f in fixes], n_turns=n,
                still_win_after_paying=(their_after == 0 or lead >= 3), lead_after_paying=lead)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--raw', help='completed_games dump (json); omit with --delete to reuse --out')
    ap.add_argument('--out', required=True)
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--delete', action='store_true', help='delete the flagged games (needs --service-account)')
    ap.add_argument('--service-account', default=None)
    a = ap.parse_args()

    if a.raw:
        from ai.replay_bridge import hydrate_records, _normalize_turns
        raw = json.load(open(a.raw, encoding='utf-8'))
        keep = []
        for k, g in raw.items():
            if not isinstance(g, dict) or not g.get('turns'):
                continue
            t = _normalize_turns(g['turns'])
            if not t or (not g.get('setupSfn') and not t[0].get('sfnBefore')):
                continue
            keep.append((k, g, t))
        hyd = {}
        for s0 in range(0, len(keep), 200):
            chunk = keep[s0:s0 + 200]
            res = hydrate_records([{'spellNames': g.get('spellNames') or [], 'variant': g.get('variant') or 'standard',
                                    'setupSfn': g.get('setupSfn'), 'finalSfn': g.get('finalSfn'), 'turns': t}
                                   for k, g, t in chunk])
            for (k, g, t), r in zip(chunk, res):
                if r.get('ok'):
                    hyd[k] = (g, t, r['turns'])
        print(f'{len(hyd)} games hydrated of {len(keep)}', flush=True)
        items = fireblast_turns(hyd)
        print(f'{len(items)} Fireblast turns to check with {a.workers} workers', flush=True)
        results = []
        t0 = time.time()
        with ProcessPoolExecutor(max_workers=a.workers) as ex:
            futs = [ex.submit(check, it) for it in items]
            for i, f in enumerate(as_completed(futs), 1):
                results.append(f.result())
                if i % 50 == 0:
                    print(f'  {i}/{len(items)} {time.time() - t0:.0f}s', flush=True)
                    json.dump(results, open(a.out, 'w'), indent=1)
        json.dump(results, open(a.out, 'w'), indent=1)
    else:
        results = json.load(open(a.out))

    print('status:', dict(Counter(r['status'] for r in results)))
    flagged = [r for r in results if r['status'] == 'unpaid_sacrifice']
    games = {}
    for r in flagged:
        games.setdefault(r['game'], []).append(r)
    print(f'{len(flagged)} unpaid-sacrifice turns in {len(games)} games')
    print('  final-turn (wrong adjudication):', sum(1 for r in flagged if r['final']),
          ' of which still a win once paid:', sum(1 for r in flagged if r['final'] and r['still_win_after_paying']))
    print('  mid-game (game continued from an illegal position):', sum(1 for r in flagged if not r['final']))
    print('  by transcript kind:', dict(Counter(r['kind'] for r in flagged)))
    other = [r for r in results if r['status'] == 'unreachable_other']
    print(f'{len(other)} Fireblast turns unreachable for another reason (left alone)')
    for gid, rs in sorted(games.items(), key=lambda kv: kv[1][0]['ts'] or 0):
        r = rs[0]
        print(f"  {gid} {time.strftime('%Y-%m-%d', time.gmtime((r['ts'] or 0) / 1000))} winner={r['winner']} turns={[x['turn'] for x in rs]} "
              f"{'FINAL' if any(x['final'] for x in rs) else 'mid-game'} fixes={r['fixes'][:3]}")

    if a.delete:
        if not a.service_account:
            sys.exit('--delete needs --service-account')
        import requests, google.auth.transport.requests
        from google.oauth2 import service_account
        creds = service_account.Credentials.from_service_account_file(
            a.service_account, scopes=['https://www.googleapis.com/auth/firebase.database',
                                       'https://www.googleapis.com/auth/userinfo.email'])
        creds.refresh(google.auth.transport.requests.Request())
        tok = {'access_token': creds.token}
        n = 0
        for gid, rs in games.items():
            if requests.get(f'{DB}/completed_games/{gid}.json', params=dict(tok, shallow='true'), timeout=60).json() is None:
                print(f'  {gid}: already absent'); continue
            requests.delete(f'{DB}/completed_games/{gid}.json', params=tok, timeout=60).raise_for_status()
            for uid in (rs[0].get('redUid'), rs[0].get('blueUid')):
                if uid and requests.get(f'{DB}/user_games/{uid}/{gid}.json', params=dict(tok, shallow='true'), timeout=60).json() is not None:
                    requests.delete(f'{DB}/user_games/{uid}/{gid}.json', params=tok, timeout=60).raise_for_status()
            n += 1
        print(f'deleted {n} games')


if __name__ == '__main__':
    main()
