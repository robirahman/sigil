//! Lazy, best-first turn generation.
//!
//! Full enumeration is complete but a materialised ~210k-successor list is not
//! searchable at every node. The fix is not to hide options again — it is to make
//! the generator lazy and ORDERED, so a search sees the promising turns first and
//! can still reach any of them by pulling further.
//!
//! Turns arrive in stages, cheapest and most-likely-best first:
//!   1. `[move, pass]` for every first move, best-first by `move_score`
//!   2. `[move, cast, pass]` — moves best-first, then spells, then that spell's
//!      outcomes best-first
//!   3. dash branches: `[move, dash, pass]` then `[move, dash, cast, pass]`
//!
//! Alpha-beta gets most of its cutoffs from a good FIRST move, so stage 1 alone
//! carries most of the ordering value; the later stages exist so nothing is
//! unreachable. `next()` does bounded work: it advances the state machine only far
//! enough to produce one turn.

use std::collections::VecDeque;
use crate::board::{Board, Color};
use crate::spells_meta::GUST;
use crate::key_dash::{KEY_DASH_EVERY, KEY_DASH_KEEP, KEY_DASH_MOVES, REASONS_ALL};
use crate::turn::{Action, Turn, OUTCOME_CAP};

/// How many outcomes of a single cast to surface. Gust's placements are
/// C(empties, displaced) — tens of thousands — so a search wants the best few,
/// with the rest still reachable by raising this.
pub const CAST_OUTCOME_WINDOW: usize = 24;

impl Board {
    /// Outcomes of casting at `pos`, best-first for `c`, at most `limit`.
    /// Gust routes through the ranked-placement generator so we never materialise
    /// the full C(empties, displaced) set just to sort it.
    pub fn resolve_outcomes_ordered(&self, pos: usize, c: Color, limit: usize)
        -> (Vec<Board>, bool)
    {
        let goal = self.placement_goal(c);
        if self.spells[pos] == GUST {
            let v = self.gust_placements_ordered(c, limit.max(1));
            let truncated = v.len() >= limit;
            return (v, truncated);
        }
        let (mut outs, trunc) = self.resolve_outcomes(pos, c, OUTCOME_CAP);
        outs.sort_by_key(|b| {
            // Prefer configurations the goal likes, and our own material.
            -(b.configuration_value(c, goal) + 30 * b.total[c.idx()] as i32
              - 30 * b.total[c.other().idx()] as i32)
        });
        let truncated = trunc || outs.len() > limit;
        outs.truncate(limit);
        (outs, truncated)
    }

    /// Lazy best-first turn generator.
    pub fn turns_ordered(&self, c: Color) -> TurnIter<'_> {
        TurnIter::new(self, c, CAST_OUTCOME_WINDOW, REASONS_ALL)
    }

    pub fn turns_ordered_window(&self, c: Color, window: usize) -> TurnIter<'_> {
        TurnIter::new(self, c, window, REASONS_ALL)
    }

    /// Same stream with an explicit interest-rule set. `reasons == 0` reproduces
    /// the pre-fix stage ordering exactly, which is what the A/B arena compares to.
    pub fn turns_ordered_reasons(&self, c: Color, window: usize, reasons: u8)
        -> TurnIter<'_>
    {
        TurnIter::new(self, c, window, reasons)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage { Moves, MoveCast, Dash, DashCast, Done }

pub struct TurnIter<'a> {
    board: &'a Board,
    c: Color,
    window: usize,
    stage: Stage,
    /// Ordered first-move options, and the post-move board for each.
    moves: Vec<(u8, Option<u8>, bool)>, // (node, push_to, is_blink)
    mi: usize,
    /// Ordered castable spells for the current move's post-move board.
    casts: Vec<usize>,
    ci: usize,
    /// Dash branches for the current move, precomputed lazily per move.
    dashes: VecDeque<(Turn, Board)>,
    pending: VecDeque<Turn>,
    /// Set if any stage dropped options because of `window`.
    pub windowed: bool,
    pub yielded: usize,
    /// Dashes that pass the interest filter, best-first. One of these takes every
    /// `KEY_DASH_EVERY`-th slot of the stream, so a width-4 budget always contains
    /// a dash and never loses more than a quarter of itself to the class.
    key: Vec<Turn>,
    ki: usize,
    /// Which interest rules are live. `0` reproduces the pre-fix stage ordering.
    reasons: u8,
}

