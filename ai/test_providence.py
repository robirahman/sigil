"""Providence pack tests: the per-player stone bank, the optional
once-per-turn placement, symmetric stone counting, enumeration, hashing,
replay, notation, and the live JS controller flow.

Rules under test (2026-10 simplification):
  * Dividend / Annuity / Endowment add 1 / 2 / 4 stones to the caster's bank.
  * Banked stones count toward their owner's total everywhere stones are
    compared (±3 lead, sixth-spell tally, score) — but NOT for zero-stone
    elimination, which looks at the board only.
  * A turn whose bank is nonempty may place ONE banked stone after the
    regular move and before dashing/casting. It is an ordinary adjacent soft
    or hard move: Seal of Wind's blink and the enemy Seal of Stone's
    soft-only rule apply to the regular move only. Skipped or impossible
    placements leave the stone banked.

Run: python -m ai.test_providence
"""
import json
import os
import subprocess

from simboard import (SimBoard, Action, CompleteTurn, apply_sim_turn,
                      CORE_SPELLS, ADJACENCY)
from notation import POSITIONS

PROVIDENCE_SPELLS = ['Endowment', 'Carnage', 'Bewitch',
                     'Annuity', 'Fireblast', 'Hail_Storm',
                     'Dividend', 'Slash', 'Surge']
# Seal of Wind at slot 3 (a8-a10), Seal of Stone at slot 4 (b8-b10).
SEAL_SPELLS = ['Endowment', 'Carnage', 'Bewitch',
               'Seal_of_Wind', 'Seal_of_Stone', 'Hail_Storm',
               'Dividend', 'Slash', 'Surge']

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')


def _board(spell_names=None):
    b = SimBoard(spell_names or PROVIDENCE_SPELLS)
    b.setup_initial()
    return b


def _prov_moves(turn):
    return [a for a in turn.actions if a.providence]


def test_metadata():
    print("Testing CORE_SPELLS metadata...")
    assert CORE_SPELLS['Dividend'] == {'resolve': 'bank_stones', 'stones': 1,
                                       'static': False, 'ischarm': True}
    assert CORE_SPELLS['Annuity']['stones'] == 2
    assert CORE_SPELLS['Endowment']['stones'] == 4
    print("  PASS")


def test_cast_semantics():
    print("Testing cast semantics + charm/lock behavior...")
    # Dividend (charm at slot 6 -> position 7 = a7).
    b = _board()
    b.stones['a7'] = 'red'
    b.update()
    assert 'Dividend' in b.charged_spells['red']
    acts = b._cast_spell('Dividend', 'red')
    assert b.prov_bank['red'] == 1
    assert b.stones['a7'] is None, "charm sigil sacrificed, no refill"
    assert b.lock['red'] is None and b.spell_counter['red'] == 0, \
        "charms advance neither lock nor counter"
    assert any(a.type == 'bank_stones' and a.banked == 1 and
               a.spell == 'Dividend' for a in acts)

    # Endowment (ritual at slot 0 -> position 1 = a2..a6), with full mana.
    b2 = _board()
    for n in POSITIONS[1]:
        b2.stones[n] = 'red'
    for n in ('a1', 'b1', 'c1'):
        b2.stones[n] = 'red'
    b2.update()
    assert b2.mana['red'] == 3
    b2._cast_spell('Endowment', 'red')
    assert b2.prov_bank['red'] == 4
    assert b2.lock['red'] == 'Endowment' and b2.spell_counter['red'] == 1
    kept = sum(1 for n in POSITIONS[1] if b2.stones[n] == 'red')
    assert kept == 3, "ritual refills mana stones"
    print("  PASS")


