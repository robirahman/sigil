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
import random
import sys
import time
from collections import namedtuple

import numpy as np
import torch

from simboard import SimBoard, CompleteTurn, Action, MANA_NODES, apply_sim_turn
from notation import NODE_ORDER, POSITIONS
from ai.features import board_to_tensor, encode_all_turns
from ai.strategic_eval import strategic_scores
from ai.enumerator import get_legal_turns_exhaustive, NARROW_CAPS, OPPONENT_CAPS


_INF = 1e9
_WIN = 100.0   # large but finite (so we still prefer faster wins / slower losses)

# Positional leaf-eval terms for stones sitting on non-spell nodes.
# "Void" nodes belong to no spell position and are not mana nodes (a11/a12/a13,
# b11/b12/b13, c11/c12/c13) — a stone parked there is doing nothing useful, so
# we reward the enemy being stranded there and penalize our own. Mana nodes
# (a1/b1/c1) are the opposite: holding them is good, ceding them is bad.
_MANA_NODE_SET = frozenset(MANA_NODES)
_SPELL_NODE_SET = frozenset(n for nodes in POSITIONS.values() for n in nodes)
_VOID_NODES = tuple(n for n in NODE_ORDER
                    if n not in _SPELL_NODE_SET and n not in _MANA_NODE_SET)
_VOID_STONE_WEIGHT = 0.2   # +own-perspective per enemy stone, − per own stone
_MANA_STONE_WEIGHT = 0.3   # +own-perspective per own stone, − per enemy stone
# NOTE: these two are hand-set magnitudes on the NN value head's [-1, 1]
# scale and were never arena-validated. The live JS opponent's equivalents
# live in docs/static/scripts/engine/caveman-ai.js CAVEMAN_EVAL_WEIGHTS —
# fitted empirically (ai/fit_positional_weights.py, see
# ai/data/positional_weights_fit.json) in STONE units and arena-gated
# (tools/arena). Porting those numbers here directly would be a category
# error (different scale, and the NN value head already encodes positional
# structure); aligning this engine is a separate, NN-gated project.

# Hard ceiling for a NON-terminal leaf score. Only the genuine forced game
# endings (handled via board.gameover: +3 stone advantage, all enemy stones
# cleared, spell counter reaching 6 with an advantage, or a full Seal of
# Destruction at the opponent's start-of-turn) may reach the ±_WIN band that
# the search treats as a mate (abs(score) >= _WIN - 1). No accumulation of NN
# value + positional top-up may masquerade as a win/loss, so we clamp strictly
# below that threshold.
_NONTERMINAL_CAP = _WIN - 2.0

# Transposition-table bound classifications.
_BOUND_EXACT = 0   # true score equals stored score
_BOUND_LOWER = 1   # fail-high: true score >= stored score
_BOUND_UPPER = 2   # fail-low:  true score <= stored score

_TTEntry = namedtuple('_TTEntry', ['depth', 'score', 'bound', 'best_move', 'age'])

# Cap on `spell_counter`; the engine resets at 6 (simboard.py:174) so any
# value past 7 collapses to the same Zobrist bucket harmlessly.
_HASH_MAX_SPELL_COUNTER = 8
# Providence pending-move hashing bounds: 4 slots (Endowment horizon) and a
# per-slot count cap (stacked casts saturate at the cap — positions beyond
# it hash together, which only costs TT precision in absurd stacking cases).
_HASH_PENDING_SLOTS = 4
_HASH_MAX_PENDING = 8

# Zobrist tables are deterministic across runs: the hash for the same
# game state must collide between processes so that TT entries from
# self-play could in principle be reused (and so test fixtures stay
# stable). The seed is arbitrary but fixed.
_HASH_SEED = 0xC0FFEE_CAFEBABE & 0xFFFFFFFFFFFFFFFF
_HASH_BITS = 64

# Module-level cache of hashers, keyed by the tuple of spell_names. Each
# game variant uses the same nine spell names, so this cache is usually
# size-1 and is built lazily at first use.
_HASHER_CACHE = {}


