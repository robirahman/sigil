"""Convert fat completed_games records (per-turn SFN snapshots) to slim
SGN-T-style transcripts by DEDUCING the moves between positions.

Old records store {color, turnNumber, sfnBefore, sfnAfter} per turn —
two full board strings — with no action transcript at all (they predate
SGN-T). This utility recovers a transcript for each turn by enumerating
the mover's legal turns from sfnBefore and finding one whose application
reproduces sfnAfter BYTE-IDENTICALLY (stones-only fuzzy matching is not
acceptable for migration). Deduced turns are stored as kind:'sim'
entries — canonical SimActions, replayable by apply_sim_turn (Python)
and applyAITurn (JS) alike — which sidesteps the human-input-token
format entirely.

Every converted game is then verified END-TO-END through the node
replay bridge (ai/replay_bridge.py -> reconstructGameLog): the replayed
transcript must reproduce every stored sfnBefore/sfnAfter byte-for-byte,
including the start-of-turn preamble (Destruction check, Providence
shift, Aftershock pop). Only fully-verified records are rewritten;
everything else stays fat and is listed in the report.

Ambiguity is fine: if two different action sequences produce the same
SFN chain, either is a faithful record of the game.

Usage:
    # Dry run over a local dump (no DB access, no writes):
    python -m ai.slim_completed_games --input ai/data/completed_games_raw.json

    # Dry run against a fresh download (also writes a timestamped backup):
    python -m ai.slim_completed_games --service-account firebase-service-account.json

    # Actually rewrite the verified records in Firebase:
    python -m ai.slim_completed_games --service-account ... --apply
"""

import argparse
import json
import os
import sys
import time
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from itertools import combinations, product

from notation import NODE_ORDER, POSITIONS, sfn_to_dict
from simboard import SimBoard, Action, CompleteTurn, apply_sim_turn
from ai.enumerator import get_legal_turns_exhaustive, DEFAULT_CAPS, _spell_overrides
from ai.replay_bridge import hydrate_records, is_slim_record, _normalize_turns

DB_URL = 'https://sigil-js-default-rtdb.firebaseio.com'
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
REPORT_PATH = os.path.join(DATA_DIR, 'slim_migration_report.json')

# Escalating enumeration budgets: greedy first (cheap, covers plain
# move/dash/pass turns), then exhaustive at DEFAULT caps (spell target
# variants), then exhaustive with tripled caps for exotic turns.
BOOSTED_CAPS = {k: v * 3 for k, v in DEFAULT_CAPS.items()}
# Focused tier: when the SFN diff names the cast spell, sweep its target
# overrides essentially uncapped.
MEGA_CAPS = {k: 99 for k in DEFAULT_CAPS}

# Human-solved turns from the reconstruction harness
# (docs/dev/unmatched-review.html -> solved_turns.json, keyed
# '<gameKey>:t<turnNumber>'). Loaded by --solutions before the worker
# pool forks; a solved turn becomes a kind:'input' token transcript
# instead of a snapshot, and the replay bridge byte-verifies it like
# everything else.
SOLUTIONS = {}


def _action_to_dict(a):
    """Serialize an Action to the JSON shape JS applyAITurn consumes
    (field names are snake_case-identical across the two engines);
    None fields dropped, mirroring notation.js _sgnStripAction."""
    out = {'type': a.type}
    for k in a.__slots__:
        if k == 'type':
            continue
        v = getattr(a, k)
        if v is not None:
            out[k] = v
    return out


def _prepare_turn_start(board, color, turn_number):
    """Mirror the reconstructGameLog start-of-turn preamble on a sim:
    the schedules pop BEFORE the move phase, so enumeration sees this
    turn's extra moves and burns."""
    board.turn_counter = turn_number
    board.whose_turn = color
    sched = board.pending_moves[color]
    board.extra_moves_this_turn = sched.pop(0) if sched else 0
    bsched = board.pending_burns[color]
    board.burns_this_turn = bsched.pop(0) if bsched else 0
    board.update()


