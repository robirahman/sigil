//! Compound turns: generation, enumeration and application.
//!
//! Turn shape in this scope (Aftershock's mandatory burn phase and Providence's
//! extra-move phase both belong to deferred packs):
//!
//!   competitive opening (turn_counter <= 2): one free blink onto any EMPTY node
//!   otherwise: move -> { pass | dash -> { pass | cast } | cast -> recurse }
//!
//! Up to TWO casts per turn: the first freely, the second only while the caster
//! holds Seal of Summer charged. `can_spell` gates CHARMS only — non-charms remain
//! castable while the outer gate is open — and each cast consumes its sigil and
//! moves the lock, which is what actually bounds the chain.
//!
//! ============================ COMPLETENESS =============================
//! Past Sigil AIs blundered by searching a move generator that hid options, so
//! this enumerator branches over EVERY turn-level choice point:
//!   * the opening move target (all of them, under Wind / enemy Stone rules)
//!   * the PUSH DESTINATION of every hard move (the engine takes options[0])
//!   * which stones a dash sacrifices (the engine takes the last 1-2 in node order)
//!   * the dash's move target (the engine takes targets[0]) and its push destination
//!   * which spell to cast, and the ordering of a second cast
//!
//! Choices INSIDE a spell resolver are still resolved greedily. That is tracked
//! explicitly — never silently — by `Turn::greedy_casts` and surfaced through
//! `EnumStats`, so a caller can always tell whether a turn list is exhaustive.
//! `enumerate_turns_exhaustive` refuses to claim completeness while any cast in the
//! list carries a greedy resolver.

use crate::board::{Board, Color, Outcome};
use crate::spells_meta::*;
use crate::topology::ADJ;

pub const MAX_ACTIONS: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    /// Competitive-variant opening, or a Wind blink onto a non-adjacent node.
    Blink { node: u8, push_to: Option<u8> },
    /// Ordinary move. `push_to` is Some for a hard move that relocates, None for a
    /// soft landing or a crush.
    Move { node: u8, push_to: Option<u8> },
    /// Dash: sacrifice `n_sacs` stones (1 with Seal of Lightning, else 2), then move.
    Dash { sacs: [u8; 2], n_sacs: u8, node: u8, push_to: Option<u8> },
    /// Cast the spell in sigil `pos`, taking outcome `outcome` from the
    /// deterministic list `resolve_outcomes` produces. The index is a faithful
    /// witness: the same board and pos always yield the same ordering, so
    /// `apply_turn` reproduces the enumerated state exactly.
    Cast { pos: u8, outcome: u16 },
    Pass,
}

#[derive(Clone, Copy, Debug)]
pub struct Turn {
    pub actions: [Action; MAX_ACTIONS],
    pub len: u8,
    /// Number of casts in this turn whose resolver choices were greedy.
    pub greedy_casts: u8,
}

impl Turn {
    fn new() -> Self {
        Turn { actions: [Action::Pass; MAX_ACTIONS], len: 0, greedy_casts: 0 }
    }
    pub fn single(a: Action) -> Self { Turn::new().push(a) }
    pub fn push_pub(&self, a: Action) -> Self { self.push(a) }

    fn push(&self, a: Action) -> Self {
        let mut t = *self;
        if (t.len as usize) < MAX_ACTIONS {
            t.actions[t.len as usize] = a;
            t.len += 1;
        }
        t
    }
    pub fn slice(&self) -> &[Action] { &self.actions[..self.len as usize] }
    /// True when no cast in this turn hid a resolver-internal choice.
    pub fn is_fully_specified(&self) -> bool { self.greedy_casts == 0 }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct EnumStats {
    pub turns: usize,
    /// Turns containing at least one greedily-resolved cast.
    pub turns_with_greedy_cast: usize,
    /// Set when the turn cap stopped generation, so a caller never mistakes a
    /// truncated list for a complete one.
    pub truncated: bool,
    /// Set when a spell's own outcome enumeration hit `OUTCOME_CAP`.
    pub resolver_truncated: bool,
}

/// Cap on distinct outcomes enumerated for a single cast. Generous: the deduped
/// frontier keeps real spells far below this, and hitting it sets
/// `EnumStats::resolver_truncated` rather than silently dropping options.
pub const OUTCOME_CAP: usize = 4096;

impl Board {
    /// Nodes `c` may target with the turn's FIRST move, honouring Seal of Wind
    /// (blink privilege) and the enemy's Seal of Stone (first move must be soft).
    /// Returns (targets, wind_active).
    pub fn first_move_targets(&self, c: Color) -> (u64, bool) {
        let has_wind = self.holds_charged(c, SEAL_OF_WIND);
        let enemy_stone = self.holds_charged(c.other(), SEAL_OF_STONE);
        let t = match (enemy_stone, has_wind) {
            // Stone bars pushes. Wind still blinks, but only onto EMPTY nodes:
            // a soft blink is a soft move, and only hard blinks are barred.
            (true, true) => self.empty(),
            (true, false) => self.soft_moveable(c),
            (false, true) => self.blinkable(c),
            (false, false) => self.all_moveable(c),
        };
        (t, has_wind)
    }

