"""Bulwark buff + Fissure nerf tests (2026-10).

Rules under test:
  * Fissure destroys EVERY stone on the nodes adjacent to its target, the
    caster's own included. The target becomes a permanent wall (its stone
    destroyed) unless it holds a Bulwark-protected stone: then the stone
    stays and no wall forms.
  * Timing: SEQUENTIAL effects (Carnage/Slash/Fury/Torrent/Tsunami hard
    moves, Storm Front picks, Corrupt conversions) re-check Bulwark before
    every step, so taking the Bulwark stone first exposes the locked spell
    to the later steps. SIMULTANEOUS effects (Fireblast, Bewitch, Decay,
    Rock Slide, ...) check once at cast time: the locked spell stays
    immune even when the same effect destroys the Bulwark stone.
  * Bulwark: a player holding Bulwark charged protects their own stones in
    their locked spell from enemy hard moves (as before), from conversion
    (Bewitch, Corrupt, Residue Mixture, Shiver) and from destruction by any
    effect (Fireblast, Hail Storm, Starfall, Meteor, Storm Front, Hurricane,
    Decay, Seal of Destruction, Rock Slide collisions, Fissure — their own
    Fissure included). Gust can't pick them up and Rock Slide doesn't push
    them; a stone pushed into one dies, as if into a wall. Sacrifices are
    unaffected.

Python sim, JS sim (parity), the interactive spells.js resolvers and the
live Python spellfile are all checked.

Run: python -m ai.test_bulwark
"""
import json
import os
import subprocess
import time

from simboard import (SimBoard, DESTROYED, bulwark_protected_nodes,
                      fissure_blast, fissure_ranked_targets)
from notation import NODE_ORDER, POSITIONS

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')

# Red holds Bulwark (slot 6 -> a7) with Carnage (slot 1 -> b2..b6) locked:
# b2..b6 are the shielded stones. Blue is the attacker.
SP = ['Fissure', 'Carnage', 'Bewitch', 'Rock_Slide', 'Fireblast',
      'Hail_Storm', 'Bulwark', 'Slash', 'Surge']
SHIELD = POSITIONS[2]
RED = list(SHIELD) + ['a7', 'c8', 'c9']
BLUE = ['b1', 'b13', 'b7', 'b11', 'a1', 'c1', 'a8']

# (label, spell list, red stones, blue stones, red lock, caster, spell,
#  overrides, expect_hit_without_bulwark)
SYZ_SP = ['Syzygy', 'Carnage', 'Bewitch', 'Rock_Slide', 'Fireblast',
          'Hail_Storm', 'Bulwark', 'Slash', 'Surge']
DEST_SP = ['Seal_of_Destruction', 'Carnage', 'Bewitch', 'Rock_Slide',
           'Fireblast', 'Hail_Storm', 'Bulwark', 'Slash', 'Surge']
SCENARIOS = [
    ('fireblast', SP, RED, BLUE, 'Carnage', 'blue', 'Fireblast', {}, True),
    ('hail_storm', SP, RED, BLUE, 'Carnage', 'blue', 'Hail_Storm', {}, True),
    ('bewitch', SP, RED, BLUE, 'Carnage', 'blue', 'Bewitch',
     {'bewitch_pair': ['b2', 'b3']}, True),
    # A refused shielded pick falls back to the first legal stone (a7, the
    # Bulwark stone itself, here); there is no pick left to exploit that.
    ('storm_front', SP, RED, BLUE, 'Carnage', 'blue', 'Storm_Front',
     {'storm_front_pair': ['b2', 'c8']}, True),
    # (No blue stone touches the Bulwark stone here; breaking it first is
    # covered by test_sequential_effects_can_break_bulwark.)
    ('corrupt', SP, RED, [n for n in BLUE if n != 'a8'], 'Carnage', 'blue', 'Corrupt',
     {'corrupt_targets': ['b2', 'b3', 'b6']}, True),
    ('gust', SP, RED, BLUE, 'Carnage', 'blue', 'Gust', {}, True),
    ('hurricane', SP, list(SHIELD) + ['a7'], BLUE, 'Carnage', 'blue',
     'Hurricane', {}, False),
    ('decay', SP, RED, ['b1'], 'Carnage', 'blue', 'Decay', {}, False),
    ('starfall', SP, RED, BLUE, 'Carnage', 'blue', 'Starfall',
     {'starfall_pair': ['b12', 'b10']}, False),
    ('meteor', SP, RED, BLUE, 'Carnage', 'blue', 'Meteor',
     {'meteor_target': 'b12'}, True),
    ('rock_slide', SP, RED, BLUE, 'Carnage', 'blue', 'Rock_Slide', {}, True),
    ('fissure_enemy', SP, RED, BLUE, 'Carnage', 'blue', 'Fissure',
     {'fissure_target': 'b3'}, True),
    ('fissure_own', SP, RED, BLUE, 'Carnage', 'red', 'Fissure',
     {'fissure_target': 'b1'}, True),
    ('syzygy', SYZ_SP, POSITIONS[5] + ['a7'], ['b12', 'c12', 'a1'],
     'Fireblast', 'blue', 'Syzygy', {}, True),
]


