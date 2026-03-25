"""
Alpha-beta search engine for Sigil.

Uses a neural network evaluator for leaf node scoring
and iterative deepening with time limits.
"""

import time
from simboard import SimBoard, CompleteTurn, Action


def alpha_beta(board, depth, alpha, beta, maximizing_color, model,
               deadline=None):
    """Alpha-beta minimax search.

    Args:
        board: SimBoard (will be copied, not mutated)
        depth: remaining full turns to search
        alpha, beta: pruning bounds
        maximizing_color: the color we're maximizing for
        model: SigilEvalNet for leaf evaluation
        deadline: time.time() deadline, or None for no limit

    Returns: (evaluation, best_turn)
    """
    if deadline and time.time() > deadline:
        return model.evaluate(board, maximizing_color), None

    if depth == 0 or board.gameover:
        return model.evaluate(board, maximizing_color), None

    color = board.whose_turn
    is_maximizing = (color == maximizing_color)

    legal_turns = list(board.get_legal_turns(color))
    if not legal_turns:
        return model.evaluate(board, maximizing_color), None

    # Move ordering: sort by shallow NN evaluation
    scored_turns = []
    for turn in legal_turns:
        child = board.copy()
        _apply_turn(child, turn, color)
        child.update()
        if child.gameover:
            # Terminal positions get extreme scores
            if child.winner == maximizing_color:
                score = 1.0
            elif child.winner is not None:
                score = 0.0
            else:
                score = 0.5
        else:
            score = model.evaluate(child, maximizing_color)
        scored_turns.append((score, turn, child))

    # Sort: maximizing player wants high scores first, minimizing wants low first
    scored_turns.sort(key=lambda x: x[0], reverse=is_maximizing)

    best_turn = scored_turns[0][1]  # fallback

    if is_maximizing:
        max_eval = -float('inf')
        for score, turn, child in scored_turns:
            if deadline and time.time() > deadline:
                break

            if child.gameover:
                eval_score = 1.0 if child.winner == maximizing_color else (
                    0.0 if child.winner else 0.5)
            else:
                child.advance_turn()
                eval_score, _ = alpha_beta(child, depth - 1, alpha, beta,
                                           maximizing_color, model, deadline)

            if eval_score > max_eval:
                max_eval = eval_score
                best_turn = turn
            alpha = max(alpha, eval_score)
            if beta <= alpha:
                break
        return max_eval, best_turn
    else:
        min_eval = float('inf')
        for score, turn, child in scored_turns:
            if deadline and time.time() > deadline:
                break

            if child.gameover:
                eval_score = 1.0 if child.winner == maximizing_color else (
                    0.0 if child.winner else 0.5)
            else:
                child.advance_turn()
                eval_score, _ = alpha_beta(child, depth - 1, alpha, beta,
                                           maximizing_color, model, deadline)

            if eval_score < min_eval:
                min_eval = eval_score
                best_turn = turn
            beta = min(beta, eval_score)
            if beta <= alpha:
                break
        return min_eval, best_turn


def _apply_turn(board, turn, color):
    """Apply a turn's actions to a board (mutating)."""
    for action in turn.actions:
        if action.type == 'move':
            board.stones[action.node] = color
        elif action.type == 'hard_move':
            board._push_enemy(action.node, color)
        elif action.type == 'blink':
            enemy = board._enemy(color)
            if board.stones[action.node] == enemy:
                board._push_enemy(action.node, color)
            else:
                board.stones[action.node] = color
        elif action.type == 'cast':
            board._cast_spell(action.spell, color)
        elif action.type in ('dash', 'dash_lightning'):
            if action.sacrificed:
                for sac in action.sacrificed:
                    board.stones[sac] = None
        board.update()


def iterative_deepening_search(board, color, model, max_depth=2,
                                time_limit=5.0):
    """Search with iterative deepening and time limit.

    Args:
        board: SimBoard
        color: which color is moving
        model: SigilEvalNet
        max_depth: maximum search depth
        time_limit: wall clock seconds

    Returns: (best_eval, best_turn)
    """
    deadline = time.time() + time_limit
    best_eval = None
    best_turn = None

    for depth in range(1, max_depth + 1):
        if time.time() > deadline:
            break

        eval_score, turn = alpha_beta(
            board, depth, -float('inf'), float('inf'),
            color, model, deadline)

        if turn is not None:
            best_eval = eval_score
            best_turn = turn

    return best_eval, best_turn
