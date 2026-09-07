"""Experimental pack tests.

Spring Tide (2 soft, 2 hard, then sacrifice 2): the shared soft_hard_chain
resolver's optional trailing sacrifice in the Python sim, its
override/enumerator plumbing, replay equivalence, pack/unrated registration
on both the Python and JS sides, and a JS parity smoke that resolves the
same position through sim-board.js.

Rapids (Torrent + "you may cast 1 additional spell this turn"): the
`extra_cast` flag reopens the turn's spell window once — in the greedy sims
(Python + JS, counted for parity), the exhaustive enumerators, the replayer,
and the live GameController driven from Node with scripted input (second
cast offered, dash withheld, Seal of Summer stacking).

Run: python -m ai.test_experimental
"""
import json
import os
import subprocess

from simboard import SimBoard, Action, CompleteTurn, apply_sim_turn, CORE_SPELLS
from notation import NODE_ORDER, POSITIONS

# Spring Tide in slot 4 (the first sorcery slot -> POSITIONS[4] = a8 a9 a10).
SPELLS = ['Flourish', 'Carnage', 'Bewitch',
          'Spring_Tide', 'Fireblast', 'Hail_Storm',
          'Sprout', 'Slash', 'Surge']

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _board():
    b = SimBoard(SPELLS)
    b.setup_initial()
    return b


def _engaged_board():
    """Red charges Spring Tide (a8 a9 a10) with full mana, and has a couple
    of blue stones in reach so both soft and hard moves exist. b1 (blue's
    setup stone) stays, so blue is never eliminated by the chain."""
    b = _board()
    for n in POSITIONS[4]:
        b.stones[n] = 'red'
    for n in ('a1', 'b1', 'c1'):
        b.stones[n] = 'red'
    b.stones['a7'] = 'blue'     # touches a8
    b.stones['b11'] = 'blue'    # touches a10
    b.stones['c5'] = 'blue'     # far away, keeps blue alive
    b.stones['b1'] = 'blue'
    b.update()
    b.whose_turn = 'red'
    return b


def test_metadata_and_texts():
    print("Testing metadata + pack registration...")
    assert CORE_SPELLS['Spring_Tide'] == {'resolve': 'soft_hard_chain', 'counts': [2, 2],
                                          'hard_first': True, 'sacrifice': 2,
                                          'static': False, 'ischarm': False}
    # Torrent/Tsunami must NOT have grown a sacrifice or a flipped order.
    for name in ('Torrent', 'Tsunami'):
        assert 'sacrifice' not in CORE_SPELLS[name]
        assert 'hard_first' not in CORE_SPELLS[name]

    import spellgenerator as g
    assert g.EXPANSIONS['experimental'] == {'rituals': [], 'sorceries': ['Spring_Tide', 'Rapids'], 'charms': []}
    assert 'experimental' in g.EXPANSION_KEYS
    assert 'Spring_Tide' in g.UNRATED_SPELLS
    r, s, c = g.spell_pool(['experimental'])
    assert 'Spring_Tide' in s and len(r) == 5 and len(c) == 5
    # A sorcery-only pack on top of core still fills a board.
    names = g.generate_spell_list(expansions=['core', 'experimental'])
    assert len(names) == 9

    import spellfile
    assert spellfile.Spring_Tide(None, [], 'Spring_Tide').text == \
        'Make 2 hard moves, then 2 soft moves, then sacrifice 2 stones.'
    print("  PASS")


