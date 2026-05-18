"""Python Caveman — iterative-deepening alpha-beta with a stone-count leaf.

Sibling of docs/static/scripts/engine/caveman-ai.js. Same leaf
(own − enemy total stones, divided by 39, with ±100 terminal sentinels),
same iterative-deepening alpha-beta, same TT + killer-move ordering.
No neural net, no model file to load.

TT + killer scaffolding mirrors ai/minimax_ai.py's _PositionHasher /
_TT / _KillerTable structurally; re-defined here so caveman_ai stays
self-contained and doesn't pull in torch via minimax_ai.

Why a Python port exists: lets us pit Caveman variants against each
other offline (e.g. ai/arena_minimax_tt.py-style harnesses) without
needing a JS runtime, and gives the existing Python AI lineup a
stone-count baseline that matches what players actually face in
__ai_easy__ / __ai_medium__ / __ai_hard__ / __ai_very_hard__ (all
time-budgeted Caveman variants per docs/static/scripts/game-board-local.js).
"""

import math
import random
import time
from collections import namedtuple

from notation import NODE_ORDER
from simboard import SimBoard, CompleteTurn, Action
from ai.search import _apply_turn


CAVEMAN_INF = 1e9
CAVEMAN_WIN = 100.0


# -----------------------------------------------------------------
# Leaf evaluator: own − enemy stone count, scaled into [-1, +1].
# Terminal positions return ±CAVEMAN_WIN.
# -----------------------------------------------------------------

def caveman_leaf(board, color):
    if board.gameover:
        if board.winner == color:
            return CAVEMAN_WIN
        if board.winner is None:
            return 0.0
        return -CAVEMAN_WIN
    enemy = 'blue' if color == 'red' else 'red'
    return (board.totalstones[color] - board.totalstones[enemy]) / 39.0


# -----------------------------------------------------------------
# TT + killers scaffolding (mirror of ai/minimax_ai.py helpers,
# duplicated to keep this module torch-free)
# -----------------------------------------------------------------

_BOUND_EXACT = 0   # true score equals stored score
_BOUND_LOWER = 1   # fail-high: true score >= stored score
_BOUND_UPPER = 2   # fail-low:  true score <= stored score

_TTEntry = namedtuple('_TTEntry', ['depth', 'score', 'bound', 'best_move', 'age'])

_HASH_MAX_SPELL_COUNTER = 8
_HASH_SEED = 0xC0FFEE_CAFEBABE & 0xFFFFFFFFFFFFFFFF
_HASH_BITS = 64
_HASHER_CACHE = {}


class _PositionHasher:
    """Zobrist hasher over stones, spell_counter, lock, springlock, side-to-move.

    Structurally identical to ai/minimax_ai.py:_PositionHasher; same seed so
    a TT entry computed in one engine is in principle reusable in the other.
    """

    def __init__(self, spell_names, seed=_HASH_SEED):
        rng = random.Random(seed)
        rnd = lambda: rng.getrandbits(_HASH_BITS)
        self._stone = {(n, c): rnd() for n in NODE_ORDER for c in ('red', 'blue')}
        self._spell_counter = {(c, k): rnd()
                               for c in ('red', 'blue')
                               for k in range(_HASH_MAX_SPELL_COUNTER)}
        lock_states = list(spell_names) + [None]
        self._lock = {(c, s): rnd()
                      for c in ('red', 'blue') for s in lock_states}
        self._springlock = {(c, s): rnd()
                            for c in ('red', 'blue') for s in lock_states}
        self._side = {'red': rnd(), 'blue': rnd()}

    def hash(self, board, side_to_move):
        h = self._side[side_to_move]
        for node, stone in board.stones.items():
            if stone is None:
                continue
            h ^= self._stone[(node, stone)]
        for color in ('red', 'blue'):
            sc = board.spell_counter[color]
            if sc >= _HASH_MAX_SPELL_COUNTER:
                sc = _HASH_MAX_SPELL_COUNTER - 1
            h ^= self._spell_counter[(color, sc)]
            h ^= self._lock[(color, board.lock[color])]
            h ^= self._springlock[(color, board.springlock[color])]
        return h


def _get_hasher(spell_names):
    key = tuple(spell_names)
    h = _HASHER_CACHE.get(key)
    if h is None:
        h = _PositionHasher(list(key))
        _HASHER_CACHE[key] = h
    return h


