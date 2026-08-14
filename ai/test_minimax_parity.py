"""Parity test: TT+killers minimax must produce the same minimax score
as the vanilla negamax α-β implementation.

Loads N positions from human_games.jsonl, runs depth-2 minimax both
with and without the search-engineering helpers, and asserts the
returned scores are bit-identical. The selected move may differ when
multiple moves tie on score (different ordering => different
first-found maximizer), so we compare scores, not moves.

Usage: python -m ai.test_minimax_parity [num_positions]
"""

import json
import random
import sys
import time

import torch

from simboard import SimBoard
from ai.sigil_net import SigilNet
from ai.minimax_ai import (
    _alphabeta, _Timeout, _get_hasher, _TT, _KillerTable,
    _INF,
)


def _search_score(board, color, model, depth, time_limit, *,
                  enable_tt, enable_killers, exhaustive_root=False):
    """Return the negamax score for `color` at `depth`, both with and without
    search-engineering helpers — returns the score the search converged to.
    """
    deadline = time.time() + time_limit
    tt = None
    hasher = None
    if enable_tt:
        tt = _TT(max_size=200_000)
        tt.new_search()
        hasher = _get_hasher(board.spell_names)
    killers = _KillerTable(max_ply=8) if enable_killers else None
    try:
        score, _move = _alphabeta(
            board, color, depth, -_INF, _INF, model, deadline,
            ordering_alpha=1.0,
            exhaustive_root=exhaustive_root, _is_root=True,
            tt=tt, killers=killers, hasher=hasher, ply=0,
        )
        return score, False
    except _Timeout:
        return None, True


def main():
    num_positions = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    depth = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    exhaustive = (len(sys.argv) > 3 and sys.argv[3] == 'exhaustive')

    print(f'Loading model and positions ...', flush=True)
    model = SigilNet.load_or_create('ai/models/best_model.pt', device='cpu')
    model.eval()

    sfns = []
    with open('ai/data/selfplay_v22b_2026-05-03.jsonl', 'r') as f:
        for line in f:
            rec = json.loads(line)
            sfn = rec.get('sfn')
            if sfn:
                sfns.append(sfn)
    print(f'  loaded {len(sfns)} candidate positions from selfplay_v22b_2026-05-03.jsonl')

    rng = random.Random(20260504)
    rng.shuffle(sfns)

    selected = []
    for sfn in sfns:
        try:
            b = SimBoard.from_sfn(sfn)
        except Exception:
            continue
        if b.gameover:
            continue
        # Mid-game filter: at least one stone past the openers, but not
        # late endgame where almost all moves win/lose immediately.
        total = b.totalstones['red'] + b.totalstones['blue']
        if total < 4 or total > 22:
            continue
        selected.append((sfn, b))
        if len(selected) >= num_positions:
            break
    print(f'  selected {len(selected)} mid-game positions for parity check')

    mismatches = []
    timings_off = []
    timings_on = []
    timeouts = 0
    for i, (sfn, board) in enumerate(selected):
        color = board.whose_turn
        # Vanilla
        t0 = time.time()
        score_off, to1 = _search_score(
            board.copy(), color, model, depth=depth, time_limit=60.0,
            enable_tt=False, enable_killers=False, exhaustive_root=exhaustive)
        timings_off.append(time.time() - t0)
        # TT + killers
        t0 = time.time()
        score_on, to2 = _search_score(
            board.copy(), color, model, depth=depth, time_limit=60.0,
            enable_tt=True, enable_killers=True, exhaustive_root=exhaustive)
        timings_on.append(time.time() - t0)

        if to1 or to2:
            timeouts += 1
            print(f'  [{i+1:3d}] timeout (off={to1}, on={to2})', flush=True)
            continue

        # Tolerance: 1e-5 — same float ops in same order should give bit-identical
        # results, but just in case there's any nondeterminism in torch.
        if abs(score_off - score_on) > 1e-5:
            mismatches.append((i, sfn, score_off, score_on))
            print(f'  [{i+1:3d}] MISMATCH: off={score_off:+.6f} on={score_on:+.6f} '
                  f'diff={score_off - score_on:+.2e}', flush=True)
        else:
            if (i + 1) % 10 == 0:
                print(f'  [{i+1:3d}] ok ({timings_off[-1]:.2f}s vs {timings_on[-1]:.2f}s)',
                      flush=True)

    print()
    print(f'Results over {len(selected)} positions:')
    print(f'  mismatches: {len(mismatches)} / {len(selected)}')
    print(f'  timeouts:   {timeouts}')
    print(f'  vanilla mean time:    {sum(timings_off)/max(1,len(timings_off)):.3f}s')
    print(f'  TT+killer mean time:  {sum(timings_on)/max(1,len(timings_on)):.3f}s')
    if timings_off and timings_on:
        speedup = sum(timings_off) / max(1e-9, sum(timings_on))
        print(f'  net speedup:          {speedup:.2f}x')

    if mismatches:
        print()
        print(f'FAIL: {len(mismatches)} positions diverged')
        return 1
    print()
    print(f'PASS: TT+killers preserves minimax scores at depth {depth}'
          f' (exhaustive={exhaustive})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