# Sequential effects: break Bulwark at a7 first (blue on a8 touches it),
# then hit b2 (blue on b1 touches it). Caster is blue.
SEQUENTIAL = [
    ('carnage', 'Carnage', {'hard_move_targets': ['a7', 'b2']}),
    ('slash_then_nothing', 'Slash', {'hard_move_targets': ['a7', 'b2']}),
    ('fury', 'Fury', {'fury_sacrifice': 'c1', 'hard_move_targets': ['a7', 'b2']}),
    ('tsunami', 'Tsunami', {'soft_move_targets': ['b12', 'c2'],
                            'hard_move_targets': ['a7', 'b2']}),
    ('storm_front', 'Storm_Front', {'storm_front_pair': ['a7', 'b2']}),
    ('corrupt', 'Corrupt', {}),
]
SEQ_RED = list(SHIELD) + ['a7']
SEQ_BLUE = ['b1', 'a8', 'c1', 'a1']


def _seq_outcome(spell, ovr):
    b = _board(SP, SEQ_RED, SEQ_BLUE, 'Carnage')
    b._resolve_spell(spell, 'blue', [], dict(ovr))
    return {n: b.stones[n] for n in NODE_ORDER}


def _board(sp, red, blue, lock, bulwark=True):
    b = SimBoard(sp)
    for n in red:
        b.stones[n] = 'red'
    for n in blue:
        b.stones[n] = 'blue'
    if not bulwark:
        b.stones['a7'] = None
    b.lock['red'] = lock
    b.whose_turn = 'blue'
    b.update()
    return b


def _shielded_nodes(sp, red, lock):
    return [n for n in POSITIONS[sp.index(lock) + 1] if n in red]


def _py_outcome(sc, bulwark=True):
    _, sp, red, blue, lock, caster, spell, ovr, _ = sc
    b = _board(sp, red, blue, lock, bulwark)
    b._resolve_spell(spell, caster, [], dict(ovr))
    return {n: b.stones[n] for n in NODE_ORDER}


def test_protected_set():
    print("Testing bulwark_protected_nodes...")
    b = _board(SP, RED, BLUE, 'Carnage')
    assert 'Bulwark' in b.charged_spells['red']
    assert b._bulwark_protected() == set(SHIELD)
    assert bulwark_protected_nodes(b.stones, SP, b.lock, b.charged_spells) == set(SHIELD)
    nb = _board(SP, RED, BLUE, 'Carnage', bulwark=False)
    assert nb._bulwark_protected() == set()
    b.lock['red'] = None
    assert b._bulwark_protected() == set(), "no lock, nothing to shield"
    print("  PASS")


def test_every_effect_spares_shielded_stones():
    print("Testing every destructive/converting effect spares shielded stones...")
    for sc in SCENARIOS:
        label, sp, red, _, lock = sc[:5]
        shield = _shielded_nodes(sp, red, lock)
        after = _py_outcome(sc)
        assert all(after[n] == 'red' for n in shield), (label, after)
        if sc[-1]:
            before = _py_outcome(sc, bulwark=False)
            assert any(before[n] != 'red' for n in shield), \
                (label, 'scenario should hit a stone when Bulwark is absent')
    print("  PASS")


