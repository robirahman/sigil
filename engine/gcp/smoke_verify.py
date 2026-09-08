"""The verification the plan requires before any of this can merge.

  * parity_primitives.py -- 4,000 positions, differential against simboard.py
  * run_emit_gate.py     -- 0 mismatches, differential against the BROWSER
                            engine under node

The emit gate matters more than usual for this change. `emit_actions` now
reports `kept` from the board after applying the chosen keep, and the client
asserts the SFN it is handed; if `kept` and `keep` ever disagreed, the WASM
client would reject its own engine's move and corrupt the recorded game
history, which feeds game review, SGN export and import_human_games.py.

`legal_draw` also changed on this branch (seeds 2n and 2n+1 used to share a
draw), so both harnesses see different positions than before. They are
differential tests against a live reference rather than stored expectations,
so that is fine -- but it is worth stating, because a stored-expectation test
would have needed regenerating and silently "passing" instead.
"""
import os, shutil, subprocess, sys

REPO = os.environ.get('SIGIL_REPO', '/opt/sigil/repo')
WORK = os.path.dirname(REPO)
PY_EXE = sys.executable

# The parity harnesses read `os.environ['SCRATCH']` and expect a `ref/` tree
# beside it holding the REFERENCE implementations: the browser engine under
# docs/static/scripts, plus notation.py, simboard.py and ai/config.py.
# `runner.sh` builds that tree; `buildtest.sh` never did, so all three
# harnesses died on a KeyError or ModuleNotFoundError and the emit gate
# reported an action census while never running its node comparison at all --
# an "EXIT=1" that looked like mismatches and was nothing of the kind.
REF = os.path.join(WORK, 'ref')


def setup_ref():
    os.makedirs(os.path.join(REF, 'ai'), exist_ok=True)
    os.makedirs(os.path.join(REF, 'docs', 'static', 'scripts'), exist_ok=True)
    src_engine = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')
    dst_engine = os.path.join(REF, 'docs', 'static', 'scripts', 'engine')
    if os.path.isdir(src_engine) and not os.path.isdir(dst_engine):
        shutil.copytree(src_engine, dst_engine)
    for f in ('notation.py', 'simboard.py'):
        src = os.path.join(REPO, f)
        if os.path.isfile(src):
            shutil.copy(src, os.path.join(REF, f))
        else:
            print(f"  WARNING: {f} missing from the checkout -- parity will fail")
    src_cfg = os.path.join(REPO, 'ai', 'config.py')
    if os.path.isfile(src_cfg):
        shutil.copy(src_cfg, os.path.join(REF, 'ai', 'config.py'))
    print(f"ref tree at {REF}: {sorted(os.listdir(REF))}")


ENV = dict(os.environ)
ENV['SCRATCH'] = WORK
# `python engine/harness/x.py` puts engine/harness on sys.path, not the repo
# root, so `from ai.config import ...` cannot resolve without this.
ENV['PYTHONPATH'] = REPO + os.pathsep + ENV.get('PYTHONPATH', '')


def run(label, args, cwd=REPO, timeout=1800):
    print(f"\n=== {label} ===", flush=True)
    print(f"    {' '.join(args)}", flush=True)
    try:
        p = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout, env=ENV)
    except subprocess.TimeoutExpired:
        print(f"{label}: TIMEOUT after {timeout}s")
        return 1
    out = (p.stdout or '') + (p.stderr or '')
    tail = out.strip().splitlines()
    for ln in tail[-40:]:
        print(f"    {ln}")
    print(f"{label} EXIT={p.returncode}")
    return p.returncode


setup_ref()

rc = 0
rc |= run('parity_primitives',
          [PY_EXE, 'engine/harness/parity_primitives.py'])
rc |= run('parity_resolvers',
          [PY_EXE, 'engine/harness/parity_resolvers.py'])
# 400 positions x 8 first moves, well above the 60x6 default, because the
# keep dimension multiplies what there is to cover.
rc |= run('emit_gate',
          [PY_EXE, 'engine/harness/run_emit_gate.py', '400', '8'])
print(f"\nVERIFY_TOTAL_EXIT={rc}")
