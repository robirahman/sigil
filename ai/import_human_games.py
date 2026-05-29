"""Download completed multiplayer games from Firebase and convert to training data.

Each game record contains SFN snapshots before and after each turn.
We replay each position, enumerate legal turns, find the one that matches
the human's action, and create a training example with policy = 1.0 for
the chosen turn (behavioral cloning).

Output format matches selfplay_mcts.py: JSONL with fields
sfn, spell_ids, raw_features, policy, turn_encodings, outcome.

Usage:
    # Set FIREBASE_DB_URL or pass --db-url
    python -m ai.import_human_games --db-url https://sigil-js-default-rtdb.firebaseio.com --output ai/data/human_games.jsonl

    # Or use a service account key for authenticated access
    python -m ai.import_human_games --service-account path/to/key.json --output ai/data/human_games.jsonl
"""

import argparse
import datetime
import hashlib
import json
import os
import random
import sys
import time

import requests
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from notation import sfn_to_dict, NODE_ORDER, POSITIONS
from simboard import SimBoard, CORE_SPELLS
from ai.search import _apply_turn
from ai.features import board_to_tensor, encode_all_turns
from ai.enumerator import get_legal_turns_exhaustive
from ai.config import SPELL_TO_ID, DATA_DIR
from ai.data_filters import FIREBLAST_RULE_CHANGE_CUTOFF


def download_games(db_url, service_account_path=None):
    """Download completed games from Firebase Realtime Database.

    Returns list of game records.
    """
    url = db_url.rstrip('/') + '/completed_games.json'

    if service_account_path:
        # Use service account for authenticated access
        try:
            import google.auth.transport.requests
            from google.oauth2 import service_account

            creds = service_account.Credentials.from_service_account_file(
                service_account_path,
                scopes=['https://www.googleapis.com/auth/firebase.database',
                        'https://www.googleapis.com/auth/userinfo.email']
            )
            creds.refresh(google.auth.transport.requests.Request())
            resp = requests.get(url, params={'access_token': creds.token})
        except ImportError:
            print("Install google-auth for service account support: pip install google-auth")
            sys.exit(1)
    else:
        # Anonymous access (works if read rules allow it, or in test mode)
        resp = requests.get(url)

    if resp.status_code != 200:
        print(f"Error downloading games: HTTP {resp.status_code}")
        print(resp.text[:500])
        sys.exit(1)

    data = resp.json()
    if data is None:
        print("No completed games found.")
        return []

    # Preserve the Firebase key on each record (handy for logging / dedup).
    games = [dict(v, _gid=k) for k, v in data.items() if isinstance(v, dict)]
    print(f"Downloaded {len(games)} completed games")
    return games


# Stream-matcher tunables. The old materialize-then-iterate matcher
# enumerated and replayed every legal variant — for positions with
# charged spells that's 10k+ board.copy() + _apply_turn() + update()
# calls (minutes of work) even when the human's turn is the very first
# variant generated. The streaming matcher below replays only until it
# finds a perfect (stones + locks) match, then iterates the rest of
# the enumerator without replay just to populate the policy negative
# pool. Empirically the human's turn lands in the first few hundred
# variants for ~all positions, so caps here only affect pathological
# cases (where we'd time out anyway).
_FIND_REPLAY_CAP = 2000      # max replays before giving up the match
_FIND_SAMPLE_CAP = 400       # max legal_turns to keep for negative sampling
_FIND_ENUM_HARD_CAP = 20000  # absolute cap on total enumeration


