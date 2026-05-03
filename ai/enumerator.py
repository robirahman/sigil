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

from notation import NODE_ORDER
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


def _spell_overrides(board, color, spell_name, caps):
    """Return a list of `target_overrides` dicts to try for `spell_name`.

    Always includes `{}` (greedy default) so we don't lose what
    get_legal_turns produced. Bounded by per-spell caps in `caps`.
    """
    info = CORE_SPELLS.get(spell_name)
    if info is None:
        return [{}]
    rt = info.get('resolve')
    out = [{}]  # always keep the greedy variant

    if rt == 'bewitch':
        for pair in _adjacent_enemy_pairs(board, color)[:caps['bewitch']]:
            out.append({'bewitch_pair': pair})
    elif rt == 'starfall':
        for pair in _adjacent_empty_pairs_ranked(board, color)[:caps['starfall']]:
            out.append({'starfall_pair': pair})
    elif rt == 'hard_moves':
        targets = board._hard_moveable(color)
        for t in targets[:caps['hard_moves']]:
            out.append({'hard_move_targets': [t]})
    elif rt == 'meteor':
        targets = board._blinkable(color)
        for t in targets[:caps['meteor']]:
            out.append({'meteor_target': t})
    elif rt == 'comet':
        blinkable = board._blinkable(color)
        own = [n for n in NODE_ORDER if board.stones[n] == color]
        added = 0
        for target in blinkable:
            if added >= caps['comet']:
                break
            for sac in own:
                if sac != target:
                    out.append({'comet_target': target, 'comet_sacrifice': sac})
                    added += 1
                    break
    # soft_moves, fireblast, hail_storm, surge_move: greedy is fine.
    # Deduplicate just in case.
    seen = set()
    deduped = []
    for o in out:
        # Hashable dedup key — list values become tuples.
        items = []
        for k, v in sorted(o.items()):
            if isinstance(v, list):
                v = tuple(v)
            items.append((k, v))
        key = tuple(items)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(o)
    return deduped


def _enumerate_dashes(board, color, caps):
    """Yield (dash_actions, post_dash_board_copy) for each sacrifice combo
    × top-K move targets. Caller decides what to chain after the dash."""
    enemy = board._enemy(color)
    if 'Autumn' in board.charged_spells.get(enemy, []):
        return
    if board.totalstones[color] <= 2:
        return
    own = [n for n in NODE_ORDER if board.stones[n] == color]
    has_lightning = 'Seal_of_Lightning' in board.charged_spells.get(color, [])

    if has_lightning:
        sac_combos = [(s,) for s in own[:caps['dash_sac']]]
    else:
        sac_combos = list(combinations(own, 2))[:caps['dash_sac']]

    for sacs in sac_combos:
        board_d = board.copy()
        for n in sacs:
            board_d.stones[n] = None
        board_d.update()
        targets = board_d._all_moveable(color)
        for chosen in targets[:caps['dash_move']]:
            board_d2 = board_d.copy()
            move_act = board_d2._do_move(color, chosen)
            if move_act is None:
                continue
            board_d2.update()
            dash_action_type = 'dash_lightning' if has_lightning else 'dash'
            dash_action = Action(dash_action_type, sacrificed=list(sacs), node=chosen)
            yield [dash_action, move_act], board_d2


def get_legal_turns_exhaustive(board, color, caps=None):
    """Yield CompleteTurn variants with the suppressed choices expanded.

    Mirrors the structure of SimBoard.get_legal_turns but expands
    dash sacrifice combos and spell-effect target choices into separate
    turns. Dash post-sacrifice move targets are also expanded (top-K).

    `caps`: dict overriding the DEFAULT_* per-spell caps. Pass an empty
    dict for the package defaults.
    """
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
    }

    board.update()
    enemy = board._enemy(color)
    has_seal_of_wind = 'Seal_of_Wind' in board.charged_spells.get(color, [])
    if has_seal_of_wind:
        move_targets = board._blinkable(color)
    else:
        move_targets = board._all_moveable(color)

    if not move_targets:
        yield CompleteTurn([Action('pass')])
        return

    for move_target in move_targets:
        board_after = board.copy()
        is_blink = has_seal_of_wind and not any(
            board_after.stones[nb] == color
            for nb in board_after._adjacent_nodes(move_target)
        )
        move_action = board_after._do_move(color, move_target, is_blink=is_blink)
        if move_action is None:
            continue
        board_after.update()

        yield from _exhaustive_post_move(
            board_after, color, [move_action], caps,
            can_dash=True, can_spell=True, can_summer=True,
        )


def _exhaustive_post_move(board, color, prefix, caps,
                          can_dash, can_spell, can_summer):
    """After a move, enumerate {pass, cast(variants), dash(variants), dash+cast}."""
    enemy = board._enemy(color)

    # Always yield the pass-only variant.
    yield CompleteTurn(prefix + [Action('pass')])

    # Spell variants (each charged castable spell × each effect override).
    if can_spell:
        try:
            castable = list(board._get_castable_spells(color, can_spell, can_summer))
        except Exception:
            castable = []
        for spell_name in castable:
            for override in _spell_overrides(board, color, spell_name, caps):
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
                    board_s, color, prefix + spell_actions, caps,
                    can_dash=can_dash, can_spell=False, can_summer=can_summer,
                )

    # Dash variants (each sacrifice combo × each post-sacrifice move target).
    if can_dash and can_spell and board.totalstones[color] > 2 \
            and 'Autumn' not in board.charged_spells.get(enemy, []):
        for dash_actions, post_dash_board in _enumerate_dashes(board, color, caps):
            # After dash: pass, or cast a spell (no further dash, no further cast after).
            yield CompleteTurn(prefix + dash_actions + [Action('pass')])
            try:
                castable = list(post_dash_board._get_castable_spells(
                    color, can_spell=False, can_summer=can_summer))
            except Exception:
                castable = []
            for spell_name in castable:
                for override in _spell_overrides(post_dash_board, color, spell_name, caps):
                    board_s = post_dash_board.copy()
                    try:
                        spell_actions = board_s._cast_spell(
                            spell_name, color, target_overrides=override)
                    except Exception:
                        continue
                    board_s.update()
                    yield CompleteTurn(prefix + dash_actions + spell_actions
                                       + [Action('pass')])
