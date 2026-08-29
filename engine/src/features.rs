//! Feature extraction for eval fitting and, later, the learned evaluation.
//!
//! Two vectors, for two different jobs.
//!
//! `hand_features` returns the RAW, unweighted quantity that each `eval::Weights`
//! field multiplies, in weight-declaration order. The invariant
//! `evaluate(c, w) == dot(w, hand_features(c))` is asserted by a unit test, which
//! makes the whole thing useful twice over: a logistic/texel fit on these features
//! produces weights that can be dropped straight into `Weights` with no
//! reinterpretation, and any future drift between the two code paths is caught.
//! That fit is the control this project never ran — three arena campaigns rejected
//! hand-CHOSEN positional weights, which says nothing about whether FITTED ones
//! work.
//!
//! `full_features` is the richer, mostly-raw set for the offline learnability test
//! (Phase C) and the seed of the learned eval's input layer (Phase E). It is
//! deliberately close to the board rather than pre-digested: the point of the
//! learnability test is to find out whether a model can extract signal that the
//! hand features miss, so pre-digesting would beg the question.
//!
//! Spell identities come back SEPARATELY as ids rather than being one-hot encoded
//! here, because the 9-of-39 draw is constant for a whole game: the consumer wants
//! to embed them once per game, not per position.

use crate::board::{Board, Color};
use crate::eval::Weights;
use crate::topology::{MANA, SIGIL, VOID};

/// Number of entries in `hand_features`, one per `Weights` field.
pub const N_HAND: usize = 13;

/// Names in the same order as `hand_features`, for labelling a fit's output.
pub const HAND_NAMES: [&str; N_HAND] = [
    "lead", "near_threshold", "own_zero_liberty", "own_one_liberty",
    "enemy_zero_liberty", "enemy_one_liberty", "sigil_stone", "sigil_charged",
    "mana", "sixth_spell_danger", "control", "void_penalty", "tempo",
];

impl Board {
    /// The unweighted quantity each `Weights` field multiplies, from `c`'s POV.
    /// `evaluate(c, w)` is exactly the dot product of `w` with this.
    pub fn hand_features(&self, c: Color) -> [i32; N_HAND] {
        let red = self.total[0] as i32;
        let blue = self.total[1] as i32;
        let red_score_lead = red - (blue + 1);
        let my_lead = if c == Color::Red { red_score_lead } else { -red_score_lead };

        // near_threshold: +1 when I am within one stone of my winning margin,
        // -1 when the opponent is. Red wins at red-blue >= 4, blue at blue-red >= 2.
        let (my_margin, their_margin) = if c == Color::Red {
            (4 - (red - blue), 2 - (blue - red))
        } else {
            (2 - (blue - red), 4 - (red - blue))
        };
        let near = (my_margin <= 1) as i32 - (their_margin <= 1) as i32;

        let (own0, own1) = self.liberty_census_pub(c);
        let (en0, en1) = self.liberty_census_pub(c.other());

        let mut sigil_stone = 0i32;
        let mut sigil_charged = 0i32;
        for p in 0..9 {
            let m = SIGIL[p];
            let n = m.count_ones() as i32;
            let mine = (m & self.mine(c)).count_ones() as i32;
            let theirs = (m & self.theirs(c)).count_ones() as i32;
            sigil_stone += mine * mine / n.max(1) - theirs * theirs / n.max(1);
            if mine == n { sigil_charged += 1; }
            if theirs == n { sigil_charged -= 1; }
        }

        let mana = (self.mine(c) & MANA).count_ones() as i32
                 - (self.theirs(c) & MANA).count_ones() as i32;

        // The sixth cast ENDS the game and awards it on stone count, so a high
        // counter while behind is a liability. Sign matches `eval.rs`: the weight
        // is negative, and the feature is +1 when it applies to me.
        let my_sc = self.spell_counter[c.idx()] as i32;
        let their_sc = self.spell_counter[c.other().idx()] as i32;
        let sixth = ((my_sc >= 5 && my_lead < 0) as i32)
                  - ((their_sc >= 5 && my_lead > 0) as i32);

        let void = (self.mine(c) & VOID).count_ones() as i32
                 - (self.theirs(c) & VOID).count_ones() as i32;

        let tempo = if self.to_move == c { 1 } else { -1 };
        [my_lead, near, own0, own1, en0, en1, sigil_stone, sigil_charged,
         mana, sixth, self.control_diff(c), -void, tempo]
    }

    /// Dot product of `hand_features` with `w`, in the same order as
    /// `HAND_NAMES`. Kept next to the feature vector so the two cannot drift.
    pub fn hand_weight_vec(w: &Weights) -> [i32; N_HAND] {
        [w.lead, w.near_threshold, w.own_zero_liberty, w.own_one_liberty,
         w.enemy_zero_liberty, w.enemy_one_liberty, w.sigil_stone, w.sigil_charged,
         w.mana, w.sixth_spell_danger, w.control, w.void_penalty, w.tempo]
    }