def test_bank_stacking_and_isolation():
    print("Testing bank stacking, advance_turn, copy isolation...")
    b = _board()
    b._resolve_spell('Endowment', 'blue', [])
    b._resolve_spell('Dividend', 'blue', [])
    b._resolve_spell('Annuity', 'blue', [])
    assert b.prov_bank == {'red': 0, 'blue': 7}
    b.advance_turn()
    b.advance_turn()
    assert b.prov_bank['blue'] == 7, "turns passing never drain the bank"
    c = b.copy()
    c.prov_bank['blue'] -= 1
    assert b.prov_bank['blue'] == 7, "copy must not alias the bank"
    print("  PASS")


def test_greedy_enumeration():
    print("Testing greedy enumeration (at most one optional placement)...")
    b = _board()
    b.stones['a2'] = 'red'
    b.stones['b2'] = 'blue'
    b.update()
    t0 = list(b.get_legal_turns('red'))
    assert not any(_prov_moves(t) for t in t0), "empty bank: no placements"

    b.prov_bank['red'] = 3
    t3 = list(b.get_legal_turns('red'))
    with_p = [t for t in t3 if _prov_moves(t)]
    assert with_p, "nonempty bank must offer a placement"
    assert max(len(_prov_moves(t)) for t in t3) == 1, \
        "a big bank still grants only ONE placement per turn"
    # Skipping is always available: every bank-0 turn shape is still there.
    assert len(t3) - len(with_p) == len(t0)
    # The placement comes right after the regular move, before dash/cast.
    for t in with_p:
        i = next(k for k, a in enumerate(t.actions) if a.providence)
        assert i == 1 and t.actions[0].type in ('move', 'hard_move', 'blink'), t
        assert t.actions[i].type in ('move', 'hard_move'), \
            "a placement is never a blink"
    print("  PASS")


def test_stone_does_not_restrict_placement():
    print("Testing Seal of Stone: regular move blocked, placement may push...")
    b = _board(SEAL_SPELLS)
    # Red: a1 only, boxed in by blue on both neighbors (a2, a11). Blue holds
    # Seal of Stone, so red's regular move (soft-only) has no target.
    b.stones['a2'] = 'blue'
    b.stones['a11'] = 'blue'
    for n in POSITIONS[5]:
        b.stones[n] = 'blue'
    b.update()
    assert 'Seal_of_Stone' in b.charged_spells['blue']
    t0 = list(b.get_legal_turns('red'))
    assert not any(a.type in ('move', 'hard_move', 'blink')
                   for t in t0 for a in t.actions), \
        "under Stone with no soft target there is no regular move"
    b.prov_bank['red'] = 1
    t1 = list(b.get_legal_turns('red'))
    hard = [t for t in t1 if any(a.providence and a.type == 'hard_move'
                                 for a in t.actions)]
    assert hard, "the Providence placement ignores Stone and may push"
    from ai.minimax_ai import _apply_turn
    sim = _apply_turn(b, hard[0], 'red')
    assert sim.prov_bank['red'] == 0
    print("  PASS")


def test_blocked_placement_keeps_bank():
    print("Testing blocked placement keeps the bank...")
    b = _board()
    # Red a1 walled in by Fissure walls: no regular move, no placement.
    b.stones['a2'] = 'X'
    b.stones['a11'] = 'X'
    b.update()
    b.prov_bank['red'] = 2
    turns = list(b.get_legal_turns('red'))
    assert turns and not any(_prov_moves(t) for t in turns)
    from ai.minimax_ai import _apply_turn
    for t in turns:
        assert _apply_turn(b, t, 'red').prov_bank['red'] == 2
    print("  PASS")