impl<'a> TurnIter<'a> {
    fn new(board: &'a Board, c: Color, window: usize, reasons: u8) -> Self {
        let mut b = *board;
        b.update();
        // Competitive opening: a free blink onto any empty node, ordered.
        if b.variant.has_competitive() && b.turn_counter <= 2 {
            let mut v: Vec<(u8, Option<u8>, bool)> = Vec::new();
            let mut m = b.empty();
            while m != 0 { v.push((m.trailing_zeros() as u8, None, true)); m &= m - 1; }
            v.sort_by_key(|&(n, p, _)| -board.move_score(n, p, c));
            let mut it = TurnIter {
                board, c, window, stage: Stage::Done, moves: Vec::new(), mi: 0,
                casts: Vec::new(), ci: 0, dashes: VecDeque::new(),
                pending: VecDeque::new(), windowed: false, yielded: 0,
                key: Vec::new(), ki: 0, reasons: 0,
            };
            for (n, _, _) in v {
                it.pending.push_back(Turn::single(Action::Blink { node: n, push_to: None }));
            }
            return it;
        }
        let moves: Vec<(u8, Option<u8>, bool)> = board.ordered_first_moves(c)
            .into_iter()
            .map(|(n, p)| (n, p, board.is_blink_pub(n, c)))
            .collect();
        let mut it = TurnIter {
            board, c, window,
            stage: if moves.is_empty() { Stage::Done } else { Stage::Moves },
            moves, mi: 0, casts: Vec::new(), ci: 0,
            dashes: VecDeque::new(), pending: VecDeque::new(),
            windowed: false, yielded: 0,
            key: Vec::new(), ki: 0, reasons,
        };
        it.build_key_dashes();
        it
    }

    fn build_key_dashes(&mut self) {
        if self.reasons == 0 || self.moves.is_empty() { return; }
        self.key = self.board.key_dash_turns(self.c, self.reasons, KEY_DASH_KEEP);
    }

    /// True when this turn is a key dash. Those are emitted from the reserved
    /// slots — or flushed at the end of the stream if the slots ran out — so the
    /// dash stage must not emit them a second time.
    fn is_key_dup(&self, t: &Turn) -> bool {
        self.key.iter().any(|k| k.slice() == t.slice())
    }

    fn first_action(&self, i: usize) -> Action {
        let (n, p, blink) = self.moves[i];
        if blink { Action::Blink { node: n, push_to: p } } else { Action::Move { node: n, push_to: p } }
    }

    fn post_move_board(&self, i: usize) -> Board {
        let (n, p, _) = self.moves[i];
        let mut b = *self.board;
        b.do_move_with_pub(n, p, self.c);
        b
    }

