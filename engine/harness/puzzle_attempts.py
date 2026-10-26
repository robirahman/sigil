"""One AI tier attempts a slice of the puzzle set, as the browser plays that tier.

    puzzle_attempts.py <tier> <puzzles.json | gs://bucket/object> <n_shards> [m1+m2+m3+win]

The shard index is $SIGIL_SHARD_OFF / 1000 (runner.sh: (SHARD_BASE + worker) * 1000);
shard i takes the puzzles whose position in the set is i mod n_shards.

The tier plays the puzzle's mover with its browser settings (tier_roundrobin.TIERS:
per-move time, table bits, the shipped eval, width and adaptive), on a fresh table,
without pondering (the defender's replies take a few seconds, not a full move).

    mate in N    the tier gets N turns, judged as the page judges a player: on a
                 stored line the stored defence replies; off it the page's judge
                 (judge_move, JUDGE_MS) rules, a slow win or an escape fails at
                 once, and the judge's move replies. Solved when the tier wins
                 within its N turns.
    winning turn the tier gets one turn. Solved when it reaches a stored solution,
                 or when its position keeps P(win) >= the puzzle's accept_p by the
                 depth-4 child search the generator used (winning_turns.py) -- the
                 rule the page applies to a player's turn.

Each attempt prints one `ATTEMPT {json}` line: id, tier, solved, turns, seconds.
fit_puzzle_ratings.py turns them into puzzle ratings against the tiers' ratings.
"""
import json, os, sys, time
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.join(_REPO, 'tools'))
import sigil_engine as se
from tier_roundrobin import TIERS, EVAL, WIDTH, ADAPTIVE
from gen_mate_puzzles import sfn_key
import winning_turns

JUDGE_MS = 6000      # PuzzleOpponent's judge budget on the page


def side_of(b):
    return 'red' if b.to_sfn().split()[1] == 'r' else 'blue'


def play(sess, b, ms, hist):
    """The session's best turn, applied to `b`. Returns (over, winner)."""
    hist.append(b.key_js)
    _d, _n, _dt, over, w, _s, _ = sess.play_best(b, ms, 64, 16, WIDTH, list(hist), EVAL, adaptive=ADAPTIVE)
    return over, w


def stored_defence(lines, key):
    """The stored line (and its defence) whose position is `key`, if any."""
    for sol in lines or []:
        if sol.get('key') == key:
            return sol
    return None


def attempt(p, tier):
    cfg = TIERS[tier]
    me = se.SearchSession(cfg['tt'])
    me.new_game()
    b = se.Board.from_sfn(p['sfn'])
    mover = p['mover']
    hist = []
    if p.get('kind') == 'winning':
        over, w = play(me, b, cfg['ms'], hist)
        key = sfn_key(b.to_sfn())
        if over:
            return w == mover, 1
        if key in set(p['solution_keys']):
            return True, 1
        prob, _info = winning_turns.mover_prob(se, b.to_sfn(), mover, winning_turns.CHILD_DEPTH,
                                               winning_turns.CHILD_MS)
        return prob is not None and prob >= p.get('accept_p', 0.7), 1
    # The page's flow (game-board-local.js _puzzleOnTurn / PuzzleOpponent): a
    # turn on a stored line gets the stored defence; any other turn is judged
    # by the engine (judge_move, as the page calls it) and the reply is the
    # judge's move. A judged turn that only wins slowly or lets the defender
    # escape fails the puzzle on the spot, even if later play would win. A
    # first turn that reaches a known winning position (solution_keys) without
    # a stored line is accepted, with the judge's reply.
    lines = p.get('solutions')
    keys = set(p.get('solution_keys') or [])
    for turn in range(1, p['mate'] + 1):
        over, w = play(me, b, cfg['ms'], hist)
        if over:
            return w == mover, turn
        if turn == p['mate']:
            return False, turn
        key = sfn_key(b.to_sfn())
        line = stored_defence(lines, key)
        d = line and line.get('defence')
        if d:
            nb = se.Board.from_sfn(d['after'])
            hist.append(b.key_js)
            b = nb
            lines = line.get('continuations') or []
            continue
        accepted = line is not None or (turn == 1 and key in keys)
        verdict, after = se.judge_move(b.to_sfn(), 2 * (p['mate'] - turn), JUDGE_MS)
        if not accepted and verdict in ('mate_slow', 'escape'):
            return False, turn
        if after is None:
            return False, turn
        hist.append(b.key_js)
        b = se.Board.from_sfn(after)
        if b.gameover:
            return False, turn
        lines = []
    return False, p['mate']


def main():
    tier, path, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
    if not path.startswith('gs://') and not os.path.isabs(path) and not os.path.exists(path):
        path = os.path.join(_REPO, path)          # runner.sh passes repo-relative paths
    shard = int(os.environ.get('SIGIL_SHARD_OFF', '0')) // 1000
    if hasattr(se, 'SHIPPED_POLICY'):
        se.set_policy(*se.SHIPPED_POLICY)
    if hasattr(se, 'SHIPPED_EXPLORE'):
        se.set_policy_explore(*se.SHIPPED_EXPLORE)
    if path.startswith('gs://'):
        # A candidate set staged in the bucket (the VM venv has no requests).
        import urllib.parse, urllib.request
        bucket, name = path[5:].split('/', 1)
        req = urllib.request.Request(
            'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
            headers={'Metadata-Flavor': 'Google'})
        tok = json.load(urllib.request.urlopen(req, timeout=10))['access_token']
        req = urllib.request.Request(f'https://storage.googleapis.com/storage/v1/b/{bucket}/o/'
                                     + urllib.parse.quote(name, safe='') + '?alt=media',
                                     headers={'Authorization': 'Bearer ' + tok})
        puzzles = json.load(urllib.request.urlopen(req, timeout=300))['puzzles']
    else:
        with open(path, encoding='utf-8') as fh:
            puzzles = json.load(fh)['puzzles']
    if len(sys.argv) > 4:
        # Only some classes, e.g. "m2,m3" (m1, m2, m3, win).
        want = set(sys.argv[4].split('+'))
        puzzles = [p for p in puzzles if ('win' if p.get('kind') == 'winning' else f"m{p['mate']}") in want]
    mine = [p for i, p in enumerate(puzzles) if i % n == shard % n]
    print(f"  CONFIG tier={tier} shard={shard}/{n} puzzles={len(mine)} eval={EVAL} judge_ms={JUDGE_MS}", flush=True)
    for p in mine:
        t0 = time.time()
        try:
            solved, turns = attempt(p, tier)
            rec = dict(id=p['id'], tier=tier, solved=bool(solved), turns=turns, secs=round(time.time() - t0, 1))
        except Exception as e:  # noqa: BLE001
            rec = dict(id=p['id'], tier=tier, error=str(e)[:200], secs=round(time.time() - t0, 1))
        print("ATTEMPT " + json.dumps(rec, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