def find_matching_turn(board, color, sfn_after):
    """Find the legal turn the human actually played.

    We stream the exhaustive enumerator, replaying each candidate
    against `board.copy()` and stopping as soon as one matches the
    recorded after-state on stones (and locks/springlocks as a tie-
    break). After matching, enumeration continues cheaply (no replay)
    until we've collected enough turns for the policy negative pool,
    then bails. This avoids the worst-case "replay 10k+ variants to
    discover the match was at index 17" pattern of the old materialize-
    then-iterate matcher.

    Matching is exact on stones (the dominant, proven-distinguishing
    signal), with lock / springlock as a tie-break for the rare case
    of two variants with identical stones. Unmatched turns (e.g. the
    JS engine resolved a spell in a way SimBoard doesn't reproduce)
    return None so the caller can discard rather than guess.

    Returns (turn_index, legal_turns) or (None, legal_turns).
    """
    target = sfn_to_dict(sfn_after)
    tgt_stones = target['stones']
    tgt_lock = (target.get('red_lock'), target.get('blue_lock'))
    tgt_spring = (target.get('red_springlock'), target.get('blue_springlock'))

    legal_turns = []
    matched_idx = None
    stone_fallback_idx = None  # stones match but locks don't — used if no
                                # perfect match is found within the budget.

    for idx, turn in enumerate(get_legal_turns_exhaustive(
            board, color, exhaustive=True)):
        legal_turns.append(turn)

        # Still hunting for a match; replay this candidate.
        if matched_idx is None and idx < _FIND_REPLAY_CAP:
            tb = board.copy()
            _apply_turn(tb, turn, color)
            tb.update()
            if all(tb.stones[n] == tgt_stones[n] for n in NODE_ORDER):
                locks_ok = (
                    (tb.lock['red'], tb.lock['blue']) == tgt_lock and
                    (tb.springlock['red'], tb.springlock['blue']) == tgt_spring
                )
                if locks_ok:
                    matched_idx = idx
                elif stone_fallback_idx is None:
                    stone_fallback_idx = idx

        # Stop conditions.
        if matched_idx is not None and len(legal_turns) >= _FIND_SAMPLE_CAP:
            break
        if matched_idx is None and idx + 1 >= _FIND_REPLAY_CAP:
            # Past the replay budget without a perfect match; fall back
            # to stone-only match if we have one, otherwise give up. No
            # need to keep enumerating — caller will discard the turn.
            break
        if len(legal_turns) >= _FIND_ENUM_HARD_CAP:
            break

    if matched_idx is None:
        matched_idx = stone_fallback_idx
    if matched_idx is None:
        return None, legal_turns
    return matched_idx, legal_turns


def _is_bot(uid):
    """True if a player UID is a bot (the built-in AI) or absent."""
    return uid is None or (isinstance(uid, str) and uid.startswith('__ai'))


# Policy negative-sampling. Per record we store the chosen turn plus K
# randomly-drawn other legal turns and encode only those; the trainer's
# cross-entropy becomes an approximate softmax over the K+1 sampled turns
# (a standard trick for huge action spaces). MCTS at inference still
# enumerates every legal turn — sampling only bounds the training set's
# size so 10k-turn positions don't blow out RAM/disk.
NEGATIVE_SAMPLES = 64


# Effective Elo for bot players (they carry no rating). Calibrated against
# the user's report (~1400 human beats hard/very-hard ~93% of the time, so
# those bots are ~1000), and all bots far exceed the current <700 net. Used
# only to weight bot *winning* moves sensibly via rating_weight / --min-elo.
_BOT_ELO = {
    '__ai_very_hard__': 1050,
    '__ai_hard__': 1000,
    '__ai_minimax__': 1000,
    '__ai_graph__': 1000,
    '__ai_medium__': 900,
    '__ai_aux__': 900,
    '__ai_easy__': 800,
    '__ai_caveman__': 750,
    '__ai_caveman_6__': 750,
}
_BOT_ELO_DEFAULT = 900


def _bot_effective_elo(uid):
    if isinstance(uid, str):
        return _BOT_ELO.get(uid, _BOT_ELO_DEFAULT)
    return _BOT_ELO_DEFAULT


def game_played_date(game_record):
    """Best-effort date the game was played, from the Firebase
    `timestamp` (ms epoch). Returns a datetime.date or None."""
    ts = game_record.get('timestamp')
    if ts is None:
        return None
    try:
        ts = float(ts)
    except (TypeError, ValueError):
        return None
    if ts > 1e12:          # milliseconds → seconds
        ts /= 1000.0
    try:
        return datetime.date.fromtimestamp(ts)
    except (OverflowError, OSError, ValueError):
        return None