def test_exhaustive_enumeration_and_caps():
    print("Testing exhaustive enumeration caps + cap keys...")
    from ai.enumerator import (get_legal_turns_exhaustive, DEFAULT_CAPS,
                               BALANCED_CAPS, NARROW_CAPS, OPPONENT_CAPS)
    for caps in (DEFAULT_CAPS, BALANCED_CAPS, NARROW_CAPS, OPPONENT_CAPS):
        assert 'providence_move' in caps
    assert 'fissure' in DEFAULT_CAPS, "B1 regression: fissure must have a default cap"

    b = _board()
    b.stones['a2'] = 'red'
    b.stones['b2'] = 'blue'
    b.update()
    turns0 = list(get_legal_turns_exhaustive(b, 'red', caps={}))
    assert not any(_prov_moves(t) for t in turns0)
    b.prov_bank['red'] = 4
    # caps={} must not KeyError (B1 class of bug).
    turns = list(get_legal_turns_exhaustive(b, 'red', caps={}))
    assert max(len(_prov_moves(t)) for t in turns) == 1
    assert len(turns) > len(turns0)
    print("  PASS")


def test_spell_overrides_noop():
    print("Testing _spell_overrides no-op for Providence spells...")
    from ai.enumerator import _spell_overrides, NARROW_CAPS
    b = _board()
    for name in ('Dividend', 'Annuity', 'Endowment'):
        assert _spell_overrides(b, 'red', name, dict(NARROW_CAPS)) == [{}], \
            "targetless spells keep only the greedy variant"
    print("  PASS")


def test_replay_equivalence():
    print("Testing replay equivalence (bank applied exactly once)...")
    b0 = _board()
    b0.stones['a7'] = 'red'
    b0.update()
    live = b0.copy()
    acts = live._cast_spell('Dividend', 'red')
    replay = b0.copy()
    apply_sim_turn(replay, CompleteTurn(acts), 'red')
    assert replay.prov_bank['red'] == 1, \
        "replaying a recorded cast turn must bank the stones ONCE"
    assert replay.to_sfn() == live.to_sfn()

    # A recorded placement withdraws from the bank on replay.
    b1 = _board()
    b1.prov_bank['red'] = 2
    t = next(t for t in b1.get_legal_turns('red') if _prov_moves(t))
    r = b1.copy()
    apply_sim_turn(r, t, 'red')
    assert r.prov_bank['red'] == 1
    assert r.totalstones['red'] == 3
    print("  PASS")


def test_win_semantics():
    print("Testing symmetric stone counting + board-only elimination...")
    # (a) Banked stones WIN: red 5 on board + 2 banked = 7 vs blue 3 + 1
    # phantom = 4 -> red leads by 3.
    b = _board()
    for n in ('a2', 'a3', 'a4', 'a11'):
        b.stones[n] = 'red'
    b.stones['b2'] = 'blue'
    b.stones['b3'] = 'blue'
    b.update()
    assert b.totalstones == {'red': 5, 'blue': 3}
    assert not b.check_game_over('red')
    b.prov_bank['red'] = 2
    b.update()
    assert b.score == 'r3'
    assert b.check_game_over('red') and b.winner == 'red', \
        "banked stones count toward a ±3-lead win immediately"

    # (b) Banked stones DEFEND: same board, blue banks 1 -> no win.
    b2 = _board()
    for n in ('a2', 'a3', 'a4', 'a11'):
        b2.stones[n] = 'red'
    b2.stones['b2'] = 'blue'
    b2.stones['b3'] = 'blue'
    b2.prov_bank['red'] = 2
    b2.prov_bank['blue'] = 1
    b2.update()
    assert not b2.check_game_over('red')

    # (c) Sixth-spell tally counts banks for both sides.
    b3 = _board()
    b3.stones['a2'] = 'red'     # red 2 vs blue 1+1 = 2: tied
    b3.update()
    b3.spell_counter['red'] = 6
    b3.prov_bank['blue'] = 1    # blue 3 > red 2
    assert b3.check_game_over('red') and b3.winner == 'blue'

    # (d) Elimination is board-only: no stones on board loses despite a bank.
    b4 = _board()
    b4.prov_bank['red'] = 5
    b4.stones['a1'] = None
    b4.update()
    assert b4.gameover and b4.winner == 'blue', \
        "zero board stones loses despite banked stones"
    print("  PASS")