class _PositionHasher:
    """Zobrist-style hasher for SimBoard positions.

    Hashes every aspect of game state that affects legal moves or
    evaluation, and only those: stones, spell_counter, lock,
    springlock, and side-to-move. Excludes turn_counter (a tactic at
    turn 5 is the same tactic at turn 50) and the totalstones / mana /
    charged_spells / score derived fields.
    """

    def __init__(self, spell_names, seed=_HASH_SEED):
        rng = random.Random(seed)
        rnd = lambda: rng.getrandbits(_HASH_BITS)

        # 'X' = node destroyed by Fissure. Walls change legality, so they
        # must hash distinctly from empty rather than raise KeyError.
        self._stone = {(n, c): rnd() for n in NODE_ORDER
                       for c in ('red', 'blue', 'X')}
        self._spell_counter = {(c, k): rnd()
                               for c in ('red', 'blue')
                               for k in range(_HASH_MAX_SPELL_COUNTER)}
        # `lock` and `springlock` carry a spell name or None.
        lock_states = list(spell_names) + [None]
        self._lock = {(c, s): rnd()
                      for c in ('red', 'blue') for s in lock_states}
        self._springlock = {(c, s): rnd()
                            for c in ('red', 'blue') for s in lock_states}
        self._side = {'red': rnd(), 'blue': rnd()}
        # Providence: pending schedules and the popped extras counter change
        # legal moves and evaluation, so they must hash — otherwise the TT
        # returns scores across positions that differ only in scheduled
        # moves. Empty schedules XOR nothing, keeping legacy hashes stable.
        self._pending = {(c, i, k): rnd() for c in ('red', 'blue')
                         for i in range(_HASH_PENDING_SLOTS)
                         for k in range(1, _HASH_MAX_PENDING)}
        self._extra_now = {(c, k): rnd() for c in ('red', 'blue')
                           for k in range(1, _HASH_MAX_PENDING)}
        # Aftershock burn schedules — same shape. IMPORTANT: these tables
        # are appended AFTER the Providence ones; the seeded rnd() stream
        # draws sequentially, so append-order preserves every pre-existing
        # table value and therefore every legacy hash (pinned by a literal
        # hash constant in ai/test_aftershock.py).
        self._pending_burn = {(c, i, k): rnd() for c in ('red', 'blue')
                              for i in range(_HASH_PENDING_SLOTS)
                              for k in range(1, _HASH_MAX_PENDING)}
        self._burn_now = {(c, k): rnd() for c in ('red', 'blue')
                          for k in range(1, _HASH_MAX_PENDING)}
        # Ambush snares — appended after the Aftershock tables (same
        # append-order rule as above).
        self._snare = {(n, c): rnd() for n in NODE_ORDER
                       for c in ('red', 'blue')}

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
            for i, k in enumerate(board.pending_moves[color]):
                if k:
                    h ^= self._pending[(color,
                                        min(i, _HASH_PENDING_SLOTS - 1),
                                        min(k, _HASH_MAX_PENDING - 1))]
            for i, k in enumerate(board.pending_burns[color]):
                if k:
                    h ^= self._pending_burn[(color,
                                             min(i, _HASH_PENDING_SLOTS - 1),
                                             min(k, _HASH_MAX_PENDING - 1))]
        e = board.extra_moves_this_turn
        if e:
            h ^= self._extra_now[(board.whose_turn,
                                  min(e, _HASH_MAX_PENDING - 1))]
        bn = board.burns_this_turn
        if bn:
            h ^= self._burn_now[(board.whose_turn,
                                 min(bn, _HASH_MAX_PENDING - 1))]
        for n, owner in board.snares.items():
            h ^= self._snare[(n, owner)]
        return h


def _get_hasher(spell_names):
    """Memoized hasher accessor; tables are built once per spell-set per process."""
    key = tuple(spell_names)
    h = _HASHER_CACHE.get(key)
    if h is None:
        h = _PositionHasher(list(key))
        _HASHER_CACHE[key] = h
    return h


