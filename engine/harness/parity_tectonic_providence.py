"""Differential test of the Tectonic + Providence port against simboard.py.

Covers what the 2026-10 port added to the Rust engine:
  * walls (Fissure's destroyed nodes) in move generation and push resolution;
  * Bulwark shields in move generation and in every effect that converts or
    destroys stones, with the step-by-step re-check for sequential effects;
  * Fissure (every target), Rock Slide (every maximum-net outcome), and the
    Providence bank spells;
  * Providence banks in the win check and the optional once-per-turn
    placement in turn enumeration.

The Rust side is the PyO3 module built from this crate: copy
`target/release/libsigil_engine.so` to `sigil_engine.so` on PYTHONPATH (or
`maturin develop`). Run from the repo root:

    PYTHONPATH=<dir with sigil_engine.so>:. python3 engine/harness/parity_tectonic_providence.py
"""
import random
import sys

from simboard import (SimBoard, CORE_SPELLS, DESTROYED, rock_slide_optimal_pushes,
                      resolve_rock_slide, fissure_ranked_targets)
from notation import NODE_ORDER, POSITIONS
import sigil_engine as se

IDX = {n: i for i, n in enumerate(NODE_ORDER)}
RITUALS = ['Fissure', 'Endowment', 'Carnage', 'Bewitch', 'Starfall', 'Hurricane',
           'Corrupt', 'Syzygy', 'Seal_of_Destruction']
SORCERIES = ['Rock_Slide', 'Annuity', 'Fireblast', 'Hail_Storm', 'Meteor',
             'Storm_Front', 'Decay', 'Fury']
CHARMS = ['Bulwark', 'Dividend', 'Slash', 'Gust', 'Sprout', 'Comet']
CASTABLE = ['Fissure', 'Endowment', 'Carnage', 'Bewitch', 'Starfall', 'Hurricane',
            'Corrupt', 'Syzygy', 'Rock_Slide', 'Annuity', 'Fireblast', 'Hail_Storm',
            'Meteor', 'Storm_Front', 'Decay', 'Fury', 'Dividend', 'Slash', 'Gust',
            'Sprout', 'Comet']


def state(b):
    """Stones (with walls) + banks, the comparison key."""
    return b.to_sfn().split('/')[0] + '|%d:%d' % (b.prov_bank['red'], b.prov_bank['blue'])


def random_board(rng, want_bulwark=True):
    draw = rng.sample(RITUALS, 3) + rng.sample(SORCERIES, 3) + rng.sample(CHARMS, 3)
    if want_bulwark and 'Bulwark' not in draw and rng.random() < 0.7:
        draw[6 + rng.randrange(3)] = 'Bulwark'
    b = SimBoard(draw)
    density = rng.choice([0.2, 0.35, 0.5])
    for n in NODE_ORDER:
        r = rng.random()
        b.stones[n] = (DESTROYED if r < 0.04 else
                       'red' if r < 0.04 + density else
                       'blue' if r < 0.04 + 2 * density else None)
    if 'Bulwark' in draw and rng.random() < 0.8:
        owner = rng.choice(['red', 'blue'])
        b.stones[POSITIONS[draw.index('Bulwark') + 1][0]] = owner
        lockpos = rng.randrange(6)
        b.lock[owner] = draw[lockpos]
        for n in POSITIONS[lockpos + 1]:
            if b.stones[n] != DESTROYED and rng.random() < 0.7:
                b.stones[n] = owner
    b.prov_bank = {'red': rng.choice([0, 0, 1, 3]), 'blue': rng.choice([0, 0, 2])}
    b.whose_turn = rng.choice(['red', 'blue'])
    b.turn_counter = 10
    if not any(v == 'red' for v in b.stones.values()):
        b.stones['c13'] = 'red'
    if not any(v == 'blue' for v in b.stones.values()):
        b.stones['c12'] = 'blue'
    b.update()
    return b


def rust(b):
    r = se.Board.from_sfn(b.to_sfn())
    return r


def check_primitives(rng, n=400):
    bad = 0
    for _ in range(n):
        b = random_board(rng)
        r = rust(b)
        assert state(b) == r.to_sfn().split('/')[0] + '|%d:%d' % r.bank, "SFN round trip"
        assert sorted(r.shielded()) == sorted(IDX[x] for x in b._bulwark_protected())
        for c in ('red', 'blue'):
            if sorted(r.all_moveable(c)) != sorted(IDX[x] for x in b._all_moveable(c)):
                bad += 1
            if sorted(r.hard_moveable(c)) != sorted(IDX[x] for x in b._hard_moveable(c)):
                bad += 1
            for t in b._hard_moveable(c)[:3]:
                cp = b.copy()
                dest = cp._push_enemy(t, c)
                opts = r.push_options(IDX[t], c)
                want = None if dest == 'X' else IDX[dest]
                if (opts[0] if opts else None) != want:
                    bad += 1
        # Win check with banks.
        for c in ('red', 'blue'):
            p, q = b.copy(), rust(b)
            p.spell_counter[c] = rng.choice([0, 6])
            q.spell_counter = (p.spell_counter['red'], p.spell_counter['blue'])
            p.check_game_over(c)
            q.check_game_over(c)
            if (p.winner if p.gameover else None) != q.winner:
                bad += 1
    print('primitives: %d mismatches over %d boards' % (bad, n))
    return bad


