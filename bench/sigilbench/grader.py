"""Grade a submitted turn by proof.

Pipeline for one answer (an applyAITurn action list):
  1. bench/grader/apply.js replays it with the browser rules (the rules
     oracle) and returns the position it produces -- or a format error.
  2. If that position is one of the puzzle's stored solution keys (each one
     proven by the generator), the answer is correct.
  3. Otherwise the Rust grader (engine/examples/bench_grade.rs) checks that a
     LEGAL turn reaches exactly that position and proves or refutes a forced
     win within N of the mover's turns (a faster win counts).

Outcomes (`status`):
  correct      proven forced win within N
  wrong        legal turn, proven not to force a win within N
  illegal      no legal turn reaches the replayed position, or a pushed_to
               names a node that is not a push destination (apply.js)
  invalid      the action list is malformed (apply.js rejected it)
  unproven     legal; neither proven nor refuted (mate-in-3+ only): the
               exhaustive mate-in-2 pass ran out of time or hit a cap ->
               counted wrong, flagged for re-check with a larger budget
  grader_error budget exhausted / enumeration cap -> counted wrong, flagged
"""
import json
import os
import subprocess
import threading

from .common import BENCH, REPO

DEFAULT_GRADE_BIN = os.environ.get('SIGILBENCH_GRADE_BIN') or os.path.join(
    os.environ.get('CARGO_TARGET_DIR', os.path.join(REPO, 'engine', 'target')),
    'release', 'examples', 'bench_grade')


class _Proc:
    def __init__(self, argv, env=None):
        self.argv, self.env = argv, env
        self.p = None
        self.lock = threading.Lock()

    def ask(self, line):
        with self.lock:
            if self.p is None or self.p.poll() is not None:
                self.p = subprocess.Popen(self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                          text=True, bufsize=1, env=self.env)
            self.p.stdin.write(line.rstrip('\n') + '\n')
            self.p.stdin.flush()
            out = self.p.stdout.readline()
            if not out:
                raise RuntimeError(f'{self.argv[0]} exited unexpectedly')
            return json.loads(out)

    def close(self):
        if self.p and self.p.poll() is None:
            self.p.stdin.close()
            self.p.wait(timeout=10)


class Grader:
    def __init__(self, grade_bin=DEFAULT_GRADE_BIN, budget=None, time_ms=None):
        if not os.path.exists(grade_bin):
            raise SystemExit(f'bench_grade binary not found at {grade_bin}; build it with\n'
                             '  (cd engine && cargo build --release --no-default-features --example bench_grade)\n'
                             'or set SIGILBENCH_GRADE_BIN')
        env = dict(os.environ)
        if budget: env['BENCH_BUDGET'] = str(budget)
        if time_ms: env['BENCH_TIME_MS'] = str(time_ms)
        self.apply = _Proc(['node', os.path.join(BENCH, 'grader', 'apply.js')])
        self.rust = _Proc([grade_bin], env=env)

    def replay(self, sfn, actions):
        return self.apply.ask(json.dumps({'sfn': sfn, 'actions': actions}))

    def grade(self, puzzle, actions):
        """`puzzle` needs sfn, n, solution_keys. Returns a dict with `status`
        and `correct` plus details."""
        r = self.replay(puzzle['sfn'], actions)
        if not r.get('ok'):
            # An impossible push destination is a rules violation, not a format error.
            return {'status': 'illegal' if r.get('illegal') else 'invalid', 'correct': False,
                    'detail': r.get('error')}
        out = {'after': r['after'], 'key': r['key']}
        if r['key'] in set(puzzle.get('solution_keys') or []):
            return dict(out, status='correct', correct=True, proof='stored solution')
        g = self.rust.ask(f"{puzzle['n']}\t{puzzle['sfn']}\t{r['after']}")
        out['rust'] = g
        v = g.get('verdict')
        if v == 'illegal':
            return dict(out, status='illegal', correct=False)
        if v == 'mate':
            return dict(out, status='correct', correct=True,
                        proof='wins immediately' if g.get('immediate') else 'proved by bench_grade')
        if v == 'not_mate':
            return dict(out, status='wrong', correct=False)
        if v == 'unproven':
            return dict(out, status='unproven', correct=False)
        return dict(out, status='grader_error', correct=False, detail=g.get('error'))

    def close(self):
        self.apply.close()
        self.rust.close()
