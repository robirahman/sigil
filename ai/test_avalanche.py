"""Avalanche (Experimental sorcery) tests.

Avalanche is Rock Slide with every push chosen first and all of them
resolved at once. Covered here: the pure simultaneous resolver
(simboard.resolve_avalanche) on every rule case, the greedy destination
picker, SimBoard casting + replay equivalence, the live Python spell
(spellfile.Avalanche, scripted human + AI), and JS parity: the same random
positions through constants.js (resolveAvalanche / avalancheGreedyPushes),
sim-board.js, and the interactive spells.js resolver driven by scripted
input.

Run: python -m ai.test_avalanche
"""
import json
import os
import random
import subprocess

import itertools
import time

from simboard import (SimBoard, Action, CompleteTurn, apply_sim_turn, CORE_SPELLS,
                      DESTROYED, avalanche_sources, avalanche_greedy_pushes,
                      avalanche_optimal_pushes, resolve_avalanche)
from notation import NODE_ORDER, POSITIONS, ADJACENCY

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Avalanche in slot 4 (the first sorcery slot -> POSITIONS[4] = a8 a9 a10).
SPELLS = ['Flourish', 'Carnage', 'Bewitch',
          'Avalanche', 'Fireblast', 'Hail_Storm',
          'Sprout', 'Slash', 'Surge']

TEXT = ("Push each enemy stone bordering you into an adjacent node. All pushes "
        "happen simultaneously. Stones already occupying a destination are "
        "destroyed; stones pushed onto each other's nodes, or into the same "
        "node, are destroyed.")


def _empty(**placed):
    stones = {n: None for n in NODE_ORDER}
    stones.update(placed)
    return stones


def _apply(stones, pushes):
    final, lost = resolve_avalanche(stones, pushes)
    out = dict(stones)
    out.update(final)
    return out, sorted(lost)


def _p(*pairs):
    return [{'from': f, 'to': t} for f, t in pairs]


def test_registration():
    print("Testing Avalanche metadata + pack registration...")
    assert CORE_SPELLS['Avalanche'] == {'resolve': 'avalanche', 'static': False, 'ischarm': False}
    import spellgenerator as g
    assert g.EXPANSIONS['experimental']['sorceries'] == ['Spring_Tide', 'Rapids', 'Avalanche']
    assert 'Avalanche' in g.UNRATED_SPELLS
    import spellfile
    assert spellfile.Avalanche(None, [], 'Avalanche').text == TEXT
    # Rock Slide is untouched.
    assert CORE_SPELLS['Rock_Slide']['resolve'] == 'rock_slide'
    print("  PASS")


