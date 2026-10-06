"""
Headless simulation board for Sigil.

No WebSocket I/O. Designed for fast copying and legal move enumeration,
used by the alpha-beta search and self-play data generation.
"""

import copy
import itertools
from collections import deque
from notation import NODE_ORDER, ADJACENCY, POSITIONS, base_spell_name, DUPLICATE_SUFFIXES

# Mana nodes
MANA_NODES = ['a1', 'b1', 'c1']


def variant_has_competitive(v):
    """Mirror of JS variantHasCompetitive: the two variant dimensions
    compose into one string ('competitive_deathmatch'), so exact string
    compares silently mishandle the composed variants."""
    return isinstance(v, str) and 'competitive' in v


def variant_has_deathmatch(v):
    """Mirror of JS variantHasDeathmatch."""
    return isinstance(v, str) and 'deathmatch' in v


def variant_has_scramble(v):
    """Mirror of JS variantHasScramble: no stone-lead win; the first to
    cast their sixth spell wins. Shares the end-condition slot with
    Deathmatch, which takes precedence."""
    return isinstance(v, str) and 'scramble' in v and 'deathmatch' not in v


def variant_has_duplicates(v):
    """Mirror of JS variantHasDuplicates: the spell draw may repeat a
    spell (X, X~2, X~3 aliases). Setup-only; play is otherwise standard."""
    return isinstance(v, str) and 'duplicates' in v

# Sentinel stored in a node's `stones[...]` slot when the node has been
# permanently destroyed by Fissure. It is a wall: not None (so it is never a
# soft-move/retreat target), not 'red'/'blue' (so it counts for nobody and
# never charges a spell), and impassable to push chains. See the wall-site
# audits in the move/push helpers below.
DESTROYED = 'X'

# Core spells metadata: name -> {type, static, ischarm, nodes_count}
CORE_SPELLS = {
    'Flourish': {'resolve': 'soft_moves', 'count': 4, 'static': False, 'ischarm': False},
    'Carnage': {'resolve': 'hard_moves', 'count': 4, 'static': False, 'ischarm': False},
    'Bewitch': {'resolve': 'bewitch', 'static': False, 'ischarm': False},
    'Starfall': {'resolve': 'starfall', 'static': False, 'ischarm': False},
    'Seal_of_Lightning': {'resolve': None, 'static': True, 'ischarm': False},
    'Grow': {'resolve': 'soft_moves', 'count': 2, 'static': False, 'ischarm': False},
    'Fireblast': {'resolve': 'fireblast', 'static': False, 'ischarm': False},
    'Hail_Storm': {'resolve': 'hail_storm', 'static': False, 'ischarm': False},
    'Meteor': {'resolve': 'meteor', 'static': False, 'ischarm': False},
    'Seal_of_Wind': {'resolve': None, 'static': True, 'ischarm': False},
    'Sprout': {'resolve': 'soft_moves', 'count': 1, 'static': False, 'ischarm': True},
    'Slash': {'resolve': 'hard_moves', 'count': 1, 'static': False, 'ischarm': True},
    'Surge': {'resolve': 'surge_move', 'static': False, 'ischarm': True},
    'Comet': {'resolve': 'comet', 'static': False, 'ischarm': True},
    'Seal_of_Summer': {'resolve': None, 'static': True, 'ischarm': True},
    # Springtime expansion
    'Seal_of_Spring': {'resolve': None, 'static': True, 'ischarm': True},
    'Scatter': {'resolve': 'scatter', 'static': False, 'ischarm': False},
    'Blossom': {'resolve': 'blossom', 'static': False, 'ischarm': False},
    # Celestial expansion
    'Azimuth': {'resolve': 'azimuth', 'static': False, 'ischarm': True},
    'Eclipse': {'resolve': 'eclipse', 'static': False, 'ischarm': False},
    'Syzygy': {'resolve': 'syzygy', 'static': False, 'ischarm': False},
    # Inferno expansion (JS internal pack key 'fury', display "Inferno")
    'Charge': {'resolve': 'charge', 'static': False, 'ischarm': True},
    'Fury': {'resolve': 'fury', 'static': False, 'ischarm': False},
    'Erupt': {'resolve': 'erupt', 'static': False, 'ischarm': False},
    # Tempest expansion
    'Gust': {'resolve': 'gust', 'static': False, 'ischarm': True},
    'Storm_Front': {'resolve': 'storm_front', 'static': False, 'ischarm': False},
    'Hurricane': {'resolve': 'hurricane', 'static': False, 'ischarm': False},
    # Flood expansion
    'Splash': {'resolve': 'surge_move', 'static': False, 'ischarm': True},
    'Torrent': {'resolve': 'soft_hard_chain', 'counts': [1, 1], 'static': False, 'ischarm': False},
    'Tsunami': {'resolve': 'soft_hard_chain', 'counts': [2, 2], 'static': False, 'ischarm': False},
    # Gloom expansion
    'Lurk': {'resolve': 'restricted_move', 'static': False, 'ischarm': True},
    'Decay': {'resolve': 'destroy_exposed', 'static': False, 'ischarm': False},
    'Corrupt': {'resolve': 'corrupt', 'static': False, 'ischarm': False},
    # Covenant expansion (static seals)
    'Seal_of_Winter': {'resolve': None, 'static': True, 'ischarm': True},
    'Seal_of_Stone': {'resolve': None, 'static': True, 'ischarm': False},
    'Seal_of_Destruction': {'resolve': None, 'static': True, 'ischarm': False},
    # Tectonic expansion
    'Fissure': {'resolve': 'fissure', 'static': False, 'ischarm': False},
    # Rock Slide: every bordering enemy stone gets a push, then all resolve
    # simultaneously (see resolve_rock_slide).
    'Rock_Slide': {'resolve': 'rock_slide', 'static': False, 'ischarm': False},
    'Bulwark': {'resolve': None, 'static': True, 'ischarm': True},
    # Providence expansion (stones banked into the caster's Providence bank)
    'Dividend': {'resolve': 'bank_stones', 'stones': 1, 'static': False, 'ischarm': True},
    'Annuity': {'resolve': 'bank_stones', 'stones': 2, 'static': False, 'ischarm': False},
    'Endowment': {'resolve': 'bank_stones', 'stones': 4, 'static': False, 'ischarm': False},
    # Experimental expansion (unofficial, unrated: unreleased spells under
    # playtest). Spring Tide rides the Flood soft_hard_chain resolver with an
    # optional trailing 'sacrifice' count (Torrent/Tsunami leave it unset).
    'Spring_Tide': {'resolve': 'soft_hard_chain', 'counts': [2, 2], 'hard_first': True, 'sacrifice': 2, 'static': False, 'ischarm': False},
    # Rapids: Torrent's chain plus 'extra_cast' — the cast reopens the turn's
    # spell window once (one more cast, no dash), like Seal of Summer's
    # second cast. Consumed by the turn enumerators, not the resolver.
    'Rapids': {'resolve': 'soft_hard_chain', 'counts': [1, 1], 'extra_cast': True, 'static': False, 'ischarm': False},
}

# Duplicate-copy aliases (allow-duplicates variant): X~2 and X~3 share X's
# metadata so every CORE_SPELLS lookup works untouched. Mirrors constants.js.
for _alias_base in list(CORE_SPELLS):
    for _sfx in DUPLICATE_SUFFIXES:
        CORE_SPELLS[_alias_base + _sfx] = CORE_SPELLS[_alias_base]

# Nodes that sit on a 3-node (sorcery) or 5-node (ritual) sigil — positions 1..6.
# Lurk (Gloom charm) may move onto any node EXCEPT these.
BIG_SPELL_NODES = set()
for _big_pos in (1, 2, 3, 4, 5, 6):
    BIG_SPELL_NODES.update(POSITIONS[_big_pos])


def is_big_spell_node(name):
    return name in BIG_SPELL_NODES

def bulwark_protected_nodes(stones, spell_names, lock, charged_spells):
    """Nodes whose stone is shielded by its owner's Bulwark: a player who
    holds Bulwark charged protects their own stones in their locked spell.
    Protected stones cannot be hard-moved by the enemy, converted, or
    destroyed by any effect (the owner's own Fissure included); sacrifices
    the owner chooses are unaffected. Mirrors bulwarkProtectedNodes in
    constants.js."""
    out = set()
    for c in ('red', 'blue'):
        if 'Bulwark' not in charged_spells[c] or not lock[c]:
            continue
        try:
            idx = spell_names.index(lock[c])
        except ValueError:
            continue
        for n in POSITIONS.get(idx + 1, []):
            if stones[n] == c:
                out.add(n)
    return out


def fissure_blast(stones, target, protected=()):
    """Fissure's outcome at `target`: (destroyed nodes, wall-or-None).
    Every unprotected stone of EITHER color on an adjacent node is
    destroyed. The target node becomes a permanent wall (its stone, if any,
    destroyed) unless it holds a Bulwark-protected stone, in which case the
    stone stays and no wall forms. Mirrors fissureBlast in constants.js."""
    destroyed = [n for n in ADJACENCY[target]
                 if stones[n] in ('red', 'blue') and n not in protected]
    if stones[target] in ('red', 'blue') and target in protected:
        return destroyed, None
    if stones[target] in ('red', 'blue'):
        destroyed.append(target)
    return destroyed, target


def fissure_score(stones, color, target, protected=()):
    """Net stone swing of casting Fissure at `target` for `color`: +1 per
    enemy stone destroyed, -1 per own stone destroyed. None for a node that
    is already a wall (not a legal target). Mirrors fissureScore."""
    if stones[target] == DESTROYED:
        return None
    destroyed, _ = fissure_blast(stones, target, protected)
    return sum(1 if stones[n] != color else -1 for n in destroyed)


def fissure_ranked_targets(stones, color, protected=()):
    """Legal Fissure targets, best net swing first (stable: NODE_ORDER on
    ties). Mirrors fissureRankedTargets in constants.js."""
    scored = []
    for node in NODE_ORDER:
        sc = fissure_score(stones, color, node, protected)
        if sc is not None:
            scored.append((sc, node))
    scored.sort(key=lambda t: -t[0])
    return [n for _, n in scored]


def rock_slide_sources(stones, color, protected=()):
    """Rock Slide's pushed set: every enemy stone touching a `color` stone,
    in NODE_ORDER, except Bulwark-protected ones. Fixed at cast time; every
    one of them must be pushed."""
    enemy = 'blue' if color == 'red' else 'red'
    return [n for n in NODE_ORDER
            if stones[n] == enemy and n not in protected
            and any(stones[nb] == color for nb in ADJACENCY[n])]


def resolve_rock_slide(stones, pushes, protected=()):
    """Resolve Rock Slide's pushes ([{'from', 'to'}, ...]) simultaneously.

    Pure: returns (final, lost) without mutating `stones`. `final` maps each
    touched node to its new value; `lost` lists (node, color) per destroyed
    stone, at the node where it died. Rules:
      - a node whose stone is pushed away counts as vacated, so chains slide
        and closed loops of 3+ rotate;
      - a stationary stone on a destination is destroyed;
      - two or more stones pushed into the same node are all destroyed;
      - two stones pushed onto each other's nodes (a swap) are both destroyed;
      - a stone pushed into a wall is destroyed; the wall stays a wall;
      - a Bulwark-protected stone on a destination acts as a wall: the
        arriving stone is destroyed and the protected stone stays.
    Mirrors resolveRockSlide in constants.js.
    """
    dest_of = {p['from']: p['to'] for p in pushes}
    arrivals = {}
    for p in pushes:
        arrivals.setdefault(p['to'], []).append(p['from'])
    final = {src: None for src in dest_of}
    lost = []
    for dest, srcs in arrivals.items():
        occ = stones[dest]
        shielded = dest in protected and dest not in dest_of
        if dest not in dest_of and occ in ('red', 'blue') and not shielded:
            lost.append((dest, occ))
            final[dest] = None
        if (occ == DESTROYED or shielded or len(srcs) >= 2
                or dest_of.get(dest) == srcs[0]):
            # A stone stopped by a shield dies where it stood: recording it at
            # the shield would put the shielded node in `destroyed`, and
            # rock_slide_replay_protected would then read the shield as absent.
            for src in srcs:
                lost.append((src if shielded else dest, stones[src]))
        else:
            final[dest] = stones[srcs[0]]
    return final, lost


