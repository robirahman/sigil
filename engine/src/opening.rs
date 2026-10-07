//! Competitive opening selector (2026-09-22).
//!
//! In the competitive variant the board starts empty and each side's first
//! turn is a free blink onto any node (`turn_iter.rs` opening branch). The
//! search cannot tell those 39 placements apart -- the eval is flat and the
//! ordering heuristic scores "mana +90, charm +70, everything else +5" -- so
//! the AI's opening was spell-blind, and the weakness audit found it losing
//! 87% of its long games. This module decides WHICH SPELL'S SIGIL to start
//! on from the strategy survey's tables (`opening_data.rs`: Bradley-Terry
//! strengths, synergies, matchups) and leaves the node inside that sigil to
//! the search (`Search::opening_root_turns` restricts the root to it).
//!
//! The decision is a one-ply minimax in Bradley-Terry units, always from red's
//! point of view. Red picks the sigil whose worst case over blue's reply is
//! best; blue, given red's stone, picks the reply that minimises red's value
//! (the strongest spell left, or the counter). Three ingredients:
//!
//! * `own(x | enemy y, side)`: the spell's strength, its liking for an empty
//!   board (it is the opening), a tempo term for how fast the sigil charges
//!   (a charm charges on the spot), a colour term (Hurricane for red, Seal of
//!   Destruction for blue), and the two zone-mates the same corner offers,
//!   each discounted by how many stones it takes to claim and credited for
//!   synergy with `x`. A zone-mate the enemy holds is excluded; otherwise a
//!   shared zone counts for both sides -- no contest penalty (designer's call).
//! * the matchup pip: `++` = 1.0, `+` = 0.5, enough to overturn one tier of
//!   strength (Blossom +1.14 vs Hail Storm +0.51) but not two.
//! * push leverage in a shared zone: the movement charms (Slash, Charge)
//!   evict a contesting stone, so the side holding one gets a bonus; if
//!   neither picked it, red does -- it moves at turn 3, before blue's turn 4.
//! * contesting the very same sigil (2026-09-30, designer's rulings, switch
//!   `set_opening_contest`): a stone in the enemy's ritual denies its cast and
//!   may seize it, so a ritual contest carries no head-start cost for red
//!   (a sorcery contest keeps one, `SAME_SIGIL_TEMPO`). Inside a contested
//!   sigil the push bonus goes to the side the charm is BEHIND: the stone on
//!   the node touching the charm (`behind_node`), because pushing it back
//!   drops it onto the charm, which then pushes on its owner's turn. Red,
//!   moving first, takes that node; blue takes it when red did not. A ritual
//!   has a charm on each side (its own corner's, and through the void node
//!   the previous corner's): the credit goes to one side only when exactly one
//!   of the two is a push charm -- two push charms cancel. A `++`
//!   counter to red's spell still comes first: blue only contests (or picks
//!   anything else) when the draw has no hard counter to red's start.
//!
//! A hard veto mirrors the designer's absolute phrasing ("never start on
//! Blossom if Hail Storm is available"): a spell with a `++` counter in the
//! draw is dropped, unless that drops everything. Ties break on strength then
//! spell id, never on slot, so the choice is zone-invariant.
//!
//! **Syzygy (designer's rules, 2026-09-23, revised 2026-09-30).** Casting
//! Syzygy blinks into the opposite 1-node sigil and then into the opposite
//! 3-node sigil (`resolvers::syzygy_opposite`), pushing or crushing whatever
//! stands there. The 3-node spell opposite is always a target; the 1-node
//! spell opposite is one if it is Slash, Surge, Gust or a static seal
//! (`SYZYGY_ALWAYS_EXPOSED`), or -- for Splash, Charge, Lurk, Azimuth, Sprout,
//! Comet -- only when Seal of Winter is the charm touching Syzygy (its own
//! corner's): the seal forbids casting 1-node spells, so the charm cannot be
//! cast to move its stone out.
//! That is a property of the draw, the same for both colours. "Next to
//! Syzygy" below = in the sigil or on a node touching it. Switchable together
//! with `set_opening_syzygy`:
//!
//! * red never starts on an exposed slot;
//! * blue always takes Syzygy when red started on one (`syzygy_threat`),
//!   on a node next to Seal of Winter when that is what exposes the charm;
//! * red's Syzygy is worth the greater of itself and the 3-node spell opposite;
//! * blue drops the exposed slots, and values them at no more than Syzygy's
//!   own strength, only when red started in or next to Syzygy; otherwise
//!   they are ordinary spells for blue, and blue's Syzygy has its own rating.
//!
//! **Carnage (designer's rule, 2026-09-30, switch `set_opening_carnage`).**
//! Its four hard moves reach the 3-node sigils on both sides of it (its own
//! corner's, and the previous corner's through the void node), so for either
//! side Carnage is worth the strongest of itself and those two sorceries,
//! plus 0.01.

