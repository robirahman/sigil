"""Human-vs-AI record from a `completed_games` dump, per AI tier and per human.

WHY. Every strength number in this project so far is engine-vs-engine. The site's
Elo cannot stand in for a human measurement: it is K=32, written by the winner's
browser, anchored to nothing (everyone starts at 1000 and the only inter-pool
links are human-vs-AI games), and it rated `very_hard` below `hard`. This script
reads the raw game outcomes instead and reports, per AI uid and per human, the
AI's win rate with a Wilson interval and the Elo gap that win rate implies
(`sprt.p_to_elo`). It is the §0.1 baseline of the superhuman campaign and the
number every later claim is compared against.

Filters, all reported: unranked games are excluded by default (`--include-unranked`
keeps them), arena/auto-arena records (`autoArena`, `isAiArena`) and AI-vs-AI games
are always excluded, and games missing a uid are counted separately.

    python3 engine/harness/human_vs_rust_report.py \
        ai/data/completed_games_backup_2026-09-09.json \
        --users ai/data/users_cache_2026-09-09.json --json ai/data/human_vs_ai_2026-09-09.json
"""
import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from sprt import p_to_elo  # noqa: E402


def wilson(w, n, z=1.96):
    if n == 0:
        return (0.0, 0.0, 1.0)
    p = w / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (p, max(0.0, centre - half), min(1.0, centre + half))


def elo_str(p):
    e = p_to_elo(p)
    if math.isinf(e):
        return '  inf' if e > 0 else ' -inf'
    return f'{e:+5.0f}'