def _cast_first_candidates(base, color):
    """Turns where the CAST precedes the move. The enumerators only
    generate move-then-cast, but the live turn structure allows either
    order, and resolver outcomes differ whenever the order matters (a
    Fireblast fired before the move sees a different board). Sweeps the
    exhaustive target overrides per spell; kept-stone and push variants
    are layered on by _choice_variants like any other candidate."""
    try:
        castable = base._get_castable_spells(color, True, True)
    except Exception:
        return
    for spell_name in castable:
        overrides = [None]
        try:
            overrides += (_spell_overrides(base, color, spell_name,
                                           BOOSTED_CAPS) or [])
        except Exception:
            pass
        for ov in overrides[:40]:
            b = base.copy()
            try:
                cast_actions = b._cast_spell(spell_name, color, ov)
                b.update()
            except Exception:
                continue
            yield CompleteTurn(cast_actions + [Action('pass')])
            if b.gameover:
                continue
            # Post-cast standard move, under the post-cast seal state
            # (Wind blink privilege / enemy Stone soft restriction).
            has_wind = 'Seal_of_Wind' in b.charged_spells[color]
            enemy_stone = 'Seal_of_Stone' in b.charged_spells[b._enemy(color)]
            if enemy_stone and has_wind:
                targets = b._soft_blinkable(color)
            elif enemy_stone:
                targets = b._soft_moveable(color)
            elif has_wind:
                targets = b._blinkable(color)
            else:
                targets = b._all_moveable(color)
            for target in targets:
                b2 = b.copy()
                is_blink = has_wind and not any(
                    b2.stones[nb] == color
                    for nb in b2._adjacent_nodes(target))
                move = b2._do_move(color, target, is_blink=is_blink)
                if move is None:
                    continue
                yield CompleteTurn(cast_actions + [move, Action('pass')])


def _move_targets(b, color):
    """Standard-move targets under the seal rules (mirrors the greedy
    enumerator's Phase 1 logic)."""
    has_wind = 'Seal_of_Wind' in b.charged_spells[color]
    enemy_stone = 'Seal_of_Stone' in b.charged_spells[b._enemy(color)]
    if enemy_stone and has_wind:
        return b._soft_blinkable(color), has_wind
    if enemy_stone:
        return b._soft_moveable(color), has_wind
    if has_wind:
        return b._blinkable(color), has_wind
    return b._all_moveable(color), has_wind


def _cast_spell_name(sfn_before, sfn_after, color):
    """Deduce which spell (if any) `color` cast this turn from the SFN
    lock / springlock / spell-counter diff."""
    try:
        b, a = sfn_to_dict(sfn_before), sfn_to_dict(sfn_after)
    except Exception:
        return None
    if a[f'{color}_spellcounter'] == b[f'{color}_spellcounter']:
        return None
    if a[f'{color}_lock'] != b[f'{color}_lock']:
        return a[f'{color}_lock']
    if a[f'{color}_springlock'] != b[f'{color}_springlock']:
        return a[f'{color}_springlock']
    return a[f'{color}_lock']


def _focused_candidates(base, color, spell_name):
    """Uncapped sweep for a KNOWN cast spell: every standard-move prefix
    (and none) x every target override, move-then-cast order. The
    cast-first order is covered by _cast_first_candidates."""
    prefixes = [([], base)]
    targets, has_wind = _move_targets(base, color)
    for target in targets:
        b1 = base.copy()
        is_blink = has_wind and not any(
            b1.stones[nb] == color for nb in b1._adjacent_nodes(target))
        mv = b1._do_move(color, target, is_blink=is_blink)
        if mv is None:
            continue
        b1.update()
        prefixes.append(([mv], b1))
    for prefix, b1 in prefixes:
        try:
            if spell_name not in b1._get_castable_spells(color, True, True):
                continue
        except Exception:
            continue
        overrides = [None]
        try:
            overrides += (_spell_overrides(b1, color, spell_name,
                                           MEGA_CAPS) or [])
        except Exception:
            pass
        for ov in overrides:
            b2 = b1.copy()
            try:
                cast_actions = b2._cast_spell(spell_name, color, ov)
                b2.update()
            except Exception:
                continue
            yield CompleteTurn(prefix + cast_actions + [Action('pass')])


def _candidates(board, color, cast_spell=None):
    """Yield candidate turns in escalating-cost order."""
    yield from board.get_legal_turns(color)
    yield from get_legal_turns_exhaustive(board, color, DEFAULT_CAPS)
    yield from _cast_first_candidates(board, color)
    if cast_spell:
        yield from _focused_candidates(board, color, cast_spell)
    yield from get_legal_turns_exhaustive(board, color, BOOSTED_CAPS)