def test_sequential_effects_can_break_bulwark():
    print("Testing sequential effects: Bulwark stone first, then the locked spell...")
    for label, spell, ovr in SEQUENTIAL:
        after = _seq_outcome(spell, ovr)
        assert after['a7'] != 'red', (label, 'the Bulwark stone is taken', after)
        if label == 'slash_then_nothing':
            # Slash makes ONE hard move: the shield drops but no step is left.
            assert all(after[n] == 'red' for n in SHIELD), (label, after)
        else:
            assert after['b2'] != 'red', (label, 'b2 is hit after the break', after)
    # Simultaneous effects stay immune even when they take the Bulwark
    # stone too (Fireblast destroys a7 via a8 here).
    after = _py_outcome(next(sc for sc in SCENARIOS if sc[0] == 'fireblast'))
    assert after['a7'] is None and all(after[n] == 'red' for n in SHIELD), after
    # Breaker-aware enumerators offer the Storm Front break.
    from ai.enumerator import _spell_overrides, DEFAULT_CAPS
    b = _board(SP, SEQ_RED, SEQ_BLUE, 'Carnage')
    assert {'storm_front_pair': ['a7', 'b2']} in _spell_overrides(
        b, 'blue', 'Storm_Front', dict(DEFAULT_CAPS))
    print("  PASS")


def test_destruction_seal():
    print("Testing Seal of Destruction spares shielded stones...")
    for bulwark in (True, False):
        b = _board(DEST_SP, RED, BLUE + list(POSITIONS[1]), 'Carnage', bulwark)
        assert 'Seal_of_Destruction' in b.charged_spells['blue']
        b._destruction_end_of_turn('blue')
        alive = [n for n in SHIELD if b.stones[n] == 'red']
        assert (alive == list(SHIELD)) == bulwark, (bulwark, alive)
    print("  PASS")


def test_fissure_rules():
    print("Testing Fissure (own stones destroyed, shielded target stays)...")
    stones = {n: None for n in NODE_ORDER}
    stones.update(a1='red', a2='blue', a11='red', a6='red')
    destroyed, wall = fissure_blast(stones, 'a2')
    assert wall == 'a2' and set(destroyed) == {'a1', 'a6', 'a2'}, (destroyed, wall)
    destroyed, wall = fissure_blast(stones, 'a11')
    assert wall == 'a11' and set(destroyed) == {'a1', 'a6', 'a11'}
    destroyed, wall = fissure_blast(stones, 'a11', protected={'a11', 'a6'})
    assert wall is None and destroyed == ['a1'], (destroyed, wall)
    # Greedy ranking: own losses count against a target.
    ranked = fissure_ranked_targets(stones, 'blue')
    assert ranked[0] in ('a6', 'a11', 'a1'), ranked
    stones['a12'] = DESTROYED
    assert 'a12' not in fissure_ranked_targets(stones, 'blue'), "walls aren't targets"

    sc = next(s for s in SCENARIOS if s[0] == 'fissure_enemy')
    after = _py_outcome(sc)
    assert after['b3'] == 'red', "shielded target keeps its stone"
    assert DESTROYED not in after.values(), "no wall under a shielded target"
    assert after['b13'] is None, "the caster's own adjacent stone is destroyed"
    before = _py_outcome(sc, bulwark=False)
    assert before['b3'] == DESTROYED and before['b2'] is None and before['b4'] is None
    own = _py_outcome(next(s for s in SCENARIOS if s[0] == 'fissure_own'))
    assert own['b1'] == DESTROYED and own['b2'] == 'red', \
        "Bulwark shields its owner's stones from their own Fissure"
    print("  PASS")