    /// A Wind move onto a node not adjacent to any of your stones is a blink.
    /// Public form: recomputes whether Wind is charged for `c`.
    #[inline]
    pub fn is_blink_pub(&self, node: u8, c: Color) -> bool {
        let has_wind = self.holds_charged(c, SEAL_OF_WIND);
        self.is_blink(node, c, has_wind)
    }

    #[inline]
    fn is_blink(&self, node: u8, c: Color, has_wind: bool) -> bool {
        has_wind && (ADJ[node as usize] & self.mine(c)) == 0
    }

    /// Every (target, push_to) pair for one move onto `targets`.
    /// A hard move's push destination is a genuine choice the live game offers
    /// (`doPushEnemy` prompts), so all destinations are enumerated.
    pub fn move_variants_pub(&self, targets: u64, c: Color) -> Vec<(u8, Option<u8>)> {
        self.move_variants(targets, c)
    }

    fn move_variants(&self, targets: u64, c: Color) -> Vec<(u8, Option<u8>)> {
        let mut out = Vec::new();
        let mut m = targets;
        while m != 0 {
            let node = m.trailing_zeros() as u8;
            m &= m - 1;
            if self.theirs(c) & (1u64 << node) != 0 {
                let (opts, k) = self.push_options(node, c);
                if k == 0 { out.push((node, None)); }            // crush
                else { for &d in &opts[..k] { out.push((node, Some(d))); } }
            } else {
                out.push((node, None));
            }
        }
        out
    }

    /// Apply one move with an explicit push destination.
    pub fn do_move_with_pub(&mut self, node: u8, push_to: Option<u8>, c: Color) {
        self.do_move_with(node, push_to, c)
    }

    fn do_move_with(&mut self, node: u8, push_to: Option<u8>, c: Color) {
        let bit = 1u64 << node;
        if self.theirs(c) & bit != 0 {
            let enemy = c.other().idx();
            self.stones[enemy] &= !bit;
            self.stones[c.idx()] |= bit;
            if let Some(d) = push_to { self.stones[enemy] |= 1u64 << d; }
        } else {
            self.stones[c.idx()] |= bit;
        }
        self.update();
    }

    /// Apply a whole turn. Push destinations and dash sacrifices come from the
    /// Turn, so replaying an enumerated turn is exact rather than re-greedy.
    pub fn apply_turn(&mut self, t: &Turn, c: Color) {
        for a in t.slice() {
            match *a {
                Action::Blink { node, push_to } | Action::Move { node, push_to } => {
                    self.do_move_with(node, push_to, c);
                }
                Action::Dash { sacs, n_sacs, node, push_to } => {
                    for i in 0..n_sacs as usize {
                        self.stones[c.idx()] &= !(1u64 << sacs[i]);
                    }
                    self.update();
                    self.do_move_with(node, push_to, c);
                }
                Action::Cast { pos, outcome } => {
                    let id = self.spells[pos as usize];
                    self.cast_clear_and_refill(pos as usize, c);
                    let (outs, _) = self.resolve_outcomes(pos as usize, c, OUTCOME_CAP);
                    if let Some(b) = outs.get(outcome as usize) {
                        self.stones = b.stones;
                    } else {
                        // Fall back to the greedy resolution rather than silently
                        // applying nothing, and only if the index is out of range.
                        self.resolve_spell_at(pos as usize, c);
                    }
                    self.update();
                    self.finish_cast(id, c);
                    self.update();
                }
                Action::Pass => {}
            }
        }
        self.check_game_over(c);
    }