def _copy_action(a, **overrides):
    fields = {k: getattr(a, k) for k in a.__slots__ if k != 'type'}
    fields.update(overrides)
    return Action(a.type, **fields)


def _choice_variants(base, color, cand, sfn_after, cap=2500):
    """The enumerators collapse HUMAN choice points to one deterministic
    option: push destinations (the Python exhaustive enumerator doesn't
    branch them at all), which sigil stones to keep on a discounted cast
    (fixed refill priority), which stone a spell's cost sacrifices, the
    dash sacrifice/destination pair, and small resolver target sets with
    no override support (e.g. Hail Storm). Yield copies of `cand`
    sweeping those choices as patch combinations. Illegal values are
    harmless — apply_sim_turn honors a pushed_to override only when
    legal (falling back to the default) and every other wrong value just
    fails the byte compare.

    Each axis is a list of PATCHES ({(action_idx, field): value}), so
    coupled choices (a dash's node + its move action's node) stay
    consistent. Sweep values are constrained to the nodes the stored SFN
    diff actually touched — anything else can't produce a byte match —
    which keeps the axis product tiny even on turns with several choice
    points (dash + charm cast + resolver move)."""
    enemy = 'blue' if color == 'red' else 'red'
    before = base.stones
    after = sfn_to_dict(sfn_after)['stones']
    # Diff-derived value pools.
    placed_own = [n for n in NODE_ORDER
                  if after.get(n) == color and before[n] != color]
    vacated_own = [n for n in NODE_ORDER
                   if before[n] == color and after.get(n) is None]
    vacated_enemy = [n for n in NODE_ORDER
                     if before[n] == enemy and after.get(n) is None]
    arrived_enemy = [n for n in NODE_ORDER
                     if after.get(n) == enemy and before[n] != enemy]

    axes = []
    cast_seen = False
    resolver_move_idxs = []
    for i, a in enumerate(cand.actions):
        if a.type in ('hard_move', 'blink') \
                and a.pushed_to not in (None, 'X', 'S'):
            if arrived_enemy:
                axes.append([{(i, 'pushed_to'): n} for n in arrived_enemy])
        elif a.type == 'cast':
            cast_seen = True
            if a.kept:
                try:
                    idx = base.spell_names.index(a.spell)
                except ValueError:
                    continue
                pos_nodes = POSITIONS.get(idx + 1, [])
                keeps = [list(c)
                         for c in combinations(pos_nodes, len(a.kept))]
                if len(keeps) > 1:
                    axes.append([{(i, 'kept'): k} for k in keeps])
        elif a.type == 'sacrifice' and a.node:
            if vacated_own:
                axes.append([{(i, 'node'): n} for n in vacated_own])
        elif a.type in ('dash', 'dash_lightning'):
            k = len(a.sacrificed or [])
            if 0 < k <= 2 and len(vacated_own) >= k:
                sacs = [list(c) for c in combinations(vacated_own, k)]
                if sacs:
                    axes.append([{(i, 'sacrificed'): s} for s in sacs])
            # The dash's landing cell is the FOLLOWING move action (soft
            # OR hard); keep the informational dash node in step with it.
            if i + 1 < len(cand.actions) \
                    and cand.actions[i + 1].type in ('move', 'hard_move',
                                                     'blink') \
                    and placed_own:
                axes.append([{(i, 'node'): d, (i + 1, 'node'): d}
                             for d in placed_own])
        elif a.type == 'move' and a.node and cast_seen and placed_own:
            # Resolver-granted soft move (Sprout/Flourish/Grow ...): the
            # human aimed it anywhere; the enumerator picked one target.
            # Collected into ONE combination axis below — targets are
            # order-insensitive, so C(pool, k) beats pool^k.
            resolver_move_idxs.append(i)
        elif a.type.endswith('_destroy') and a.node and vacated_enemy:
            # Single-target resolver kill (Meteor et al.).
            axes.append([{(i, 'node'): n} for n in vacated_enemy])
        elif a.type == 'bewitch' and a.node:
            conv = [n for n in NODE_ORDER
                    if before[n] == enemy and after.get(n) == color]
            if conv:
                axes.append([{(i, 'node'): n} for n in conv])
        elif a.destroyed and a.type != 'fissure':
            # Resolver kill sets without exhaustive override support
            # (Hail Storm et al.).
            k = len(a.destroyed)
            if 0 < k <= 4 and len(vacated_enemy) >= k:
                combos = list(combinations(vacated_enemy, k))
                if 0 < len(combos) <= 200:
                    axes.append([{(i, 'destroyed'): list(c)}
                                 for c in combos])

    if resolver_move_idxs and placed_own \
            and len(resolver_move_idxs) <= len(placed_own):
        vals = [
            {(j, 'node'): n for j, n in zip(resolver_move_idxs, combo)}
            for combo in combinations(placed_own, len(resolver_move_idxs))
        ]
        if 0 < len(vals) <= 400:
            axes.append(vals)

    if not axes or len(axes) > 6:
        return
    count = 0
    for patches in product(*axes):
        count += 1
        if count > cap:
            return
        override = {}
        for p in patches:
            override.update(p)
        actions = []
        for i, a in enumerate(cand.actions):
            kw = {f: v for (j, f), v in override.items() if j == i}
            actions.append(_copy_action(a, **kw) if kw else a)
        yield CompleteTurn(actions)


