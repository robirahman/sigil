"""Build the frozen human-game benchmark suites (2026-10 training plan, Step 1).

    # 1. drop games the current rules cannot replay faithfully:
    python engine/harness/bench_build.py filter --lines work/lines_all.json --out work/lines.json
    # 2. the games a previous surprise audit has not seen yet (its own corpus for the fleet):
    python engine/harness/bench_build.py newgames --lines work/lines.json \
        --audit ai/data/surprise_audit_2026-09-26.json --out work/lines_new.json
    # 3. freeze the three suites under ai/data/benchmarks/:
    python engine/harness/bench_build.py freeze --lines work/lines.json --old-lines <corpus of the old audit> \
        --audit ai/data/surprise_audit_2026-09-26.json [--new-rows report_rows.json] \
        --drops ai/data/human_turn_drops_2026-09-23.json --final work/final_probe.jsonl --out ai/data/benchmarks
    # 4. the own-turn half of a guest suite (bench_suites.py --guest):
    python engine/harness/bench_build.py guest-own --lines lines_all.json --rows v23:<run>/report_rows_own.json \
        --rows v25:... --rows v27:... --out ai/data/benchmarks/guest_2026-10_own.json

Every case in a frozen suite carries its own SFNs (and the game history up to the position,
for threefold repetition), so `bench_suites.py` needs nothing but the suite file.

Filters (`filter`, and re-applied to old cases in `freeze`): the Fireblast and Competitive
cutoffs of `ai/data_filters.py` (by game timestamp), and the 2026-10 rule change
(`OCT2026_RULE_CHANGE_SPELLS`: Fissure, Bulwark and the Providence pack were rewritten on
providence-bank, so their recorded games were played under old rules).
"""
import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from ai import data_filters as df  # noqa: E402


def _write(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(obj, fh, indent=1 if path.endswith('.json') and 'benchmarks' in path else None)
    os.replace(tmp, path)


def excluded_reason(sfn, timestamp_ms=None):
    """Why a game (given its first position) is excluded, or None."""
    if df.has_oct2026_rule_change_spell(sfn):
        return '2026-10 rule change (Fissure/Bulwark/Providence)'
    if timestamp_ms:
        d = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).date()
        if df.sfn_has_fireblast(sfn) and d < df.FIREBLAST_RULE_CHANGE_CUTOFF:
            return 'pre-nerf Fireblast'
        if df.sfn_variant(sfn) == 'competitive' and d < df.COMPETITIVE_FIX_CUTOFF:
            return 'pre-fix competitive'
    return None


def cmd_filter(a):
    lines = json.load(open(a.lines, encoding='utf-8'))
    out, why = {}, Counter()
    for k, g in lines.items():
        r = excluded_reason(g['positions'][0], g.get('timestamp'))
        if r:
            why[r] += 1
            continue
        out[k] = g
    _write(a.out, out)
    print(f'kept {len(out)} of {len(lines)} games, '
          f'{sum(len(g["positions"]) for g in out.values())} positions; excluded {dict(why)}')


def cmd_newgames(a):
    lines = json.load(open(a.lines, encoding='utf-8'))
    audit = json.load(open(a.audit, encoding='utf-8'))
    seen = {c['g'] for side in ('opponent_turn', 'own_turn') for c in audit.get(side, [])}
    seen |= set(json.load(open(a.seen_lines, encoding='utf-8'))) if a.seen_lines else set()
    out = {k: g for k, g in lines.items() if k not in seen}
    _write(a.out, out)
    print(f'{len(out)} of {len(lines)} games not in the previous audit '
          f'({sum(len(g["positions"]) for g in out.values())} positions)')


def _history(g, i):
    return g['positions'][:i]


def _surprise_case(c, lines, src):
    g = lines.get(c['g'])
    if g is None:
        return None
    i = c['i']
    return {
        'src': src, 'g': c['g'], 'i': i, 'room': c.get('room'), 'ai': c['ai'],
        'sfn': g['positions'][i], 'sfn_after': g['positions'][i + 1],
        'history': _history(g, i),
        'target': c['target'], 'v4_i': c.get('v4_i'), 'cls': c.get('cls'), 'kind': c.get('kind'),
        'nodes_d6': (c.get('nodes') or {}).get('d6_i'),
    }


