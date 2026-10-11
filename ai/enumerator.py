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

from collections import deque
from itertools import combinations

from notation import NODE_ORDER, POSITIONS, base_spell_name
from simboard import Action, CompleteTurn, CORE_SPELLS, fissure_ranked_targets


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
DEFAULT_CORRUPT_CAP = 3         # Corrupt sacrifice variants
DEFAULT_CHARGE_CAP = 6          # Charge move-target variants
DEFAULT_FURY_SAC_CAP = 4        # Fury sacrifice variants
DEFAULT_FURY_TARGET_CAP = 3     # Fury first-hard-move-target variants (× sac)
DEFAULT_STORM_FRONT_CAP = 12    # Storm Front enemy-pair variants
DEFAULT_HURRICANE_CAP = 4       # Hurricane smallest-group variants
DEFAULT_SOFT_HARD_SOFT_CAP = 4  # Torrent/Tsunami first-soft-target variants
DEFAULT_SOFT_HARD_HARD_CAP = 4  # Torrent/Tsunami first-hard-target variants (× soft)
DEFAULT_SOFT_HARD_SAC_CAP = 3   # Spring Tide trailing-sacrifice SET variants (beyond greedy)
DEFAULT_SPLASH_CAP = 6          # Splash move-target variants
DEFAULT_FISSURE_CAP = 4         # Fissure wall-target variants
DEFAULT_PROVIDENCE_MOVE_CAP = 3 # Providence placement targets
DEFAULT_ROCK_SLIDE_CAP = 12     # Rock Slide distinct max-net outcomes (incl. greedy)

# Every cap key with its package default. get_legal_turns_exhaustive merges
# caller overrides on top of this dict, so a key only needs to be added here
# (plus any profile dicts that want a non-default value) to be safe to
# dereference — profile dicts may omit keys freely.
DEFAULT_CAPS = {
    'dash_sac': DEFAULT_DASH_SAC_CAP,
    'dash_move': DEFAULT_DASH_MOVE_CAP,
    'bewitch': DEFAULT_BEWITCH_CAP,
    'starfall': DEFAULT_STARFALL_CAP,
    'hard_moves': DEFAULT_HARD_MOVES_CAP,
    'meteor': DEFAULT_METEOR_CAP,
    'comet': DEFAULT_COMET_CAP,
    'fireblast': DEFAULT_FIREBLAST_CAP,
    'corrupt': DEFAULT_CORRUPT_CAP,
    'charge': DEFAULT_CHARGE_CAP,
    'fury_sac': DEFAULT_FURY_SAC_CAP,
    'fury_target': DEFAULT_FURY_TARGET_CAP,
    'storm_front': DEFAULT_STORM_FRONT_CAP,
    'hurricane': DEFAULT_HURRICANE_CAP,
    'soft_hard_soft': DEFAULT_SOFT_HARD_SOFT_CAP,
    'soft_hard_sac': DEFAULT_SOFT_HARD_SAC_CAP,
    'soft_hard_hard': DEFAULT_SOFT_HARD_HARD_CAP,
    'splash': DEFAULT_SPLASH_CAP,
    'fissure': DEFAULT_FISSURE_CAP,
    'providence_move': DEFAULT_PROVIDENCE_MOVE_CAP,
    'rock_slide': DEFAULT_ROCK_SLIDE_CAP,
}


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
    'corrupt': 2,
    'charge': 3,
    'fury_sac': 2,
    'fury_target': 2,
    'storm_front': 6,
    'hurricane': 2,
    'soft_hard_soft': 2,
    'soft_hard_hard': 2,
    'splash': 3,
    'providence_move': 2,
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
    'corrupt': 2,
    'charge': 2,
    'fury_sac': 1,
    'fury_target': 1,
    'storm_front': 3,
    'hurricane': 1,
    'soft_hard_soft': 1,
    'soft_hard_hard': 1,
    'splash': 2,
    'fissure': 2,
    'providence_move': 1,
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
    'corrupt': 2,
    'charge': 2,
    'fury_sac': 2,
    'fury_target': 1,
    'storm_front': 4,
    'hurricane': 2,
    'soft_hard_soft': 2,
    'soft_hard_hard': 2,
    'splash': 2,
    'fissure': 3,
    'providence_move': 1,
}


