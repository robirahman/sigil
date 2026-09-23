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
//!   Contesting the very same sigil is allowed too (no penalty), but red is a
//!   stone ahead in that race, so it carries a tempo term for red.
//!
//! A hard veto mirrors the designer's absolute phrasing ("never start on
//! Blossom if Hail Storm is available"): a spell with a `++` counter in the
//! draw is dropped, unless that drops everything. Ties break on strength then
//! spell id, never on slot, so the choice is zone-invariant.
//!
//! **Syzygy (designer's rule, 2026-09-23).** Casting Syzygy blinks into the
//! opposite 1-node sigil and then into the opposite 3-node sigil
//! (`resolvers::syzygy_opposite`), pushing or crushing whatever stands there,
//! so a stone started in either is a target the moment the ritual charges.
//! Three consequences, switchable together with `set_opening_syzygy`:
//!
//! * never start on the 3-node spell opposite Syzygy, nor on the 1-node spell
//!   opposite it unless that charm's cast moves the stone away before the
//!   ritual can fire (`SYZYGY_SAFE_CHARMS`: Sprout, Splash, Charge);
//! * when the enemy has started on one of those exposed slots, take Syzygy,
//!   whatever the Bradley-Terry tables say (`OpeningPick::syzygy_threat`);
//! * for blue, Syzygy is worth the strongest of itself and the two spells
//!   across from it, because casting it effectively grants those spells.

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
use crate::opening_data::{BOARD_PREF, MATCHUP, PUSH_CHARMS, STRENGTH, SYNERGY};
use crate::spells_meta::{CHARGE, HURRICANE, NUM_OFFICIAL_SPELLS, SEAL_OF_DESTRUCTION, SPELLS, SPLASH, SPROUT, SYZYGY};
use crate::topology::SIGIL;
use crate::resolvers::syzygy_opposite;

/// Charms whose cast moves the stone off the charm node before Syzygy can
/// crush it (designer's list, 2026-09-23): a stone started on any other
/// 1-node sigil opposite Syzygy can only leave by dashing.
pub const SYZYGY_SAFE_CHARMS: [u8; 3] = [SPROUT, SPLASH, CHARGE];

/// The ritual slot Syzygy was drawn in, if any (it does nothing elsewhere).
pub fn syzygy_slot(spells: &[u8; 9]) -> Option<usize> {
    (0..3).find(|&p| spells[p] == SYZYGY && syzygy_opposite(p).is_some())
}

