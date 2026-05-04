"""Round-robin arena between Tactical Aux, Graph Trunk, and Minimax 3-ply.

Mirrors the JS deployment configs in docs/static/scripts/game-board-local.js
and engine/ai-player.js:
    - Tactical Aux : NeuralAI(v25, 100 MCTS sims, strategic_alpha=1.0)
    - Graph Trunk  : NeuralAI(v24, 100 MCTS sims, strategic_alpha=1.0)
    - Minimax 3-ply: MinimaxAI(v27, depth=3, time=12s, alpha=1.0,
                                exhaustive_root=True)

Run:
    python -m ai.arena_three_way --games 30
"""

import argparse
import os
import sys
import time
from itertools import combinations

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simboard import SimBoard
from search import _apply_turn
from selfplay import random_core_spells

from ai.config import MAX_TURNS, MODELS_DIR
from ai.sigil_net import SigilNet
from ai.sigil_net_graph import SigilNetGraph
from ai.mcts import mcts_search
from ai.minimax_ai import minimax_search


def _load(path):
    ckpt = torch.load(path, map_location='cpu', weights_only=True)
    arch = ckpt.get('arch', 'SigilNet')
    if arch == 'SigilNetGraph':
        m = SigilNetGraph.load(path)
    else:
        m = SigilNet.load(path)
    m.eval()
    return m


class Player:
    def __init__(self, name, model, kind, **kwargs):
        self.name = name
        self.model = model
        self.kind = kind  # 'mcts' or 'minimax'
        self.kwargs = kwargs

    def pick(self, board, color):
        if self.kind == 'mcts':
            best, _, _ = mcts_search(
                board, color, self.model,
                add_noise=False, temperature=None,
                **self.kwargs,
            )
            return best
        return minimax_search(board, color, self.model, **self.kwargs)


def play_game(red_player, blue_player):
    spells = random_core_spells()
    board = SimBoard(spells)
    board.setup_initial()

    turn_num = 0
    while not board.gameover and turn_num < MAX_TURNS:
        turn_num += 1
        board.turn_counter = turn_num
        color = 'red' if turn_num % 2 == 1 else 'blue'
        board.whose_turn = color
        player = red_player if color == 'red' else blue_player

        best = player.pick(board, color)
        _apply_turn(board, best, color)
        board.update()
        board.check_game_over(color)
        if not board.gameover:
            board.advance_turn()

    if board.gameover:
        return board.winner
    board.update()
    if board.totalstones['red'] > board.totalstones['blue'] + 1:
        return 'red'
    if board.totalstones['blue'] + 1 > board.totalstones['red']:
        return 'blue'
    return None


def matchup(p1, p2, n_games):
    """Play n_games between p1 and p2, alternating colors. Returns
    (p1_wins, p2_wins, draws)."""
    w1 = w2 = d = 0
    start = time.time()
    print(f"\n=== {p1.name} vs {p2.name} ({n_games} games) ===", flush=True)
    for i in range(n_games):
        red, blue = (p1, p2) if i % 2 == 0 else (p2, p1)
        winner = play_game(red, blue)
        if winner is None:
            d += 1
        elif (winner == 'red') == (red is p1):
            w1 += 1
        else:
            w2 += 1
        elapsed = time.time() - start
        print(f"  G{i+1:2d}/{n_games}: {p1.name}={w1} {p2.name}={w2} D={d} "
              f"[{elapsed:.0f}s]", flush=True)
    return w1, w2, d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=30,
                    help='Games per matchup')
    ap.add_argument('--aux-model', default=os.path.join(MODELS_DIR, 'candidate_v25.pt'))
    ap.add_argument('--graph-model', default=os.path.join(MODELS_DIR, 'candidate_v24.pt'))
    ap.add_argument('--minimax-model', default=os.path.join(MODELS_DIR, 'best_model.pt'))
    ap.add_argument('--mcts-sims', type=int, default=100)
    ap.add_argument('--strategic-alpha', type=float, default=1.0)
    ap.add_argument('--minimax-depth', type=int, default=3)
    ap.add_argument('--minimax-time', type=float, default=12.0)
    args = ap.parse_args()

    print(f"Loading models...", flush=True)
    aux = _load(args.aux_model)
    graph = _load(args.graph_model)
    mm = _load(args.minimax_model)

    p_aux = Player('Aux', aux, 'mcts',
                   num_simulations=args.mcts_sims,
                   strategic_alpha=args.strategic_alpha)
    p_graph = Player('Graph', graph, 'mcts',
                     num_simulations=args.mcts_sims,
                     strategic_alpha=args.strategic_alpha)
    p_mm = Player('Minimax', mm, 'minimax',
                  time_limit=args.minimax_time,
                  max_depth=args.minimax_depth,
                  ordering_alpha=args.strategic_alpha,
                  exhaustive_root=True)

    pairs = [(p_aux, p_graph), (p_aux, p_mm), (p_graph, p_mm)]
    results = []
    overall_start = time.time()
    for a, b in pairs:
        w1, w2, d = matchup(a, b, args.games)
        results.append((a.name, b.name, w1, w2, d))

    print("\n========= SUMMARY =========")
    for a, b, w1, w2, d in results:
        n = w1 + w2 + d
        print(f"  {a:8s} vs {b:8s}: {a}={w1} {b}={w2} draws={d}  "
              f"({a} rate={w1/n:.3f})")

    # Per-player aggregate
    agg = {}
    for a, b, w1, w2, d in results:
        agg.setdefault(a, [0, 0, 0])
        agg.setdefault(b, [0, 0, 0])
        agg[a][0] += w1
        agg[a][1] += w2
        agg[a][2] += d
        agg[b][0] += w2
        agg[b][1] += w1
        agg[b][2] += d
    print("\n  Per-player totals (across all matchups):")
    for name, (w, l, dr) in agg.items():
        n = w + l + dr
        print(f"    {name:8s}: W={w} L={l} D={dr}  ({w/n:.3f})")
    print(f"\nTotal arena time: {time.time()-overall_start:.0f}s")


if __name__ == '__main__':
    main()
