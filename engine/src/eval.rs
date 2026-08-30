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
//!   * distance to the +-3 lead: SYMMETRIC in score (both need +3, blue's score
//!     includes its +1 token), which is red +4 / blue +2 in REAL stones
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
    /// Scale applied to the SUM of the positional terms, as `pos_num/pos_den`.
    ///
    /// WHY THE SUM AND NOT EACH WEIGHT. Scaling weights individually destroys the
    /// BALANCE between terms once they reach small integers: at 4% of the base set,
    /// `own_one_liberty` truncates from -0.8 to 0 while `near_threshold` keeps 6, so
    /// the ratio between them changes with the scale and each "scale point" is a
    /// DIFFERENT evaluation function. Scaling the accumulated sum keeps every ratio
    /// exact and costs one division per leaf.
    pub pos_num: i32,
    pub pos_den: i32,
    /// Centistones credited to the SIDE TO MOVE, cancelling the one-stone-per-ply
    /// square wave that "every move places a stone" produces. See the module docs;
    /// 50 is the derived value, 0 reproduces the old behaviour for A/B.
    pub tempo: i32,
}

impl Weights {
    /// `const` twin of `Default::default`, so const presets can build on it.
    /// `Default` delegates here, so the two cannot drift apart.
    pub const fn default_const() -> Weights {
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
            pos_num: 1,
            pos_den: 1,
            tempo: 50,
        }
    }
}

impl Default for Weights {
    fn default() -> Self { Weights::default_const() }
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
    mana: 30, sixth_spell_danger: 0, control: 5, void_penalty: 0,
    pos_num: 1, pos_den: 1, tempo: 50,
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
    void_penalty: 0, pos_num: 1, pos_den: 1, tempo: 0,
};

/// Material only PLUS the tempo correction: the minimal change that removes the
/// one-stone-per-ply square wave, and the first thing to gate.
pub const MATERIAL_TEMPO: Weights = Weights { tempo: 50, ..MATERIAL_ONLY };

/// The structural set with the tempo correction REMOVED, so an arena can isolate
/// what the correction is worth inside a rich eval. This is the configuration that
/// scored 22.5% against material-only; the open question is whether it lost because
/// its terms are wrong or because it was riding a one-stone-per-ply square wave
/// (its wave measured 152 centistones/ply, worse than material's 96).
pub const STRUCTURAL_NO_TEMPO: Weights = Weights { tempo: 0, ..Weights::default_const() };


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
        mana: m, sixth_spell_danger: 0, control: c, void_penalty: v,
        pos_num: 1, pos_den: 1, tempo: 50,
    }
}

/// Worst-case |positional contribution| of a weight set, in centistones, using the
/// maximum each feature can reach on a 39-node board. This is the quantity
/// `cavemanCapWeights` holds below one stone so that "position only ever breaks
/// material ties, never outbids a stone".
///
/// The structural default measures **2,578 centistones = 25.8 STONES**, i.e. 27x
/// the production budget, in a game where blue wins on a real lead of 2. That is
/// almost certainly why it scored 19.4% against material-only at matched time
/// (-247 Elo) while WINNING 63.2% at matched depth: the knowledge is good, but at
/// that scale it can outbid twelve wins' worth of material.
pub const fn worst_case_positional(w: &Weights) -> i32 {
    unscaled_worst_case(w) * w.pos_num / w.pos_den
}

/// The same total before `pos_num/pos_den` is applied.
pub const fn unscaled_worst_case(w: &Weights) -> i32 {
    // max |feature|: liberties ~6 stones apiece, sigil_stone sums mine^2/n over the
    // nine sigils (5+5+5+3+3+3+1+1+1 = 27), 9 sigils, 3 mana, 9 void, 39 nodes.
    abs_i32(w.near_threshold) * 1
        + abs_i32(w.own_zero_liberty) * 6 + abs_i32(w.own_one_liberty) * 6
        + abs_i32(w.enemy_zero_liberty) * 6 + abs_i32(w.enemy_one_liberty) * 6
        + abs_i32(w.sigil_stone) * 27 + abs_i32(w.sigil_charged) * 9
        + abs_i32(w.mana) * 3 + abs_i32(w.sixth_spell_danger) * 1
        + abs_i32(w.control) * 39 + abs_i32(w.void_penalty) * 9
}

const fn abs_i32(x: i32) -> i32 { if x < 0 { -x } else { x } }

/// The structural set with every positional term scaled by `num/den`, leaving
/// `lead` and `tempo` alone. The right scale is an empirical question, not a
/// principle: at full strength the set is 27x over budget and loses badly, while
/// scaling it all the way down to the 0.96-stone budget (~4%) may leave nothing.
/// So sweep it.
pub const fn scaled_structural(num: i32, den: i32) -> Weights {
    Weights { pos_num: num, pos_den: den, ..Weights::default_const() }
}

/// Rescale a weight set so its worst-case positional contribution lands on the
/// production budget, leaving `lead` and `tempo` alone. Self-adjusting, so a shape
/// can be edited without recomputing a scale by hand -- and it is the scale the
/// arena favoured: everything at or just inside the budget won, everything above
/// ~2x lost.
pub const fn at_budget(w: Weights) -> Weights {
    let worst = unscaled_worst_case(&w);
    if worst <= 0 { return w; }
    Weights { pos_num: POSITIONAL_BUDGET, pos_den: worst, ..w }
}