class _TT:
    """Transposition table with depth-preferred replacement and aging."""

    __slots__ = ('entries', 'max_size', 'age', 'probes', 'hits', 'cutoffs')

    def __init__(self, max_size=200_000):
        self.entries = {}
        self.max_size = max_size
        self.age = 0
        self.probes = 0
        self.hits = 0
        self.cutoffs = 0

    def new_search(self):
        self.age += 1

    def get(self, key):
        self.probes += 1
        e = self.entries.get(key)
        if e is not None:
            self.hits += 1
        return e

    def store(self, key, depth, score, bound, best_move):
        existing = self.entries.get(key)
        if (existing is None
                or depth >= existing.depth
                or existing.age < self.age):
            self.entries[key] = _TTEntry(depth, score, bound, best_move, self.age)
        if len(self.entries) > self.max_size:
            self._evict()

    def _evict(self):
        threshold = self.age - 1
        stale = [k for k, v in self.entries.items() if v.age < threshold]
        for k in stale:
            del self.entries[k]
        if len(self.entries) > self.max_size:
            ordered = sorted(self.entries.items(), key=lambda kv: kv[1].age)
            for k, _ in ordered[:len(ordered) // 2]:
                del self.entries[k]


class _KillerTable:
    """Per-ply pair of moves that recently caused beta cutoffs."""

    __slots__ = ('_slots', 'max_ply')

    def __init__(self, max_ply=12):
        self._slots = [[None, None] for _ in range(max_ply)]
        self.max_ply = max_ply

    def add(self, ply, move):
        if ply >= self.max_ply or move is None:
            return
        slot = self._slots[ply]
        if slot[0] is not None and _turn_eq(slot[0], move):
            return
        slot[1] = slot[0]
        slot[0] = move

    def get(self, ply):
        if ply >= self.max_ply:
            return ()
        slot = self._slots[ply]
        return tuple(m for m in slot if m is not None)


def _turn_signature(turn):
    """Hashable structural identity for a CompleteTurn."""
    parts = []
    for a in turn.actions:
        sac = tuple(a.sacrificed) if a.sacrificed else ()
        kept = tuple(a.kept) if a.kept else ()
        dest = tuple(a.destroyed) if a.destroyed else ()
        parts.append((a.type, a.node, a.pushed_to, a.spell,
                      sac, kept, a.node2, dest))
    return tuple(parts)


def _turn_eq(t1, t2):
    if t1 is None or t2 is None:
        return False
    if t1 is t2:
        return True
    return _turn_signature(t1) == _turn_signature(t2)


def _order_with_hints(turns, tt_move, killers):
    """Move tt_move (if any) and killer moves to the front of `turns`."""
    if tt_move is None and not killers:
        return turns
    targets = []
    if tt_move is not None:
        targets.append(tt_move)
    for k in killers:
        if k is not None:
            targets.append(k)
    if not targets:
        return turns
    head_indices = []
    used = set()
    for tgt in targets:
        for i, t in enumerate(turns):
            if i in used:
                continue
            if _turn_eq(t, tgt):
                head_indices.append(i)
                used.add(i)
                break
    if not head_indices:
        return turns
    head = [turns[i] for i in head_indices]
    tail = [t for i, t in enumerate(turns) if i not in used]
    return head + tail


# -----------------------------------------------------------------
# Alpha-beta with iterative deepening
# -----------------------------------------------------------------

class _Timeout(Exception):
    pass


def _ordered_turns(board, color):
    """1-ply leaf-sorted turn ordering."""
    turns = list(board.get_legal_turns(color))
    if len(turns) <= 1:
        return turns
    scored = []
    for t in turns:
        child = board.copy()
        _apply_turn(child, t, color)
        child.update()
        scored.append((caveman_leaf(child, color), t))
    scored.sort(key=lambda x: -x[0])
    return [t for _, t in scored]


def _alpha_beta(board, color, depth, alpha, beta, deadline,
                tt, killers, hasher, ply):
    """Negamax with TT + killers. Returns (score, best_turn) for `color`."""
    if time.time() > deadline:
        raise _Timeout()
    if board.gameover or depth == 0:
        return caveman_leaf(board, color), None

    # -- TT probe --
    alpha_orig = alpha
    tt_move = None
    tt_key = None
    if tt is not None and hasher is not None:
        tt_key = hasher.hash(board, color)
        entry = tt.get(tt_key)
        if entry is not None:
            tt_move = entry.best_move
            if entry.depth >= depth:
                if entry.bound == _BOUND_EXACT:
                    tt.cutoffs += 1
                    return entry.score, entry.best_move
                if entry.bound == _BOUND_LOWER:
                    if entry.score > alpha:
                        alpha = entry.score
                elif entry.bound == _BOUND_UPPER:
                    if entry.score < beta:
                        beta = entry.score
                if alpha >= beta:
                    tt.cutoffs += 1
                    return entry.score, entry.best_move

    enemy = 'blue' if color == 'red' else 'red'
    turns = _ordered_turns(board, color)
    if not turns:
        return caveman_leaf(board, color), None

    # -- Hint-driven re-ordering: TT-move first, then killers --
    killer_moves = killers.get(ply) if killers is not None else ()
    if tt_move is not None or killer_moves:
        turns = _order_with_hints(turns, tt_move, killer_moves)

    best_score = -CAVEMAN_INF
    best_turn = turns[0]
    cutoff = False
    for t in turns:
        child = board.copy()
        _apply_turn(child, t, color)
        child.update()
        if child.gameover and child.winner == color:
            best_score = CAVEMAN_WIN
            best_turn = t
            cutoff = True
            break
        if not child.gameover:
            child.advance_turn()
        sub_score, _ = _alpha_beta(child, enemy, depth - 1,
                                   -beta, -alpha, deadline,
                                   tt, killers, hasher, ply + 1)
        score = -sub_score
        if score > best_score:
            best_score = score
            best_turn = t
        if best_score > alpha:
            alpha = best_score
        if alpha >= beta:
            if killers is not None:
                killers.add(ply, t)
            cutoff = True
            break

    # -- TT store --
    if tt is not None and tt_key is not None:
        if cutoff and best_score >= beta:
            bound = _BOUND_LOWER
        elif best_score <= alpha_orig:
            bound = _BOUND_UPPER
        else:
            bound = _BOUND_EXACT
        tt.store(tt_key, depth, best_score, bound, best_turn)

    return best_score, best_turn


def caveman_search(board, color, time_limit=5.0, max_depth=10,
                   enable_tt=True, enable_killers=True,
                   tt_max_size=200_000, max_ply=12, tt=None, verbose=False):
    """Iterative-deepening alpha-beta with TT + killers.

    Args:
        board, color: side-to-move and SimBoard (not mutated)
        time_limit: wall-clock seconds per move
        max_depth: cap on search depth (iterative deepening returns the
            deepest completed depth before the deadline)
        enable_tt, enable_killers: search-engineering toggles. Default on.
        tt: optional pre-existing _TT instance to share across moves
            within a single game (entries from move N can prune move N+1)

    Returns: best CompleteTurn (or a pass if there are no legal turns).
    """
    legal = list(board.get_legal_turns(color))
    if not legal:
        return CompleteTurn([Action('pass')])

    # Mate-in-1 short-circuit at the root.
    for t in legal:
        child = board.copy()
        _apply_turn(child, t, color)
        child.update()
        if child.gameover and child.winner == color:
            return t

    if tt is None and enable_tt:
        tt = _TT(max_size=tt_max_size)
    if tt is not None:
        tt.new_search()
    killers = _KillerTable(max_ply=max_ply) if enable_killers else None
    hasher = _get_hasher(board.spell_names) if tt is not None else None

    deadline = time.time() + time_limit
    best_turn = legal[0]
    completed_depth = 0
    for depth in range(1, max_depth + 1):
        if time.time() > deadline:
            break
        t0 = time.time()
        try:
            score, turn = _alpha_beta(board, color, depth,
                                       -CAVEMAN_INF, CAVEMAN_INF,
                                       deadline,
                                       tt, killers, hasher, 0)
        except _Timeout:
            if verbose:
                print(f'caveman: timed out at depth={depth}, using d={completed_depth}')
            break
        if turn is not None:
            best_turn = turn
            completed_depth = depth
            if verbose:
                tt_info = (f' tt_hits={tt.hits}/{tt.probes} cuts={tt.cutoffs}'
                           if tt is not None else '')
                print(f'caveman: d={depth} done in {time.time()-t0:.2f}s '
                      f'score={score:+.3f}{tt_info}')
        if abs(score) >= CAVEMAN_WIN - 1:
            break
    return best_turn


class CavemanAI:
    """Drop-in player wrapper. Mirrors the JS CavemanAI surface."""

    def __init__(self, time_limit=5.0, max_depth=10,
                 enable_tt=True, enable_killers=True,
                 share_tt_across_moves=True):
        self.time_limit = time_limit
        self.max_depth = max_depth
        self.enable_tt = enable_tt
        self.enable_killers = enable_killers
        # When True, one _TT instance lives across all pick_turn calls;
        # entries computed early in the game prune later positions.
        self._shared_tt = _TT() if (enable_tt and share_tt_across_moves) else None

    def pick_turn(self, board, color):
        return caveman_search(board, color,
                              time_limit=self.time_limit,
                              max_depth=self.max_depth,
                              enable_tt=self.enable_tt,
                              enable_killers=self.enable_killers,
                              tt=self._shared_tt)