use crate::board::{Board, Color, Outcome};

thread_local! {
    static OPENING_BOOK: std::cell::Cell<bool> = std::cell::Cell::new(true);
}
/// A/B switch for the opening selector (default on), per thread like the
/// pre-pass switches: the arena sets it before every move.
pub fn set_opening_book(on: bool) { OPENING_BOOK.with(|c| c.set(on)); }
pub fn opening_book_enabled() -> bool { OPENING_BOOK.with(|c| c.get()) }
thread_local! {
    static OPENING_SYZYGY: std::cell::Cell<bool> = std::cell::Cell::new(true);
}
/// A/B switch for the Syzygy rules (veto, forced reply, blue's strength
/// substitution); default on, per thread like `set_opening_book`.
pub fn set_opening_syzygy(on: bool) { OPENING_SYZYGY.with(|c| c.set(on)); }
pub fn opening_syzygy_enabled() -> bool { OPENING_SYZYGY.with(|c| c.get()) }
thread_local! {
    static OPENING_CONTEST: std::cell::Cell<bool> = std::cell::Cell::new(true);
}
/// A/B switch for the same-sigil contest rules (no ritual head-start cost, the
/// charm-behind push credit and node choice); off restores the flat
/// `SAME_SIGIL_TEMPO_V17` and red's push credit. Default on, per thread.
pub fn set_opening_contest(on: bool) { OPENING_CONTEST.with(|c| c.set(on)); }
pub fn opening_contest_enabled() -> bool { OPENING_CONTEST.with(|c| c.get()) }
thread_local! {
    static OPENING_CARNAGE: std::cell::Cell<bool> = std::cell::Cell::new(true);
}
/// A/B switch for Carnage's strength substitution (the best of itself and the
/// sorceries on both sides, + `NEIGHBOUR_EDGE`); default on, per thread.
pub fn set_opening_carnage(on: bool) { OPENING_CARNAGE.with(|c| c.set(on)); }
pub fn opening_carnage_enabled() -> bool { OPENING_CARNAGE.with(|c| c.get()) }

thread_local! {
    static OPENING_FORCE: std::cell::Cell<u64> = std::cell::Cell::new(0);
}
/// Data-generation hook (harness/opening_rollouts.py): a non-zero node mask
/// restricts the competitive first placement to those nodes, overriding the
/// selector, so a rollout can play out one chosen sigil. 0 = off (default).
/// Per thread; never set by the site.
pub fn set_opening_force(mask: u64) { OPENING_FORCE.with(|c| c.set(mask)); }
pub fn opening_force() -> u64 { OPENING_FORCE.with(|c| c.get()) }

/// Carnage's engine id (`spells_meta.rs`; pinned by a test).
pub const CARNAGE: u8 = 1;
/// What Carnage adds on top of the best of the sorceries beside it, so it wins the tie.
pub const NEIGHBOUR_EDGE: f32 = 0.01;
use crate::opening_data::{BOARD_PREF, MATCHUP, PUSH_CHARMS, STRENGTH, SYNERGY};
use crate::spells_meta::{AZIMUTH, CHARGE, COMET, GUST, HURRICANE, LURK, CORE_SPELL_COUNT, SEAL_OF_AUTUMN,
                         SEAL_OF_DESTRUCTION, SEAL_OF_SPRING, SEAL_OF_SUMMER, SEAL_OF_WINTER, SLASH, SPELLS, SPLASH,
                         SPROUT, SURGE, SYZYGY};
use crate::topology::{ADJ, SIGIL, VOID};
use crate::resolvers::syzygy_opposite;