def deduce_turn(sfn_before, color, turn_number, sfn_after, max_applies=25000):
    """Find a legal turn whose application takes sfn_before to sfn_after
    byte-identically. Returns a CompleteTurn or None. `max_applies`
    bounds the TOTAL board applications (candidates + choice variants) —
    successful turns typically match within a few thousand; the bound
    keeps hopeless turns from stalling a batch run."""
    base = SimBoard.from_sfn(sfn_before)
    _prepare_turn_start(base, color, turn_number)
    cast_spell = _cast_spell_name(sfn_before, sfn_after, color)
    tried = set()

    def matches(turn):
        sig = repr(turn.actions)
        if sig in tried:
            return False
        tried.add(sig)
        b = base.copy()
        try:
            apply_sim_turn(b, turn, color)
            b.update()
        except Exception:
            return False
        return b.to_sfn() == sfn_after

    for cand in _candidates(base, color, cast_spell):
        if len(tried) > max_applies:
            return None
        if matches(cand):
            return cand
        for variant in _choice_variants(base, color, cand, sfn_after):
            if matches(variant):
                return variant
            if len(tried) > max_applies:
                return None
    return None


def convert_record(key, rec):
    """Deduce a slim transcript for one fat record.

    Turns whose move sequence can't be reproduced become 'snapshot'
    entries (hybrid record, Robi's suggestion): the after-state is kept
    verbatim and the replayer jumps the board there — so a game with one
    exotic turn still slims every other turn. Deduction is per-turn
    independent (each starts from its own stored sfnBefore), which makes
    the fallback sound.

    Returns (slim_turns, snapshot_turn_indices, None) on success or
    (None, [], reason) on failure (malformed records only).
    """
    turns = _normalize_turns(rec.get('turns'))
    if not turns:
        return None, 0, 'no-turns'
    slim, snapshots = [], []
    for i, t in enumerate(turns):
        color = t.get('color')
        sfn_before = t.get('sfnBefore')
        sfn_after = t.get('sfnAfter')
        turn_number = t.get('turnNumber')
        if color not in ('red', 'blue') or not sfn_before or not sfn_after \
                or not isinstance(turn_number, int):
            return None, 0, f'malformed-turn-{i}'
        try:
            cand = deduce_turn(sfn_before, color, turn_number, sfn_after)
        except Exception:
            cand = None
        if cand is None:
            solved = SOLUTIONS.get(f'{key}:t{turn_number}')
            if solved and solved.get('actions'):
                slim.append({
                    'color': color,
                    'turnNumber': turn_number,
                    'kind': 'input',
                    'actions': list(solved['actions']),
                })
                continue
            snapshots.append(i)
            slim.append({
                'color': color,
                'turnNumber': turn_number,
                'kind': 'snapshot',
                'sfnAfter': sfn_after,
            })
        else:
            slim.append({
                'color': color,
                'turnNumber': turn_number,
                'kind': 'sim',
                'actions': [_action_to_dict(a) for a in cand.actions],
            })
    return slim, snapshots, None


def _convert_worker(item):
    """Multiprocessing worker: deduce one record's transcript."""
    key, rec = item
    try:
        slim, snapshots, reason = convert_record(key, rec)
    except Exception as e:
        slim, snapshots, reason = None, [], f'worker-error: {e}'
    return key, slim, snapshots, reason


