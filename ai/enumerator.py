"""Exhaustive legal-turn enumerator for minimax search.

The default ``SimBoard.get_legal_turns`` collapses three things into a
single greedy variant:

  1. Dash sacrifices — always sacrifices the highest-indexed own stones.
  2. Dash post-sacrifice move target — always ``targets[0]``.
  3. Spell-effect target choices (Bewitch pair, Carnage hard-move
     target, Comet/Meteor blink target, Starfall pair, …) — each
     spell's resolver picks one target heuristically.

That collapse means decision-time search (MCTS or minimax) literally
never gets to evaluate "Bewitch the bridge stone" if the engine's
greedy choice picked a different pair. This module enumerates the
suppressed variants, gated by branching caps so the total turn count
stays tractable.

Trade-off: even with caps, branching at mid-game positions with
charged spells goes from ~25 (default) to ~80–150. 2-ply minimax
remains feasible; 3-ply needs aggressive pruning.

Used by ai/minimax_ai.py when ``exhaustive=True`` is set.
"""

from itertools import combinations

from notation import NODE_ORDER, POSITIONS
from simboard import Action, CompleteTurn, CORE_SPELLS


# Caps on enumeration size. Tuned so a worst-case position with two
# charged choice-heavy spells stays under ~100 dash/cast variants.
DEFAULT_DASH_SAC_CAP = 12       # Top-K sacrifice combinations to try
DEFAULT_DASH_MOVE_CAP = 4       # Top-K post-sacrifice move targets per combo
DEFAULT_BEWITCH_CAP = 8         # Bewitch pair variants
DEFAULT_STARFALL_CAP = 6        # Starfall pair variants
DEFAULT_HARD_MOVES_CAP = 4      # Carnage/Slash first-target variants
DEFAULT_METEOR_CAP = 4          # Meteor blink target variants
DEFAULT_COMET_CAP = 3           # Comet (target × sacrifice) cap
DEFAULT_FIREBLAST_CAP = 3       # Fireblast sacrifice variants


# Tighter "balanced" caps: keep total branching low enough that 3-ply
# alpha-beta still fits in a 10s budget (target ~30–60 effective branches).
BALANCED_CAPS = {
    'dash_sac': 4,
    'dash_move': 2,
    'bewitch': 4,
    'starfall': 3,
    'hard_moves': 3,
    'meteor': 2,
    'comet': 2,
    'fireblast': 2,
}

# Surgical caps: only expand the choice points that empirically matter
# most for the user's reported failure modes. Bewitch pair selection is
# the most-cited gap (the AI never breaks enemy chains because it only
# considers the first-found pair); Carnage/Slash hard-move choices
# matter for the 4-target spells. Dash sacrifice / move targets stay
# greedy — depth-3 search is more valuable than enumerating every
# sacrifice combo at depth 2.
NARROW_CAPS = {
    'dash_sac': 1,
    'dash_move': 1,
    'bewitch': 6,
    'starfall': 1,
    'hard_moves': 3,
    'meteor': 1,
    'comet': 1,
    'fireblast': 2,
}


# Caps for the opponent's response (depth=1 in minimax). We expand the
# attacker's options that empirically destroy our stones: bewitch
# (chain-disrupting our mana connections), hard-move spells (bumping
# our stones into a crush), starfall/meteor (mass-clear or surgical
# kill), and a couple of dash sacrifice variants. Branching averages
# ~25 vs NARROW's ~13 — doable inside the 12s budget at depth 3 with
# the transposition table doing the cross-iteration heavy lifting.
OPPONENT_CAPS = {
    'dash_sac': 2,
    'dash_move': 1,
    'bewitch': 4,
    'starfall': 2,
    'hard_moves': 2,
    'meteor': 2,
    'comet': 1,
    'fireblast': 2,
}


