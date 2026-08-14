"""Cross-check Python and JS feature implementations on real positions.

Writes a sample of positions to disk as JSON, invokes Node to compute
JS-side features, and asserts the resulting vectors match within tol.

Run:
    python -m ai.test_feature_parity
"""

import json
import os
import subprocess
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from notation import sfn_to_dict
from simboard import SimBoard
from ai.features import board_to_tensor, encode_all_turns
from ai.config import RAW_FEATURE_DIM, TURN_FEATURE_DIM

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')

# Order matters — later files reference symbols defined in earlier ones.
JS_FILES = [
    'constants.js',
    'notation.js',
    'spells.js',
    'moves.js',
    'sim-board.js',
    'features.js',
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
    it reads `{positions: [sfn,...]}` on stdin, emits JSON results on stdout.
    """
    parts = []
    for fn in JS_FILES:
        with open(os.path.join(ENGINE, fn), encoding='utf-8') as f:
            parts.append(f.read())
    parts.append(R"""
// --- Test driver: read SFNs from stdin, emit features as JSON ---
let buf = '';
process.stdin.on('data', d => buf += d.toString());
process.stdin.on('end', () => {
    const input = JSON.parse(buf);
    const out = [];
    for (const sfn of input.positions) {
        const d = sfnToDict(sfn);
        const board = new SimBoard(d.spell_names);
        for (const n of NODE_ORDER) board.stones[n] = d.stones[n] || null;
        board.turnCounter = d.turncounter;
        board.whoseTurn = d.turn;
        board.score = d.score;
        board.spellCounter.red = d.red_spellcounter;
        board.spellCounter.blue = d.blue_spellcounter;
        board.lock.red = d.red_lock;
        board.lock.blue = d.blue_lock;
        board.springlock.red = d.red_springlock;
        board.springlock.blue = d.blue_springlock;
        board.update();
        const { raw, spellIds } = boardToTensor(board, d.turn);
        const legal = [...board.getLegalTurns(d.turn)];
        let turnFeats = [];
        if (legal.length > 0) {
            const tf = encodeAllTurns(legal, board, d.turn);
            const N = legal.length;
            for (let i = 0; i < N; i++) {
                turnFeats.push(Array.from(tf.slice(i * TURN_FEATURE_DIM, (i + 1) * TURN_FEATURE_DIM)));
            }
        }
        out.push({ raw: Array.from(raw), turnFeats });
    }
    process.stdout.write(JSON.stringify(out));
});
""")
    return '\n'.join(parts)


def main():
    sample = collect_positions(
        os.path.join(REPO, 'ai', 'data', 'selfplay_v22b_2026-05-03.jsonl'),
        n=200,
    )
    # Save the runner JS to a temp file so Node can execute it.
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f:
        f.write(build_node_runner())
        runner_path = f.name
    try:
        proc = subprocess.run(
            ['node', runner_path],
            input=json.dumps({'positions': sample}),
            capture_output=True, text=True, timeout=60,
        )
    finally:
        os.unlink(runner_path)

    if proc.returncode != 0:
        print('Node failed (returncode', proc.returncode, ')')
        print('STDERR:', proc.stderr)
        sys.exit(1)
    js_results = json.loads(proc.stdout)

    max_raw_diff = 0.0
    max_turn_diff = 0.0
    n_mismatches = 0

    for sfn, js in zip(sample, js_results):
        sb = SimBoard.from_sfn(sfn)
        side = sfn_to_dict(sfn)['turn']
        py_raw, _spell_ids = board_to_tensor(sb, side)
        py_raw_np = py_raw.numpy()
        js_raw_np = np.array(js['raw'], dtype=np.float32)
        if py_raw_np.shape != js_raw_np.shape:
            print(f'shape mismatch on {sfn[:30]}: py={py_raw_np.shape} js={js_raw_np.shape}')
            n_mismatches += 1
            continue
        d = float(np.max(np.abs(py_raw_np - js_raw_np)))
        max_raw_diff = max(max_raw_diff, d)
        if d > 1e-4:
            n_mismatches += 1
            idx = int(np.argmax(np.abs(py_raw_np - js_raw_np)))
            print(f'raw diff {d:.4e} on {sfn[:30]}: py[{idx}]={py_raw_np[idx]:.4f} js[{idx}]={js_raw_np[idx]:.4f}')

        legal = list(sb.get_legal_turns(side))
        if legal:
            py_turns = encode_all_turns(legal, sb, side).numpy()
            js_turns = np.array(js['turnFeats'], dtype=np.float32)
            if py_turns.shape != js_turns.shape:
                print(f'turn shape mismatch on {sfn[:30]}: py={py_turns.shape} js={js_turns.shape}')
                n_mismatches += 1
                continue
            d = float(np.max(np.abs(py_turns - js_turns)))
            max_turn_diff = max(max_turn_diff, d)
            if d > 1e-4:
                n_mismatches += 1
                ij = np.unravel_index(int(np.argmax(np.abs(py_turns - js_turns))), py_turns.shape)
                from ai.forbidden_moves import turn_signature
                sig = turn_signature(legal[ij[0]])
                print(f'turn diff {d:.4e} on {sfn[:30]} at turn {ij[0]} feat {ij[1]}: '
                      f'py={py_turns[ij]:.4f} js={js_turns[ij]:.4f} sig={sig}')

    print(f'\nChecked {len(sample)} positions.')
    print(f'max raw diff:  {max_raw_diff:.6e}')
    print(f'max turn diff: {max_turn_diff:.6e}')
    print(f'mismatches:    {n_mismatches}')
    sys.exit(0 if n_mismatches == 0 else 1)


if __name__ == '__main__':
    main()
