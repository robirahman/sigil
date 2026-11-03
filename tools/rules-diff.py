#!/usr/bin/env python3
"""Differential test: the Rust full-rules enumerator (engine/examples/rules_children: every
distinct position after the turn's end-of-turn effects)
against the browser's interactive rules (tools/rules-enum.js).

    python3 tools/rules-diff.py --rust <target>/release/examples/rules_children \
        positions.txt [--jobs 4] [--out diff.jsonl] [--max-children 60000]

positions.txt holds one SFN per line (side to move = the mover). For each
position, both sides list every distinct resulting position; they are compared
by normKey (the SFN without its side-to-move and turn-counter tokens). Any
position one side reaches and the other does not is a MISMATCH and is printed
with a witness token/action list. Positions whose Rust child count exceeds
--max-children are skipped (the JS walk replays every prefix and is ~2,000
runs/s), and reported as skipped, never as passed.
"""
import argparse
import concurrent.futures as cf
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def norm(sfn):
    p = sfn.split()
    return ' '.join([p[0]] + p[3:])


def rust_children(binary, sfn):
    out = subprocess.run([binary], input=sfn + '\n', capture_output=True, text=True, check=True).stdout
    r = json.loads(out)
    if 'error' in r:
        raise RuntimeError(r['error'])
    return r


def js_children(sfn):
    out = subprocess.run(['node', '--max-old-space-size=4096', os.path.join(REPO, 'tools', 'rules-enum.js')],
                         input=sfn + '\n', capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def one(binary, sfn, max_children):
    rr = rust_children(binary, sfn)
    if rr['truncated']:
        return {'sfn': sfn, 'status': 'skipped', 'why': 'rust truncated'}
    if len(rr['children']) > max_children:
        return {'sfn': sfn, 'status': 'skipped', 'why': f"{len(rr['children'])} children"}
    jr = js_children(sfn)
    if jr['stats']['runs'] == 1 and len(jr['children']) == 1 and jr['children'][0]['tokens'] == []:
        # The controller ended the game before the mover's first prompt (the
        # mover holds a charged Seal of Destruction). Not a turn position:
        # mate::child marks such children finished, so a proof never expands one.
        return {'sfn': sfn, 'status': 'terminal', 'winner': jr['children'][0]['winner']}
    rk = {norm(c['sfn']): c for c in rr['children']}
    jk = {c['key']: c for c in jr['children']}
    only_r = sorted(set(rk) - set(jk))
    only_j = sorted(set(jk) - set(rk))
    win = {'Ongoing': None, 'RedWins': 'red', 'BlueWins': 'blue'}
    outcome_diff = [k for k in set(rk) & set(jk)
                    if win[rk[k]['outcome']] != (jk[k]['winner'] if jk[k]['gameover'] else None)]
    res = {'sfn': sfn, 'rust': len(rk), 'js': len(jk), 'js_stats': jr['stats'],
           'status': 'ok' if not only_r and not only_j and not outcome_diff and not jr['stats']['errors'] else 'MISMATCH'}
    if outcome_diff:
        res['outcome_diff'] = [{'key': k, 'rust': rk[k]['outcome'], 'js': jk[k]['winner'], 'actions': rk[k]['actions']}
                               for k in sorted(outcome_diff)[:20]]
        res['outcome_diff_count'] = len(outcome_diff)
    if only_r:
        res['only_rust'] = [{'key': k, 'actions': rk[k]['actions']} for k in only_r[:20]]
        res['only_rust_count'] = len(only_r)
    if only_j:
        res['only_js'] = [{'key': k, 'tokens': jk[k]['tokens']} for k in only_j[:20]]
        res['only_js_count'] = len(only_j)
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('positions')
    ap.add_argument('--rust', required=True, help='engine/examples/rules_children binary')
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 1)
    ap.add_argument('--out')
    ap.add_argument('--max-children', type=int, default=60000)
    a = ap.parse_args()
    sfns = [l.strip() for l in open(a.positions) if l.strip()]
    out = open(a.out, 'a') if a.out else None
    counts = {}
    with cf.ThreadPoolExecutor(a.jobs) as ex:
        futs = {ex.submit(one, a.rust, s, a.max_children): s for s in sfns}
        for f in cf.as_completed(futs):
            try:
                r = f.result()
            except Exception as e:  # noqa: BLE001
                r = {'sfn': futs[f], 'status': 'error', 'why': str(e)[:300]}
            counts[r['status']] = counts.get(r['status'], 0) + 1
            if r['status'] != 'ok':
                print(json.dumps(r)[:2000], flush=True)
            if out:
                out.write(json.dumps(r) + '\n')
                out.flush()
    print('summary', json.dumps(counts))
    sys.exit(1 if counts.get('MISMATCH') or counts.get('error') else 0)


if __name__ == '__main__':
    main()
