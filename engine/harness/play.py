#!/usr/bin/env python3
"""Play Sigil against the Rust engine, locally, in a terminal.

    python engine/harness/play.py                # you are red, engine thinks 60 s
    python engine/harness/play.py --color blue --time 10 --seed 7

Why a terminal rather than the website: sigilbattle.com is static GitHub Pages
with every AI running client-side, so an in-browser `?ai=rust` would need the
engine compiled to WebAssembly *and* a translation layer emitting JS-compatible
action lists for every spell resolution. This skips both — the Rust kernel is the
rules authority for both sides, and it is the same kernel verified against
simboard.py on 4,000 positions and the full 4,202-position corpus.

Move entry mirrors the real UI: pick a first move, then pick a continuation
(pass / dash / cast), because the full turn space is ~10^4 wide and cannot be
listed. Everything legal is reachable — nothing is hidden from you.
"""
import argparse, os, sys, textwrap

_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, os.path.join(os.environ['SCRATCH'], 'ref'))
import sigil_engine as se

NODES = list(se.NODE_NAMES)
IDX = {n: i for i, n in enumerate(NODES)}
# Sigil positions 1..9 by node, for the board legend.
POS_OF = {}
for p, group in enumerate([['a2','a3','a4','a5','a6'], ['b2','b3','b4','b5','b6'],
                           ['c2','c3','c4','c5','c6'], ['a8','a9','a10'],
                           ['b8','b9','b10'], ['c8','c9','c10'],
                           ['a7'], ['b7'], ['c7']], start=1):
    for n in group: POS_OF[n] = p
MANA = {'a1', 'b1', 'c1'}

def render(b, spells):
    red = set(NODES[i] for i in b.red); blue = set(NODES[i] for i in b.blue)
    def cell(n):
        ch = 'R' if n in red else 'B' if n in blue else '.'
        return ch
    out = []
    for zone in 'abc':
        row = []
        for k in range(1, 14):
            n = f"{zone}{k}"
            tag = f"{n}:{cell(n)}"
            if n in MANA: tag += '*'                     # mana node
            elif n not in POS_OF: tag += '_'             # void node
            else: tag += f"{POS_OF[n]}"                  # sigil membership
            row.append(f"{tag:>9}")
        out.append("  " + " ".join(row))
    r, bl = b.total
    lines = ["", "  " + " ".join(f"{'':>9}" for _ in range(13)), *out, ""]
    # Blue carries a permanent +1 counter token, which makes the win margin
    # asymmetric: red needs a REAL lead of 4, blue only 2.
    lines.append(f"  stones  red {r}   blue {bl} (+1 token = {bl+1})   "
                 f"score lead {r - (bl+1):+d} for red")
    lines.append(f"          red wins at a real lead of +4 (needs {max(0, 4-(r-bl))} more), "
                 f"blue at 2 (needs {max(0, 2-(bl-r))} more)")
    lines.append(f"  spells cast  red {b.spell_counter[0]}   blue {b.spell_counter[1]}   (6 ends the game)")
    lines.append(f"  charged  red: {', '.join(b.charged_names('red')) or '-'}")
    lines.append(f"           blue: {', '.join(b.charged_names('blue')) or '-'}")
    lines.append("  draw: " + ", ".join(f"{i+1}={s}" for i, s in enumerate(spells)))
    lines.append("  legend  N:X  X=R/B/. ; suffix * mana, _ void, digit = sigil position")
    return "\n".join(lines)

def ask(prompt, options, allow_back=False):
    """options: list of (label,) tuples; returns index or None for 'back'."""
    while True:
        print()
        for i, lab in enumerate(options):
            print(f"   [{i:>3}] {lab}")
        if allow_back: print("   [  b] back")
        raw = input(f"{prompt} > ").strip().lower()
        if allow_back and raw == 'b': return None
        if raw in ('q', 'quit', 'exit'): sys.exit("resigned")
        if raw.isdigit() and 0 <= int(raw) < len(options): return int(raw)
        print("   ? pick one of the listed numbers (or q to quit)")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--color', choices=['red', 'blue'], default='red', help='your colour')
    ap.add_argument('--time', type=int, default=60, help='engine seconds per move')
    ap.add_argument('--seed', type=int, default=None, help='spell draw seed')
    ap.add_argument('--variant', default='standard')
    ap.add_argument('--width-scale', type=int, default=1)
    a = ap.parse_args()

    import random
    seed = a.seed if a.seed is not None else random.randrange(1 << 40)
    draw = se.Board.legal_draw(seed)
    b = se.Board(draw, a.variant)
    b.setup_initial()
    spells = b.spell_names
    me, eng = a.color, ('blue' if a.color == 'red' else 'red')
    print(textwrap.dedent(f"""
    ================ Sigil : you ({me}) vs the Rust engine ({eng}) ================
      draw seed {seed}    variant {a.variant}    engine budget {a.time}s/move
      'q' at any prompt quits.
    """))
    history = []
    while True:
        print(render(b, spells))
        if b.gameover:
            print(f"\n  *** game over — {b.winner} wins ***\n"); return
        history.append(b.key_js)
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        if side == me:
            variants = b.first_move_variants()
            if not variants:
                print("\n  no legal move — you must pass."); input("  [enter] ")
                b.apply_choice(0, -1, 'pass', -1, -1, -1, me)   # engine treats as pass
                continue
            labels = []
            for kind, nd, push in variants:
                s = f"{kind:5s} {NODES[nd]}"
                if push >= 0: s += f"  (push enemy -> {NODES[push]})"
                elif kind != 'blink' and NODES[nd] in set(NODES[i] for i in
                        (b.blue if me == 'red' else b.red)): s += "  (CRUSH)"
                labels.append(s)
            i = ask("your move", labels)
            kind, nd, push = variants[i]
            conts = b.continuations(nd, push, me)
            j = ask("then", [c[0] for c in conts], allow_back=True)
            if j is None: continue
            _lab, ckind, ca, cb, ccc = conts[j]
            b.apply_choice(nd, push, ckind, ca, cb, ccc, me)
        else:
            print(f"\n  engine thinking ({a.time}s)...", flush=True)
            d, nodes, dt, over, w, sc, wd = b.play_best(
                a.time * 1000, 64, 20, 16, a.width_scale, history, "material")
            print(f"  engine: depth {d}, {nodes:,} nodes in {dt:.1f}s, eval {sc/100:+.2f} stones")

if __name__ == '__main__':
    main()