def test_rock_slide_shield_brute_force():
    print("Testing Rock Slide with shields against brute force...")
    import itertools
    import random
    from simboard import (rock_slide_sources, resolve_rock_slide, rock_slide_replay_protected,
                          rock_slide_optimal_pushes)
    from notation import ADJACENCY
    rng = random.Random(77)
    checked = 0
    while checked < 200:
        stones = {}
        for n in NODE_ORDER:
            r = rng.random()
            stones[n] = DESTROYED if r < 0.04 else (
                rng.choice(['red', 'blue']) if r < 0.7 else None)
        occupied = [n for n in NODE_ORDER if stones[n] in ('red', 'blue')]
        prot = set(rng.sample(occupied, min(len(occupied), rng.randint(0, 6))))
        srcs = rock_slide_sources(stones, 'red', prot)
        if len(srcs) > 7:
            continue
        checked += 1
        assert not (set(srcs) & prot), "shielded stones are never pushed"
        best = None
        for combo in itertools.product(*[ADJACENCY[s] for s in srcs]):
            pushes = [{'from': s, 'to': d} for s, d in zip(srcs, combo)]
            final, lost = resolve_rock_slide(stones, pushes, prot)
            for n in prot:
                assert final.get(n, stones[n]) == stones[n], "shielded stone moved or died"
            # A replay re-derives the shield from the recorded `destroyed`
            # list; it must reproduce the same board.
            destroyed = list(dict.fromkeys(n for n, _ in lost))
            replay_prot = rock_slide_replay_protected(stones, pushes, destroyed)
            assert resolve_rock_slide(stones, pushes, replay_prot)[0] == final, \
                "replay from the destroyed list disagrees"
            net = sum(1 if c != 'red' else -1 for _, c in lost)
            best = net if best is None else max(best, net)
        got, options = rock_slide_optimal_pushes(stones, 'red', protected=prot)
        assert got == (best if best is not None else 0), (got, best)
        for pushes in options:
            _, lost = resolve_rock_slide(stones, pushes, prot)
            assert sum(1 if c != 'red' else -1 for _, c in lost) == got
    print("  PASS (200 positions)")


def test_enumerator_overrides():
    print("Testing enumerator overrides skip shielded stones...")
    from ai.enumerator import _spell_overrides, DEFAULT_CAPS
    b = _board(SP, RED, BLUE, 'Carnage')
    caps = dict(DEFAULT_CAPS)
    for o in _spell_overrides(b, 'blue', 'Bewitch', caps):
        assert not (set(o.get('bewitch_pair', ())) & set(SHIELD)), o
    for o in _spell_overrides(b, 'blue', 'Storm_Front', caps):
        pair = o.get('storm_front_pair', [])
        if pair and pair[0] not in SHIELD:
            # A shielded second pick only after the Bulwark stone is taken.
            assert pair[1] not in SHIELD or pair[0] == 'a7', o
        assert not pair or pair[0] not in SHIELD, o
    for o in _spell_overrides(b, 'blue', 'Hurricane', caps):
        assert not (set(o.get('hurricane_group', ())) & set(SHIELD)), o
    print("  PASS")


def _load_js(files):
    out = []
    for fn in files:
        with open(os.path.join(ENGINE, fn), encoding='utf-8') as f:
            out.append(f.read())
    return out


def _run_node(js, marker):
    proc = subprocess.run(['node', '-'], input='\n'.join(js),
                          capture_output=True, text=True, timeout=180)
    for line in proc.stdout.splitlines():
        if line.startswith(marker + ' '):
            return json.loads(line[len(marker) + 1:])
    print(proc.stdout[-2000:])
    print(proc.stderr[-2000:])
    raise AssertionError('node run failed')