class RockSlideVariantUnavailable(Exception):
    """A 'rock_slide_variant' override asked for more distinct optimal
    outcomes than the position has. The exhaustive enumerators wrap casts in
    try/except-continue, so the surplus variant just disappears."""


_ROCK_SLIDE_MEMO = {}
_ROCK_SLIDE_MEMO_MAX = 256


def _rock_slide_pinned(sources, override_pushes):
    pinned = {}
    for ovr in override_pushes or []:
        src, dst = ovr.get('from'), ovr.get('to')
        if src in sources and dst in ADJACENCY[src] and src not in pinned:
            pinned[src] = dst
    return pinned


def _rock_slide_order(comp, opts):
    """Deterministic variable order keeping the DP frontier narrow: BFS over
    interacting sources (shared destination or adjacency), seeded and
    tie-broken by NODE_ORDER (`comp` arrives in NODE_ORDER)."""
    touches = {src: set(opts[src]) | {src} for src in comp}
    order, seen = [], set()
    for root in comp:
        if root in seen:
            continue
        seen.add(root)
        queue = [root]
        while queue:
            cur = queue.pop(0)
            order.append(cur)
            for nb in comp:
                if nb not in seen and touches[cur] & touches[nb]:
                    seen.add(nb)
                    queue.append(nb)
    return order


def rock_slide_replay_protected(stones, pushes, destroyed):
    """The Bulwark-shielded destinations of a RECORDED Rock Slide: a
    stationary stone on a destination that the recorded outcome did not
    destroy. Replayers use this instead of re-deriving protection, because
    the caster's lock (and so their own shield) changes with the cast."""
    sources = {p['from'] for p in pushes}
    dead = set(destroyed or ())
    return {p['to'] for p in pushes
            if p['to'] not in sources and p['to'] not in dead
            and stones.get(p['to']) in ('red', 'blue')}


def _rock_slide_component(stones, color, comp, opts, src_set, limit,
                          protected=()):
    """Exact max-net search over one interaction component.

    Returns (best_net, [dest dict, ...]): one assignment per distinct
    resolved outcome, each the first optimal assignment reaching it in
    canonical order (sources in _rock_slide_order, options in ADJACENCY
    order), at most `limit` of them (None = all).

    Net = sources destroyed + stationary enemy stones hit - own stones hit,
    accrued per arrival: into a wall +1; the first arrival on a stationary
    enemy / own stone +1 / -1; the second arrival anywhere +2 (both die),
    each later one +1. A lone arrival on a pushed-away node dies only in a
    swap, settled when the node closes. Sources are assigned in
    _rock_slide_order and a node "closes" once every source that can touch it is
    assigned, so the open-node state is a small frontier: dp(i, frontier)
    memoizes the best completion (dynamic programming over the frontier),
    and the tie walk uses it as an exact bound, visiting only optimal paths.
    """
    enemy = 'blue' if color == 'red' else 'red'
    kind = {}
    for src in comp:
        for d in opts[src] + [src]:
            if d in src_set:
                kind[d] = 'mover'
            elif stones[d] == DESTROYED:
                kind[d] = 'wall'
            elif d in protected:
                kind[d] = 'shield'   # Bulwark: arrivals die, occupant stays
            elif stones[d] == enemy:
                kind[d] = 'enemy'
            elif stones[d] == color:
                kind[d] = 'own'
            else:
                kind[d] = 'empty'
    in_comp = set(comp)
    seq = _rock_slide_order(comp, opts)
    # close_at[d]: index of the last source whose choice can affect d.
    close_at = {}
    for i, src in enumerate(seq):
        for d in opts[src]:
            close_at[d] = i
        close_at[src] = max(close_at.get(src, i), i)
    closing = [[] for _ in seq]
    for d, i in close_at.items():
        if kind[d] == 'mover' and d in in_comp:
            closing[i].append(d)
    first_hit = {'enemy': 1, 'own': -1}

    def step(frontier, i, d):
        """Assign seq[i] -> d on `frontier` ({node: (count, arriver, dest)}).
        Returns (gain, new frontier key)."""
        src = seq[i]
        f = dict(frontier)
        kd = kind[d]
        gain = 0
        if kd in ('wall', 'shield'):
            gain = 1
        else:
            cnt, arriver, dst = f.get(d, (0, None, None))
            if cnt == 0:
                gain = first_hit.get(kd, 0)
                f[d] = (1, src, dst)
            else:
                gain = 2 if cnt == 1 else 1
                f[d] = (2, None, dst)
        if src in close_at and kind.get(src) == 'mover':
            cnt, arriver, _ = f.get(src, (0, None, None))
            f[src] = (cnt, arriver, d)
        for node in closing[i]:
            cnt, arriver, dst = f.pop(node, (0, None, None))
            if cnt == 1 and dst == arriver:
                gain += 1        # swap: the lone arrival here dies
        for node in [n for n in f if close_at[n] <= i]:
            del f[node]
        return gain, tuple(sorted(f.items()))

    memo = {}

    def dp(i, key):
        if i == len(seq):
            return 0
        hit = memo.get((i, key))
        if hit is not None:
            return hit
        frontier = dict(key)
        best = None
        for d in opts[seq[i]]:
            gain, nkey = step(frontier, i, d)
            val = gain + dp(i + 1, nkey)
            if best is None or val > best:
                best = val
        memo[(i, key)] = best
        return best

    best = dp(0, ())
    dest = {}
    out, keys = [], set()

    def outcome_key():
        # Key over every node the component can touch (not just this
        # assignment's destinations): landing on a stationary enemy stone
        # leaves an enemy stone there either way, so C->B vs C->D can be
        # the same board.
        arrivals = {}
        for src in seq:
            arrivals.setdefault(dest[src], []).append(src)
        vals = {d: (None if d in src_set else stones[d]) for d in kind}
        for d, srcs in arrivals.items():
            if kind[d] == 'wall':
                vals[d] = DESTROYED
            elif kind[d] == 'shield':
                vals[d] = stones[d]
            elif len(srcs) >= 2 or (kind[d] == 'mover' and dest.get(d) == srcs[0]):
                vals[d] = None
            else:
                vals[d] = enemy
        return tuple(sorted(vals.items()))

    def walk(i, key, acc):
        if limit is not None and len(out) >= limit:
            return
        if i == len(seq):
            k = outcome_key()
            if k not in keys:
                keys.add(k)
                out.append(dict(dest))
            return
        frontier = dict(key)
        for d in opts[seq[i]]:
            gain, nkey = step(frontier, i, d)
            if acc + gain + dp(i + 1, nkey) == best:
                dest[seq[i]] = d
                walk(i + 1, nkey, acc + gain)
                del dest[seq[i]]

    walk(0, (), 0)
    return best, out


def _rock_slide_solve(stones, color, pinned, limit, protected=()):
    sources = rock_slide_sources(stones, color, protected)
    src_set = set(sources)
    opts = {s: [pinned[s]] if s in pinned else list(ADJACENCY[s]) for s in sources}
    parent = {s: s for s in sources}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    by_dest = {}
    for s in sources:
        for d in opts[s]:
            by_dest.setdefault(d, []).append(s)
    for ss in by_dest.values():
        for t in ss[1:]:
            union(ss[0], t)
    for s in sources:
        for d in opts[s]:
            if d in src_set and s in opts[d]:
                union(s, d)
    comps, index = [], {}
    for s in sources:
        r = find(s)
        if r not in index:
            index[r] = len(comps)
            comps.append([])
        comps[index[r]].append(s)
    total, per_comp = 0, []
    for comp in comps:
        net, assigns = _rock_slide_component(stones, color, comp, opts, src_set,
                                             limit, protected)
        total += net
        per_comp.append(assigns)
    return sources, total, per_comp


def rock_slide_optimal_pushes(stones, color, override_pushes=None, limit=None,
                              protected=()):
    """Every Rock Slide push set with the maximum net gain (enemy stones
    destroyed minus own stones destroyed), one per distinct resolved board.

    Returns (best_net, [pushes, ...]) in canonical order (first = greedy).
    Exact: sources split into independent interaction components (shared
    destination or possible swap), each solved by dynamic programming over
    a narrow frontier (see _rock_slide_component), which also walks the tied
    optima; component optima multiply lazily, stopping at `limit`.
    Components touch disjoint nodes, so per-component outcome dedupe makes
    every combination a different board. `override_pushes` pins valid
    {'from', 'to'} choices. `protected`: Bulwark-shielded nodes (never
    pushed; arrivals on them die). Mirrors rockSlideOptimalPushes in
    constants.js.
    """
    protected = frozenset(protected)
    sources = rock_slide_sources(stones, color, protected)
    pinned = _rock_slide_pinned(sources, override_pushes)
    # Memo per position; a solve with a larger limit serves smaller ones
    # (the outcome lists are prefix-consistent).
    key = (tuple(stones[n] for n in NODE_ORDER), color, tuple(sorted(pinned.items())),
           tuple(sorted(protected)))
    hit = _ROCK_SLIDE_MEMO.get(key)
    if hit is None or not (hit[0] is None or (limit is not None and hit[0] >= limit)):
        if len(_ROCK_SLIDE_MEMO) >= _ROCK_SLIDE_MEMO_MAX:
            _ROCK_SLIDE_MEMO.clear()
        hit = _ROCK_SLIDE_MEMO[key] = (limit, _rock_slide_solve(stones, color, pinned, limit,
                                                                protected))
    sources, best, per_comp = hit[1]
    out = []
    for combo in itertools.product(*per_comp):
        merged = {}
        for a in combo:
            merged.update(a)
        out.append([{'from': s, 'to': merged[s]} for s in sources])
        if limit is not None and len(out) >= limit:
            break
    return best, out


def rock_slide_greedy_pushes(stones, color, override_pushes=None, protected=()):
    """The canonical first max-net Rock Slide push set (see
    rock_slide_optimal_pushes). Mirrors rockSlideGreedyPushes in constants.js."""
    return rock_slide_optimal_pushes(stones, color, override_pushes, limit=1,
                                     protected=protected)[1][0]


# Maps a 5-node ritual position to its "opposite" 1-node and 3-node positions.
SYZYGY_OPPOSITE = {1: (8, 5), 2: (9, 6), 3: (7, 4)}