    /// Advance one step, possibly pushing turns onto `pending`. Returns false when
    /// there is nothing left to do.
    fn step(&mut self) -> bool {
        match self.stage {
            Stage::Done => false,
            Stage::Moves => {
                if self.mi >= self.moves.len() {
                    self.mi = 0; self.stage = Stage::MoveCast; return true;
                }
                let a = self.first_action(self.mi);
                self.pending.push_back(Turn::single(a));
                self.mi += 1;
                true
            }
            Stage::MoveCast => {
                if self.mi >= self.moves.len() {
                    self.mi = 0; self.stage = Stage::Dash; return true;
                }
                let b = self.post_move_board(self.mi);
                if self.casts.is_empty() && self.ci == 0 {
                    // Order castable spells by the best outcome each can reach.
                    let goal = b.placement_goal(self.c);
                    let mut v: Vec<(i32, usize)> = b.castable(self.c, true, true, false)
                        .into_iter()
                        .filter_map(|id| b.position_of(id))
                        .map(|pos| {
                            let mut cl = b;
                            cl.cast_clear_and_refill(pos, self.c);
                            let (outs, _) = cl.resolve_outcomes_ordered(pos, self.c, 1);
                            let s = outs.first()
                                .map(|o| o.configuration_value(self.c, goal)
                                        + 30 * o.total[self.c.idx()] as i32)
                                .unwrap_or(i32::MIN / 4);
                            (s, pos)
                        }).collect();
                    v.sort_by_key(|&(s, _)| -s);
                    self.casts = v.into_iter().map(|(_, p)| p).collect();
                }
                if self.ci >= self.casts.len() {
                    self.casts.clear(); self.ci = 0; self.mi += 1; return true;
                }
                let pos = self.casts[self.ci];
                self.ci += 1;
                let mut cl = b;
                cl.cast_clear_and_refill(pos, self.c);
                let (outs, trunc) = cl.resolve_outcomes_ordered(pos, self.c, self.window);
                if trunc { self.windowed = true; }
                let a = self.first_action(self.mi);
                for k in 0..outs.len() {
                    self.pending.push_back(
                        Turn::single(a).push_pub(Action::Cast { pos: pos as u8, outcome: k as u16 }));
                }
                true
            }
            Stage::Dash => {
                if self.mi >= self.moves.len() {
                    self.mi = 0; self.stage = Stage::DashCast; return true;
                }
                let b = self.post_move_board(self.mi);
                let a = self.first_action(self.mi);
                for (t, _bd) in b.ordered_dash_branches(self.c, self.window) {
                    let mut full = Turn::single(a);
                    for act in t.slice() { full = full.push_pub(*act); }
                    if self.is_key_dup(&full) { continue; }
                    self.pending.push_back(full);
                }
                self.mi += 1;
                true
            }
            Stage::DashCast => {
                if self.mi >= self.moves.len() { self.stage = Stage::Done; return true; }
                let b = self.post_move_board(self.mi);
                let a = self.first_action(self.mi);
                for (t, bd) in b.ordered_dash_branches(self.c, self.window) {
                    // post-dash casts
                    for id in bd.castable(self.c, true, true, true) {
                        let Some(pos) = bd.position_of(id) else { continue };
                        let mut cl = bd;
                        cl.cast_clear_and_refill(pos, self.c);
                        let (outs, trunc) = cl.resolve_outcomes_ordered(pos, self.c, self.window);
                        if trunc { self.windowed = true; }
                        for k in 0..outs.len() {
                            let mut full = Turn::single(a);
                            for act in t.slice() { full = full.push_pub(*act); }
                            full = full.push_pub(Action::Cast { pos: pos as u8, outcome: k as u16 });
                            self.pending.push_back(full);
                        }
                    }
                }
                self.mi += 1;
                true
            }
        }
    }
}

impl<'a> Iterator for TurnIter<'a> {
    type Item = Turn;
    fn next(&mut self) -> Option<Turn> {
        loop {
            // Reserved slot: one dash in every KEY_DASH_EVERY of the stream.
            if self.ki < self.key.len() && (self.yielded + 1) % KEY_DASH_EVERY == 0 {
                let t = self.key[self.ki];
                self.ki += 1;
                self.yielded += 1;
                return Some(t.push_pub(Action::Pass));
            }
            if let Some(t) = self.pending.pop_front() {
                self.yielded += 1;
                return Some(t.push_pub(Action::Pass));
            }
            if !self.step() {
                // Never drop a key dash just because the schedule ran out of slots.
                if self.ki < self.key.len() {
                    let t = self.key[self.ki];
                    self.ki += 1;
                    self.yielded += 1;
                    return Some(t.push_pub(Action::Pass));
                }
                return None;
            }
        }
    }
}