def test_cast_values_at_depth_one():
    print("Testing banked stones are valued like placed stones...")
    from ai.minimax_ai import _apply_turn
    # With full mana, Endowment costs 2 net board stones and banks 4.
    b = _board()
    for n in POSITIONS[1]:
        b.stones[n] = 'red'
    for n in ('a1', 'b1', 'c1'):
        b.stones[n] = 'red'
    for n in ('b2', 'b3', 'b4'):
        b.stones[n] = 'blue'
    b.update()
    best_cast = best_plain = None
    for t in b.get_legal_turns('red'):
        sim = _apply_turn(b, t, 'red')
        diff = sim.effective_stones('red') - sim.effective_stones('blue')
        if any(a.type == 'cast' and a.spell == 'Endowment' for a in t.actions):
            best_cast = diff if best_cast is None else max(best_cast, diff)
        elif all(a.type in ('move', 'pass') for a in t.actions):
            best_plain = diff if best_plain is None else max(best_plain, diff)
    assert best_cast is not None and best_plain is not None
    assert best_cast == best_plain + 2, (best_cast, best_plain)
    print("  PASS")


def test_hashing_and_repetition_keys():
    print("Testing Zobrist + looping-snapshot sensitivity...")
    from ai.minimax_ai import _get_hasher
    b = _board()
    h = _get_hasher(b.spell_names)
    h0 = h.hash(b, 'red')
    assert h.hash(_board(), 'red') == h0
    b1 = b.copy()
    b1.prov_bank['red'] = 1
    b2 = b.copy()
    b2.prov_bank['red'] = 2
    b3 = b.copy()
    b3.prov_bank['blue'] = 1
    hs = {h0, h.hash(b1, 'red'), h.hash(b2, 'red'), h.hash(b3, 'red')}
    assert len(hs) == 4

    fresh = _board()
    assert '|P' not in fresh.looping_snapshot(), "legacy key byte-identical"
    fresh.prov_bank['blue'] = 3
    assert fresh.looping_snapshot().endswith('|P0/3')
    print("  PASS")


def test_sfn_roundtrip():
    print("Testing SFN pm: token round-trip...")
    b = _board()
    s_legacy = b.to_sfn()
    assert ' pm:' not in s_legacy
    assert SimBoard.from_sfn(s_legacy).to_sfn() == s_legacy

    b.prov_bank = {'red': 4, 'blue': 1}
    b.update()
    s = b.to_sfn()
    assert s.endswith(' pm:4:1'), s
    r = SimBoard.from_sfn(s)
    assert r.prov_bank == {'red': 4, 'blue': 1}
    assert r.to_sfn() == s

    b.variant = 'competitive'
    b.update()
    r2 = SimBoard.from_sfn(b.to_sfn())
    assert r2.variant == 'competitive' and r2.prov_bank['red'] == 4
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