class Action:
    """A single sub-action within a turn."""
    __slots__ = ('type', 'node', 'pushed_to', 'spell', 'sacrificed', 'kept',
                 'node2', 'destroyed', 'converted', 'wall', 'pushes', 'banked',
                 'providence', 'nodes')

    def __init__(self, type, **kwargs):
        self.type = type
        self.node = kwargs.get('node')
        self.pushed_to = kwargs.get('pushed_to')
        self.spell = kwargs.get('spell')
        self.sacrificed = kwargs.get('sacrificed')
        self.kept = kwargs.get('kept')
        self.node2 = kwargs.get('node2')
        self.destroyed = kwargs.get('destroyed')
        self.converted = kwargs.get('converted')
        # Node permanently destroyed (turned into a wall) by this action,
        # e.g. Fissure's target node. None for actions that create no wall.
        self.wall = kwargs.get('wall')
        # Rock Slide pushes: list of {'from', 'to'} dicts (resolved simultaneously).
        self.pushes = kwargs.get('pushes')
        # Providence bank_stones: stones this cast added to the caster's bank.
        self.banked = kwargs.get('banked')
        # Providence: True on the move that placed a stone from the bank.
        self.providence = kwargs.get('providence')

    def __repr__(self):
        parts = [f"Action({self.type!r}"]
        for attr in ('node', 'pushed_to', 'spell', 'sacrificed', 'kept',
                     'node2', 'destroyed', 'converted', 'wall', 'pushes',
                     'banked', 'providence'):
            val = getattr(self, attr)
            if val is not None:
                parts.append(f"{attr}={val!r}")
        return ', '.join(parts) + ')'


class CompleteTurn:
    """A full sequence of actions constituting one player's turn."""
    __slots__ = ('actions',)

    def __init__(self, actions=None):
        self.actions = actions or []

    def __repr__(self):
        return f"CompleteTurn({self.actions})"


