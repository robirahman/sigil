#!/usr/bin/env python3
"""Proof certificates for a puzzle set's reference solutions (SigilBench v3).

For every puzzle: replay the reference first turn in the browser rules
(bench/grader/apply.js), extract a certificate that it forces mate within N
(engine/examples/cert_tool make -> mate::cert_json), then re-verify it with the
independent Rust checker (cert_tool check -> sigil_engine::cert). Optionally
also with the browser's interactive rules (tools/check-mate-cert.js, --js).

    python3 bench/tools/certs.py bench/dev/dev_set_v2.json --tool <target>/release/examples/cert_tool \
        --out certs.jsonl [--jobs 4] [--time-ms 600000] [--ids a,b] [--max-n 4] [--js]

Writes one JSON line per puzzle: id, n, make (ok, nodes, seconds, sizes),
check (ok, and/or nodes, seconds) and the certificate itself under "cert".
Certificates for private (test-set) puzzles belong in the private bucket only.
"""
import argparse
import concurrent.futures as cf
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import BENCH  # noqa: E402

REPO = os.path.dirname(BENCH)


def after_sfns(puzzles):
    inp = ''.join(json.dumps({'sfn': p['sfn'], 'actions': p['reference_solution']}) + '\n' for p in puzzles)
    out = subprocess.run(['node', os.path.join(BENCH, 'grader', 'apply.js')], input=inp,
                         capture_output=True, text=True, check=True).stdout.splitlines()
    return [json.loads(l) for l in out]


def make(tool, n, after, budget, time_ms, leaves):
    req = '\t'.join([str(n), after, str(budget), str(time_ms), '1' if leaves else '0']) + '\n'
    out = subprocess.run([tool, 'make'], input=req, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def check(tool, cert):
    fields = [str(cert['n']), cert['after']]
    for e in cert['internal'] + cert.get('leaves', []):
        fields += [e['at'], e['to']]
    out = subprocess.run([tool, 'check'], input='\t'.join(fields) + '\n', capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def check_js(cert):
    out = subprocess.run(['node', '--max-old-space-size=4096', os.path.join(REPO, 'tools', 'check-mate-cert.js')],
                         input=json.dumps(cert) + '\n', capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def one(a, p, rep):
    res = {'id': p['id'], 'n': p['n']}
    if not rep.get('ok'):
        res['error'] = 'replay: ' + str(rep.get('error'))
        return res
    if rep.get('gameover'):
        res['make'] = {'ok': True, 'immediate': True}
        res['check'] = {'ok': rep.get('winner') == p['mover']}
        return res
    c = make(a.tool, p['n'], rep['after'], a.budget, a.time_ms, a.leaves or a.js)
    res['make'] = {k: c.get(k) for k in ('ok', 'error', 'nodes', 'seconds')}
    if c.get('ok'):
        res['make']['internal'] = len(c['internal'])
        res['make']['leaves'] = len(c['leaves'])
        res['check'] = check(a.tool, c)
        if a.js:
            res['check_js'] = check_js(c)
        res['cert'] = c
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('puzzles')
    ap.add_argument('--tool', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 1)
    ap.add_argument('--budget', type=int, default=20_000_000_000)
    ap.add_argument('--time-ms', type=int, default=600_000)
    ap.add_argument('--ids', default='')
    ap.add_argument('--max-n', type=int, default=6)
    ap.add_argument('--leaves', action='store_true', help='also store leaf mates (needed by the JS checker)')
    ap.add_argument('--js', action='store_true', help='also check with tools/check-mate-cert.js')
    a = ap.parse_args()
    ps = json.load(open(a.puzzles))['puzzles']
    if a.ids:
        want = set(a.ids.split(','))
        ps = [p for p in ps if p['id'] in want]
    ps = [p for p in ps if p['n'] <= a.max_n]
    reps = after_sfns(ps)
    with open(a.out, 'a') as f, cf.ThreadPoolExecutor(a.jobs) as ex:
        futs = [ex.submit(one, a, p, r) for p, r in zip(ps, reps)]
        for fu in cf.as_completed(futs):
            r = fu.result()
            f.write(json.dumps(r) + '\n')
            f.flush()
            brief = {k: v for k, v in r.items() if k != 'cert'}
            print(json.dumps(brief), flush=True)


if __name__ == '__main__':
    main()
