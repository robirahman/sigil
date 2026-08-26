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
        TurnIter::new(self, c, CAST_OUTCOME_WINDOW)
    }

    pub fn turns_ordered_window(&self, c: Color, window: usize) -> TurnIter<'_> {
        TurnIter::new(self, c, window)
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
}

impl<'a> TurnIter<'a> {
    fn new(board: &'a Board, c: Color, window: usize) -> Self {
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
        TurnIter {
            board, c, window,
            stage: if moves.is_empty() { Stage::Done } else { Stage::Moves },
            moves, mi: 0, casts: Vec::new(), ci: 0,
            dashes: VecDeque::new(), pending: VecDeque::new(),
            windowed: false, yielded: 0,
        }
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
            if let Some(t) = self.pending.pop_front() {
                self.yielded += 1;
                return Some(t.push_pub(Action::Pass));
            }
            if !self.step() { return None; }
        }
    }
}

impl Board {
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
