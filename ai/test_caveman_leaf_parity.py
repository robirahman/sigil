"""Cross-check the JS caveman leaf eval against a Python reference.

The JS `_cavemanLeaf` (docs/static/scripts/engine/caveman-ai.js) is the
only implementation used in play; this test pins its formula and sign
conventions against a tiny independent Python reference so the
regression pipeline (ai/fit_positional_weights.py) and the shipped leaf
can't silently disagree:

    score = (effDiff + burnCreditDiff + mana*manaDiff
             - voidPenalty*voidDiff + mapControl*mcDiff) / 39
                                            (mover POV, non-terminal)

where effDiff uses effectiveStones = real stones + Providence phantoms
(scheduled extras, plus this-turn extras for the side to move) + own
Ambush snares, and burnCreditDiff is the Aftershock engagement-capped
credit: min(scheduled burns incl. the popped this-turn counter, enemy
stones currently adjacent to that side's stones).

Checks several weight sets (zeros = legacy behavior, a capped set, an
asymmetric set) on synthetic fixtures (including schedule-, burn- and
snare-bearing boards) + sampled selfplay positions, for both colors,
asserting equality within 1e-12 and the negamax antisymmetry
leaf(red) == -leaf(blue).

Run:
    python -m ai.test_caveman_leaf_parity
"""

import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from notation import NODE_ORDER, POSITIONS, ADJACENCY
from simboard import MANA_NODES
from ai.features import map_control

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')
DATA = os.path.join(REPO, 'ai', 'data', 'selfplay_v22b_2026-05-03.jsonl')

# Order matters — later files reference symbols defined in earlier ones.
JS_FILES = [
    'constants.js',
    'notation.js',
    'spells.js',
    'moves.js',
    'sim-board.js',
    'features.js',
    'strategic-eval.js',
    'enumerator.js',
    'minimax-ai.js',
    'caveman-ai.js',
]

_SPELL_NODE_SET = frozenset(n for nodes in POSITIONS.values() for n in nodes)
VOID_NODES = tuple(n for n in NODE_ORDER
                   if n not in _SPELL_NODE_SET and n not in MANA_NODES)

WEIGHT_SETS = [
    {'mana': 0.0, 'voidPenalty': 0.0, 'mapControl': 0.0},
    {'mana': 0.1, 'voidPenalty': 0.03, 'mapControl': 0.0246},
    {'mana': 0.5, 'voidPenalty': 0.2, 'mapControl': 0.1},
]


def _stones(**kw):
    s = {n: None for n in NODE_ORDER}
    s.update(kw)
    return s


# Fixtures: 'stones' is required; schedule/snare fields are optional and
# default to empty. Snares must sit on empty or owner-occupied nodes so
# update() doesn't consume them (which would desync the reference).
SYNTHETIC_FIXTURES = [
    {'stones': _stones(a1='red', b1='blue')},
    {'stones': _stones(a1='red', b1='blue', c1='red', a11='red', b11='blue', b12='blue')},
    {'stones': _stones(a1='red', b1='blue', a2='X', a11='X', c5='red', c6='blue')},
    # Providence phantoms (scheduled + this-turn extras) and Ambush snares
    # for both sides join effectiveStones.
    {'stones': _stones(a1='red', a2='red', b1='blue', b2='blue'),
     'pendingMoves': {'red': [1, 1], 'blue': [2]},
     'snares': {'c3': 'red', 'b9': 'blue'},
     'whoseTurn': 'red', 'extraMoves': 1},
    # Aftershock burn credit with the engagement cap biting: red schedules
    # 3 burns but only 2 blue stones touch red (credit 2); blue holds this
    # turn's popped burn + 1 scheduled with 2 contacts (credit 2).
    {'stones': _stones(a1='red', a2='red', a6='blue', b1='blue', b2='blue',
                       c1='red', c2='blue'),
     'pendingBurns': {'red': [3], 'blue': [1]},
     'whoseTurn': 'blue', 'burnsThisTurn': 1,
     'snares': {'a13': 'red'}},
]


def caveman_leaf_ref(fix, color, w):
    """Python reference of the non-terminal JS leaf formula."""
    enemy = 'blue' if color == 'red' else 'red'
    stones = fix['stones']
    pending = fix.get('pendingMoves') or {}
    burns = fix.get('pendingBurns') or {}
    snares = fix.get('snares') or {}
    whose = fix.get('whoseTurn', 'red')
    extra = fix.get('extraMoves', 0)
    burns_now = fix.get('burnsThisTurn', 0)

    def diff(nodes):
        d = 0
        for n in nodes:
            s = stones[n]
            if s == color:
                d += 1
            elif s == enemy:
                d -= 1
        return d

    def effective(side):
        # Mirrors SimBoard.effectiveStones: real stones + Providence
        # phantoms + snares + pending burns (full material since the
        # 2026-08 buff — the old engagement-capped burn credit is gone).
        e = sum(1 for n in NODE_ORDER if stones[n] == side)
        e += sum(pending.get(side) or [])
        e += sum(1 for owner in snares.values() if owner == side)
        e += sum(burns.get(side) or [])
        if whose == side:
            e += extra
            e += burns_now
        return e

    score = float(effective(color) - effective(enemy))
    score += w['mana'] * diff(MANA_NODES)
    score -= w['voidPenalty'] * diff(VOID_NODES)
    mc = map_control(stones)['diff']
    score += w['mapControl'] * (mc if color == 'red' else -mc)
    return score / 39.0


