"""Scramble variant tests.

Scramble disables the stone-lead win: the first player to cast their sixth
spell wins outright (no stone comparison). Elimination and threefold
repetition still end the game. It shares the end-condition slot with
Deathmatch (mutually exclusive; Deathmatch wins a composed string that
asks for both). These tests pin the variant string plumbing (Python + JS),
the terminal rule in all three boards (simboard.py, sim-board.js,
board.js), the reversed Itch / Residue Mixture counter effect, the
Caveman leaf term, and full self-play games to the finish.

Run: python -m ai.test_scramble
"""
import json
import os
import random
import subprocess

from simboard import (SimBoard, apply_sim_turn, variant_has_scramble,
                      variant_has_deathmatch, variant_has_competitive,
                      variant_has_duplicates)
from notation import NODE_ORDER

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SPELLS = ['Flourish', 'Bewitch', 'Carnage', 'Seal_of_Stone', 'Fireblast',
          'Hail_Storm', 'Seal_of_Summer', 'Sprout', 'Slash']


def _lead_board(variant, red_extra=5):
    """Red far ahead on stones (well past the +3 lead)."""
    b = SimBoard(SPELLS, variant)
    b.setup_initial()
    for n in ('a2', 'a3', 'a4', 'a5', 'a6', 'a7')[:red_extra]:
        b.stones[n] = 'red'
    b.update()
    return b


def test_helpers():
    print("Testing variant helpers + VARIANTS...")
    assert variant_has_scramble('scramble')
    assert variant_has_scramble('competitive_scramble_duplicates')
    assert not variant_has_scramble('deathmatch_scramble')  # Deathmatch wins
    assert not variant_has_scramble('standard')
    v = SimBoard.VARIANTS
    assert len(v) == 12 and len(set(v)) == 12, v
    for s in ('scramble', 'competitive_scramble', 'scramble_duplicates',
              'competitive_scramble_duplicates'):
        assert s in v, s
    assert not any('deathmatch' in s and 'scramble' in s for s in v)
    SimBoard(SPELLS, 'competitive_scramble')  # accepted
    print("  PASS")


def test_python_terminal():
    print("Testing the Python terminal rule...")
    # Standard: a big stone lead ends the game.
    b = _lead_board('standard')
    assert b.check_game_over('red') and b.winner == 'red'
    # Scramble: the same lead does nothing.
    b = _lead_board('scramble')
    assert not b.check_game_over('red') and not b.gameover
    assert not b.check_game_over('blue') and not b.gameover
    # Sixth spell for the mover wins outright, even far behind on stones.
    b = _lead_board('scramble')
    b.spell_counter['blue'] = 6
    assert not b.check_game_over('red'), "only the mover's counter triggers"
    assert b.check_game_over('blue') and b.winner == 'blue'
    # Standard would have compared stones instead (red is ahead).
    b = _lead_board('standard', red_extra=1)
    b.spell_counter['blue'] = 6
    assert b.check_game_over('blue') and b.winner == 'red'
    # Five spells is not enough.
    b = _lead_board('scramble')
    b.spell_counter['red'] = 5
    assert not b.check_game_over('red')
    # Elimination still wins.
    b = SimBoard(SPELLS, 'scramble')
    b.setup_initial()
    b.stones['b1'] = None
    b.update()
    assert b.check_game_over('red') and b.winner == 'red'
    print("  PASS")


def _playout(variant, rng, max_plies=400):
    b = SimBoard(SPELLS, variant)
    b.setup_initial()
    b.whose_turn = 'red'
    seen = {}
    for _ in range(max_plies):
        color = b.whose_turn
        key = b.looping_snapshot() if hasattr(b, 'looping_snapshot') else None
        if key is not None:
            seen[key] = seen.get(key, 0) + 1
            if seen[key] >= 3:
                return b, 'repetition'
        turns = list(b.get_legal_turns(color))
        if not turns:
            return b, 'stuck'
        # Greedy 1-ply: most own spells cast, then most material, random
        # tiebreak -- random play almost never charges a spell.
        def score(t):
            c = b.copy()
            apply_sim_turn(c, t, color)
            c.update()
            other = 'blue' if color == 'red' else 'red'
            return (c.spell_counter[color],
                    c.totalstones[color] - c.totalstones[other], rng.random())
        turn = max(turns, key=score)
        apply_sim_turn(b, turn, color)
        b.update()
        if b.check_game_over(color):
            return b, 'over'
        b.advance_turn()
    return b, 'cap'


def test_python_playouts():
    print("Testing Python random playouts under Scramble...")
    rng = random.Random(7)
    sixth = 0
    for _ in range(12):
        b, why = _playout('scramble', rng)
        if why != 'over':
            continue
        w, l = b.winner, ('blue' if b.winner == 'red' else 'red')
        if b.totalstones[l] == 0:
            continue  # elimination
        assert b.spell_counter[w] >= 6, (b.to_sfn(), b.spell_counter)
        sixth += 1
    assert sixth >= 4, sixth
    print(f"  PASS ({sixth}/12 decided by the sixth spell)")