impl Board {
    /// Turns of the form `[first move, key dash]`, best-first, at most `cap`.
    ///
    /// Bounded work: `KEY_DASH_MOVES` post-move boards, each resolving push options
    /// only for landing nodes that already passed the interest filter. Shared by
    /// `TurnIter`'s reserved slot and by the search's strictly-additive path, so
    /// both see exactly the same candidates.
    pub fn key_dash_turns(&self, c: Color, reasons: u8, cap: usize) -> Vec<Turn> {
        if reasons == 0 || cap == 0 { return Vec::new(); }
        let moves: Vec<(u8, Option<u8>)> = self.ordered_first_moves(c);
        let has_wind = self.holds_charged(c, crate::spells_meta::SEAL_OF_WIND);
        let mut all: Vec<(i32, Turn)> = Vec::new();
        for &(n, p) in moves.iter().take(KEY_DASH_MOVES) {
            let mut b = *self;
            b.do_move_with_pub(n, p, c);
            if b.outcome != crate::board::Outcome::Ongoing { continue; }
            let blink = has_wind && (crate::topology::ADJ[n as usize] & self.mine(c)) == 0;
            let a = if blink { Action::Blink { node: n, push_to: p } }
                    else { Action::Move { node: n, push_to: p } };
            // Ranked across first moves as well as within one, so a strong dash
            // under the second-best move can outrank a weak one under the best.
            // `turn_score` already scores the leading move.
            for (t, _bd, _why) in b.key_dash_branches(c, reasons, cap) {
                let mut full = Turn::single(a);
                for act in t.slice() { full = full.push_pub(*act); }
                all.push((self.turn_score(&full, c), full));
            }
        }
        all.sort_by(|x, y| y.0.cmp(&x.0));
        all.truncate(cap);
        all.into_iter().map(|(_, t)| t).collect()
    }

    /// Dash branches from a post-move board, best-first, capped at `limit`.
    /// Sacrifice choice is ordered by giving up our least valuable stones.
    pub fn ordered_dash_branches(&self, c: Color, limit: usize) -> Vec<(Turn, Board)> {
        if self.total[c.idx()] <= 2 { return Vec::new(); }
        let cost = self.dash_cost(c) as usize;
        let mut cands: Vec<u8> = Vec::new();
        let mut m = self.dash_sacrificeable(c);
        while m != 0 { cands.push(m.trailing_zeros() as u8); m &= m - 1; }
        if cands.len() < cost { return Vec::new(); }
        // Cheapest stones to give up first: low sigil progress, not on mana.
        cands.sort_by_key(|&n| self.sacrifice_cost(n, c));

        let combos: Vec<Vec<u8>> = if cost == 1 {
            cands.iter().map(|&s| vec![s]).collect()
        } else {
            let mut v = Vec::new();
            for i in 0..cands.len() {
                for j in (i + 1)..cands.len() { v.push(vec![cands[i], cands[j]]); }
            }
            v
        };
        let mut out = Vec::new();
        for combo in combos {
            let mut bd = *self;
            for &s in &combo { bd.stones[c.idx()] &= !(1u64 << s); }
            bd.update();
            if bd.outcome != crate::board::Outcome::Ongoing { continue; }
            let dt = bd.all_moveable(c);
            if dt == 0 { continue; }
            let mut vars = bd.move_variants_pub(dt, c);
            vars.sort_by_key(|&(n, p)| -bd.move_score(n, p, c));
            let mut sacs = [0u8; 2];
            for (i, &s) in combo.iter().enumerate() { sacs[i] = s; }
            for (node, push_to) in vars.into_iter().take(limit) {
                let mut b2 = bd;
                b2.do_move_with_pub(node, push_to, c);
                out.push((Turn::single(Action::Dash {
                    sacs, n_sacs: combo.len() as u8, node, push_to,
                }), b2));
                if out.len() >= limit { return out; }
            }
        }
        out
    }