def test_greedy_resolution():
    print("Testing greedy resolution: 2 hard, 2 soft, 2 sacrifices...")
    b = _engaged_board()
    assert 'Spring_Tide' in b.charged_spells['red']
    before_red = sum(1 for n in NODE_ORDER if b.stones[n] == 'red')
    mana = b.mana['red']
    assert mana == 2, mana   # a1 + c1 (b1 is blue's)
    acts = b._cast_spell('Spring_Tide', 'red')
    types = [a.type for a in acts]
    assert types[0] == 'cast'
    assert types.count('move') == 2, types
    assert types.count('hard_move') == 2, types
    assert types.count('sacrifice') == 2, types
    # Strict order: hard moves FIRST, then soft moves, then sacrifices.
    body = [t for t in types if t != 'cast']
    assert body == ['hard_move', 'hard_move', 'move', 'move', 'sacrifice', 'sacrifice'], body
    # Tsunami (same counts, no flag) keeps the soft-then-hard order.
    bt = SimBoard(['Tsunami', 'Carnage', 'Bewitch', 'Grow', 'Fireblast', 'Hail_Storm',
                   'Sprout', 'Slash', 'Surge'])
    bt.setup_initial()
    for n in POSITIONS[1] + ['a1', 'c1']:
        bt.stones[n] = 'red'
    bt.stones['a7'] = 'blue'
    bt.stones['b11'] = 'blue'
    bt.stones['c5'] = 'blue'
    bt.update()
    tt = [a.type for a in bt._cast_spell('Tsunami', 'red') if a.type != 'cast']
    assert tt[:2] == ['move', 'move'] and 'hard_move' in tt, tt
    # Greedy sacrifice picks the caster's LAST stones in NODE_ORDER (Fury rule).
    sacs = [a.node for a in acts if a.type == 'sacrifice']
    for s in sacs:
        assert b.stones[s] is None
    # Material: -3 (cast) +M (refill) +2 (soft) +2 (hard moves place a
    # stone on the pushed node) -2 (sacrifice) = M - 1, the sorcery line.
    after_red = sum(1 for n in NODE_ORDER if b.stones[n] == 'red')
    assert after_red == before_red + mana - 1, (before_red, mana, after_red)
    assert b.lock['red'] == 'Spring_Tide' and b.spell_counter['red'] == 1
    assert not b.gameover
    print("  PASS")


def test_sacrifice_overrides():
    print("Testing sacrifice_targets override + stale-entry skipping...")
    b = _engaged_board()
    # a1 and c1 are red mana stones: legal sacrifice picks. 'a7' is blue
    # (stale/illegal) and must be skipped, falling through to the next.
    acts = b._cast_spell('Spring_Tide', 'red',
                         target_overrides={'sacrifice_targets': ['a7', 'a1', 'c1']})
    sacs = [a.node for a in acts if a.type == 'sacrifice']
    assert sacs == ['a1', 'c1'], sacs
    assert b.stones['a1'] is None and b.stones['c1'] is None

    # Exhausted overrides fall back to greedy for the remainder.
    b2 = _engaged_board()
    acts2 = b2._cast_spell('Spring_Tide', 'red', target_overrides={'sacrifice_targets': ['a1']})
    sacs2 = [a.node for a in acts2 if a.type == 'sacrifice']
    assert len(sacs2) == 2 and sacs2[0] == 'a1' and sacs2[1] != 'a1', sacs2
    print("  PASS")


def test_no_sacrifice_when_game_already_over():
    print("Testing the sacrifice is not paid once the game is over...")
    b = SimBoard(SPELLS)
    for n in POSITIONS[4]:
        b.stones[n] = 'red'
    b.stones['a1'] = 'red'
    b.whose_turn = 'red'
    b.update()                       # blue has no stones -> game over
    assert b.gameover and b.winner == 'red'
    acts = b._resolve_spell('Spring_Tide', 'red', POSITIONS[4])
    assert all(a.type != 'sacrifice' for a in acts), [a.type for a in acts]
    print("  PASS")


def test_sacrifice_stops_when_out_of_stones():
    print("Testing the sacrifice stops when the caster runs dry...")
    b = SimBoard(SPELLS)
    for n in POSITIONS[4]:
        b.stones[n] = 'red'
    b.stones['c5'] = 'blue'
    b.whose_turn = 'red'
    b.update()
    # M=0: the cast clears a8-a10 and refills nothing. The chain's soft
    # moves need an adjacent red stone, so nothing moves; the caster has
    # zero stones, and there is nothing to sacrifice -> loss by elimination
    # is flagged by update(), not by a phantom sacrifice.
    acts = b._cast_spell('Spring_Tide', 'red')
    assert [a.type for a in acts if a.type == 'sacrifice'] == []
    assert b.gameover and b.winner == 'blue'
    print("  PASS")