/// Sweep points. `s04` is roughly the production 0.96-stone budget; `s100` is the
/// current structural default. Measured at 300 ms, colour-swapped, vs material:
/// s04 +93, s12 +84, s25 +22, s50 -44, s100 -247 Elo -- a clean monotone curve with
/// the optimum at or BELOW 4%, which is to say right at the budget
/// `cavemanCapWeights` already enforced. So the finer points below extend the sweep
/// downward rather than upward.
/// ====================== SHAPE HYPOTHESES FROM THE TEXEL FIT =================
///
/// A logistic fit of game outcome on the 12 hand features, over 181k positions from
/// 7,283 self-play games, disagrees with the hand-chosen weights on FOUR SIGNS and
/// several magnitudes (centistones, normalised so lead = 100):
///
/// ```text
///   term                   fitted    hand
///   near_threshold          +56.2    +150
///   own_zero_liberty         +1.3     -70   sign differs
///   own_one_liberty         +15.0     -20   sign differs
///   enemy_zero_liberty       +2.5     +70
///   enemy_one_liberty       -17.0     +20   sign differs
///   sigil_stone             +35.6     +14
///   sigil_charged            +2.4     +80
///   mana                    +82.2     +40
///   sixth_spell_danger      +63.6    -130   sign differs
///   control                  +3.3      +0
///   void_penalty            -21.9      +0
/// ```
///
/// These are OBSERVATIONAL and confounded -- a winner tends to have spare stones,
/// which is why void stones "look good" and why a player who has cast five spells
/// looks like a winner rather than someone in danger from the sixth. So they are an
/// arena hypothesis, not a weight set. The three presets below let the arena decide
/// between the two SHAPES at the same budget, which is the only way to separate
/// "the hand weights were wrong" from "these features are useless".
pub const FIT_SHAPE: Weights = Weights {
    lead: 100, near_threshold: 56,
    own_zero_liberty: 1, own_one_liberty: 15,
    enemy_zero_liberty: 3, enemy_one_liberty: -17,
    sigil_stone: 36, sigil_charged: 2,
    mana: 82, sixth_spell_danger: 64,
    control: 3, void_penalty: -22,
    pos_num: 1, pos_den: 1, tempo: 50,
};

/// The hand shape with only the four disputed SIGNS flipped, magnitudes untouched.
/// Isolates the sign question from the magnitude question.
pub const FLIP_SHAPE: Weights = Weights {
    own_zero_liberty: 70, own_one_liberty: 20,
    enemy_one_liberty: -20, sixth_spell_danger: 130,
    ..Weights::default_const()
};

/// The three shapes, each rescaled to the production budget -- the scale the arena
/// favoured, since everything at or just inside it won and everything above ~2x lost.
pub const HAND_AT_BUDGET: Weights = at_budget(Weights::default_const());
pub const FIT_AT_BUDGET: Weights = at_budget(FIT_SHAPE);
pub const FLIP_AT_BUDGET: Weights = at_budget(FLIP_SHAPE);