def _run_node(js, marker, timeout=600):
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


def test_js():
    print("Testing JS plumbing and both JS boards...")
    js = _engine(('constants.js', 'notation.js', 'spells.js', 'moves.js',
                  'board.js', 'sim-board.js'))
    js.append(r"""
const SP = %s;
function lead(Cls, variant, extra) {
  const b = new Cls(SP, variant);
  b.setupInitial ? b.setupInitial() : (b.stones.a1 = 'red', b.stones.b1 = 'blue');
  for (const n of ['a2', 'a3', 'a4', 'a5', 'a6'].slice(0, extra)) b.stones[n] = 'red';
  b.update();
  return b;
}
const out = { variants: SIGIL_VARIANTS,
  norm: ['scramble_competitive', 'deathmatch_scramble', 'duplicates_scramble', 'junk', 'scramble'].map(normalizeVariant),
  compose: composeVariant(true, false, true, true),
  composeBoth: composeVariant(false, true, false, true),
  boards: {} };
for (const [name, Cls] of [['board', SigilBoard], ['sim', SimBoard]]) {
  const r = {};
  let b = lead(Cls, 'standard', 5); r.stdLead = [b.checkGameOver('red'), b.winner];
  b = lead(Cls, 'scramble', 5); r.scrLead = [b.checkGameOver('red'), b.checkGameOver('blue'), b.gameover];
  b = lead(Cls, 'scramble', 5); b.spellCounter.blue = 6;
  r.scrSixth = [b.checkGameOver('red'), b.checkGameOver('blue'), b.winner];
  b = lead(Cls, 'scramble', 5); b.spellCounter.red = 5; r.scrFive = b.checkGameOver('red');
  b = lead(Cls, 'standard', 1); b.spellCounter.blue = 6; r.stdSixth = [b.checkGameOver('blue'), b.winner];
  out.boards[name] = r;
}
console.log('JS_RESULT ' + JSON.stringify(out));
""" % json.dumps(SPELLS))
    res = _run_node(js, 'JS_RESULT')
    assert res['variants'] == list(SimBoard.VARIANTS), (res['variants'], SimBoard.VARIANTS)
    assert res['norm'] == ['competitive_scramble', 'deathmatch', 'scramble_duplicates',
                           'standard', 'scramble'], res['norm']
    assert res['compose'] == 'competitive_scramble_duplicates'
    assert res['composeBoth'] == 'deathmatch'
    for name, r in res['boards'].items():
        assert r['stdLead'] == [True, 'red'], (name, r)
        assert r['scrLead'] == [False, False, False], (name, r)
        assert r['scrSixth'] == [False, True, 'blue'], (name, r)
        assert r['scrFive'] is False, (name, r)
        assert r['stdSixth'] == [True, 'red'], (name, r)
    print("  PASS")


def test_panda_counter_reversal():
    print("Testing Itch / Residue Mixture: enemy counter goes BACK in Scramble...")
    js = _engine(('constants.js', 'notation.js', 'spells.js', 'moves.js',
                  'board.js', 'sim-board.js', 'minimax-ai.js'))
    js.append(r"""
const SP = ['Flourish', 'Carnage', 'Bewitch', 'Grow', 'Hail_Storm', 'Meteor', 'Itch', 'Residue_Mixture', 'Slash'];
function setup(b) {
  b.stones.a1 = 'red'; b.stones.b1 = 'blue'; b.stones.b5 = 'blue';
  b.spellCounter.red = 3; b.spellCounter.blue = 2;
  b.update();
}
(async () => {
  const out = {};
  for (const v of ['standard', 'scramble', 'deathmatch']) {
    const r = {};
    for (const spell of ['Itch', 'Residue_Mixture']) {
      // Live resolver (spells.js), auto-answering every prompt.
      const live = new SigilBoard(SP, v); setup(live);
      const msgs = [];
      const getInput = async (p) => { const k = Object.keys(p.moveoptions || {}); return k[0] || NODE_ORDER.find(n => live.stones[n] === 'blue'); };
      await SpellResolvers[spell === 'Itch' ? 'itch' : 'residue_mixture'](live, 'red', spell, getInput, (e) => { if (e && e.message) msgs.push(e.message); });
      // Sim resolver, then replay its recorded actions with both replayers.
      const sim = new SimBoard(SP, v); setup(sim);
      const idx = SP.indexOf(spell) + 1;
      const acts = sim._resolveSpell(spell, 'red', POSITIONS[idx] || [], {}) || [];
      const bump = acts.find(a => a.type === 'lock_bump');
      const rep = new SimBoard(SP, v); setup(rep);
      applySimTurn(rep, new SimTurn([bump]), 'red');
      const rep2 = new SimBoard(SP, v); setup(rep2);
      const rep2b = _minimaxApplyTurn(rep2, new SimTurn([bump, new SimAction('pass')]), 'red');
      r[spell] = { live: live.spellCounter.blue, sim: sim.spellCounter.blue, replay: rep.spellCounter.blue,
                   minimax: rep2b.spellCounter.blue, msg: msgs[msgs.length - 1] };
    }
    // Floor at zero in Scramble.
    const z = new SimBoard(SP, v); setup(z); z.spellCounter.blue = 0;
    bumpEnemySpellCounter(z, 'blue'); r.floor = z.spellCounter.blue;
    out[v] = r;
  }
  console.log('JS_RESULT ' + JSON.stringify(out));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
""")
    res = _run_node(js, 'JS_RESULT')
    want = {'standard': 3, 'scramble': 1, 'deathmatch': 2}
    for v, n in want.items():
        for spell in ('Itch', 'Residue_Mixture'):
            r = res[v][spell]
            assert r['live'] == r['sim'] == r['replay'] == r['minimax'] == n, (v, spell, r)
        assert res[v]['floor'] == (1 if v == 'standard' else 0), (v, res[v])
    assert 'reduced' in res['scramble']['Itch']['msg'], res['scramble']
    assert 'advanced' in res['standard']['Itch']['msg'], res['standard']
    print("  PASS")