    /// Stones `c` may sacrifice to dash, as an explicit list (Seal of Autumn aware).
    fn sac_candidates(&self, c: Color) -> Vec<u8> {
        let mut v = Vec::new();
        let mut m = self.dash_sacrificeable(c);
        while m != 0 { v.push(m.trailing_zeros() as u8); m &= m - 1; }
        v
    }

    /// Every legal turn for `c`, with all turn-level choice points expanded.
    /// `cap` bounds the output; `stats.truncated` says whether it bit.
    pub fn enumerate_turns_capped(&self, c: Color, cap: usize) -> (Vec<Turn>, EnumStats) {
        let mut out: Vec<Turn> = Vec::new();
        let mut st = EnumStats::default();
        let mut base = *self;
        base.update();

        // --- competitive opening: one free blink onto any empty node, then pass ---
        if base.variant.has_competitive() && base.turn_counter <= 2 {
            let mut m = base.empty();
            while m != 0 {
                let node = m.trailing_zeros() as u8;
                m &= m - 1;
                let t = Turn::new()
                    .push(Action::Blink { node, push_to: None })
                    .push(Action::Pass);
                out.push(t);
                if out.len() >= cap { st.truncated = true; break; }
            }
            st.turns = out.len();
            return (out, st);
        }

        let (targets, has_wind) = base.first_move_targets(c);
        if targets == 0 {
            out.push(Turn::new().push(Action::Pass));
            st.turns = 1;
            return (out, st);
        }

        for (node, push_to) in base.move_variants(targets, c) {
            let blink = base.is_blink(node, c, has_wind);
            let mut b = base;
            b.do_move_with(node, push_to, c);
            let first = Turn::new().push(if blink {
                Action::Blink { node, push_to }
            } else {
                Action::Move { node, push_to }
            });
            b.enumerate_post_move(c, first, true, true, true, &mut out, cap, &mut st);
            if st.truncated { break; }
        }

        st.turns = out.len();
        st.turns_with_greedy_cast = out.iter().filter(|t| t.greedy_casts > 0).count();
        (out, st)
    }

    /// Convenience with a generous cap.
    pub fn enumerate_turns(&self, c: Color) -> (Vec<Turn>, EnumStats) {
        self.enumerate_turns_capped(c, 1 << 20)
    }

    fn enumerate_post_move(
        &self, c: Color, so_far: Turn,
        can_dash: bool, can_spell: bool, can_summer: bool,
        out: &mut Vec<Turn>, cap: usize, st: &mut EnumStats,
    ) {
        if out.len() >= cap { st.truncated = true; return; }
        out.push(so_far.push(Action::Pass));
        if out.len() >= cap { st.truncated = true; return; }

        // --- dash ---
        // Gate matches the JS exactly: total stones > 2 is required even when
        // Seal of Lightning reduces the cost to one stone.
        if can_dash && can_spell && self.total[c.idx()] > 2 {
            let cost = self.dash_cost(c) as usize;
            let cands = self.sac_candidates(c);
            if cands.len() >= cost {
                // Enumerate WHICH stones are sacrificed, not just the engine's
                // greedy "last one or two in node order".
                let combos: Vec<Vec<u8>> = if cost == 1 {
                    cands.iter().map(|&s| vec![s]).collect()
                } else {
                    let mut v = Vec::new();
                    for i in 0..cands.len() {
                        for j in (i + 1)..cands.len() { v.push(vec![cands[i], cands[j]]); }
                    }
                    v
                };
                for combo in combos {
                    let mut bd = *self;
                    for &s in &combo { bd.stones[c.idx()] &= !(1u64 << s); }
                    bd.update();
                    if bd.outcome != Outcome::Ongoing { continue; }
                    let dt = bd.all_moveable(c);
                    if dt == 0 { continue; }
                    let mut sacs = [0u8; 2];
                    for (i, &s) in combo.iter().enumerate() { sacs[i] = s; }
                    // Enumerate the dash's move target AND its push destination.
                    for (node, push_to) in bd.move_variants(dt, c) {
                        let mut b2 = bd;
                        b2.do_move_with(node, push_to, c);
                        let t = so_far.push(Action::Dash {
                            sacs, n_sacs: combo.len() as u8, node, push_to,
                        });
                        b2.enumerate_post_dash(c, t, can_spell, can_summer, out, cap, st);
                        if st.truncated { return; }
                    }
                }
            }
        }

        // --- spell casting ---
        if can_spell || (can_summer && self.holds_charged(c, SEAL_OF_SUMMER)) {
            for id in self.castable(c, can_spell, can_summer, false) {
                let Some(pos) = self.position_of(id) else { continue };
                let mut cleared = *self;
                cleared.cast_clear_and_refill(pos, c);
                let (outs, trunc) = cleared.resolve_outcomes(pos, c, OUTCOME_CAP);
                if trunc { st.resolver_truncated = true; }
                // canSpell becomes false; canSummer survives only after a first
                // cast made while canSpell was true.
                let next_summer = if can_spell { can_summer } else { false };
                for (i, ob) in outs.iter().enumerate() {
                    let mut bs = cleared;
                    bs.stones = ob.stones;
                    bs.update();
                    bs.finish_cast(id, c);
                    bs.update();
                    let t = so_far.push(Action::Cast { pos: pos as u8, outcome: i as u16 });
                    bs.enumerate_post_move(c, t, can_dash, false, next_summer, out, cap, st);
                    if st.truncated { return; }
                }
            }
        }
    }