class SimBoard:
    """Lightweight, copyable board for simulation."""

    # Recognized variants. 'standard' = the classic two-stone opening with
    # red on a1 and blue on b1. 'competitive' = empty board (all three mana
    # nodes neutral); red's turn-0 is a free blink to any of the 39 nodes;
    # blue's turn-1 is a free soft-blink to any of the remaining 38 empty
    # nodes; play proceeds normally from turn 2.
    # Tokens compose in this fixed order (mirrors JS composeVariant):
    # competitive, deathmatch|scramble, duplicates -> 12 strings (the same
    # order as JS SIGIL_VARIANTS). Deathmatch and Scramble are mutually
    # exclusive end conditions.
    VARIANTS = tuple(
        '_'.join(p for p, on in (('competitive', m & 1), ('deathmatch', m & 2),
                                 ('duplicates', m & 4)) if on) or 'standard'
        for m in range(8)) + tuple(
        '_'.join(p for p, on in (('competitive', m & 1), ('scramble', True),
                                 ('duplicates', m & 4)) if on)
        for m in range(8) if not m & 2)

    __slots__ = ('stones', 'spell_names', 'turn_counter', 'whose_turn',
                 'gameover', 'winner', 'score', 'spell_counter', 'lock',
                 'springlock', 'totalstones', 'mana', 'charged_spells',
                 'variant', 'all_looping_snapshot_counts',
                 'prov_bank')

    def __init__(self, spell_names=None, variant='standard'):
        if variant not in self.VARIANTS:
            raise ValueError(f"Unknown variant: {variant!r}")
        self.stones = {n: None for n in NODE_ORDER}
        self.spell_names = spell_names or ['Flourish', 'Carnage', 'Bewitch',
                                           'Grow', 'Fireblast', 'Hail_Storm',
                                           'Sprout', 'Slash', 'Surge']
        self.turn_counter = 0
        self.whose_turn = 'red'
        self.gameover = False
        self.winner = None
        self.score = 'b1'
        self.spell_counter = {'red': 0, 'blue': 0}
        self.lock = {'red': None, 'blue': None}
        self.springlock = {'red': None, 'blue': None}
        self.totalstones = {'red': 0, 'blue': 0}
        self.mana = {'red': 0, 'blue': 0}
        self.charged_spells = {'red': [], 'blue': []}
        self.variant = variant
        self.all_looping_snapshot_counts = {}
        # Providence: stones banked by Dividend/Annuity/Endowment. They count
        # toward the owner's stone total; a turn that starts with a nonempty
        # bank may place one of them after the regular move.
        self.prov_bank = {'red': 0, 'blue': 0}

    def copy(self):
        b = SimBoard.__new__(SimBoard)
        b.stones = dict(self.stones)
        b.spell_names = self.spell_names  # immutable list, shared
        b.turn_counter = self.turn_counter
        b.whose_turn = self.whose_turn
        b.gameover = self.gameover
        b.winner = self.winner
        b.score = self.score
        b.spell_counter = dict(self.spell_counter)
        b.lock = dict(self.lock)
        b.springlock = dict(self.springlock)
        b.totalstones = dict(self.totalstones)
        b.mana = dict(self.mana)
        b.charged_spells = {'red': list(self.charged_spells['red']),
                            'blue': list(self.charged_spells['blue'])}
        b.variant = self.variant
        b.all_looping_snapshot_counts = dict(self.all_looping_snapshot_counts)
        b.prov_bank = dict(self.prov_bank)
        return b

    def looping_snapshot(self):
        """Repetition-detection key. Matches game.py:Board.take_snapshot
        format so a dict carried over from a live Board produces matching
        keys: red+blue spell counters, every node's stone in NODE_ORDER,
        red lock name (or 'None'), blue lock name (or 'None').

        FIXME (pre-existing, confirmed by Robi 2026-08-26): this key is WRONG.
        Two positions are the same position for repetition purposes only if the
        SIDE TO MOVE and the SPRINGLOCK state also match, and neither is in the
        key. Concretely `self.whose_turn` and `self.springlock` are both omitted,
        so:

          * a position reached with red to move and the same position reached
            with blue to move collide, and
          * a player who has spent their Seal of Spring re-cast collides with one
            who has not, even though only one of them may cast the locked spell.

        Both make threefold repetition (a BLUE WIN, per the rulebook) fire early
        or late. Do not "fix" this by appending to the key casually: the format is
        byte-compatible with game.py's take_snapshot and with dicts carried over
        from live Boards, so a change has to be made on both sides together, or
        suffixed the way the |P bank suffix below is — non-empty
        only, so legacy keys stay identical.

        The Rust engine does NOT inherit this bug: `zobrist.rs::key_js` folds in
        side-to-move and springlock, which is why its repetition handling and this
        function's disagree on purpose.
        """
        key = str(self.spell_counter['red']) + str(self.spell_counter['blue'])
        for nodename in NODE_ORDER:
            key += str(self.stones[nodename])
        key += self.lock['red'] if self.lock['red'] else 'None'
        key += self.lock['blue'] if self.lock['blue'] else 'None'
        # Providence: positions with different banks are NOT the same
        # position. Suffix only when a bank is nonempty so legacy keys (and
        # dicts carried over from live Boards) stay byte-identical.
        if self.prov_bank['red'] or self.prov_bank['blue']:
            key += '|P%d/%d' % (self.prov_bank['red'], self.prov_bank['blue'])
        return key

    def setup_initial(self):
        """Set up the starting board for this board's variant.

        Standard: red on a1, blue on b1.
        Competitive: empty board (mana nodes neutral); both players will
        place their first stone via the special opening moves.
        """
        if variant_has_competitive(self.variant):
            # Empty board; first two turns will use the competitive opening.
            pass
        else:
            self.stones['a1'] = 'red'
            self.stones['b1'] = 'blue'
        self.update()

    def update(self):
        """Recalculate derived state: totalstones, mana, charged_spells, score."""
        red_count = 0
        blue_count = 0
        for stone in self.stones.values():
            if stone == 'red':
                red_count += 1
            elif stone == 'blue':
                blue_count += 1
        self.totalstones['red'] = red_count
        self.totalstones['blue'] = blue_count

        # Score: blue gets +1 phantom stone (a counter token off the
        # playable board — counts toward score only). Providence banked
        # stones count for their owner.
        redscore = red_count + self.prov_bank['red']
        bluescore = blue_count + 1 + self.prov_bank['blue']
        if redscore == bluescore:
            self.score = 'tied'
        elif redscore > bluescore:
            self.score = 'r' + str(min(3, redscore - bluescore))
        else:
            self.score = 'b' + str(min(3, bluescore - redscore))

        # Immediate-loss: a player with zero stones on playable nodes
        # loses right away (latest-edition rules). Blue's +1 phantom
        # counter does NOT save them. In the competitive variant, both
        # players legitimately start with zero stones during the
        # opening; the rule kicks in only "from that point onward",
        # i.e., once turn_counter >= 2 (after both opening blinks).
        # The live game-controller (and selfplay_mcts) use 1-indexed
        # turn numbering: red opens at turn_counter=1, blue at 2, normal
        # play resumes at 3+. Use `<= 2` so both opening turns are
        # covered. Also safe under the 0-indexed advance_turn convention
        # (turn_counter==2 there is red's first regular turn, where both
        # players already have a stone, so the check is inert).
        opening_pass = (variant_has_competitive(self.variant)
                        and self.turn_counter <= 2)
        if not self.gameover and not opening_pass:
            if red_count == 0 and blue_count == 0:
                # Should not occur via any legal action, but guard:
                # whoever's turn it is to move is responsible for the state.
                self.gameover = True
                self.winner = 'blue' if self.whose_turn == 'red' else 'red'
            elif red_count == 0:
                self.gameover = True
                self.winner = 'blue'
            elif blue_count == 0:
                self.gameover = True
                self.winner = 'red'

        # Mana
        for color in ('red', 'blue'):
            self.mana[color] = sum(1 for n in MANA_NODES if self.stones[n] == color)

        # Charged spells
        for color in ('red', 'blue'):
            self.charged_spells[color] = []
        for i, spell_name in enumerate(self.spell_names):
            pos_idx = i + 1
            nodes = POSITIONS[pos_idx]
            if not nodes:
                continue
            # A spell whose position contains a permanently destroyed node
            # can never be charged or cast again.
            if any(self.stones[n] == DESTROYED for n in nodes):
                continue
            first = self.stones[nodes[0]]
            if first is None:
                continue
            all_same = all(self.stones[n] == first for n in nodes[1:])
            if all_same:
                # Duplicates variant: statics list under their BASE name (any
                # copy satisfies "Seal_of_X charged"); castables keep their
                # unique name. Mirrors board.js / sim-board.js.
                info = CORE_SPELLS.get(spell_name)
                self.charged_spells[first].append(
                    base_spell_name(spell_name) if info and info['static'] else spell_name)

    def effective_stones(self, color):
        """Board stones plus Providence banked stones (no blue +1 token)."""
        return self.totalstones[color] + self.prov_bank[color]

    def check_game_over(self, active_color):
        """Check win conditions after a turn. Returns True if game is over.

        Providence banked stones count fully for their owner in both the
        ±3-lead check and the sixth-spell count. Elimination stays
        board-stones-only (handled in update()).
        """
        # update() may already have flagged immediate-loss (zero stones).
        if self.gameover:
            return True

        # Deathmatch: only elimination wins (handled in update()); the
        # ±3-lead and sixth-spell conditions are disabled. Mirrors JS
        # sim-board checkGameOver.
        if variant_has_deathmatch(self.variant):
            return False

        # Scramble: no stone-lead win; casting your sixth spell wins
        # outright. Mirrors JS sim-board checkGameOver.
        if variant_has_scramble(self.variant):
            if self.spell_counter[active_color] >= 6:
                self.gameover = True
                self.winner = active_color
                return True
            return False

        red_total = self.effective_stones('red')
        blue_total = self.effective_stones('blue') + 1  # phantom counter token

        if red_total > blue_total + 2:
            self.gameover = True
            self.winner = 'red'
            return True
        if blue_total > red_total + 2:
            self.gameover = True
            self.winner = 'blue'
            return True

        if self.spell_counter[active_color] >= 6:
            self.gameover = True
            if red_total > blue_total:
                self.winner = 'red'
            elif blue_total > red_total:
                self.winner = 'blue'
            else:
                self.winner = 'blue' if active_color == 'red' else 'red'
            return True

        return False

    def advance_turn(self):
        """Switch to the next player's turn."""
        self.turn_counter += 1
        self.whose_turn = 'blue' if self.whose_turn == 'red' else 'red'

    # ---- Move helpers ----

    def _enemy(self, color):
        return 'blue' if color == 'red' else 'red'

    def _adjacent_nodes(self, node_name):
        return ADJACENCY.get(node_name, [])

    def _bulwark_protected(self):
        """Set of nodes shielded by Bulwark right now (both colors)."""
        return bulwark_protected_nodes(self.stones, self.spell_names,
                                       self.lock, self.charged_spells)

    def _bulwark_unshielded_by_removing(self, node_name):
        """Nodes whose Bulwark shield would drop if the stone at node_name
        were removed (it is the owner's Bulwark charm stone). Used by
        sequential effects (Corrupt, Storm Front) and the enumerators to
        take the Bulwark stone first and then hit the locked spell."""
        if self.stones[node_name] not in ('red', 'blue'):
            return set()
        shielded = self._bulwark_protected()
        if not shielded or node_name in shielded:
            return set()
        b = self.copy()
        b.stones[node_name] = None
        b.update()
        return shielded - b._bulwark_protected()

    def _is_bulwark_protected(self, color, node_name):
        """Return True if the stone at node_name belongs to color and is protected by Bulwark."""
        if self.stones[node_name] != color:
            return False
        if 'Bulwark' not in self.charged_spells[color]:
            return False
        lock_spell = self.lock[color]
        if not lock_spell:
            return False
        try:
            lock_idx = self.spell_names.index(lock_spell)
        except ValueError:
            return False
        lock_nodes = POSITIONS.get(lock_idx + 1, [])
        return node_name in lock_nodes

    def _soft_moveable(self, color):
        """Return list of empty nodes adjacent to color's stones."""
        result = []
        for name in NODE_ORDER:
            if self.stones[name] is None:
                for nb in self._adjacent_nodes(name):
                    if self.stones[nb] == color:
                        result.append(name)
                        break
        return result

    def _hard_moveable(self, color, exclude_nodes=None):
        """Return list of enemy nodes adjacent to color's stones."""
        enemy = self._enemy(color)
        exclude = set(exclude_nodes) if exclude_nodes else set()
        result = []
        for name in NODE_ORDER:
            if self.stones[name] == enemy and not self._is_bulwark_protected(enemy, name):
                for nb in self._adjacent_nodes(name):
                    if nb not in exclude and self.stones[nb] == color:
                        result.append(name)
                        break
        return result

    def _all_moveable(self, color):
        """Return list of nodes (empty or enemy) adjacent to color's stones."""
        enemy = self._enemy(color)
        result = []
        for name in NODE_ORDER:
            if self.stones[name] == DESTROYED:
                continue  # walls are impassable
            if self.stones[name] != color:
                if self.stones[name] == enemy and self._is_bulwark_protected(enemy, name):
                    continue
                for nb in self._adjacent_nodes(name):
                    if self.stones[nb] == color:
                        result.append(name)
                        break
        return result

    def _blinkable(self, color):
        """Return list of all nodes not occupied by color (walls excluded)."""
        enemy = self._enemy(color)
        return [n for n in NODE_ORDER if self.stones[n] != color and self.stones[n] != DESTROYED and not (self.stones[n] == enemy and self._is_bulwark_protected(enemy, n))]

    def _soft_blinkable(self, color):
        """All EMPTY nodes (walls excluded): Wind's blink targets while the
        enemy holds Seal of Stone. A blink onto an empty node is still a
        soft move — Stone only forbids pushes (hard moves / hard blinks),
        per the 2026-08 clarification."""
        return [n for n in NODE_ORDER if self.stones[n] is None]

    def escape_distance(self, node_name, defender_color, max_dist=6):
        """Minimum BFS distance from node_name through defender stones to
        the nearest empty cell, mirroring the push-chain logic in
        _push_enemy. Used by feature engineering as a 'liberty' analogue.

        Returns max_dist if no empty cell is reachable through a chain
        of defender stones (i.e. the stone at node_name would be crushed
        if the attacker pushed it).

        Non-mutating.
        """
        attacker = 'blue' if defender_color == 'red' else 'red'
        queue = deque()
        for nb in self._adjacent_nodes(node_name):
            queue.append((nb, 1))
        visited = {node_name}
        shortest = None
        while queue:
            next_node, dist = queue.popleft()
            if next_node in visited:
                continue
            visited.add(next_node)
            if shortest is not None and dist > shortest:
                break
            if dist > max_dist:
                break
            stone = self.stones[next_node]
            if stone == attacker:
                # Attacker's own stones block the push chain.
                continue
            elif stone == DESTROYED:
                # A wall blocks the push chain and is not an escape cell.
                continue
            elif stone == defender_color:
                for nb in self._adjacent_nodes(next_node):
                    if nb not in visited:
                        queue.append((nb, dist + 1))
            else:  # empty
                return dist
        return max_dist

    def is_crushable(self, node_name, attacker_color):
        """True iff a hard-move into node_name by attacker_color would
        crush the stone there (no empty cell reachable through the push
        chain). Returns False if node_name isn't occupied by the defender.

        Non-mutating; pure read of self.stones.
        """
        defender = 'blue' if attacker_color == 'red' else 'red'
        if self.stones[node_name] != defender:
            return False
        # Use 39 as the unreachable sentinel — graph has 39 nodes total.
        return self.escape_distance(node_name, defender, max_dist=39) >= 39

    def _push_enemy(self, node_name, color, dest_override=None):
        """Push enemy stone from node_name. Returns the push destination,
        or 'X' for crush.

        Mutates self.stones: places color on node_name, moves enemy to destination.
        `dest_override`: replay a recorded push destination (mirrors the JS
        _pushEnemy destOverride); ignored unless it is a legal option.
        """
        enemy = self._enemy(color)

        self.stones[node_name] = color

        queue = deque()
        for nb in self._adjacent_nodes(node_name):
            queue.append((nb, 1))

        visited = {node_name}
        options = []
        shortest = None

        while queue:
            next_node, dist = queue.popleft()
            if next_node in visited:
                continue
            visited.add(next_node)

            if shortest is not None and dist > shortest:
                break

            stone = self.stones[next_node]
            if stone == color:
                continue
            elif stone == DESTROYED:
                # A wall blocks the retreat chain and is not a destination.
                continue
            elif stone == enemy:
                for nb in self._adjacent_nodes(next_node):
                    if nb not in visited:
                        queue.append((nb, dist + 1))
            else:  # empty
                options.append(next_node)
                shortest = dist

        if not options:
            # Crush — stone is destroyed
            return 'X'
        else:
            if dest_override is not None and dest_override in options:
                dest = dest_override
            else:
                # Pick first option (greedy, same as AI)
                dest = options[0]
            self.stones[dest] = enemy
            return dest

    def _do_soft_move(self, color, node_name):
        """Place color stone on empty node. Returns the Action."""
        self.stones[node_name] = color
        return Action('move', node=node_name)

    def _do_hard_move(self, color, node_name):
        """Push enemy at node_name. Returns the Action."""
        dest = self._push_enemy(node_name, color)
        return Action('hard_move', node=node_name, pushed_to=dest)

    def _do_move(self, color, node_name, is_blink=False):
        """Execute a move to node_name. Returns an Action."""
        if self.stones[node_name] is None:
            if is_blink:
                self.stones[node_name] = color
                return Action('blink', node=node_name)
            else:
                return self._do_soft_move(color, node_name)
        elif self.stones[node_name] == self._enemy(color):
            act = self._do_hard_move(color, node_name)
            if is_blink:
                act.type = 'blink'
            return act
        return None  # invalid

    # ---- Spell resolution (greedy by default, branching via overrides) ----

    def _resolve_spell(self, spell_name, color, spell_position_nodes,
                       target_overrides=None):
        """Resolve a spell's effect. Returns list of Actions describing what
        happened.

        Defaults to greedy choices for spells with target options. Pass
        `target_overrides` (a dict) to force a specific resolution — used
        by the exhaustive turn enumerator to branch over target choices.

        Recognized override keys:
          - 'bewitch_pair': (node1, node2) — both must be enemy stones,
              adjacent to each other.
          - 'starfall_pair': (node1, node2) — both must be empty, adjacent.
          - 'meteor_target': node — blink target.
          - 'comet_target': node — blink target.
          - 'comet_sacrifice': node — own stone to sacrifice (≠ target).
          - 'fireblast_sacrifice': node — own stone to sacrifice after
              Fireblast's destruction (any own stone, including the
              casting stone — the player picks).
          - 'hard_move_targets': [node, …] — for Carnage/Slash, the order in
              which to apply hard moves (first valid ones used).
          - 'soft_move_targets': [node, …] — for Flourish/Grow/Sprout.
        """
        info = CORE_SPELLS.get(spell_name)
        if info is None or info['resolve'] is None:
            return []

        actions = []
        enemy = self._enemy(color)
        resolve_type = info['resolve']
        overrides = target_overrides or {}

        if resolve_type == 'soft_moves':
            count = info['count']
            override_targets = list(overrides.get('soft_move_targets') or [])
            for _ in range(count):
                targets = self._soft_moveable(color)
                if not targets:
                    break
                chosen = None
                # Apply override targets in order, skipping any no longer legal.
                while override_targets and chosen is None:
                    candidate = override_targets.pop(0)
                    if candidate in targets:
                        chosen = candidate
                if chosen is None:
                    # Greedy fallback: prefer nodes not in the spell position
                    for t in targets:
                        if t not in spell_position_nodes:
                            chosen = t
                            break
                if chosen is None:
                    chosen = targets[0]
                actions.append(self._do_soft_move(color, chosen))
                self.update()

        elif resolve_type == 'hard_moves':
            count = info['count']
            override_targets = list(overrides.get('hard_move_targets') or [])
            for _ in range(count):
                targets = self._hard_moveable(color)
                if not targets:
                    break
                chosen = None
                while override_targets and chosen is None:
                    candidate = override_targets.pop(0)
                    if candidate in targets:
                        chosen = candidate
                if chosen is None:
                    chosen = targets[0]
                actions.append(self._do_hard_move(color, chosen))
                self.update()

        elif resolve_type == 'fireblast':
            destroyed = []
            prot = self._bulwark_protected()
            for name in NODE_ORDER:
                if self.stones[name] == enemy and name not in prot:
                    for nb in self._adjacent_nodes(name):
                        if self.stones[nb] == color:
                            self.stones[name] = None
                            destroyed.append(name)
                            break
            actions.append(Action('fireblast', destroyed=destroyed))
            self.update()
            # If destruction wiped out the opponent's last stone, the
            # game ends immediately — no sacrifice happens.
            if self.gameover:
                return actions
            # Sacrifice cost (latest-edition rules): pick lowest-priority
            # own stone by reverse NODE_ORDER, mirroring Comet's heuristic.
            sac_override = overrides.get('fireblast_sacrifice')
            sac_done = False
            if sac_override is not None and self.stones.get(sac_override) == color:
                self.stones[sac_override] = None
                actions.append(Action('sacrifice', node=sac_override))
                sac_done = True
            if not sac_done:
                for name in reversed(NODE_ORDER):
                    if self.stones[name] == color:
                        self.stones[name] = None
                        actions.append(Action('sacrifice', node=name))
                        break
            self.update()

        elif resolve_type == 'hail_storm':
            destroyed = []
            prot = self._bulwark_protected()
            for pos_idx in range(1, 7):
                nodes = POSITIONS[pos_idx]
                for n in nodes:
                    if self.stones[n] == enemy and n not in prot:
                        self.stones[n] = None
                        destroyed.append(n)
                        self.update()
                        break
            if destroyed:
                actions.append(Action('hail_storm', destroyed=destroyed))

        elif resolve_type == 'bewitch':
            # Convert two adjacent enemy stones. Override picks a specific
            # pair; otherwise fall back to first-found by NODE_ORDER.
            override = overrides.get('bewitch_pair')
            prot = self._bulwark_protected()
            if override is not None:
                n1, n2 = override
                if (self.stones[n1] == enemy
                        and self.stones[n2] == enemy
                        and n1 not in prot and n2 not in prot
                        and n2 in self._adjacent_nodes(n1)):
                    self.stones[n1] = color
                    self.stones[n2] = color
                    actions.append(Action('bewitch', node=n1, node2=n2))
                    self.update()
                    return actions
            for name in NODE_ORDER:
                if self.stones[name] == enemy and name not in prot:
                    for nb in self._adjacent_nodes(name):
                        if self.stones[nb] == enemy and nb not in prot:
                            self.stones[name] = color
                            self.stones[nb] = color
                            actions.append(Action('bewitch', node=name, node2=nb))
                            self.update()
                            return actions
            # No valid target found

        elif resolve_type == 'starfall':
            # Place two adjacent stones on empty nodes, then destroy
            # neighboring enemies. Override picks a specific empty pair;
            # otherwise the greedy choice maximizes enemy destruction.
            best = None
            override = overrides.get('starfall_pair')
            if override is not None:
                n1, n2 = override
                if (self.stones[n1] is None
                        and self.stones[n2] is None
                        and n2 in self._adjacent_nodes(n1)):
                    best = (n1, n2)
            if best is None:
                # Heuristic: max enemy stones destroyed; ties broken in
                # favor of pairs that destroy an enemy on a mana node
                # (a1/b1/c1). Mana destruction is strictly better than
                # destruction elsewhere because losing mana stalls the
                # opponent's spell tempo.
                best_score = (-1, -1)
                prot = self._bulwark_protected()
                for name in NODE_ORDER:
                    if self.stones[name] is not None:
                        continue
                    for nb in self._adjacent_nodes(name):
                        if self.stones[nb] is not None:
                            continue
                        neighbors_union = (set(self._adjacent_nodes(name))
                                           | set(self._adjacent_nodes(nb)))
                        enemy_targets = [n for n in neighbors_union
                                         if self.stones[n] == enemy
                                         and n not in prot]
                        enemy_count = len(enemy_targets)
                        mana_kills = sum(1 for n in enemy_targets if n in MANA_NODES)
                        score = (enemy_count, mana_kills)
                        if score > best_score:
                            best_score = score
                            best = (name, nb)
            if best:
                n1, n2 = best
                self.stones[n1] = color
                self.stones[n2] = color
                destroyed = []
                prot = self._bulwark_protected()
                neighbors_union = set(self._adjacent_nodes(n1)) | set(self._adjacent_nodes(n2))
                for n in neighbors_union:
                    if self.stones[n] == enemy and n not in prot:
                        self.stones[n] = None
                        destroyed.append(n)
                actions.append(Action('starfall', node=n1, node2=n2, destroyed=destroyed))
                self.update()

        elif resolve_type == 'meteor':
            # Blink move, then destroy 1 adjacent enemy. Override picks
            # a specific blink target.
            targets = self._blinkable(color)
            chosen = None
            override = overrides.get('meteor_target')
            if override is not None and override in targets:
                chosen = override
            else:
                # Heuristic: maximize total enemies destroyed (push-crush
                # if blinking onto an enemy with no escape, plus the one
                # adjacent enemy the spell destroys). Ties broken in
                # favor of options that eliminate an enemy mana stone —
                # via crush of a mana-occupant or via the adjacent-kill
                # falling on a mana node.
                best_score = (-1, -1)
                prot_now = self._bulwark_protected()
                for t in targets:
                    crush = (self.stones[t] == enemy
                             and self.is_crushable(t, color))
                    crush_kills = 1 if crush else 0
                    crush_mana = 1 if (crush and t in MANA_NODES) else 0
                    # After the blink, t is owned by us. Find the first
                    # adjacent enemy (matches the actual resolver's
                    # iteration order), preferring one on a mana node.
                    adj_enemies = [
                        nb for nb in self._adjacent_nodes(t)
                        if self.stones[nb] == enemy and nb not in prot_now
                    ]
                    if adj_enemies:
                        kill = 1
                        # Prefer killing a mana stone if available.
                        kill_mana = 1 if any(n in MANA_NODES for n in adj_enemies) else 0
                    else:
                        kill = 0
                        kill_mana = 0
                    score = (crush_kills + kill, crush_mana + kill_mana)
                    if score > best_score:
                        best_score = score
                        chosen = t
                if chosen is None and targets:
                    chosen = targets[0]
            if chosen:
                if self.stones[chosen] == enemy:
                    dest = self._push_enemy(chosen, color)
                    actions.append(Action('blink', node=chosen, pushed_to=dest))
                else:
                    self.stones[chosen] = color
                    actions.append(Action('blink', node=chosen))
                self.update()
                # Destroy 1 adjacent enemy — prefer one on a mana node so
                # the heuristic's mana-tiebreak choice is realized.
                prot = self._bulwark_protected()
                adj_enemies = [
                    nb for nb in self._adjacent_nodes(chosen)
                    if self.stones[nb] == enemy and nb not in prot
                ]
                kill_target = None
                for nb in adj_enemies:
                    if nb in MANA_NODES:
                        kill_target = nb
                        break
                if kill_target is None and adj_enemies:
                    kill_target = adj_enemies[0]
                if kill_target is not None:
                    self.stones[kill_target] = None
                    actions.append(Action('meteor_destroy', node=kill_target))
                self.update()

        elif resolve_type == 'comet':
            # Blink move (typically to a mana node), then sacrifice a stone.
            # Override picks a specific blink target.
            target = None
            override = overrides.get('comet_target')
            if override is not None:
                blinkable = self._blinkable(color)
                if override in blinkable:
                    target = override
            if target is None:
                for mn in reversed(MANA_NODES):
                    if self.stones[mn] != color and self.stones[mn] != DESTROYED:
                        adj_enemy = sum(1 for nb in self._adjacent_nodes(mn) if self.stones[nb] == enemy)
                        already_touching = self.stones[mn] == color or any(
                            self.stones[nb] == color for nb in self._adjacent_nodes(mn))
                        if not already_touching and adj_enemy < 2:
                            target = mn
                            break
                if target is None:
                    targets = self._blinkable(color)
                    if targets:
                        target = targets[0]
            if target:
                if self.stones[target] == enemy:
                    dest = self._push_enemy(target, color)
                    actions.append(Action('blink', node=target, pushed_to=dest))
                else:
                    self.stones[target] = color
                    actions.append(Action('blink', node=target))
                self.update()
                # Sacrifice the least valuable stone — but never the
                # just-placed blink target (that defeats the purpose of
                # the spell). JS implementation skips `target`; this
                # matches it for cross-engine feature parity.
                sac_override = overrides.get('comet_sacrifice')
                sac_done = False
                if sac_override is not None and sac_override != target:
                    if self.stones[sac_override] == color:
                        self.stones[sac_override] = None
                        actions.append(Action('sacrifice', node=sac_override))
                        sac_done = True
                if not sac_done:
                    for name in reversed(NODE_ORDER):
                        if self.stones[name] == color and name != target:
                            self.stones[name] = None
                            actions.append(Action('sacrifice', node=name))
                            break
                self.update()

        elif resolve_type == 'surge_move':
            # Make 1 move. Override picks a specific target.
            targets = self._all_moveable(color)
            override = overrides.get('surge_target')
            chosen = None
            if override is not None and override in targets:
                chosen = override
            elif targets:
                chosen = targets[0]
            if chosen:
                actions.append(self._do_move(color, chosen))
                self.update()

        elif resolve_type == 'azimuth':
            # 1 move into a spell where this color controls all but 1 node.
            qualifying = []
            for i in range(1, 10):
                unc = sum(1 for n in POSITIONS[i] if self.stones[n] != color)
                if unc == 1:
                    qualifying.append(i)
            moves = self._all_moveable(color)
            chosen = None
            for idx in qualifying:
                for n in POSITIONS[idx]:
                    if n in moves:
                        chosen = n
                        break
                if chosen:
                    break
            if chosen:
                actions.append(self._do_move(color, chosen))
                self.update()

        elif resolve_type == 'eclipse':
            # 2 moves into a spell where this color controls all but 2 nodes.
            candidates = []
            for i in range(1, 10):
                unc = sum(1 for n in POSITIONS[i] if self.stones[n] != color)
                if unc == 2:
                    candidates.append(i)
            chosen_spell = None
            first_node = None
            for idx in candidates:
                moves = self._all_moveable(color)
                for n in POSITIONS[idx]:
                    if n in moves:
                        chosen_spell = idx
                        first_node = n
                        break
                if first_node:
                    break
            if first_node:
                actions.append(self._do_move(color, first_node))
                self.update()
                moves2 = self._all_moveable(color)
                for n in POSITIONS[chosen_spell]:
                    if n in moves2:
                        actions.append(self._do_move(color, n))
                        self.update()
                        break

        elif resolve_type == 'scatter':
            # 1 soft blink into each of 2 different spells (any empty node).
            used_spells = set()
            for _ in range(2):
                placed = None
                for i in range(1, 10):
                    if i in used_spells:
                        continue
                    for n in POSITIONS[i]:
                        if self.stones[n] is None:
                            placed = (n, i)
                            break
                    if placed:
                        break
                if not placed:
                    break
                node_name, idx = placed
                self.stones[node_name] = color
                used_spells.add(idx)
                actions.append(Action('blink', node=node_name))
                self.update()

        elif resolve_type == 'blossom':
            # 1 soft blink into each other 3-node and 5-node spell. A FULL
            # spell is SKIPPED, not a stop condition — the live resolver
            # only ends early when no eligible spell has an empty node
            # (the old `break` made the whole spread fizzle whenever the
            # first other sigil happened to be full).
            self_idx = self.spell_names.index(spell_name) + 1
            for i in range(1, 7):
                if i == self_idx:
                    continue
                placed = None
                for n in POSITIONS[i]:
                    if self.stones[n] is None:
                        placed = n
                        break
                if not placed:
                    continue  # this spell is full — skip it
                self.stones[placed] = color
                actions.append(Action('blink', node=placed))
                self.update()

        elif resolve_type == 'syzygy':
            # 1 blink into the opposite 1-node spell, then up to 3 into the opposite 3-node spell.
            spell_idx = self.spell_names.index(spell_name) + 1
            opp = SYZYGY_OPPOSITE.get(spell_idx)
            if opp is not None:
                charm_idx, sorcery_idx = opp
                charm_node = POSITIONS[charm_idx][0]
                if (self.stones[charm_node] != color and self.stones[charm_node] != DESTROYED
                        and not self._is_bulwark_protected(enemy, charm_node)):
                    if self.stones[charm_node] == enemy:
                        dest = self._push_enemy(charm_node, color)
                        actions.append(Action('blink', node=charm_node, pushed_to=dest))
                    else:
                        self.stones[charm_node] = color
                        actions.append(Action('blink', node=charm_node))
                    self.update()
                for _ in range(3):
                    target = next((n for n in POSITIONS[sorcery_idx]
                                   if self.stones[n] != color and self.stones[n] != DESTROYED
                                   and not self._is_bulwark_protected(enemy, n)), None)
                    if target is None:
                        break
                    if self.stones[target] == enemy:
                        dest = self._push_enemy(target, color)
                        actions.append(Action('blink', node=target, pushed_to=dest))
                    else:
                        self.stones[target] = color
                        actions.append(Action('blink', node=target))
                    self.update()

        elif resolve_type == 'charge':
            # 1 move (soft or hard) into any 3- or 5-node spell (positions
            # 1..6). No "control all but N" constraint, unlike Azimuth.
            def _pos_of(node):
                for i in range(1, 10):
                    if node in POSITIONS[i]:
                        return i
                return None
            moves = self._all_moveable(color)
            override = overrides.get('charge_target')
            chosen = None
            if override is not None and override in moves:
                p = _pos_of(override)
                if p is not None and p <= 6:
                    chosen = override
            if chosen is None:
                for i in range(1, 7):
                    for n in POSITIONS[i]:
                        if n in moves:
                            chosen = n
                            break
                    if chosen:
                        break
            if chosen:
                actions.append(self._do_move(color, chosen))
                self.update()

        elif resolve_type == 'fury':
            # Sacrifice 1 stone, then 3 hard moves.
            sac_override = overrides.get('fury_sacrifice')
            sacrificed = None
            if sac_override is not None and self.stones[sac_override] == color:
                self.stones[sac_override] = None
                sacrificed = sac_override
            else:
                for name in reversed(NODE_ORDER):
                    if self.stones[name] == color:
                        self.stones[name] = None
                        sacrificed = name
                        break
            if sacrificed:
                actions.append(Action('sacrifice', node=sacrificed))
            self.update()
            if self.gameover:
                return actions
            override_targets = list(overrides.get('hard_move_targets') or [])
            for _ in range(3):
                targets = self._hard_moveable(color)
                if not targets:
                    break
                chosen = None
                while override_targets and chosen is None:
                    candidate = override_targets.pop(0)
                    if candidate in targets:
                        chosen = candidate
                if chosen is None:
                    chosen = targets[0]
                actions.append(self._do_hard_move(color, chosen))
                self.update()

        elif resolve_type == 'erupt':
            # Up to 2 non-blink moves into every 3- or 5-node spell (positions
            # 1..6) in which `color` already has a stone, EXCEPT Erupt's own
            # slot. A spell where you hold k of N nodes allows min(2, N-k)
            # moves, further limited by reachability.
            own = set(spell_position_nodes)
            for i in range(1, 7):
                nodes_i = POSITIONS[i]
                if set(nodes_i) == own:
                    continue  # skip Erupt's own slot
                if not any(self.stones[n] == color for n in nodes_i):
                    continue  # need an existing stone in this spell
                for _ in range(2):
                    moves = self._all_moveable(color)
                    chosen = None
                    for n in nodes_i:
                        if n in moves:
                            chosen = n
                            break
                    if chosen is None:
                        break
                    actions.append(self._do_move(color, chosen))
                    self.update()
                    if self.gameover:
                        return actions

        elif resolve_type == 'gust':
            # Pick up every enemy stone touching one of our stones, then place
            # them (one at a time) on any empty node.
            picked = []
            prot = self._bulwark_protected()
            for n in NODE_ORDER:
                if self.stones[n] != enemy or n in prot:
                    continue
                for nb in self._adjacent_nodes(n):
                    if self.stones[nb] == color:
                        picked.append(n)
                        break
            if picked:
                for n in picked:
                    self.stones[n] = None
                self.update()
                place_overrides = list(overrides.get('gust_placements') or [])
                placed = []
                for i in range(len(picked)):
                    dest = None
                    if i < len(place_overrides) and self.stones.get(place_overrides[i]) is None:
                        dest = place_overrides[i]
                    else:
                        for n in NODE_ORDER:
                            if self.stones[n] is None:
                                dest = n
                                break
                    if dest is None:
                        break
                    self.stones[dest] = enemy
                    placed.append(dest)
                    self.update()
                actions.append(Action('gust', destroyed=picked, kept=placed))

        elif resolve_type == 'storm_front':
            # Destroy any 2 enemy stones of the caster's choice.
            self._destroy_chosen(color, actions, 2,
                                 overrides.get('storm_front_pair'))

        elif resolve_type == 'hurricane':
            # Destroy the smallest contiguous enemy group (ties: caster picks).
            # Bulwark-protected stones are ignored: groups are formed from
            # the destroyable enemy stones only.
            prot = self._bulwark_protected()
            visited = set(prot)
            groups = []
            for start in NODE_ORDER:
                if start in visited or self.stones[start] != enemy:
                    continue
                group = []
                queue = deque([start])
                visited.add(start)
                while queue:
                    n = queue.popleft()
                    group.append(n)
                    for nb in self._adjacent_nodes(n):
                        if nb not in visited and self.stones[nb] == enemy:
                            visited.add(nb)
                            queue.append(nb)
                groups.append(group)
            if groups:
                min_size = min(len(g) for g in groups)
                smallest = [g for g in groups if len(g) == min_size]
                chosen = smallest[0]
                ovr = overrides.get('hurricane_group')
                if ovr:
                    for g in smallest:
                        if len(g) == len(ovr) and all(n in g for n in ovr):
                            chosen = g
                            break
                for n in chosen:
                    self.stones[n] = None
                actions.append(Action('hurricane', destroyed=list(chosen)))
                self.update()

        elif resolve_type == 'soft_hard_chain':
            # N soft moves, then M hard moves (Torrent [1,1], Tsunami [2,2]).
            # 'hard_first' flips the two phases (Spring Tide: pushes, then
            # placements). Each phase stops early when it runs out of legal
            # targets; the other phase still runs.
            soft_count, hard_count = info['counts']
            soft_overrides = list(overrides.get('soft_move_targets') or [])
            hard_overrides = list(overrides.get('hard_move_targets') or [])

            def _soft_phase():
                for _ in range(soft_count):
                    targets = self._soft_moveable(color)
                    if not targets:
                        break
                    chosen = None
                    while soft_overrides and chosen is None:
                        candidate = soft_overrides.pop(0)
                        if candidate in targets:
                            chosen = candidate
                    if chosen is None:
                        for t in targets:
                            if t not in spell_position_nodes:
                                chosen = t
                                break
                    if chosen is None:
                        chosen = targets[0]
                    actions.append(self._do_soft_move(color, chosen))
                    self.update()

            def _hard_phase():
                for _ in range(hard_count):
                    targets = self._hard_moveable(color)
                    if not targets:
                        break
                    chosen = None
                    while hard_overrides and chosen is None:
                        candidate = hard_overrides.pop(0)
                        if candidate in targets:
                            chosen = candidate
                    if chosen is None:
                        chosen = targets[0]
                    actions.append(self._do_hard_move(color, chosen))
                    self.update()

            if info.get('hard_first'):
                _hard_phase()
                _soft_phase()
            else:
                _soft_phase()
                _hard_phase()
            # Optional trailing sacrifice (Spring Tide: 2). Not paid when the
            # moves already ended the game (Fireblast/Corrupt convention).
            # Greedy pick mirrors Fury: the caster's last stone in NODE_ORDER;
            # 'sacrifice_targets' overrides it (skipping stale entries).
            sac_count = info.get('sacrifice', 0)
            if sac_count > 0:
                if self.gameover:
                    return actions
                sac_overrides = list(overrides.get('sacrifice_targets') or [])
                for _ in range(sac_count):
                    sacrificed = None
                    while sac_overrides and sacrificed is None:
                        candidate = sac_overrides.pop(0)
                        if self.stones.get(candidate) == color:
                            sacrificed = candidate
                    if sacrificed is None:
                        for name in reversed(NODE_ORDER):
                            if self.stones[name] == color:
                                sacrificed = name
                                break
                    if sacrificed is None:
                        break
                    self.stones[sacrificed] = None
                    actions.append(Action('sacrifice', node=sacrificed))
                    self.update()
                    if self.gameover:
                        return actions

        elif resolve_type == 'destroy_exposed':
            self._destroy_exposed(color, actions)

        elif resolve_type == 'corrupt':
            # Convert up to 3 enemy stones touching the caster, then sacrifice
            # one own stone. Eligibility is frozen against the pre-conversion
            # board so conversions can't chain (a stone touching only a freshly
            # converted stone is never eligible). Greedy converts the first 3
            # eligible by NODE_ORDER; 'corrupt_targets' override picks specific
            # ones, 'corrupt_sacrifice' picks the stone to give up.
            #
            # Conversions happen one at a time, so Bulwark is checked before
            # each one: converting the enemy's Bulwark stone first exposes
            # their locked spell to the remaining conversions. Greedy
            # therefore takes such a "Bulwark breaker" first, when eligible.
            eligible = []
            for name in NODE_ORDER:
                if self.stones[name] != enemy:
                    continue
                if any(self.stones[nb] == color
                       for nb in self._adjacent_nodes(name)):
                    eligible.append(name)
            breakers = [n for n in eligible
                        if self._bulwark_unshielded_by_removing(n) & set(eligible)]
            order = []
            for cand in list(overrides.get('corrupt_targets') or []) + breakers + eligible:
                if cand in eligible and cand not in order:
                    order.append(cand)
            converted = []
            while len(converted) < 3 and not self.gameover:
                prot = self._bulwark_protected()
                pick = next((n for n in order if n not in converted
                             and self.stones[n] == enemy and n not in prot), None)
                if pick is None:
                    break
                self.stones[pick] = color
                converted.append(pick)
                self.update()
            if converted:
                actions.append(Action('corrupt', converted=converted))
            self.update()
            # Converting the enemy's last stone ends the game — no sacrifice.
            if self.gameover:
                return actions
            sac_override = overrides.get('corrupt_sacrifice')
            sac_done = False
            if sac_override is not None and self.stones.get(sac_override) == color:
                self.stones[sac_override] = None
                actions.append(Action('sacrifice', node=sac_override))
                sac_done = True
            if not sac_done:
                for name in reversed(NODE_ORDER):
                    if self.stones[name] == color:
                        self.stones[name] = None
                        actions.append(Action('sacrifice', node=name))
                        break
            self.update()

        elif resolve_type == 'restricted_move':
            # Lurk: 1 move onto any moveable node not in a 3- or 5-node spell.
            targets = [n for n in self._all_moveable(color) if not is_big_spell_node(n)]
            chosen = None
            ovr = overrides.get('restricted_target')
            if ovr and ovr in targets:
                chosen = ovr
            elif targets:
                chosen = targets[0]
            if chosen is not None:
                actions.append(self._do_move(color, chosen, is_blink=False))
                self.update()

        elif resolve_type == 'fissure':
            prot = self._bulwark_protected()
            target = overrides.get('fissure_target')
            if (not target or target not in NODE_ORDER
                    or self.stones[target] == DESTROYED):
                # Greedy default: the target with the greatest net
                # stone-count swing (see fissure_score).
                ranked = fissure_ranked_targets(self.stones, color, prot)
                target = ranked[0] if ranked else None
            if target is not None:
                destroyed, wall = fissure_blast(self.stones, target, prot)
                for n in destroyed:
                    self.stones[n] = None
                if wall:
                    self.stones[wall] = DESTROYED
                actions.append(Action('fissure', node=target, destroyed=destroyed,
                                      wall=wall))
                self.update()

        elif resolve_type == 'rock_slide':
            # Every push is chosen first, then all resolve at once, with one
            # update() at the end (no mid-resolution stone-count checks).
            # 'rock_slide_variant' i > 0 (exhaustive enumerator) picks the
            # i-th distinct max-net outcome on this post-cast board.
            variant = overrides.get('rock_slide_variant') or 0
            prot = self._bulwark_protected()
            if variant:
                # One generous solve serves the enumerator's whole run of
                # variants through the memo.
                _, options = rock_slide_optimal_pushes(
                    self.stones, color, overrides.get('rock_slide_pushes'),
                    limit=max(16, variant + 1), protected=prot)
                if variant >= len(options):
                    raise RockSlideVariantUnavailable(variant)
                pushes = options[variant]
            else:
                pushes = rock_slide_greedy_pushes(self.stones, color,
                                                  overrides.get('rock_slide_pushes'),
                                                  protected=prot)
            final, lost = resolve_rock_slide(self.stones, pushes, prot)
            self.stones.update(final)
            destroyed = list(dict.fromkeys(n for n, _ in lost))
            actions.append(Action('rock_slide', pushes=pushes,
                                  destroyed=destroyed or None))
            self.update()

        elif resolve_type == 'bank_stones':
            # Providence: add stones to the caster's bank.
            n = info.get('stones', 1)
            self.prov_bank[color] += n
            actions.append(Action('bank_stones', spell=spell_name, banked=n))
            self.update()

        return actions

    def _destroy_exposed(self, color, actions):
        """Gloom (Decay): destroy every enemy stone touching 2+ empty
        nodes. Membership is computed against the pre-destruction board, then
        applied simultaneously. Appends a 'decay' Action and updates."""
        enemy = self._enemy(color)
        prot = self._bulwark_protected()
        doomed = []
        for name in NODE_ORDER:
            if self.stones[name] != enemy or name in prot:
                continue
            empties = sum(1 for nb in self._adjacent_nodes(name)
                          if self.stones[nb] is None)
            if empties >= 2:
                doomed.append(name)
        for name in doomed:
            self.stones[name] = None
        actions.append(Action('decay', destroyed=doomed))
        self.update()
        return doomed

    def _destroy_chosen(self, color, actions, count, chosen=None):
        """Destroy up to `count` enemy stones of the caster's choice
        (Storm_Front). `chosen` is an optional
        ordered list of preferred enemy nodes; entries that aren't currently
        enemy stones are skipped, falling back to the first enemy stone in
        NODE_ORDER. Appends one Action describing what was destroyed."""
        enemy = self._enemy(color)
        chosen = list(chosen or [])
        destroyed = []
        for _ in range(count):
            # One stone at a time: destroying the enemy's Bulwark stone
            # first exposes their locked spell to the next pick.
            prot = self._bulwark_protected()
            target = None
            while chosen and target is None:
                cand = chosen.pop(0)
                if self.stones.get(cand) == enemy and cand not in prot:
                    target = cand
            if target is None:
                for name in NODE_ORDER:
                    if self.stones[name] == enemy and name not in prot:
                        target = name
                        break
            if target is None:
                break
            self.stones[target] = None
            destroyed.append(target)
            self.update()
            if self.gameover:
                break
        if destroyed:
            actions.append(Action('storm_front', destroyed=destroyed))
        return destroyed

    def _destruction_end_of_turn(self, color):
        """Seal of Destruction, END of `color`'s turn: if `color` controls the
        seal, destroy every enemy stone touching one of `color`'s stones."""
        if 'Seal_of_Destruction' not in self.charged_spells[color]:
            return []
        enemy = self._enemy(color)
        prot = self._bulwark_protected()
        destroyed = []
        for name in NODE_ORDER:
            if self.stones[name] != enemy or name in prot:
                continue
            for nb in self._adjacent_nodes(name):
                if self.stones[nb] == color:
                    self.stones[name] = None
                    destroyed.append(name)
                    break
        if destroyed:
            self.update()
        return destroyed

    def _destruction_start_of_turn_loss(self, color):
        """Seal of Destruction, START of `color`'s turn: if `color` still
        controls the seal, they lose immediately."""
        if self.gameover:
            return True
        if 'Seal_of_Destruction' in self.charged_spells[color]:
            self.gameover = True
            self.winner = self._enemy(color)
            return True
        return False

    def _cast_spell(self, spell_name, color, target_overrides=None):
        """Cast a spell: sacrifice nodes, refill by mana, resolve effect.

        Mutates board state. Returns list of Actions.
        """
        spell_idx = self.spell_names.index(spell_name)
        pos_idx = spell_idx + 1
        position_nodes = POSITIONS[pos_idx]
        spell_info = CORE_SPELLS[spell_name]
        is_charm = spell_info['ischarm']

        actions = []

        # Sacrifice all stones in spell position (never clobber a wall: a
        # destroyed node stays destroyed even if it sits in this position).
        for n in position_nodes:
            if self.stones[n] != DESTROYED:
                self.stones[n] = None

        # Refill based on mana (non-charms only)
        kept = []
        if not is_charm:
            refills = self.mana[color]
            # AI refill priority: middle nodes first
            if len(position_nodes) == 3:
                refill_priority = [position_nodes[2], position_nodes[1], position_nodes[0]]
            else:
                refill_priority = [position_nodes[2], position_nodes[3], position_nodes[4],
                                   position_nodes[0], position_nodes[1]]
            for node in refill_priority:
                if refills > 0 and self.stones[node] != DESTROYED:
                    self.stones[node] = color
                    kept.append(node)
                    refills -= 1

        self.update()

        # Resolve spell effect (optionally with target overrides)
        resolve_actions = self._resolve_spell(
            spell_name, color, position_nodes, target_overrides=target_overrides)
        actions.extend(resolve_actions)

        self.update()

        # Lock management (non-charms only)
        if not is_charm:
            if self.lock[color] == spell_name:
                self.springlock[color] = spell_name
            else:
                self.lock[color] = spell_name
                self.springlock[color] = None
            # Deathmatch removes the counter (mirrors sim-board.js).
            if not variant_has_deathmatch(self.variant):
                self.spell_counter[color] += 1

        cast_action = Action('cast', spell=spell_name, kept=kept)
        return [cast_action] + actions

    # ---- Legal turn enumeration ----

    def get_legal_turns(self, color):
        """Generate legal CompleteTurn objects for the given color.

        Uses greedy heuristics for spell sub-actions to keep branching manageable.
        Yields CompleteTurn objects.
        """
        self.update()
        enemy = self._enemy(color)

        # Competitive variant opening: red and blue each get a free
        # blink onto any empty node on their first turn. No dash, no
        # cast. Bound matches the openingPass gate in update() — see
        # the comment there for the convention reasoning.
        if variant_has_competitive(self.variant) and self.turn_counter <= 2:
            for n in NODE_ORDER:
                if self.stones[n] is not None:
                    continue
                yield CompleteTurn([
                    Action('blink', node=n),
                    Action('pass'),
                ])
            return

        has_seal_of_wind = 'Seal_of_Wind' in self.charged_spells[color]
        has_seal_of_lightning = 'Seal_of_Lightning' in self.charged_spells[color]
        has_seal_of_summer = 'Seal_of_Summer' in self.charged_spells[color]

        # Phase 1: Move options. Seal of Stone (enemy-held) forces a SOFT
        # opening move — no pushes. Wind's blink privilege survives it on
        # EMPTY nodes (a soft blink is a soft move); only hard blinks onto
        # occupied nodes are barred (2026-08 clarification).
        enemy_has_stone = 'Seal_of_Stone' in self.charged_spells[self._enemy(color)]
        if enemy_has_stone and has_seal_of_wind:
            move_targets = self._soft_blinkable(color)
        elif enemy_has_stone:
            move_targets = self._soft_moveable(color)
        elif has_seal_of_wind:
            move_targets = self._blinkable(color)
        else:
            move_targets = self._all_moveable(color)

        if not move_targets:
            # Must pass if no moves available (a Providence placement, which
            # ignores Stone's soft-only rule, may still be possible).
            yield CompleteTurn([Action('pass')])
            yield from self._enumerate_providence_step(color, [])
            return

        for move_target in move_targets:
            board_after_move = self.copy()
            is_blink = has_seal_of_wind and not any(
                board_after_move.stones[nb] == color
                for nb in board_after_move._adjacent_nodes(move_target)
            )
            move_action = board_after_move._do_move(color, move_target, is_blink=is_blink)
            if move_action is None:
                continue
            board_after_move.update()

            # Phase 2: optional Providence placement, then dash/cast/pass.
            yield from board_after_move._enumerate_post_move(
                color, [move_action], can_dash=True, can_spell=True, can_summer=True)
            yield from board_after_move._enumerate_providence_step(
                color, [move_action])

    def _do_providence_move(self, color, node_name):
        """Place one banked stone at node_name (soft or hard move, never a
        blink). Returns the Action flagged providence=True, or None."""
        act = self._do_move(color, node_name)
        if act is None:
            return None
        act.providence = True
        self.prov_bank[color] -= 1
        self.update()
        return act

    def _enumerate_providence_step(self, color, actions_so_far):
        """Providence: with a nonempty bank, the mover may place one banked
        stone after the regular move, then proceed to dash/cast/pass.
        (Skipping it is the caller's plain post-move branch.) Greedy engine:
        a single target, matching the greedy dash convention; the exhaustive
        enumerator branches over top-K targets instead.

        Wind's blink privilege and Stone's soft-move restriction apply only
        to the regular move, so the placement uses _all_moveable.
        """
        if self.prov_bank[color] <= 0 or self.gameover:
            return
        targets = self._all_moveable(color)
        if not targets:
            return
        b = self.copy()
        act = b._do_providence_move(color, targets[0])
        if act is None:
            return
        yield from b._enumerate_post_move(
            color, actions_so_far + [act], can_dash=True, can_spell=True,
            can_summer=True)

    def _enumerate_post_move(self, color, actions_so_far, can_dash, can_spell, can_summer):
        """Enumerate post-move options: dash, spell, or pass."""
        enemy = self._enemy(color)
        has_seal_of_lightning = 'Seal_of_Lightning' in self.charged_spells[color]
        has_seal_of_summer = 'Seal_of_Summer' in self.charged_spells[color]
        has_autumn = 'Autumn' in self.charged_spells[enemy]

        # Option: pass (always available)
        yield CompleteTurn(actions_so_far + [Action('pass')])

        # Option: dash (if allowed and enough stones)
        if can_dash and can_spell and self.totalstones[color] > 2 and not has_autumn:
            dash_targets = self._all_moveable(color)
            if dash_targets:
                # For each possible dash, we do it greedily (one dash variant)
                board_d = self.copy()
                dash_actions = []

                if has_seal_of_lightning:
                    # Sacrifice 1 stone
                    sac = None
                    for name in reversed(NODE_ORDER):
                        if board_d.stones[name] == color:
                            sac = name
                            break
                    if sac:
                        board_d.stones[sac] = None
                        board_d.update()
                        # Move
                        targets = board_d._all_moveable(color)
                        if targets:
                            chosen = targets[0]
                            move_act = board_d._do_move(color, chosen)
                            if move_act:
                                dash_actions.append(Action('dash_lightning',
                                                           sacrificed=[sac], node=chosen))
                                dash_actions.append(move_act)
                                board_d.update()
                                yield from board_d._enumerate_post_dash(
                                    color, actions_so_far + dash_actions,
                                    can_spell=can_spell, can_summer=can_summer)
                else:
                    # Sacrifice 2 stones
                    sacs = []
                    for name in reversed(NODE_ORDER):
                        if board_d.stones[name] == color and len(sacs) < 2:
                            sacs.append(name)
                            board_d.stones[name] = None
                    if len(sacs) == 2:
                        board_d.update()
                        targets = board_d._all_moveable(color)
                        if targets:
                            chosen = targets[0]
                            move_act = board_d._do_move(color, chosen)
                            if move_act:
                                dash_actions.append(Action('dash', sacrificed=sacs, node=chosen))
                                dash_actions.append(move_act)
                                board_d.update()
                                yield from board_d._enumerate_post_dash(
                                    color, actions_so_far + dash_actions,
                                    can_spell=can_spell, can_summer=can_summer)

        # Option: cast spells
        if can_spell or (not can_spell and has_seal_of_summer and can_summer):
            castable = self._get_castable_spells(color, can_spell, can_summer)
            for spell_name in castable:
                board_s = self.copy()
                spell_actions = board_s._cast_spell(spell_name, color)
                board_s.update()
                if CORE_SPELLS[spell_name].get('extra_cast'):
                    # Rapids: the cast reopens the spell window once — one
                    # more cast, never a dash. Seal of Summer's own window
                    # is spent only if THIS was the Summer cast.
                    yield from board_s._enumerate_post_move(
                        color, actions_so_far + spell_actions,
                        can_dash=False, can_spell=True,
                        can_summer=(can_summer if can_spell else False))
                elif can_spell:
                    yield from board_s._enumerate_post_move(
                        color, actions_so_far + spell_actions,
                        can_dash=can_dash, can_spell=False, can_summer=can_summer)
                else:
                    yield from board_s._enumerate_post_move(
                        color, actions_so_far + spell_actions,
                        can_dash=can_dash, can_spell=False, can_summer=False)

    def _enumerate_post_dash(self, color, actions_so_far, can_spell, can_summer):
        """After dashing, can cast spells or pass."""
        yield CompleteTurn(actions_so_far + [Action('pass')])

        has_seal_of_summer = 'Seal_of_Summer' in self.charged_spells[color]

        if can_spell or (not can_spell and has_seal_of_summer and can_summer):
            castable = self._get_castable_spells(color, can_spell, can_summer, post_dash=True)
            for spell_name in castable:
                board_s = self.copy()
                spell_actions = board_s._cast_spell(spell_name, color)
                board_s.update()
                if CORE_SPELLS[spell_name].get('extra_cast'):
                    # Rapids after a dash: one more (post-dash) cast or pass.
                    yield from board_s._enumerate_post_dash(
                        color, actions_so_far + spell_actions,
                        can_spell=True,
                        can_summer=(can_summer if can_spell else False))
                    continue
                # After spell, can only pass or cast summer spell
                yield CompleteTurn(actions_so_far + spell_actions + [Action('pass')])

    def _get_castable_spells(self, color, can_spell, can_summer, post_dash=False):
        """Return list of spell names that can be cast.

        `post_dash` is True when called after a dash this turn. Surge and
        Splash have opposite dash gates: Surge is only castable after a dash
        (and is not modeled in the sim — see below), Splash only when the
        caster has NOT dashed.
        """
        enemy = self._enemy(color)
        has_winter = 'Seal_of_Winter' in self.charged_spells[enemy]
        has_spring = 'Seal_of_Spring' in self.charged_spells[color]
        has_seal_of_summer = 'Seal_of_Summer' in self.charged_spells[color]

        castable = []
        for spell_name in self.charged_spells[color]:
            info = CORE_SPELLS.get(spell_name)
            if info is None or info['static']:
                continue

            if info['ischarm']:
                if has_winter:
                    continue
                if base_spell_name(spell_name) == 'Surge':
                    # Surge can only be cast if we dashed this turn
                    # (caller manages this via can_dash flag)
                    continue
                if base_spell_name(spell_name) == 'Splash' and post_dash:
                    # Splash is the inverse of Surge: castable only if we
                    # have NOT dashed this turn.
                    continue
                if not can_spell and has_seal_of_summer and can_summer:
                    castable.append(spell_name)
                elif can_spell:
                    castable.append(spell_name)
            else:
                if self.lock[color] == spell_name:
                    if has_spring and self.springlock[color] != spell_name:
                        castable.append(spell_name)
                else:
                    castable.append(spell_name)
        return castable

    # ---- Turn application ----

    def apply_turn(self, turn):
        """Apply a CompleteTurn to this board, mutating state.

        Note: This replays the actions, which may not perfectly match
        because spell resolutions are greedy. For search purposes,
        we apply turns by copying + executing rather than replaying.
        """
        # Turns are applied by the search via copy + get_legal_turns,
        # so each CompleteTurn already contains the result of execution.
        # This method is mainly for external use.
        pass

    # ---- Serialization ----

    def to_sfn(self):
        from notation import board_to_sfn as _to_sfn_func
        # Create a minimal adapter
        class _Adapter:
            pass
        board = _Adapter()
        board.nodes = {n: _Adapter() for n in NODE_ORDER}
        for n in NODE_ORDER:
            board.nodes[n].stone = self.stones[n]
        board.spells = []
        for name in self.spell_names:
            s = _Adapter()
            s.name = name
            board.spells.append(s)
        board.whoseturn = self.whose_turn
        board.turncounter = self.turn_counter
        board.score = self.score
        board.variant = self.variant
        board.redplayer = _Adapter()
        board.blueplayer = _Adapter()
        board.redplayer.spellcounter = self.spell_counter['red']
        board.blueplayer.spellcounter = self.spell_counter['blue']
        board.redplayer.lock = _Adapter() if self.lock['red'] else None
        board.blueplayer.lock = _Adapter() if self.lock['blue'] else None
        if board.redplayer.lock:
            board.redplayer.lock.name = self.lock['red']
        if board.blueplayer.lock:
            board.blueplayer.lock.name = self.lock['blue']
        board.redplayer.springlock = _Adapter() if self.springlock['red'] else None
        board.blueplayer.springlock = _Adapter() if self.springlock['blue'] else None
        if board.redplayer.springlock:
            board.redplayer.springlock.name = self.springlock['red']
        if board.blueplayer.springlock:
            board.blueplayer.springlock.name = self.springlock['blue']
        board.prov_bank = dict(self.prov_bank)
        return _to_sfn_func(board)

    @classmethod
    def from_sfn(cls, sfn_str):
        from notation import sfn_to_dict
        d = sfn_to_dict(sfn_str)
        b = cls(spell_names=d['spell_names'], variant=d.get('variant', 'standard'))
        b.stones = dict(d['stones'])
        b.whose_turn = d['turn']
        b.turn_counter = d['turncounter']
        b.spell_counter = {'red': d['red_spellcounter'], 'blue': d['blue_spellcounter']}
        b.lock = {'red': d['red_lock'], 'blue': d['blue_lock']}
        b.springlock = {'red': d['red_springlock'], 'blue': d['blue_springlock']}
        b.score = d['score']
        # Providence banks ride the optional pm: token.
        b.prov_bank = {'red': d.get('red_bank', 0), 'blue': d.get('blue_bank', 0)}
        b.update()
        return b


