#!/usr/bin/env python3
"""Build the password-protected dev set for the "Try the dev set" panel of
docs/sigilbench.html (and the bench mode of docs/puzzles.html).

The payload is the dev set plus the exact prompts the harness sends
(sigilbench.prompt): the system prompt, the submit_answer tool and each
puzzle's user prompt. It is gzipped, then encrypted with AES-256-GCM under a
key derived from the password by PBKDF2-HMAC-SHA256, so the site serves no
plain-text copy for crawlers to collect. The page decrypts it with WebCrypto.

The password is read from $SIGILBENCH_TRY_PASSWORD (never pass it on the
command line, never commit it). Re-run this script to change the password or
after editing the dev set or the prompt files:

  SIGILBENCH_TRY_PASSWORD=... python3 bench/tools/build_try_devset.py --set v3 \\
      [--children-bin <target>/release/examples/rules_children]

The site offers one set at a time (the page opens dev_v2 or dev_v3, whichever
the file holds). Dev set v3 has two kinds of puzzle:
  * mates (kind "mate", category m1..m5): graded by the stored solution keys,
    a win on the spot, or the in-browser engine;
  * winning turns (kind "win"): graded by lookup alone -- answer_keys is
    correct, failed_keys is "right idea, wrong execution", anything else is
    "wrong idea" (bench/sigilbench/grader.py grade_win with complete keys,
    bench/tools/complete_keys.py). Both lists must be in the dev set.
Every puzzle needs a reference turn as an action list ("Show solution" rings
and describes it). A puzzle that has only `reference_after` (a position), or
a winning-turn puzzle with no reference at all, gets one from
engine/examples/rules_children (--children-bin; build it with
`cargo build --release --no-default-features --example rules_children`): the
first turn whose position is the reference position, else one of the answer
keys. Every reference is replayed with the browser rules
(bench/grader/apply.js) and must reach a solution / answer key.

This is a gate, not secrecy: the dev set itself is public in this repository.
"""
import argparse
import base64
import gzip
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import BENCH, CANARY, REPO, bench_version, load_json  # noqa: E402
from sigilbench import prompt as P  # noqa: E402

from cryptography.hazmat.primitives import hashes  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC  # noqa: E402

OUT = os.path.join(REPO, 'docs', 'static', 'data', 'sigilbench', 'devset.enc.json')
ITERATIONS = 310_000
# The sets the site can offer. The page accepts a payload whose `set` is one
# of its SET_IDS (sigilbench.html, puzzles.html BENCH_SETS); add a new set to
# both. Full solution lines (stored defences to the mate) for puzzles the
# Puzzles set does not hold: v2's mined mate-in-4s (bench/tools/
# build_m4_lines.py); v3 may have its own. Shown by "Show solution" in bench mode.
SETS = {
    'v2': dict(dev_set=os.path.join(BENCH, 'dev', 'dev_set_v2.json'), set_id='dev_v2',
               lines=os.path.join(BENCH, 'dev', 'dev_set_v2_lines.json')),
    'v3': dict(dev_set=os.path.join(BENCH, 'dev', 'dev_set_v3.json'), set_id='dev_v3',
               lines=os.path.join(BENCH, 'dev', 'dev_set_v3_lines.json')),
}
DEFAULT_SET = 'v3'
# Back-compat names (dev set v2).
DEV_SET = SETS['v2']['dev_set']
LINES = SETS['v2']['lines']
SET_ID = SETS['v2']['set_id']
APPLY = os.path.join(BENCH, 'grader', 'apply.js')

# Appended to the system prompt in the "one message" copy, for chat
# interfaces that cannot offer the submit_answer tool.
NO_TOOL_NOTE = (
    'No tools are available in this interface. Instead of calling `submit_answer`, end your reply with the '
    'turn as a JSON array of action objects in a ```json code block. Only that last block is read, and it '
    'is final.')


def sfn_key(sfn):
    """puzzleSfnKey (game-board-local.js) / bench/sigilbench/grader.py sfn_key."""
    t = sfn.split()
    pm = [x for x in t[6:] if x.startswith('pm:')]
    return ' '.join([t[0].split('/')[0]] + t[3:6] + pm)


def kind_of(p):
    return p.get('kind') or 'mate'


