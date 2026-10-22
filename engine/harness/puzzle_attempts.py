"""One AI tier attempts a slice of the puzzle set, as the browser plays that tier.

    puzzle_attempts.py <tier> <puzzles.json> <n_shards>

The shard index is $SIGIL_SHARD_OFF / 1000 (runner.sh: (SHARD_BASE + worker) * 1000);
shard i takes the puzzles whose position in the set is i mod n_shards.

The tier plays the puzzle's mover with its browser settings (tier_roundrobin.TIERS:
per-move time, table bits, the shipped eval, width and adaptive), on a fresh table,
without pondering (the defender's replies take a few seconds, not a full move).

    mate in N    the tier gets N turns. Between them the defender replies: the
                 stored defence when the tier's turn reached a stored line, else a
                 DEFENCE_MS search. Solved when the tier wins within its N turns.
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

DEFENCE_MS = 3000
DEFENCE_TT = 20


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
    foe = se.SearchSession(DEFENCE_TT)
    foe.new_game()
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
    lines = p.get('solutions')
    for turn in range(1, p['mate'] + 1):
        over, w = play(me, b, cfg['ms'], hist)
        if over:
            return w == mover, turn
        if turn == p['mate']:
            return False, turn
        # The defender's reply: the stored defence on a stored line, else a search.
        line = stored_defence(lines, sfn_key(b.to_sfn()))
        d = line and line.get('defence')
        if d and side_of(b) != mover:
            nb = se.Board.from_sfn(d['after'])
            hist.append(b.key_js)
            b = nb
            lines = line.get('continuations') or []
        else:
            over, w = play(foe, b, DEFENCE_MS, hist)
            lines = []
            if over:
                return w == mover, turn
    return False, p['mate']


def main():
    tier, path, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
    if not os.path.isabs(path) and not os.path.exists(path):
        path = os.path.join(_REPO, path)          # runner.sh passes repo-relative paths
    shard = int(os.environ.get('SIGIL_SHARD_OFF', '0')) // 1000
    if hasattr(se, 'SHIPPED_POLICY'):
        se.set_policy(*se.SHIPPED_POLICY)
    if hasattr(se, 'SHIPPED_EXPLORE'):
        se.set_policy_explore(*se.SHIPPED_EXPLORE)
    with open(path, encoding='utf-8') as fh:
        puzzles = json.load(fh)['puzzles']
    mine = [p for i, p in enumerate(puzzles) if i % n == shard % n]
    print(f"  CONFIG tier={tier} shard={shard}/{n} puzzles={len(mine)} eval={EVAL} defence_ms={DEFENCE_MS}", flush=True)
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
