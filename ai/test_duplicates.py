"""Allow-duplicates variant tests.

The variant triples the spell pool with alias names (X, X~2, X~3) and draws
without replacement, so a board can hold up to three copies of a spell while
every slot keeps a unique name. These tests pin the alias registration, the
tripled draw (Python + JS), slot-correct casting of a ~2/~3 copy, the
static-seal collapse in the charged lists, SFN/replay round trips, the
variant string plumbing, JS parity, and a live GameController run.

Run: python -m ai.test_duplicates
"""
import json
import os
import subprocess

from simboard import (SimBoard, CompleteTurn, apply_sim_turn, CORE_SPELLS,
                      variant_has_duplicates, variant_has_competitive,
                      variant_has_deathmatch)
from notation import (NODE_ORDER, POSITIONS, DUPLICATE_SUFFIXES,
                      base_spell_name, normalize_spell_name)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Two Flourish copies, two Grow copies, an aliased Seal of Lightning, two
# Slash copies — every slot name unique, several base spells repeated.
DUP_SPELLS = ['Flourish', 'Flourish~2', 'Bewitch',
              'Grow', 'Grow~2', 'Fireblast',
              'Seal_of_Lightning~2', 'Slash', 'Slash~3']


def _board():
    """Red: Grow~2 (slot 5: b8 b9 b10) charged, Seal of Lightning~2 (a7)
    charged, mana on a1 + c1, a spare stone on a4 and spares on c12/c13 (so a
    greedy dash never eats a sigil). Blue: b1, a3 (hard-move target), c5."""
    b = SimBoard(DUP_SPELLS, 'duplicates')
    b.setup_initial()
    for n in POSITIONS[5] + ['a1', 'c1', 'a4', 'a7', 'c12', 'c13']:
        b.stones[n] = 'red'
    b.stones['b1'] = 'blue'
    b.stones['a3'] = 'blue'
    b.stones['c5'] = 'blue'
    b.update()
    b.whose_turn = 'red'
    return b


def test_aliases_and_helpers():
    print("Testing alias registration + name helpers...")
    for base in ('Grow', 'Seal_of_Wind', 'Spring_Tide', 'Minefield'):
        for sfx in DUPLICATE_SUFFIXES:
            assert CORE_SPELLS[base + sfx] is CORE_SPELLS[base], base + sfx
    assert base_spell_name('Storm_Front~3') == 'Storm_Front'
    assert base_spell_name('Grow') == 'Grow'
    assert normalize_spell_name('Flood~2') == 'Tsunami~2'   # legacy rename keeps suffix
    assert normalize_spell_name('Flood') == 'Tsunami'
    assert variant_has_duplicates('competitive_deathmatch_duplicates')
    assert not variant_has_duplicates('competitive_deathmatch')
    assert len(SimBoard.VARIANTS) == 8 and 'competitive_duplicates' in SimBoard.VARIANTS
    print("  PASS")


def test_tripled_draw():
    print("Testing the tripled draw (Python generator)...")
    import random
    import spellgenerator as g
    random.seed(7)
    for _ in range(50):
        inst = g.generate_spell_list(expansions=['covenant'], allow_duplicates=True)
        names = [s.split("'")[1] for s in inst]
        classes = [s.split('.')[1].split('(')[0] for s in inst]
        assert len(set(names)) == 9, names
        assert all(base_spell_name(n) == c for n, c in zip(names, classes))
        # Covenant alone has one spell per category -> each appears 3 times.
        assert sorted(base_spell_name(n) for n in names[:3]) == ['Seal_of_Destruction'] * 3
    # Without the flag, a one-pack pool is still rejected.
    try:
        g.generate_spell_list(expansions=['covenant'])
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
    # Core-only with duplicates: 9 unique names, no ~ collisions.
    inst = g.generate_spell_list(expansions=['core'], allow_duplicates=True)
    names = [s.split("'")[1] for s in inst]
    assert len(set(names)) == 9
    print("  PASS")


def test_cast_copy_hits_its_own_slot():
    print("Testing casting Grow~2 clears slot 5, not Grow's slot 4...")
    b = _board()
    assert 'Grow~2' in b.charged_spells['red'] and 'Grow' not in b.charged_spells['red']
    before4 = {n: b.stones[n] for n in POSITIONS[4]}
    acts = b._cast_spell('Grow~2', 'red')
    assert acts[0].type == 'cast' and acts[0].spell == 'Grow~2'
    assert {n: b.stones[n] for n in POSITIONS[4]} == before4, "Grow's slot must be untouched"
    # M=2 refill into slot 5, then 2 soft moves.
    assert sum(1 for n in POSITIONS[5] if b.stones[n] == 'red') == 2
    assert [a.type for a in acts if a.type == 'move'] == ['move', 'move']
    assert b.lock['red'] == 'Grow~2' and b.spell_counter['red'] == 1
    # The lock names the copy, so Grow (slot 4) would still be castable
    # once charged, while Grow~2 is locked.
    for n in POSITIONS[4]:
        b.stones[n] = 'red'
    b.update()
    castable = b._get_castable_spells('red', True, True)
    assert 'Grow' in castable and 'Grow~2' not in castable, castable
    print("  PASS")


