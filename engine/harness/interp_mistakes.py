"""Interpretability experiment 9: a taxonomy of human mistakes (2026-10).

    interp_mistakes.py flag   <lines.json> <raw.json> <out.json> <evals.jsonl> [<evals.jsonl> ...]
    interp_mistakes.py probe  <cases.json|gs://> <depth> <n_shards> <shard_base>    (runner.sh shard)
    interp_mistakes.py report <cases.json> <out.json> <probe-log-glob>

flag. Every recorded human turn (standard and competitive games; `__ai_` uids
are AI opponents, whose turns are skipped) is valued with the stored backward-walk
evaluations (eval_games.py eval --walk backward, depth 5, the shipped search):
the human's loss on the turn is V(before) - V(after) from the human's side, in
stones (a forced result counts as MATE_V). The backward walk puts an evaluation
drop on the move that caused it. Each turn is labelled by its actions from the
transcript (placements, moves, dash, cast + spell, keep choice), by whether the
engine's own best turn cast a spell the human did not, by phase and by the
human's rating; turns losing >= 1 stone are mistakes, >= 3 or allowing a forced
loss are blunders.

probe. A depth-5 drop can be the engine's own blind spot (it never generates
57% of human dashes; engine/FINDINGS). Each flagged turn is re-searched deeper:
the position before the turn and the one after it at `depth`, both untimed, the
shipped search; a mistake is CONFIRMED when the deeper drop is still >= 1 stone.

report. Rates per category, confirmed and unconfirmed, with the engine's
preferred alternative (most common missed casts), for the strategy guide.
"""
import collections, glob, json, os, sys, time
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

MATE_V = 20.0


def _J(x):
    return json.loads(x.replace("'", '"')) if isinstance(x, str) else x


def red_value(row):
    if row is None:
        return None
    if row.get('mate') is not None:
        return MATE_V if row['mate'] > 0 else -MATE_V
    return row.get('stones')


def turn_actions(t):
    acts = t.get('actions') if t else None
    if isinstance(acts, str):
        try:
            acts = json.loads(acts)
        except Exception:  # noqa: BLE001
            acts = None
    if not acts or not all(isinstance(x, dict) for x in acts):
        return None
    kinds = collections.Counter(x.get('type') for x in acts)
    casts = [x.get('spell') for x in acts if x.get('type') == 'cast']
    return {'kinds': dict(kinds), 'casts': casts, 'dash': kinds.get('dash', 0) > 0}


def label(acts):
    if acts is None:
        return 'unknown'
    if acts['casts']:
        return 'cast'
    if acts['dash']:
        return 'dash, no cast'
    return 'placement/move only'


def best_casts(best):
    """Spell names the engine's best turn casts (eval_games 'best' = applyAITurn actions)."""
    if not best:
        return []
    return [a.get('spell') for a in best if isinstance(a, dict) and a.get('type') == 'cast']


def cmd_flag(a):
    lines = json.load(open(a[0])); raw = json.load(open(a[1])); out = a[2]
    rows = {}
    for path in a[3:]:
        for line in open(path):
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            rows[(r.get('gameId') or r.get('g'), r.get('i', r.get('ply')))] = r
    print(f'{len(rows)} evaluated positions', flush=True)
    cases, stats = [], collections.Counter()
    for gid, g in lines.items():
        if g.get('variant', 'standard') not in ('standard', 'competitive'):
            continue
        pos = _J(g['positions'])
        rt = (raw.get(gid) or {}).get('turns') or []
        n = len(pos) - 1
        uids = {'red': g.get('redUid'), 'blue': g.get('blueUid')}
        r_raw = raw.get(gid) or {}
        elo = {'red': r_raw.get('redEloBefore'), 'blue': r_raw.get('blueEloBefore')}
        for i in range(n):
            mover = 'red' if pos[i].split()[1] == 'r' else 'blue'
            if str(uids[mover]).startswith('__ai_'):
                continue
            stats['human turns'] += 1
            ri, rj = rows.get((gid, i)), rows.get((gid, i + 1))
            vi = red_value(ri)
            if i + 1 < n:
                vj = red_value(rj)
            else:
                w = g.get('winner')
                vj = None if w not in ('red', 'blue') else (MATE_V if w == 'red' else -MATE_V)
            if vi is None or vj is None:
                stats['missing eval'] += 1
                continue
            s = 1 if mover == 'red' else -1
            loss = s * (vi - vj)
            acts = turn_actions(rt[i]) if i < len(rt) and len(rt) == n else None
            stones = sum(c in 'rb' for c in pos[i].split('/')[0])
            cases.append({'g': gid, 'i': i, 'mover': mover, 'v_before': round(s * vi, 3), 'v_after': round(s * vj, 3),
                          'loss': round(loss, 3), 'label': label(acts), 'casts': acts['casts'] if acts else None,
                          'engine_casts': best_casts(ri.get('best') if ri else None),
                          'stones_on_board': stones, 'elo': elo[mover], 'sfn': pos[i],
                          'sfn_after': pos[i + 1] if i + 1 < len(pos) else None,
                          'terminal': i + 1 == n, 'vs_ai': str(uids['blue' if mover == 'red' else 'red']).startswith('__ai_')})
    flagged = [c for c in cases if c['loss'] >= 1.0]
    print(dict(stats), f'turns valued {len(cases)}, mistakes (>=1 stone) {len(flagged)}', flush=True)
    json.dump({'turns': cases, 'flagged_index': [k for k, c in enumerate(cases) if c['loss'] >= 1.0]}, open(out, 'w'))