def test_caveman_selfplay():
    print("Testing the Caveman leaf + self-play under Scramble (JS, short budget)...")
    js = [r"""
const path = require('path');
process.chdir(%s);
const { loadEngine } = require(path.join(%s, 'tools', 'arena', 'engine.js'));
const { playGame } = require(path.join(%s, 'tools', 'arena', 'play-game.js'));
const { parseModeSpec } = require(path.join(%s, 'tools', 'arena', 'engine.js'));
(async () => {
  const E = loadEngine();
  // Leaf: a spell-counter lead is worth evalWeights.scrambleSpell stones per
  // spell in Scramble only (function declarations are vm globals).
  const leaf = {};
  for (const v of ['standard', 'scramble']) {
    const b = new E.SimBoard(E.generateSpellList(['core']), v);
    b.stones.a1 = 'red'; b.stones.b1 = 'blue'; b.update();
    b.spellCounter = { red: 3, blue: 1 };
    leaf[v] = _cavemanLeaf(b, 'red', _cavemanResolveWeights(null), 0) * 39;
    leaf[v + '_ssw3'] = _cavemanLeaf(b, 'red', _cavemanResolveWeights({ scrambleSpell: 3 }), 0) * 39;
    leaf[v + '_ssw0'] = _cavemanLeaf(b, 'red', _cavemanResolveWeights({ scrambleSpell: 0 }), 0) * 39;
  }
  const results = [leaf];
  for (let g = 0; g < 4; g++) {
    const spellNames = E.generateSpellList(['core']);
    const r = await playGame(E, { gameId: g, spellNames, redCfg: parseModeSpec('caveman'),
      blueCfg: parseModeSpec('caveman'), timeLimit: 0.05, maxDepth: 64, maxTurns: 300, variant: 'scramble' });
    results.push({ winner: r.winner, endReason: r.endReason, finalStones: r.finalStones, finalSpells: r.finalSpells, plies: r.plies });
  }
  console.log('JS_RESULT ' + JSON.stringify(results));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
""" % tuple([json.dumps(REPO)] * 4)]
    res = _run_node(js, 'JS_RESULT')
    leaf, res = res[0], res[1:]
    assert abs(leaf['scramble'] - leaf['standard']) < 1e-9, leaf  # default weight 0
    assert abs(leaf['scramble_ssw3'] - leaf['standard'] - 6.0) < 1e-9, leaf  # 2 spells x 3
    assert abs(leaf['standard_ssw3'] - leaf['standard']) < 1e-9, leaf
    assert abs(leaf['standard_ssw0'] - leaf['standard']) < 1e-9, leaf
    decided = 0
    for r in res:
        if r['endReason'] != 'normal' or r['winner'] is None:
            continue
        w = r['winner']
        l = 'blue' if w == 'red' else 'red'
        if r['finalStones'][l] == 0:
            continue
        assert r['finalSpells'][w] >= 6, r
        decided += 1
    assert decided >= 1, res
    print(f"  PASS ({decided}/{len(res)} decided by the sixth spell): {res}")


def main():
    test_helpers()
    test_python_terminal()
    test_python_playouts()
    test_js()
    test_panda_counter_reversal()
    test_caveman_selfplay()
    print("All Scramble tests passed.")


if __name__ == '__main__':
    main()