def _adjacent_enemy_pairs(board, color):
    """Unique unordered pairs of adjacent enemy stones."""
    enemy = board._enemy(color)
    seen = set()
    out = []
    for n in NODE_ORDER:
        if board.stones[n] != enemy:
            continue
        for nb in board._adjacent_nodes(n):
            if board.stones[nb] != enemy:
                continue
            key = tuple(sorted([n, nb]))
            if key in seen:
                continue
            seen.add(key)
            out.append(key)
    return out


def _adjacent_empty_pairs_ranked(board, color):
    """Unique adjacent empty-empty pairs, ranked by enemy-stone destruction."""
    enemy = board._enemy(color)
    seen = set()
    cand = []
    for n in NODE_ORDER:
        if board.stones[n] is not None:
            continue
        for nb in board._adjacent_nodes(n):
            if board.stones[nb] is not None:
                continue
            key = tuple(sorted([n, nb]))
            if key in seen:
                continue
            seen.add(key)
            neighbors = set(board._adjacent_nodes(n)) | set(board._adjacent_nodes(nb))
            score = sum(1 for x in neighbors if board.stones[x] == enemy)
            cand.append((score, key))
    cand.sort(key=lambda c: -c[0])
    return [k for _, k in cand]


def _take(seq, lim):
    """Slice helper: ``lim is None`` means no limit (exhaustive)."""
    seq = list(seq)
    return seq if lim is None else seq[:lim]


def _stones_sig(board):
    """Order-independent signature of stone placement (for board dedup)."""
    return tuple(board.stones[n] for n in NODE_ORDER)


def _refill_sets(board, color, spell_name, exhaustive):
    """Keep-set variants (which spell-position stones to keep when refilling).

    Returns a list where each element is either ``None`` (charm: no
    refill choice) or a concrete list of kept nodes. In non-exhaustive
    mode (minimax) only the greedy keep-set is returned so minimax
    economics are unchanged.
    """
    info = CORE_SPELLS.get(spell_name)
    if info is None or info.get('ischarm'):
        return [None]
    spell_idx = board.spell_names.index(spell_name)
    position_nodes = POSITIONS[spell_idx + 1]
    refills = min(board.mana[color], len(position_nodes))

    def greedy_set():
        if len(position_nodes) == 3:
            order = [position_nodes[2], position_nodes[1], position_nodes[0]]
        else:
            order = [position_nodes[2], position_nodes[3], position_nodes[4],
                     position_nodes[0], position_nodes[1]]
        return order[:refills]

    if refills <= 0:
        return [[]]
    if refills >= len(position_nodes):
        return [list(position_nodes)]
    if not exhaustive:
        return [greedy_set()]
    return [list(c) for c in combinations(position_nodes, refills)]


def _post_refill_board(board, color, spell_name, kept_nodes):
    """Board after a cast's sacrifice + refill, before the effect resolves.

    Mirrors the sacrifice/refill in SimBoard._cast_spell so effect-target
    candidates are enumerated against the same state the resolver sees.
    """
    sim = board.copy()
    spell_idx = board.spell_names.index(spell_name)
    position_nodes = POSITIONS[spell_idx + 1]
    for n in position_nodes:
        sim.stones[n] = None
    if kept_nodes:
        for n in kept_nodes:
            sim.stones[n] = color
    sim.update()
    return sim


def _move_sequences(board, color, count, mover, lister):
    """All reachable length-``count`` placement/move sequences, deduped by
    resulting board. ``lister(b)`` returns legal targets; ``mover(b, t)``
    applies one. Used for multi-step spells (soft: Flourish/Grow/Sprout;
    hard: Carnage). Permutations reaching the same board are collapsed.
    """
    results = {}
    seen = set()

    def dfs(b, chosen):
        key = (len(chosen), _stones_sig(b))
        if key in seen:
            return
        seen.add(key)
        if len(chosen) == count:
            results.setdefault(_stones_sig(b), list(chosen))
            return
        targets = lister(b)
        if not targets:
            results.setdefault(_stones_sig(b), list(chosen))
            return
        for t in targets:
            nb = b.copy()
            mover(nb, t)
            nb.update()
            dfs(nb, chosen + [t])

    dfs(board.copy(), [])
    return list(results.values())


