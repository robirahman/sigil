#!/usr/bin/env python3
"""Re-check stored mate certificates with the current checkers.

Input: JSON lists or JSONL files of records holding a certificate under 'cert'
(mine_mate_k.py work records). Every record
gets the Rust check (cert_tool check); records named by --js-ids, plus a
deterministic --js-sample of the rest, also get the JS check
(tools/check-mate-cert.js). Results are written as they complete.

    python3 bench/tools/recheck_certs.py m4_work*.jsonl --tool $BIN/cert_tool \\
        --out recheck.jsonl --workers 64 --js-failed --js-sample 0.05
"""
import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import subprocess

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def load(path):
    txt = open(path).read()
    try:
        d = json.loads(txt)
        return d if isinstance(d, list) else d.get('records') or d.get('puzzles') or []
    except json.JSONDecodeError:
        return [json.loads(line) for line in txt.splitlines() if line.strip()]


def rust(tool, cert):
    fields = [str(cert['n']), cert['after']]
    for e in cert['internal'] + cert.get('leaves', []):
        fields += [e['at'], e['to']]
    p = subprocess.run([tool, 'check'], input='\t'.join(fields) + '\n', capture_output=True, text=True)
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {'ok': False, 'error': (p.stderr or 'no output')[-300:]}


def js(cert):
    p = subprocess.run(['node', '--max-old-space-size=4096', os.path.join(REPO, 'tools', 'check-mate-cert.js')],
                       input=json.dumps(cert) + '\n', capture_output=True, text=True)
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {'ok': False, 'error': (p.stderr or 'no output')[-300:]}


def sampled(rid, fraction):
    return int(hashlib.sha256(rid.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF < fraction


def one(a, r, do_js):
    out = {'id': r['id'], 'old_check': (r.get('check') or {}).get('ok'), 'check': rust(a.tool, r['cert'])}
    if do_js:
        out['check_js'] = js(r['cert'])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('records', nargs='+')
    ap.add_argument('--tool', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--workers', type=int, default=os.cpu_count() or 1)
    ap.add_argument('--js-ids', default='')
    ap.add_argument('--js-sample', type=float, default=0.0)
    ap.add_argument('--js-failed', action='store_true', help='also JS-check every record whose stored check failed')
    a = ap.parse_args()
    recs = [r for p in a.records for r in load(p) if (r.get('cert') or {}).get('ok')]
    js_ids = set(x for x in a.js_ids.split(',') if x)
    if a.js_failed:
        js_ids |= {r['id'] for r in recs if (r.get('check') or {}).get('ok') is False}
    done = set()
    if os.path.exists(a.out):
        done = {json.loads(line)['id'] for line in open(a.out) if line.strip()}
    todo = [r for r in recs if r['id'] not in done]
    # JS checks are the slow ones: start them first.
    todo.sort(key=lambda r: not (r['id'] in js_ids or sampled(r['id'], a.js_sample)))
    print(f'{len(recs)} certificates, {len(todo)} to check', flush=True)
    with open(a.out, 'a') as f, cf.ThreadPoolExecutor(a.workers) as ex:
        futs = [ex.submit(one, a, r, r['id'] in js_ids or sampled(r['id'], a.js_sample)) for r in todo]
        for fu in cf.as_completed(futs):
            res = fu.result()
            f.write(json.dumps(res) + '\n')
            f.flush()
            print(res['id'], res['old_check'], res['check'].get('ok'), (res.get('check_js') or {}).get('ok'),
                  (res['check'].get('error') or '')[:80], flush=True)


if __name__ == '__main__':
    main()