def test_js_sim_parity():
    print("Testing JS sim parity on every scenario (with and without Bulwark)...")
    js = _load_js(('constants.js', 'notation.js', 'moves.js', 'spells.js',
                   'sim-board.js', 'enumerator.js'))
    payload = [list(sc[:8]) for sc in SCENARIOS]
    js.append(r"""
const SC = %s;
const DEST_SP = %s, RED = %s, BLUE = %s, SHIELD = %s;
function mk(sp, red, blue, lock, bulwark) {
  const b = new SimBoard(sp);
  for (const n of red) b.stones[n] = 'red';
  for (const n of blue) b.stones[n] = 'blue';
  if (!bulwark) b.stones.a7 = null;
  b.lock.red = lock; b.whoseTurn = 'blue'; b.update();
  return b;
}
const out = {};
for (const [label, sp, red, blue, lock, caster, spell, ovr] of SC) {
  for (const bw of [true, false]) {
    const b = mk(sp, red, blue, lock, bw);
    b._resolveSpell(spell, caster, [], JSON.parse(JSON.stringify(ovr)));
    out[label + (bw ? '' : '-nb')] = Object.fromEntries(NODE_ORDER.map(n => [n, b.stones[n]]));
  }
}
const d = mk(DEST_SP, RED, BLUE.concat(POSITIONS[1]), 'Carnage', true);
destructionEndOfTurn(d, 'blue');
out.destruction = Object.fromEntries(NODE_ORDER.map(n => [n, d.stones[n]]));
out.sequential = {};
for (const [label, spell, ovr] of %s) {
  const b = mk(%s, %s, %s, 'Carnage', true);
  b._resolveSpell(spell, 'blue', [], JSON.parse(JSON.stringify(ovr)));
  out.sequential[label] = Object.fromEntries(NODE_ORDER.map(n => [n, b.stones[n]]));
}
// Enumerators never target shielded stones.
const e = mk(%s, RED, BLUE, 'Carnage', true);
const bad = [];
for (const spell of ['Bewitch', 'Storm_Front', 'Hurricane']) {
  for (const o of _spellOverrides(e, 'blue', spell, ENUM_CAPS)) {
    // A Storm Front pair may name a shielded stone second, after the
    // Bulwark stone (a7) is taken first.
    const sf = o.storm_front_pair || [];
    const nodes = [].concat(o.bewitch_pair || [], o.hurricane_group || [],
      sf[0] === 'a7' ? [] : sf);
    if (nodes.some(n => SHIELD.includes(n))) bad.push([spell, o]);
  }
}
out.badOverrides = bad;
console.log('JS_RESULT ' + JSON.stringify(out));
""" % (json.dumps(payload), json.dumps(DEST_SP), json.dumps(RED), json.dumps(BLUE),
       json.dumps(list(SHIELD)), json.dumps(SEQUENTIAL), json.dumps(SP),
       json.dumps(SEQ_RED), json.dumps(SEQ_BLUE), json.dumps(SP)))
    res = _run_node(js, 'JS_RESULT')
    for label, spell, ovr in SEQUENTIAL:
        py = _seq_outcome(spell, ovr)
        assert res['sequential'][label] == py, (label, {
            n: (py[n], res['sequential'][label][n]) for n in NODE_ORDER
            if py[n] != res['sequential'][label][n]})
    for sc in SCENARIOS:
        for bw in (True, False):
            key = sc[0] + ('' if bw else '-nb')
            py = _py_outcome(sc, bulwark=bw)
            assert res[key] == py, (key, {n: (py[n], res[key][n]) for n in NODE_ORDER
                                          if py[n] != res[key][n]})
    b = _board(DEST_SP, RED, BLUE + list(POSITIONS[1]), 'Carnage')
    b._destruction_end_of_turn('blue')
    assert res['destruction'] == {n: b.stones[n] for n in NODE_ORDER}
    assert res['badOverrides'] == [], res['badOverrides']
    print("  PASS")