def test_replay_equivalence():
    print("Testing replay equivalence (apply_sim_turn reproduces the cast)...")
    b0 = _engaged_board()
    live = b0.copy()
    acts = live._cast_spell('Spring_Tide', 'red')
    rep = b0.copy()
    apply_sim_turn(rep, CompleteTurn(acts), 'red')
    assert rep.to_sfn() == live.to_sfn(), (rep.to_sfn(), live.to_sfn())
    print("  PASS")


def test_enumerator_variants():
    print("Testing enumerator sacrifice_targets variants + caps...")
    from ai.enumerator import (_spell_overrides, get_legal_turns_exhaustive,
                               DEFAULT_CAPS)
    assert 'soft_hard_sac' in DEFAULT_CAPS
    b = _engaged_board()
    ovs = _spell_overrides(b, 'red', 'Spring_Tide', DEFAULT_CAPS)
    assert {} in ovs
    sac_variants = [o for o in ovs if 'sacrifice_targets' in o]
    assert 1 <= len(sac_variants) <= DEFAULT_CAPS['soft_hard_sac'], sac_variants
    for o in sac_variants:
        assert len(o['sacrifice_targets']) == 2
        # Never a stone inside Spring Tide's own position (cleared by the cast).
        assert not set(o['sacrifice_targets']) & set(POSITIONS[4]), o
    # Torrent/Tsunami keep their variant shape (no sacrifice branching).
    bt = SimBoard(['Flourish', 'Carnage', 'Bewitch', 'Torrent', 'Fireblast',
                   'Hail_Storm', 'Sprout', 'Slash', 'Surge'])
    bt.setup_initial()
    for n in POSITIONS[4]:
        bt.stones[n] = 'red'
    bt.stones['a7'] = 'blue'
    bt.update()
    assert all('sacrifice_targets' not in o
               for o in _spell_overrides(bt, 'red', 'Torrent', DEFAULT_CAPS))
    # Exhaustive enumeration includes casts with distinct sacrifice sets.
    turns = list(get_legal_turns_exhaustive(b, 'red', caps={}))
    casts = [t for t in turns if any(a.type == 'cast' and a.spell == 'Spring_Tide'
                                     for a in t.actions)]
    assert casts, "no Spring Tide casts enumerated"
    sac_sets = {tuple(sorted(a.node for a in t.actions if a.type == 'sacrifice')) for t in casts}
    assert len(sac_sets) >= 2, sac_sets
    print("  PASS")


