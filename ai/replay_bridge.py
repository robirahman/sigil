"""Hydrate slim game records into per-turn SFN pairs via the JS engine.

Slim `completed_games` records store the SGN-T transcript (marginal
moves: {color, turnNumber, kind, actions}) instead of per-turn board
states. Python consumers that need positions (ai/import_human_games.py,
ai/fit_positional_weights.py, ai/slim_completed_games.py verification)
call `hydrate_records`, which replays the transcripts through the ONE
canonical replayer — the browser engine's reconstructGameLog — by
concatenating the engine files with tools/replay-transcripts.js and
running node. No Python port of the human-input-token interpreter
exists, deliberately: two replayers would drift.

Fat records pass through the bridge unchanged (hydrateGameLog is
dual-format), so callers can feed mixed batches.
"""

import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(REPO, 'docs', 'static', 'scripts', 'engine')
DRIVER = os.path.join(REPO, 'tools', 'replay-transcripts.js')

# Order matters — later files reference symbols defined in earlier ones.
# This is the minimal set reconstructGameLog needs (verified by the
# min-replay harness; same subset puzzles.html loads for hydration).
ENGINE_FILES = [
    'constants.js', 'notation.js', 'board.js', 'moves.js', 'spells.js',
    'ai-player.js', 'game-controller.js', 'game-review.js',
]


def _build_script():
    parts = []
    for fn in ENGINE_FILES:
        with open(os.path.join(ENGINE, fn), encoding='utf-8') as f:
            parts.append(f.read())
    with open(DRIVER, encoding='utf-8') as f:
        parts.append(f.read())
    return '\n'.join(parts)


def hydrate_records(records, timeout=1800):
    """Replay a list of record dicts ({spellNames, variant, setupSfn,
    finalSfn, turns}) and return the bridge results, one per record:
    {'ok': True, 'turns': [{color, turnNumber, sfnBefore, sfnAfter}, ...]}
    or {'ok': False, 'error': str}. One node invocation per call — batch
    everything you can into a single list.
    """
    tmpdir = tempfile.mkdtemp(prefix='sigil_replay_')
    script_path = os.path.join(tmpdir, 'bridge.js')
    in_path = os.path.join(tmpdir, 'in.json')
    out_path = os.path.join(tmpdir, 'out.json')
    try:
        with open(script_path, 'w', encoding='utf-8') as f:
            f.write(_build_script())
        with open(in_path, 'w', encoding='utf-8') as f:
            json.dump(records, f)
        proc = subprocess.run(
            ['node', script_path, in_path, out_path],
            capture_output=True, text=True, timeout=timeout,
        )
        if proc.returncode != 0:
            raise RuntimeError('replay bridge failed (rc=%d): %s'
                               % (proc.returncode, proc.stderr[-2000:]))
        with open(out_path, encoding='utf-8') as f:
            return json.load(f)
    finally:
        for p in (script_path, in_path, out_path):
            try:
                os.unlink(p)
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass


def _normalize_turns(turns):
    """Firebase can deliver arrays as dicts keyed by stringified index.
    Return a clean list, or None if the shape is unusable."""
    if isinstance(turns, dict):
        try:
            turns = [v for _k, v in
                     sorted(turns.items(), key=lambda kv: int(kv[0]))]
        except (ValueError, TypeError):
            return None
    if not isinstance(turns, list) or any(
            not isinstance(t, dict) for t in turns):
        return None
    return turns


def is_slim_record(rec):
    """True when the record's turns need hydration (any turn lacking
    per-turn SFNs — the at-rest transcript shape)."""
    turns = _normalize_turns(rec.get('turns'))
    return bool(turns) and any(
        not (t.get('sfnBefore') and t.get('sfnAfter')) for t in turns)


def hydrate_games_in_place(games, log=print):
    """Given a list of raw completed_games record dicts, replace each
    slim record's `turns` with hydrated fat turns (sfnBefore/sfnAfter).
    Records that fail replay keep their turns and gain
    `_hydration_error`; callers' existing missing-SFN hygiene then drops
    them. Returns (n_hydrated, n_failed)."""
    slim_idx = [i for i, g in enumerate(games) if is_slim_record(g)]
    if not slim_idx:
        return 0, 0
    payload = [{
        'spellNames': games[i].get('spellNames') or [],
        'variant': games[i].get('variant') or 'standard',
        'setupSfn': games[i].get('setupSfn'),
        'finalSfn': games[i].get('finalSfn'),
        'turns': _normalize_turns(games[i].get('turns')) or [],
    } for i in slim_idx]
    results = hydrate_records(payload)
    n_ok = n_fail = 0
    for i, res in zip(slim_idx, results):
        if res.get('ok'):
            # Preserve the slim entries' kind/actions alongside the
            # hydrated SFNs (harmless for consumers that ignore them).
            hydrated = res['turns']
            orig = games[i].get('turns') or []
            for h, o in zip(hydrated, orig):
                if 'kind' in o:
                    h['kind'] = o['kind']
                if 'actions' in o:
                    h['actions'] = o['actions']
            games[i]['turns'] = hydrated
            n_ok += 1
        else:
            games[i]['_hydration_error'] = res.get('error', 'unknown')
            n_fail += 1
    if log:
        log('replay bridge: hydrated %d slim record(s), %d failed'
            % (n_ok, n_fail))
    return n_ok, n_fail
