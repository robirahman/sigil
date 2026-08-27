//! Evaluation.
//!
//! WHY NOT PURE MATERIAL. `ai/ARENA_POSITIONAL_WEIGHTS.md` reports that no
//! positional weight set beat the pure stone-count baseline, and concludes the
//! deep material search already prices those terms in. Measured here, the real
//! reason is different and more damning: **every move PLACES a stone**, so the
//! stone differential oscillates 1,0,1,0,... and is pinned near zero except when a
//! crush or a destructive spell fires. Instrumented over a full game the sequence
//! was literally [1,0,1,0,1,0,...,2,1,2,1]. A material eval is therefore almost
//! CONSTANT, the search has no gradient to follow, and depth buys nothing — which
//! is exactly what we measured: 20x thinking time was worth only ~57%.
//!
//! So the terms below are not "positional weights" in the sense that campaign
//! tested. They measure progress toward the three win conditions:
//!   * distance to the +-3 lead (asymmetric: red needs 4 real stones, blue 2)
//!   * whose stones are in danger of being crushed (liberty pressure)
//!   * how close each side is to charging and casting (sigil fill, mana tempo)
//!   * the sixth-spell trigger, which is a liability when you are behind
//!
//! Weights are in centistones (100 = one stone) and deliberately tunable, so this
//! can be arena-gated against material-only the way the original campaign was.
//!
//! ## THE TEMPO TERM, and why it is not optional
//!
//! Every move PLACES a stone, so the side that has just moved is always exactly one
//! stone up on that account alone. Measured directly (root score at fixed search
//! depth, material eval, three real midgame positions):
//!
//! ```text
//!     seed      d1     d2     d3     d4     d5     d6     d7     d8
//!       11     100      0    100      0    100      0    100      0
//!       19       0   -100      0   -100      0   -100      0   -100
//!       27       0   -100    100      0    100      0    100      0
//! ```
//!
//! A pure square wave of exactly ONE STONE per ply, with no convergence. Blue wins
//! on a real lead of 2, so the search's answer was dominated by whose turn it
//! happened to be at the horizon rather than by the position. That is the whole
//! explanation for "20x thinking time is worth only ~57.5%": extra depth cannot
//! express a better judgement when the returned score is a parity bit.
//!
//! The correction is exact to first order and follows from the measurement: the
//! side that has just placed looks +1, so the side TO MOVE is half a stone below
//! the mean. `tempo = 50` centistones for the side to move flattens both phases of
//! the wave onto their average. It is only first-order because a dash places one
//! stone while sacrificing two, and a cast places and removes a variable number --
//! but the wave is exactly 100 everywhere, so the first-order term dominates.
//!
//! Anchored to `self.to_move`, NOT to the POV argument, so it stays correct when
//! `evaluate` is called for a side that is not the side to move.

use crate::board::{Board, Color};
use crate::topology::{ADJ, MANA, SIGIL};

#[derive(Clone, Copy, Debug)]
pub struct Weights {
    pub lead: i32,
    pub near_threshold: i32,
    pub own_zero_liberty: i32,
    pub own_one_liberty: i32,
    pub enemy_zero_liberty: i32,
    pub enemy_one_liberty: i32,
    pub sigil_stone: i32,
    pub sigil_charged: i32,
    pub mana: i32,
    pub sixth_spell_danger: i32,
    /// Per node the side to move is STRICTLY closer to (multi-source BFS).
    pub control: i32,
    /// Penalty per net own stone sitting on a VOID node (they charge nothing).
    pub void_penalty: i32,
    /// Centistones credited to the SIDE TO MOVE, cancelling the one-stone-per-ply
    /// square wave that "every move places a stone" produces. See the module docs;
    /// 50 is the derived value, 0 reproduces the old behaviour for A/B.
    pub tempo: i32,
}

impl Default for Weights {
    fn default() -> Self {
        Weights {
            lead: 100,
            near_threshold: 150,
            own_zero_liberty: -70,
            own_one_liberty: -20,
            enemy_zero_liberty: 70,
            enemy_one_liberty: 20,
            sigil_stone: 14,
            sigil_charged: 80,
            mana: 40,
            sixth_spell_danger: -130,
            control: 0,
            void_penalty: 0,
            tempo: 50,
        }
    }
}

/// Robi's classic positional recipe, at the scale he actually used: material plus
/// a small mana bonus (+0.3 stones per net mana node) and a small influence term
/// (+0.05 stones per node you are strictly closer to). Previously this cost more
/// in depth than it gained on the Python/JS engines; the point of the Rust port is
/// that the depth is now cheap enough to retest it.
pub const CLASSIC: Weights = Weights {
    lead: 100, near_threshold: 0,
    own_zero_liberty: 0, own_one_liberty: 0,
    enemy_zero_liberty: 0, enemy_one_liberty: 0,
    sigil_stone: 0, sigil_charged: 0,
    mana: 30, sixth_spell_danger: 0, control: 5, void_penalty: 0, tempo: 50,
};

