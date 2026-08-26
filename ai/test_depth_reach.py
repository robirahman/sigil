"""Depth-reach metric: under a fixed time budget, how often does
TT+killers reach a deeper iterative-deepening level than vanilla?

Runs each search to a high max_depth with a constrained time_limit;
records the completed_depth (the deepest iteration that finished
before the deadline). The TT/killers version should match or exceed
vanilla on ~all positions; the gain shows up as the *fraction* of
positions where TT+killers reaches strictly deeper.

Usage:
    python -m ai.test_depth_reach [num_positions] [time_limit] [max_depth]
"""

import json
import random
import sys
import time

import torch

from simboard import SimBoard
from ai.sigil_net import SigilNet
from ai.minimax_ai import (
    _alphabeta, _Timeout, _get_hasher, _TT, _KillerTable, _INF, _PROVEN_MIN,
)


def _completed_depth(board, color, model, time_limit, max_depth, *,
                     enable_tt, enable_killers, exhaustive=True):
    """Run iterative-deepening, return the deepest depth that completed."""
    deadline = time.time() + time_limit
    tt = None
    hasher = None
    if enable_tt:
        tt = _TT(max_size=200_000)
        tt.new_search()
        hasher = _get_hasher(board.spell_names)
    killers = _KillerTable(max_ply=max_depth + 2) if enable_killers else None
    completed = 0
    last_score = 0.0
    for depth in range(1, max_depth + 1):
        try:
            score, _move = _alphabeta(
                board, color, depth, -_INF, _INF, model, deadline,
                ordering_alpha=1.0,
                exhaustive_root=exhaustive, _is_root=True,
                tt=tt, killers=killers, hasher=hasher, ply=0,
            )
            completed = depth
            last_score = score
            if abs(score) >= _PROVEN_MIN:
                break
        except _Timeout:
            break
    return completed, last_score


def main():
    num_positions = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    time_limit = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0
    max_depth = int(sys.argv[3]) if len(sys.argv) > 3 else 5

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
        total = b.totalstones['red'] + b.totalstones['blue']
        if total < 4 or total > 22:
            continue
        selected.append(b)
        if len(selected) >= num_positions:
            break
    print(f'  selected {len(selected)} positions; '
          f'time_limit={time_limit}s, max_depth={max_depth}\n', flush=True)

    deeper = same = shallower = 0
    depths_off = []
    depths_on = []
    for i, board in enumerate(selected):
        color = board.whose_turn
        d_off, _ = _completed_depth(
            board.copy(), color, model, time_limit, max_depth,
            enable_tt=False, enable_killers=False)
        d_on, _ = _completed_depth(
            board.copy(), color, model, time_limit, max_depth,
            enable_tt=True, enable_killers=True)
        depths_off.append(d_off)
        depths_on.append(d_on)
        if d_on > d_off:
            deeper += 1
            tag = 'DEEPER'
        elif d_on < d_off:
            shallower += 1
            tag = 'SHALLOWER'
        else:
            same += 1
            tag = 'same'
        print(f'  [{i+1:3d}] off={d_off} on={d_on} {tag}', flush=True)

    print()
    print(f'Depth reach over {num_positions} positions:')
    print(f'  TT+killers DEEPER:    {deeper}')
    print(f'  same depth:           {same}')
    print(f'  TT+killers SHALLOWER: {shallower}')
    print(f'  mean depth (vanilla):     {sum(depths_off)/num_positions:.2f}')
    print(f'  mean depth (TT+killers):  {sum(depths_on)/num_positions:.2f}')


if __name__ == '__main__':
    sys.exit(main())