def collect_positions(jsonl_path, n=100, stride=30):
    out = []
    with open(jsonl_path) as f:
        for i, line in enumerate(f):
            if i % stride != 0:
                continue
            d = json.loads(line)
            out.append(d['sfn'])
            if len(out) >= n:
                break
    return out


def build_node_runner():
    parts = []
    for fn in JS_FILES:
        with open(os.path.join(ENGINE, fn), encoding='utf-8') as f:
            parts.append(f.read())
    parts.append(R"""
// --- Test driver: evaluate _cavemanLeaf on each (fixture, weights) ---
// Boards are built via SimBoard + update() so totalStones/mana are
// populated exactly as in play; schedule/snare fixture fields restore
// onto the board before update(). Terminal boards report null (the
// Python reference covers non-terminal positions only).
let buf = '';
process.stdin.on('data', d => buf += d.toString());
process.stdin.on('end', () => {
    const input = JSON.parse(buf);
    const out = [];
    for (const fix of input.fixtures) {
        const board = new SimBoard(null);
        for (const n of NODE_ORDER) board.stones[n] = fix.stones[n] || null;
        if (fix.pendingMoves) {
            board.pendingMoves = { red: (fix.pendingMoves.red || []).slice(),
                                   blue: (fix.pendingMoves.blue || []).slice() };
        }
        if (fix.pendingBurns) {
            board.pendingBurns = { red: (fix.pendingBurns.red || []).slice(),
                                   blue: (fix.pendingBurns.blue || []).slice() };
        }
        if (fix.snares) board.snares = Object.assign({}, fix.snares);
        if (fix.whoseTurn) board.whoseTurn = fix.whoseTurn;
        board.extraMovesThisTurn = fix.extraMoves || 0;
        board.burnsThisTurn = fix.burnsThisTurn || 0;
        board.update();
        if (board.gameover) { out.push(null); continue; }
        const row = [];
        for (const w of input.weightSets) {
            const rw = _cavemanResolveWeights(w);
            row.push({
                red: _cavemanLeaf(board, 'red', rw),
                blue: _cavemanLeaf(board, 'blue', rw),
            });
        }
        out.push(row);
    }
    process.stdout.write(JSON.stringify(out));
});
""")
    return '\n'.join(parts)


def main():
    fixtures = list(SYNTHETIC_FIXTURES)
    if os.path.exists(DATA):
        from notation import sfn_to_dict
        for sfn in collect_positions(DATA):
            d = sfn_to_dict(sfn)
            fixtures.append(
                {'stones': {n: d['stones'].get(n) for n in NODE_ORDER}})

    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f:
        f.write(build_node_runner())
        runner_path = f.name
    try:
        proc = subprocess.run(
            ['node', runner_path],
            input=json.dumps({'fixtures': fixtures,
                              'weightSets': WEIGHT_SETS}),
            capture_output=True, text=True, timeout=120,
        )
    finally:
        os.unlink(runner_path)

    if proc.returncode != 0:
        print('Node failed (returncode', proc.returncode, ')')
        print('STDERR:', proc.stderr)
        sys.exit(1)
    js_results = json.loads(proc.stdout)

    n_mismatches = 0
    n_checked = 0
    n_terminal = 0
    for fix, row in zip(fixtures, js_results):
        if row is None:
            n_terminal += 1
            continue
        for w, js in zip(WEIGHT_SETS, row):
            if abs(js['red'] + js['blue']) > 1e-12:
                print(f'antisymmetry violated: {js} weights={w}')
                n_mismatches += 1
            for color in ('red', 'blue'):
                py = caveman_leaf_ref(fix, color, w)
                if abs(py - js[color]) > 1e-12:
                    print(f'mismatch color={color} weights={w}: '
                          f'py={py!r} js={js[color]!r}')
                    n_mismatches += 1
                n_checked += 1

    print(f'Checked {n_checked} evaluations over {len(fixtures)} boards '
          f'x {len(WEIGHT_SETS)} weight sets ({n_terminal} terminal skipped).')
    print(f'mismatches: {n_mismatches}')
    sys.exit(0 if n_mismatches == 0 else 1)


if __name__ == '__main__':
    main()