def test_resolver_rules():
    print("Testing resolve_avalanche rule cases...")
    # Into an empty node: the stone just moves.
    out, lost = _apply(_empty(a8='blue'), _p(('a8', 'a7')))
    assert out['a8'] is None and out['a7'] == 'blue' and lost == []
    # Into a stationary enemy stone / own stone: the occupant is destroyed.
    out, lost = _apply(_empty(a8='blue', a7='blue'), _p(('a8', 'a7')))
    assert out['a8'] is None and out['a7'] == 'blue' and lost == [('a7', 'blue')]
    out, lost = _apply(_empty(a8='blue', a7='red'), _p(('a8', 'a7')))
    assert out['a7'] == 'blue' and lost == [('a7', 'red')]
    # Swap: both destroyed.
    out, lost = _apply(_empty(a8='blue', a9='blue'), _p(('a8', 'a9'), ('a9', 'a8')))
    assert out['a8'] is None and out['a9'] is None and len(lost) == 2
    # Two into the same (empty) node: both destroyed.
    out, lost = _apply(_empty(a8='blue', a10='blue'), _p(('a8', 'a9'), ('a10', 'a9')))
    assert out['a8'] is None and out['a9'] is None and out['a10'] is None
    assert lost == [('a9', 'blue'), ('a9', 'blue')]
    # ...and onto a stationary stone: all three destroyed.
    out, lost = _apply(_empty(a8='blue', a10='blue', a9='red'), _p(('a8', 'a9'), ('a10', 'a9')))
    assert out['a9'] is None and lost == [('a9', 'blue'), ('a9', 'blue'), ('a9', 'red')]
    # Chain A->B->C ending on a stationary stone: only C's stone dies.
    out, lost = _apply(_empty(a7='blue', a8='blue', a9='red'), _p(('a7', 'a8'), ('a8', 'a9')))
    assert (out['a7'], out['a8'], out['a9']) == (None, 'blue', 'blue') and lost == [('a9', 'red')]
    # Chain ending on an empty node: nothing dies.
    out, lost = _apply(_empty(a7='blue', a8='blue'), _p(('a7', 'a8'), ('a8', 'a9')))
    assert (out['a7'], out['a8'], out['a9']) == (None, 'blue', 'blue') and lost == []
    # Closed 3-cycle (a8-a9-a10 is a triangle): stones rotate, nothing dies.
    out, lost = _apply(_empty(a8='blue', a9='blue', a10='red'),
                       _p(('a8', 'a9'), ('a9', 'a10'), ('a10', 'a8')))
    assert (out['a8'], out['a9'], out['a10']) == ('red', 'blue', 'blue') and lost == []
    # Into a wall: the stone dies and the wall stays permanently destroyed.
    stones = _empty(a8='blue', a7=DESTROYED)
    final, lost = resolve_avalanche(stones, _p(('a8', 'a7')))
    assert 'a7' not in final and final['a8'] is None and lost == [('a7', 'blue')]
    # Two into a wall: both die, wall stays.
    out, lost = _apply(_empty(a8='blue', a10='blue', a9=DESTROYED), _p(('a8', 'a9'), ('a10', 'a9')))
    assert out['a9'] == DESTROYED and out['a8'] is None and out['a10'] is None and len(lost) == 2
    # Pure: the input is not mutated.
    stones = _empty(a8='blue', a9='blue')
    resolve_avalanche(stones, _p(('a8', 'a9'), ('a9', 'a8')))
    assert stones['a8'] == 'blue' and stones['a9'] == 'blue'
    print("  PASS")


def _sim(**placed):
    b = SimBoard(SPELLS)
    b.setup_initial()
    for n in NODE_ORDER:
        b.stones[n] = None
    b.stones.update(placed)
    b.update()
    b.whose_turn = 'red'
    return b


def test_greedy():
    print("Testing avalanche_greedy_pushes...")
    # Red a9 borders blue a8 + a10 (a8-a10 adjacent). Best is the swap
    # (+2); dumping both on a9 is only +1 (kills red a9 too).
    stones = _empty(a9='red', a8='blue', a10='blue', c5='red', b1='blue')
    assert avalanche_sources(stones, 'red') == ['a8', 'a10']
    pushes = avalanche_greedy_pushes(stones, 'red')
    assert pushes == _p(('a8', 'a10'), ('a10', 'a8')), pushes
    # Forced own loss: blue a1 only borders red a2 / red a11.
    stones = _empty(a1='blue', a2='red', a11='red', b1='blue')
    pushes = avalanche_greedy_pushes(stones, 'red')
    assert len(pushes) == 1
    _, lost = resolve_avalanche(stones, pushes)
    assert lost == [(pushes[0]['to'], 'red')]
    # Prefers destroying a stationary enemy over an empty push.
    stones = _empty(a4='red', a7='blue', a8='blue', b1='blue')
    pushes = avalanche_greedy_pushes(stones, 'red')
    _, lost = resolve_avalanche(stones, pushes)
    assert [c for _, c in lost] == ['blue'], (pushes, lost)
    # Overrides pin a choice; invalid ones are ignored.
    stones = _empty(a9='red', a8='blue', a10='blue', c5='red', b1='blue')
    pushes = avalanche_greedy_pushes(stones, 'red', _p(('a8', 'a7'), ('c5', 'c4'), ('a10', 'c1')))
    assert pushes[0] == {'from': 'a8', 'to': 'a7'}
    print("  PASS")


