"""Run a model on SigilBench puzzles and grade the answers.

    cd bench && python3 -m sigilbench.run --provider anthropic --model claude-opus-5-5 --effort high --limit 5
    cd bench && python3 -m sigilbench.run --provider oracle      # pipeline self-test, expect 100%
    cd bench && python3 -m sigilbench.run --provider random      # random-legal baseline

Writes bench/runs/<run_id>/: run.json (settings, versions), results.jsonl (one
record per graded puzzle; re-runs append and the last record counts),
transcripts/<puzzle>.json (full exchange), summary.json. Every file carries
the SigilBench canary string. --resume skips puzzles already graded in that
directory.
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback

from .common import APPROVED, BENCH, CANARY, DEV_SET, REPO, bench_version, load_json
from .grader import Grader
from .prompt import system_prompt, user_prompt
from .providers import OFFLINE, PROVIDERS
from .report import summarize


def approval(provider, model):
    """The matching entry of bench/providers_approved.json, or None."""
    if not os.path.exists(APPROVED):
        return None
    for e in load_json(APPROVED).get('approved', []):
        if e.get('provider') == provider and re.fullmatch(e.get('model_regex', '.*'), model) \
                and e.get('zero_data_retention') and e.get('no_training'):
            return e
    return None


def git_commit():
    try:
        return subprocess.run(['git', '-C', REPO, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    except Exception:
        return None


def load_puzzles(a):
    if a.split == 'dev':
        doc = load_json(a.puzzles or DEV_SET)
        return doc['puzzles'], None
    if not a.puzzles:
        sys.exit('--split test needs --puzzles <local copy of the private test set>')
    raw = open(a.puzzles, 'rb').read()
    digest = hashlib.sha256(raw).hexdigest()
    want = a.expect_sha256
    if not want and os.path.exists(os.path.join(BENCH, 'TEST_SET_SHA256')):
        want = open(os.path.join(BENCH, 'TEST_SET_SHA256')).read().split()[0]
    if not want:
        sys.exit('no published test-set hash to check against (bench/TEST_SET_SHA256 or --expect-sha256)')
    if digest != want:
        sys.exit(f'test set SHA-256 {digest} does not match the published {want}; refusing to run')
    return json.loads(raw)['puzzles'], digest


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--provider', required=True, choices=sorted(PROVIDERS))
    ap.add_argument('--model', default=None)
    ap.add_argument('--effort', default=None, help='reasoning effort (anthropic/openai/xai; gemini thinking_level)')
    ap.add_argument('--max-tokens', type=int, default=None, help='per-response output cap')
    ap.add_argument('--split', default='dev', choices=['dev', 'test'])
    ap.add_argument('--puzzles', default=None, help='puzzle file (default: bench/dev/dev_set.json)')
    ap.add_argument('--expect-sha256', default=None)
    ap.add_argument('--ids', default=None, help='comma-separated puzzle ids')
    ap.add_argument('--n', default=None, help='only these mate depths, e.g. 1,2')
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--concurrency', type=int, default=4)
    ap.add_argument('--out', default=None, help='run directory (default bench/runs/<timestamp>_<provider>_<model>)')
    ap.add_argument('--resume', action='store_true')
    ap.add_argument('--price-in', type=float, default=None, help='USD per million input tokens (for the cost cap)')
    ap.add_argument('--price-out', type=float, default=None, help='USD per million output tokens')
    ap.add_argument('--max-cost', type=float, default=None, help='stop starting new puzzles past this USD estimate')
    ap.add_argument('--seed', type=int, default=0, help='random baseline seed')
    a = ap.parse_args()

    cls = PROVIDERS[a.provider]
    model = a.model or {'oracle': 'reference', 'random': 'uniform'}.get(a.provider)
    if not model:
        sys.exit('--model is required for API providers')
    appr = None
    if a.provider not in OFFLINE:
        appr = approval(a.provider, model)
        if not appr:
            msg = (f'{a.provider}/{model} is not in bench/providers_approved.json with zero_data_retention '
                   f'and no_training confirmed.')
            if a.split == 'test':
                sys.exit(msg + ' The private test set is only run on approved accounts.')
            print('WARNING: ' + msg + ' Allowed for the public dev set only.', file=sys.stderr)
    if a.max_cost is not None and (a.price_in is None or a.price_out is None):
        sys.exit('--max-cost needs --price-in and --price-out')

    puzzles, digest = load_puzzles(a)
    if a.ids:
        want = set(a.ids.split(','))
        puzzles = [p for p in puzzles if p['id'] in want]
    if a.n:
        ns = {int(x) for x in a.n.split(',')}
        puzzles = [p for p in puzzles if p['n'] in ns]
    if a.limit:
        puzzles = puzzles[:a.limit]

    kw = {'model': model}
    if a.effort is not None: kw['effort'] = a.effort
    if a.max_tokens is not None: kw['max_tokens'] = a.max_tokens
    if a.provider == 'random': kw['seed'] = a.seed
    prov = cls(**kw)

    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    run_dir = a.out or os.path.join(BENCH, 'runs', f"{stamp}_{a.provider}_{re.sub(r'[^A-Za-z0-9.-]', '_', model)}")
    os.makedirs(os.path.join(run_dir, 'transcripts'), exist_ok=True)
    sysp = system_prompt()
    meta_path = os.path.join(run_dir, 'run.json')
    if not (a.resume and os.path.exists(meta_path)):
        json.dump({
            'canary': CANARY, 'benchmark': bench_version(), 'split': a.split, 'test_set_sha256': digest,
            'provider': a.provider, 'model': model, 'settings': getattr(prov, 'settings', {}),
            'approval': appr, 'started': stamp, 'git_commit': git_commit(),
            'system_prompt_sha256': hashlib.sha256(sysp.encode()).hexdigest(),
            'price_in_per_mtok': a.price_in, 'price_out_per_mtok': a.price_out,
            'n_puzzles': len(puzzles),
        }, open(meta_path, 'w'), indent=1)
    res_path = os.path.join(run_dir, 'results.jsonl')
    done = set()
    if a.resume and os.path.exists(res_path):
        for line in open(res_path):
            r = json.loads(line)
            if r.get('puzzle_id') and r.get('status') != 'api_error':
                done.add(r['puzzle_id'])
    todo = [p for p in puzzles if p['id'] not in done]
    if not os.path.exists(res_path):
        with open(res_path, 'w') as f:
            f.write(json.dumps({'canary': CANARY}) + '\n')
    print(f'{len(todo)} puzzles to run ({len(done)} already graded) -> {run_dir}', file=sys.stderr)

    grader = Grader()
    wlock = threading.Lock()
    spent = {'in': 0, 'out': 0}
    stop = threading.Event()

    def cost():
        if a.price_in is None:
            return 0.0
        return spent['in'] / 1e6 * a.price_in + spent['out'] / 1e6 * a.price_out

    def one(p):
        if stop.is_set():
            return None
        user = user_prompt(p)
        t0 = time.time()
        try:
            if a.provider in OFFLINE:
                ans = prov.solve(sysp, user, puzzle=p)
            else:
                ans = prov.solve(sysp, user)
            err = None
        except Exception as e:  # noqa: BLE001 -- record and move on
            ans, err = {'actions': None, 'stop': 'api_error', 'usage': {}, 'transcript': []}, \
                f'{type(e).__name__}: {e}'
            traceback.print_exc()
        secs = round(time.time() - t0, 1)
        if err:
            g = {'status': 'api_error', 'correct': False, 'detail': err}
        elif ans['actions'] is None:
            g = {'status': 'no_answer', 'correct': False, 'detail': ans.get('stop')}
        else:
            g = grader.grade(p, ans['actions'])
        rec = {'puzzle_id': p['id'], 'n': p['n'], 'status': g['status'], 'correct': g['correct'],
               'answer': ans.get('actions'), 'raw_answer': ans.get('raw_answer'),
               'stop': ans.get('stop'), 'usage': ans.get('usage'), 'seconds': secs,
               'grade': {k: v for k, v in g.items() if k not in ('status', 'correct')}}
        with wlock:
            u = ans.get('usage') or {}
            spent['in'] += u.get('input_tokens', 0)
            spent['out'] += u.get('output_tokens', 0)
            with open(res_path, 'a') as f:
                f.write(json.dumps(rec) + '\n')
            with open(os.path.join(run_dir, 'transcripts', f"{p['id']}.json"), 'w') as f:
                json.dump({'canary': CANARY, 'puzzle_id': p['id'], 'model': model,
                           'system_prompt_sha256': hashlib.sha256(sysp.encode()).hexdigest(),
                           'user_prompt': user, 'transcript': ans.get('transcript'), 'result': rec}, f, indent=1)
            print(f"{p['id']} N={p['n']} {g['status']:<12} {secs:>7}s  cost~${cost():.2f}", file=sys.stderr)
            if a.max_cost is not None and cost() >= a.max_cost:
                if not stop.is_set():
                    print(f'cost cap ${a.max_cost} reached; not starting new puzzles', file=sys.stderr)
                stop.set()
        return rec

    try:
        with cf.ThreadPoolExecutor(max_workers=max(1, a.concurrency)) as ex:
            list(ex.map(one, todo))
    finally:
        grader.close()
    s = summarize(run_dir)
    s['canary'] = CANARY
    json.dump(s, open(os.path.join(run_dir, 'summary.json'), 'w'), indent=1)
    print(json.dumps({k: s[k] for k in ('model', 'overall', 'by_n', 'status_counts', 'tokens')}, indent=1))


if __name__ == '__main__':
    main()
