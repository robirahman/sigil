"""A/B one SEARCH knob against its current value, holding the eval fixed.

    ab_search.py <pairs> <ms> <eval> <knob> <arm_value> <base_value>

    knob = q_depth      plies of quiescence at the horizon (0 = off)
         = aspiration   half-width of the aspiration window, centistones
         = width_scale  multiplier on the progressive-widening schedule

The shard's seed offset comes from $SIGIL_SHARD_OFF, never a positional argument.

WHY NOW. Every search parameter in this engine was tuned against the MATERIAL eval,
whose score at fixed depth is a one-stone square wave. `tfit` is worth ~+58 Elo over
it and has a completely different score distribution, so the tuned values are no
longer the tuned values -- the aspiration window in particular was a hardcoded +/-60
chosen by eye against that square wave.

Both arms are the same binary at the same eval, differing only in the knob.
Colour-swapped and seeded.
"""
import os, statistics, sys
_HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault('SCRATCH', os.path.dirname(os.path.dirname(_HERE)))
sys.path.insert(0, _HERE)
import sigil_engine as se
from sprt import Sprt, shard_offset

MERGE_OFF = 1 << 62
# Baseline widening comes from the ENGINE, not a literal: the shipped scale is now 4,
# and a harness that hardcoded 1 would silently test every other knob under the old,
# far-too-narrow budget -- which is exactly the confound this re-test exists to remove.
BASE_WS = se.DEFAULT_WIDTH_SCALE
KNOBS = ('q_depth', 'aspiration', 'width_scale', 'merge_min_width',
         'key_dash_extra', 'key_dash_min_width', 'adaptive',
         'rank_oversample', 'width_shape',
         # §1.2 booleans: arm value 1 = on, 0 = off (engine default).
         'force_hints', 'root_resort', 'aspiration_steps', 'adopt_partial',
         # elastic: arm value 1 = Elastic::DEFAULT; the GAME lines carry each
         # arm's mean seconds per move so pool_shards can check matched time.
         'elastic',
         # full_budget: 1 = the shipped fixed-budget policy (Elastic::FULL +
         # adopt_partial, the engine default since 2026-09-22); 0 = the
         # matched-time policy it replaced (Elastic::DEFAULT, adopt_partial
         # off). Gate this one at FIXED per-move time: the browser has no pool.
         'full_budget',
         # exact_clock: 1 = the deadline is the budget (engine default since
         # v15: no extension, no early stop, overflow into the reply position);
         # 0 = v14's Elastic::FULL (2x instability extension). FIXED time gate.
         'exact_clock',
         # Selective depth (v15), each measured alone at fixed 10 s, base 0:
         #   nmp      = R*10 + mode  (20 = R 2 at zero-window nodes, 21 = every node)
         #   lmr_quiet = first reduced index (4)
         #   tact_ext = mask*10 + cap (72 = cast|dash|crush, cap 2; 41 = crush, cap 1)
         #   singular = margin in centistones (150)
         'nmp', 'lmr_quiet', 'tact_ext', 'singular',
         # §1.4: pvs 1/0; history 1/0; lmr = ext*10 + r (e.g. 21 = band x2, R 1)
         'pvs', 'history', 'lmr',
         # bundle: the two knobs that cleared individually at 3 s, together.
         # Knobs interact through node rate, so a default flip needs the pair
         # measured as one arm. Value = the lmr code (21); elastic is DEFAULT.
         'bundle',
         # decisive_lead: the stone-lead pre-pass in the ordered stream
         # (turn_iter.rs), 1 = on / 0 = off, set per move through
         # se.set_decisive_lead (a per-thread switch; both arms share this
         # thread, so it is set before EVERY move). Measured Elo-neutral at 3 s
         # (FINDINGS 2026-09-20); the bookend knobs that sat here were removed
         # with the bookends.
         'decisive_lead',
         # lead_bounds_v2: the 2026-09-22 bound corrections + two-phase scan in
         # the same pre-pass (turn_iter::set_lead_bounds_v2), 1 = on / 0 = off,
         # set per move like decisive_lead.
         'lead_bounds_v2',
         # opening_book: the competitive opening selector (opening.rs), 1/0;
         # only meaningful with SIGIL_VARIANT=competitive.
         'opening_book',
         # outcome_order_v2: score a cast's resolutions by what the placed
         # stones achieve (turn_iter::set_outcome_order_v2), 1/0 per move.
         'outcome_order_v2',
         # swing_prepass: material-swing pre-pass at plies 0-1 (turn_iter::set_swing_prepass), 1/0.
         'swing_prepass',
         # dash_summer: the U4TL2D bundle -- Summer second cast after a dash-cast in the
         # stream, swing cap 6000, sacrifice-pair limit, Meteor bound (turn_iter::set_dash_summer), 1/0.
         'dash_summer', 'dash_gen', 'key_dash_v2', 'dash_v2')
