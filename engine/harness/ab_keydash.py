#!/usr/bin/env python3
"""A/B one key-dash configuration against the pre-fix stage ordering.

    ab_keydash.py <pairs> <ms> <reasons> <min_width> <extra> [eval_name]

The shard's seed offset comes from $SIGIL_SHARD_OFF, never a positional argument.

RE-RUN NOTE. Every earlier dash experiment was measured with the MATERIAL eval, which
prices a dash at -2 stones the moment it is played and cannot see the positional
payoff that justifies it -- measured at 0.81 stones of unearned penalty per dash. So
"dashes are not worth their cost" was never really tested; what was tested was
"dashes are not worth their cost TO AN EVAL THAT CANNOT PRICE THEM". `tfit` is worth
~+58 Elo over material and prices sigil progress and mana far higher, so the
strictly-additive variant deserves one more measurement against it.

`reasons` is a bitmask over key_dash::REASON_* (1 CRUSH, 2 SPELL_CRUSH, 4 FILLS,
8 MANA, 16 DOOMED); `min_width` reserves the dash slot only where the width budget
is at least that; `extra` > 0 switches to the strictly-additive path, which APPENDS
that many key dashes instead of reserving slots — so a loss there can only be the
cost of the extra subtrees, never a displaced move, since the blindness is not uniform over the tree — the root
already reaches a dash in most positions and it is the width-6 leaf-adjacent nodes
that are blind.

Both arms are the same binary, differing only in these knobs, and the merge is held
OFF in both (it is a separate, known regression). Colour-swapped and seeded.
"""
import math, os, statistics, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
import sigil_engine as se
from sprt import Sprt, shard_offset

OFF = 1 << 62   # merge_min_width sentinel: wider than any real budget

def game(seed, new_color, ms, reasons, min_width, extra, ev, max_plies=140):
    b = se.Board(se.Board.legal_draw(seed), "standard"); b.setup_initial()
    hist = []; dep = {'new': [], 'old': []}
    for ply in range(max_plies):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        legacy = (side != new_color)
        hist.append(b.key_js)
        d, n, dt, over, w, sc, wd = b.play_best(
            ms, 64, 20, 16, 1, hist, ev, legacy, OFF,
            0 if legacy else reasons, 0 if legacy else min_width,
            0 if legacy else extra)
        dep['old' if legacy else 'new'].append(d)
        if over: return w, ply + 1, dep
    return None, max_plies, dep

if __name__ == "__main__":
    pairs = int(sys.argv[1]); ms = int(sys.argv[2])
    reasons = int(sys.argv[3]); min_width = int(sys.argv[4])
    extra = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    ev = sys.argv[6] if len(sys.argv) > 6 else "tfit"
    off = shard_offset()
    cfg = se.search_defaults()
    print(f"  ENGINE CONFIG  eval={ev} reasons={reasons} min_width={min_width} "
          f"extra={extra} merge_min_width="
          f"{'OFF' if cfg['merge_min_width'] >= (1<<63) else cfg['merge_min_width']}",
          flush=True)
    print(f"  SEEDS  {7_000_000+off}..{7_000_000+off+pairs-1} (shard offset {off}) -- "
          f"two shards sharing a range replicate games and invalidate the statistics",
          flush=True)
    sprt = Sprt(elo0=0.0, elo1=25.0)
    wins = {'new': 0, 'old': 0}; unf = 0; plies = []; dep = {'new': [], 'old': []}
    for i in range(pairs):
        for nc in ('red', 'blue'):
            w, n, d = game(7_000_000 + off + i, nc, ms, reasons, min_width, extra, ev)
            plies.append(n); dep['new'] += d['new']; dep['old'] += d['old']
            if w is None: unf += 1
            elif w == nc: wins['new'] += 1
            else: wins['old'] += 1
            sprt.update(None if w is None else (w == nc))
            print(f"GAME seed={7_000_000+off+i} new={nc} winner={w} plies={n}", flush=True)
    tot = sum(wins.values()) + unf
    p = wins['new'] / tot if tot else 0
    se_ = math.sqrt(p * (1 - p) / tot) if 0 < p < 1 else 0
    elo = 400 * math.log10(p / (1 - p)) if 0 < p < 1 else float('nan')
    print(f"SHARD reasons={reasons} min_width={min_width} extra={extra} off={off} n={tot} "
          f"new={wins['new']} old={wins['old']} unf={unf}")
    print(f"key-dash(reasons={reasons}, min_width={min_width}, extra={extra}) vs stage-order   "
          f"{tot} games, {ms} ms/move, colour-swapped")
    print(f"  new {wins['new']}   old {wins['old']}   unfinished {unf}")
    print(f"  NEW SCORE {100*p:.1f}%  (SE {100*se_:.1f}%)   Elo diff {elo:+.0f}")
    print(f"  mean plies {statistics.mean(plies):.1f}")
    print(f"  depth: new {statistics.mean(dep['new']):.2f}  old {statistics.mean(dep['old']):.2f}")
    print(sprt.line(f"keydash r={reasons} mw={min_width} x={extra} eval={ev}"))