def _spell_overrides(board, color, spell_name, caps, exhaustive=False):
    """Return a list of `target_overrides` dicts to try for `spell_name`.

    Always includes `{}` (greedy default) so we don't lose what
    get_legal_turns produced. In exhaustive mode this enumerates the
    cartesian product of keep-set choices (which spell-position stones to
    keep when refilling) with effect-target choices, computed against the
    post-refill board so they match how the resolver actually picks. In
    capped mode (minimax) keep-sets stay greedy and per-spell caps bound
    the effect variants.
    """
    info = CORE_SPELLS.get(spell_name)
    if info is None:
        return [{}]
    rt = info.get('resolve')

    out = [{}]  # always keep the greedy variant
    for kept in _refill_sets(board, color, spell_name, exhaustive):
        # Resolve effect-target candidates against the post-refill board.
        eff_board = _post_refill_board(board, color, spell_name, kept)
        eff_overrides = _effect_overrides(eff_board, color, spell_name, rt, caps,
                                          exhaustive)
        for eff in eff_overrides:
            d = dict(eff)
            if kept is not None:
                d['kept_nodes'] = list(kept)
            out.append(d)

    # Deduplicate (hashable key; list values become tuples).
    seen = set()
    deduped = []
    for o in out:
        items = []
        for k, v in sorted(o.items()):
            if isinstance(v, (list, tuple)):
                v = tuple(v)
            items.append((k, v))
        key = tuple(items)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(o)
    return deduped


def _effect_overrides(board, color, spell_name, rt, caps, exhaustive):
    """Effect-target override dicts for `spell_name`, computed against the
    post-refill `board`. Excludes the keep-set (added by the caller)."""
    out = [{}]
    if rt == 'bewitch':
        for pair in _take(_adjacent_enemy_pairs(board, color), caps['bewitch']):
            out.append({'bewitch_pair': pair})
    elif rt == 'starfall':
        for pair in _take(_adjacent_empty_pairs_ranked(board, color), caps['starfall']):
            out.append({'starfall_pair': pair})
    elif rt == 'hard_moves':
        count = CORE_SPELLS[spell_name].get('count', 1)
        if exhaustive and count > 1:
            for seq in _move_sequences(board, color, count,
                                       lambda b, t: b._do_hard_move(color, t),
                                       lambda b: b._hard_moveable(color)):
                out.append({'hard_move_targets': seq})
        else:
            for t in _take(board._hard_moveable(color), caps['hard_moves']):
                out.append({'hard_move_targets': [t]})
    elif rt == 'soft_moves':
        count = CORE_SPELLS[spell_name].get('count', 1)
        if exhaustive:
            for seq in _move_sequences(board, color, count,
                                       lambda b, t: b._do_soft_move(color, t),
                                       lambda b: b._soft_moveable(color)):
                out.append({'soft_move_targets': seq})
        # capped/minimax: greedy soft moves (no override) — unchanged.
    elif rt == 'surge_move':
        if exhaustive:
            for t in board._all_moveable(color):
                out.append({'surge_target': t})
    elif rt == 'meteor':
        for t in _take(board._blinkable(color), caps['meteor']):
            out.append({'meteor_target': t})
    elif rt == 'comet':
        blinkable = board._blinkable(color)
        own = [n for n in NODE_ORDER if board.stones[n] == color]
        if exhaustive:
            for target in blinkable:
                for sac in own:
                    if sac != target:
                        out.append({'comet_target': target, 'comet_sacrifice': sac})
        else:
            added = 0
            for target in blinkable:
                if added >= caps['comet']:
                    break
                for sac in own:
                    if sac != target:
                        out.append({'comet_target': target, 'comet_sacrifice': sac})
                        added += 1
                        break
    elif rt == 'fireblast':
        own = [n for n in NODE_ORDER if board.stones[n] == color]
        for sac in _take(own, caps['fireblast']):
            out.append({'fireblast_sacrifice': sac})
    # hail_storm: no target choice.
    return out