def _brute(stones, color):
    """Naive 3^s reference: the max net, and the distinct boards reaching it."""
    srcs = avalanche_sources(stones, color)
    best, boards = None, set()
    for combo in itertools.product(*[ADJACENCY[s] for s in srcs]):
        pushes = [{'from': s, 'to': d} for s, d in zip(srcs, combo)]
        final, lost = resolve_avalanche(stones, pushes)
        net = sum(1 if c != color else -1 for _, c in lost)
        board = dict(stones)
        board.update(final)
        key = tuple(board[n] for n in NODE_ORDER)
        if best is None or net > best:
            best, boards = net, set()
        if net == best:
            boards.add(key)
    return best, boards


def _net_and_board(stones, pushes, color='red'):
    final, lost = resolve_avalanche(stones, pushes)
    board = dict(stones)
    board.update(final)
    return sum(1 if c != color else -1 for _, c in lost), tuple(board[n] for n in NODE_ORDER)


def test_optimal_matches_brute_force():
    print("Testing avalanche_optimal_pushes against 3^s brute force...")
    rng = random.Random(4242)
    checked = 0
    while checked < 250:
        stones = {}
        density = rng.uniform(0.3, 0.9)
        for node in NODE_ORDER:
            r = rng.random()
            stones[node] = DESTROYED if r < 0.05 else (
                rng.choice(['red', 'blue']) if r < density else None)
        if len(avalanche_sources(stones, 'red')) > 8:
            continue
        checked += 1
        best, boards = _brute(stones, 'red')
        got_best, options = avalanche_optimal_pushes(stones, 'red')
        assert got_best == best, (got_best, best)
        got = [_net_and_board(stones, p) for p in options]
        assert all(net == best for net, _ in got)
        got_boards = [b for _, b in got]
        assert len(set(got_boards)) == len(got_boards), "two options give the same board"
        assert set(got_boards) == boards, "optimal outcome set differs from brute force"
        # The limit keeps a prefix of the full list.
        assert avalanche_optimal_pushes(stones, 'red', limit=2)[1] == options[:2]
    print("  PASS (%d positions)" % checked)


def test_optimal_shapes():
    print("Testing optimal Avalanche shapes (pair, triangle, 5-cycle, 5-chain, sinks)...")
    # Touching pair: swap them (+2).
    st = _empty(a9='red', a8='blue', a10='blue', b4='blue')
    best, opts = avalanche_optimal_pushes(st, 'red')
    assert best == 2 and opts == [_p(('a8', 'a10'), ('a10', 'a8'))], (best, opts)
    # Triangle a8/a9/a10, each bordering red: all three destroyed, one board.
    st = _empty(a7='red', a13='red', b11='red', a8='blue', a9='blue', a10='blue', b4='blue')
    best, opts = avalanche_optimal_pushes(st, 'red')
    assert best == 3 and len(opts) == 1, (best, opts)
    # Odd loop: the a2-a6 ritual 5-cycle, each bordering red -> all 5 destroyed.
    st = _empty(a1='red', a13='red', a7='red', a12='red', a11='red',
                a2='blue', a3='blue', a4='blue', a5='blue', a6='blue', b4='blue')
    best, opts = avalanche_optimal_pushes(st, 'red')
    assert best == 5 and len(opts) == 1, (best, opts)
    # 5-chain c11-c6-c5-c4-c3: two swaps + the middle stone into either
    # swap -> the same board, so ONE option although brute force finds
    # several optimal push sets.
    st = _empty(b10='red', c2='red', c12='red', c7='red', c13='red',
                c11='blue', c6='blue', c5='blue', c4='blue', c3='blue', b4='blue')
    best, opts = avalanche_optimal_pushes(st, 'red')
    assert best == 5 and len(opts) == 1, (best, opts)
    srcs = avalanche_sources(st, 'red')
    n_optimal = sum(1 for combo in itertools.product(*[ADJACENCY[s] for s in srcs])
                    if _net_and_board(st, [{'from': s, 'to': d} for s, d in zip(srcs, combo)])[0] == 5)
    assert n_optimal > 1, n_optimal
    # Two pushes into a stationary enemy stone: +3 (beats the +2 swap).
    st = _empty(a7='red', b11='red', a8='blue', a10='blue', a9='blue', b4='blue')
    best, opts = avalanche_optimal_pushes(st, 'red')
    assert best == 3 and opts == [_p(('a8', 'a9'), ('a10', 'a9'))], (best, opts)
    # Wall sink.
    st = _empty(a9='red', a8='blue', a7=DESTROYED, b4='blue')
    best, opts = avalanche_optimal_pushes(st, 'red')
    assert best == 1 and opts == [_p(('a8', 'a7'))], (best, opts)
    # Forced own loss: blue a1 only borders red a2 / red a11.
    st = _empty(a1='blue', a2='red', a11='red', b4='blue')
    best, opts = avalanche_optimal_pushes(st, 'red')
    assert best == -1 and len(opts) == 2, (best, opts)
    # Neutral ties are separate boards: c5 may go to c4 or c6 (not own c12).
    st = _empty(c12='red', c5='blue', b4='blue')
    best, opts = avalanche_optimal_pushes(st, 'red')
    assert best == 0 and opts == [_p(('c5', 'c4')), _p(('c5', 'c6'))], (best, opts)
    # Pinned override: the rest is optimized around it.
    st = _empty(a9='red', a8='blue', a10='blue', c5='red', b4='blue')
    best, opts = avalanche_optimal_pushes(st, 'red', _p(('a8', 'a7')))
    assert opts[0][0] == {'from': 'a8', 'to': 'a7'} and best == 0, (best, opts)
    print("  PASS")


