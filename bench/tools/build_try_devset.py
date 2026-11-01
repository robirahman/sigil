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

  SIGILBENCH_TRY_PASSWORD=... python3 bench/tools/build_try_devset.py

This is a gate, not secrecy: the dev set itself is public in this repository.
"""
import argparse
import base64
import gzip
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sigilbench.common import BENCH, CANARY, REPO, bench_version, load_json  # noqa: E402
from sigilbench import prompt as P  # noqa: E402

from cryptography.hazmat.primitives import hashes  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC  # noqa: E402

OUT = os.path.join(REPO, 'docs', 'static', 'data', 'sigilbench', 'devset.enc.json')
ITERATIONS = 310_000
# The set the site offers. The page only accepts a cached payload whose `set`
# matches its own SET_ID, so bump both together.
DEV_SET = os.path.join(BENCH, 'dev', 'dev_set_v2.json')
SET_ID = 'dev_v2'

# Appended to the system prompt in the "one message" copy, for chat
# interfaces that cannot offer the submit_answer tool.
NO_TOOL_NOTE = (
    'No tools are available in this interface. Instead of calling `submit_answer`, end your reply with the '
    'turn as a JSON array of action objects in a ```json code block. Only that last block is read, and it '
    'is final.')


def payload(path=DEV_SET, set_id=SET_ID):
    dev = load_json(path)
    puzzles = []
    for p in dev['puzzles']:
        puzzles.append({
            'id': p['id'],
            'n': p['n'],
            'mover': p['mover'],
            'sfn': p['sfn'],
            'variant': p.get('variant'),
            'source_puzzle_id': p['source_puzzle_id'],
            'solution_keys': p['solution_keys'],
            'reference_solution': p['reference_solution'],
            'user_prompt': P.user_prompt(p),
        })
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


def encrypt(data: bytes, password: str):
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS).derive(password.encode())
    ct = AESGCM(key).encrypt(iv, data, None)
    b64 = lambda b: base64.b64encode(b).decode()
    return {
        'canary': CANARY,
        'format': 'sigilbench-devset-enc/1',
        'kdf': {'name': 'PBKDF2', 'hash': 'SHA-256', 'iterations': ITERATIONS, 'salt': b64(salt)},
        'cipher': {'name': 'AES-GCM', 'iv': b64(iv)},
        'compression': 'gzip',
        'ciphertext': b64(ct),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--dev-set', default=DEV_SET)
    ap.add_argument('--set-id', default=SET_ID)
    ap.add_argument('--check', action='store_true', help='decrypt the existing file with the password and report')
    a = ap.parse_args()
    pw = os.environ.get('SIGILBENCH_TRY_PASSWORD')
    if not pw:
        raise SystemExit('set SIGILBENCH_TRY_PASSWORD')
    if a.check:
        e = load_json(a.out)
        k = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=base64.b64decode(e['kdf']['salt']),
                       iterations=e['kdf']['iterations']).derive(pw.encode())
        d = json.loads(gzip.decompress(AESGCM(k).decrypt(base64.b64decode(e['cipher']['iv']),
                                                          base64.b64decode(e['ciphertext']), None)))
        print(f"ok: set {d.get('set')}, {len(d['puzzles'])} puzzles, benchmark {d['benchmark']}")
        return
    raw = json.dumps(payload(a.dev_set, a.set_id), separators=(',', ':')).encode()
    enc = encrypt(gzip.compress(raw, mtime=0), pw)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, 'w') as f:
        json.dump(enc, f, indent=1)
        f.write('\n')
    print(f'wrote {a.out}: {len(raw):,} bytes of JSON -> {os.path.getsize(a.out):,} bytes encrypted')


if __name__ == '__main__':
    main()