def _move_action_variants(board, color, target, is_blink, exhaustive):
    """Yield (move_action, board_after) for moving onto `target`.

    When `target` holds an enemy stone (a hard move / push) and we're in
    exhaustive mode, branch over every legal push destination — the
    `_push_enemy` greedy `options[0]` choice is otherwise collapsed.
    """
    is_enemy = board.stones[target] == board._enemy(color)
    if is_enemy and exhaustive:
        dests = board._push_destinations(target, color) or [None]
    else:
        dests = [None]
    for dest in dests:
        b = board.copy()
        act = b._do_move(color, target, is_blink=is_blink, dest_override=dest)
        if act is None:
            continue
        b.update()
        yield act, b


def _enumerate_dashes(board, color, caps, exhaustive):
    """Yield (dash_actions, post_dash_board_copy) for each sacrifice combo
    × move target (× push destination). Caller chains what follows."""
    enemy = board._enemy(color)
    if 'Autumn' in board.charged_spells.get(enemy, []):
        return
    if board.totalstones[color] <= 2:
        return
    own = [n for n in NODE_ORDER if board.stones[n] == color]
    has_lightning = 'Seal_of_Lightning' in board.charged_spells.get(color, [])

    if has_lightning:
        sac_combos = [(s,) for s in _take(own, caps['dash_sac'])]
    else:
        sac_combos = _take(combinations(own, 2), caps['dash_sac'])

    dash_action_type = 'dash_lightning' if has_lightning else 'dash'
    for sacs in sac_combos:
        board_d = board.copy()
        for n in sacs:
            board_d.stones[n] = None
        board_d.update()
        for chosen in _take(board_d._all_moveable(color), caps['dash_move']):
            for move_act, board_d2 in _move_action_variants(
                    board_d, color, chosen, False, exhaustive):
                dash_action = Action(dash_action_type, sacrificed=list(sacs),
                                     node=chosen)
                yield [dash_action, move_act], board_d2


# All-None caps = no limit (fully exhaustive).
_UNCAPPED = {k: None for k in (
    'dash_sac', 'dash_move', 'bewitch', 'starfall', 'hard_moves',
    'meteor', 'comet', 'fireblast')}


def _turn_result_sig(board, color, turn):
    """Full post-turn state signature for output dedup. Two turns with the
    same signature are interchangeable (same stones, locks, counters,
    terminal status), so 'exhaustive' means every distinct resulting
    position rather than every action permutation."""
    from ai.search import _apply_turn
    b = board.copy()
    _apply_turn(b, turn, color)
    return (_stones_sig(b),
            b.lock['red'], b.lock['blue'],
            b.springlock['red'], b.springlock['blue'],
            b.spell_counter['red'], b.spell_counter['blue'],
            b.gameover, b.winner)


def get_legal_turns_exhaustive(board, color, caps=None, exhaustive=False):
    """Yield CompleteTurn variants with the suppressed choices expanded.

    Mirrors the structure of SimBoard.get_legal_turns but expands dash
    sacrifice combos, push destinations, keep-set choices, and
    spell-effect target choices into separate turns.

    `caps`: dict overriding the DEFAULT_* per-spell caps (minimax use).
    `exhaustive`: if True, ignore caps entirely (fully exhaustive: every
    keep-set, push destination, multi-move target-set and effect target),
    and dedup the output by resulting position. Used by MCTS + self-play.
    """
    if exhaustive:
        caps = dict(_UNCAPPED)
    else:
        if caps is None:
            caps = {}
        caps = {
            'dash_sac': caps.get('dash_sac', DEFAULT_DASH_SAC_CAP),
            'dash_move': caps.get('dash_move', DEFAULT_DASH_MOVE_CAP),
            'bewitch': caps.get('bewitch', DEFAULT_BEWITCH_CAP),
            'starfall': caps.get('starfall', DEFAULT_STARFALL_CAP),
            'hard_moves': caps.get('hard_moves', DEFAULT_HARD_MOVES_CAP),
            'meteor': caps.get('meteor', DEFAULT_METEOR_CAP),
            'comet': caps.get('comet', DEFAULT_COMET_CAP),
            'fireblast': caps.get('fireblast', DEFAULT_FIREBLAST_CAP),
        }

    gen = _gen_turns(board, color, caps, exhaustive)
    if not exhaustive:
        yield from gen
        return

    # Exhaustive: dedup by resulting position.
    seen = set()
    for turn in gen:
        try:
            sig = _turn_result_sig(board, color, turn)
        except Exception:
            sig = None
        if sig is not None:
            if sig in seen:
                continue
            seen.add(sig)
        yield turn