def convert_game(game_record):
    """Convert one game record to training positions.

    Returns (positions, matched, unmatched): a list of dicts matching
    selfplay_mcts.py's record format, plus how many turns were matched
    to an enumerated turn vs. discarded as unmatchable.
    """
    spell_names = game_record.get('spellNames', [])
    winner = game_record.get('winner')
    turns = game_record.get('turns', [])
    played_date = game_played_date(game_record)
    # Per-player rating. Bots have no Elo, so we assign an effective Elo by
    # difficulty: their *winning* moves are good demonstrations (they beat
    # mid-rated humans and far outplay the <700 net), and winners-only
    # policy at train time keeps only winners' moves anyway. The effective
    # Elo feeds rating_weight / --min-elo so bot moves are weighted by
    # strength alongside humans.
    red_uid = game_record.get('redUid')
    blue_uid = game_record.get('blueUid')
    red_elo = _bot_effective_elo(red_uid) if _is_bot(red_uid) \
        else game_record.get('redEloBefore')
    blue_elo = _bot_effective_elo(blue_uid) if _is_bot(blue_uid) \
        else game_record.get('blueEloBefore')
    # Player-supplied per-turn annotations: { '<turnNumber>': 'good' | 'bad' }.
    # Firebase keys are strings; we coerce to int below for matching.
    raw_annotations = game_record.get('annotations') or {}
    annotations = {}
    for k, v in raw_annotations.items():
        if v not in ('good', 'bad'):
            continue
        try:
            annotations[int(k)] = v
        except (TypeError, ValueError):
            continue

    if not spell_names or not turns or not winner:
        return [], 0, 0

    # Skip games using spells outside the net's fixed vocabulary — the
    # spell-embedding can't represent them, and silently mapping an
    # unknown spell to id 0 (Flourish) would corrupt the input. (Newer
    # spells like Syzygy / Eclipse / Seal_of_Spring appear in a handful
    # of real games.)
    if any(s not in SPELL_TO_ID for s in spell_names):
        return [], 0, 0

    positions = []
    matched = 0
    unmatched = 0

    for turn_data in turns:
        color = turn_data.get('color')
        sfn_before = turn_data.get('sfnBefore')
        sfn_after = turn_data.get('sfnAfter')
        turn_number = turn_data.get('turnNumber')

        if not color or not sfn_before or not sfn_after:
            continue

        # Reconstruct board from SFN
        board = SimBoard.from_sfn(sfn_before)

        # Find which legal turn produces the after-state
        turn_idx, legal_turns = find_matching_turn(board, color, sfn_after)

        if turn_idx is None or not legal_turns:
            unmatched += 1
            continue

        # Create training example.
        # Negative sampling for the policy target: encoding all legal turns
        # is intractable for explosive positions (10k+ turns × 84 floats per
        # record → OOM). We store the chosen turn plus K random negatives
        # and let the trainer compute the policy cross-entropy over the
        # sampled set (standard softmax-sampling approximation). MCTS at
        # inference still sees every legal turn — only the training loss is
        # over a sample. Seed is per-record so re-imports are reproducible.
        sfn = sfn_before
        spell_ids = [SPELL_TO_ID.get(board.spell_names[i], 0) for i in range(9)]

        raw, _ = board_to_tensor(board, color)

        n_total = len(legal_turns)
        K = NEGATIVE_SAMPLES
        if n_total <= K + 1:
            sampled_turns = legal_turns
            chosen_pos = turn_idx
        else:
            seed_bytes = hashlib.md5(
                f"{sfn_before}|{color}|{turn_number}".encode()
            ).digest()[:8]
            rng = random.Random(int.from_bytes(seed_bytes, 'big'))
            neg_pool = [i for i in range(n_total) if i != turn_idx]
            neg_idx = rng.sample(neg_pool, K)
            sampled_indices = [turn_idx] + neg_idx     # chosen at slot 0
            sampled_turns = [legal_turns[i] for i in sampled_indices]
            chosen_pos = 0
        turn_feats = encode_all_turns(sampled_turns, board, color)

        # Policy: one-hot on the chosen turn within the sampled set.
        policy = np.zeros(len(sampled_turns), dtype=np.float32)
        policy[chosen_pos] = 1.0

        # Outcome from this color's perspective
        if winner == color:
            outcome = 1.0
        elif winner is not None:
            outcome = -1.0
        else:
            outcome = 0.0

        position = {
            'sfn': sfn,
            'spell_ids': spell_ids,
            'raw_features': raw.numpy().tolist(),
            'policy': policy.tolist(),
            'turn_encodings': turn_feats.numpy().tolist(),
            'outcome': outcome,
        }
        # Firebase key for the source game. Lets --resume dedup by game
        # identity rather than positional index, which is robust to
        # download-order changes.
        gid = game_record.get('_gid')
        if gid is not None:
            position['_gid'] = gid
        # Player's own rating from their POV; opponent's for context. Optional.
        own_elo = red_elo if color == 'red' else blue_elo
        opp_elo = blue_elo if color == 'red' else red_elo
        if own_elo is not None:
            position['player_elo'] = own_elo
        if opp_elo is not None:
            position['opponent_elo'] = opp_elo
        # Human-supplied annotation, if any. Each annotation is set by the
        # OPPOSITE-color player about the move whose turnNumber this is.
        if turn_number is not None and turn_number in annotations:
            position['annotation'] = annotations[turn_number]
        if played_date is not None:
            position['played_date'] = played_date.isoformat()
        positions.append(position)
        matched += 1

    return positions, matched, unmatched