class _TT:
    """Transposition table with depth-preferred replacement and two-generation aging.

    Entries are keyed by Zobrist hash. On overflow we drop entries
    whose age is at least two searches old; if we're still over the
    cap, drop the oldest half.
    """

    __slots__ = ('entries', 'max_size', 'age',
                 'probes', 'hits', 'cutoffs')

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

    def __init__(self, max_ply=8):
        self._slots = [[None, None] for _ in range(max_ply)]
        self.max_ply = max_ply

    def add(self, ply, move):
        if ply >= self.max_ply or move is None:
            return
        slot = self._slots[ply]
        if slot[0] is not None and _turn_eq(slot[0], move):
            return  # already first
        slot[1] = slot[0]
        slot[0] = move

    def get(self, ply):
        if ply >= self.max_ply:
            return ()
        slot = self._slots[ply]
        return tuple(m for m in slot if m is not None)


def _turn_signature(turn):
    """Hashable structural identity for a CompleteTurn — used to match TT/killer hints.

    Must cover EVERY field that distinguishes turn variants, or two
    different variants collide on the same hint (e.g. Rock Slide push
    orders, Fissure walls, Corrupt conversions).
    """
    parts = []
    for a in turn.actions:
        sac = tuple(a.sacrificed) if a.sacrificed else ()
        kept = tuple(a.kept) if a.kept else ()
        dest = tuple(a.destroyed) if a.destroyed else ()
        conv = tuple(a.converted) if a.converted else ()
        pushes = (tuple((p['from'], p['to']) for p in a.pushes)
                  if a.pushes else ())
        nds = tuple(a.nodes) if a.nodes else ()
        parts.append((a.type, a.node, a.pushed_to, a.spell,
                      sac, kept, a.node2, dest, conv, a.wall, pushes,
                      a.turns, nds))
    return tuple(parts)


def _turn_eq(t1, t2):
    if t1 is None or t2 is None:
        return False
    if t1 is t2:
        return True
    return _turn_signature(t1) == _turn_signature(t2)


def _order_with_hints(turns, tt_move, killers):
    """Move tt_move (if any) and killer moves to the front of `turns`.

    Hint moves keep the order tt_move → killer1 → killer2; non-hint
    turns retain their relative ordering. Returns a new list (does not
    mutate `turns`). When no hint matches, returns `turns` unchanged.
    """
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


def _apply_turn(board, turn, color):
    """Replay a turn on a copy of `board`. Returns the post-turn SimBoard.

    Mirrors ai/features.py:_simulate_turn — the underlying SimBoard.apply_turn
    is a no-op, so we step through actions explicitly.
    """
    sim = board.copy()
    # Canonical replay (mirrors JS applySimTurn): honors recorded push
    # destinations and resolver outcomes, replays casts as bookkeeping —
    # never re-resolves (re-casting would double-apply recorded effects and
    # discard the enumerator's target choices). Includes the Seal of
    # Destruction end-of-turn trigger.
    apply_sim_turn(sim, turn, color)
    sim.check_game_over(color)
    if not sim.gameover:
        sim.advance_turn()
        # Start of the next player's turn: still holding the seal loses.
        sim._destruction_start_of_turn_loss(sim.whose_turn)
    return sim