def _adjacent_enemy_pairs(board, color):
    """Unique unordered pairs of adjacent enemy stones (Bulwark-protected
    stones can't be converted, so they never pair)."""
    enemy = board._enemy(color)
    prot = board._bulwark_protected()
    seen = set()
    out = []
    for n in NODE_ORDER:
        if board.stones[n] != enemy or n in prot:
            continue
        for nb in board._adjacent_nodes(n):
            if board.stones[nb] != enemy or nb in prot:
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
    prot = board._bulwark_protected()
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
            score = sum(1 for x in neighbors
                        if board.stones[x] == enemy and x not in prot)
            cand.append((score, key))
    cand.sort(key=lambda c: -c[0])
    return [k for _, k in cand]


def _enemy_groups(board, color):
    """Contiguous groups of destroyable enemy stones (BFS over adjacency;
    Bulwark-protected stones are ignored, matching the Hurricane resolver)."""
    enemy = board._enemy(color)
    visited = set(board._bulwark_protected())
    groups = []
    for start in NODE_ORDER:
        if start in visited or board.stones[start] != enemy:
            continue
        group = []
        queue = deque([start])
        visited.add(start)
        while queue:
            n = queue.popleft()
            group.append(n)
            for nb in board._adjacent_nodes(n):
                if nb not in visited and board.stones[nb] == enemy:
                    visited.add(nb)
                    queue.append(nb)
        groups.append(group)
    return groups


