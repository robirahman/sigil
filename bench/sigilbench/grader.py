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
  illegal      no legal turn reaches the replayed position
  invalid      the action list is malformed (apply.js rejected it)
  unproven     legal; neither proven nor refuted (mate-in-3+ only) -> counted
               wrong, flagged for re-check with a larger budget
  grader_error budget exhausted / enumeration cap -> counted wrong, flagged

Winning-turn puzzles (kind "win", SigilBench v3) have no proof: the answer key
is the set of positions reached by the executions of the one winning idea that
the root table found winning (answer_keys). An answer is
  correct  if its position is an answer key, or if it executes the same idea
           (bench/tools/win_puzzle.py solution_signature: placement nodes and
           spells cast) in a way the table did not search deeply and a fixed-
           depth search of its position (bench_grade "w", the table's depth and
           net, calibrated with the table's curve) gives P(mover wins) >=
           win_p -- the rule the table used to choose the answer keys;
  wrong    otherwise (another idea, or an execution of the idea that does not
           win: "failed execution").
"""
import json
import os
import subprocess
import threading

from .common import BENCH, REPO

import sys as _sys
_sys.path.insert(0, os.path.join(BENCH, 'tools'))
from win_puzzle import solution_signature, WT  # noqa: E402  (pins the nnue_mt256 calibration)


def win_prob(sfn, after, g):
    """P(mover wins) from a bench_grade "w" result (mover's side), with the
    calibration the root tables used (win_puzzle.p_of)."""
    mover = 'red' if sfn.split()[1] == 'r' else 'blue'
    if g.get('over'):
        return 1.0 if g.get('mover_wins') else 0.0
    sign = 1 if mover == 'red' else -1
    pr = WT.red_win_prob(after, g['depth'], g['stones'] * sign,
                         None if not g.get('mate') else g['mate'] * sign, bool(g.get('proven')))
    if pr is None:
        return None
    return pr if mover == 'red' else 1 - pr

DEFAULT_GRADE_BIN = os.environ.get('SIGILBENCH_GRADE_BIN') or os.path.join(
    os.environ.get('CARGO_TARGET_DIR', os.path.join(REPO, 'engine', 'target')),
    'release', 'examples', 'bench_grade')


def sfn_key(sfn):
    """puzzleSfnKey (game-board-local.js): stones, spell counters, locks,
    springlocks, plus the Providence banks when present."""
    t = sfn.split()
    pm = [x for x in t[6:] if x.startswith('pm:')]
    return ' '.join([t[0].split('/')[0]] + t[3:6] + pm)


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
        """`puzzle` needs sfn, n, solution_keys (mates) or answer_keys,
        key_idea, win_p, depth, eval (kind "win"). Returns a dict with
        `status` and `correct` plus details."""
        r = self.replay(puzzle['sfn'], actions)
        if not r.get('ok'):
            return {'status': 'invalid', 'correct': False, 'detail': r.get('error')}
        if puzzle.get('kind') == 'win':
            return self.grade_win(puzzle, actions, r['after'], r['key'])
        return self.grade_after(puzzle, r['after'], r['key'])

    def grade_win(self, puzzle, actions, after, key=None):
        key = key or sfn_key(after)
        out = {'after': after, 'key': key}
        if key in set(puzzle.get('answer_keys') or []):
            return dict(out, status='correct', correct=True, proof='answer key')
        if actions is None:      # a position without its action list (engine baseline): only the keys count
            return dict(out, status='wrong', correct=False, detail='not an answer key (no action list to judge the idea)')
        sig = solution_signature(actions)
        idea = (tuple(puzzle['key_idea'][0]), tuple(puzzle['key_idea'][1]))
        out['idea'] = [list(sig[0]), list(sig[1])]
        if sig != idea:
            return dict(out, status='wrong', correct=False, detail='another idea')
        g = self.rust.ask(f"w\t{puzzle['sfn']}\t{after}\t{puzzle.get('depth', 5)}\t{puzzle.get('eval', 'nnue_mt256')}")
        out['rust'] = g
        if g.get('verdict') == 'illegal':
            return dict(out, status='illegal', correct=False)
        if g.get('verdict') != 'eval':
            return dict(out, status='grader_error', correct=False, detail=g.get('error'))
        p = win_prob(puzzle['sfn'], after, g)
        out['p'] = p
        if p is not None and p >= puzzle.get('win_p', 0.80):
            return dict(out, status='correct', correct=True, proof='key idea, P %.3f' % p)
        return dict(out, status='wrong', correct=False, detail='failed execution of the key idea')

    def grade_after(self, puzzle, after, key=None):
        """Grade a turn given by the position it produced (the engine
        baseline hands in its after-position, not an action list). Legality
        and the proof are bench_grade's, exactly as for an action list."""
        key = key or sfn_key(after)
        out = {'after': after, 'key': key}
        if key in set(puzzle.get('solution_keys') or []):
            return dict(out, status='correct', correct=True, proof='stored solution')
        g = self.rust.ask(f"{puzzle['n']}\t{puzzle['sfn']}\t{after}")
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