def target_keys(p):
    """Positions a reference turn may reach: the stored reference position,
    else any answer key (winning turns) or solution key (mates)."""
    if p.get('reference_after'):
        return [sfn_key(p['reference_after'])]
    return list(p.get('answer_keys') if kind_of(p) == 'win' else p.get('solution_keys') or [])


def accepted_keys(p):
    return set(p.get('answer_keys') if kind_of(p) == 'win' else p.get('solution_keys') or [])


def replay(jobs):
    """apply.js on [(sfn, actions)] -> [{ok, after, key, ...}]."""
    if not jobs:
        return []
    inp = ''.join(json.dumps({'sfn': s, 'actions': a}) + '\n' for s, a in jobs)
    out = subprocess.run(['node', APPLY], input=inp, capture_output=True, text=True, check=True).stdout
    return [json.loads(x) for x in out.splitlines()]


def derive_references(puzzles, children_bin):
    """{id: actions} for puzzles with no reference action list: the first
    rules_children turn that reaches one of target_keys."""
    if not puzzles:
        return {}
    inp = ''.join(p['sfn'] + '\n' for p in puzzles)
    out = subprocess.run([children_bin], input=inp, capture_output=True, text=True, check=True).stdout
    rows = [json.loads(x) for x in out.splitlines() if x.strip()]
    if len(rows) != len(puzzles):
        sys.exit(f'{children_bin}: {len(rows)} results for {len(puzzles)} positions')
    refs = {}
    for p, r in zip(puzzles, rows):
        want = set(target_keys(p))
        hit = next((c for c in r.get('children') or [] if sfn_key(c['sfn']) in want), None)
        if hit is None:
            sys.exit(f"{p['id']}: no turn from rules_children reaches its reference or answer keys"
                     + (' (enumeration truncated)' if r.get('truncated') else ''))
        refs[p['id']] = hit['actions']
    return refs


def references(puzzles, children_bin=None):
    """{id: (actions, key)}: each puzzle's reference turn, checked with the
    browser rules to reach a key the page accepts."""
    refs = {p['id']: p['reference_solution'] for p in puzzles if p.get('reference_solution')}
    need = [p for p in puzzles if p['id'] not in refs]
    if need and not children_bin:
        sys.exit(f"{len(need)} puzzles have no reference action list ({', '.join(p['id'] for p in need[:5])}"
                 f"{', ...' if len(need) > 5 else ''}): give --children-bin (engine/examples/rules_children)")
    refs.update(derive_references(need, children_bin))
    out = {}
    for p, r in zip(puzzles, replay([(p['sfn'], refs[p['id']]) for p in puzzles])):
        if not r.get('ok'):
            sys.exit(f"{p['id']}: the reference turn does not replay: {r.get('error')}")
        ok = accepted_keys(p)
        if r['key'] not in ok and not (kind_of(p) == 'mate' and r.get('gameover') and r.get('winner') == p['mover']):
            sys.exit(f"{p['id']}: the reference turn reaches {r['key']}, not a "
                     + ('answer key' if kind_of(p) == 'win' else 'solution key'))
        out[p['id']] = (refs[p['id']], r['key'])
    return out


def payload(path=DEV_SET, set_id=SET_ID, lines_path=LINES, children_bin=None):
    dev = load_json(path)
    lines = load_json(lines_path)['lines'] if lines_path and os.path.exists(lines_path) else {}
    for p in dev['puzzles']:
        if kind_of(p) == 'win':
            missing = [k for k in ('answer_keys', 'failed_keys', 'key_idea_text') if p.get(k) is None]
            if missing or not p['answer_keys']:
                sys.exit(f"{p['id']}: a winning-turn puzzle needs answer_keys (non-empty), failed_keys and "
                         f"key_idea_text (complete keys: bench/tools/complete_keys.py); missing {missing or ['answer_keys']}")
        elif kind_of(p) != 'mate':
            sys.exit(f"{p['id']}: unknown kind {p.get('kind')!r}")
    refs = references(dev['puzzles'], children_bin)
    puzzles = []
    for p in dev['puzzles']:
        kind = kind_of(p)
        ref, ref_key = refs[p['id']]
        e = {
            'id': p['id'],
            'kind': kind,
            'category': p.get('category') or ('win' if kind == 'win' else f"m{p['n']}"),
            'n': p['n'],
            'mover': p['mover'],
            'sfn': p['sfn'],
            'variant': p.get('variant'),
        }
        if p.get('source_puzzle_id'):
            e['source_puzzle_id'] = p['source_puzzle_id']
        if kind == 'win':
            # Complete keys: grading is a lookup (bench/sigilbench/grader.py grade_win).
            e.update(answer_keys=p['answer_keys'], failed_keys=p['failed_keys'],
                     key_idea_text=p['key_idea_text'], execution_matters=bool(p.get('execution_matters')))
        else:
            e['solution_keys'] = p['solution_keys']
        e.update(reference_solution=ref, reference_key=ref_key, user_prompt=P.user_prompt(p))
        if p['id'] in lines:
            e['solution_line'] = lines[p['id']]
        puzzles.append(e)
    return {
        'canary': CANARY,
        'set': set_id,
        'benchmark': bench_version().get('version'),
        'name': dev.get('name'),
        'counts': dev.get('counts'),
        'system_prompt': P.system_prompt(),
        'no_tool_note': NO_TOOL_NOTE,
        'tool': {'name': P.TOOL_NAME, 'description': P.TOOL_DESCRIPTION, 'input_schema': P.TOOL_SCHEMA},
        'puzzles': puzzles,
    }