def test_optimal_timing():
    print("Timing avalanche_optimal_pushes on dense random boards...")
    import simboard
    worst, total, n = 0.0, 0.0, 0
    for stones in _random_positions(400, seed=99, dense=True):
        simboard._AVALANCHE_MEMO.clear()
        t0 = time.perf_counter()
        avalanche_optimal_pushes(stones, 'red', limit=12)
        dt = time.perf_counter() - t0
        worst, total, n = max(worst, dt), total + dt, n + 1
    assert worst < 0.5, worst
    print("  PASS (mean %.2f ms, max %.2f ms)" % (1000 * total / n, 1000 * worst))


def test_enumerator_variants():
    print("Testing exhaustive enumeration: one turn per distinct max-net outcome...")
    from ai.enumerator import get_legal_turns_exhaustive
    # Ties guaranteed: c5 (bordering red c12) has two neutral destinations.
    b = _sim(a8='red', a9='red', a10='red', b11='blue', a7='blue', b1='blue',
             c5='blue', c12='red', a1='red')
    turns = list(get_legal_turns_exhaustive(b, 'red', caps={}))
    groups = {}
    for t in turns:
        idx = next((i for i, a in enumerate(t.actions) if a.type == 'avalanche'), None)
        if idx is None:
            continue
        pre = b.copy()
        apply_sim_turn(pre, CompleteTurn(t.actions[:idx]), 'red')
        best, options = avalanche_optimal_pushes(pre.stones, 'red')
        pushes = t.actions[idx].pushes
        assert pushes in options[:12], pushes
        net, board = _net_and_board(pre.stones, pushes)
        assert net == best
        prefix = repr([(a.type, a.node, a.pushed_to, a.spell, a.kept) for a in t.actions[:idx]])
        suffix = repr([(a.type, a.node, a.sacrificed) for a in t.actions[idx + 1:]])
        groups.setdefault((prefix, suffix), []).append(board)
    assert groups, "no Avalanche turns"
    for boards in groups.values():
        assert len(set(boards)) == len(boards), "duplicate Avalanche outcomes in one branch"
    assert any(len(v) > 1 for v in groups.values()), "tie variants never enumerated"
    print("  PASS (%d branches, max %d variants)" % (len(groups), max(len(v) for v in groups.values())))