def test_static_collapse():
    print("Testing charged statics collapse to their base name...")
    b = _board()
    assert 'Seal_of_Lightning' in b.charged_spells['red'], b.charged_spells['red']
    assert 'Seal_of_Lightning~2' not in b.charged_spells['red']
    turns = list(b.get_legal_turns('red'))
    dash_types = {a.type for t in turns for a in t.actions if a.type.startswith('dash')}
    assert dash_types == {'dash_lightning'}, dash_types
    # Castable copies keep their unique names.
    assert 'Grow~2' in b.charged_spells['red']
    print("  PASS")


def test_static_copies_per_side():
    print("Testing duplicated statics: one copy per side, or two on one side...")
    # Seal of Wind in slots 4 and 5: red fills the plain copy, blue the ~2 copy.
    spells = ['Flourish', 'Carnage', 'Bewitch',
              'Seal_of_Wind', 'Seal_of_Wind~2', 'Grow',
              'Sprout', 'Slash', 'Surge']
    b = SimBoard(spells, 'duplicates')
    b.setup_initial()
    for n in POSITIONS[4]:
        b.stones[n] = 'red'
    for n in POSITIONS[5]:
        b.stones[n] = 'blue'
    b.stones['c13'] = 'red'
    b.stones['c12'] = 'blue'
    b.update()
    assert 'Seal_of_Wind' in b.charged_spells['red']
    assert 'Seal_of_Wind' in b.charged_spells['blue']
    # Both sides get Wind's blink: a first move onto a node that touches
    # no stone at all (c4: c3/c5/c7 are all empty here).
    for color in ('red', 'blue'):
        b.whose_turn = color
        firsts = {t.actions[0] for t in b.get_legal_turns(color) if t.actions}
        blinks = {a.node for a in firsts if a.type == 'blink'}
        assert 'c4' in blinks, (color, sorted(blinks)[:5])
    # Blue loses its copy: only red keeps the ability.
    for n in POSITIONS[5]:
        b.stones[n] = None
    b.update()
    assert 'Seal_of_Wind' in b.charged_spells['red']
    assert 'Seal_of_Wind' not in b.charged_spells['blue']
    b.whose_turn = 'blue'
    assert not any(a.type == 'blink' for t in b.get_legal_turns('blue') for a in t.actions[:1])
    # One side holding BOTH copies is redundant, not doubled: two entries,
    # one ability, nothing else changes (Lightning's dash cost stays 1).
    spells2 = ['Flourish', 'Carnage', 'Bewitch', 'Grow', 'Fireblast', 'Hail_Storm',
               'Seal_of_Lightning', 'Seal_of_Lightning~2', 'Slash']
    c = SimBoard(spells2, 'duplicates')
    c.setup_initial()
    for n in ('a7', 'b7', 'a4', 'c12', 'c13'):
        c.stones[n] = 'red'
    c.stones['a3'] = 'blue'
    c.update()
    assert c.charged_spells['red'].count('Seal_of_Lightning') == 2
    turns = list(c.get_legal_turns('red'))
    dashes = [a for t in turns for a in t.actions if a.type.startswith('dash')]
    assert dashes and all(a.type == 'dash_lightning' and len(a.sacrificed) == 1 for a in dashes)
    assert c._get_castable_spells('red', True, True) == [], "statics never castable"
    print("  PASS")


def test_sfn_replay_exhaustive():
    print("Testing SFN round trip, replay and exhaustive enumeration...")
    b = _board()
    sfn = b.to_sfn()
    assert 'Grow~2' in sfn and sfn.rstrip().endswith('duplicates'), sfn
    b2 = SimBoard.from_sfn(sfn)
    assert b2.to_sfn() == sfn and b2.variant == 'duplicates'
    # Lock field carries the alias through SFN.
    live = b.copy()
    live._cast_spell('Grow~2', 'red')
    live.update()
    sfn2 = live.to_sfn()
    assert 'Grow~2:-' in sfn2, sfn2
    assert SimBoard.from_sfn(sfn2).lock['red'] == 'Grow~2'
    # Replay equivalence for a recorded cast of the copy.
    turn = next(t for t in b.get_legal_turns('red')
                if any(a.type == 'cast' and a.spell == 'Grow~2' for a in t.actions)
                and not any(a.type.startswith('dash') for a in t.actions)
                and t.actions[0].type == 'move')
    rep = b.copy()
    apply_sim_turn(rep, turn, 'red')
    ref = b.copy()
    ref._do_move('red', turn.actions[0].node)
    ref.update()
    ref._cast_spell('Grow~2', 'red')
    ref.update()
    assert rep.to_sfn() == ref.to_sfn()
    from ai.enumerator import get_legal_turns_exhaustive
    ex = list(get_legal_turns_exhaustive(b, 'red', caps={}))
    assert any(a.type == 'cast' and a.spell == 'Grow~2' for t in ex for a in t.actions)
    # NN spell IDs resolve through the base name.
    from ai.config import SPELL_TO_ID
    assert SPELL_TO_ID[base_spell_name('Grow~2')] == SPELL_TO_ID['Grow']
    print("  PASS")