/// Mana term only, to separate the two contributions.
pub const MANA_ONLY: Weights = Weights { control: 0, ..CLASSIC };
/// Influence term only.
pub const CONTROL_ONLY: Weights = Weights { mana: 0, ..CLASSIC };

/// Material only — the shipped engine's eval, kept for A/B testing.
pub const MATERIAL_ONLY: Weights = Weights {
    lead: 100, near_threshold: 0,
    own_zero_liberty: 0, own_one_liberty: 0,
    enemy_zero_liberty: 0, enemy_one_liberty: 0,
    sigil_stone: 0, sigil_charged: 0, mana: 0, sixth_spell_danger: 0, control: 0,
    void_penalty: 0, tempo: 0,
};

/// Material only PLUS the tempo correction: the minimal change that removes the
/// one-stone-per-ply square wave, and the first thing to gate.
pub const MATERIAL_TEMPO: Weights = Weights { tempo: 50, ..MATERIAL_ONLY };


// ===================== caveman-faithful positional eval =====================
//
// `docs/static/scripts/engine/caveman-ai.js` computes
//     score = stoneDiff + mana*manaDiff - voidPenalty*voidDiff + mapControl*mcDiff
// in STONE units, and — crucially — caps the positional part strictly below one
// stone via `cavemanCapWeights`:
//     3*mana + 9*voidPenalty + 39*mapControl <= 0.96
// so that "position only ever breaks material ties, never outbids a stone".
//
// That cap is the discipline my first attempt violated. Uncapped variants lost
// heavily in a colour-swapped 80-game arena: my structural set 22.5%, and Robi's
// classic scale (mana 0.3 + control 0.05, worst case 0.9 + 1.95 = 2.85 stones)
// 17.5%. With 39 nodes, an 0.05/node influence term can outbid nearly two stones.
//
// The 2026-08-02 campaign (ai/ARENA_POSITIONAL_WEIGHTS.md) tested the CAPPED
// versions at ~depth 4 and found none beat baseline: capped map-control tiebreaker
// 47.0% (p=.40), full-scale prior-informed 37.0% (p=.0002), mana+void 44.5%
// (p=.12). Robi's hypothesis is that the verdict may change now depth is cheap —
// which is a question about the DEPTH INTERACTION, so it must be tested at matched
// time AND at higher depth.

/// Positional budget in centistones, strictly sub-material.
pub const POSITIONAL_BUDGET: i32 = 96;

/// Uniformly scale a positional weight set so the worst case fits the budget,
/// mirroring `cavemanCapWeights`. Weights are centistones.
pub const fn cap(mana: i32, void_penalty: i32, map_control: i32) -> Weights {
    let worst = 3 * mana + 9 * void_penalty + 39 * map_control;
    let (m, v, c) = if worst <= POSITIONAL_BUDGET || worst == 0 {
        (mana, void_penalty, map_control)
    } else {
        (mana * POSITIONAL_BUDGET / worst,
         void_penalty * POSITIONAL_BUDGET / worst,
         map_control * POSITIONAL_BUDGET / worst)
    };
    Weights {
        lead: 100, near_threshold: 0,
        own_zero_liberty: 0, own_one_liberty: 0,
        enemy_zero_liberty: 0, enemy_one_liberty: 0,
        sigil_stone: 0, sigil_charged: 0,
        mana: m, sixth_spell_danger: 0, control: c, void_penalty: v, tempo: 50,
    }
}

/// The whole budget on map control: 96/39 = 2 centistones per node, matching the
/// `caveman:mc=0.0246` arm from the committed arena runs.
pub const CAPPED_MC: Weights = cap(0, 0, POSITIONAL_BUDGET / 39);
/// Mana + void only, the campaign's third arm.
pub const CAPPED_MANAVOID: Weights = cap(30, 6, 0);
/// A three-way split of the same budget.
pub const CAPPED_MIX: Weights = cap(16, 3, 1);

impl Board {
    /// Liberty census: (stones with 0 empty neighbours, stones with exactly 1).
    /// A cheap stand-in for crushability — a full `escape_distance` per stone would
    /// be several BFS traversals per leaf, which the search cannot afford.
    /// Public alias so `features.rs` can build the same vector the weights index.
    #[inline]
    pub fn liberty_census_pub(&self, c: Color) -> (i32, i32) { self.liberty_census(c) }

    #[inline]
    fn liberty_census(&self, c: Color) -> (i32, i32) {
        let empty = self.empty();
        let mut zero = 0i32;
        let mut one = 0i32;
        let mut m = self.mine(c);
        while m != 0 {
            let i = m.trailing_zeros() as usize;
            m &= m - 1;
            match (ADJ[i] & empty).count_ones() {
                0 => zero += 1,
                1 => one += 1,
                _ => {}
            }
        }
        (zero, one)
    }