def _run_one_game(i, game, out_path):
    """Worker entrypoint for the process-per-game parallelism model.

    The parent owns the timeout: it forks one short-lived child per game,
    .join(timeout=N)s, and SIGTERM/SIGKILLs the child if it exceeds the
    budget. Process-level termination is the only mechanism guaranteed
    to work regardless of where the child is stuck (pure Python, C
    extension, or kernel call) — in-worker SIGALRM is unreliable here
    because the enumerator hot loops defer signal delivery long enough
    to defeat a 5-minute budget.

    Result is written to `out_path` as JSON. We use a temp file instead
    of multiprocessing.Queue: each game's positions list can run hundreds
    of KB once raw_features / turn_encodings are serialized, blowing
    through the 64-KB OS pipe buffer that backs Queue. The pipe back-
    pressures, the queue's feeder thread blocks, the worker process
    can't exit, and the parent (which only drains on worker exit) never
    sees the result — classic deadlock. Files have no such limit.

    Each child handles exactly one game and exits, which doubles as the
    memory-leak bound (Python's allocator never returns freed memory to
    the OS, so re-using a worker across games lets RSS creep upward; one
    game per child caps peak RSS at the per-game peak)."""
    try:
        positions, matched, unmatched = convert_game(game)
        result = {'i': i, 'positions': positions, 'matched': matched,
                  'unmatched': unmatched, 'timed_out': False}
    except Exception as e:
        # Surface as TIMEOUT-flagged empty result so the parent doesn't
        # confuse a real crash with a clean no-positions game.
        result = {'i': i, 'positions': [], 'matched': 0, 'unmatched': 0,
                  'timed_out': True, 'error': repr(e)}
    # Atomic write: dump to .tmp and rename so the parent never sees a
    # half-written file (a kill mid-write would leave .tmp; the rename
    # itself is atomic on POSIX).
    tmp = out_path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(result, f)
    os.replace(tmp, out_path)


def _has_fireblast(spell_names):
    return any(s == 'Fireblast' for s in (spell_names or []))