def test_js_parity_smoke():
    print("Testing JS engine parity (same position, same greedy resolution)...")
    py = _engaged_board()
    py_acts = py._cast_spell('Spring_Tide', 'red')
    py_seq = [(a.type, a.node) for a in py_acts if a.type != 'cast']
    py_stones = {n: py.stones[n] for n in NODE_ORDER}

    engine = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')
    js = []
    for fn in ('constants.js', 'notation.js', 'spells.js', 'moves.js',
               'sim-board.js', 'enumerator.js'):
        with open(os.path.join(engine, fn), encoding='utf-8') as f:
            js.append(f.read())
    js.append(r"""
const SP = %s;
const b = new SimBoard(SP);
for (const n of POSITIONS[4]) b.stones[n] = 'red';
for (const n of ['a1','b1','c1']) b.stones[n] = 'red';
b.stones.a7 = 'blue'; b.stones.b11 = 'blue'; b.stones.c5 = 'blue'; b.stones.b1 = 'blue';
b.update(); b.whoseTurn = 'red';
if (!b.chargedSpells.red.includes('Spring_Tide')) throw new Error('not charged');
const acts = b._castSpell('Spring_Tide', 'red');
const seq = acts.filter(a => a.type !== 'cast').map(a => [a.type, a.node]);
const stones = {}; for (const n of NODE_ORDER) stones[n] = b.stones[n];
// Pack registration on the JS side.
if (!EXPANSIONS.experimental || EXPANSIONS.experimental.sorceries.join() !== 'Spring_Tide,Rapids') throw new Error('pack');
if (!EXPANSION_KEYS.includes('experimental')) throw new Error('keys');
if (!isUnratedSpell('Spring_Tide') || !isExperimentalSpell('Spring_Tide')) throw new Error('unrated');
if (isUnratedSpell('Torrent')) throw new Error('Torrent must stay rated');
if (SPELL_TEXTS.Spring_Tide !== 'Make 2 hard moves, then 2 soft moves, then sacrifice 2 stones.') throw new Error('text');
// Sorcery-only pack still draws a full board on top of core.
const drawn = generateSpellList(['core', 'experimental']);
if (drawn.length !== 9) throw new Error('draw');
// Enumerator emits sacrifice variants with no in-position stones.
const c = b0();
function b0() { const x = new SimBoard(SP);
  for (const n of POSITIONS[4]) x.stones[n] = 'red'; for (const n of ['a1','b1','c1']) x.stones[n] = 'red';
  x.stones.a7 = 'blue'; x.stones.b11 = 'blue'; x.stones.c5 = 'blue'; x.stones.b1 = 'blue'; x.update(); x.whoseTurn = 'red'; return x; }
const ovs = _spellOverrides(c, 'red', 'Spring_Tide', ENUM_CAPS);
const sacs = ovs.filter(o => o.sacrifice_targets);
if (!sacs.length || sacs.length > ENUM_CAPS.soft_hard_sac) throw new Error('enum variants: ' + JSON.stringify(sacs));
for (const o of sacs) if (o.sacrifice_targets.length !== 2 || o.sacrifice_targets.some(n => POSITIONS[4].includes(n))) throw new Error('bad variant ' + JSON.stringify(o));
console.log('JS_RESULT ' + JSON.stringify({ seq, stones }));
""" % repr(SPELLS).replace("'", '"'))
    proc = subprocess.run(['node', '-'], input='\n'.join(js),
                          capture_output=True, text=True, timeout=120)
    line = next((l for l in proc.stdout.splitlines() if l.startswith('JS_RESULT ')), None)
    if line is None:
        print(proc.stdout[-2000:])
        print(proc.stderr[-2000:])
        raise AssertionError('JS parity smoke failed to run')
    import json
    res = json.loads(line[len('JS_RESULT '):])
    js_seq = [tuple(x) for x in res['seq']]
    assert js_seq == py_seq, (js_seq, py_seq)
    assert res['stones'] == py_stones
    print("  PASS")


# ---------------------------------------------------------------- Rapids

# Rapids in slot 4 (a8 a9 a10), Grow in slot 5 (b8 b9 b10), Sprout charm in
# slot 7 (a7), Seal of Summer charm in slot 9 (c7).
RAPIDS_SPELLS = ['Flourish', 'Carnage', 'Bewitch',
                 'Rapids', 'Grow', 'Hail_Storm',
                 'Sprout', 'Slash', 'Seal_of_Summer']


def _rapids_board(summer=False):
    """Red: Rapids + Grow charged, a base stone on a4 (soft move to a5),
    blue on a3 (hard-move target) — and NO mana, so live casts need no
    refill prompt. `summer` also charges Seal of Summer (c7) and Sprout (a7)."""
    b = SimBoard(RAPIDS_SPELLS)
    b.setup_initial()
    b.stones['a1'] = None
    # c12/c13 are red's LAST stones in NODE_ORDER: the greedy dash
    # sacrifices those, leaving both sigils charged for post-dash casts.
    for n in POSITIONS[4] + POSITIONS[5] + ['a4', 'c12', 'c13']:
        b.stones[n] = 'red'
    b.stones['a3'] = 'blue'
    b.stones['c5'] = 'blue'
    if summer:
        b.stones['c7'] = 'red'
        b.stones['a7'] = 'red'
    b.update()
    b.whose_turn = 'red'
    return b


def _casts(turn):
    return [a.spell for a in turn.actions if a.type == 'cast']


def _dash_after_rapids(turn):
    types = [(a.type, getattr(a, 'spell', None)) for a in turn.actions]
    idx = next((i for i, (t, sp) in enumerate(types) if t == 'cast' and sp == 'Rapids'), None)
    return idx is not None and any(t in ('dash', 'dash_lightning') for t, _ in types[idx + 1:])


def _cast_histogram(turns):
    hist = {}
    for t in turns:
        k = len(_casts(t))
        hist[k] = hist.get(k, 0) + 1
    return hist


