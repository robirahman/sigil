//! Learned move ordering: a linear re-ranker over candidate turns.
//!
//! Fitted as a conditional logit (softmax over one position's candidates, which is
//! the right likelihood for "which of these did the search choose") on 95,630
//! ranking instances from 2,175 self-play games, split by GAME.
//!
//! Coverage on held-out games -- the fraction of positions whose chosen turn falls
//! inside width k, the same currency the widening work is denominated in:
//!
//! ```text
//!   ranking                          w6      w12     w24     w40
//!   current order.rs               77.2%   85.8%   92.0%   96.3%
//!   this linear model              79.7%   88.4%   94.7%   98.1%
//!   GBM, 50 trees depth 4          80.1%   89.2%   95.1%   98.5%
//!   GBM, 300 trees, all features   82.2%   90.4%   95.6%   98.5%
//! ```
//!
//! WHY LINEAR. The gradient-boosted models are barely better and about a hundred
//! times dearer: 50 trees x depth 4 is ~200 comparisons per candidate, which at even
//! 24 candidates is ~5 us against a ~6.4 us node. A 15-term dot product is ~20 ns.
//! An earlier 12k-instance fit made the GBM look far stronger (97.8% at w24); that
//! gap was overfitting and it closed once the dataset grew 8x.
//!
//! CLOSED FORM ONLY. Every feature is computable from the turn and the CURRENT
//! board, with no board copy and no `apply_turn`. Scoring 24-64 candidates by
//! applying each would cost more than the search it is meant to help. Measured on
//! held-out data, dropping the three apply-dependent features (liberty deltas,
//! control delta) costs almost nothing: 97.0% vs 97.8% at w24 in the richer fit.
//!
//! Standardisation is folded into the weights, so no mean/scale table ships.
//!
//! CAVEAT, recorded because it bounds what this can buy: the largest weights are
//! `d_my_total`, `d_their_total`, `n_sacs` and `is_cast` -- essentially "prefer
//! simple material-gaining moves over casts and dashes", which the staged generator
//! ALREADY does by construction. The model is partly re-deriving the stage order
//! rather than adding to it, which is why the coverage gain is a few points and not
//! the 9x the oracle suggested was theoretically available.

use crate::board::{Board, Color};
use crate::topology::{MANA, SIGIL, VOID};
use crate::turn::{Action, Turn};

pub const N_RANK: usize = 15;

pub const RANK_BIAS: f32 = 1.364719;
pub const RANK_W: [f32; N_RANK] = [
    0.278906,   // is_move
    -0.279982,  // is_blink
    -0.093542,  // is_dash
    -1.901398,  // is_cast
    -0.079154,  // is_crush
    0.943599,   // move_score (in stones)
    -0.482110,  // lands_mana
    -0.562995,  // lands_void
    -1.061839,  // n_sacs
    0.517582,   // charges_sigil
    2.525898,   // d_my_total
    -2.534149,  // d_their_total
    1.483183,   // d_my_mana
    0.508894,   // d_their_mana
    -0.021094,  // order_rank
];

impl Board {
    /// Learned score for one candidate turn. Higher is better. No board copy.
    ///
    /// The material and mana deltas are derived in CLOSED FORM rather than by
    /// applying the turn: a move always places one stone, a dash also removes
    /// `n_sacs` of ours, and a crush removes one of theirs. For a CAST the deltas
    /// are not knowable without resolving it, so they are left at the move-only
    /// value and `is_cast` carries the correction -- which is exactly how the model
    /// was fitted, since the same approximation was available to it.
    pub fn rank_score(&self, t: &Turn, c: Color, rank: usize) -> f32 {
        let mut f = [0.0f32; N_RANK];
        let (mut node, mut push, mut n_sacs) = (0u8, None, 0.0f32);
        let mut is_cast = false;
        for a in t.slice() {
            match *a {
                Action::Move { node: n, push_to } => { f[0] = 1.0; node = n; push = push_to; }
                Action::Blink { node: n, push_to } => { f[1] = 1.0; node = n; push = push_to; }
                Action::Dash { node: n, push_to, n_sacs: ns, .. } => {
                    f[2] = 1.0; n_sacs = ns as f32; node = n; push = push_to;
                }
                Action::Cast { .. } => { f[3] = 1.0; is_cast = true; }
                Action::Pass => {}
            }
        }
        let bit = 1u64 << node;
        let enemy_here = self.theirs(c) & bit != 0;
        let crush = enemy_here && push.is_none();
        f[4] = crush as u8 as f32;
        f[5] = self.move_score(node, push, c) as f32 / 100.0;
        f[6] = (MANA & bit != 0) as u8 as f32;
        f[7] = (VOID & bit != 0) as u8 as f32;
        f[8] = n_sacs;
        // does landing here complete a sigil we are one short of?
        let mut charges = 0.0f32;
        for p in 0..9 {
            if SIGIL[p] & bit != 0 && self.uncontrolled_count(p, c) == 1 { charges = 1.0; break; }
        }
        f[9] = charges;
        f[10] = 1.0 - n_sacs;                       // d_my_total
        f[11] = if crush { -1.0 } else { 0.0 };     // d_their_total
        f[12] = if MANA & bit != 0 && !enemy_here { 1.0 }
                else if MANA & bit != 0 { 1.0 } else { 0.0 };   // d_my_mana
        f[13] = if MANA & bit != 0 && enemy_here { -1.0 } else { 0.0 }; // d_their_mana
        f[14] = rank as f32;
        let _ = is_cast;
        let mut s = RANK_BIAS;
        for i in 0..N_RANK { s += RANK_W[i] * f[i]; }
        s
    }
}