def python_greedy_state(b, spell, color):
    p = b.copy()
    p._cast_spell(spell, color)
    # _cast_spell also locks/counts; compare the stones/walls/banks only.
    return state(p)


def check_casts(rng, n=250):
    bad = 0
    cases = 0
    truncated = 0
    sets = {'Fissure': [0, 0], 'Rock_Slide': [0, 0]}
    for _ in range(n):
        b = random_board(rng)
        color = b.whose_turn
        for spell in [s for s in b.spell_names if s in CASTABLE]:
            pos = b.spell_names.index(spell)
            # A sigil holding a wall can never be charged, so never cast.
            if any(b.stones[x] == DESTROYED for x in POSITIONS[pos + 1]):
                continue
            r = rust(b)
            rust_states = set(r.outcome_states(pos, color))
            py = python_greedy_state(b, spell, color)
            cases += 1
            if len(rust_states) >= 4096:
                truncated += 1          # the resolver hit OUTCOME_CAP: not a verdict
            elif py not in rust_states:
                bad += 1
                if bad <= 5:
                    print('  greedy not reachable:', spell, color, b.to_sfn())
            # Exact sets for the new spells.
            if spell == 'Fissure':
                want = {state_after(b, spell, color, t) for t in NODE_ORDER
                        if b.stones[t] != DESTROYED}
                sets['Fissure'][0] += 1
                if want != rust_states:
                    bad += 1
                    sets['Fissure'][1] += 1
                    print('  fissure sets differ', len(want), len(rust_states), b.to_sfn())
            if spell == 'Rock_Slide':
                post = post_clear(b, spell, color)
                _, options = rock_slide_optimal_pushes(
                    post.stones, color, protected=post._bulwark_protected())
                want = set()
                for pushes in options:
                    z = post.copy()
                    final, _ = resolve_rock_slide(z.stones, pushes, z._bulwark_protected())
                    z.stones.update(final)
                    z.update()
                    want.add(state(z))
                sets['Rock_Slide'][0] += 1
                if want != rust_states:
                    bad += 1
                    sets['Rock_Slide'][1] += 1
                    print('  rock slide sets differ', len(want), len(rust_states), b.to_sfn())
    sys.stdout.flush()
    print('casts: %d mismatches over %d casts (%d skipped: resolver at OUTCOME_CAP); '
          'exact sets checked/differing: %s' % (bad, cases, truncated, sets))
    return bad


def post_clear(b, spell, color):
    """The board after _cast_spell's sigil clear + refill, before resolving
    (captured by patching the resolver at class level for one call)."""
    q = b.copy()
    orig = SimBoard._resolve_spell
    holder = {}

    def capture(self, name, col, nodes, target_overrides=None):
        holder['b'] = self.copy()
        return []
    SimBoard._resolve_spell = capture
    try:
        q._cast_spell(spell, color)
    finally:
        SimBoard._resolve_spell = orig
    return holder['b']


def state_after(b, spell, color, target):
    q = b.copy()
    q._cast_spell(spell, color, target_overrides={'fissure_target': target})
    return state(q)


def check_turns(rng, n=60):
    """Python's greedy turn results (incl. Providence placements) must be
    reachable in Rust's exhaustive enumeration."""
    bad = 0
    total = 0
    for _ in range(n):
        b = random_board(rng)
        # Keep the enumeration tractable: thin boards only.
        for nn in NODE_ORDER:
            if b.stones[nn] in ('red', 'blue') and rng.random() < 0.75:
                b.stones[nn] = None
        if not any(v == 'red' for v in b.stones.values()):
            b.stones['c13'] = 'red'
        if not any(v == 'blue' for v in b.stones.values()):
            b.stones['c12'] = 'blue'
        b.update()
        if b.gameover:
            continue
        color = b.whose_turn
        r = rust(b)
        rs = r.turn_states()
        if len(rs) >= 1 << 20:
            continue                    # enumeration capped: not a verdict
        rs = set(rs)
        from simboard import apply_sim_turn
        for t in b.get_legal_turns(color):
            q = b.copy()
            apply_sim_turn(q, t, color)
            q.check_game_over(color)
            total += 1
            if state(q) not in rs:
                bad += 1
                if bad <= 5:
                    print('  turn not reachable:', t, b.to_sfn())
    print('turns: %d of %d Python turns unreachable' % (bad, total))
    return bad


def main():
    rng = random.Random(int(sys.argv[1]) if len(sys.argv) > 1 else 20261003)
    bad = check_primitives(rng)
    bad += check_casts(rng)
    bad += check_turns(rng)
    print('TOTAL MISMATCHES:', bad)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