BOOL_KNOBS = ('force_hints', 'root_resort', 'aspiration_steps', 'adopt_partial',
              'pvs', 'history')

# Adaptive arms are named `adaptive` and encode (easy_scale, hard_scale) in the arm
# value as easy*100 + hard, with the threshold fixed at ADAPTIVE_P. Keeps the
# one-knob-one-integer shape of this harness.
ADAPTIVE_P = 0.10
DECISIVE_LEAD_CAP = se.DECISIVE_LEAD_CAP   # the engine's, never restated; the switch takes the cap too


def play(b, ms, ev, hist, knob, val):
    """One move with `knob` set to `val`; everything else at engine defaults."""
    ws = val if knob == 'width_scale' else BASE_WS
    qd = val if knob == 'q_depth' else None
    asp = val if knob == 'aspiration' else None
    merge = val if knob == 'merge_min_width' else MERGE_OFF
    adaptive = None
    if knob == 'adaptive' and val > 0:
        adaptive = (ADAPTIVE_P, val // 100, val % 100)
    # key_dash needs BOTH its reason mask and its slot count to do anything, so the
    # extra/min_width knobs turn on CRUSH-only reasons, the one rule that was not
    # harmful at scale 1.
    kdr = 1 if knob in ('key_dash_extra', 'key_dash_min_width') else None
    kdx = val if knob == 'key_dash_extra' else None
    kdmw = val if knob == 'key_dash_min_width' else None
    ros = val if knob == 'rank_oversample' else None
    wsh = val if knob == 'width_shape' else None
    extra = {}
    if knob in BOOL_KNOBS and val:
        extra['use_history' if knob == 'history' else knob] = True
    if knob == 'elastic' and val:
        extra['elastic'] = (2.0, 0.4, 2, 50, True)
    if knob == 'lmr' and val:
        extra['lmr'] = (val // 10, val % 10)
    if knob == 'nmp':
        # 0 must switch the shipped default (2, 1) OFF explicitly.
        extra['nmp'] = (val // 10, val % 10)
    if knob == 'lmr_quiet' and val:
        extra['lmr_quiet'] = val
    if knob == 'tact_ext' and val:
        extra['tact_ext'] = (val // 10, val % 10)
    if knob == 'singular' and val:
        extra['singular'] = val
    if knob == 'exact_clock' and not val:
        extra['exact_clock'] = False
    if knob == 'full_budget' and not val:
        extra['elastic'] = (2.0, 0.4, 2, 50, True)
        extra['adopt_partial'] = False
    if knob == 'bundle' and val:
        extra['elastic'] = (2.0, 0.4, 2, 50, True)
        extra['lmr'] = (val // 10, val % 10)
    if knob == 'decisive_lead':
        se.set_decisive_lead(bool(val), DECISIVE_LEAD_CAP)
    if knob == 'lead_bounds_v2':
        se.set_lead_bounds_v2(bool(val))
    if knob == 'opening_book':
        se.set_opening_book(bool(val))
    if knob == 'outcome_order_v2':
        se.set_outcome_order_v2(bool(val))
    if knob == 'swing_prepass':
        se.set_swing_prepass(bool(val))
    if knob == 'dash_summer':
        se.set_dash_summer(bool(val))
    if knob == 'dash_gen':
        # val = width*10 + sacrifice pairs per landing (242 = width 24, 2 pairs);
        # 0 restores the v15 generator for the base side.
        se.set_dash_gen(1 if val else 0, val // 10, (val % 10) or 2)
    if knob == 'dash_v2':
        # The composed arm: placement-first stream (width 24, 2 pairs per landing)
        # AND key dashes built from it, promoted through the additive path with
        # reasons CRUSH|SPELL_CRUSH|FILLS. val = moves*10 + extra (84 = 8 first
        # moves scanned, 4 key dashes appended); 0 restores the shipped engine.
        if val:
            kdr = 7; kdx = val % 10
            se.set_dash_gen(1, 24, 2); se.set_key_dash_scan(val // 10, 5, 3)
        else:
            se.set_dash_gen(0, 0, 2); se.set_key_dash_scan(4, 5, 3)
    if knob == 'key_dash_v2':
        # val = moves*100 + combos*10 + extra: a wider key-dash scan (8 sacrifice
        # stones) feeding the additive path with reasons CRUSH|SPELL_CRUSH|FILLS.
        if val:
            kdr = 7; kdx = val % 10
            se.set_key_dash_scan(val // 100, 8, (val // 10) % 10)
        else:
            se.set_key_dash_scan(4, 5, 3)
    return b.play_best(ms, 64, 20, 16, ws, hist, ev, False, merge,
                       kdr, kdmw, kdx, qd, None, asp, adaptive, ros, wsh, **extra)


# SIGIL_VARIANT=competitive plays the empty-board opening. The browser counts
# turns from 1 (it pre-increments before each turn: red's free blink is turn 1,
# blue's turn 2, and the engine's `turn_counter <= 2` guards mirror that). A
# harness board starts at 0 and `play_best` increments AFTER the move, so it
# must start at 1 or red gets a SECOND free blink at counter 2.
VARIANT = os.environ.get('SIGIL_VARIANT', 'standard')
if 'competitive' not in VARIANT and len(sys.argv) > 4 and sys.argv[4] == 'opening_book':
    sys.exit('the opening_book knob only acts in the competitive variant: set SIGIL_VARIANT=competitive')


def game(seed, arm_color, ms, ev, knob, arm_val, base_val, max_plies=140):
    b = se.Board(se.Board.legal_draw(seed), VARIANT)
    b.setup_initial()
    if 'competitive' in VARIANT:
        b.turn_counter = 1
    hist = []
    dep = {'arm': [], 'base': []}
    secs = {'arm': [], 'base': []}
    for ply in range(max_plies):
        side = 'red' if b.to_sfn().split()[1] == 'r' else 'blue'
        is_arm = (side == arm_color)
        hist.append(b.key_js)
        r = play(b, ms, ev, hist, knob, arm_val if is_arm else base_val)
        dep['arm' if is_arm else 'base'].append(r[0])
        secs['arm' if is_arm else 'base'].append(r[2])
        if r[3]:
            return r[4], ply + 1, dep, secs
    return None, max_plies, dep, secs


if __name__ == "__main__":
    pairs = int(sys.argv[1]); ms = int(sys.argv[2]); ev = sys.argv[3]
    knob = sys.argv[4]; arm_val = int(sys.argv[5]); base_val = int(sys.argv[6])
    if knob not in KNOBS:
        sys.exit(f"unknown knob {knob!r}; expected one of {KNOBS}")
    off = shard_offset()

    cfg = se.search_defaults()
    print(f"  ENGINE CONFIG  variant={VARIANT} eval={ev} knob={knob} arm={arm_val} base={base_val} "
          f"base_width_scale={BASE_WS} "
          f"ms={ms} merge_min_width="
          f"{'OFF' if cfg['merge_min_width'] >= (1 << 63) else cfg['merge_min_width']} "
          f"defaults(q_depth={cfg['q_depth']}, aspiration={cfg['aspiration']})",
          flush=True)
    print(f"  SEEDS  {6_000_000 + off}..{6_000_000 + off + pairs - 1} "
          f"(shard offset {off}) -- two shards sharing a range replicate games "
          f"and invalidate the statistics", flush=True)

    s = Sprt(elo0=0.0, elo1=25.0)
    plies = []; dep = {'arm': [], 'base': []}; secs = {'arm': [], 'base': []}
    for i in range(pairs):
        for arm in ('red', 'blue'):
            w, n, d, sc = game(6_000_000 + off + i, arm, ms, ev, knob, arm_val, base_val)
            plies.append(n); dep['arm'] += d['arm']; dep['base'] += d['base']
            secs['arm'] += sc['arm']; secs['base'] += sc['base']
            s.update(None if w is None else (w == arm))
            ma = statistics.mean(sc['arm']) if sc['arm'] else 0.0
            mb = statistics.mean(sc['base']) if sc['base'] else 0.0
            print(f"GAME seed={6_000_000+off+i} arm={arm} winner={w} plies={n} "
                  f"arm_s={ma:.3f} base_s={mb:.3f}", flush=True)
        if s.verdict != 'continue':
            break
    print(f"SHARD knob={knob} arm={arm_val} base={base_val} eval={ev} ms={ms} "
          f"off={off} n={s.n} armwins={s.wins} basewins={s.losses} unf={s.unfinished}")
    print(s.line(f"{knob}={arm_val} vs {base_val} (eval={ev}, {ms}ms)"))
    print(f"  mean plies {statistics.mean(plies):.1f}")
    if dep['arm']:
        print(f"  depth: arm {statistics.mean(dep['arm']):.2f}  "
              f"base {statistics.mean(dep['base']):.2f}")
    if secs['arm']:
        print(f"  mean s/move: arm {statistics.mean(secs['arm']):.3f}  "
              f"base {statistics.mean(secs['base']):.3f}  "
              f"(an elastic arm must be gated at MATCHED average time)")