def _spell_overrides(board, color, spell_name, caps):
    """Return a list of `target_overrides` dicts to try for `spell_name`.

    Always includes `{}` (greedy default) so we don't lose what
    get_legal_turns produced. Bounded by per-spell caps in `caps`.
    """
    info = CORE_SPELLS.get(spell_name)
    if info is None:
        return [{}]
    rt = info.get('resolve')
    enemy = board._enemy(color)
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
    elif rt == 'fireblast':
        # Branch over which own stone is sacrificed. We're called on
        # the pre-cast board, but cast() will consume the spell's own
        # position nodes — so prefer stones outside the spell as
        # sacrifice candidates (those still exist when the resolver
        # runs). Resolver falls back greedy on any invalid override.
        try:
            spell_idx = board.spell_names.index(spell_name)
            spell_pos = set(POSITIONS[spell_idx + 1])
        except (ValueError, KeyError):
            spell_pos = set()
        own = [n for n in NODE_ORDER
               if board.stones[n] == color and n not in spell_pos]
        for sac in own[:caps['fireblast']]:
            out.append({'fireblast_sacrifice': sac})
    elif rt == 'corrupt':
        # Branch over which own stone is sacrificed (same spell-position caveat
        # as fireblast — prefer stones outside the casting spell, which survive
        # the cast). Conversion stays greedy: converting more enemy stones is
        # ~always good, so the greedy first-3 covers it.
        try:
            spell_idx = board.spell_names.index(spell_name)
            spell_pos = set(POSITIONS[spell_idx + 1])
        except (ValueError, KeyError):
            spell_pos = set()
        own = [n for n in NODE_ORDER
               if board.stones[n] == color and n not in spell_pos]
        for sac in own[:caps['corrupt']]:
            out.append({'corrupt_sacrifice': sac})
    elif rt == 'charge':
        # 1 move into a 3- or 5-node spell (positions 1..6).
        in_small = set()
        for i in range(1, 7):
            in_small.update(POSITIONS[i])
        targets = [t for t in board._all_moveable(color) if t in in_small]
        for t in targets[:caps['charge']]:
            out.append({'charge_target': t})
    elif rt == 'fury':
        # (sacrifice) × (first hard-move target). Remaining hard moves resolve
        # greedily. Sacrifices outside the spell's own position survive the
        # cast (same caveat as fireblast).
        try:
            spell_idx = board.spell_names.index(spell_name)
            spell_pos = set(POSITIONS[spell_idx + 1])
        except (ValueError, KeyError):
            spell_pos = set()
        sacs = [n for n in NODE_ORDER
                if board.stones[n] == color and n not in spell_pos][:caps['fury_sac']]
        targets = board._hard_moveable(color)[:caps['fury_target']]
        for sac in sacs:
            out.append({'fury_sacrifice': sac})
            for t in targets:
                out.append({'fury_sacrifice': sac, 'hard_move_targets': [t]})
    elif rt == 'storm_front':
        prot = board._bulwark_protected()
        enemies = [n for n in NODE_ORDER
                   if board.stones[n] == enemy and n not in prot]
        added = 0
        for i in range(len(enemies)):
            if added >= caps['storm_front']:
                break
            for j in range(i + 1, len(enemies)):
                if added >= caps['storm_front']:
                    break
                out.append({'storm_front_pair': [enemies[i], enemies[j]]})
                added += 1
        # Storm Front picks one stone at a time and Bulwark is re-checked
        # before each pick: destroying the Bulwark stone first exposes the
        # locked spell to the second pick.
        for brk in enemies:
            for u in sorted(board._bulwark_unshielded_by_removing(brk),
                            key=NODE_ORDER.index)[:caps['storm_front']]:
                out.append({'storm_front_pair': [brk, u]})
    elif rt == 'hurricane':
        for group in _enemy_groups(board, color):
            out.append({'hurricane_group': group})
        # Keep only the smallest groups + greedy; cap the rest.
        out = [out[0]] + sorted(out[1:], key=lambda o: len(o['hurricane_group']))[:caps['hurricane']]
    elif rt == 'soft_hard_chain':
        soft_targets = board._soft_moveable(color)[:caps['soft_hard_soft']]
        hard_targets = board._hard_moveable(color)[:caps['soft_hard_hard']]
        for s in soft_targets:
            for h in hard_targets:
                out.append({'soft_move_targets': [s], 'hard_move_targets': [h]})
            if not hard_targets:
                out.append({'soft_move_targets': [s]})
        # Spring Tide's trailing sacrifice: branch over WHICH own stones to
        # give up (moves stay greedy in these variants). Candidates are the
        # pre-cast own stones outside the spell's own position — those are
        # cleared by the cast itself (same caveat as fury) — as sliding
        # windows over NODE_ORDER, so every variant is a different set. The
        # greedy {} already covers the reversed-NODE_ORDER default.
        sac_count = info.get('sacrifice', 0)
        if sac_count:
            try:
                spell_idx = board.spell_names.index(spell_name)
                spell_pos = set(POSITIONS[spell_idx + 1])
            except (ValueError, KeyError):
                spell_pos = set()
            own = [n for n in NODE_ORDER
                   if board.stones[n] == color and n not in spell_pos]
            for i in range(caps['soft_hard_sac']):
                window = own[i:i + sac_count]
                if len(window) < sac_count:
                    break
                out.append({'sacrifice_targets': window})
    elif rt == 'rock_slide':
        # Every max-net push set with a distinct resolved board, chosen at
        # resolve time on the post-cast board (the cast's sacrifice changes
        # who borders the caster). Variant 0 is the greedy {} above; a
        # variant past the position's count raises inside the resolver and
        # is skipped by the try/except around _cast_spell.
        for i in range(1, caps.get('rock_slide', DEFAULT_ROCK_SLIDE_CAP)):
            out.append({'rock_slide_variant': i})
    elif rt == 'fissure':
        # Branch over which node to blast, best net stone swing first (enemy
        # stones destroyed minus own stones destroyed; see
        # simboard.fissure_score), so the search explores the most damaging
        # walls first and models the opponent's best Fissure.
        ranked = fissure_ranked_targets(board.stones, color,
                                        board._bulwark_protected())
        for t in ranked[:caps['fissure']]:
            out.append({'fissure_target': t})
    elif rt == 'surge_move' and base_spell_name(spell_name) == 'Splash':
        # Splash: 1 move (only castable when not dashed — see castability).
        # Plain Surge stays greedy (post-dash only, fewer options).
        for t in board._all_moveable(color)[:caps['splash']]:
            out.append({'surge_target': t})
    # soft_moves, hail_storm, surge_move (Surge), erupt, gust: greedy is fine.
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
    caps = {**DEFAULT_CAPS, **(caps or {})}

    board.update()
    enemy = board._enemy(color)

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

    yield from _exhaustive_move_root(board, color, [], caps)