def cmd_freeze(a):
    os.makedirs(a.out, exist_ok=True)
    lines = json.load(open(a.lines, encoding='utf-8'))
    old_lines = {}
    for p in a.old_lines:
        old_lines.update(json.load(open(p, encoding='utf-8')))
    allg = {**lines, **old_lines}   # the audited corpora win: case indices refer to them
    report = {}

    # --- surprise suite -----------------------------------------------------------
    audit = json.load(open(a.audit, encoding='utf-8'))
    old = [c for c in audit['opponent_turn'] if c.get('confirmed')]
    cases, dropped, missing = [], Counter(), 0
    for c in old:
        g = allg.get(c['g'])
        if g is None:
            missing += 1
            continue
        r = excluded_reason(g['positions'][0], g.get('timestamp'))
        if r:
            dropped[r] += 1
            continue
        cases.append(_surprise_case(c, allg, 'surprise_audit_2026-09-26'))
    n_old = len(cases)
    n_new = 0
    if a.new_rows:   # surprise_audit.py report --json output of the new games' run
        for c in json.load(open(a.new_rows, encoding='utf-8')):
            if not c.get('confirmed'):
                continue
            g = lines.get(c['g'])
            if g is None or excluded_reason(g['positions'][0], g.get('timestamp')):
                continue
            cases.append(_surprise_case(c, lines, a.new_tag))
            n_new += 1
    _write(os.path.join(a.out, 'surprise_cases.json'), cases)
    report['surprise'] = {'old_confirmed': len(old), 'old_kept': n_old, 'old_dropped': dict(dropped),
                          'old_missing_game': missing, 'new_confirmed': n_new, 'total': len(cases)}

    # --- human finds ---------------------------------------------------------------
    drops = json.load(open(a.drops, encoding='utf-8'))
    conf = [d for d in drops if (d.get('vdrop') or 0) > 1.0]
    finds, hd = [], Counter()
    for d in conf:
        r = excluded_reason(d['sfn0'])
        if r:
            hd[r] += 1
            continue
        g = allg.get(d['gid'])
        finds.append({'src': 'human_turn_drops_2026-09-23', 'g': d['gid'], 'i': d['i'], 'room': d.get('room'),
                      'human': d['human'], 'ai': d['ai'], 'sfn': d['sfn0'], 'sfn_after': d['sfn1'],
                      'history': _history(g, d['i']) if g else None,
                      'v_before': d.get('vv0'), 'v_after': d.get('vv1'), 'vdrop': d.get('vdrop'),
                      'cat': d.get('cat'), 'cls': d.get('cls'), 'tokens': d.get('tokens')})
    _write(os.path.join(a.out, 'human_finds.json'), finds)
    report['human_finds'] = {'confirmed': len(conf), 'kept': len(finds), 'dropped': dict(hd),
                             'without_history': sum(f['history'] is None for f in finds)}

    # --- final-blow misses -----------------------------------------------------------
    fb, fd, n_all = [], Counter(), 0
    for ln in open(a.final, encoding='utf-8'):
        if not ln.strip():
            continue
        r = json.loads(ln)
        n_all += 1
        # A miss = the mover had an immediate win (solver) and the depth-2 search did not
        # report a forced win: weakness_report.py's Part 3 definition (61 in 2026-09).
        if r.get('d2_sees') or r.get('error') or not r.get('sfn') or not r.get('mate1_total'):
            continue
        g = allg.get(r['g'])
        why = excluded_reason(r['sfn'], g.get('timestamp') if g else None)
        if why:
            fd[why] += 1
            continue
        fb.append({'src': a.final_tag, 'g': r['g'], 'i': r['i'], 'sfn': r['sfn'],
                   'history': _history(g, r['i']) if g else None, 'mover': r.get('mover'),
                   'sfn_after': g['positions'][r['i'] + 1] if g and r['i'] + 1 < len(g['positions']) else None,
                   'mate1_total': r.get('mate1_total'), 'root_successors': r.get('root_successors'),
                   'd1_sees': r.get('d1_sees'), 'd2_sees': r.get('d2_sees')})
    _write(os.path.join(a.out, 'final_blow_misses.json'), fb)
    report['final_blow'] = {'games_probed': n_all, 'misses_kept': len(fb), 'dropped': dict(fd)}
    print(json.dumps(report, indent=1))
    _write(os.path.join(a.out, 'build_report.json'), report)


