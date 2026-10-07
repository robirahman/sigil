"""A/B one SEARCH knob against its current value, holding the eval fixed.

    ab_search.py <pairs> <ms> <eval> <knob> <arm_value> <base_value>

    ms = a fixed per-move budget in milliseconds, or a schedule
         <open_ms>@<n>/<ms>: open_ms for each side's first n moves, then ms
         (e.g. 30000@10/10000 -- 30 s for moves 1-10 of each side, 10 s after).

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
KNOBS = ('q_depth', 'aspiration', 'width_scale', 'merge_min_width', 'policy',
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
         # opening_syzygy: the selector's Syzygy rules (opening::set_opening_syzygy:
         # never start opposite Syzygy, take Syzygy when the enemy did, blue values
         # Syzygy by the spells across from it), 1/0; competitive only.
         'opening_syzygy',
         # opening_contest: the selector's same-sigil contest rules
         # (opening::set_opening_contest: free ritual contests, push credit to the
         # side the charm is behind, blue's ++ counter first), 1/0; competitive only.
         'opening_contest',
         # opening_carnage: Carnage worth the best of itself and the sorceries on
         # both sides of it, +0.01, for either colour (opening::set_opening_carnage), 1/0.
         'opening_carnage',
         # outcome_order_v2: score a cast's resolutions by what the placed
         # stones achieve (turn_iter::set_outcome_order_v2), 1/0 per move.
         'outcome_order_v2',
         # swing_prepass: material-swing pre-pass at plies 0-1 (turn_iter::set_swing_prepass), 1/0.
         'swing_prepass',
         # dash_summer: the U4TL2D bundle -- Summer second cast after a dash-cast in the
         # stream, swing cap 6000, sacrifice-pair limit, Meteor bound (turn_iter::set_dash_summer), 1/0.
         'dash_summer', 'dash_gen', 'key_dash_v2', 'dash_v2', 'dash_v3',
         # 2026-09-27 (surprise audit follow-ups):
         # outcome_sel = mode*10000 + window*100 + keep (32404 = sel_score mode 3,
         #   24 resolutions, 4 keeps, for the SEL_SPELLS_DEFAULT spells); 0 = off.
         # speed = 1/0: the tree-identical node-rate switch (turn_iter::set_speed_v1).
         # lead_min = skip the stone-lead pre-pass below this many plies left (2 = shipped since v18, 0 = v17).
         'outcome_sel', 'speed', 'lead_min',
         # preset: an EVAL A/B on the shipped search. Pass the eval argument as
         # `<arm_eval>:<base_eval>` (e.g. tfit_spell:tfit); the side whose knob
         # value is non-zero plays the left one. Arm 1, base 0.
         'preset',
         # threads = search threads*10 + mode (2026-10 step 6; mode 0 = Lazy SMP,
         # 1 = parallel root), base 10 = one thread. Give each shard as many vCPUs as
         # its arm's threads: WORKERS = vCPUs // threads.
         'threads',
         # split = browser option A emulation (2026-10 round 2): k independent
         # engines with root parts merged like rust-ai.js; base 1 = one engine.
         # BOTH arms play the shipped generator policy (se.SHIPPED_POLICY). Give
         # each shard k vCPUs' worth of cores: WORKERS = physical cores // k.
         'split')
BOOL_KNOBS = ('force_hints', 'root_resort', 'aspiration_steps', 'adopt_partial',
              'pvs', 'history')

# Adaptive arms are named `adaptive` and encode (easy_scale, hard_scale) in the arm
# value as easy*100 + hard, with the threshold fixed at ADAPTIVE_P. Keeps the
# one-knob-one-integer shape of this harness.
ADAPTIVE_P = 0.10
DECISIVE_LEAD_CAP = se.DECISIVE_LEAD_CAP   # the engine's, never restated; the switch takes the cap too


def play(b, ms, ev, hist, knob, val):
    """One move with `knob` set to `val`; everything else at engine defaults."""
    if ':' in ev:
        # preset: an eval-only A/B. policy: a release A/B -- the arm (policy on,
        # val != 0) plays the left eval, the base (policy off) the right one.
        if knob not in ('preset', 'policy'):
            sys.exit(f"an `arm:base` eval pair needs knob=preset or policy, got {knob!r}")
        ev = ev.split(':')[0 if val else 1]
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
    if knob == 'opening_syzygy':
        se.set_opening_syzygy(bool(val))
    if knob == 'opening_contest':
        se.set_opening_contest(bool(val))
    if knob == 'opening_carnage':
        se.set_opening_carnage(bool(val))
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
    if knob == 'dash_v3':
        # Tuned composition (coverage instrument 2026-09-23): placement-first
        # stream, key dashes = the best CRUSHING dash under each of the top
        # `moves` first moves (one per move, deduped by landing), appended on the
        # additive path only at nodes of width >= min_width. val = moves*100 +
        # min_width (824 = 8 moves, width >= 24); extra = moves. 0 = shipped.
        if val:
            kdr = 1; kdx = val // 100; kdmw = val % 100
            se.set_dash_gen(1, 24, 2); se.set_key_dash_scan(val // 100, 1, 3)
        else:
            se.set_dash_gen(0, 0, 2); se.set_key_dash_scan(4, 5, 3)
    if knob == 'outcome_sel':
        se.set_outcome_sel(val // 10000, (val // 100) % 100, val % 100)
    if knob == 'speed':
        se.set_speed_v1(bool(val))
    if knob == 'lead_min':
        se.set_lead_min_remaining(val)
    if knob == 'policy':
        # Step 4 learned generator policy (engine/src/policy.rs), BOTH arms at the
        # SHIPPED adaptive widening (0.10, 2, 6) unless the arm overrides it.
        # val = ws*10^8 + easy*10^7 + hard*10^6 + penalty*1000 + min_width; 0 =
        # shipped engine (policy off). penalty in 1/256 nat; easy/hard 0 = shipped
        # (2, 6); ws 0 = BASE_WS (the policy may let width_scale come down).
        se.set_policy(bool(val), val % 1000)
        ws = (val // 10 ** 8) % 10 or ws
        se.set_policy_cost((val // 1000) % 1000, 1 << 30)
        e_, h_ = (val // 10 ** 7) % 10, (val // 10 ** 6) % 10
        sp = tuple(se.SHIPPED_ADAPTIVE)
        adaptive = (sp[0], e_ or sp[1], h_ or sp[2])
    if knob == 'split':
        se.set_policy(*se.SHIPPED_POLICY)
        if val > 1:
            extra['split_workers'] = val
    if knob == 'threads' and val // 10 > 1:
        extra['threads'] = val // 10
        extra['smp_mode'] = val % 10
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
if 'competitive' not in VARIANT and len(sys.argv) > 4 and sys.argv[4] in ('opening_book', 'opening_syzygy', 'opening_contest', 'opening_carnage'):
    sys.exit(f'the {sys.argv[4]} knob only acts in the competitive variant: set SIGIL_VARIANT=competitive')
# SIGIL_REQUIRE_SPELL=<engine spell id>: only play draws that contain this spell
# (the seed is stepped deterministically until its draw does), so a knob that
# acts in one spell's draws is measured where it acts. `legal_draw` draws the 39
# core spells only, so for an EXPANSION id (39-44, Tectonic/Providence) the draw
# comes from the 15-spell-per-role pool instead (core plus the two expansion
# spells of each role, as selfplay_v2.py's all-45 draws), stepped until it holds
# the spell; -1 means "any expansion spell". The GAME lines carry the draw, so
# split_by_draw.py never has to reconstruct it.
REQUIRE_SPELL = int(os.environ['SIGIL_REQUIRE_SPELL']) if os.environ.get('SIGIL_REQUIRE_SPELL') else None
_CORE_POOLS = ([0, 1, 2, 3, 4, 15, 18, 21, 24, 27, 30, 33, 36],
               [5, 6, 7, 8, 9, 16, 19, 22, 25, 28, 31, 34, 37],
               [10, 11, 12, 13, 14, 17, 20, 23, 26, 29, 32, 35, 38])
_EXPANSION_POOLS = ([39, 44], [40, 43], [41, 42])


def _expansion_draw(seed, want):
    import random
    rng = random.Random(seed * 1_000_003 + 45)
    while True:
        d = []
        for role in range(3):
            d += rng.sample(_CORE_POOLS[role] + _EXPANSION_POOLS[role], 3)
        if (want == -1 and any(x >= 39 for x in d)) or want in d:
            return d


def draw_for(seed):
    if REQUIRE_SPELL is not None and (REQUIRE_SPELL < 0 or REQUIRE_SPELL >= 39):
        return _expansion_draw(seed, REQUIRE_SPELL)
    d = se.Board.legal_draw(seed)
    if REQUIRE_SPELL is None:
        return d
    k = 0
    while REQUIRE_SPELL not in d:
        k += 1
        d = se.Board.legal_draw(seed + 10_000_000 * k)
    return d


def parse_ms(spec):
    """'10000' -> (10000, 0, 10000); '30000@10/10000' -> (30000, 10, 10000)."""
    if '@' not in spec:
        return int(spec), 0, int(spec)
    head, tail = spec.split('/', 1)
    open_ms, n = head.split('@', 1)
    return int(open_ms), int(n), int(tail)


def ms_for(sched, ply):
    """Budget for the move at game ply `ply` (0-based; each side's k-th move is ply 2k or 2k+1)."""
    open_ms, n, ms = sched
    return open_ms if ply // 2 < n else ms


# Position saving (2026-10). With $SIGIL_ARENA_DATA set (runner.sh sets it to the
# directory it ships to gs://...-sigil/runs/<run>/data/), every arena position is
# kept as training data: the SFN, the 9 spell ids, full/hand features from the side
# to move, the mover's search result (depth, nodes, score, seconds) and, once the
# game ends, the winner from the mover's side (`y`; 255 = unfinished). The played
# move is the next row's SFN. There are no root-candidate scores (selfplay_v2.py
# has those); these rows add outcome labels and start positions from engines of
# release strength. One npz per shard and arm, rewritten atomically after every
# game, so a watchdog kill loses at most the game in progress.
class ArenaRecorder:
    COLS = ('sfn', 'spells', 'full', 'hand', 'is_red', 'ply', 'game', 'is_arm',
            'ms', 'depth', 'nodes', 'score', 'secs', 'y')

    def __init__(self, path, meta):
        self.path, self.meta = path, meta
        self.rows = {c: [] for c in self.COLS}

    @classmethod
    def from_env(cls, knob, arm_val, base_val, ms_spec, ev, off):
        d = os.environ.get('SIGIL_ARENA_DATA')
        if not d:
            return None
        os.makedirs(d, exist_ok=True)
        tag = ''.join(ch if ch.isalnum() else '_' for ch in f"{knob}{arm_val}v{base_val}_{ms_spec}")
        meta = dict(harness='ab_search', knob=knob, arm=arm_val, base=base_val, ms=ms_spec,
                    eval=ev, variant=VARIANT, require_spell=REQUIRE_SPELL, shard_off=off,
                    engine_version=getattr(se, 'ENGINE_VERSION', None),
                    shipped_eval=getattr(se, 'SHIPPED_EVAL', None))
        return cls(os.path.join(d, f"arena_{tag}_{off}.npz"), meta)

    def before(self, b, side, ply, gid, is_arm, ms):
        R = self.rows
        R['sfn'].append(b.to_sfn()); R['spells'].append(b.spell_ids())
        R['full'].append(b.full_features(side)); R['hand'].append(b.hand_features(side))
        R['is_red'].append(side == 'red'); R['ply'].append(ply); R['game'].append(gid)
        R['is_arm'].append(is_arm); R['ms'].append(ms)

    def after(self, r):
        R = self.rows
        R['depth'].append(r[0]); R['nodes'].append(r[1]); R['secs'].append(r[2])
        R['score'].append(r[5]); R['y'].append(255)

    def end_game(self, gid, winner):
        R = self.rows
        for i in range(len(R['game']) - 1, -1, -1):
            if R['game'][i] != gid:
                break
            if winner is not None:
                R['y'][i] = 1 if (winner == 'red') == bool(R['is_red'][i]) else 0
        self.write()

    def write(self):
        import json
        import numpy as np
        R = self.rows
        tmp = self.path + '.tmp.npz'
        np.savez_compressed(
            tmp, sfn=np.asarray(R['sfn']), spells=np.asarray(R['spells'], np.uint8),
            full=np.asarray(R['full'], np.float32), hand=np.asarray(R['hand'], np.int32),
            is_red=np.asarray(R['is_red'], np.uint8), ply=np.asarray(R['ply'], np.int16),
            game=np.asarray(R['game'], np.int64), is_arm=np.asarray(R['is_arm'], np.uint8),
            ms=np.asarray(R['ms'], np.int32), depth=np.asarray(R['depth'], np.int8),
            nodes=np.asarray(R['nodes'], np.int64), score=np.asarray(R['score'], np.int32),
            secs=np.asarray(R['secs'], np.float32), y=np.asarray(R['y'], np.uint8),
            meta=np.asarray(json.dumps(self.meta)))
        os.replace(tmp, self.path)


RECORDER = None


def game(seed, arm_color, ms, ev, knob, arm_val, base_val, max_plies=140):
    b = se.Board(draw_for(seed), VARIANT)
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
        gid = seed * 2 + (arm_color == 'blue')
        if RECORDER:
            RECORDER.before(b, side, ply, gid, is_arm, ms_for(ms, ply))
        r = play(b, ms_for(ms, ply), ev, hist, knob, arm_val if is_arm else base_val)
        if RECORDER:
            RECORDER.after(r)
        dep['arm' if is_arm else 'base'].append(r[0])
        secs['arm' if is_arm else 'base'].append(r[2])
        if r[3]:
            if RECORDER:
                RECORDER.end_game(gid, r[4])
            return r[4], ply + 1, dep, secs
    if RECORDER:
        RECORDER.end_game(seed * 2 + (arm_color == 'blue'), None)
    return None, max_plies, dep, secs


if __name__ == "__main__":
    pairs = int(sys.argv[1]); ms_spec = sys.argv[2]; ms = parse_ms(ms_spec); ev = sys.argv[3]
    knob = sys.argv[4]; arm_val = int(sys.argv[5]); base_val = int(sys.argv[6])
    if knob not in KNOBS:
        sys.exit(f"unknown knob {knob!r}; expected one of {KNOBS}")
    if knob == 'policy' and ':' in ev and base_val != 0:
        sys.exit("knob=policy with an eval pair needs base value 0 (policy off)")
    if knob == 'preset' and (':' not in ev or arm_val == base_val):
        sys.exit("knob=preset needs eval=<arm>:<base> and arm/base values 1 0")
    for e in ev.split(':'):
        if e not in se.EVAL_NAMES:
            sys.exit(f"unknown eval {e!r}; expected one of {se.EVAL_NAMES}")
    off = shard_offset()
    RECORDER = ArenaRecorder.from_env(knob, arm_val, base_val, ms_spec, ev, off)

    cfg = se.search_defaults()
    print(f"  ENGINE CONFIG  variant={VARIANT} require_spell={REQUIRE_SPELL} eval={ev} knob={knob} arm={arm_val} base={base_val} "
          f"base_width_scale={BASE_WS} "
          f"ms={ms_spec} merge_min_width="
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
                  f"arm_s={ma:.3f} base_s={mb:.3f} "
                  f"draw={','.join(map(str, draw_for(6_000_000 + off + i)))}", flush=True)
        if s.verdict != 'continue':
            break
    print(f"SHARD knob={knob} arm={arm_val} base={base_val} eval={ev} ms={ms_spec} "
          f"off={off} n={s.n} armwins={s.wins} basewins={s.losses} unf={s.unfinished}")
    print(s.line(f"{knob}={arm_val} vs {base_val} (eval={ev}, {ms_spec}ms)"))
    print(f"  mean plies {statistics.mean(plies):.1f}")
    if dep['arm']:
        print(f"  depth: arm {statistics.mean(dep['arm']):.2f}  "
              f"base {statistics.mean(dep['base']):.2f}")
    if secs['arm']:
        print(f"  mean s/move: arm {statistics.mean(secs['arm']):.3f}  "
              f"base {statistics.mean(secs['base']):.3f}  "
              f"(an elastic arm must be gated at MATCHED average time)")