def _exhaustive_move_root(board, color, prefix, caps):
    """The move root: enumerate first-move targets, then the optional
    Providence placement and everything downstream."""
    has_seal_of_wind = 'Seal_of_Wind' in board.charged_spells.get(color, [])
    # Seal of Stone (enemy-held) forces a SOFT opening move — no pushes.
    # Wind's blink privilege survives it on EMPTY nodes (a soft blink is a
    # soft move); only hard blinks onto occupied nodes are barred. (This
    # root previously skipped the Stone check entirely — the exhaustive
    # engine could open with an illegal hard move under Stone.)
    enemy_has_stone = ('Seal_of_Stone'
                       in board.charged_spells.get(board._enemy(color), []))
    if enemy_has_stone and has_seal_of_wind:
        move_targets = board._soft_blinkable(color)
    elif enemy_has_stone:
        move_targets = board._soft_moveable(color)
    elif has_seal_of_wind:
        move_targets = board._blinkable(color)
    else:
        move_targets = board._all_moveable(color)

    # Cross-branch dedup for (regular move, Providence placement) prefixes:
    # two orders of the same placements produce the same stones, so their
    # continuations are identical. Safe because every move adds exactly one
    # own stone (pushes are deterministic given the stone map).
    seen_move_prefixes = set()

    if not move_targets:
        yield CompleteTurn(prefix + [Action('pass')])
        # A Providence placement ignores Stone's soft-only rule, so it may
        # still be possible.
        yield from _exhaustive_providence_step(
            board, color, prefix, caps, seen_move_prefixes)
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
            board_after, color, prefix + [move_action], caps,
            can_dash=True, can_spell=True, can_summer=True,
        )
        yield from _exhaustive_providence_step(
            board_after, color, prefix + [move_action], caps,
            seen_move_prefixes)


def _exhaustive_providence_step(board, color, prefix, caps, seen):
    """Optional Providence placement for the exhaustive enumerator (the
    skip branch is the caller's plain post-move): with a nonempty bank,
    place one banked stone on each of the top-`providence_move`-cap
    targets, deduped by stone map across orderings, then dash/cast/pass."""
    if board.prov_bank[color] <= 0 or board.gameover:
        return
    targets = board._all_moveable(color)
    for t in targets[:caps['providence_move']]:
        b = board.copy()
        act = b._do_providence_move(color, t)
        if act is None:
            continue
        key = tuple(b.stones[n] for n in NODE_ORDER)
        if key in seen:
            continue
        seen.add(key)
        yield from _exhaustive_post_move(
            b, color, prefix + [act], caps,
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
                if CORE_SPELLS[spell_name].get('extra_cast'):
                    # Rapids: reopen the spell window once (no dash).
                    yield from _exhaustive_post_move(
                        board_s, color, prefix + spell_actions, caps,
                        can_dash=False, can_spell=True, can_summer=can_summer,
                    )
                    continue
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
                    color, can_spell=False, can_summer=can_summer, post_dash=True))
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
                    if not CORE_SPELLS[spell_name].get('extra_cast'):
                        continue
                    # Rapids after a dash: one more post-dash cast (with its
                    # own override variants). No further chaining.
                    try:
                        castable2 = list(board_s._get_castable_spells(
                            color, can_spell=True, can_summer=can_summer, post_dash=True))
                    except Exception:
                        castable2 = []
                    for spell2 in castable2:
                        for override2 in _spell_overrides(board_s, color, spell2, caps):
                            board_2 = board_s.copy()
                            try:
                                spell_actions2 = board_2._cast_spell(
                                    spell2, color, target_overrides=override2)
                            except Exception:
                                continue
                            board_2.update()
                            yield CompleteTurn(prefix + dash_actions + spell_actions
                                               + spell_actions2 + [Action('pass')])