def _eval_leaf(board, color, model):
    """Static evaluation in [-1, +1] from `color`'s perspective.

    Game-over short-circuits: +WIN if we win, -WIN if we lose, 0 draw.
    Otherwise: NN value head, plus a positional top-up for stones on
    non-spell nodes — penalize our own stones stranded on void nodes and
    off mana nodes, reward the enemy being so positioned. The strategic
    score uses the side-to-move's per-turn feature deltas, read off the
    *current* board's pre-state (no per-turn lookahead at leaves).
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

    # Positional top-up (from `color`'s perspective). Void nodes: enemy
    # stones there are wasted (+), our own stranded there are wasted (−).
    # Mana nodes: our control is good (+), enemy control is bad (−).
    enemy = 'blue' if color == 'red' else 'red'
    stones = board.stones
    adj = 0.0
    for n in _VOID_NODES:
        s = stones[n]
        if s == enemy:
            adj += _VOID_STONE_WEIGHT
        elif s == color:
            adj -= _VOID_STONE_WEIGHT
    for n in _MANA_NODE_SET:
        s = stones[n]
        if s == color:
            adj += _MANA_STONE_WEIGHT
        elif s == enemy:
            adj -= _MANA_STONE_WEIGHT
    # A non-terminal position never counts as a forced win/loss, no matter how
    # large its material/positional edge — only board.gameover (above) does.
    result = float(v.item()) + adj
    return max(-_NONTERMINAL_CAP, min(_NONTERMINAL_CAP, result))


def _ordered_turns(board, color, model, ordering_alpha=1.0,
                   exhaustive_caps=None, blunder_lambda=0.0):
    """Return legal turns sorted by (log policy + strategic_score), descending.

    Strong move ordering is what makes alpha-beta efficient — the first
    move evaluated should be the best one, so subsequent moves can be
    cut off quickly. We use the same policy + strategic-eval signal
    that the production search relies on, computed once per node.

    When `exhaustive_caps` is a dict (e.g. NARROW_CAPS or
    OPPONENT_CAPS), uses ai.enumerator.get_legal_turns_exhaustive with
    those caps instead of the engine's default greedy enumerator. That
    includes every dash sacrifice combination, every post-sacrifice
    move target, and every variant of choice-bearing spells (Bewitch
    pair, Carnage target, Meteor/Comet blink target, Starfall pair,
    …). Pass None for greedy (the engine's default).

    When `blunder_lambda > 0`, the trained auxiliary blunder head's
    sigmoid output is subtracted from the policy logit (scaled by
    `blunder_lambda`), suppressing turns the head flags as
    human-curated blunders. Mirrors `model.evaluate_with_policy`.
    """
    if exhaustive_caps is not None:
        turns = list(get_legal_turns_exhaustive(board, color, caps=exhaustive_caps))
    else:
        turns = list(board.get_legal_turns(color))
    if not turns:
        return []
    if len(turns) == 1:
        return turns
    raw, spell_ids = board_to_tensor(board, color)
    tf = encode_all_turns(turns, board, color)
    _v, policy = model.evaluate_with_policy(
        raw, spell_ids, tf, blunder_lambda=blunder_lambda)
    strat = strategic_scores(tf.cpu().numpy())
    score = np.log(np.maximum(policy, 1e-6)) + ordering_alpha * strat
    order = np.argsort(-score)
    return [turns[int(i)] for i in order]


class _Timeout(Exception):
    pass


def _alphabeta(board, color, depth, alpha, beta, model, deadline,
               ordering_alpha=1.0, exhaustive_root=False,
               exhaustive_opponent=False, blunder_lambda=0.0,
               _is_root=True,
               tt=None, killers=None, hasher=None, ply=0,
               position_history=None):
    """Negamax alpha-beta. Returns (score from `color`'s perspective, best move).

    `exhaustive_root`: if True, the *root* call enumerates every dash and
    spell variant via ai.enumerator with NARROW_CAPS.

    `exhaustive_opponent`: if True, the depth-1 (opponent response)
    nodes also enumerate exhaustive variants with OPPONENT_CAPS — these
    are the responses that crush our stones via bewitch chain breaks,
    hard-move bumps, starfall/meteor mass destruction, etc. Deeper
    plies (our re-response, opponent re-re-response, …) still use the
    engine's greedy enumerator.

    `tt`, `killers`, `hasher`: search-engineering helpers. Each is
    optional — when None, behavior reduces to vanilla negamax α-β.
    """
    if time.time() > deadline:
        raise _Timeout()
    if board.gameover or depth == 0:
        return _eval_leaf(board, color, model), None

    # ---- Transposition-table probe ----
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

    if exhaustive_root and _is_root:
        caps = NARROW_CAPS
    elif exhaustive_opponent and ply == 1:
        caps = OPPONENT_CAPS
    else:
        caps = None
    turns = _ordered_turns(
        board, color, model,
        ordering_alpha=ordering_alpha,
        exhaustive_caps=caps,
        blunder_lambda=blunder_lambda,
    )
    if not turns:
        return _eval_leaf(board, color, model), None

    # ---- Hint-driven re-ordering: TT-move first, then killers ----
    killer_moves = killers.get(ply) if killers is not None else ()
    if tt_move is not None or killer_moves:
        turns = _order_with_hints(turns, tt_move, killer_moves)

    best_score = -_INF
    best_move = turns[0]
    enemy = 'blue' if color == 'red' else 'red'
    cutoff = False
    for turn in turns:
        sim = _apply_turn(board, turn, color)
        # Threefold-repetition rule: 5th occurrence of any position is
        # a forced blue-win. Mutate `position_history` on the way down
        # and undo on the way up so siblings see the original counts.
        rep_snap = None
        if position_history is not None and not sim.gameover:
            rep_snap = sim.looping_snapshot()
            new_count = position_history.get(rep_snap, 0) + 1
            position_history[rep_snap] = new_count
            if new_count >= 5:
                sim.gameover = True
                sim.winner = 'blue'
        try:
            if sim.gameover and sim.winner == color:
                best_score = _WIN
                best_move = turn
                cutoff = True
                break
            sub_score, _sub_move = _alphabeta(
                sim, enemy, depth - 1, -beta, -alpha, model, deadline,
                ordering_alpha=ordering_alpha,
                exhaustive_root=exhaustive_root,
                exhaustive_opponent=exhaustive_opponent,
                blunder_lambda=blunder_lambda,
                _is_root=False,
                tt=tt, killers=killers, hasher=hasher, ply=ply + 1,
                position_history=position_history,
            )
            score = -sub_score
            if score > best_score:
                best_score = score
                best_move = turn
            if best_score > alpha:
                alpha = best_score
            if alpha >= beta:
                if killers is not None:
                    killers.add(ply, turn)
                cutoff = True
                break
        finally:
            if rep_snap is not None:
                position_history[rep_snap] -= 1
                if position_history[rep_snap] <= 0:
                    del position_history[rep_snap]

    # ---- Transposition-table store ----
    if tt is not None and tt_key is not None:
        if cutoff and best_score >= beta:
            bound = _BOUND_LOWER
        elif best_score <= alpha_orig:
            bound = _BOUND_UPPER
        else:
            bound = _BOUND_EXACT
        tt.store(tt_key, depth, best_score, bound, best_move)

    return best_score, best_move


def minimax_search(board, color, model, time_limit=10.0, max_depth=4,
                   ordering_alpha=1.0, exhaustive_root=False,
                   exhaustive_opponent=False, blunder_lambda=0.0,
                   verbose=False,
                   enable_tt=True, enable_killers=True,
                   aspiration_delta=0.15,
                   tt_max_size=200_000, max_ply=8, tt=None,
                   position_history=None):
    """Iterative-deepening alpha-beta search.

    Returns the best CompleteTurn found within `time_limit` seconds, up
    to `max_depth` plies. Falls back to depth-1 if even a single 2-ply
    search would exceed the budget — guarantees we always return *some*
    move and never run over time by more than the cost of evaluating
    the current depth's last subtree.

    When `exhaustive_root=True`, every legal turn variant the engine
    can produce — every dash sacrifice combination, post-dash move
    target, and choice-bearing spell variant (e.g. all valid Bewitch
    pairs) — is enumerated at the *root* and ordered by network policy
    + strategic-eval. Opponent responses at deeper plies still use the
    engine's default greedy enumeration to keep cost bounded.

    Search-engineering helpers:
      - `enable_tt=True` enables a transposition table that survives
        across iterative-deepening depths within a single search; if
        `tt` is provided, that TT is reused across moves so entries
        from earlier moves can prune later ones.
      - `enable_killers=True` enables per-ply killer-move ordering.
      - `aspiration_delta > 0` opens iterative-deepening re-searches
        with a narrow window [prev_score - δ, prev_score + δ] around
        the previous depth's score; on fail-high or fail-low we widen
        only the failed bound to ±∞ and re-search. Set to 0 to disable.
    All three default on; passing zero / False reproduces vanilla
    iterative-deepening α-β for benchmarking.
    """
    if exhaustive_root:
        legal = list(get_legal_turns_exhaustive(board, color, caps=NARROW_CAPS))
    else:
        legal = list(board.get_legal_turns(color))
    if not legal:
        return CompleteTurn([Action('pass')])

    # Working copy of the live game's repetition history. Mutated during
    # alpha-beta descent (increment) and undone on backtrack so the
    # caller's dict is never modified.
    ab_history = dict(position_history) if position_history is not None else None

    # Mate-in-1: cheap special case. Iterate over the (possibly
    # exhaustive) root variants so we don't miss a winning Bewitch pair.
    # Also catches a rep-mate where this turn drives the position to its
    # 5th occurrence (forced blue-win).
    for turn in legal:
        sim = _apply_turn(board, turn, color)
        if ab_history is not None and not sim.gameover:
            k = sim.looping_snapshot()
            if ab_history.get(k, 0) + 1 >= 5:
                sim.gameover = True
                sim.winner = 'blue'
        if sim.gameover and sim.winner == color:
            if verbose:
                print(f'minimax: mate-in-1 found, returning immediately', flush=True)
            return turn

    deadline = time.time() + time_limit
    best_move = legal[0]
    completed_depth = 0

    # Build search-engineering helpers.
    if enable_tt:
        tt_obj = tt if tt is not None else _TT(max_size=tt_max_size)
        tt_obj.new_search()
        hasher = _get_hasher(board.spell_names)
    else:
        tt_obj = None
        hasher = None
    killers = _KillerTable(max_ply=max_ply) if enable_killers else None

    prev_score = None
    for depth in range(1, max_depth + 1):
        t0 = time.time()
        try:
            # Aspiration window: open narrow around prev_score and
            # widen only the failed bound on fail-high/fail-low.
            if aspiration_delta > 0 and prev_score is not None and depth > 1:
                alpha = prev_score - aspiration_delta
                beta = prev_score + aspiration_delta
            else:
                alpha, beta = -_INF, _INF
            score = None
            move = None
            while True:
                score, move = _alphabeta(
                    board, color, depth, alpha, beta, model, deadline,
                    ordering_alpha=ordering_alpha,
                    exhaustive_root=exhaustive_root,
                    exhaustive_opponent=exhaustive_opponent,
                    blunder_lambda=blunder_lambda,
                    _is_root=True,
                    tt=tt_obj, killers=killers, hasher=hasher, ply=0,
                    position_history=ab_history,
                )
                if score <= alpha and alpha > -_INF:
                    alpha = -_INF
                    continue
                if score >= beta and beta < _INF:
                    beta = _INF
                    continue
                break
            if move is not None:
                best_move = move
                completed_depth = depth
                prev_score = score
                if verbose:
                    msg = (f'minimax: depth={depth} completed in '
                           f'{time.time()-t0:.2f}s best score={score:+.3f}')
                    if tt_obj is not None:
                        msg += (f' tt={len(tt_obj.entries)}'
                                f' hits={tt_obj.hits} cuts={tt_obj.cutoffs}')
                    print(msg, flush=True)
            # Early exit if we found a forced win / loss.
            if abs(score) >= _WIN - 1:
                break
        except _Timeout:
            if verbose:
                print(f'minimax: timed out at depth={depth} after {time.time()-t0:.2f}s, '
                      f'using depth-{completed_depth} result', flush=True)
            break
    return best_move