def test_js_enumerator_and_timing():
    print("Testing JS exhaustive enumeration variants + JS solve timing...")
    dense = _random_positions(400, seed=99, dense=True)
    js = _load_engine_js(('constants.js', 'notation.js', 'spells.js', 'moves.js',
                          'sim-board.js', 'enumerator.js'))
    js.append(r"""
const SP = %s;
const b = new SimBoard(SP);
for (const n of NODE_ORDER) b.stones[n] = null;
Object.assign(b.stones, { a8: 'red', a9: 'red', a10: 'red', b11: 'blue', a7: 'blue', b1: 'blue',
                          c5: 'blue', c12: 'red', a1: 'red' });
b.update(); b.whoseTurn = 'red';
const turns = getLegalTurnsExhaustive(b, 'red', ENUM_CAPS);
const groups = new Map();
for (const t of turns) {
  const idx = t.actions.findIndex(a => a.type === 'avalanche');
  if (idx < 0) continue;
  const pre = b.copy();
  applySimTurn(pre, new SimTurn(t.actions.slice(0, idx)), 'red');
  const [best, options] = avalancheOptimalPushes(pre.stones, 'red', null, null);
  const pushes = t.actions[idx].pushes;
  if (!options.slice(0, ENUM_CAPS.avalanche).some(o => JSON.stringify(o) === JSON.stringify(pushes))) throw new Error('non-optimal pushes ' + JSON.stringify(pushes));
  const { final } = resolveAvalanche(pre.stones, pushes);
  const board = NODE_ORDER.map(n => (n in final ? final[n] : pre.stones[n])).join(',');
  const key = JSON.stringify(t.actions.slice(0, idx).map(a => [a.type, a.node, a.pushed_to, a.spell, a.kept]))
    + '|' + JSON.stringify(t.actions.slice(idx + 1).map(a => [a.type, a.node, a.sacrificed]));
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(board);
}
let maxV = 0;
for (const v of groups.values()) {
  if (new Set(v).size !== v.length) throw new Error('duplicate outcomes in a branch');
  maxV = Math.max(maxV, v.length);
}
const POS = %s;
let worst = 0, total = 0;
for (const st of POS) {
  _AVALANCHE_MEMO.clear();
  const t0 = process.hrtime.bigint();
  avalancheOptimalPushes(st, 'red', null, 12);
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  worst = Math.max(worst, dt); total += dt;
}
console.log('JS_RESULT ' + JSON.stringify({ branches: groups.size, maxV, worst, mean: total / POS.length }));
""" % (json.dumps(SPELLS), json.dumps(dense)))
    res = _run_node(js, 'JS_RESULT')
    assert res['branches'] > 0 and res['maxV'] > 1, res
    assert res['worst'] < 500, res
    print("  PASS (%d branches, max %d variants; JS mean %.2f ms, max %.2f ms)"
          % (res['branches'], res['maxV'], res['mean'], res['worst']))


def test_sim_cast_and_replay():
    print("Testing SimBoard cast + replay equivalence...")
    b = _sim(a9='red', a8='blue', a10='blue', c5='red', b1='blue', a7='red')
    before = b.copy()
    acts = b._resolve_spell('Avalanche', 'red', POSITIONS[4])
    assert len(acts) == 1 and acts[0].type == 'avalanche'
    assert acts[0].pushes == _p(('a8', 'a10'), ('a10', 'a8'))
    assert sorted(acts[0].destroyed) == ['a10', 'a8']
    assert b.stones['a8'] is None and b.stones['a10'] is None
    apply_sim_turn(before, CompleteTurn([acts[0]]), 'red')
    assert all(before.stones[n] == b.stones[n] for n in NODE_ORDER)
    # Nothing bordering: an empty action, board unchanged.
    b = _sim(a1='red', c13='blue')
    acts = b._resolve_spell('Avalanche', 'red', POSITIONS[4])
    assert acts[0].pushes == [] and b.stones['c13'] == 'blue'
    # Full turn generation with Avalanche charged (greedy + exhaustive).
    from ai.enumerator import get_legal_turns_exhaustive
    b = _sim(a8='red', a9='red', a10='red', b11='blue', a7='blue', b1='blue', c5='blue', a1='red')
    assert 'Avalanche' in b.charged_spells['red']
    for turns in (list(b.get_legal_turns('red')),
                  list(get_legal_turns_exhaustive(b, 'red', caps={}))):
        casts = [t for t in turns if any(a.type == 'avalanche' for a in t.actions)]
        assert casts, "no Avalanche casts enumerated"
        for t in casts[:20]:
            replay = b.copy()
            apply_sim_turn(replay, t, 'red')
    print("  PASS")


class _FakePlayer:
    def __init__(self, board, color, ishuman, script=()):
        self.board = board
        self.color = color
        self.enemy = 'blue' if color == 'red' else 'red'
        self.ishuman = ishuman
        self.script = list(script)
        self.messages = []
        self.opp = self

    def jmessage(self, msg, awaiting=None):
        self.messages.append(msg)

    def receivemessage(self):
        return self.script.pop(0)


