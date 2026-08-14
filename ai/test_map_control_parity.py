"""Cross-check Python and JS map_control implementations.

Runs both implementations over a sample of real selfplay positions plus
synthetic fixtures (including destroyed-node walls, which selfplay data
may not contain) and asserts exact integer equality on all four fields.
The synthetic fixtures are additionally asserted against known ground
truth, so this test validates correctness as well as parity.

Run:
    python -m ai.test_map_control_parity
"""

import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from notation import NODE_ORDER
from simboard import SimBoard
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
]


def _stones(**kw):
    s = {n: None for n in NODE_ORDER}
    s.update(kw)
    return s


# (stones, expected) — expected values verified by BFS over ADJACENCY.
# The -1 diff at the standard opening is a real property of the board's
# rotational (not mirror) asymmetry.
SYNTHETIC_FIXTURES = [
    (_stones(a1='red', b1='blue'),
     {'red': 17, 'blue': 18, 'contested': 4, 'diff': -1}),
    (_stones(),
     {'red': 0, 'blue': 0, 'contested': 39, 'diff': 0}),
    (_stones(a1='red'),
     {'red': 39, 'blue': 0, 'contested': 0, 'diff': 39}),
    (_stones(a1='red', b1='blue', a2='X', a11='X'),
     {'red': 1, 'blue': 36, 'contested': 0, 'diff': -35}),
]


def collect_positions(jsonl_path, n=200, stride=15):
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
    """Return JS source that loads engine modules and exposes a tiny CLI:
    it reads `{positions: [sfn,...], fixtures: [stones,...]}` on stdin and
    emits `{positions: [...], fixtures: [...]}` mapControl results on
    stdout.
    """
    parts = []
    for fn in JS_FILES:
        with open(os.path.join(ENGINE, fn), encoding='utf-8') as f:
            parts.append(f.read())
    parts.append(R"""
// --- Test driver: read SFNs + stones fixtures from stdin, emit mapControl ---
// Also cross-checks the fast leaf-eval variant mapControlDiff against
// mapControl(...).diff on every input.
let buf = '';
process.stdin.on('data', d => buf += d.toString());
process.stdin.on('end', () => {
    const input = JSON.parse(buf);
    const out = { positions: [], fixtures: [], fastMismatches: 0 };
    const check = (stones) => {
        const mc = mapControl(stones);
        if (mapControlDiff(stones) !== mc.diff) out.fastMismatches++;
        return mc;
    };
    for (const sfn of input.positions) {
        out.positions.push(check(sfnToDict(sfn).stones));
    }
    for (const stones of input.fixtures) {
        out.fixtures.push(check(stones));
    }
    process.stdout.write(JSON.stringify(out));
});
""")
    return '\n'.join(parts)


def main():
    sample = collect_positions(DATA, n=200)
    fixtures = [stones for stones, _expected in SYNTHETIC_FIXTURES]

    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f:
        f.write(build_node_runner())
        runner_path = f.name
    try:
        proc = subprocess.run(
            ['node', runner_path],
            input=json.dumps({'positions': sample, 'fixtures': fixtures}),
            capture_output=True, text=True, timeout=60,
        )
    finally:
        os.unlink(runner_path)

    if proc.returncode != 0:
        print('Node failed (returncode', proc.returncode, ')')
        print('STDERR:', proc.stderr)
        sys.exit(1)
    js_results = json.loads(proc.stdout)

    n_mismatches = 0

    fast_mismatches = js_results.get('fastMismatches', 0)
    if fast_mismatches:
        print(f'mapControlDiff fast-variant mismatches: {fast_mismatches}')
        n_mismatches += fast_mismatches

    for (stones, expected), js in zip(SYNTHETIC_FIXTURES, js_results['fixtures']):
        py = map_control(stones)
        if py != expected:
            print(f'ground-truth mismatch: py={py} expected={expected}')
            n_mismatches += 1
        if py != js:
            print(f'fixture parity mismatch: py={py} js={js}')
            n_mismatches += 1

    for sfn, js in zip(sample, js_results['positions']):
        py = map_control(SimBoard.from_sfn(sfn).stones)
        if py != js:
            print(f'parity mismatch on {sfn[:40]}: py={py} js={js}')
            n_mismatches += 1

    print(f'Checked {len(SYNTHETIC_FIXTURES)} fixtures + {len(sample)} positions.')
    print(f'mismatches: {n_mismatches}')
    sys.exit(0 if n_mismatches == 0 else 1)


if __name__ == '__main__':
    main()