def test_variant_gating_helpers():
    print("Testing variant helpers keep the other two dimensions intact...")
    v = 'competitive_deathmatch_duplicates'
    assert variant_has_competitive(v) and variant_has_deathmatch(v) and variant_has_duplicates(v)
    b = SimBoard(DUP_SPELLS, v)
    b.setup_initial()
    assert b.variant == v
    print("  PASS")


def _run_node(js, marker, timeout=180):
    proc = subprocess.run(['node', '-'], input='\n'.join(js),
                          capture_output=True, text=True, timeout=timeout)
    line = next((l for l in proc.stdout.splitlines() if l.startswith(marker + ' ')), None)
    if line is None:
        print(proc.stdout[-3000:])
        print(proc.stderr[-3000:])
        raise AssertionError('node run failed (' + marker + ')')
    return json.loads(line[len(marker) + 1:])


def _engine(files):
    engine = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')
    out = []
    for fn in files:
        with open(os.path.join(engine, fn), encoding='utf-8') as f:
            out.append(f.read())
    return out


def test_js_parity():
    print("Testing JS parity (SFN, charged lists, slot clearing, cast histogram)...")
    py = _board()
    py_sfn = py.to_sfn()
    py_hist = {}
    for t in py.get_legal_turns('red'):
        for a in t.actions:
            if a.type == 'cast':
                py_hist[a.spell] = py_hist.get(a.spell, 0) + 1
    js = _engine(('constants.js', 'notation.js', 'spells.js', 'moves.js', 'board.js', 'sim-board.js', 'enumerator.js'))
    js.append(r"""
const SP = %s;
const b = new SimBoard(SP, 'duplicates');
b.stones.b1 = 'blue';
for (const n of [...POSITIONS[5], 'a1', 'c1', 'a4', 'a7', 'c12', 'c13']) b.stones[n] = 'red';
b.stones.a3 = 'blue'; b.stones.c5 = 'blue';
b.update(); b.whoseTurn = 'red';
const sfn = boardToSfn(b);
const charged = b.chargedSpells.red.slice();
const hist = {};
for (const t of b.getLegalTurns('red')) for (const a of t.actions) if (a.type === 'cast') hist[a.spell] = (hist[a.spell] || 0) + 1;
const c = b.copy();
const before4 = POSITIONS[4].map(n => c.stones[n]);
c._castSpell('Grow~2', 'red');
const after4 = POSITIONS[4].map(n => c.stones[n]);
const slot5 = POSITIONS[5].filter(n => c.stones[n] === 'red').length;
const d = sfnToDict(boardToSfn(c));
// Duplicated static, one copy per side: both colors get Wind's blink in
// the LIVE move helper (moves.js), and losing a copy switches it off.
const w = new SigilBoard(['Flourish','Carnage','Bewitch','Seal_of_Wind','Seal_of_Wind~2','Grow','Sprout','Slash','Surge'], 'duplicates');
w.setupInitial();
for (const n of POSITIONS[4]) w.stones[n] = 'red';
for (const n of POSITIONS[5]) w.stones[n] = 'blue';
w.update();
const windRed = !!getStandardMoveTargets(w, 'red', true).c4;
const windBlue = !!getStandardMoveTargets(w, 'blue', true).c4;
for (const n of POSITIONS[5]) w.stones[n] = null;
w.update();
const windBlueAfter = !!getStandardMoveTargets(w, 'blue', true).c4;
// Tripled JS draw: 9 unique names, 3 base spells for a one-pack pool.
const drawn = generateSpellList(['covenant'], true);
const uniq = new Set(drawn).size, bases = new Set(drawn.map(baseSpellName)).size;
// Exhaustive enumerator handles alias names.
const ex = getLegalTurnsExhaustive(b, 'red', ENUM_CAPS).some(t => t.actions.some(a => a.type === 'cast' && a.spell === 'Grow~2'));
console.log('JS_RESULT ' + JSON.stringify({ sfn, charged, hist, before4, after4, slot5,
  lock: c.lock.red, sfnLock: d.redLock || d.red_lock || null, variant: d.variant, uniq, bases, ex,
  variants: SIGIL_VARIANTS.length, norm: normalizeVariant('duplicates_competitive'), windRed, windBlue, windBlueAfter }));
""" % json.dumps(DUP_SPELLS))
    res = _run_node(js, 'JS_RESULT')
    assert res['sfn'] == py_sfn, (res['sfn'], py_sfn)
    assert set(res['charged']) == set(py.charged_spells['red']), (res['charged'], py.charged_spells['red'])
    assert res['hist'] == py_hist, (res['hist'], py_hist)
    assert res['before4'] == res['after4'] and res['slot5'] == 2
    assert res['lock'] == 'Grow~2' and res['variant'] == 'duplicates'
    assert res['uniq'] == 9 and res['bases'] == 3 and res['ex']
    assert res['variants'] == 8 and res['norm'] == 'competitive_duplicates'
    assert res['windRed'] and res['windBlue'] and not res['windBlueAfter'], res
    print("  PASS")


