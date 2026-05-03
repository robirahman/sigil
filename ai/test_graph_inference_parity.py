"""Cross-check Python and JS SigilNetGraph inference produce identical
value/policy on a sample of positions.

The JS port lives at docs/static/scripts/engine/sigil-net-graph.js. If
its forward path drifts from ai/sigil_net_graph.py, the deployed AI
will play differently from what we trained — so we lock parity here.

Run:
    python -m ai.test_graph_inference_parity
"""

import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from notation import sfn_to_dict
from simboard import SimBoard
from ai.features import board_to_tensor, encode_all_turns
from ai.sigil_net_graph import SigilNetGraph

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')
MODELS = os.path.join(REPO, 'docs', 'static', 'models')

JS_FILES = [
    'constants.js',
    'notation.js',
    'spells.js',
    'moves.js',
    'sim-board.js',
    'features.js',
    'sigil-net.js',
    'sigil-net-graph.js',
]


def collect_positions(jsonl_path, n=20, stride=200):
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


def build_runner():
    parts = []
    for fn in JS_FILES:
        with open(os.path.join(ENGINE, fn), encoding='utf-8') as f:
            parts.append(f.read())
    parts.append(R"""
// Driver: load model + run forward on sample positions; emit JSON.
async function main() {
    const buf = await new Promise(res => {
        let s = '';
        process.stdin.on('data', d => s += d.toString());
        process.stdin.on('end', () => res(s));
    });
    const input = JSON.parse(buf);
    const fs = require('fs');
    // Load manifest + binary into a SigilNetGraphJS instance.
    const manifest = JSON.parse(fs.readFileSync(input.manifest, 'utf-8'));
    const binData = fs.readFileSync(input.bin);
    const buffer = binData.buffer.slice(binData.byteOffset, binData.byteOffset + binData.byteLength);
    const weights = {};
    for (const [k, info] of Object.entries(manifest.tensors)) {
        weights[k] = {
            data: new Float32Array(buffer, info.offset, info.length),
            shape: info.shape,
        };
    }
    const model = new SigilNetGraphJS(manifest.config, weights);

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
        let value, policy = [];
        if (legal.length > 0) {
            const tf = encodeAllTurns(legal, board, d.turn);
            const r = model.evaluateWithPolicy(raw, spellIds, tf, legal.length);
            value = r.value;
            policy = Array.from(r.policy);
        } else {
            const r = model.forward(raw, spellIds, null, 0);
            value = r.value;
        }
        out.push({ value, policy });
    }
    process.stdout.write(JSON.stringify(out));
}
main();
""")
    return '\n'.join(parts)


def main():
    sample = collect_positions(
        os.path.join(REPO, 'ai', 'data', 'selfplay_v15_2026-05-02.jsonl'),
        n=15,
    )
    manifest_path = os.path.join(MODELS, 'sigil_net_graph.json')
    bin_path = os.path.join(MODELS, 'sigil_net_graph.bin')

    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f:
        f.write(build_runner())
        runner_path = f.name
    try:
        proc = subprocess.run(
            ['node', runner_path],
            input=json.dumps({
                'positions': sample,
                'manifest': manifest_path,
                'bin': bin_path,
            }),
            capture_output=True, text=True, timeout=120,
        )
    finally:
        os.unlink(runner_path)

    if proc.returncode != 0:
        print('Node failed:', proc.returncode)
        print('STDERR:', proc.stderr[-2000:])
        sys.exit(1)
    js_results = json.loads(proc.stdout)

    py_model = SigilNetGraph.load(os.path.join(REPO, 'ai', 'models', 'candidate_v24.pt'))
    py_model.eval()

    max_value_diff = 0.0
    max_policy_diff = 0.0
    n_mismatches = 0

    for sfn, js in zip(sample, js_results):
        sb = SimBoard.from_sfn(sfn)
        side = sfn_to_dict(sfn)['turn']
        raw, spell_ids = board_to_tensor(sb, side)
        legal = list(sb.get_legal_turns(side))
        if legal:
            tf = encode_all_turns(legal, sb, side)
            py_v, py_p = py_model.evaluate_with_policy(raw, spell_ids, tf)
            js_p = np.array(js['policy'], dtype=np.float32)
        else:
            with torch.no_grad():
                py_v_t, _ = py_model(raw.unsqueeze(0), spell_ids.unsqueeze(0))
            py_v = py_v_t.item()
            py_p = np.array([])
            js_p = np.array([])

        d_val = abs(py_v - js['value'])
        max_value_diff = max(max_value_diff, d_val)
        if d_val > 1e-3:
            n_mismatches += 1
            print(f'{sfn[:30]} value: py={py_v:.4f} js={js["value"]:.4f} diff={d_val:.4e}')

        if py_p.size > 0 and js_p.size > 0:
            if py_p.shape != js_p.shape:
                print(f'{sfn[:30]} policy shape mismatch: py={py_p.shape} js={js_p.shape}')
                n_mismatches += 1
                continue
            d_pol = float(np.max(np.abs(py_p - js_p)))
            max_policy_diff = max(max_policy_diff, d_pol)
            if d_pol > 1e-3:
                n_mismatches += 1
                idx = int(np.argmax(np.abs(py_p - js_p)))
                print(f'{sfn[:30]} policy[{idx}]: py={py_p[idx]:.4f} js={js_p[idx]:.4f}')

    print(f'\nChecked {len(sample)} positions.')
    print(f'max value diff:  {max_value_diff:.4e}')
    print(f'max policy diff: {max_policy_diff:.4e}')
    print(f'mismatches:      {n_mismatches}')
    sys.exit(0 if n_mismatches == 0 else 1)


if __name__ == '__main__':
    main()