/// Charms opposite Syzygy that are always its target (designer, 2026-09-30).
pub const SYZYGY_ALWAYS_EXPOSED: [u8; 7] = [SLASH, SURGE, GUST, SEAL_OF_SPRING, SEAL_OF_SUMMER, SEAL_OF_AUTUMN, SEAL_OF_WINTER];
/// Charms opposite Syzygy that are its target only when Seal of Winter is the
/// charm touching Syzygy (2026-10-02: Winter, not Autumn -- the owner cannot
/// cast the charm to move its stone out).
pub const SYZYGY_WINTER_EXPOSED: [u8; 6] = [SPLASH, CHARGE, LURK, AZIMUTH, SPROUT, COMET];

/// The ritual slot Syzygy was drawn in, if any (it does nothing elsewhere).
pub fn syzygy_slot(spells: &[u8; 9]) -> Option<usize> {
    (0..3).find(|&p| spells[p] == SYZYGY && syzygy_opposite(p).is_some())
}

/// Every node next to one in `mask`.
fn neighbours(mask: u64) -> u64 {
    let (mut m, mut out) = (mask, 0u64);
    while m != 0 { let i = m.trailing_zeros() as usize; m &= m - 1; out |= ADJ[i]; }
    out
}
/// Is some stone in `stones` in sigil `slot` or on a node next to it?
pub fn stones_near(stones: u64, slot: usize) -> bool { stones & (SIGIL[slot] | neighbours(SIGIL[slot])) != 0 }
/// Could one stone started in sigil `s` be near sigil `target` (in it, or touching it)?
fn slot_near(s: usize, target: usize) -> bool { s == target || neighbours(SIGIL[s]) & SIGIL[target] != 0 }
/// The charm slot holding Seal of Winter, if drawn.
fn winter_slot(spells: &[u8; 9]) -> Option<usize> { (6..9).find(|&p| spells[p] == SEAL_OF_WINTER) }

/// Is a stone started on `slot` a Syzygy target: the 3-node sigil opposite
/// Syzygy, or the 1-node sigil opposite it when that charm is always exposed,
/// or is Winter-exposed and `near_winter` (`syzygy_touches_winter`).
pub fn syzygy_exposed(spells: &[u8; 9], slot: usize, near_winter: bool) -> bool {
    let Some(z) = syzygy_slot(spells) else { return false };
    let Some((charm, sorcery)) = syzygy_opposite(z) else { return false };
    slot == sorcery || (slot == charm && (SYZYGY_ALWAYS_EXPOSED.contains(&spells[charm])
        || (near_winter && SYZYGY_WINTER_EXPOSED.contains(&spells[charm]))))
}

/// Is Seal of Winter the charm touching Syzygy (one of Syzygy's nodes is next
/// to the seal)? Then the Winter-exposed charms opposite are targets too.
pub fn syzygy_targets(spells: &[u8; 9], slot: usize) -> bool { syzygy_exposed(spells, slot, syzygy_touches_winter(spells)) }
fn syzygy_touches_winter(spells: &[u8; 9]) -> bool {
    match (syzygy_slot(spells), winter_slot(spells)) {
        (Some(z), Some(a)) => slot_near(z, a),
        _ => false,
    }
}

/// Red's start as the Syzygy side: is it in or next to Syzygy?
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SyzygyThreat { pub near_syzygy: bool }

impl SyzygyThreat {
    /// From red's actual stone.
    pub fn of_stones(spells: &[u8; 9], red: u64) -> Self {
        Self { near_syzygy: syzygy_slot(spells).map_or(false, |z| stones_near(red, z)) }
    }
    /// From the sigil red starts in.
    pub fn of_slot(spells: &[u8; 9], s: usize) -> Self {
        Self { near_syzygy: syzygy_slot(spells).map_or(false, |z| slot_near(s, z)) }
    }
    /// Is blue's start on `slot` a target this red start threatens?
    pub fn exposes(&self, spells: &[u8; 9], slot: usize) -> bool {
        opening_syzygy_enabled() && self.near_syzygy && syzygy_targets(spells, slot)
    }
}