/// Is a stone started on `slot` a Syzygy target: the 3-node sigil opposite
/// it, or the 1-node sigil opposite it when that charm cannot move its stone
/// away.
pub fn syzygy_exposed(spells: &[u8; 9], slot: usize) -> bool {
    let Some(z) = syzygy_slot(spells) else { return false };
    let Some((charm, sorcery)) = syzygy_opposite(z) else { return false };
    slot == sorcery || (slot == charm && !SYZYGY_SAFE_CHARMS.contains(&spells[charm]))
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
/// Red's head start when blue contests the SAME sigil: red placed first, so
/// in a race to charge it red is a stone ahead. Without this V(s, s) is
/// exactly 0 and blue's best reply to any strong pick is to mirror it.
pub const SAME_SIGIL_TEMPO: f32 = 0.5;

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
/// `enemy` (a slot, or none yet).
pub fn own_value(spells: &[u8; 9], x: usize, enemy: Option<usize>, side: Color) -> f32 {
    let sx = spells[x] as usize;
    let mut strength = STRENGTH[sx];
    // Blue's Syzygy is worth the best of itself and the two spells across from
    // it: casting it plays into their sigils, so it effectively grants them.
    if opening_syzygy_enabled() && side == Color::Blue && spells[x] == SYZYGY {
        if let Some((charm, sorcery)) = syzygy_opposite(x) {
            strength = strength.max(STRENGTH[spells[charm] as usize]).max(STRENGTH[spells[sorcery] as usize]);
        }
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

/// Push leverage in a shared zone, red POV.
fn push_term(spells: &[u8; 9], s: usize, t: usize) -> f32 {
    if zone(s) != zone(t) { return 0.0; }
    let charm_slot = 6 + zone(s);
    let charm = spells[charm_slot];
    if !PUSH_CHARMS.contains(&charm) { return 0.0; }
    if t == charm_slot { -PUSH }            // blue holds it
    else { PUSH }                            // red holds it, or takes it first (turn 3)
}

/// V(s, t): red opens on slot `s`, blue answers on slot `t`. Red POV.
pub fn pair_value(spells: &[u8; 9], s: usize, t: usize) -> f32 {
    let (ss, st) = (spells[s] as usize, spells[t] as usize);
    own_value(spells, s, Some(t), Color::Red) - own_value(spells, t, Some(s), Color::Blue)
        + W_MATCHUP_PIP * MATCHUP[ss][st] as f32
        + push_term(spells, s, t)
        + if s == t { SAME_SIGIL_TEMPO } else { 0.0 }
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
        && b.spells.iter().all(|&id| (id as usize) < NUM_OFFICIAL_SPELLS)
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
            if hard_countered(spells, s, &slots) || (opening_syzygy_enabled() && syzygy_exposed(spells, s)) {
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
                let v = pair_value(spells, s, t);
                if worst.map_or(true, |(w, _)| v < w) { worst = Some((v, t)); }
            }
            let (w, t) = worst?;
            if best.map_or(true, |(bv, bs, _)| better((w, s), (bv, bs))) { best = Some((w, s, t)); }
        }
        let (value, pos, reply) = best?;
        Some(OpeningPick { pos, spell: spells[pos], node_mask: SIGIL[pos] & b.empty(), value,
                           reply: Some(spells[reply]), vetoed, syzygy_threat: false })
    } else {
        let red = b.theirs(c);
        let s_red = (0..9).find(|&p| SIGIL[p] & red != 0);
        let syz = opening_syzygy_enabled();
        let Some(s) = s_red else {
            // Red opened on a mana or void node: no matchup to answer, take the
            // best sigil on its own merits (never an exposed one).
            let mut vetoed = 0u16;
            for &t in &slots { if syz && syzygy_exposed(spells, t) { vetoed |= 1 << t; } }
            let cands: Vec<usize> = slots.iter().copied().filter(|&t| vetoed & (1 << t) == 0).collect();
            let cands = if cands.is_empty() { vetoed = 0; slots.clone() } else { cands };
            let mut best: Option<(f32, usize)> = None;
            for &t in &cands {
                let v = own_value(spells, t, None, Color::Blue);
                if best.map_or(true, |bt| better((v, t), bt)) { best = Some((v, t)); }
            }
            let (value, pos) = best?;
            return Some(OpeningPick { pos, spell: spells[pos], node_mask: SIGIL[pos] & b.empty(), value,
                                      reply: None, vetoed, syzygy_threat: false });
        };
        // Red started on a slot Syzygy crushes: take Syzygy, whatever the
        // tables say about it in general.
        if syz && syzygy_exposed(spells, s) {
            if let Some(z) = syzygy_slot(spells) {
                if SIGIL[z] & b.empty() != 0 {
                    return Some(OpeningPick { pos: z, spell: SYZYGY, node_mask: SIGIL[z] & b.empty(),
                                              value: pair_value(spells, s, z), reply: Some(spells[s]),
                                              vetoed: 0, syzygy_threat: true });
                }
            }
        }
        let mut vetoed = 0u16;
        for &t in &slots {
            if (t != s && MATCHUP[spells[s] as usize][spells[t] as usize] >= 2) || (syz && syzygy_exposed(spells, t)) {
                vetoed |= 1 << t;
            }
        }
        let cands: Vec<usize> = slots.iter().copied().filter(|&t| vetoed & (1 << t) == 0).collect();
        let cands = if cands.is_empty() { vetoed = 0; slots.clone() } else { cands };
        // Blue minimises red's value: compare on -V so the tie-breaks favour blue's stronger spell.
        let mut best: Option<(f32, usize)> = None;
        for &t in &cands {
            if t == s && SIGIL[s].count_ones() == 1 { continue; }
            let v = -pair_value(spells, s, t);
            if best.map_or(true, |bt| better((v, t), bt)) { best = Some((v, t)); }
        }
        let (neg, pos) = best?;
        Some(OpeningPick { pos, spell: spells[pos], node_mask: SIGIL[pos] & b.empty(), value: -neg,
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