def test_rapids_metadata():
    print("Testing Rapids metadata + registration...")
    assert CORE_SPELLS['Rapids'] == {'resolve': 'soft_hard_chain', 'counts': [1, 1],
                                     'extra_cast': True, 'static': False, 'ischarm': False}
    assert 'extra_cast' not in CORE_SPELLS['Torrent']
    import spellgenerator as g
    assert g.EXPANSIONS['experimental']['sorceries'] == ['Spring_Tide', 'Rapids']
    assert 'Rapids' in g.UNRATED_SPELLS
    import spellfile
    sp = spellfile.Rapids(None, [], 'Rapids')
    assert sp.extra_cast is True
    assert spellfile.Torrent(None, [], 'Torrent').extra_cast is False
    assert sp.text == 'Make 1 soft move, then 1 hard move. You may cast 1 additional spell this turn.'
    print("  PASS")


def test_rapids_greedy_enumeration():
    print("Testing Rapids reopens the cast window in get_legal_turns...")
    b = _rapids_board()
    assert {'Rapids', 'Grow'} <= set(b.charged_spells['red'])
    turns = list(b.get_legal_turns('red'))
    seqs = [_casts(t) for t in turns]
    assert ['Rapids'] in seqs, "plain Rapids cast must remain a legal turn"
    assert ['Rapids', 'Grow'] in seqs, seqs
    assert ['Grow'] in seqs
    # Grow grants nothing: never a second cast after it (no Summer here).
    assert not any(sq and sq[0] == 'Grow' and len(sq) > 1 for sq in seqs), seqs
    # Every two-cast turn opens with Rapids, and Rapids never re-casts itself
    # (its own lock bars it without Seal of Spring).
    for sq in seqs:
        if len(sq) >= 2:
            assert sq[0] == 'Rapids' and 'Rapids' not in sq[1:], sq
    # The reopened window never offers a dash.
    assert not any(_dash_after_rapids(t) for t in turns)
    # Dash -> Rapids -> Grow (post-dash extra cast) exists.
    assert any(any(a.type == 'dash' for a in t.actions) and _casts(t) == ['Rapids', 'Grow']
               for t in turns), "post-dash Rapids must still grant its extra cast"
    hist = _cast_histogram(turns)
    assert hist.get(2, 0) > 0 and hist.get(3, 0) == 0, hist
    print("  PASS")


def test_rapids_summer_stacking():
    print("Testing Rapids stacks with Seal of Summer (3 casts)...")
    b = _rapids_board(summer=True)
    assert {'Rapids', 'Grow', 'Sprout', 'Seal_of_Summer'} <= set(b.charged_spells['red'])
    turns = list(b.get_legal_turns('red'))
    seqs = [_casts(t) for t in turns]
    # Rapids (main) -> Grow (extra) -> Sprout (Summer's window).
    assert ['Rapids', 'Grow', 'Sprout'] in seqs, [sq for sq in seqs if len(sq) == 3]
    # Grow (main) -> Rapids (Summer's second spell) -> Sprout (Rapids' extra).
    assert ['Grow', 'Rapids', 'Sprout'] in seqs, [sq for sq in seqs if len(sq) == 3]
    # Plain Summer still caps at 2 without Rapids.
    assert ['Grow', 'Sprout'] in seqs
    assert not any(len(sq) > 3 for sq in seqs), max(seqs, key=len)
    assert not any(_dash_after_rapids(t) for t in turns)
    print("  PASS")


def test_rapids_exhaustive_and_replay():
    print("Testing Rapids in the exhaustive enumerator + replay equivalence...")
    from ai.enumerator import get_legal_turns_exhaustive
    b = _rapids_board()
    ex = list(get_legal_turns_exhaustive(b, 'red', caps={}))
    two = [t for t in ex if _casts(t) == ['Rapids', 'Grow']]
    assert two, "exhaustive enumerator must branch into the reopened window"
    assert not any(_dash_after_rapids(t) for t in ex)
    assert any(any(a.type == 'dash' for a in t.actions) and _casts(t) == ['Rapids', 'Grow']
               for t in ex), "exhaustive post-dash Rapids extra cast"

    # Replay: a recorded two-cast turn re-applies to the same position that
    # executing it live produces (greedy casts are deterministic).
    turn = next(t for t in list(b.get_legal_turns('red'))
                if _casts(t) == ['Rapids', 'Grow'] and t.actions[0].type == 'move'
                and not any(a.type in ('dash', 'dash_lightning') for a in t.actions))
    rep = b.copy()
    apply_sim_turn(rep, turn, 'red')
    live = b.copy()
    live._do_move('red', turn.actions[0].node)
    live.update()
    live._cast_spell('Rapids', 'red')
    live._cast_spell('Grow', 'red')
    live.update()
    assert rep.to_sfn() == live.to_sfn(), (rep.to_sfn(), live.to_sfn())
    assert live.lock['red'] == 'Grow' and live.spell_counter['red'] == 2
    print("  PASS")