def _gen_turns(board, color, caps, exhaustive):
    board.update()

    # Competitive variant opening: blink to any empty node, no spells.
    if getattr(board, 'variant', 'standard') == 'competitive' and board.turn_counter <= 2:
        for n in NODE_ORDER:
            if board.stones[n] is not None:
                continue
            yield CompleteTurn([
                Action('blink', node=n),
                Action('pass'),
            ])
        return

    has_seal_of_wind = 'Seal_of_Wind' in board.charged_spells.get(color, [])
    if has_seal_of_wind:
        move_targets = board._blinkable(color)
    else:
        move_targets = board._all_moveable(color)

    if not move_targets:
        yield CompleteTurn([Action('pass')])
        return

    for move_target in move_targets:
        is_blink = has_seal_of_wind and not any(
            board.stones[nb] == color
            for nb in board._adjacent_nodes(move_target)
        )
        for move_action, board_after in _move_action_variants(
                board, color, move_target, is_blink, exhaustive):
            yield from _exhaustive_post_move(
                board_after, color, [move_action], caps, exhaustive,
                can_dash=True, can_spell=True, can_summer=True,
            )


def _exhaustive_post_move(board, color, prefix, caps, exhaustive,
                          can_dash, can_spell, can_summer):
    """After a move, enumerate {pass, cast(variants), dash(variants), dash+cast}."""
    enemy = board._enemy(color)

    # Always yield the pass-only variant.
    yield CompleteTurn(prefix + [Action('pass')])

    # Spell variants (each charged castable spell × each override).
    if can_spell:
        try:
            castable = list(board._get_castable_spells(color, can_spell, can_summer))
        except Exception:
            castable = []
        for spell_name in castable:
            for override in _spell_overrides(board, color, spell_name, caps, exhaustive):
                board_s = board.copy()
                try:
                    spell_actions = board_s._cast_spell(
                        spell_name, color, target_overrides=override)
                except Exception:
                    continue
                board_s.update()
                # After cast, dash is still allowed (engine permits) but
                # another cast isn't. Recurse to enumerate dash-after-cast.
                yield from _exhaustive_post_move(
                    board_s, color, prefix + spell_actions, caps, exhaustive,
                    can_dash=can_dash, can_spell=False, can_summer=can_summer,
                )

    # Dash variants (each sacrifice combo × move target × push dest).
    if can_dash and can_spell and board.totalstones[color] > 2 \
            and 'Autumn' not in board.charged_spells.get(enemy, []):
        for dash_actions, post_dash_board in _enumerate_dashes(
                board, color, caps, exhaustive):
            # After dash: pass, or cast a spell (no further dash/cast after).
            yield CompleteTurn(prefix + dash_actions + [Action('pass')])
            try:
                castable = list(post_dash_board._get_castable_spells(
                    color, can_spell=False, can_summer=can_summer))
            except Exception:
                castable = []
            for spell_name in castable:
                for override in _spell_overrides(
                        post_dash_board, color, spell_name, caps, exhaustive):
                    board_s = post_dash_board.copy()
                    try:
                        spell_actions = board_s._cast_spell(
                            spell_name, color, target_overrides=override)
                    except Exception:
                        continue
                    board_s.update()
                    yield CompleteTurn(prefix + dash_actions + spell_actions
                                       + [Action('pass')])
