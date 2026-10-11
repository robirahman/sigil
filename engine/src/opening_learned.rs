//! Learned competitive-opening selector (2026-10, round 2; arena-gated, OFF by
//! default -- switch `set_opening_learned`).
//!
//! A linear score over a candidate sigil slot `s`, fitted by
//! `harness/fit_opening_selector.py` to `harness/opening_rollouts.py` labels
//! (every sigil choice played out by the shipped v25 engine):
//!
//!   score(s) = OWN[spell at s] + sum over zone-mates z of s of MATE[spell at z]
//!              (+ CONTEST, blue only, when s is red's sigil)
//!
//! Integer weights (x1000), so native and wasm agree by construction. Like the
//! hand-built selector it picks the SIGIL; the search picks the node inside it.

use crate::board::{Board, Color};
use crate::opening::applies;
use crate::topology::SIGIL;

pub use crate::opening_learned_weights::{LEARNED_BLUE, LEARNED_RED};

pub const NS: usize = 39;
pub const NF: usize = 2 * NS + 1;

thread_local! {
    static OPENING_LEARNED: std::cell::Cell<bool> = std::cell::Cell::new(false);
}
/// A/B switch for the learned selector (default off). When on it replaces the
/// hand-built selector's pick; per thread like `set_opening_book`.
pub fn set_opening_learned(on: bool) { OPENING_LEARNED.with(|c| c.set(on)); }
pub fn opening_learned_enabled() -> bool { OPENING_LEARNED.with(|c| c.get()) }

fn slot_of(stones: u64) -> Option<usize> {
    (0..9).find(|&p| SIGIL[p] & stones != 0)
}

/// The score of every slot that still has an empty node, for `c` to move.
pub fn slot_scores(b: &Board, c: Color) -> Vec<(usize, i32)> {
    let w: &[i32; NF] = if c == Color::Red { &LEARNED_RED } else { &LEARNED_BLUE };
    let red_slot = if c == Color::Blue { slot_of(b.theirs(c)) } else { None };
    (0..9).filter(|&s| SIGIL[s] & b.empty() != 0).map(|s| {
        let mut v = w[b.spells[s] as usize];
        for z in (0..9).filter(|&z| z % 3 == s % 3 && z != s) {
            v += w[NS + b.spells[z] as usize];
        }
        if red_slot == Some(s) { v += w[2 * NS]; }
        (s, v)
    }).collect()
}

/// The learned pick as a node mask (the slot's empty nodes), or None when the
/// selector does not apply. Ties go to the lower slot.
pub fn learned_mask(b: &Board, c: Color) -> Option<u64> {
    if !applies(b, c) { return None; }
    let best = slot_scores(b, c).into_iter().max_by_key(|&(s, v)| (v, std::cmp::Reverse(s)))?;
    Some(SIGIL[best.0] & b.empty())
}