def test_live_controller():
    print("Testing the live GameController with a duplicated board...")
    js = _engine(('constants.js', 'notation.js', 'moves.js', 'spells.js', 'board.js', 'game-controller.js'))
    js.append(r"""
const SP = %s;
(async () => {
  const prompts = [];
  let pushOptions = [];
  const gc = new GameController((ev) => {
    if (ev && ev.type === 'pushingoptions') pushOptions = Object.keys(ev).filter(k => k !== 'type' && k !== 'sourceNode');
  }, { variant: 'duplicates' });
  const board = new SigilBoard(SP, 'duplicates');
  board.setupInitial();
  // Both Grow copies charged, Lightning copy charged, no mana (no refill prompts).
  board.stones.a1 = null;
  for (const n of [...POSITIONS[4], ...POSITIONS[5], 'a4', 'a7', 'c12', 'c13']) board.stones[n] = 'red';
  board.stones.a3 = 'blue'; board.stones.c5 = 'blue';
  board.update();
  gc.board = board;
  gc._currentTurnActions = [];
  const queue = ['Grow~2', 'pass'];
  gc.getInput = async (payload) => {
    if (payload.awaiting === 'action') {
      prompts.push(payload.actionlist.slice());
      if (payload.actionlist.includes('move')) return 'a5';
      const next = queue.shift();
      if (!payload.actionlist.includes(next)) throw new Error('scripted ' + next + ' not offered: ' + JSON.stringify(payload.actionlist));
      return next;
    }
    if (payload.awaiting === 'node') {
      const keys = Object.keys(payload.moveoptions || {});
      if (keys.length) return keys[0];
      if (/push/.test(payload.message) && pushOptions.length) return pushOptions[0];
      for (const n of NODE_ORDER) if (board.stones[n] === 'red') return n;
    }
    throw new Error('unexpected prompt ' + JSON.stringify(payload));
  };
  const before4 = POSITIONS[4].map(n => board.stones[n]);
  await gc._takeTurn('red', true, true, true, true);
  console.log('JS_RESULT ' + JSON.stringify({
    prompts, charged: board.chargedSpells.red, lock: board.lock.red,
    slot4: POSITIONS[4].map(n => board.stones[n]), before4,
    slot5: POSITIONS[5].filter(n => board.stones[n] === 'red').length,
    sfn: boardToSfn(board),
  }));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
""" % json.dumps(DUP_SPELLS))
    res = _run_node(js, 'JS_RESULT')
    p = res['prompts']
    # Post-move prompt offers BOTH copies by their unique names, plus the
    # dash (Lightning collapsed to its base name makes canDash see it).
    assert 'Grow' in p[1] and 'Grow~2' in p[1] and 'dash' in p[1], p[1]
    assert res['slot4'] == res['before4'], "casting Grow~2 must leave Grow's slot alone"
    assert res['slot5'] == 0, res    # M=0: cleared, no refill
    assert res['lock'] == 'Grow~2'
    assert 'Seal_of_Lightning' in res['charged'] and 'Grow' in res['charged']
    assert 'Grow~2:-' in res['sfn'] and res['sfn'].rstrip().endswith('duplicates'), res['sfn']
    print("  PASS")


def main():
    test_aliases_and_helpers()
    test_tripled_draw()
    test_cast_copy_hits_its_own_slot()
    test_static_collapse()
    test_static_copies_per_side()
    test_sfn_replay_exhaustive()
    test_variant_gating_helpers()
    test_js_parity()
    test_live_controller()
    print("All allow-duplicates tests passed.")


if __name__ == '__main__':
    main()
