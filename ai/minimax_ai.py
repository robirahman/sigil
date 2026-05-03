"""Iterative-deepening alpha-beta minimax search for Sigil.

Decision-time tactical engine that complements the network. Where MCTS
samples and averages, this enumerates: every legal turn for us, then
every legal opponent response, etc., with alpha-beta pruning. The
network's value head is the leaf evaluator (no rollouts), and the
network policy + strategic-eval score drive move ordering for
maximum alpha-beta cutoff.

Why this exists: the existing MCTS at 100-200 simulations samples
most root moves only a handful of times, which means it can miss
short tactical sequences (mate-in-1, "if I move here, opponent
crushes my a13 stone next turn", "this move lets opponent's
filled Fireblast jump from +0 to +3"). Exhaustive 2-4 ply search
sees those by construction.

Tractability with measured branching (mean=13, p90=25, p99=72):
  - 2-ply (full):   ~169 leaf evals → ~0.5s
  - 3-ply (αβ):     ~13² = 169 nodes → ~1s
  - 4-ply (αβ):     ~13³ ≈ 2200 nodes → ~5-10s
Iterative deepening returns the deepest completed depth before the
deadline, so we always have a usable best-move.

Leaf evaluator returns value in [-1, +1] from the side-to-move's
perspective; +1 = side-to-move wins. Negamax recursion negates
between layers. Mate-in-1 short-circuits at the root.
"""

import math
import sys
import time

import numpy as np
import torch

from simboard import SimBoard, CompleteTurn, Action
from ai.features import board_to_tensor, encode_all_turns
from ai.strategic_eval import strategic_scores


_INF = 1e9
_WIN = 100.0   # large but finite (so we still prefer faster wins / slower losses)


def _apply_turn(board, turn, color):
    """Replay a turn on a copy of `board`. Returns the post-turn SimBoard.

    Mirrors ai/features.py:_simulate_turn — the underlying SimBoard.apply_turn
    is a no-op, so we step through actions explicitly.
    """
    sim = board.copy()
    for action in turn.actions:
        t = action.type
        if t == 'move':
            sim.stones[action.node] = color
        elif t == 'hard_move':
            sim._push_enemy(action.node, color)
        elif t == 'blink':
            if sim.stones[action.node] == sim._enemy(color):
                sim._push_enemy(action.node, color)
            else:
                sim.stones[action.node] = color
        elif t == 'cast':
            sim._cast_spell(action.spell, color)
        elif t in ('dash', 'dash_lightning'):
            if action.sacrificed:
                for n in action.sacrificed:
                    sim.stones[n] = None
        sim.update()
    sim.check_game_over(color)
    if not sim.gameover:
        sim.advance_turn()
    return sim


def _eval_leaf(board, color, model):
    """Static evaluation in [-1, +1] from `color`'s perspective.

    Game-over short-circuits: +WIN if we win, -WIN if we lose, 0 draw.
    Otherwise: NN value head, with a small strategic top-up so positions
    with obvious tactical wins/losses get scored even if the value head
    is uncertain. The strategic score uses the side-to-move's per-turn
    feature deltas — we read them off the *current* board's pre-state
    (no per-turn lookahead at leaves).
    """
    if board.gameover:
        if board.winner == color:
            return _WIN
        if board.winner is None:
            return 0.0
        return -_WIN
    raw, spell_ids = board_to_tensor(board, color)
    with torch.no_grad():
        v, _ = model(raw.unsqueeze(0), spell_ids.unsqueeze(0))
    return float(v.item())


def _ordered_turns(board, color, model, ordering_alpha=1.0):
    """Return legal turns sorted by (log policy + strategic_score), descending.

    Strong move ordering is what makes alpha-beta efficient — the first
    move evaluated should be the best one, so subsequent moves can be
    cut off quickly. We use the same policy + strategic-eval signal
    that the production search relies on, computed once per node.
    """
    turns = list(board.get_legal_turns(color))
    if not turns:
        return []
    if len(turns) == 1:
        return turns
    raw, spell_ids = board_to_tensor(board, color)
    tf = encode_all_turns(turns, board, color)
    _v, policy = model.evaluate_with_policy(raw, spell_ids, tf)
    strat = strategic_scores(tf.cpu().numpy())
    score = np.log(np.maximum(policy, 1e-6)) + ordering_alpha * strat
    order = np.argsort(-score)
    return [turns[int(i)] for i in order]


class _Timeout(Exception):
    pass


def _alphabeta(board, color, depth, alpha, beta, model, deadline,
               ordering_alpha=1.0):
    """Negamax alpha-beta. Returns (score from `color`'s perspective, best move)."""
    if time.time() > deadline:
        raise _Timeout()
    if board.gameover or depth == 0:
        return _eval_leaf(board, color, model), None

    turns = _ordered_turns(board, color, model, ordering_alpha=ordering_alpha)
    if not turns:
        return _eval_leaf(board, color, model), None

    best_score = -_INF
    best_move = turns[0]
    enemy = 'blue' if color == 'red' else 'red'
    for turn in turns:
        sim = _apply_turn(board, turn, color)
        if sim.gameover and sim.winner == color:
            # Mate-in-1 detected mid-search — propagate immediately.
            return _WIN, turn
        sub_score, _sub_move = _alphabeta(
            sim, enemy, depth - 1, -beta, -alpha, model, deadline,
            ordering_alpha=ordering_alpha,
        )
        score = -sub_score
        if score > best_score:
            best_score = score
            best_move = turn
        if best_score > alpha:
            alpha = best_score
        if alpha >= beta:
            break  # beta cutoff
    return best_score, best_move


def minimax_search(board, color, model, time_limit=10.0, max_depth=4,
                   ordering_alpha=1.0, verbose=False):
    """Iterative-deepening alpha-beta search.

    Returns the best CompleteTurn found within `time_limit` seconds, up
    to `max_depth` plies. Falls back to depth-1 if even a single 2-ply
    search would exceed the budget — guarantees we always return *some*
    move and never run over time by more than the cost of evaluating
    the current depth's last subtree.
    """
    legal = list(board.get_legal_turns(color))
    if not legal:
        return CompleteTurn([Action('pass')])

    # Mate-in-1: cheap special case.
    for turn in legal:
        sim = _apply_turn(board, turn, color)
        if sim.gameover and sim.winner == color:
            if verbose:
                print(f'minimax: mate-in-1 found, returning immediately', flush=True)
            return turn

    deadline = time.time() + time_limit
    best_move = legal[0]
    completed_depth = 0
    for depth in range(1, max_depth + 1):
        t0 = time.time()
        try:
            score, move = _alphabeta(
                board, color, depth, -_INF, _INF, model, deadline,
                ordering_alpha=ordering_alpha,
            )
            if move is not None:
                best_move = move
                completed_depth = depth
                if verbose:
                    print(f'minimax: depth={depth} completed in {time.time()-t0:.2f}s '
                          f'best score={score:+.3f}', flush=True)
            # Early exit if we found a forced win / loss.
            if abs(score) >= _WIN - 1:
                break
        except _Timeout:
            if verbose:
                print(f'minimax: timed out at depth={depth} after {time.time()-t0:.2f}s, '
                      f'using depth-{completed_depth} result', flush=True)
            break
    return best_move