def _load_engine_js(files):
    engine = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')
    js = []
    for fn in files:
        with open(os.path.join(engine, fn), encoding='utf-8') as f:
            js.append(f.read())
    return js


def _run_node(js, marker, timeout=180):
    proc = subprocess.run(['node', '-'], input='\n'.join(js),
                          capture_output=True, text=True, timeout=timeout)
    line = next((l for l in proc.stdout.splitlines() if l.startswith(marker + ' ')), None)
    if line is None:
        print(proc.stdout[-3000:])
        print(proc.stderr[-3000:])
        raise AssertionError('node run failed (' + marker + ')')
    return json.loads(line[len(marker) + 1:])


def test_rapids_js_sim_parity():
    print("Testing Rapids JS sim parity (cast histograms, no dash in window)...")
    py_plain = _cast_histogram(list(_rapids_board().get_legal_turns('red')))
    py_summer = _cast_histogram(list(_rapids_board(summer=True).get_legal_turns('red')))
    js = _load_engine_js(('constants.js', 'notation.js', 'spells.js', 'moves.js',
                          'sim-board.js', 'enumerator.js'))
    js.append(r"""
const SP = %s;
function mk(summer) {
  const b = new SimBoard(SP);
  b.stones.b1 = 'blue';
  for (const n of [...POSITIONS[4], ...POSITIONS[5], 'a4', 'c12', 'c13']) b.stones[n] = 'red';
  b.stones.a3 = 'blue'; b.stones.c5 = 'blue';
  if (summer) { b.stones.c7 = 'red'; b.stones.a7 = 'red'; }
  b.update(); b.whoseTurn = 'red';
  return b;
}
const casts = t => t.actions.filter(a => a.type === 'cast').map(a => a.spell);
function hist(turns) { const h = {}; for (const t of turns) { const k = casts(t).length; h[k] = (h[k] || 0) + 1; } return h; }
function dashAfterRapids(t) {
  const i = t.actions.findIndex(a => a.type === 'cast' && a.spell === 'Rapids');
  return i >= 0 && t.actions.slice(i + 1).some(a => a.type === 'dash' || a.type === 'dash_lightning');
}
const plain = [...mk(false).getLegalTurns('red')];
const summer = [...mk(true).getLegalTurns('red')];
if (plain.some(dashAfterRapids) || summer.some(dashAfterRapids)) throw new Error('dash in reopened window');
const seqs = plain.map(t => casts(t).join('>'));
if (!seqs.includes('Rapids>Grow')) throw new Error('no Rapids>Grow');
const ex = getLegalTurnsExhaustive(mk(false), 'red', ENUM_CAPS);
const exTwo = ex.filter(t => casts(t).join('>') === 'Rapids>Grow').length;
if (!exTwo) throw new Error('exhaustive: no Rapids>Grow');
if (ex.some(dashAfterRapids)) throw new Error('exhaustive: dash in reopened window');
console.log('JS_RESULT ' + JSON.stringify({ plain: hist(plain), summer: hist(summer) }));
""" % json.dumps(RAPIDS_SPELLS))
    res = _run_node(js, 'JS_RESULT')
    js_plain = {int(k): v for k, v in res['plain'].items()}
    js_summer = {int(k): v for k, v in res['summer'].items()}
    assert js_plain == py_plain, (js_plain, py_plain)
    assert js_summer == py_summer, (js_summer, py_summer)
    print("  PASS")


