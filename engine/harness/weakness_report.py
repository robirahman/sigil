#!/usr/bin/env python3
"""Where does the Rust AI lose, and where does its evaluation fail?

    python engine/harness/weakness_report.py --raw raw_all.json --lines lines_all.json \
        --evals evals.jsonl [--evals more.jsonl] --out report.md [--cases cases.json]

Inputs are the eval_games.py artefacts: the raw completed_games dump (players,
winner, spells, variant, Elo fields), the hydrated per-position SFNs, and the
depth-D evaluations (red-POV stones with the even-game offset, mate in the
winner's turns, proven flag, engine's best turn).

Part 1 -- outcome correlates, Rust-AI games only (`__ai_rust*` uids). Loss rate
overall and split by colour, tier, variant, game length, human opponent Elo,
and by each spell present in the draw. Every split carries a Wilson 95%
interval and a two-proportion z against the rest; with a few hundred games a
spell effect needs |z| >= 2 to be worth a look and >= 3 to be believed.

Part 2 -- evaluation failures, every game with evals (human-vs-human and
AI-vs-AI included: the evaluation is the same engine, whoever moved):
  A. "winning but did not win": a position the engine scores as a forced win
     (mate) or decisive (|stones| >= DECISIVE) for side X, in a game X did not
     win.
  B. "loss in N but lost sooner": mate says the side to move loses in N of the
     winner's turns; the game ended, won by that side, within fewer of the
     winner's turns than N. (And the mirror: "win in N but it took longer" is
     counted, not listed -- the winner may simply have played slower.)
  C. "non-decisive eval that collapsed": two positions two plies apart, same
     side to move, both non-decisive (|stones| < DECISIVE), and the mover's
     evaluation fell by more than DROP stones. Split by whose turn came in
     between: across the ENGINE's own move (horizon effect: its chosen move
     looked fine at depth D and was refuted two plies later) versus across the
     OPPONENT's move (the engine did not see the opponent's resource).
Each class is counted per 1,000 positions overall, per side-to-move, per
engine era, and per spell present, and the worst cases are listed with the
SFN and a review link.
"""
import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime

DECISIVE = 3.0
DROP = 1.0
RUST_LIVE = datetime(2026, 8, 30).timestamp() * 1000


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (p, max(0.0, c - h), min(1.0, c + h))


def ztest(k1, n1, k2, n2):
    """Two-proportion z: group 1 against group 2."""
    if n1 == 0 or n2 == 0:
        return 0.0
    p1, p2 = k1 / n1, k2 / n2
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)) or 1e-9
    return (p1 - p2) / se


def is_ai(uid):
    return isinstance(uid, str) and uid.startswith('__ai_')


def is_rust(uid):
    return isinstance(uid, str) and uid.startswith('__ai_rust')


def tier(uid):
    return uid.strip('_')[3:] if is_ai(uid) else 'human'


def load_rows(paths):
    rows = defaultdict(dict)
    for path in paths:
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                d = json.loads(line)
                if 'error' in d:
                    continue
                rows[d['g']][d['i']] = d
    return rows


def spells_of(g):
    return sorted(set(g.get('spellNames') or []))


def pct(p):
    return f'{100 * p:.1f}%'


def fmt_split(name, k, n, k_rest, n_rest):
    p, lo, hi = wilson(k, n)
    z = ztest(k, n, k_rest, n_rest)
    return f'| {name} | {n} | {k} | {pct(p)} | {pct(lo)}–{pct(hi)} | {z:+.1f} |'


def review_link(g, gid):
    rc = g.get('roomCode')
    return f'https://sigilbattle.com/multiplayer.html?id={rc}' if rc else f'(no room code; game {gid})'


# ------------------------------------------------------------- part 1 ---