def _live_board(placed):
    import game
    board = game.Board()
    for name in board.nodes:
        board.nodes[name].stone = None
    for name, value in placed.items():
        board.nodes[name].stone = value
    # Players are not attached, so skip the stone-count bookkeeping.
    board.update = lambda *a, **k: None
    return board


def test_live_python_spell():
    print("Testing spellfile.Avalanche (scripted human + AI)...")
    import spellfile
    import time
    placed = dict(a9='red', a8='blue', a10='blue', c5='red', b1='blue', a7=DESTROYED)
    board = _live_board(placed)
    # Human: an invalid pick (c5, own stone) is re-prompted, then a8 -> a7
    # (a wall: blue dies) and a10 -> a8 (vacated: lands).
    player = _FakePlayer(board, 'red', True, ['c5', 'a8', 'a7', 'a10', 'a8'])
    spellfile.Avalanche(board, [], 'Avalanche').resolve(player)
    got = {n: board.nodes[n].stone for n in ('a7', 'a8', 'a9', 'a10')}
    assert got == {'a7': DESTROYED, 'a8': 'blue', 'a9': 'red', 'a10': None}, got
    assert player.script == [] and any('destroyed' in m for m in player.messages)
    # AI: the greedy picker (swap, both blue stones die).
    board = _live_board(dict(a9='red', a8='blue', a10='blue', c5='red', b1='blue'))
    player = _FakePlayer(board, 'red', False)
    real_sleep = time.sleep
    time.sleep = lambda s: None
    try:
        spellfile.Avalanche(board, [], 'Avalanche').resolve(player)
    finally:
        time.sleep = real_sleep
    assert board.nodes['a8'].stone is None and board.nodes['a10'].stone is None
    assert board.nodes['a9'].stone == 'red'
    print("  PASS")


def _random_positions(n, seed=20260930, dense=False):
    rng = random.Random(seed)
    out = []
    for i in range(n):
        stones = {}
        density = rng.uniform(0.75, 1.0) if dense else rng.uniform(0.35, 0.85)
        for node in NODE_ORDER:
            r = rng.random()
            if r < 0.04:
                stones[node] = DESTROYED
            elif r < density:
                stones[node] = rng.choice(['red', 'blue'])
            else:
                stones[node] = None
        out.append(stones)
    return out


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


def test_js_parity():
    print("Testing JS parity (random positions: optimal sets, greedy, resolution, sim cast)...")
    positions = _random_positions(60) + _random_positions(40, seed=7, dense=True)
    py = []
    for stones in positions:
        best, options = avalanche_optimal_pushes(stones, 'red', limit=12)
        pushes = avalanche_greedy_pushes(stones, 'red')
        assert pushes == options[0]
        final, lost = resolve_avalanche(stones, pushes)
        py.append({'best': best, 'options': options, 'pushes': pushes, 'final': final,
                   'lost': [list(x) for x in lost]})
    js = _load_engine_js(('constants.js', 'notation.js', 'spells.js', 'moves.js', 'sim-board.js'))
    js.append(r"""
const POS = %s;
const SP = %s;
const out = POS.map(stones => {
  const [best, options] = avalancheOptimalPushes(stones, 'red', null, 12);
  const pushes = avalancheGreedyPushes(stones, 'red');
  const { final, lost } = resolveAvalanche(stones, pushes);
  // Same position through the SimBoard resolver + replay.
  const b = new SimBoard(SP);
  for (const n of NODE_ORDER) b.stones[n] = stones[n];
  b.update();
  const before = b.copy();
  const acts = b._resolveSpell('Avalanche', 'red', POSITIONS[4]);
  applySimTurn(before, new SimTurn(acts), 'red');
  for (const n of NODE_ORDER) if (before.stones[n] !== b.stones[n]) throw new Error('replay mismatch at ' + n);
  if (JSON.stringify(acts[0].pushes) !== JSON.stringify(pushes)) throw new Error('sim pushes differ');
  return { best, options, pushes, final, lost };
});
if (!isUnratedSpell('Avalanche') || EXPANSIONS.experimental.sorceries.join() !== 'Spring_Tide,Rapids,Avalanche') throw new Error('pack');
if (SPELL_TEXTS.Avalanche !== %s) throw new Error('text');
console.log('JS_RESULT ' + JSON.stringify(out));
""" % (json.dumps(positions), json.dumps(SPELLS), json.dumps(TEXT)))
    res = _run_node(js, 'JS_RESULT')
    for i, (p, j) in enumerate(zip(py, res)):
        for k in ('best', 'options', 'pushes', 'final', 'lost'):
            assert p[k] == j[k], (i, k, p[k], j[k])
    print("  PASS (%d positions)" % len(py))