/// One matchup pip (`+`) in Bradley-Terry units; `++` is two.
pub const W_MATCHUP_PIP: f32 = 0.5;
/// One synergy pip with a zone-mate -- half a matchup pip, because a synergy
/// needs both spells actually held while the matchup only needs the two picks.
pub const W_SYNERGY_PIP: f32 = 0.25;
/// A zone-mate's own strength, before the access discount.
pub const W_MATE_STRENGTH: f32 = 0.25;
/// "Better on an empty board" at the opening.
pub const W_BOARD_PREF: f32 = 0.25;
/// Tempo of charging the sigil started on: ritual (5 nodes), sorcery (3), charm (1).
pub const TEMPO: [f32; 3] = [0.0, 0.15, 0.3];
/// How reachable a zone-mate is, by role, as a fraction of its value.
pub const ACCESS: [f32; 3] = [0.35, 0.6, 1.0];
/// Hurricane as red, Seal of Destruction as blue (the article's mechanism
/// arguments; the colour-split fit found no significant asymmetry, so small).
pub const COLOUR_BONUS: f32 = 0.3;
/// Push leverage of a movement charm in a shared zone.
pub const PUSH: f32 = 0.4;
/// Red's head start when blue contests the SAME sigil, by role: red placed
/// first, so in a race to charge a sorcery red is a stone ahead. A ritual
/// contest costs nothing (designer, 2026-09-30): one stone matters less in a
/// five-node race and the blocker denies the cast, so blue mirrors a strong
/// ritual whenever every other reply leaves red ahead. (Charms cannot be shared.)
pub const SAME_SIGIL_TEMPO: [f32; 3] = [0.0, 0.5, 0.0];
/// The pre-2026-09-30 flat head start, used when `set_opening_contest(false)`.
pub const SAME_SIGIL_TEMPO_V17: f32 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OpeningPick {
    /// Sigil slot 0..8 (identity with topology position).
    pub pos: usize,
    pub spell: u8,
    /// The chosen sigil's EMPTY nodes: the root candidates for the search.
    pub node_mask: u64,
    /// Red-POV value at the minimax point.
    pub value: f32,
    /// Red: the blue reply that minimised; blue: red's spell being answered.
    pub reply: Option<u8>,
    /// Bit `p` set: slot `p` was dropped by the `++` veto or the Syzygy veto.
    pub vetoed: u16,
    /// The pick is Syzygy forced by an enemy stone on an exposed opposite slot.
    pub syzygy_threat: bool,
}

#[inline] pub fn zone(pos: usize) -> usize { pos % 3 }
#[inline] pub fn role(pos: usize) -> usize { pos / 3 }

fn colour_bonus(spell: u8, side: Color) -> f32 {
    match (spell, side) {
        (HURRICANE, Color::Red) | (SEAL_OF_DESTRUCTION, Color::Blue) => COLOUR_BONUS,
        _ => 0.0,
    }
}

/// What starting on slot `x` is worth to `side`, given the enemy starts on
/// `enemy` (a slot, or none yet). For blue, red's Syzygy threat is read from
/// red's slot; `own_value_ctx` takes it from red's actual stone.
pub fn own_value(spells: &[u8; 9], x: usize, enemy: Option<usize>, side: Color) -> f32 {
    let threat = match (side, enemy) { (Color::Blue, Some(s)) => SyzygyThreat::of_slot(spells, s), _ => SyzygyThreat::default() };
    own_value_ctx(spells, x, enemy, side, threat)
}

/// `own_value` with red's Syzygy threat given (it only affects blue).
pub fn own_value_ctx(spells: &[u8; 9], x: usize, enemy: Option<usize>, side: Color, threat: SyzygyThreat) -> f32 {
    let sx = spells[x] as usize;
    let mut strength = STRENGTH[sx];
    // Red's Syzygy is worth the greater of itself and the 3-node spell across
    // from it: casting it plays into that sigil, so it effectively grants it.
    if opening_syzygy_enabled() && side == Color::Red && spells[x] == SYZYGY {
        if let Some((_, sorcery)) = syzygy_opposite(x) {
            strength = strength.max(STRENGTH[spells[sorcery] as usize]);
        }
    }
    // Blue's start across from a Syzygy red is in or next to is worth no more
    // than Syzygy itself.
    if side == Color::Blue && threat.exposes(spells, x) {
        strength = strength.min(STRENGTH[SYZYGY as usize]);
    }
    // Carnage, either side: its hard moves reach the sorceries on both sides.
    if opening_carnage_enabled() && spells[x] == CARNAGE && role(x) == 0 {
        let (own, prev) = (3 + zone(x), 3 + (zone(x) + 2) % 3);
        strength = strength.max(STRENGTH[spells[own] as usize]).max(STRENGTH[spells[prev] as usize])
            + NEIGHBOUR_EDGE;
    }
    let mut v = strength + W_BOARD_PREF * BOARD_PREF[sx] as f32 + TEMPO[role(x)]
              + colour_bonus(spells[x], side);
    for m in 0..9 {
        if m == x || zone(m) != zone(x) || Some(m) == enemy { continue; }
        let sm = spells[m] as usize;
        v += ACCESS[role(m)] * (W_SYNERGY_PIP * SYNERGY[sx][sm] as f32 + W_MATE_STRENGTH * STRENGTH[sm]);
    }
    v
}