    /// Rich, close-to-the-board features for the offline learnability test and as
    /// the seed of the learned eval's inputs. Returned from `c`'s POV so a single
    /// model serves both sides without mirroring — Sigil is NOT colour-symmetric
    /// (red needs a real lead of 4, blue 2, and blue holds the +1 token), so a
    /// mirrored two-perspective encoding would be a correctness bug here.
    pub fn full_features(&self, c: Color) -> Vec<f32> {
        let mine = self.mine(c);
        let theirs = self.theirs(c);
        let empty = self.empty();
        let mut v = Vec::with_capacity(160);

        // 39 + 39: per-node occupancy, my stones then theirs.
        for i in 0..39 { v.push(((mine >> i) & 1) as f32); }
        for i in 0..39 { v.push(((theirs >> i) & 1) as f32); }

        // 9 + 9: fraction of each sigil owned, mine then theirs. This is the
        // "distance to castable" signal; the consumer crosses it with spell id.
        for p in 0..9 {
            let m = SIGIL[p];
            let n = m.count_ones() as f32;
            v.push((m & mine).count_ones() as f32 / n);
        }
        for p in 0..9 {
            let m = SIGIL[p];
            let n = m.count_ones() as f32;
            v.push((m & theirs).count_ones() as f32 / n);
        }

        // 9 + 9: castable-now flags (charged AND legal to cast), which is not the
        // same as fully owned once locks and the enemy's Seal of Winter are in play.
        let mut mine_castable = [0.0f32; 9];
        for id in self.castable(c, true, true, false) {
            if let Some(p) = self.position_of(id) { mine_castable[p] = 1.0; }
        }
        let mut their_castable = [0.0f32; 9];
        for id in self.castable(c.other(), true, true, false) {
            if let Some(p) = self.position_of(id) { their_castable[p] = 1.0; }
        }
        v.extend_from_slice(&mine_castable);
        v.extend_from_slice(&their_castable);

        // Scalars. Counts are left raw (not normalised) so a linear model can
        // recover the material term exactly.
        v.push(self.total[c.idx()] as f32);
        v.push(self.total[c.other().idx()] as f32);
        v.push(self.mana[c.idx()] as f32);
        v.push(self.mana[c.other().idx()] as f32);
        v.push((mine & VOID).count_ones() as f32);
        v.push((theirs & VOID).count_ones() as f32);
        v.push(self.spell_counter[c.idx()] as f32);
        v.push(self.spell_counter[c.other().idx()] as f32);
        v.push(self.turn_counter as f32);
        v.push(if c == Color::Red { 1.0 } else { 0.0 });
        v.push(empty.count_ones() as f32);
        // Liberty census, the cheap crushability stand-in.
        let (own0, own1) = self.liberty_census_pub(c);
        let (en0, en1) = self.liberty_census_pub(c.other());
        v.push(own0 as f32); v.push(own1 as f32);
        v.push(en0 as f32); v.push(en1 as f32);
        v.push(self.control_diff(c) as f32);
        // Locks: whether each side is locked out of a spell it holds charged.
        v.push((self.lock[c.idx()] != crate::board::NO_SPELL) as u8 as f32);
        v.push((self.lock[c.other().idx()] != crate::board::NO_SPELL) as u8 as f32);
        v
    }

    /// Spell id per sigil slot, for the consumer to embed once per game.
    pub fn spell_ids(&self) -> [u8; 9] { self.spells }
}

/// Per-candidate-turn features, for training a re-ranker.
pub const N_TURN: usize = 18;

pub const TURN_NAMES: [&str; N_TURN] = [
    "is_move", "is_blink", "is_dash", "is_cast", "is_crush", "move_score",
    "lands_mana", "lands_void", "n_sacs", "charges_sigil",
    "d_my_total", "d_their_total", "d_my_mana", "d_their_mana",
    "d_my_zero_lib", "d_enemy_zero_lib", "d_control", "order_rank",
];