def who(uid):
    if not uid:
        return 'unknown'
    return 'ai' if uid.startswith('__ai') or uid.startswith('ai-') else 'human'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('dump')
    ap.add_argument('--users', help='users table dump (uid -> {name|displayName, elo})')
    ap.add_argument('--include-unranked', action='store_true')
    ap.add_argument('--since', help='ISO date; keep games at/after it')
    ap.add_argument('--min-human-elo', type=float, default=0.0,
                    help='only count humans at/above this rating in the pooled row')
    ap.add_argument('--json', help='write the per-(ai, human) table here')
    args = ap.parse_args()

    games = json.load(open(args.dump, encoding='utf-8'))
    users = json.load(open(args.users, encoding='utf-8')) if args.users else {}

    def name(uid):
        u = users.get(uid) or {}
        return u.get('name') or u.get('displayName') or uid[:10]

    def elo(uid):
        u = users.get(uid) or {}
        return u.get('elo')

    since_ms = None
    if args.since:
        since_ms = datetime.fromisoformat(args.since).replace(
            tzinfo=timezone.utc).timestamp() * 1000

    skipped = Counter()
    # (ai_uid, human_uid) -> [ai_wins, games, ai_red_games, ai_red_wins]
    table = defaultdict(lambda: [0, 0, 0, 0])
    first_ts = {}
    last_ts = {}
    for key, g in games.items():
        if not isinstance(g, dict):
            skipped['malformed'] += 1
            continue
        if g.get('autoArena') or g.get('isAiArena'):
            skipped['arena record'] += 1
            continue
        r, b = g.get('redUid'), g.get('blueUid')
        kinds = (who(r), who(b))
        if 'unknown' in kinds:
            skipped['missing uid'] += 1
            continue
        if kinds == ('ai', 'ai'):
            skipped['ai vs ai'] += 1
            continue
        if kinds == ('human', 'human'):
            skipped['human vs human'] += 1
            continue
        if not g.get('ranked') and not args.include_unranked:
            skipped['unranked'] += 1
            continue
        ts = g.get('timestamp') or 0
        if since_ms and ts < since_ms:
            skipped['before --since'] += 1
            continue
        w = g.get('winner')
        if w not in ('red', 'blue'):
            skipped['no winner'] += 1
            continue
        ai, hum = (r, b) if kinds[0] == 'ai' else (b, r)
        ai_is_red = kinds[0] == 'ai'
        ai_won = (w == 'red') == ai_is_red
        row = table[(ai, hum)]
        row[1] += 1
        row[0] += int(ai_won)
        if ai_is_red:
            row[2] += 1
            row[3] += int(ai_won)
        first_ts[ai] = min(first_ts.get(ai, ts), ts)
        last_ts[ai] = max(last_ts.get(ai, ts), ts)

    def day(ms):
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d')

    print(f'dump: {args.dump}  games in dump: {len(games)}')
    print('excluded: ' + ', '.join(f'{k} {v}' for k, v in sorted(skipped.items())))
    print()

    # --- per AI tier, pooled over humans ---
    per_ai = defaultdict(lambda: [0, 0, 0, 0])
    per_ai_strong = defaultdict(lambda: [0, 0])
    opp_elo = defaultdict(list)
    for (ai, hum), (aw, n, rn, rw) in table.items():
        per_ai[ai][0] += aw; per_ai[ai][1] += n
        per_ai[ai][2] += rn; per_ai[ai][3] += rw
        e = elo(hum)
        if e is not None:
            opp_elo[ai] += [e] * n
        if e is not None and e >= args.min_human_elo:
            per_ai_strong[ai][0] += aw; per_ai_strong[ai][1] += n

    print('AI tier vs humans (ranked, human-vs-AI only)')
    hdr = (f'{"ai uid":26} {"games":>5} {"ai wins":>7} {"ai%":>6} {"wilson95":>15} '
           f'{"elo gap":>7} {"as red":>9} {"as blue":>9} {"opp elo":>7}  first..last')
    print(hdr)
    for ai, (aw, n, rn, rw) in sorted(per_ai.items(), key=lambda kv: -kv[1][1]):
        p, lo, hi = wilson(aw, n)
        bn, bw = n - rn, aw - rw
        red = f'{rw}/{rn}' if rn else '-'
        blue = f'{bw}/{bn}' if bn else '-'
        oe = sum(opp_elo[ai]) / len(opp_elo[ai]) if opp_elo[ai] else float('nan')
        print(f'{ai:26} {n:5d} {aw:7d} {100*p:5.1f}% [{100*lo:5.1f},{100*hi:5.1f}] '
              f'{elo_str(p):>7} {red:>9} {blue:>9} {oe:7.0f}  {day(first_ts[ai])}..{day(last_ts[ai])}')
    if args.min_human_elo:
        print(f'\n  same, humans rated >= {args.min_human_elo:.0f} only')
        for ai, (aw, n) in sorted(per_ai_strong.items(), key=lambda kv: -kv[1][1]):
            if n == 0:
                continue
            p, lo, hi = wilson(aw, n)
            print(f'  {ai:24} {n:5d} {aw:7d} {100*p:5.1f}% [{100*lo:5.1f},{100*hi:5.1f}] {elo_str(p):>7}')

    # --- per human vs the Rust tiers, and vs all AI ---
    print('\nHumans (rows with >= 3 games): vs Rust tiers | vs all AI tiers')
    per_hum = defaultdict(lambda: [0, 0, 0, 0])   # rust_ai_wins, rust_n, all_ai_wins, all_n
    for (ai, hum), (aw, n, _, _) in table.items():
        per_hum[hum][2] += aw; per_hum[hum][3] += n
        if ai.startswith('__ai_rust'):
            per_hum[hum][0] += aw; per_hum[hum][1] += n
    print(f'{"human":16} {"elo":>5} | {"n":>4} {"human%":>7} {"wilson95":>15} | {"n":>4} {"human%":>7}')
    for hum, (rw, rn, aw, an) in sorted(per_hum.items(), key=lambda kv: -(elo(kv[0]) or 0)):
        if an < 3:
            continue
        e = elo(hum)
        es = f'{e:5.0f}' if e is not None else '    ?'
        if rn:
            hp, lo, hi = wilson(rn - rw, rn)
            rust = f'{rn:4d} {100*hp:6.1f}% [{100*lo:5.1f},{100*hi:5.1f}]'
        else:
            rust = f'{"-":>4} {"":>7} {"":>15}'
        ap_ = (an - aw) / an
        print(f'{name(hum)[:16]:16} {es} | {rust} | {an:4d} {100*ap_:6.1f}%')

    # --- per (rust tier, human) detail ---
    print('\nRust tiers, per human')
    for (ai, hum), (aw, n, rn, rw) in sorted(table.items(), key=lambda kv: (kv[0][0], -kv[1][1])):
        if not ai.startswith('__ai_rust'):
            continue
        p, lo, hi = wilson(aw, n)
        e = elo(hum)
        es = f'{e:.0f}' if e is not None else '?'
        print(f'  {ai:24} {name(hum)[:16]:16} ({es:>4}) {aw:3d}/{n:3d} ai wins  '
              f'{100*p:5.1f}% [{100*lo:5.1f},{100*hi:5.1f}]  elo gap {elo_str(p)}')

    if args.json:
        out = {
            'dump': args.dump, 'games_in_dump': len(games),
            'excluded': dict(skipped),
            'pairs': [{'ai': ai, 'human': hum, 'human_name': name(hum), 'human_elo': elo(hum),
                       'games': n, 'ai_wins': aw, 'ai_red_games': rn, 'ai_red_wins': rw}
                      for (ai, hum), (aw, n, rn, rw) in table.items()],
        }
        json.dump(out, open(args.json, 'w'), indent=1)
        print(f'\nwrote {args.json}')


if __name__ == '__main__':
    main()