def cmd_guest_own(a):
    """Own-turn falls of a surprise audit that started NEAR LEVEL: the run's depth-4 value
    before the AI's move is >= --min-v4 (default -1.0), that run confirmed the fall, and its
    depth-6 alternative beats the played move by >= --min-gain stones (default 0.25). These
    are the avoidable blunders; from a lost position every move loses, and "avoids" means
    nothing there. One case per (game, position). The first run listed sets the base fields,
    and every run's values are kept as `<tag>_*`. `sfn` is the AI's decision position,
    `sfn_after` the move it actually played, `history` the game before `sfn`."""
    lines = json.load(open(a.lines, encoding='utf-8'))
    cases = {}
    for spec in a.rows:
        tag, _, path = spec.partition(':')
        for r in json.load(open(path, encoding='utf-8')):
            if not r.get('confirmed') or r.get('v4_i') is None or r['v4_i'] < a.min_v4:
                continue
            # The depth-6 alternative must be better than the played move by --min-gain
            # (alt6_v None = depth 6 plays the blunder too: kept, a blind case).
            if r.get('alt6_v') is not None and r['alt6_v'] - r['target'] < a.min_gain:
                continue
            P = lines[r['g']]['positions']
            key = (r['g'], r['i'])
            c = cases.get(key)
            if c is None:
                c = cases[key] = {'g': r['g'], 'i': r['i'], 'ai': r['ai'], 'room': r.get('room'),
                                  'sfn': P[r['i']], 'sfn_after': P[r['i'] + 1], 'history': P[:r['i']],
                                  'kind': r.get('kind'), 'target': r['target'], 'v4_i': r['v4_i'],
                                  'alt6_v': r.get('alt6_v'), 'ai_won': r.get('winner') == r['ai'],
                                  'confirmed_by': []}
            c['confirmed_by'].append(tag)
            for k in ('target', 'v4_i', 'alt6_v', 'avoids_d4_i', 'avoids_d5_i', 'avoids_d6_i'):
                c[f'{tag}_{k}'] = r.get(k)
    out = sorted(cases.values(), key=lambda c: (lines[c['g']]['timestamp'], c['i']))
    print(f'{len(out)} own-turn cases (v4_i >= {a.min_v4}, alt6 gain >= {a.min_gain})')
    _write(a.out, out)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    f = sub.add_parser('filter'); f.add_argument('--lines', required=True); f.add_argument('--out', required=True)
    n = sub.add_parser('newgames'); n.add_argument('--lines', required=True); n.add_argument('--audit', required=True)
    n.add_argument('--seen-lines', help='lines.json whose games were already audited'); n.add_argument('--out', required=True)
    z = sub.add_parser('freeze')
    z.add_argument('--lines', required=True); z.add_argument('--old-lines', action='append', default=[])
    z.add_argument("--audit", required=True); z.add_argument("--new-rows")
    z.add_argument('--new-tag', default='surprise_audit_2026-10'); z.add_argument('--drops', required=True)
    z.add_argument('--final', required=True); z.add_argument('--final-tag', default='final_blow_probe_2026-10')
    z.add_argument('--out', required=True)
    o = sub.add_parser('guest-own'); o.add_argument('--lines', required=True)
    o.add_argument('--rows', action='append', required=True, help='TAG:report_rows_own.json (repeatable)')
    o.add_argument('--min-v4', type=float, default=-1.0); o.add_argument('--min-gain', type=float, default=0.25)
    o.add_argument('--out', required=True)
    a = ap.parse_args()
    {'filter': cmd_filter, 'newgames': cmd_newgames, 'freeze': cmd_freeze,
     'guest-own': cmd_guest_own}[a.cmd](a)


if __name__ == '__main__':
    main()