def encrypt(data: bytes, password: str, set_id=None):
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS).derive(password.encode())
    ct = AESGCM(key).encrypt(iv, data, None)
    b64 = lambda b: base64.b64encode(b).decode()
    out = {
        'canary': CANARY,
        'format': 'sigilbench-devset-enc/1',
    }
    if set_id:
        # In clear, so the page can tell a stale cached file from the current one
        # before decrypting (the set's name is not secret).
        out['set'] = set_id
    out.update({
        'kdf': {'name': 'PBKDF2', 'hash': 'SHA-256', 'iterations': ITERATIONS, 'salt': b64(salt)},
        'cipher': {'name': 'AES-GCM', 'iv': b64(iv)},
        'compression': 'gzip',
        'ciphertext': b64(ct),
    })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--set', choices=sorted(SETS), default=DEFAULT_SET,
                    help=f'dev set: the defaults for --dev-set, --set-id and --lines (default {DEFAULT_SET})')
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--dev-set', default=None)
    ap.add_argument('--set-id', default=None)
    ap.add_argument('--lines', default=None, help='solution lines file (empty string: none)')
    ap.add_argument('--children-bin', default=None,
                    help='engine/examples/rules_children, to find a reference turn for puzzles that have none')
    ap.add_argument('--check', action='store_true', help='decrypt the existing file with the password and report')
    a = ap.parse_args()
    for k in ('dev_set', 'set_id', 'lines'):
        if getattr(a, k) is None:
            setattr(a, k, SETS[a.set][k])
    pw = os.environ.get('SIGILBENCH_TRY_PASSWORD')
    if not pw:
        raise SystemExit('set SIGILBENCH_TRY_PASSWORD')
    if a.check:
        e = load_json(a.out)
        k = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=base64.b64decode(e['kdf']['salt']),
                       iterations=e['kdf']['iterations']).derive(pw.encode())
        d = json.loads(gzip.decompress(AESGCM(k).decrypt(base64.b64decode(e['cipher']['iv']),
                                                          base64.b64decode(e['ciphertext']), None)))
        kinds = {}
        for p in d['puzzles']:
            kinds[p.get('category') or f"m{p['n']}"] = kinds.get(p.get('category') or f"m{p['n']}", 0) + 1
        print(f"ok: set {d.get('set')} (envelope {e.get('set')}), {len(d['puzzles'])} puzzles {kinds}, "
              f"benchmark {d['benchmark']}")
        return
    if not os.path.exists(a.dev_set):
        raise SystemExit(f'{a.dev_set} not found' + (' (dev set v3 is not built yet; --set v2 rebuilds v2)'
                                                     if a.set == 'v3' and a.dev_set == SETS['v3']['dev_set'] else ''))
    raw = json.dumps(payload(a.dev_set, a.set_id, a.lines, a.children_bin), separators=(',', ':')).encode()
    enc = encrypt(gzip.compress(raw, mtime=0), pw, a.set_id)
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    with open(a.out, 'w') as f:
        json.dump(enc, f, indent=1)
        f.write('\n')
    print(f'wrote {a.out}: set {a.set_id}, {len(raw):,} bytes of JSON -> {os.path.getsize(a.out):,} bytes encrypted')


if __name__ == '__main__':
    main()