/// The node of 3/5-node sigil `slot` on the side of charm slot `charm_slot`:
/// touching it (a4, a8 for charm a7), or for the previous corner's charm, one
/// void node away (a5 -- a12 -- c7). `None` if neither.
pub fn side_node(slot: usize, charm_slot: usize) -> Option<u8> {
    if role(slot) == 2 { return None; }
    let charm = SIGIL[charm_slot].trailing_zeros() as usize;
    let mut m = ADJ[charm] & SIGIL[slot];
    if m == 0 {
        let mut v = ADJ[charm] & VOID;
        while v != 0 { let i = v.trailing_zeros() as usize; v &= v - 1; m |= ADJ[i] & SIGIL[slot]; }
    }
    (m != 0).then(|| m.trailing_zeros() as u8)
}

/// The charms on either side of 3/5-node sigil `slot`: its own corner's, and
/// for a ritual the previous corner's (through the void node).
fn side_charms(slot: usize) -> ([usize; 2], usize) {
    if role(slot) == 0 { ([6 + zone(slot), 6 + (zone(slot) + 2) % 3], 2) } else { ([6 + zone(slot), 0], 1) }
}

/// The node a contested `slot`'s push charm is behind, if exactly one of the
/// charms beside it is a push charm (Slash, Charge): holding it means a push
/// drops you onto the charm. Two push charms cancel; none, no credit.
pub fn behind_node(spells: &[u8; 9], slot: usize) -> Option<u8> {
    if role(slot) == 2 { return None; }
    let (cs, k) = side_charms(slot);
    let push: Vec<usize> = cs[..k].iter().copied().filter(|&c| PUSH_CHARMS.contains(&spells[c])).collect();
    if push.len() != 1 { return None; }
    side_node(slot, push[0])
}

/// Does the corner of `slot` hold a push charm (Slash, Charge)?
fn push_corner(spells: &[u8; 9], slot: usize) -> bool { PUSH_CHARMS.contains(&spells[6 + zone(slot)]) }

/// Push leverage in a shared zone, red POV. `red_behind`: in a same-sigil
/// contest, red's stone is on the node the charm is behind.
fn push_term(spells: &[u8; 9], s: usize, t: usize, red_behind: bool) -> f32 {
    if s == t && opening_contest_enabled() {
        // Same-sigil contest: credit the side holding the node a push charm is behind.
        return match behind_node(spells, s) { None => 0.0, Some(_) => if red_behind { PUSH } else { -PUSH } };
    }
    if zone(s) != zone(t) || !push_corner(spells, s) { return 0.0; }
    if t == 6 + zone(s) { -PUSH }            // blue holds it
    else { PUSH }                            // red holds it, or takes it first (turn 3)
}

/// V(s, t): red opens on slot `s`, blue answers on slot `t`. Red POV.
/// `red_behind` only matters when `s == t` (see `push_term`).
pub fn pair_value(spells: &[u8; 9], s: usize, t: usize, red_behind: bool) -> f32 {
    pair_value_ctx(spells, s, t, red_behind, SyzygyThreat::of_slot(spells, s))
}

/// `pair_value` with red's Syzygy threat given.
pub fn pair_value_ctx(spells: &[u8; 9], s: usize, t: usize, red_behind: bool, threat: SyzygyThreat) -> f32 {
    let (ss, st) = (spells[s] as usize, spells[t] as usize);
    let tempo = if s != t { 0.0 }
        else if opening_contest_enabled() { SAME_SIGIL_TEMPO[role(s)] } else { SAME_SIGIL_TEMPO_V17 };
    own_value(spells, s, Some(t), Color::Red) - own_value_ctx(spells, t, Some(s), Color::Blue, threat)
        + W_MATCHUP_PIP * MATCHUP[ss][st] as f32
        + push_term(spells, s, t, red_behind)
        + tempo
}

