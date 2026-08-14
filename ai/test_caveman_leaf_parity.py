"""Cross-check the JS caveman leaf eval against a Python reference.

The JS `_cavemanLeaf` (docs/static/scripts/engine/caveman-ai.js) is the
only implementation used in play; this test pins its formula and sign
conventions against a tiny independent Python reference so the
regression pipeline (ai/fit_positional_weights.py) and the shipped leaf
can't silently disagree:

    score = (stoneDiff + mana*manaDiff - voidPenalty*voidDiff
             + mapControl*mcDiff) / 39     (mover POV, non-terminal)

Checks several weight sets (zeros = legacy behavior, a capped set, an
asymmetric set) on synthetic fixtures + sampled selfplay positions,
for both colors, asserting equality within 1e-12 and the negamax
antisymmetry leaf(red) == -leaf(blue).

Run:
    python -m ai.test_caveman_leaf_parity
"""

import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from notation import NODE_ORDER, POSITIONS
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


SYNTHETIC_STONES = [
    _stones(a1='red', b1='blue'),
    _stones(a1='red', b1='blue', c1='red', a11='red', b11='blue', b12='blue'),
    _stones(a1='red', b1='blue', a2='X', a11='X', c5='red', c6='blue'),
]


def caveman_leaf_ref(stones, color, w):
    """Python reference of the non-terminal JS leaf formula."""
    enemy = 'blue' if color == 'red' else 'red'

    def diff(nodes):
        d = 0
        for n in nodes:
            s = stones[n]
            if s == color:
                d += 1
            elif s == enemy:
                d -= 1
        return d

    score = float(diff(NODE_ORDER))
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
// --- Test driver: evaluate _cavemanLeaf on each (stones, weights) ---
// Boards are built via SimBoard + update() so totalStones/mana are
// populated exactly as in play. Terminal boards report null (the
// Python reference covers non-terminal positions only).
let buf = '';
process.stdin.on('data', d => buf += d.toString());
process.stdin.on('end', () => {
    const input = JSON.parse(buf);
    const out = [];
    for (const stones of input.stonesList) {
        const board = new SimBoard(null);
        for (const n of NODE_ORDER) board.stones[n] = stones[n] || null;
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
    stones_list = list(SYNTHETIC_STONES)
    if os.path.exists(DATA):
        from notation import sfn_to_dict
        for sfn in collect_positions(DATA):
            d = sfn_to_dict(sfn)
            stones_list.append({n: d['stones'].get(n) for n in NODE_ORDER})

    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f:
        f.write(build_node_runner())
        runner_path = f.name
    try:
        proc = subprocess.run(
            ['node', runner_path],
            input=json.dumps({'stonesList': stones_list,
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
    for stones, row in zip(stones_list, js_results):
        if row is None:
            n_terminal += 1
            continue
        for w, js in zip(WEIGHT_SETS, row):
            if abs(js['red'] + js['blue']) > 1e-12:
                print(f'antisymmetry violated: {js} weights={w}')
                n_mismatches += 1
            for color in ('red', 'blue'):
                py = caveman_leaf_ref(stones, color, w)
                if abs(py - js[color]) > 1e-12:
                    print(f'mismatch color={color} weights={w}: '
                          f'py={py!r} js={js[color]!r}')
                    n_mismatches += 1
                n_checked += 1

    print(f'Checked {n_checked} evaluations over {len(stones_list)} boards '
          f'x {len(WEIGHT_SETS)} weight sets ({n_terminal} terminal skipped).')
    print(f'mismatches: {n_mismatches}')
    sys.exit(0 if n_mismatches == 0 else 1)


if __name__ == '__main__':
    main()
