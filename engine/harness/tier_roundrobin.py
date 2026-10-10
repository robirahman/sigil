"""One game between two of the site's Rust AI tiers, configured as the browser plays them.

    tier_roundrobin.py <red_tier> <blue_tier> <seed> [max_plies]

Tiers mirror `_RUST_TIERS` in docs/static/scripts/game-board-local.js and the RustAI
defaults in rust-ai.js: per-move seconds, transposition-table bits, the shipped eval
(`se.SHIPPED_EVAL`; `tfit` in the 2026-09-24 run), the shipped generator policy and
exploration tail (as the wasm `ensure_shipped_policy`, engine v25+ / v28+),
width scale 4, adaptive (0.10, 2, 6), and a PERSISTENT table for the whole game (the
worker's `Engine`). The two tiers of >= 10 s ponder by default in the browser, so they
ponder here too: while the other side thinks for its budget, the pondering side
searches the position that side faces (max depth 12, as rust-ai.js). The harness runs
the two sides sequentially, so each ponder phase costs wall time equal to the
opponent's think; the per-move budgets themselves are exact.

Each game ends with one `RECORD {json}` line: tiers, seed, draw, winner and every
position (`positions[i]` is the SFN before ply i+1, the last one is final) with the
per-ply search stats; they are uploaded to Firebase `ai_arena_games/` as training
data (the per-ply log lines alone cannot reconstruct a game).

Used for the 2026-09-24 and 2026-10-10 round-robins that re-anchored the tier ratings (FINDINGS
"Rust AI tier ratings"). Variant from $SIGIL_VARIANT (the human games are competitive).
"""
import json, os, sys, time
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import sigil_engine as se

TIERS = {
    'easy':      dict(ms=100,    tt=16, ponder=False),
    'medium':    dict(ms=1000,   tt=18, ponder=False),
    'hard':      dict(ms=10000,  tt=20, ponder=True),
    'very_hard': dict(ms=60000,  tt=21, ponder=True),
}
EVAL = getattr(se, 'SHIPPED_EVAL', 'tfit')   # rust-ai.js evalName
WIDTH = 4
ADAPTIVE = (0.10, 2, 6)
PONDER_MAX_DEPTH = 12
VARIANT = os.environ.get('SIGIL_VARIANT', 'competitive')


def _names(b):
    n = getattr(b, 'spell_names', None)
    return n() if callable(n) else n


def main():
    red_t, blue_t, seed = sys.argv[1], sys.argv[2], int(sys.argv[3])
    max_plies = int(sys.argv[4]) if len(sys.argv) > 4 else 160
    sa = tuple(se.SHIPPED_ADAPTIVE)   # f32 in the engine: 0.1 comes back as 0.100000001
    assert se.DEFAULT_WIDTH_SCALE == WIDTH and abs(sa[0] - ADAPTIVE[0]) < 1e-6 and sa[1:] == ADAPTIVE[1:], \
        (se.DEFAULT_WIDTH_SCALE, se.SHIPPED_ADAPTIVE)
    # Thread-local, so set in this process before any search (wasm does it in Engine::new).
    if hasattr(se, 'SHIPPED_POLICY'):
        se.set_policy(*se.SHIPPED_POLICY)
    if hasattr(se, 'SHIPPED_EXPLORE'):
        se.set_policy_explore(*se.SHIPPED_EXPLORE)
    tiers = {'red': red_t, 'blue': blue_t}
    sess = {c: se.SearchSession(TIERS[t]['tt']) for c, t in tiers.items()}
    for s in sess.values():
        s.new_game()
    b = se.Board(se.Board.legal_draw(seed), VARIANT)
    b.setup_initial()
    if 'competitive' in VARIANT:
        b.turn_counter = 1          # the browser pre-increments: red's free blink is turn 1
    print(f"  CONFIG variant={VARIANT} seed={seed} red={red_t} blue={blue_t} eval={EVAL} "
          f"width={WIDTH} adaptive={ADAPTIVE} policy={getattr(se, 'SHIPPED_POLICY', None)} "
          f"explore={getattr(se, 'SHIPPED_EXPLORE', None)} draw={_names(b)}", flush=True)
    hist = []
    positions, plies_rec = [b.to_sfn()], []
    secs = {'red': [], 'blue': []}
    winner, plies = None, max_plies
    t0 = time.time()
    for ply in range(max_plies):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        other = 'blue' if side == 'red' else 'red'
        hist.append(b.key_js)
        ms = TIERS[tiers[side]]['ms']
        if TIERS[tiers[other]]['ponder']:
            sess[other].ponder(b, ms, PONDER_MAX_DEPTH, 16, WIDTH, list(hist), EVAL, ADAPTIVE)
        d, nodes, dt, over, w, score, _ = sess[side].play_best(
            b, ms, 64, 16, WIDTH, list(hist), EVAL, adaptive=ADAPTIVE)
        secs[side].append(dt)
        positions.append(b.to_sfn())
        plies_rec.append(dict(mover=side, depth=d, nodes=nodes, secs=round(dt, 3), score=score))
        print(f"  ply {ply+1} {side}({tiers[side]}) depth={d} nodes={nodes} s={dt:.2f} score={score}", flush=True)
        if over:
            winner, plies = w, ply + 1
            break
    mr = sum(secs['red']) / max(1, len(secs['red']))
    mb = sum(secs['blue']) / max(1, len(secs['blue']))
    print(f"GAME seed={seed} red={red_t} blue={blue_t} winner={winner} plies={plies} "
          f"red_s={mr:.3f} blue_s={mb:.3f} wall={time.time()-t0:.0f}", flush=True)
    rec = dict(seed=seed, variant=VARIANT, red=red_t, blue=blue_t,
               redConfig=TIERS[red_t], blueConfig=TIERS[blue_t], eval=EVAL, widthScale=WIDTH,
               adaptive=list(ADAPTIVE), policy=list(getattr(se, 'SHIPPED_POLICY', ()) or []),
               explore=list(getattr(se, 'SHIPPED_EXPLORE', ()) or []),
               spellNames=list(_names(b) or []), winner=winner, plies=plies,
               finished=winner is not None, endTime=int(time.time() * 1000),
               positions=positions, turns=plies_rec)
    print("RECORD " + json.dumps(rec, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