def test_rapids_live_controller():
    print("Testing Rapids in the live GameController (scripted input)...")
    js = _load_engine_js(('constants.js', 'notation.js', 'moves.js', 'spells.js',
                          'board.js', 'game-controller.js'))
    js.append(r"""
const SP = %s;
async function run(summer, script) {
  const prompts = [];
  // Push destinations arrive via a 'pushingoptions' emit just before the
  // node prompt (moveoptions is empty there), so remember the last one.
  let pushOptions = [];
  const gc = new GameController((ev) => {
    if (ev && ev.type === 'pushingoptions') {
      pushOptions = Object.keys(ev).filter(k => k !== 'type' && k !== 'sourceNode');
    }
  }, { variant: 'standard' });
  const board = new SigilBoard(SP, 'standard');
  board.setupInitial();
  board.stones.a1 = null;
  for (const n of [...POSITIONS[4], ...POSITIONS[5], 'a4', 'c12', 'c13']) board.stones[n] = 'red';
  board.stones.a3 = 'blue'; board.stones.c5 = 'blue';
  if (summer) { board.stones.c7 = 'red'; board.stones.a7 = 'red'; }
  board.update();
  gc.board = board;
  gc._currentTurnActions = [];
  const queue = script.slice();
  gc.getInput = async (payload) => {
    if (payload.awaiting === 'action') {
      prompts.push(payload.actionlist.slice());
      if (payload.actionlist.includes('move')) return 'a5';   // soft move a4 -> a5
      const next = queue.shift();
      if (next === undefined) throw new Error('script exhausted at ' + JSON.stringify(payload.actionlist));
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
  if (board.mana.red !== 0) throw new Error('test wants M=0 (no refill prompts)');
  await gc._takeTurn('red', true, true, true, true);
  return { prompts, lock: board.lock.red, counter: board.spellCounter.red,
           stones: NODE_ORDER.filter(n => board.stones[n] === 'red').length };
}
(async () => {
  const plain = await run(false, ['Rapids', 'Grow', 'pass']);
  const summer = await run(true, ['Rapids', 'Grow', 'Sprout', 'pass']);
  const summerFirst = await run(true, ['Grow', 'Rapids', 'Sprout', 'pass']);
  console.log('JS_RESULT ' + JSON.stringify({ plain, summer, summerFirst }));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
""" % json.dumps(RAPIDS_SPELLS))
    res = _run_node(js, 'JS_RESULT')
    p = res['plain']['prompts']
    # p[0]: move prompt; p[1]: post-move (dash + spells + pass);
    # p[2]: Rapids' reopened window; p[3]: after the extra cast.
    assert 'dash' in p[1] and 'Rapids' in p[1] and 'Grow' in p[1], p[1]
    assert 'Grow' in p[2] and 'dash' not in p[2] and 'Rapids' not in p[2], p[2]
    assert p[3] == ['pass'], p[3]
    assert res['plain']['lock'] == 'Grow' and res['plain']['counter'] == 2, res['plain']
    s = res['summer']['prompts']
    assert 'Grow' in s[2] and 'dash' not in s[2], s[2]
    assert 'Sprout' in s[3] and 'dash' not in s[3] and 'Grow' not in s[3], s[3]
    assert s[4] == ['pass'], s[4]
    assert res['summer']['counter'] == 2, res['summer']   # charms don't count
    f = res['summerFirst']['prompts']
    # Grow (main) -> Rapids offered by Summer's window -> Sprout by Rapids'.
    assert 'Rapids' in f[2] and 'dash' not in f[2], f[2]
    assert 'Sprout' in f[3] and 'dash' not in f[3], f[3]
    assert f[4] == ['pass'], f[4]
    print("  PASS")


def main():
    test_metadata_and_texts()
    test_greedy_resolution()
    test_sacrifice_overrides()
    test_no_sacrifice_when_game_already_over()
    test_sacrifice_stops_when_out_of_stones()
    test_replay_equivalence()
    test_enumerator_variants()
    test_js_parity_smoke()
    test_rapids_metadata()
    test_rapids_greedy_enumeration()
    test_rapids_summer_stacking()
    test_rapids_exhaustive_and_replay()
    test_rapids_js_sim_parity()
    test_rapids_live_controller()
    print("All Experimental tests passed.")


if __name__ == '__main__':
    main()