def test_js_interactive_resolver():
    print("Testing the interactive spells.js resolver (scripted input)...")
    js = _load_engine_js(('constants.js', 'notation.js', 'moves.js', 'spells.js', 'board.js'))
    js.append(r"""
const SP = %s;
(async () => {
  const board = new SigilBoard(SP, 'standard');
  board.setupInitial();
  for (const n of NODE_ORDER) board.stones[n] = null;
  Object.assign(board.stones, { a9: 'red', a8: 'blue', a10: 'blue', c5: 'red', b1: 'blue', a7: 'X', a4: 'red' });
  board.update();
  // c5 (not bordering) and an early 'submit' are re-prompted; a10 -> a9,
  // a8 -> a7 (wall); then a10 is re-aimed to a8 before submitting.
  const script = ['c5', 'submit', 'a10', 'a9', 'a8', 'a7', 'a10', 'a8', 'submit'];
  const prompts = [];
  const events = [];
  const arrows = [];
  const getInput = async (payload) => {
    prompts.push({ opts: Object.keys(payload.moveoptions || {}).sort(), actions: payload.actionlist || [] });
    return script.shift();
  };
  const emit = (ev) => {
    events.push(ev && ev.type);
    if (ev && ev.type === 'push_arrows') arrows.push(ev.arrows.map(a => a.from + '>' + a.to));
  };
  await SpellResolvers.avalanche(board, 'red', 'Avalanche', getInput, emit);
  const stones = {}; for (const n of ['a4', 'a7', 'a8', 'a9', 'a10']) stones[n] = board.stones[n];
  console.log('JS_RESULT ' + JSON.stringify({ stones, prompts, left: script.length, events, arrows,
                                              crushed: !!board.crushedThisTurn }));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
""" % json.dumps(SPELLS))
    res = _run_node(js, 'JS_RESULT')
    assert res['stones'] == {'a4': 'red', 'a7': 'X', 'a8': 'blue', 'a9': 'red', 'a10': None}, res
    assert res['left'] == 0 and res['crushed'], res
    p = res['prompts']
    # First pick offers both bordering stones (a7's wall never borders);
    # Submit is withheld until every stone has an arrow.
    assert p[0] == {'opts': ['a10', 'a8'], 'actions': []}, p[0]
    assert p[1]['actions'] == [], p[1]
    # Destinations include the wall.
    assert 'a7' in p[5]['opts'], p[5]
    # All aimed: Submit offered, both stones still clickable for re-aiming.
    assert p[6] == {'opts': ['a10', 'a8'], 'actions': ['submit']}, p[6]
    assert p[-1]['actions'] == ['submit'], p[-1]
    # Arrows grow per choice, re-aim replaces, then clear before resolving.
    assert res['arrows'] == [['a10>a9'], ['a8>a7', 'a10>a9'], ['a8>a7', 'a10>a8'], []], res['arrows']
    ev = res['events']
    assert ev.index('push_animation') > max(i for i, t in enumerate(ev) if t == 'push_arrows')
    assert 'crush_animation' in ev and ev.count('push_animation') == 2
    print("  PASS")


def main():
    test_registration()
    test_resolver_rules()
    test_greedy()
    test_optimal_matches_brute_force()
    test_optimal_shapes()
    test_optimal_timing()
    test_enumerator_variants()
    test_sim_cast_and_replay()
    test_live_python_spell()
    test_js_parity()
    test_js_enumerator_and_timing()
    test_js_interactive_resolver()
    print("All Avalanche tests passed.")


if __name__ == '__main__':
    main()