def test_js_parity_smoke():
    print("Testing JS engine parity (leaf, enumeration, replay, win checks)...")
    js = _load_js(('constants.js', 'notation.js', 'spells.js', 'moves.js',
                   'sim-board.js', 'enumerator.js', 'minimax-ai.js',
                   'caveman-ai.js'))
    js.append(r"""
const SP = %s;
const b = new SimBoard(SP);
b.stones.a1='red'; b.stones.a2='red'; b.stones.b1='blue'; b.stones.b2='blue'; b.update();
const w = { mana: 0, voidPenalty: 0, mapControl: 0 };
const l0 = _cavemanLeaf(b, 'red', w);
b.providenceBank.red = 2; b.update();
const l1 = _cavemanLeaf(b, 'red', w);
if (!(l1 > l0)) throw new Error('leaf must credit banked stones');
const prov = t => t.actions.filter(a => a.providence).length;
const greedy = [...b.getLegalTurns('red')];
const exh = getLegalTurnsExhaustive(b, 'red');
const t = greedy.find(t => prov(t) === 1);
const r = b.copy(); applySimTurn(r, t, 'red');
const sfn = boardToSfn(r);
// Win check: red 5 + bank 2 vs blue 3 + 1.
const wb = new SimBoard(SP); wb.setupInitial ? wb.setupInitial() : null;
for (const n of ['a1','a2','a3','a4','a11']) wb.stones[n]='red';
for (const n of ['b1','b2','b3']) wb.stones[n]='blue';
wb.update();
const before = wb.checkGameOver('red');
wb.providenceBank.red = 2; wb.update();
const after = wb.checkGameOver('red') && wb.winner;
console.log('JS_RESULT ' + JSON.stringify({
  greedyMax: Math.max(...greedy.map(prov)), greedyWith: greedy.filter(t => prov(t)).length,
  exhMax: Math.max(...exh.map(prov)), bankAfter: r.providenceBank.red, sfn,
  before, after, score: wb.score,
}));
""" % json.dumps(PROVIDENCE_SPELLS))
    res = _run_node(js, 'JS_RESULT')
    assert res['greedyMax'] == 1 and res['exhMax'] == 1, res
    assert res['bankAfter'] == 1, res
    assert res['sfn'].endswith(' pm:1:0'), res['sfn']
    assert res['before'] is False and res['after'] == 'red', res
    assert res['score'] == 'r3', res

    # Python reads JS's SFN identically.
    assert SimBoard.from_sfn(res['sfn']).prov_bank == {'red': 1, 'blue': 0}
    # Greedy enumerations agree on how many placement turns exist.
    pb = SimBoard(PROVIDENCE_SPELLS)
    for n, c in (('a1', 'red'), ('a2', 'red'), ('b1', 'blue'), ('b2', 'blue')):
        pb.stones[n] = c
    pb.prov_bank['red'] = 2
    pb.update()
    py_with = sum(1 for t in pb.get_legal_turns('red') if _prov_moves(t))
    assert py_with == res['greedyWith'], (py_with, res['greedyWith'])
    print("  PASS")