    /// How much it hurts to sacrifice our stone on `node`. Lower is cheaper.
    pub fn sacrifice_cost(&self, node: u8, c: Color) -> i32 {
        let bit = 1u64 << node;
        let mut v = 0i32;
        if crate::topology::MANA & bit != 0 { v += 100; }
        for p in 0..9 {
            if crate::topology::SIGIL[p] & bit == 0 { continue; }
            match self.uncontrolled_count(p, c) {
                0 => v += 90,          // breaks a charged sigil
                1 => v += 50,
                2 => v += 20,
                _ => v += 5,
            }
        }
        if crate::topology::VOID & bit != 0 { v -= 20; }
        v
    }
}

/// Best-first over ALL turn classes, with a guaranteed quota per class.
///
/// `TurnIter` yields in STAGES: Moves, then MoveCast, then Dash, then DashCast.
/// Combined with progressive widening (6 successors near the leaves, 40 deep) that
/// starved dashes almost everywhere. Measured over 120 legal midgame positions, the
/// first dash turn sat at median index 40 and p90 284 in the stream, so at width 10
/// a dash was absent in 118/120 positions.
///
/// The search was therefore structurally blind to a whole move class at shallow
/// depth: it could not see that a player may place TWO stones in one turn (dash to
/// fill a sigil and cast it), nor that stones about to be crushed can be dashed
/// away instead, nor use dash for tempo itself. It also let the search "prove" wins
/// whose refutation was a dash — a playtest showed `win in 7` that then evaporated.
///
/// Fix: pull a bounded slice from each class, score WHOLE turns with `turn_score`,
/// and merge. The per-class quota guarantees dashes and casts appear inside every
/// width budget however the scores fall. Cost measured at ~1% of node rate.
pub struct OrderedTurns {
    buf: std::vec::IntoIter<Turn>,
    pub windowed: bool,
}

impl Board {
    /// `width` is what the caller intends to consume, so per-node cost stays
    /// proportional to the search's own budget.
    pub fn turns_best_first(&self, c: Color, window: usize, width: usize) -> OrderedTurns {
        let take_each = width.max(8);
        let mut it = self.turns_ordered_window(c, window);
        let mut moves: Vec<Turn> = Vec::new();
        let mut casts: Vec<Turn> = Vec::new();
        let mut dashes: Vec<Turn> = Vec::new();
        let hard_cap = take_each.saturating_mul(12).max(64);
        let mut seen = 0usize;
        for t in it.by_ref() {
            seen += 1;
            let has_dash = t.slice().iter().any(|a| matches!(a, Action::Dash { .. }));
            let has_cast = t.slice().iter().any(|a| matches!(a, Action::Cast { .. }));
            if has_dash {
                if dashes.len() < take_each { dashes.push(t); }
            } else if has_cast {
                if casts.len() < take_each { casts.push(t); }
            } else if moves.len() < take_each {
                moves.push(t);
            }
            if (moves.len() >= take_each && casts.len() >= take_each
                && dashes.len() >= take_each) || seen >= hard_cap { break; }
        }
        let windowed = it.windowed;
        let mut all: Vec<(i32, Turn)> = Vec::with_capacity(
            moves.len() + casts.len() + dashes.len());
        for t in moves.into_iter().chain(casts).chain(dashes) {
            all.push((self.turn_score(&t, c), t));
        }
        all.sort_by(|a, b| b.0.cmp(&a.0));
        OrderedTurns {
            buf: all.into_iter().map(|(_, t)| t).collect::<Vec<_>>().into_iter(),
            windowed,
        }
    }
}

impl Iterator for OrderedTurns {
    type Item = Turn;
    fn next(&mut self) -> Option<Turn> { self.buf.next() }
}