pub const STRUCT_01: Weights = scaled_structural(1, 100);
pub const STRUCT_02: Weights = scaled_structural(2, 100);
pub const STRUCT_06: Weights = scaled_structural(6, 100);
pub const STRUCT_08: Weights = scaled_structural(8, 100);
pub const STRUCT_04: Weights = scaled_structural(4, 100);
pub const STRUCT_12: Weights = scaled_structural(12, 100);
pub const STRUCT_25: Weights = scaled_structural(25, 100);
pub const STRUCT_50: Weights = scaled_structural(50, 100);

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
    ///
    /// Three parts, kept separate on purpose: MATERIAL (`lead`), the POSITIONAL sum
    /// scaled by `pos_num/pos_den`, and the TEMPO offset. Only the middle one is
    /// scaled, so re-pricing position never re-prices the ruler it is measured
    /// against, and every ratio inside the positional part stays exact.
    ///
    /// Deliberately does NOT call `hand_features`, even though the two must agree
    /// exactly: this is the leaf path and has to stay lazy, while `hand_features`
    /// computes `control_diff` (a 12-layer flood fill) unconditionally. The
    /// duplication is safe only because
    /// `evaluate_is_exactly_the_dot_product_of_the_hand_features` fails the build
    /// when they drift -- which it has already caught once, on an integer
    /// truncation difference in the sigil term.
    pub fn evaluate(&self, c: Color, w: &Weights) -> i32 {
        let red = self.total[0] as i32;
        let blue = self.total[1] as i32;
        // Signed lead in *score* terms, i.e. including blue's +1 counter token.
        let red_score_lead = red - (blue + 1);
        let my_lead = if c == Color::Red { red_score_lead } else { -red_score_lead };

        // --- material, never scaled ---
        let mut mat = w.lead * my_lead;
        // --- positional, scaled as one sum ---
        let mut pos = 0i32;

        if w.near_threshold != 0 {
            // Red wins at red-blue >= 4, blue at blue-red >= 2.
            let (my_margin, their_margin) = if c == Color::Red {
                (4 - (red - blue), 2 - (blue - red))
            } else {
                (2 - (blue - red), 4 - (red - blue))
            };
            pos += w.near_threshold
                 * ((my_margin <= 1) as i32 - (their_margin <= 1) as i32);
        }

        if w.own_zero_liberty != 0 || w.own_one_liberty != 0
            || w.enemy_zero_liberty != 0 || w.enemy_one_liberty != 0 {
            let (own0, own1) = self.liberty_census(c);
            let (en0, en1) = self.liberty_census(c.other());
            pos += w.own_zero_liberty * own0 + w.own_one_liberty * own1;
            pos += w.enemy_zero_liberty * en0 + w.enemy_one_liberty * en1;
        }

        if w.sigil_stone != 0 || w.sigil_charged != 0 {
            // The FEATURE is summed first and the weight applied once, so that
            // `evaluate == dot(weights, hand_features)` holds exactly.
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
            pos += w.sigil_stone * stone_feat + w.sigil_charged * charged_feat;
        }

        if w.mana != 0 {
            pos += w.mana * ((self.mine(c) & MANA).count_ones() as i32
                           - (self.theirs(c) & MANA).count_ones() as i32);
        }

        if w.sixth_spell_danger != 0 {
            // The sixth cast ENDS the game and awards it on stone count, so a high
            // counter while behind is a liability: casting becomes self-destructive.
            let my_sc = self.spell_counter[c.idx()] as i32;
            let their_sc = self.spell_counter[c.other().idx()] as i32;
            pos += w.sixth_spell_danger
                 * (((my_sc >= 5 && my_lead < 0) as i32)
                    - ((their_sc >= 5 && my_lead > 0) as i32));
        }

        // Guarded: a 12-layer flood fill, and most presets set it to 0.
        if w.control != 0 { pos += w.control * self.control_diff(c); }

        if w.void_penalty != 0 {
            // Void stones charge nothing, so holding them is a liability. The sign
            // is folded into the FEATURE to match `hand_features`.
            let vd = (self.mine(c) & crate::topology::VOID).count_ones() as i32
                   - (self.theirs(c) & crate::topology::VOID).count_ones() as i32;
            pos += w.void_penalty * (-vd);
        }

        mat += pos * w.pos_num / w.pos_den;

        // Tempo: cancel the one-stone-per-ply parity wave. Anchored to the real
        // side to move rather than to `c`, and never scaled.
        if w.tempo != 0 {
            mat += if self.to_move == c { w.tempo } else { -w.tempo };
        }
        mat
    }
}

/// Every accepted preset name, in one place. Exported (via py.rs) as
/// `EVAL_NAMES` so callers (argparse `choices`, harnesses, docs) enumerate
/// rather than restate: a hardcoded copy in `serve.py` rejected `--eval s04`
/// outright, which is the fourth instance of the same "list written down
/// twice" failure in this codebase.
pub const EVAL_NAMES: [&str; 18] = [
    "default", "structural", "material", "mtempo", "snotempo",
    "s01", "s02", "s04", "s06", "s08", "s12", "s25", "s50", "manavoid", "mc",
    "hand", "tfit", "tflip",
];

/// Resolve an eval preset by name. **Deliberately errors on an unknown name.**
/// The old `_ => Weights::default()` arm meant a typo silently selected the
/// structural eval, which is the same failure shape as the `merge_min_width`
/// binding default that invalidated a 120-game campaign.
///
/// Lives here (not in py.rs) so BOTH front ends — the CPython module and the
/// wasm build — resolve presets through the one list. The wasm feature does not
/// compile py.rs at all, and a wasm entry point that could not resolve names
/// would fall back to `Weights::default()`, the exact trap this exists to close.
pub fn weights_by_name(name: &str) -> Result<Weights, String> {
    Ok(match name {
        "default" | "structural" => Weights::default(),
        "material" => MATERIAL_ONLY,
        "mtempo" => MATERIAL_TEMPO,
        "snotempo" => STRUCTURAL_NO_TEMPO,
        "hand" => HAND_AT_BUDGET,
        "tfit" => FIT_AT_BUDGET,
        "tflip" => FLIP_AT_BUDGET,
        "s01" => STRUCT_01,
        "s02" => STRUCT_02,
        "s04" => STRUCT_04,
        "s06" => STRUCT_06,
        "s08" => STRUCT_08,
        "s12" => STRUCT_12,
        "s25" => STRUCT_25,
        "s50" => STRUCT_50,
        "classic" => CLASSIC,
        "mana" => MANA_ONLY,
        "mix" => CAPPED_MIX,
        "control" => CONTROL_ONLY,
        "mc" => CAPPED_MC,
        "manavoid" => CAPPED_MANAVOID,
        other => return Err(format!(
            "unknown eval name {other:?}; expected one of default/structural, \
             material, mtempo, snotempo, s01, s02, s04, s06, s08, s12, s25, s50, classic, mana, mc, manavoid, mix, control")),
    })
}