/// Root nodes for a pick on `slot`: the behind node when the contest rules
/// want it (and it is empty), otherwise every empty node of the sigil.
fn pick_mask(b: &Board, spells: &[u8; 9], slot: usize, want_behind: bool) -> u64 {
    let all = SIGIL[slot] & b.empty();
    if want_behind && opening_contest_enabled() {
        if let Some(n) = behind_node(spells, slot) {
            if all & (1u64 << n) != 0 { return 1u64 << n; }
        }
    }
    all
}

/// Slots blue can still answer on given red's stone: every slot with an
/// empty node (a charm node red took is gone; a 3/5-node sigil red started
/// can be contested).
fn open_slots(b: &Board) -> Vec<usize> {
    (0..9).filter(|&p| SIGIL[p] & b.empty() != 0).collect()
}

/// Red's `++` veto: slot `s` has some other drawn spell favoured `++` against it.
fn hard_countered(spells: &[u8; 9], s: usize, candidates: &[usize]) -> bool {
    candidates.iter().any(|&t| t != s && MATCHUP[spells[t] as usize][spells[s] as usize] >= 2)
}

/// Does the selector apply here: the competitive free-placement turn, the
/// mover has no stone yet, the enemy at most one, an official draw.
pub fn applies(b: &Board, c: Color) -> bool {
    b.variant.has_competitive() && b.turn_counter <= 2 && b.outcome == Outcome::Ongoing
        && b.mine(c) == 0 && b.theirs(c).count_ones() <= 1
        && b.spells.iter().all(|&id| (id as usize) < CORE_SPELL_COUNT)
}