def test_live_controller():
    print("Testing the live GameController Providence prompt (scripted input)...")
    js = _load_js(('constants.js', 'notation.js', 'moves.js', 'spells.js',
                   'board.js', 'game-controller.js'))
    js.append(r"""
const SEAL = %s;
async function run(setup, script) {
  const prompts = [];
  let pushOptions = [];
  const gc = new GameController((ev) => {
    if (ev && ev.type === 'pushingoptions') {
      pushOptions = Object.keys(ev).filter(k => k !== 'type' && k !== 'sourceNode');
    }
  }, { variant: 'standard' });
  const board = new SigilBoard(SEAL, 'standard');
  board.setupInitial();
  setup(board);
  board.update();
  board.providenceOpen = board.providenceBank.red > 0;   // as _runGameLoop does
  gc.board = board;
  gc._currentTurnActions = [];
  const queue = script.slice();
  gc.getInput = async (payload) => {
    if (payload.awaiting === 'action') {
      prompts.push({ actions: payload.actionlist.slice(),
                     options: Object.keys(payload.moveoptions || {}) });
      const next = queue.shift();
      if (next === undefined) throw new Error('script exhausted at ' + JSON.stringify(payload.actionlist));
      if (next === '<first>') return Object.keys(payload.moveoptions)[0];
      return next;
    }
    if (payload.awaiting === 'node') {
      if (/push/i.test(payload.message) && pushOptions.length) return pushOptions[0];
      const keys = Object.keys(payload.moveoptions || {});
      if (keys.length) return keys[0];
    }
    throw new Error('unexpected prompt ' + JSON.stringify(payload));
  };
  await gc._takeTurn('red', true, true, true, true);
  return { prompts, bank: board.providenceBank.red, open: board.providenceOpen,
           red: NODE_ORDER.filter(n => board.stones[n] === 'red'),
           blue: NODE_ORDER.filter(n => board.stones[n] === 'blue') };
}
const windSetup = (b) => { for (const n of POSITIONS[4]) b.stones[n] = 'red'; b.providenceBank.red = 2; };
const stoneSetup = (b) => {
  b.stones.a2 = 'blue'; b.stones.a11 = 'blue';
  for (const n of POSITIONS[5]) b.stones[n] = 'blue';
  b.providenceBank.red = 1;
};
function adjacentToRed(res, nodes, removed) {
  // Every offered node must touch a red stone present before the placement.
  const red = new Set(res.red.filter(n => n !== removed));
  return nodes.every(n => ADJACENCY[n].some(nb => red.has(nb)));
}
(async () => {
  const place = await run(windSetup, ['c12', '<first>', 'pass']);
  const skip = await run(windSetup, ['c12', 'skip_providence', 'pass']);
  const passAt = await run(windSetup, ['c12', 'pass']);
  const none = await run((b) => {}, ['a2', 'pass']);
  const stone = await run(stoneSetup, ['a2', 'pass']);
  // Wind: the regular move may blink anywhere, the placement may not.
  const windBlinkOffered = place.prompts[0].options.includes('c12');
  const provOpts = place.prompts[1].options;
  console.log('JS_RESULT ' + JSON.stringify({
    place: { bank: place.bank, red: place.red.length, prompts: place.prompts.map(p => p.actions), open: place.open },
    skip: { bank: skip.bank, red: skip.red.length, prompts: skip.prompts.map(p => p.actions) },
    passAt: { bank: passAt.bank, prompts: passAt.prompts.map(p => p.actions) },
    none: { prompts: none.prompts.map(p => p.actions) },
    stone: { bank: stone.bank, red: stone.red, prompts: stone.prompts.map(p => p.actions),
             options: stone.prompts.map(p => p.options) },
    windBlinkOffered, provNoBlink: !provOpts.includes('b13') && provOpts.length > 0,
  }));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
""" % json.dumps(SEAL_SPELLS))
    res = _run_node(js, 'JS_RESULT')
    p = res['place']
    assert p['prompts'][0] == ['move'], p
    assert p['prompts'][1] == ['providence', 'skip_providence', 'pass'], p
    assert 'pass' in p['prompts'][2] and 'providence' not in p['prompts'][2], p
    assert len(p['prompts']) == 3, "the placement is offered only once"
    assert p['bank'] == 1 and p['red'] == 6, p          # a1 + a8-a10 + c12 + 1
    assert p['open'] is False
    s = res['skip']
    assert s['bank'] == 2 and s['red'] == 5, s
    assert 'dash' not in s['prompts'][1], "Skip Providence is not the dash button"
    a = res['passAt']
    assert a['bank'] == 2 and len(a['prompts']) == 2, a
    assert all('providence' not in pr for pr in res['none']['prompts']), \
        "empty bank: no Providence prompt"
    assert res['windBlinkOffered'] and res['provNoBlink'], res
    st = res['stone']
    # Regular move impossible under Stone -> straight to the placement,
    # which may push (a2 / a11 are blue).
    assert st['prompts'][0] == ['providence', 'skip_providence', 'pass'], st
    assert set(st['options'][0]) == {'a2', 'a11'}, st
    assert st['bank'] == 0 and 'a2' in st['red'], st
    print("  PASS")


def main():
    test_metadata()
    test_cast_semantics()
    test_bank_stacking_and_isolation()
    test_greedy_enumeration()
    test_stone_does_not_restrict_placement()
    test_blocked_placement_keeps_bank()
    test_exhaustive_enumeration_and_caps()
    test_spell_overrides_noop()
    test_replay_equivalence()
    test_win_semantics()
    test_cast_values_at_depth_one()
    test_hashing_and_repetition_keys()
    test_sfn_roundtrip()
    test_js_parity_smoke()
    test_live_controller()
    print("All Providence tests passed.")


if __name__ == '__main__':
    main()