def outcome_report(raw, out):
    games = []
    for gid, g in raw.items():
        r, b = g.get('redUid'), g.get('blueUid')
        if not (is_rust(r) or is_rust(b)):
            continue
        if is_rust(r) and is_rust(b):
            continue                      # AI-vs-AI: no "the AI" to lose
        ai_color = 'red' if is_rust(r) else 'blue'
        ai_uid = r if ai_color == 'red' else b
        opp_uid = b if ai_color == 'red' else r
        winner = g.get('winner')
        t = g.get('turns') or []
        n_turns = len(t) if isinstance(t, list) else len(t)
        opp_elo = g.get('redEloBefore' if ai_color == 'blue' else 'blueEloBefore')
        games.append({'gid': gid, 'ai_color': ai_color, 'tier': tier(ai_uid), 'opp': tier(opp_uid),
                      'lost': winner not in (None, ai_color, 'draw') and winner != ai_color,
                      'won': winner == ai_color, 'winner': winner, 'variant': g.get('variant') or 'standard',
                      'n_turns': n_turns, 'opp_elo': opp_elo, 'spells': spells_of(g), 'ts': g.get('timestamp') or 0,
                      'ranked': bool(g.get('ranked'))})
    n = len(games)
    k = sum(x['lost'] for x in games)
    out.append('## Part 1 — where the Rust AI loses\n')
    if n == 0:
        out.append('No Rust-AI games in the dump.\n'); return games
    p, lo, hi = wilson(k, n)
    out.append(f'{n} games with a Rust tier on one side (both AI-vs-AI and JS-tier games excluded). '
               f'The AI lost **{k}** ({pct(p)}, 95% {pct(lo)}–{pct(hi)}); '
               f'won {sum(x["won"] for x in games)}; other results {sum(1 for x in games if not x["won"] and not x["lost"])}.\n')
    out.append('Each split: loss rate with a Wilson 95% interval and a z-score against the complementary games. '
               'Read |z| >= 2 as worth a look and |z| >= 3 as real.\n')

    def table(title, key_fn, min_n=5):
        groups = defaultdict(list)
        for x in games:
            for key in key_fn(x):
                groups[key].append(x)
        out.append(f'\n### {title}\n\n| split | games | AI losses | loss rate | 95% CI | z vs rest |\n|---|---|---|---|---|---|')
        rows = []
        for key, xs in groups.items():
            if len(xs) < min_n:
                continue
            kk = sum(x['lost'] for x in xs)
            rest_n = n - len(xs); rest_k = k - kk
            rows.append((ztest(kk, len(xs), rest_k, rest_n), key, kk, len(xs), rest_k, rest_n))
        rows.sort(key=lambda r: -r[0])
        for z, key, kk, nn, rk, rn in rows:
            out.append(fmt_split(str(key), kk, nn, rk, rn))
        return rows

    table('By colour', lambda x: [f'AI plays {x["ai_color"]}'])
    table('By tier', lambda x: [x['tier']])
    table('By variant', lambda x: [x['variant']])
    table('By ranked flag', lambda x: ['ranked' if x['ranked'] else 'unranked'])

    def elo_bucket(x):
        e = x['opp_elo']
        if not isinstance(e, (int, float)):
            return ['opponent Elo unknown']
        lo_ = int(e // 100) * 100
        return [f'opponent Elo {lo_}–{lo_ + 99}']
    table('By opponent Elo (before the game)', elo_bucket)

    def length_bucket(x):
        t = x['n_turns']
        return [f'{(t // 10) * 10}–{(t // 10) * 10 + 9} turns']
    table('By game length', length_bucket)

    def week(x):
        return [datetime.utcfromtimestamp(x['ts'] / 1000).strftime('%Y-W%V')]
    table('By week', week)

    spell_rows = table('By spell present in the draw (9 of the pool per game)', lambda x: x['spells'], min_n=8)
    out.append('\nSpells sorted by z: the top rows are where the AI loses MORE than in games without that spell, '
               'the bottom rows where it loses less. With this many games a single spell needs |z| >= 3 before '
               'it means anything; treat 2–3 as a hint to look at those games\' eval trajectories in Part 2.\n')
    # Pairwise: spells that co-occur in lost games more than chance is beyond this sample; skip.
    return games


# ------------------------------------------------------------- part 2 ---

def eval_report(raw, lines, rows, out, cases, max_list=25):
    out.append('\n## Part 2 — evaluation failures (every game with stored evals)\n')
    covered = [gid for gid in lines if gid in rows and rows[gid]]
    n_pos = sum(len(rows[gid]) for gid in covered)
    out.append(f'{len(covered)} games / {n_pos} evaluated positions (of {len(lines)} hydrated games). '
               f'Evals are the shipped search at fixed depth, red-POV stones after the even-game offset; '
               f'"mate" is the winner\'s own turns.\n')
    if not covered:
        return

    A, B, B_slow, C_engine, C_opp, C_other = [], [], [], [], [], []
    per_spell = defaultdict(lambda: Counter())
    per_side = Counter(); per_era = Counter()
    pos_by_spell = Counter(); pos_by_side = Counter(); pos_by_era = Counter()

    def era(g):
        ts = g.get('timestamp') or 0
        return 'rust era (>= 2026-08-30)' if ts >= RUST_LIVE else 'pre-rust era'

    for gid in covered:
        g = lines[gid]; rg = raw.get(gid, {})
        r = rows[gid]
        n = len(g['positions']) - 1
        winner = g.get('winner') if g.get('winner') in ('red', 'blue') else None
        spells = spells_of(rg) if rg else []
        ai_side = None
        red_ai, blue_ai = is_ai(rg.get('redUid')), is_ai(rg.get('blueUid'))
        if red_ai != blue_ai:
            ai_side = 'red' if red_ai else 'blue'
        e = era(rg)
        link = review_link(rg, gid)
        idxs = sorted(r)
        for i in idxs:
            pos_by_side[r[i]['mover']] += 1; pos_by_era[e] += 1
            for s in spells: pos_by_spell[s] += 1

        def flag(kind, i, detail, rec_list):
            row = r[i]
            per_side[(kind, row['mover'])] += 1; per_era[(kind, e)] += 1
            for s in spells: per_spell[kind][s] += 1
            rec = {'kind': kind, 'game': gid, 'i': i, 'turn': (g.get('turnNumbers') or [None] * n)[i] if i < n else None,
                   'mover': row['mover'], 'stones_red': row['stones'], 'mate_red': row['mate'], 'proven': row['proven'],
                   'depth': row['depth'], 'winner': winner, 'ai_side': ai_side, 'era': e, 'link': link,
                   'sfn': g['positions'][i], 'detail': detail,
                   'red': tier(rg.get('redUid')), 'blue': tier(rg.get('blueUid'))}
            rec_list.append(rec); cases.append(rec)

        # A / B: forced or decisive claims vs the result
        winner_turns_left = {}
        if winner:
            # winner's own turns remaining from position i: count winner's moves in positions i..n-1
            cnt = 0
            for i in range(n - 1, -1, -1):
                if r.get(i) and r[i]['mover'] == winner:
                    cnt += 1
                elif i in r:
                    pass
                winner_turns_left[i] = cnt
            # positions without rows still need a count: recompute from movers in lines
            movers = [p.split()[1] for p in g['positions'][:-1]]
            cnt = 0
            for i in range(n - 1, -1, -1):
                if movers[i] == ('r' if winner == 'red' else 'b'):
                    cnt += 1
                winner_turns_left[i] = cnt
        for i in idxs:
            row = r[i]; st, m = row['stones'], row['mate']
            claimed = None
            if m:
                claimed = 'red' if m > 0 else 'blue'
            elif isinstance(st, (int, float)) and abs(st) >= DECISIVE:
                claimed = 'red' if st > 0 else 'blue'
            if claimed and winner and claimed != winner:
                flag('A', i, f'engine: {"mate in %d" % abs(m) if m else "%+.1f stones" % st} for {claimed}'
                             f'{"" if row["proven"] else " (unproven)"}; game won by {winner}', A)
            elif claimed and not winner:
                flag('A', i, f'engine: {"mate in %d" % abs(m) if m else "%+.1f stones" % st} for {claimed}; game had no winner', A)
            if m and winner and claimed == winner:
                actual = winner_turns_left.get(i)
                if actual is not None and actual < abs(m):
                    flag('B', i, f'engine: {winner} wins in {abs(m)}{"" if row["proven"] else " (unproven)"}; '
                                 f'the game ended after {actual} more {winner} turn(s)', B)
                elif actual is not None and actual > abs(m):
                    B_slow.append((gid, i, abs(m), actual))
        # C: collapses of non-decisive evals over two plies
        for i in idxs:
            j = i + 2
            if j not in r:
                continue
            a, b = r[i], r[j]
            if a['mate'] or b['mate'] or a['stones'] is None or b['stones'] is None:
                continue
            if abs(a['stones']) >= DECISIVE or abs(b['stones']) >= DECISIVE:
                continue
            sign = 1 if a['mover'] == 'red' else -1
            drop = (a['stones'] - b['stones']) * sign     # mover's view: positive = got worse for the mover
            if drop > DROP:
                mover = a['mover']
                if ai_side is None:
                    bucket, kind = C_other, 'C'
                elif mover == ai_side:
                    bucket, kind = C_engine, 'C-engine-move'
                else:
                    bucket, kind = C_opp, 'C-opp-move'
                flag(kind, i, f'{mover} to move: {a["stones"] * sign:+.1f} -> {b["stones"] * sign:+.1f} for {mover} two plies later '
                              f'(drop {drop:.1f}); AI is {ai_side or "neither side"}', bucket)

    def rate_table(title, kind_prefix):
        out.append(f'\n### {title}\n\n| split | positions | cases | per 1,000 |\n|---|---|---|---|')
        for side in ('red', 'blue'):
            c = sum(v for (k_, s), v in per_side.items() if k_.startswith(kind_prefix) and s == side)
            out.append(f'| {side} to move | {pos_by_side[side]} | {c} | {1000 * c / max(1, pos_by_side[side]):.1f} |')
        for e_ in sorted(pos_by_era):
            c = sum(v for (k_, x), v in per_era.items() if k_.startswith(kind_prefix) and x == e_)
            out.append(f'| {e_} | {pos_by_era[e_]} | {c} | {1000 * c / max(1, pos_by_era[e_]):.1f} |')

    def spell_table(kind_prefix, top=12):
        tot_cases = sum(sum(per_spell[k_].values()) for k_ in per_spell if k_.startswith(kind_prefix))
        tot_pos = sum(pos_by_spell.values())
        if not tot_cases:
            return
        base = tot_cases / max(1, tot_pos)
        rows_ = []
        for s, npos in pos_by_spell.items():
            if npos < 300:
                continue
            c = sum(per_spell[k_][s] for k_ in per_spell if k_.startswith(kind_prefix))
            z = ztest(c, npos, tot_cases - c, tot_pos - npos)
            rows_.append((z, s, c, npos))
        rows_.sort(key=lambda t: -t[0])
        out.append(f'\n| spell present | positions | cases | per 1,000 | z vs rest |\n|---|---|---|---|---|')
        shown = rows_[:top] + (rows_[-4:] if len(rows_) > top + 4 else rows_[top:])
        for z, s, c, npos in shown:
            out.append(f'| {s} | {npos} | {c} | {1000 * c / npos:.1f} | {z:+.1f} |')

    def listing(items, title, key=None, n_max=max_list):
        out.append(f'\n**{title}: {len(items)} cases.**\n')
        if not items:
            return
        items = sorted(items, key=key) if key else items
        out.append('| game | turn | mover | red / blue | engine said | result | depth | review |\n|---|---|---|---|---|---|---|---|')
        for c in items[:n_max]:
            out.append(f'| `{c["game"]}` | {c["turn"]} | {c["mover"]} | {c["red"]} / {c["blue"]} | {c["detail"]} | '
                       f'{c["winner"] or "no winner"} | {c["depth"]} | {c["link"]} |')
        if len(items) > n_max:
            out.append(f'\n… {len(items) - n_max} more in the cases file.')

    out.append('\n### A. "Winning" positions the claimed side did not win\n')
    out.append(f'{len(A)} positions ({1000 * len(A) / n_pos:.1f} per 1,000) where the engine gave one side a forced win or a '
               f'decisive lead (|stones| >= {DECISIVE:.0f}) and that side did not win the game. Proven mates here are the '
               f'strongest evidence of a rules or search bug; unproven mates and decisive material leads may also be the '
               f'winning side blundering later (check who was to move and who the players were).')
    rate_table('Rate by side to move and era', 'A')
    out.append('\nBy spell present:'); spell_table('A')
    proven_A = [c for c in A if c['mate_red'] and c['proven']]
    listing(proven_A, 'A1. PROVEN mates that did not materialise', key=lambda c: c['i'])
    unproven_A = [c for c in A if c['mate_red'] and not c['proven']]
    listing(unproven_A, 'A2. Unproven ("likely") mates that did not materialise', key=lambda c: c['i'])
    material_A = [c for c in A if not c['mate_red']]
    listing(material_A, 'A3. Decisive material evals that did not materialise', key=lambda c: -abs(c['stones_red'] or 0))

    out.append('\n### B. "Loss in N" that arrived sooner\n')
    out.append(f'{len(B)} positions where the engine\'s mate distance was longer than the game\'s actual finish '
               f'(counted in the winner\'s own turns; the winner may also have found a faster mate the engine did not see). '
               f'{len(B_slow)} positions had the opposite: the winner took longer than the engine\'s distance, which is '
               f'normal (a slower win is still a win).')
    listing(B, 'B. Mate distance too long', key=lambda c: c['i'])

    out.append('\n### C. Non-decisive evaluations that collapsed within two plies\n')
    out.append(f'Both positions non-decisive (|stones| < {DECISIVE:.0f}) with the same side to move, mover\'s eval down by more '
               f'than {DROP:.0f} stone. Across the ENGINE\'s own move the engine picked a move it later disliked (horizon effect / '
               f'a refutation beyond depth); across the OPPONENT\'s move the engine did not see the opponent\'s resource. '
               f'Games without an AI side (human-vs-human, AI-vs-AI) are pooled as "other".\n')
    out.append(f'- engine-move collapses: **{len(C_engine)}** ({1000 * len(C_engine) / n_pos:.1f} per 1,000 positions)\n'
               f'- opponent-move collapses (AI side surprised): **{len(C_opp)}** ({1000 * len(C_opp) / n_pos:.1f} per 1,000)\n'
               f'- other games: **{len(C_other)}**')
    rate_table('Rate by side to move and era (all C)', 'C')
    out.append('\nBy spell present (all C):'); spell_table('C')
    listing(C_engine, 'C1. Collapses across the AI\'s own move (largest first)',
            key=lambda c: -float(c['detail'].split('drop ')[1].split(')')[0]))
    listing(C_opp, 'C2. Collapses across the opponent\'s move (largest first)',
            key=lambda c: -float(c['detail'].split('drop ')[1].split(')')[0]))
    listing(C_other, 'C3. Collapses in games without an AI side (largest first)',
            key=lambda c: -float(c['detail'].split('drop ')[1].split(')')[0]), n_max=10)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--raw', required=True); ap.add_argument('--lines', required=True)
    ap.add_argument('--evals', action='append', required=True)
    ap.add_argument('--out', required=True); ap.add_argument('--cases', default='')
    ap.add_argument('--max-list', type=int, default=25)
    a = ap.parse_args()
    raw = json.load(open(a.raw, encoding='utf-8'))
    lines = json.load(open(a.lines, encoding='utf-8'))
    rows = load_rows(a.evals)
    out = [f'# Rust engine weakness report — {datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")}\n',
           f'Sources: {len(raw)} completed_games records, {len(lines)} hydrated games, '
           f'{sum(len(v) for v in rows.values())} evaluated positions from {len(a.evals)} evals file(s).\n']
    cases = []
    outcome_report(raw, out)
    eval_report(raw, lines, rows, out, cases, max_list=a.max_list)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or '.', exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(out) + '\n')
    if a.cases:
        with open(a.cases, 'w', encoding='utf-8') as fh:
            json.dump(cases, fh, indent=1)
    print(f'wrote {a.out} ({len(cases)} cases)')


if __name__ == '__main__':
    main()