/// The pick for `c`, or `None` when the selector does not apply.
pub fn choose_opening(b: &Board, c: Color) -> Option<OpeningPick> {
    if !applies(b, c) { return None; }
    let spells = &b.spells;
    let slots = open_slots(b);
    let better = |a: (f32, usize), z: (f32, usize)| -> bool {
        // higher value, then stronger spell, then lower id -- never the slot
        let (va, pa) = a; let (vz, pz) = z;
        if (va - vz).abs() > 1e-6 { return va > vz; }
        let (sa, sz) = (spells[pa] as usize, spells[pz] as usize);
        if (STRENGTH[sa] - STRENGTH[sz]).abs() > 1e-6 { return STRENGTH[sa] > STRENGTH[sz]; }
        sa < sz
    };
    if c == Color::Red {
        // Red's candidates: every slot; drop the hard-countered ones.
        let mut vetoed = 0u16;
        for &s in &slots {
            if hard_countered(spells, s, &slots) || (opening_syzygy_enabled() && syzygy_targets(spells, s)) {
                vetoed |= 1 << s;
            }
        }
        let cands: Vec<usize> = slots.iter().copied().filter(|&s| vetoed & (1 << s) == 0).collect();
        let cands = if cands.is_empty() { vetoed = 0; slots.clone() } else { cands };
        let mut best: Option<(f32, usize, usize)> = None;   // (worst-case value, slot, minimising reply)
        for &s in &cands {
            // Blue may answer anywhere with an empty node, including red's sigil
            // when it has more than one node (a contest); a charm cannot be shared.
            let mut worst: Option<(f32, usize)> = None;
            for &t in &slots {
                if t == s && SIGIL[s].count_ones() == 1 { continue; }
                let v = pair_value(spells, s, t, true);   // red moves first: it takes the behind node
                if worst.map_or(true, |(w, _)| v < w) { worst = Some((v, t)); }
            }
            let (w, t) = worst?;
            if best.map_or(true, |(bv, bs, _)| better((w, s), (bv, bs))) { best = Some((w, s, t)); }
        }
        let (value, pos, reply) = best?;
        Some(OpeningPick { pos, spell: spells[pos], node_mask: pick_mask(b, spells, pos, true), value,
                           reply: Some(spells[reply]), vetoed, syzygy_threat: false })
    } else {
        let red = b.theirs(c);
        let s_red = (0..9).find(|&p| SIGIL[p] & red != 0);
        let syz = opening_syzygy_enabled();
        let threat = SyzygyThreat::of_stones(spells, red);
        let Some(s) = s_red else {
            // Red opened on a mana or void node: no matchup to answer, take the
            // best sigil on its own merits (not an exposed one if red is next to Syzygy).
            let mut vetoed = 0u16;
            for &t in &slots { if threat.exposes(spells, t) { vetoed |= 1 << t; } }
            let cands: Vec<usize> = slots.iter().copied().filter(|&t| vetoed & (1 << t) == 0).collect();
            let cands = if cands.is_empty() { vetoed = 0; slots.clone() } else { cands };
            let mut best: Option<(f32, usize)> = None;
            for &t in &cands {
                let v = own_value_ctx(spells, t, None, Color::Blue, threat);
                if best.map_or(true, |bt| better((v, t), bt)) { best = Some((v, t)); }
            }
            let (value, pos) = best?;
            return Some(OpeningPick { pos, spell: spells[pos], node_mask: SIGIL[pos] & b.empty(), value,
                                      reply: None, vetoed, syzygy_threat: false });
        };
        // Red started on a slot Syzygy crushes: take Syzygy, whatever the
        // tables say about it in general. If only Seal of Winter makes red's
        // charm a target, start on the Syzygy node next to the seal.
        if syz && syzygy_targets(spells, s) {
            if let Some(z) = syzygy_slot(spells) {
                let free = SIGIL[z] & b.empty();
                if free != 0 {
                    let mut mask = free;
                    if !syzygy_exposed(spells, s, false) {
                        let a = winter_slot(spells).expect("Winter-exposed implies the seal");
                        let by_seal = free & neighbours(SIGIL[a]);
                        if by_seal != 0 { mask = by_seal; }
                    }
                    return Some(OpeningPick { pos: z, spell: SYZYGY, node_mask: mask,
                                              value: pair_value(spells, s, z, false), reply: Some(spells[s]),
                                              vetoed: 0, syzygy_threat: true });
                }
            }
        }
        let mut vetoed = 0u16;
        for &t in &slots {
            if (t != s && MATCHUP[spells[s] as usize][spells[t] as usize] >= 2) || threat.exposes(spells, t) {
                vetoed |= 1 << t;
            }
        }
        let cands: Vec<usize> = slots.iter().copied().filter(|&t| vetoed & (1 << t) == 0).collect();
        let cands = if cands.is_empty() { vetoed = 0; slots.clone() } else { cands };
        // A `++` counter to red's spell is THE answer (designer: "if red picked
        // Blossom, blue should counter with Hail Storm or Decay"), the mirror of
        // red's veto. Needed since a free ritual contest would otherwise tie it.
        let counters: Vec<usize> = cands.iter().copied()
            .filter(|&t| t != s && MATCHUP[spells[t] as usize][spells[s] as usize] >= 2).collect();
        let cands = if opening_contest_enabled() && !counters.is_empty() { counters } else { cands };
        // Blue minimises red's value: compare on -V so the tie-breaks favour blue's stronger spell.
        let red_behind = behind_node(spells, s).map_or(false, |n| red & (1u64 << n) != 0);
        let mut best: Option<(f32, usize)> = None;
        for &t in &cands {
            if t == s && SIGIL[s].count_ones() == 1 { continue; }
            let v = -pair_value_ctx(spells, s, t, red_behind, threat);
            if best.map_or(true, |bt| better((v, t), bt)) { best = Some((v, t)); }
        }
        let (neg, pos) = best?;
        Some(OpeningPick { pos, spell: spells[pos], node_mask: pick_mask(b, spells, pos, pos == s && !red_behind), value: -neg,
                           reply: Some(spells[s]), vetoed, syzygy_threat: false })
    }
}

/// One line for the think report / JSON: `opening: Fireblast (b8) -- worst case Hail_Storm`.
pub fn report_line(p: &OpeningPick, node: u8) -> String {
    let name = SPELLS[p.spell as usize].name;
    let node_name = crate::topology::NAMES[node as usize];
    match p.reply {
        Some(r) if p.syzygy_threat => format!("opening: {} ({}) -- crushes the {} start", name, node_name, SPELLS[r as usize].name),
        Some(r) => format!("opening: {} ({}) -- worst case {}", name, node_name, SPELLS[r as usize].name),
        None => format!("opening: {} ({})", name, node_name),
    }
}