    /// Nodes `c` is STRICTLY closer to than the opponent, by multi-source BFS from
    /// each side's stones. This is the influence/territory notion Robi describes as
    /// "+0.05 for every node on the board that you are closer to than your
    /// opponent". Bitboard layer expansion, so it costs a handful of dilations on a
    /// 39-node graph rather than a per-node BFS.
    pub fn control_diff(&self, c: Color) -> i32 {
        let mut mine_acc = self.mine(c);
        let mut theirs_acc = self.theirs(c);
        if mine_acc == 0 && theirs_acc == 0 { return 0; }
        let mut closer_me = 0u64;
        let mut closer_them = 0u64;
        for _ in 0..12 {
            if (mine_acc | theirs_acc) == crate::topology::ALL { break; }
            let m_next = (mine_acc | Board::dilate(mine_acc)) & crate::topology::ALL;
            let t_next = (theirs_acc | Board::dilate(theirs_acc)) & crate::topology::ALL;
            let m_new = m_next & !mine_acc;
            let t_new = t_next & !theirs_acc;
            // Reached by me at this distance, and not by them now or earlier.
            closer_me |= m_new & !theirs_acc & !t_new;
            closer_them |= t_new & !mine_acc & !m_new;
            if m_next == mine_acc && t_next == theirs_acc { break; }
            mine_acc = m_next;
            theirs_acc = t_next;
        }
        closer_me.count_ones() as i32 - closer_them.count_ones() as i32
    }

    /// Score in centistones from `c`'s point of view.
    pub fn evaluate(&self, c: Color, w: &Weights) -> i32 {
        let red = self.total[0] as i32;
        let blue = self.total[1] as i32;
        // Signed lead in *score* terms, i.e. including blue's +1 counter token.
        let red_score_lead = red - (blue + 1);
        let mut v = w.lead * if c == Color::Red { red_score_lead } else { -red_score_lead };

        // Being one step from the winning margin is worth much more than linear.
        // Red wins at red-blue >= 4, blue at blue-red >= 2.
        if w.near_threshold != 0 {
            let (my_margin, their_margin) = if c == Color::Red {
                (4 - (red - blue), 2 - (blue - red))
            } else {
                (2 - (blue - red), 4 - (red - blue))
            };
            if my_margin <= 1 { v += w.near_threshold; }
            if their_margin <= 1 { v -= w.near_threshold; }
        }

        let (own0, own1) = self.liberty_census(c);
        let (en0, en1) = self.liberty_census(c.other());
        v += w.own_zero_liberty * own0 + w.own_one_liberty * own1;
        v += w.enemy_zero_liberty * en0 + w.enemy_one_liberty * en1;

        if w.sigil_stone != 0 || w.sigil_charged != 0 {
            // The FEATURE is summed first and the weight applied once, so that
            // `evaluate == dot(weights, hand_features)` holds exactly. Multiplying
            // per sigil and dividing afterwards truncated differently in the two
            // code paths, which the dot-product invariant test caught; a fitted
            // weight vector would otherwise have meant something subtly different
            // from what the search computes.
            let mut stone_feat = 0i32;
            let mut charged_feat = 0i32;
            for p in 0..9 {
                let m = SIGIL[p];
                let n = m.count_ones() as i32;
                let mine = (m & self.mine(c)).count_ones() as i32;
                let theirs = (m & self.theirs(c)).count_ones() as i32;
                // Quadratic-ish: filling the last node of a sigil is what pays.
                stone_feat += mine * mine / n.max(1) - theirs * theirs / n.max(1);
                if mine == n { charged_feat += 1; }
                if theirs == n { charged_feat -= 1; }
            }
            v += w.sigil_stone * stone_feat + w.sigil_charged * charged_feat;
        }

        v += w.mana * ((self.mine(c) & MANA).count_ones() as i32
                     - (self.theirs(c) & MANA).count_ones() as i32);

        if w.control != 0 { v += w.control * self.control_diff(c); }

        // Void stones charge nothing, so holding them is a liability.
        if w.void_penalty != 0 {
            let vd = (self.mine(c) & crate::topology::VOID).count_ones() as i32
                   - (self.theirs(c) & crate::topology::VOID).count_ones() as i32;
            v -= w.void_penalty * vd;
        }

        // The sixth cast ENDS the game and awards it on stone count, so a high
        // counter while behind is a liability: casting becomes self-destructive.
        if w.sixth_spell_danger != 0 {
            let my_sc = self.spell_counter[c.idx()] as i32;
            let their_sc = self.spell_counter[c.other().idx()] as i32;
            let my_lead = if c == Color::Red { red_score_lead } else { -red_score_lead };
            if my_sc >= 5 && my_lead < 0 { v += w.sixth_spell_danger; }
            if their_sc >= 5 && my_lead > 0 { v -= w.sixth_spell_danger; }
        }

        // Tempo: cancel the one-stone-per-ply parity wave. Anchored to the real
        // side to move rather than to `c`.
        if w.tempo != 0 {
            v += if self.to_move == c { w.tempo } else { -w.tempo };
        }
        v
    }
}
