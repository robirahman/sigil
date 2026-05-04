"""Smoke-test the JS minimax port end-to-end via Node.

Loads the engine JS files, stubs the model with a deterministic fake
that returns plausible value/policy outputs, then runs `minimaxSearch`
on a real SimBoard. Verifies it completes without errors and that
the TT, killer table, and hint-driven ordering all integrate cleanly.

This isn't a full parity test (no real model = no real scores) — it's
an end-to-end exercise that catches plumbing bugs in the JS port.

Run:
    python -m ai.test_minimax_js_smoke
"""

import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')

# Order matters.
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
]


def build_node_runner(sfns):
    parts = []
    for fn in JS_FILES:
        with open(os.path.join(ENGINE, fn), encoding='utf-8') as f:
            parts.append(f.read())
    parts.append(r"""
// --- Stub model: deterministic, no neural net ---
class StubModel {
    forward(raw, spellIds, tf, N) {
        // Value: zero-centered, weakly correlated with raw[0]
        const value = Math.tanh((raw && raw.length ? raw[0] : 0) * 0.1);
        if (!N || N <= 0) return { value, policyLogits: null };
        // Policy: linear ramp so highest index has highest logit.
        const policyLogits = new Float32Array(N);
        for (let i = 0; i < N; i++) policyLogits[i] = -i * 0.1;
        return { value, policyLogits };
    }
}

const sfns = JSON.parse(process.argv[2]);
const results = [];
for (const sfn of sfns) {
    try {
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
        if (board.gameover) {
            results.push({ sfn, skipped: 'already gameover' });
            continue;
        }
        const t0 = Date.now();
        const move = minimaxSearch(board, d.turn, new StubModel(), {
            timeLimit: 3.0, maxDepth: 3,
            exhaustiveRoot: true, exhaustiveOpponent: true,
            enableTT: true, enableKillers: true,
            aspirationDelta: 0.15,
        });
        const elapsed = Date.now() - t0;
        results.push({
            sfn,
            ok: !!move,
            n_actions: move ? move.actions.length : 0,
            first_action: move && move.actions.length ? move.actions[0].type : null,
            elapsed_ms: elapsed,
        });
    } catch (e) {
        results.push({ sfn, error: e.message, stack: e.stack });
    }
}
process.stdout.write(JSON.stringify(results));
""")
    return '\n'.join(parts)


def main():
    # Pull a handful of varied SFNs from human_games.jsonl. Pick from
    # different positions in the file so we hit a variety of game stages.
    sfns = []
    with open(os.path.join(REPO, 'ai', 'data', 'human_games.jsonl')) as f:
        all_lines = f.readlines()
    stride = max(1, len(all_lines) // 10)
    for i in range(0, len(all_lines), stride):
        d = json.loads(all_lines[i])
        sfns.append(d['sfn'])
        if len(sfns) >= 10:
            break

    runner_src = build_node_runner(sfns)
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f:
        f.write(runner_src)
        runner_path = f.name
    try:
        proc = subprocess.run(
            ['node', runner_path, json.dumps(sfns)],
            capture_output=True, text=True, timeout=120,
        )
    finally:
        os.unlink(runner_path)

    if proc.returncode != 0:
        print(f'Node failed (returncode {proc.returncode})')
        print(f'STDERR: {proc.stderr[:2000]}')
        return 1
    if proc.stderr:
        print(f'STDERR (non-fatal): {proc.stderr[:500]}')
    if not proc.stdout.strip():
        print('No output from node; STDERR was:', proc.stderr[:2000])
        return 1
    results = json.loads(proc.stdout)
    print(f'Tested {len(results)} positions:')
    errors = 0
    for r in results:
        if 'error' in r:
            print(f'  ERROR on {r["sfn"][:30]}: {r["error"]}')
            print(f'    stack: {r.get("stack", "")[:200]}')
            errors += 1
        elif 'skipped' in r:
            print(f'  skipped: {r["skipped"]}')
        else:
            print(f'  ok: actions={r["n_actions"]} first={r["first_action"]} '
                  f'elapsed={r["elapsed_ms"]}ms')
    print()
    if errors:
        print(f'FAIL: {errors} errors')
        return 1
    print('PASS: JS minimax search completes without errors')
    return 0


if __name__ == '__main__':
    sys.exit(main())