def _fetch(path):
    if not path.startswith('gs://'):
        return open(path, 'rb').read()
    import urllib.parse, urllib.request
    bucket, name = path[5:].split('/', 1)
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        headers={'Metadata-Flavor': 'Google'}), timeout=15))['access_token']
    url = f'https://storage.googleapis.com/storage/v1/b/{bucket}/o/{urllib.parse.quote(name, safe="")}?alt=media'
    return urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': f'Bearer {tok}'}), timeout=300).read()


def cmd_probe(a):
    import sigil_engine as se
    from sprt import shard_offset
    d = json.loads(_fetch(a[0])); depth, n_shards, base = int(a[1]), int(a[2]), int(a[3])
    se.set_policy(*se.SHIPPED_POLICY); se.set_policy_explore(*se.SHIPPED_EXPLORE); se.set_opening_book(False)
    k = shard_offset() // 1000 - base
    idx = d['flagged_index']
    mine = idx[k::n_shards] if 0 <= k < n_shards else idx[:1]
    ad = tuple(se.SHIPPED_ADAPTIVE)
    def val(sfn, pov):
        b = se.Board.from_sfn(sfn)
        if b.gameover:
            w = b.winner
            return 100 * MATE_V * (1 if w == pov else -1)
        mover = 'red' if sfn.split()[1] == 'r' else 'blue'
        v = b.root_scores_and_play(depth, se.SHIPPED_EVAL, False, 1, [], False, None, ad)[1]
        return v if mover == pov else -v
    t0 = time.time()
    for j in (mine if 0 <= k < n_shards else mine[:1]):
        c = d['turns'][j]
        if c['sfn_after'] is None:
            continue
        try:
            vb, va = val(c['sfn'], c['mover']), val(c['sfn_after'], c['mover'])
        except ValueError:
            continue
        print('MPROBE ' + json.dumps({'j': j, 'depth': depth, 'v_before': vb, 'v_after': va,
                                      'loss_deep': round((vb - va) / 100, 3)}), flush=True)
    print(f'SHARD off={shard_offset()} k={k} cases={len(mine)} {time.time() - t0:.0f}s', flush=True)


def cmd_report(a):
    d = json.load(open(a[0])); out = a[1]
    deep = {}
    for path in glob.glob(a[2]):
        for line in open(path, errors='replace'):
            if line.startswith('MPROBE '):
                r = json.loads(line[7:]); deep[r['j']] = r
    T = d['turns']
    res = {'turns': len(T), 'probed': len(deep)}
    def rate(sel, thr=1.0, confirmed=False):
        n = len(sel)
        if confirmed:
            m = sum(1 for j in sel if T[j]['loss'] >= thr and j in deep and deep[j]['loss_deep'] >= 1.0)
        else:
            m = sum(1 for j in sel if T[j]['loss'] >= thr)
        return [m, n, round(m / n, 4) if n else None]
    allj = list(range(len(T)))
    groups = collections.defaultdict(list)
    for j, c in enumerate(T):
        groups['all'].append(j)
        groups[f"action: {c['label']}"].append(j)
        ph = 'early (<=12 stones)' if c['stones_on_board'] <= 12 else 'middle (13-20)' if c['stones_on_board'] <= 20 else 'late (21+)'
        groups[f'phase: {ph}'].append(j)
        e = c['elo']
        if isinstance(e, (int, float)):
            groups['rating: ' + ('<1300' if e < 1300 else '1300-1449' if e < 1450 else '1450+')].append(j)
        for s in c['casts'] or []:
            groups[f'cast: {s}'].append(j)
    res['groups'] = {g: {'mistake_rate': rate(js), 'blunder_rate': rate(js, 3.0),
                         'confirmed_mistake_rate': rate(js, 1.0, True)} for g, js in groups.items() if len(js) >= 50}
    # Missed casts: the engine's best turn cast a spell the human's turn did not, on a confirmed mistake.
    missed = collections.Counter()
    for j in allj:
        c = T[j]
        if c['loss'] >= 1.0 and j in deep and deep[j]['loss_deep'] >= 1.0:
            for s in set(c['engine_casts']) - set(c['casts'] or []):
                missed[s] += 1
    res['missed_casts_on_confirmed_mistakes'] = missed.most_common()
    flagged = [j for j in allj if T[j]['loss'] >= 1.0 and j in deep]
    res['engine_blind_spot_share'] = round(sum(deep[j]['loss_deep'] < 1.0 for j in flagged) / max(1, len(flagged)), 3)
    json.dump(res, open(out, 'w'), indent=1)
    print(f"{res['turns']} human turns, {res['probed']} re-searched; share of depth-5 mistakes NOT confirmed deeper: {res['engine_blind_spot_share']}")
    for g, v in sorted(res['groups'].items()):
        print(f"{g:40s} mistake {v['mistake_rate']}  blunder {v['blunder_rate']}  confirmed {v['confirmed_mistake_rate']}")
    print('missed casts:', res['missed_casts_on_confirmed_mistakes'][:15])


if __name__ == '__main__':
    {'flag': cmd_flag, 'probe': cmd_probe, 'report': cmd_report}[sys.argv[1]](sys.argv[2:])