def main():
    parser = argparse.ArgumentParser(
        description='Import human games from Firebase for AI training')
    parser.add_argument('--db-url', type=str,
                        default='https://sigil-js-default-rtdb.firebaseio.com',
                        help='Firebase Realtime Database URL')
    parser.add_argument('--service-account', type=str, default=None,
                        help='Path to Firebase service account JSON key')
    parser.add_argument('--output', type=str, default=None,
                        help='Output JSONL path (default: '
                             'ai/data/human/human_games_<today>.jsonl)')
    parser.add_argument('--jobs', type=int, default=1,
                        help='Parallel worker processes for conversion '
                             '(exhaustive enumeration is CPU-bound)')
    parser.add_argument('--resume', type=str, default=None,
                        help='Path to an existing partial JSONL; games '
                             'already represented in it are skipped and '
                             'new positions are appended to the same file. '
                             'Dedup is by _gid when present (records written '
                             'by this version), with game_index as a fallback '
                             'for older partial files (assumes Firebase '
                             'download order is stable).')
    parser.add_argument('--game-timeout', type=int, default=300,
                        help='Per-game timeout in seconds. Games whose '
                             'conversion (incl. exhaustive enumeration) does '
                             'not finish in this window are skipped and '
                             'logged as TIMEOUT so a single explosive game '
                             'cannot stall the entire import. Set to 0 to '
                             'disable. Default: 300.')
    args = parser.parse_args()

    if args.resume:
        if args.output is not None and args.output != args.resume:
            print(f"--resume implies --output={args.resume}; ignoring "
                  f"--output {args.output}")
        args.output = args.resume

    if args.output is None:
        today = datetime.date.today().isoformat()
        args.output = os.path.join(DATA_DIR, 'human',
                                   f'human_games_{today}.jsonl')

    games = download_games(args.db_url, args.service_account)
    if not games:
        return

    # Pre-filter: drop games that pre-date the Fireblast nerf AND used
    # Fireblast (old, cost-free Fireblast mis-teaches the value head).
    # Uses the authoritative Firebase timestamp, not file mtime. The
    # glitched competitive opening-pass games were already removed from
    # Firebase, so no competitive carve-out is needed here.
    kept_games = []
    skipped_fireblast = 0
    skipped_oov = 0
    for g in games:
        sn = g.get('spellNames') or []
        if any(s not in SPELL_TO_ID for s in sn):
            skipped_oov += 1          # uses spells the net can't represent
            continue
        d = game_played_date(g)
        if (d is not None and d < FIREBLAST_RULE_CHANGE_CUTOFF
                and _has_fireblast(sn)):
            skipped_fireblast += 1
            continue
        kept_games.append(g)

    os.makedirs(os.path.dirname(args.output) if os.path.dirname(args.output) else '.',
                exist_ok=True)

    # Build the (index, game) task list. Index refers to position in
    # kept_games, which is downstream of Firebase's dict-iteration order;
    # we rely on that being stable across runs for the game_index-based
    # resume fallback (records written by older versions don't carry _gid).
    tasks = list(enumerate(kept_games))

    # --resume: scan the existing partial JSONL and remove already-processed
    # games from the task list. Prefer _gid dedup (robust to download-order
    # changes); fall back to game_index for legacy records that predate _gid.
    open_mode = 'w'
    if args.resume and os.path.exists(args.resume):
        # Trim any partial trailing line (no final newline) — a kill mid-
        # write leaves an orphan that breaks json.loads on every subsequent
        # resume and stays in the file as garbage even if dedup proceeds.
        # Truncate to the last complete \n.
        file_size = os.path.getsize(args.resume)
        if file_size > 0:
            with open(args.resume, 'rb') as rf:
                rf.seek(file_size - 1)
                last_byte = rf.read(1)
            if last_byte != b'\n':
                with open(args.resume, 'rb+') as rf:
                    chunk_size = 65536
                    scan_pos = file_size
                    trimmed = False
                    while scan_pos > 0:
                        read_size = min(chunk_size, scan_pos)
                        rf.seek(scan_pos - read_size)
                        chunk = rf.read(read_size)
                        nl = chunk.rfind(b'\n')
                        if nl >= 0:
                            new_size = (scan_pos - read_size) + nl + 1
                            rf.truncate(new_size)
                            print(f"Resume: trimmed {file_size - new_size} "
                                  f"byte(s) of partial trailing line.")
                            trimmed = True
                            break
                        scan_pos -= read_size
                    if not trimmed:
                        rf.truncate(0)
                        print("Resume: file had no complete lines; "
                              "truncated to empty.")

        done_gids = set()
        done_indices = set()
        with open(args.resume) as rf:
            for line in rf:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                gid = rec.get('_gid')
                if gid is not None:
                    done_gids.add(gid)
                gi = rec.get('game_index')
                if gi is not None:
                    try:
                        done_indices.add(int(gi))
                    except (TypeError, ValueError):
                        pass
        before = len(tasks)
        tasks = [(i, g) for i, g in tasks
                 if g.get('_gid') not in done_gids and i not in done_indices]
        print(f"Resume: {len(done_gids)} game(s) deduped by _gid, "
              f"{len(done_indices)} by game_index; "
              f"{before - len(tasks)} skipped, {len(tasks)} remaining "
              f"(of {before} eligible games).")
        open_mode = 'a'
    elif args.resume:
        # User asked to resume but the file doesn't exist yet — start fresh
        # at that path so subsequent runs can resume.
        print(f"--resume {args.resume}: file does not exist yet; "
              f"starting fresh and writing to it.")

    # Free the raw Firebase blob — we only need kept_games[i] from here on,
    # and we explicitly want the parent's RSS low before workers fork.
    del games

    total_positions = 0
    total_matched = 0
    total_unmatched = 0
    games_with_positions = 0
    timeouts = 0
    elos = []
    dates = []
    annotations = 0
    start_time = time.time()

    def _handle(i, game, positions, matched, unmatched, fh):
        nonlocal total_positions, total_matched, total_unmatched
        nonlocal games_with_positions, annotations
        total_matched += matched
        total_unmatched += unmatched
        if positions:
            games_with_positions += 1
        for pos in positions:
            pos['game_index'] = i
            fh.write(json.dumps(pos) + '\n')
            total_positions += 1
            if pos.get('player_elo') is not None:
                elos.append(pos['player_elo'])
            if pos.get('played_date'):
                dates.append(pos['played_date'])
            if pos.get('annotation'):
                annotations += 1

    # Process-per-game parallelism. Each game runs in its own short-lived
    # child via ctx.Process; the parent enforces --game-timeout with
    # .join(timeout=N) and .terminate() if exceeded. We tried Pool +
    # SIGALRM first — workers got stuck in the enumerator hot loop where
    # signal delivery was deferred indefinitely, and a single 5-minute-
    # over-budget game stalled the whole pool. Parent-side termination
    # cannot be defeated by anything the child does, so a stuck game
    # always frees its slot.
    #
    # 'fork' start method: parent has torch loaded (via ai.features), and
    # CoW lets workers share most of it. Switching to 'spawn'/'forkserver'
    # would re-import torch in every child (~2 GB each) — we measured
    # this and it pushed 12 workers past 29 GB RAM. With fork + one
    # process per game, peak RSS is bounded by the worst single-game
    # peak (~few GB), regardless of how many games we import.
    from multiprocessing import get_context
    import tempfile
    import shutil
    ctx = get_context('fork')
    jobs = max(1, args.jobs)
    timeout = args.game_timeout if args.game_timeout and args.game_timeout > 0 else None
    ipc_dir = tempfile.mkdtemp(prefix='sigil_import_')

    def _start_one(idx, game):
        out_path = os.path.join(ipc_dir, f'game_{idx}.json')
        p = ctx.Process(target=_run_one_game, args=(idx, game, out_path),
                        daemon=True)
        p.start()
        return {'p': p, 'out': out_path, 'i': idx, 'start': time.time()}

    def _reap(slot, timed_out_flag):
        """Read the slot's result file (or fabricate a TIMEOUT result if
        the child was terminated before it could write). Cleans up the
        temp file in either case."""
        out_path = slot['out']
        try:
            if not timed_out_flag and os.path.exists(out_path):
                with open(out_path) as rf:
                    d = json.load(rf)
                return (d['i'], d['positions'], d['matched'],
                        d['unmatched'], d['timed_out'])
            return (slot['i'], [], 0, 0, True)
        finally:
            for path in (out_path, out_path + '.tmp'):
                try:
                    os.unlink(path)
                except FileNotFoundError:
                    pass

    def _terminate(slot):
        p = slot['p']
        p.terminate()
        p.join(timeout=5)
        if p.is_alive():
            p.kill()
            p.join(timeout=5)

    in_flight = []
    pending = iter(tasks)
    total_tasks = len(tasks)
    completed = 0

    with open(args.output, open_mode) as f:
        try:
            while True:
                # Top up: keep `jobs` games in flight.
                while len(in_flight) < jobs:
                    try:
                        i_next, game_next = next(pending)
                    except StopIteration:
                        break
                    in_flight.append(_start_one(i_next, game_next))

                if not in_flight:
                    break

                # Poll for completions / timeouts.
                now = time.time()
                still_alive = []
                for slot in in_flight:
                    # File-based completion: if the result file exists,
                    # the child has finished its atomic write and is
                    # about to exit. We don't need to wait for is_alive()
                    # to flip — the result is already on disk.
                    file_ready = os.path.exists(slot['out'])
                    if file_ready or not slot['p'].is_alive():
                        slot['p'].join(timeout=5)
                        # If process died without writing the file,
                        # _reap returns a TIMEOUT-flagged result.
                        timed_out_hint = not file_ready
                        i, positions, matched, unmatched, t_o = _reap(
                            slot, timed_out_hint)
                        _handle(i, kept_games[i], positions, matched,
                                unmatched, f)
                        f.flush()
                        if t_o:
                            timeouts += 1
                        completed += 1
                        elapsed = now - start_time
                        rate = completed / elapsed if elapsed > 0 else 0.0
                        tag = ('TIMEOUT' if t_o
                               else f'+{len(positions)}pos')
                        print(f"  [{completed}/{total_tasks}] game={i} "
                              f"{tag} (total={total_positions} positions, "
                              f"{rate:.2f} g/s)", flush=True)
                    elif timeout is not None and (now - slot['start']) > timeout:
                        # Hard timeout — the child is wedged.
                        i = slot['i']
                        _terminate(slot)
                        i_r, positions, matched, unmatched, _ = _reap(slot, True)
                        _handle(i, kept_games[i], positions, matched, unmatched, f)
                        f.flush()
                        timeouts += 1
                        completed += 1
                        elapsed = now - start_time
                        rate = completed / elapsed if elapsed > 0 else 0.0
                        print(f"  [{completed}/{total_tasks}] game={i} "
                              f"TIMEOUT after {timeout}s "
                              f"(total={total_positions} positions, "
                              f"{rate:.2f} g/s)", flush=True)
                    else:
                        still_alive.append(slot)
                in_flight = still_alive

                # Short sleep so we don't spin while waiting.
                if in_flight:
                    time.sleep(0.25)
        except KeyboardInterrupt:
            # Clean up any in-flight children on Ctrl-C so we don't leave
            # orphan processes pegged on a CPU.
            for slot in in_flight:
                _terminate(slot)
            raise
        finally:
            # Clear the IPC tempdir whether we finished normally or were
            # interrupted — keeps /tmp tidy across re-runs.
            shutil.rmtree(ipc_dir, ignore_errors=True)

    elapsed = time.time() - start_time
    match_total = total_matched + total_unmatched
    match_rate = (total_matched / match_total * 100) if match_total else 0.0
    print(f"\nConverted {total_positions} positions from "
          f"{games_with_positions}/{len(kept_games)} games in {elapsed:.1f}s")
    print(f"  skipped (out-of-vocab spells): {skipped_oov} games")
    print(f"  skipped (pre-nerf Fireblast): {skipped_fireblast} games")
    print(f"  timed-out games (>{args.game_timeout}s, dropped): {timeouts}")
    print(f"  turn match rate: {total_matched}/{match_total} ({match_rate:.1f}%) "
          f"— {total_unmatched} unmatched/discarded")
    if elos:
        import statistics
        elos_sorted = sorted(elos)
        print(f"  player_elo (positions w/ rating): n={len(elos)} "
              f"min={elos_sorted[0]} median={int(statistics.median(elos_sorted))} "
              f"max={elos_sorted[-1]}")
        for lo in (0, 1050, 1200, 1400):
            print(f"    >= {lo}: {sum(1 for e in elos if e >= lo)} positions")
    if dates:
        print(f"  played dates: {min(dates)} -> {max(dates)}")
    print(f"  annotated positions: {annotations}")
    print(f"Output: {args.output}")


if __name__ == '__main__':
    main()