def test_live_spells_js():
    print("Testing interactive spells.js resolvers (scripted input)...")
    js = _load_js(('constants.js', 'notation.js', 'moves.js', 'spells.js', 'board.js'))
    js.append(r"""
const SP = %s, RED = %s, BLUE = %s;
function mk(bulwark) {
  const b = new SigilBoard(SP, 'standard');
  for (const n of NODE_ORDER) b.stones[n] = null;
  for (const n of RED) b.stones[n] = 'red';
  for (const n of BLUE) b.stones[n] = 'blue';
  if (!bulwark) b.stones.a7 = null;
  b.lock.red = 'Carnage';
  b.update();
  return b;
}
async function run(resolver, color, script, bulwark = true) {
  const b = mk(bulwark);
  const prompts = [];
  const q = script.slice();
  const getInput = async (p) => {
    prompts.push(Object.keys(p.moveoptions || {}));
    if (!q.length) throw new Error('script exhausted: ' + JSON.stringify(p));
    return q.shift();
  };
  await SpellResolvers[resolver](b, color, 'X', getInput, () => {});
  return { stones: Object.fromEntries(NODE_ORDER.map(n => [n, b.stones[n]])), prompts, left: q.length };
}
(async () => {
  const out = {};
  // Fissure at a shielded node: stone stays, no wall, b13 (blue's own) dies.
  out.fissure = await run('fissure', 'blue', ['b3']);
  // Storm Front: clicks on shielded stones are refused; b9? use c8/c9.
  out.storm = await run('storm_front', 'blue', ['b2', 'b3', 'c8', 'c9']);
  // Bewitch: shielded stones aren't offered.
  out.bewitch = await run('bewitch', 'blue', ['c8', 'c9']);
  out.fireblast = await run('fireblast', 'blue', ['b1']);
  // Sequential: Storm Front takes the Bulwark stone, then a locked stone.
  out.stormBreak = await run('storm_front', 'blue', ['a7', 'b2']);
  console.log('JS_RESULT ' + JSON.stringify(out));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
""" % (json.dumps(SP), json.dumps(RED), json.dumps(BLUE)))
    res = _run_node(js, 'JS_RESULT')
    f = res['fissure']['stones']
    assert f['b3'] == 'red' and f['b2'] == 'red' and f['b4'] == 'red', f
    assert f['b13'] is None and DESTROYED not in f.values(), f
    s = res['storm']['stones']
    assert all(s[n] == 'red' for n in SHIELD) and s['c8'] is None and s['c9'] is None, s
    assert res['storm']['left'] == 0
    bw = res['bewitch']
    assert not (set(bw['prompts'][0]) & set(SHIELD)), bw['prompts'][0]
    fb = res['fireblast']['stones']
    assert all(fb[n] == 'red' for n in SHIELD), fb
    sb = res['stormBreak']['stones']
    assert sb['a7'] is None and sb['b2'] is None, sb
    print("  PASS")


class _FakePlayer:
    def __init__(self, board, color, ishuman, script=()):
        self.board = board
        self.color = color
        self.enemy = 'blue' if color == 'red' else 'red'
        self.ishuman = ishuman
        self.script = list(script)
        self.messages = []
        self.lock = None
        self.charged_spells = []
        self.opp = None

    def jmessage(self, msg, awaiting=None):
        self.messages.append(msg)

    def receivemessage(self):
        return self.script.pop(0)


def test_live_spellfile():
    print("Testing live spellfile resolvers (Fissure, Storm Front, Fireblast)...")
    import game
    import spellfile

    def setup():
        board = game.Board()
        for name in board.nodes:
            board.nodes[name].stone = None
        for n in RED:
            board.nodes[n].stone = 'red'
        for n in BLUE:
            board.nodes[n].stone = 'blue'
        board.update = lambda *a, **k: None
        blue = _FakePlayer(board, 'blue', False)
        red = _FakePlayer(board, 'red', False)
        blue.opp, red.opp = red, blue

        class _S:
            def __init__(self, name):
                self.name = name
        red.charged_spells = [_S('Bulwark')]

        class _L:
            position = [board.nodes[n] for n in SHIELD]
        red.lock = _L()
        return board, blue

    real_sleep = time.sleep
    time.sleep = lambda s: None
    try:
        board, blue = setup()
        blue.ishuman = True
        blue.script = ['b3']
        spellfile.Fissure(board, [], 'Fissure').resolve(blue)
        st = {n: board.nodes[n].stone for n in board.nodes}
        assert st['b3'] == 'red' and st['b13'] is None and 'X' not in st.values(), st

        board, blue = setup()
        spellfile.Storm_Front(board, [], 'Storm_Front').resolve(blue)
        st = {n: board.nodes[n].stone for n in board.nodes}
        assert all(st[n] == 'red' for n in SHIELD), st

        board, blue = setup()
        blue.priority_order = list(NODE_ORDER)
        spellfile.Fireblast(board, [], 'Fireblast').resolve(blue)
        st = {n: board.nodes[n].stone for n in board.nodes}
        assert all(st[n] == 'red' for n in SHIELD), st
    finally:
        time.sleep = real_sleep
    print("  PASS")


def main():
    test_protected_set()
    test_every_effect_spares_shielded_stones()
    test_sequential_effects_can_break_bulwark()
    test_destruction_seal()
    test_fissure_rules()
    test_rock_slide_shield_brute_force()
    test_enumerator_overrides()
    test_js_sim_parity()
    test_live_spells_js()
    test_live_spellfile()
    print("All Bulwark/Fissure tests passed.")


if __name__ == '__main__':
    main()
