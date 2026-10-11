"""Engine spell charts, data: self-play with randomized EXCLUSIVE spell access.

    spell_access_arena.py <games> <depth> [comp_frac=0.67] [p_shared=0.3333]

Every game draws 3 spells per role uniformly from the 45 official spells, then
assigns each of the 9 drawn spells independently to red only, blue only (each
with probability (1 - p_shared) / 2) or both players (p_shared). A spell a
player may not use never counts as charged for them (`PyBoard.set_access`), so
they can neither cast it nor benefit from its static -- the engine's version of
"this player holds the spell". Both sides play the SHIPPED config (eval,
policy, exploration tail, adaptive widening, book off) at a fixed depth with no
clock (`root_scores_and_play`, as selfplay_v2.py), so a game does not depend on
the VM's speed.

One `RECORD {json}` line per game: seed, spells (slot order), owner per slot
(0 shared, 1 red only, 2 blue only), variant, winner (red/blue/null for the
140-ply cap), plies. fit_spell_charts.py turns the records into the tier list
(value of exclusive access), matchup chart (red-only A vs blue-only B) and
synergy chart (one player holding both). The shard offset comes from
$SIGIL_SHARD_OFF, as with every gcp/runner.sh harness.
"""
import json, os, random, sys, time
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import shard_offset

SEED_BASE = 30_000_000
MAX_PLIES = 140
ROLES = ([0, 1, 2, 3, 4, 15, 18, 21, 24, 27, 30, 33, 36, 39, 44],
         [5, 6, 7, 8, 9, 16, 19, 22, 25, 28, 31, 34, 37, 40, 43],
         [10, 11, 12, 13, 14, 17, 20, 23, 26, 29, 32, 35, 38, 41, 42])
EVAL = se.SHIPPED_EVAL
AD = tuple(se.SHIPPED_ADAPTIVE)


def draw_game(rng, comp_frac, p_shared):
    spells = []
    for pool in ROLES:
        spells += rng.sample(pool, 3)
    owner = []
    for _ in range(9):
        u = rng.random()
        owner.append(0 if u < p_shared else (1 if u < p_shared + (1 - p_shared) / 2 else 2))
    comp = rng.random() < comp_frac
    return spells, owner, comp


def access_masks(owner):
    red = blue = 0
    for p, o in enumerate(owner):
        if o in (0, 1):
            red |= 1 << p
        if o in (0, 2):
            blue |= 1 << p
    return red, blue


def play(spells, owner, comp, depth):
    b = se.Board(spells, 'competitive' if comp else 'standard')
    b.setup_initial()
    b.set_access(*access_masks(owner))
    hist = []
    plies = 0
    for plies in range(1, MAX_PLIES + 1):
        hist.append(b.key_js)
        # Fixed-depth search with no clock (play_best would spend its whole
        # time budget even at a depth cap); universe_cap=1 skips the training
        # labels' ordered-stream drain.
        b.root_scores_and_play(depth, EVAL, False, 1, list(hist), True, None, AD)
        if b.gameover:
            return b.winner, plies
    return None, plies


def main():
    a = sys.argv[1:]
    games, depth = int(a[0]), int(a[1])
    comp_frac = float(a[2]) if len(a) > 2 else 0.67
    p_shared = float(a[3]) if len(a) > 3 else 1 / 3
    off = shard_offset()
    se.set_policy(*se.SHIPPED_POLICY)
    se.set_policy_explore(*se.SHIPPED_EXPLORE)
    se.set_opening_book(False)
    assert games <= 1000, "seeds are SEED_BASE + off + i with off stepping by 1000"
    t0 = time.time()
    wins = {'red': 0, 'blue': 0, None: 0}
    for g in range(games):
        seed = SEED_BASE + off + g
        spells, owner, comp = draw_game(random.Random(seed), comp_frac, p_shared)
        winner, plies = play(spells, owner, comp, depth)
        wins[winner] += 1
        print('RECORD ' + json.dumps(dict(
            seed=seed, spells=spells, owner=owner,
            variant='competitive' if comp else 'standard', winner=winner, plies=plies,
            depth=depth, eval=EVAL)), flush=True)
    print(f"SHARD off={off} games={games} depth={depth} red={wins['red']} blue={wins['blue']} "
          f"capped={wins[None]} {time.time() - t0:.0f}s", flush=True)


if __name__ == '__main__':
    main()