def load_games(args):
    if args.input:
        with open(args.input) as f:
            games = json.load(f)
        print(f'Loaded {len(games)} records from {args.input}')
        return games
    if not args.service_account:
        raise SystemExit('need --input FILE or --service-account KEY')
    import requests
    from ai.backfill_game_elos import auth_token
    tok = auth_token(args.service_account)
    print(f'Fetching {DB_URL}/completed_games.json ...')
    resp = requests.get(DB_URL + '/completed_games.json',
                        params={'access_token': tok}, timeout=600)
    resp.raise_for_status()
    games = resp.json() or {}
    backup = os.path.join(
        DATA_DIR, f'completed_games_backup_{date.today().isoformat()}.json')
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(backup, 'w') as f:
        json.dump(games, f)
    print(f'Downloaded {len(games)} records; backup at {backup}')
    return games


def main():
    ap = argparse.ArgumentParser(
        description='Convert fat completed_games records to slim transcripts')
    ap.add_argument('--input', help='local JSON dump (key -> record); '
                    'skips the DB download')
    ap.add_argument('--service-account', default=None)
    ap.add_argument('--apply', action='store_true',
                    help='rewrite verified records in Firebase '
                         '(default: dry run, report only)')
    ap.add_argument('--limit', type=int, default=0,
                    help='process at most N fat records (0 = all)')
    ap.add_argument('--workers', type=int, default=0,
                    help='deduction worker processes (0 = cpu count - 2)')
    ap.add_argument('--solutions', default=None,
                    help='solved_turns.json from the reconstruction '
                         'harness (docs/dev/unmatched-review.html)')
    args = ap.parse_args()

    if args.solutions:
        with open(args.solutions) as f:
            SOLUTIONS.update(json.load(f))
        print(f'Loaded {len(SOLUTIONS)} human-solved turns '
              f'from {args.solutions}')

    games = load_games(args)

    fat, skipped = [], {'already-slim': 0, 'no-turns': 0, 'malformed': 0}
    for key, rec in sorted(games.items()):
        if not isinstance(rec, dict):
            skipped['malformed'] += 1
            continue
        turns = _normalize_turns(rec.get('turns'))
        if not turns:
            skipped['no-turns'] += 1
            continue
        if not is_slim_record(rec):
            fat.append((key, rec))
        else:
            skipped['already-slim'] += 1
    if args.limit:
        fat = fat[:args.limit]
    print(f"Records: {len(games)} total | {len(fat)} fat to convert | "
          + ' | '.join(f'{k} {v}' for k, v in skipped.items()))

    t0 = time.time()
    converted, failures = [], []
    snap_by_key = {}
    rec_by_key = dict(fat)
    workers = args.workers or max(1, (os.cpu_count() or 4) - 2)
    if workers > 1 and len(fat) > 1:
        import multiprocessing
        with multiprocessing.Pool(workers) as pool:
            results = pool.imap_unordered(_convert_worker, fat, chunksize=4)
            for n, (key, slim, snapshots, reason) in enumerate(results, 1):
                if slim is None:
                    failures.append({'key': key, 'stage': 'deduce',
                                     'reason': reason})
                else:
                    converted.append((key, rec_by_key[key], slim))
                    snap_by_key[key] = snapshots
                if n % 50 == 0 or n == len(fat):
                    print(f'  deduced {n}/{len(fat)} '
                          f'({len(converted)} ok, {len(failures)} failed, '
                          f'{time.time() - t0:.0f}s)', flush=True)
        converted.sort(key=lambda kv: kv[0])
        failures.sort(key=lambda f_: f_['key'])
    else:
        for n, (key, rec) in enumerate(fat, 1):
            slim, snapshots, reason = convert_record(key, rec)
            if slim is None:
                failures.append({'key': key, 'stage': 'deduce',
                                 'reason': reason})
            else:
                converted.append((key, rec, slim))
                snap_by_key[key] = snapshots
            if n % 50 == 0 or n == len(fat):
                print(f'  deduced {n}/{len(fat)} '
                      f'({len(converted)} ok, {len(failures)} failed, '
                      f'{time.time() - t0:.0f}s)', flush=True)

    # End-to-end verification through the canonical JS replayer: the
    # deduced transcript must reproduce EVERY stored SFN byte-for-byte.
    verified, still_fat = [], []
    if converted:
        payload = []
        for key, rec, slim in converted:
            turns = _normalize_turns(rec['turns'])
            payload.append({
                'spellNames': rec.get('spellNames') or [],
                'variant': rec.get('variant') or 'standard',
                'setupSfn': turns[0]['sfnBefore'],
                'finalSfn': turns[-1]['sfnAfter'],
                'turns': slim,
            })
        print(f'Verifying {len(payload)} conversions through the node bridge ...')
        results = hydrate_records(payload)
        for (key, rec, slim), res in zip(converted, results):
            turns = _normalize_turns(rec['turns'])
            if not res.get('ok'):
                failures.append({'key': key, 'stage': 'replay',
                                 'reason': res.get('error', 'unknown')})
                still_fat.append(key)
                continue
            hyd = res['turns']
            mismatch = None
            if len(hyd) != len(turns):
                mismatch = f'length {len(hyd)} != {len(turns)}'
            else:
                for i, (h, t) in enumerate(zip(hyd, turns)):
                    if h['sfnBefore'] != t['sfnBefore'] \
                            or h['sfnAfter'] != t['sfnAfter']:
                        mismatch = f'sfn mismatch at turn {i}'
                        break
            if mismatch:
                failures.append({'key': key, 'stage': 'verify',
                                 'reason': mismatch})
                still_fat.append(key)
            else:
                verified.append((key, rec, slim, turns))

    old_bytes = sum(len(json.dumps(_normalize_turns(rec['turns'])))
                    for _, rec, _, _ in verified)
    new_bytes = sum(len(json.dumps(slim)) for _, _, slim, _ in verified)
    fully_slim = [k for k, *_ in verified if not snap_by_key.get(k)]
    hybrid = [k for k, *_ in verified if snap_by_key.get(k)]
    snap_turns = sum(len(snap_by_key.get(k, [])) for k, *_ in verified)
    total_turns = sum(len(t) for _, _, _, t in verified)
    print(f'\nConversion: {len(verified)} verified / {len(fat)} fat '
          f'({len(failures)} failures)')
    print(f'  fully slim: {len(fully_slim)} | hybrid: {len(hybrid)} '
          f'({snap_turns} snapshot turns of {total_turns})')
    if verified:
        print(f'turns payload: {old_bytes / 1e6:.1f} MB -> '
              f'{new_bytes / 1e6:.1f} MB '
              f'({(1 - new_bytes / old_bytes) * 100:.0f}% smaller)')
    for f_ in failures[:20]:
        print(f"  FAIL {f_['key']} [{f_['stage']}] {f_['reason']}")
    if len(failures) > 20:
        print(f'  ... and {len(failures) - 20} more (see report)')

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(REPORT_PATH, 'w') as f:
        json.dump({
            'total': len(games), 'fat': len(fat),
            'verified': [k for k, *_ in verified],
            'snapshot_turns': {k: snap_by_key[k] for k, *_ in verified
                               if snap_by_key.get(k)},
            'failures': failures, 'skipped': skipped,
            'old_turns_bytes': old_bytes, 'new_turns_bytes': new_bytes,
        }, f, indent=1)
    print(f'Report: {REPORT_PATH}')

    if not args.apply:
        print('\nDry run — no writes. Re-run with --apply to rewrite '
              'the verified records.')
        return

    if not args.service_account:
        raise SystemExit('--apply requires --service-account')
    import requests
    from ai.backfill_game_elos import auth_token
    tok = auth_token(args.service_account)
    print(f'Rewriting {len(verified)} records ...')
    BATCH = 50
    for i in range(0, len(verified), BATCH):
        updates = {}
        for key, rec, slim, turns in verified[i:i + BATCH]:
            updates[f'completed_games/{key}/turns'] = slim
            updates[f'completed_games/{key}/setupSfn'] = turns[0]['sfnBefore']
            updates[f'completed_games/{key}/finalSfn'] = turns[-1]['sfnAfter']
        r = requests.patch(DB_URL + '/.json', params={'access_token': tok},
                           json=updates, timeout=300)
        r.raise_for_status()
        print(f'  wrote {min(i + BATCH, len(verified))}/{len(verified)}')
    print('Done.')


if __name__ == '__main__':
    main()