impl Board {
    /// Features of ONE candidate turn, from `c`'s point of view.
    ///
    /// `best_rank` in the self-play data says WHERE the current ordering failed; it
    /// cannot train a re-ranker, because it does not describe the candidates that
    /// were passed over. This does: a ranker is trained on these rows plus which row
    /// the search chose.
    ///
    /// Deltas are computed by applying the turn, which costs a board copy per
    /// candidate. That is fine here -- this runs offline during data generation, not
    /// in the search.
    pub fn turn_features(&self, t: &crate::turn::Turn, c: Color, rank: usize)
        -> [f32; N_TURN]
    {
        use crate::turn::Action;
        let mut f = [0.0f32; N_TURN];
        let (mut node, mut push) = (0u8, None);
        for a in t.slice() {
            match *a {
                Action::Move { node: n, push_to } => { f[0] = 1.0; node = n; push = push_to; }
                Action::Blink { node: n, push_to } => { f[1] = 1.0; node = n; push = push_to; }
                Action::Dash { node: n, push_to, n_sacs, .. } => {
                    f[2] = 1.0; f[8] = n_sacs as f32; node = n; push = push_to;
                }
                Action::Cast { .. } => f[3] = 1.0,
                Action::Pass => {}
            }
        }
        let bit = 1u64 << node;
        // a crush: the landing square held an enemy stone and nothing was relocated
        if self.theirs(c) & bit != 0 && push.is_none() { f[4] = 1.0; }
        f[5] = self.move_score(node, push, c) as f32 / 100.0;
        if crate::topology::MANA & bit != 0 { f[6] = 1.0; }
        if crate::topology::VOID & bit != 0 { f[7] = 1.0; }

        let mut after = *self;
        after.apply_turn(t, c);
        let (b0, b1) = (self.liberty_census_pub(c), self.liberty_census_pub(c.other()));
        let (a0, a1) = (after.liberty_census_pub(c), after.liberty_census_pub(c.other()));
        let ch_before = (self.charged[c.idx()]).count_ones() as f32;
        let ch_after = (after.charged[c.idx()]).count_ones() as f32;
        f[9] = ch_after - ch_before;
        f[10] = after.total[c.idx()] as f32 - self.total[c.idx()] as f32;
        f[11] = after.total[c.other().idx()] as f32 - self.total[c.other().idx()] as f32;
        f[12] = after.mana[c.idx()] as f32 - self.mana[c.idx()] as f32;
        f[13] = after.mana[c.other().idx()] as f32 - self.mana[c.other().idx()] as f32;
        f[14] = (a0.0 - b0.0) as f32;
        f[15] = (a1.0 - b1.0) as f32;
        f[16] = (after.control_diff(c) - self.control_diff(c)) as f32;
        f[17] = rank as f32;
        f
    }
}

// ===================== ADAPTIVE WIDENING: "is this position hard?" ============
//
// Logistic model for P(the search's best move lies beyond width 24), fitted on
// 1,392,592 policy-labelled positions from 175,485 self-play games, split by GAME.
//
// WHY THESE 31 FEATURES. The full 132-feature vector scores AUC 0.8403; this cheap
// subset scores **0.8306**, and it drops everything the hot path cannot afford.
// `control_diff` -- a 12-layer flood fill, by far the most expensive feature --
// contributes NOTHING: removing it moves AUC from 0.8403 to 0.8401. What remains is
// sigil occupancy and scalars the board already maintains, so the whole model is a
// few popcounts and a 31-term dot product, well under 2% of a ~6.4 us node.
//
// Coefficients are fitted on RAW features, deliberately unstandardised, so the
// engine needs no mean/scale table alongside them.
const HARD_BIAS: f32 = -0.00081;
const HARD_W: [f32; 31] = [
    0.40639, -0.33818, -0.62829, 0.30003, 0.15960, 0.30633, 0.18265, 0.27887, 0.12354,
    0.70531, -0.19231, -0.43788, 0.17759, -0.15970, -0.00014, -0.05098, -0.10145, -0.12445,
    0.17338,   // total_me
    -0.08686,  // total_them
    0.14656,   // mana_me
    -0.04456,  // mana_them
    -0.05578,  // void_me
    -0.19427,  // void_them
    -0.03855,  // casts_me
    -0.07404,  // casts_them
    0.01490,   // turn_counter
    -0.25468,  // is_red
    -0.11808,  // empty
    0.00331,   // lock_me
    0.34646,   // lock_them
];

impl Board {
    /// Logit of "this position's best move lies beyond width 24", from `c`'s POV.
    ///
    /// Returned as a LOGIT rather than a probability so the caller compares against
    /// a pre-transformed threshold and no `exp` runs in the search.
    pub fn hard_logit(&self, c: Color) -> f32 {
        let mine = self.mine(c);
        let theirs = self.theirs(c);
        let mut acc = HARD_BIAS;
        let mut k = 0usize;
        for p in 0..9 {
            let m = SIGIL[p];
            let n = m.count_ones() as f32;
            acc += HARD_W[k] * ((m & mine).count_ones() as f32 / n); k += 1;
        }
        for p in 0..9 {
            let m = SIGIL[p];
            let n = m.count_ones() as f32;
            acc += HARD_W[k] * ((m & theirs).count_ones() as f32 / n); k += 1;
        }
        let i = c.idx();
        let j = c.other().idx();
        let scal = [
            self.total[i] as f32, self.total[j] as f32,
            self.mana[i] as f32, self.mana[j] as f32,
            (mine & VOID).count_ones() as f32, (theirs & VOID).count_ones() as f32,
            self.spell_counter[i] as f32, self.spell_counter[j] as f32,
            self.turn_counter as f32,
            if c == Color::Red { 1.0 } else { 0.0 },
            self.empty().count_ones() as f32,
            (self.lock[i] != crate::board::NO_SPELL) as u8 as f32,
            (self.lock[j] != crate::board::NO_SPELL) as u8 as f32,
        ];
        for v in scal { acc += HARD_W[k] * v; k += 1; }
        debug_assert_eq!(k, HARD_W.len());
        acc
    }
}
