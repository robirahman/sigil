#!/usr/bin/env python3
"""Re-score runs made with the old one-reminder protocol under the current one
(one response per puzzle), from their transcripts -- no API calls.

    python3 bench/tools/rescore_no_reminder.py <run_dir> [...]   # writes <run_dir>_noreminder/

A puzzle whose transcript holds more than one model response was answered only
after the reminder, so its first response ended without a submit_answer call:
under the current protocol that is `no_answer`. Every other record is kept as
graded. Usage for a re-scored puzzle is set to the output cap when the first
response stopped at it (the exact output count), with input left as recorded
(an overstatement), and flagged `usage_estimated`.
"""
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import CANARY  # noqa: E402
from sigilbench.report import summarize  # noqa: E402


def responses(t):
    return [m for m in (t or []) if m.get('role') in ('assistant', 'model')]


def first_stop(m):
    for k in ('stop_reason', 'status', 'finish_reason'):
        if k in m:
            return m[k]
    try:
        return m['response']['candidates'][0]['finish_reason']
    except Exception:  # noqa: BLE001
        return None


def main():
    for src in sys.argv[1:]:
        src = src.rstrip('/')
        dst = src + '_noreminder'
        os.makedirs(dst, exist_ok=True)
        meta = json.load(open(os.path.join(src, 'run.json')))
        st = meta.get('settings') or {}
        cap = st.get('max_tokens') or st.get('max_output_tokens')
        meta['rescored'] = {'from': os.path.basename(src), 'protocol': 'one response per puzzle (no reminder)',
                            'tool': 'bench/tools/rescore_no_reminder.py'}
        json.dump(meta, open(os.path.join(dst, 'run.json'), 'w'), indent=1)
        if os.path.isdir(os.path.join(src, 'transcripts')) and not os.path.isdir(os.path.join(dst, 'transcripts')):
            shutil.copytree(os.path.join(src, 'transcripts'), os.path.join(dst, 'transcripts'))
        changed = 0
        with open(os.path.join(src, 'results.jsonl')) as f, open(os.path.join(dst, 'results.jsonl'), 'w') as out:
            out.write(json.dumps({'canary': CANARY}) + '\n')
            for line in f:
                r = json.loads(line)
                if 'puzzle_id' not in r:
                    continue
                tp = os.path.join(src, 'transcripts', r['puzzle_id'] + '.json')
                t = json.load(open(tp)).get('transcript') if os.path.exists(tp) else None
                resp = responses(t)
                if len(resp) > 1:
                    stop = first_stop(resp[0])
                    u = dict(r.get('usage') or {})
                    if cap and str(stop).lower() in ('max_tokens', 'incomplete', 'length'):
                        u['output_tokens'] = cap
                    r = {'puzzle_id': r['puzzle_id'], 'n': r['n'], 'status': 'no_answer', 'correct': False,
                         'answer': None, 'raw_answer': None, 'stop': f'no tool call ({stop})', 'usage': u,
                         'usage_estimated': True, 'seconds': r.get('seconds'),
                         'grade': {'rescored_from': r['status'], 'original_correct': r['correct'],
                                   'reason': 'answered only after the old reminder'}}
                    changed += 1
                out.write(json.dumps(r) + '\n')
        s = summarize(dst)
        s['canary'] = CANARY
        json.dump(s, open(os.path.join(dst, 'summary.json'), 'w'), indent=1)
        print(dst, 'records changed:', changed, 'accuracy', s['overall'])


if __name__ == '__main__':
    main()