    fn enumerate_post_dash(
        &self, c: Color, so_far: Turn, can_spell: bool, can_summer: bool,
        out: &mut Vec<Turn>, cap: usize, st: &mut EnumStats,
    ) {
        if out.len() >= cap { st.truncated = true; return; }
        out.push(so_far.push(Action::Pass));
        for id in self.castable(c, can_spell, can_summer, true) {
            let Some(pos) = self.position_of(id) else { continue };
            let mut cleared = *self;
            cleared.cast_clear_and_refill(pos, c);
            let (outs, trunc) = cleared.resolve_outcomes(pos, c, OUTCOME_CAP);
            if trunc { st.resolver_truncated = true; }
            for (i, _ob) in outs.iter().enumerate() {
                out.push(so_far.push(Action::Cast { pos: pos as u8, outcome: i as u16 })
                               .push(Action::Pass));
                if out.len() >= cap { st.truncated = true; return; }
            }
        }
    }

    /// Enumerate and refuse to return anything if completeness cannot be claimed.
    /// Use where a search must not silently miss options.
    pub fn enumerate_turns_exhaustive(&self, c: Color) -> Result<Vec<Turn>, EnumStats> {
        let (turns, st) = self.enumerate_turns(c);
        if st.truncated || st.resolver_truncated { Err(st) } else { Ok(turns) }
    }
}

/// The turn-level choice points this enumerator expands, and the resolver-level
/// ones still outstanding. Kept as data so the gap is auditable, never implicit.
pub const TURN_LEVEL_COMPLETE: &[&str] = &[
    "first move target (Wind blink / enemy Stone soft-only rules applied)",
    "push destination of every hard move",
    "dash sacrifice selection (all 1- or 2-subsets, Seal of Autumn aware)",
    "dash move target and its push destination",
    "spell selection, and second cast via Seal of Summer",
];

/// Resolver-level choice points, now ALSO enumerated (see `cast_enum.rs`).
/// Each of these is collapsed to a single greedy pick by the shipped engines.
pub const RESOLVER_LEVEL_COMPLETE: &[&str] = &[
    "soft_moves / hard_moves / soft_hard_chain: every target at every step",
    "surge_move / restricted_move / charge / azimuth / eclipse / erupt / syzygy: target choice",
    "locked_or_self_moves (Harvest/Gather): target and push destination per step",
    "bewitch / starfall: which adjacent pair",
    "hail_storm: which enemy stone in each qualifying sigil (the live game prompts)",
    "meteor: blink target and which adjacent enemy dies",
    "comet: blink target and which stone is sacrificed",
    "fireblast / fury: which stone is sacrificed",
    "corrupt: which up-to-three convert, and the sacrifice",
    "storm_front: which two enemy stones",
    "hurricane: which of several equally smallest groups",
    "scatter: which two sigils and which node in each",
    "blossom: which node inside each other sigil",
    "gust: where each displaced enemy stone lands",
];