def apply_sim_turn(board, turn, color):
    """Replay a recorded CompleteTurn's actions onto `board` (mutating).

    Exact Python mirror of sim-board.js:applySimTurn — the canonical way to
    re-apply a recorded turn. Casts replay as BOOKKEEPING only (sacrifice the
    sigil, place the recorded kept stones, advance lock/counter): the
    resolver's effects are already present as separate recorded actions, and
    re-running _cast_spell here would both double-apply them (e.g. Slash's
    recorded hard_moves would push twice) and silently discard the
    enumerator's target choices by re-resolving greedily. Recorded push
    destinations are honored. Ends with the Seal of Destruction end-of-turn
    trigger; the start-of-turn half stays with the turn driver.
    """
    enemy = board._enemy(color)
    for action in turn.actions:
        t = action.type
        if action.providence:
            board.prov_bank[color] -= 1
        if t == 'move':
            board.stones[action.node] = color
        elif t == 'hard_move':
            board._push_enemy(action.node, color, action.pushed_to)
        elif t == 'blink':
            if board.stones[action.node] == enemy:
                board._push_enemy(action.node, color, action.pushed_to)
            else:
                board.stones[action.node] = color
        elif t == 'cast':
            info = CORE_SPELLS.get(action.spell)
            try:
                spell_idx = board.spell_names.index(action.spell)
            except ValueError:
                spell_idx = -1
            pos_nodes = POSITIONS.get(spell_idx + 1, []) if spell_idx >= 0 else []
            for n in pos_nodes:
                if board.stones[n] != DESTROYED:
                    board.stones[n] = None
            # Spells absent from the Python CORE_SPELLS (Autumn's
            # Gather/Harvest — live-only) still lock and count on replay:
            # the JS replayers know them as non-charms, and silently
            # skipping the bookkeeping here desyncs the two engines.
            # (Seal_of_Autumn is a static and never appears as a cast.)
            if info is None or not info.get('ischarm'):
                if action.kept:
                    for n in action.kept:
                        board.stones[n] = color
                if board.lock[color] == action.spell:
                    board.springlock[color] = action.spell
                else:
                    board.lock[color] = action.spell
                    board.springlock[color] = None
                # Deathmatch removes the counter (mirrors sim-board.js).
                if not variant_has_deathmatch(board.variant):
                    board.spell_counter[color] += 1
        elif t in ('dash', 'dash_lightning'):
            if action.sacrificed:
                for sac in action.sacrificed:
                    board.stones[sac] = None
        # Resolver-emitted outcomes — apply the recorded result directly.
        elif t == 'sacrifice':
            if action.node:
                board.stones[action.node] = None
        elif t in ('fireblast', 'hail_storm', 'storm_front', 'hurricane',
                   'decay'):
            if action.destroyed:
                for n in action.destroyed:
                    board.stones[n] = None
        elif t == 'bewitch':
            if action.node:
                board.stones[action.node] = color
            if action.node2:
                board.stones[action.node2] = color
        elif t == 'starfall':
            if action.node:
                board.stones[action.node] = color
            if action.node2:
                board.stones[action.node2] = color
            if action.destroyed:
                for n in action.destroyed:
                    board.stones[n] = None
        elif t == 'meteor_destroy':
            if action.node:
                board.stones[action.node] = None
        elif t == 'gust':
            if action.destroyed:
                for n in action.destroyed:
                    board.stones[n] = None
            if action.kept:
                for n in action.kept:
                    board.stones[n] = enemy
        elif t == 'corrupt':
            if action.converted:
                for n in action.converted:
                    board.stones[n] = color
        elif t == 'fissure':
            if action.destroyed:
                for n in action.destroyed:
                    board.stones[n] = None
            if action.wall:
                board.stones[action.wall] = DESTROYED
        elif t == 'rock_slide':
            pushes = action.pushes or []
            final, _ = resolve_rock_slide(
                board.stones, pushes,
                rock_slide_replay_protected(board.stones, pushes, action.destroyed))
            board.stones.update(final)
        elif t == 'bank_stones':
            board.prov_bank[color] += action.banked or 0
        board.update()
    # Seal of Destruction end-of-turn trigger (the start-of-turn loss is
    # applied by the turn driver, e.g. minimax _apply_turn / live loops).
    board._destruction_end_of_turn(color)
