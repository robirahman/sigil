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
use crate::board::{Board, Color, Outcome};
use crate::spells_meta::{GUST, SEAL_OF_DESTRUCTION, SEAL_OF_WIND};
use crate::key_dash::{KEY_DASH_EVERY, KEY_DASH_KEEP, KEY_DASH_MOVES};
use crate::turn::{Action, Turn, OUTCOME_CAP};

/// How many outcomes of a single cast to surface. Gust's placements are
/// C(empties, displaced) — tens of thousands — so a search wants the best few,
/// with the rest still reachable by raising this.
pub const CAST_OUTCOME_WINDOW: usize = 24;

/// Default number of a cast's keep choices to expand in the ORDERED stream.
///
/// Full enumeration always expands every one — reachability is not negotiable
/// there. Here it is purely a cost knob, and a measured one: at the maximum of
/// 10 the node rate went from 20.15 to 108.16 us/node, a 5.4x regression,
/// because each extra keep is one more full `resolve_outcomes` per cast
/// candidate. Every width lever in this project is gated on node rate, so the
/// default is low and `Search::set_keep_window` exists to sweep it.
///
/// 2 still doubles what the search can see -- stratification guarantees the
/// second slot is a DIFFERENT keep, not another outcome of the priority one.
pub const DEFAULT_KEEP_WINDOW: usize = 2;

/// Ceiling, from `keep_options`: no cast offers more than C(5,2) choices.
pub const MAX_KEEP_WINDOW: usize = crate::cast::MAX_KEEPS;

/// Cap on the eagerly-enumerated turns of a NO-first-move position (dash/cast
/// continuations only, so the real count is small). `windowed` is set if it bites.
pub const NO_MOVE_TURN_CAP: usize = 4096;

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
        outs.sort_by_cached_key(|b| {
            // Prefer configurations the goal likes, and our own material.
            -(b.configuration_value(c, goal) + 30 * b.total[c.idx()] as i32
              - 30 * b.total[c.other().idx()] as i32)
        });
        let truncated = trunc || outs.len() > limit;
        outs.truncate(limit);
        (outs, truncated)
    }

    /// One cast's resolution score, the key both the ordered and ranked forms use.
    #[inline]
    fn outcome_score(&self, c: Color, goal: crate::order::PlacementGoal) -> i32 {
        self.configuration_value(c, goal) + 30 * self.total[c.idx()] as i32
            - 30 * self.total[c.other().idx()] as i32
    }

    /// What a resolution's PLACED stones achieve for the caster, scored like a
    /// first move (`move_score_goal`'s soft branch): a mana node +90, a node of
    /// another sigil +70 when it charges it / +30 one short / +5 otherwise, a
    /// void node -10 -- and **-40 for every stone put back onto the sigil just
    /// cleared** (`cleared`), the refill the players flag. Plus 5 per empty
    /// neighbour the caster's stones gain, so walking out of an encirclement
    /// ranks above packing in. `self` is the board the keep left, before the
    /// resolution; `after` is the resolved board.
    pub fn placement_bonus(&self, after: &Board, c: Color, cleared: u64) -> i32 {
        use crate::topology::{MANA, SIGIL, VOID};
        let placed = after.mine(c) & !self.mine(c);
        if placed == 0 { return 0; }
        let mut v = 0i32;
        let mut m = placed;
        while m != 0 {
            let n = m.trailing_zeros() as usize;
            m &= m - 1;
            let bit = 1u64 << n;
            if MANA & bit != 0 { v += 90; }
            if cleared & bit != 0 { v -= 40; continue; }
            if VOID & bit != 0 { v -= 10; }
            for p in 0..9 {
                if SIGIL[p] & bit == 0 || SIGIL[p] == cleared { continue; }
                v += match self.uncontrolled_count(p, c) { 1 => 70, 2 => 30, _ => 5 };
            }
        }
        let lib_before = (Board::dilate(self.mine(c)) & self.empty()).count_ones() as i32;
        let lib_after = (Board::dilate(after.mine(c)) & after.empty()).count_ones() as i32;
        v + 5 * (lib_after - lib_before)
    }

    /// Outcomes of casting at `pos`, best-first for `c`, at most `limit`, each
    /// paired with its index in the RAW `resolve_outcomes` list.
    ///
    /// The raw index is the point. `apply_turn` applies `Action::Cast::outcome`
    /// against the RAW list, so a generator that stored a position in the
    /// SORTED list made the search apply a different resolution than the one it
    /// scored -- legal, but not the turn the ordering picked, and the ordering
    /// is the entire job of this file. Returning raw indices keeps `outcome` a
    /// faithful witness, which is exactly the property `keep` needs too.
    ///
    /// Gust is deliberately NOT special-cased here: `gust_placements_ordered`
    /// yields boards with no correspondence to the raw list, so its positions
    /// cannot be applied faithfully at all. Gust is rare enough -- 5 casts in
    /// the entire recorded history -- that paying full `resolve_outcomes` for
    /// it is the right trade against being silently wrong.
    pub fn resolve_outcomes_ranked(&self, pos: usize, c: Color, limit: usize)
        -> (Vec<(usize, Board)>, bool)
    {
        let goal = self.placement_goal(c);
        let (outs, trunc) = self.resolve_outcomes(pos, c, OUTCOME_CAP);
        let mut v: Vec<(usize, Board)> = outs.into_iter().enumerate().collect();
        v.sort_by_key(|(i, b)| (-b.outcome_score(c, goal), *i));
        let truncated = trunc || v.len() > limit;
        v.truncate(limit);
        (v, truncated)
    }

    /// Keep choices for a cast at `pos`, best-first for `c`, at most `limit`,
    /// as CANONICAL `keep_options` indices — never positions in this ordering,
    /// for the reason `resolve_outcomes_ranked` documents.
    ///
    /// Scored on the board the keep leaves, BEFORE resolving. Ranking by the
    /// resolved outcome instead would cost one full resolution per keep per
    /// cast candidate, and that resolver work is the whole node-rate risk of
    /// enumerating this choice at all. Ties break toward the lower canonical
    /// index, so index 0 — the order the engine used to be fixed to — still
    /// wins whenever nothing distinguishes the options.
    pub fn keep_indices_ordered(&self, pos: usize, c: Color, limit: usize)
        -> (Vec<usize>, bool)
    {
        let (keeps, n) = self.keep_options(pos, c);
        if n <= 1 { return (vec![0], false); }
        // A budget of 1 is the pre-fix engine: the priority keep, no ranking.
        // Without this the scoring loop below still ran over every keep and
        // then threw all but one away, so `keep_window = 1` was not free and
        // could not serve as the A/B baseline it exists to be.
        if limit <= 1 { return (vec![0], n > 1); }
        let goal = self.placement_goal(c);
        let mask = crate::topology::SIGIL[pos];
        let mut v: Vec<(i32, usize)> = (0..n).map(|i| {
            let mut b = *self;
            b.stones[0] &= !mask;
            b.stones[1] &= !mask;
            b.stones[c.idx()] |= keeps[i];
            b.update();
            (b.configuration_value(c, goal), i)
        }).collect();
        v.sort_by_key(|&(s, i)| (-s, i));
        let truncated = v.len() > limit.max(1);
        v.truncate(limit.max(1));
        (v.into_iter().map(|(_, i)| i).collect(), truncated)
    }

    /// Lazy best-first turn generator, in the SHIPPED configuration: stage order,
    /// no reserved key-dash slot. The filter is off by default because every
    /// measured configuration of it lost — see `key_dash` and FINDINGS.md — so
    /// asking for it has to be explicit.
    pub fn turns_ordered(&self, c: Color) -> TurnIter<'_> {
        TurnIter::new(self, c, CAST_OUTCOME_WINDOW, 0, DEFAULT_KEEP_WINDOW)
    }

    pub fn turns_ordered_window(&self, c: Color, window: usize) -> TurnIter<'_> {
        TurnIter::new(self, c, window, 0, DEFAULT_KEEP_WINDOW)
    }

    /// The stream with an explicit keep budget, for the node-rate sweep.
    pub fn turns_ordered_keeps(&self, c: Color, window: usize, reasons: u8,
                               keep_window: usize) -> TurnIter<'_>
    {
        TurnIter::new(self, c, window, reasons, keep_window)
    }

    /// Same stream with an explicit interest-rule set. `reasons == 0` reproduces
    /// the pre-fix stage ordering exactly, which is what the A/B arena compares to.
    pub fn turns_ordered_reasons(&self, c: Color, window: usize, reasons: u8)
        -> TurnIter<'_>
    {
        TurnIter::new(self, c, window, reasons, DEFAULT_KEEP_WINDOW)
    }
}

/// Interleave per-keep candidate lists so a window holds as many DISTINCT
/// keeps as it has slots.
///
/// Scoring the (keep, outcome) pairs and taking the best `window` is not
/// enough, and the test that caught it is
/// `the_ordered_stream_offers_more_than_one_keep`: `configuration_value` often
/// cannot tell two keeps apart, every pair ties, the tie-break to the lower
/// canonical index hands the whole window to keep 0, and the search stays
/// exactly as blind as it was before the choice was enumerated. Round-robin
/// instead, best keep first, so a width-`k` budget sees `k` distinct keeps.
/// This is the same starvation the KEY_DASH reserved slot exists to prevent.
fn stratify_by_keep(mut per_keep: Vec<Vec<(i32, usize, usize)>>, window: usize)
    -> (Vec<(i32, usize, usize)>, bool)
{
    per_keep.sort_by_key(|v| v.first().map(|&(s, _, _)| -s).unwrap_or(i32::MAX));
    let total: usize = per_keep.iter().map(|v| v.len()).sum();
    let mut out: Vec<(i32, usize, usize)> = Vec::with_capacity(window.min(total));
    let mut round = 0usize;
    while out.len() < window {
        let mut pushed = false;
        for v in per_keep.iter() {
            if let Some(&x) = v.get(round) {
                out.push(x);
                pushed = true;
                if out.len() >= window { break; }
            }
        }
        if !pushed { break; }
        round += 1;
    }
    (out, total > window)
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
    /// How many keep choices per cast this stream expands. 1 reproduces the
    /// pre-fix behaviour exactly: only the priority keep.
    keep_window: usize,
}

impl<'a> TurnIter<'a> {
    fn new(board: &'a Board, c: Color, window: usize, reasons: u8,
           keep_window: usize) -> Self {
        let mut b = *board;
        b.update();
        // Competitive opening: a free blink onto any empty node, ordered.
        if b.variant.has_competitive() && b.turn_counter <= 2 {
            let mut v: Vec<(u8, Option<u8>, bool)> = Vec::new();
            let mut m = b.empty();
            while m != 0 { v.push((m.trailing_zeros() as u8, None, true)); m &= m - 1; }
            let goal = board.placement_goal(c);
            v.sort_by_cached_key(|&(n, p, _)| -board.move_score_goal(n, p, c, goal));
            let mut it = TurnIter {
                board, c, window, stage: Stage::Done, moves: Vec::new(), mi: 0,
                casts: Vec::new(), ci: 0, dashes: VecDeque::new(),
                pending: VecDeque::new(), windowed: false, yielded: 0,
                key: Vec::new(), ki: 0, reasons: 0, keep_window,
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
            key: Vec::new(), ki: 0, reasons, keep_window,
        };
        // No legal first move (e.g. an enemy Seal of Stone forcing soft moves while
        // every reachable node is occupied) only invalidates the MOVE: the optional
        // dash and/or cast — and the bare pass — remain. This class is rare and its
        // turn count small (no first-move fan-out), so instead of teaching every
        // stage to run move-less we take the exhaustive enumerator's answer, which
        // is the reference for exactly this case. Starting in Stage::Done with
        // nothing pending made the search see ZERO successors here.
        if it.moves.is_empty() {
            let (turns, st) = b.enumerate_turns_capped(c, NO_MOVE_TURN_CAP);
            if st.truncated || st.resolver_truncated { it.windowed = true; }
            for t in turns {
                // `pending` holds turns WITHOUT the trailing Pass (`next()` appends
                // it), so strip the one the enumerator added.
                debug_assert!(matches!(t.slice().last(), Some(Action::Pass)));
                let mut t2 = t;
                t2.len -= 1;
                it.pending.push_back(t2);
            }
        }
        it.build_key_dashes();
        // Seal of Destruction: a turn that decides the game goes to the FRONT of
        // the stream, ahead of every stage. Width cuts the stream after `w`
        // turns and the stages put every cast under every first move before any
        // dash, so a mate under the last-ranked first move -- the only soft move
        // in a position full of tempting pushes -- sat 120+ turns deep and was
        // never searched (the k=5 Gust case). The stages emit it again later;
        // the duplicate costs a TT probe.
        for t in board.decisive_destruction_turns(c).into_iter().rev() {
            it.pending.push_front(t);
        }
        // Stone-lead mates (the ordinary way a game ends) get the same treatment:
        // a material-gated scan puts every turn that reaches the lead now at the
        // front of the stream. See `decisive_lead_turns`.
        if decisive_lead_enabled() {
            // Iterative deepening regenerates every node's stream once per
            // iteration, so the scan's answer is memoised per position.
            let key = crate::zobrist::ZOBRIST.key_js(&b) ^ if c == Color::Red { 0 } else { 0x9E37_79B9_7F4A_7C15 };
            let cached = LEAD_CACHE.with(|cache| {
                let e = &cache.borrow()[(key as usize) & (LEAD_CACHE_SIZE - 1)];
                if e.key == key { Some(e.turn) } else { None }
            });
            let found: Option<Turn> = match cached {
                Some(t) => t,
                None => {
                    let fm: Vec<(u8, Option<u8>)> = it.moves.iter().map(|&(n, p, _)| (n, p)).collect();
                    let t = board.decisive_lead_turns_from(c, decisive_lead_cap(), &fm).into_iter().next();
                    LEAD_CACHE.with(|cache| {
                        cache.borrow_mut()[(key as usize) & (LEAD_CACHE_SIZE - 1)] = LeadEntry { key, turn: t };
                    });
                    t
                }
            };
            if let Some(t) = found { it.pending.push_front(t); }
        }
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
                            // Which SPELL to try first is a heuristic, so it is
                            // scored on the priority keep alone. Scoring every
                            // keep here would multiply this ordering pass by
                            // `keep_count` for a tie-break that the joint
                            // window below re-decides properly anyway.
                            let mut cl = b;
                            cl.cast_clear_and_keep(pos, self.c, 0);
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
                let a = self.first_action(self.mi);
                let goal = b.placement_goal(self.c);

                // The keep and the resolution are ONE choice -- the resolver
                // runs on whatever board the keep leaves -- so they are scored
                // and windowed JOINTLY. That holds the turns surfaced per cast
                // at `window`, the same as before this dimension existed, so
                // the search's view improves without the stream paying for
                // options progressive widening would discard anyway.
                let (kis, ktr) = b.keep_indices_ordered(pos, self.c, self.keep_window.clamp(1, MAX_KEEP_WINDOW));
                if ktr { self.windowed = true; }
                // Resolve once per KEEP and hold the raw list. The Summer
                // continuation below needs to index outcomes by RAW index, and
                // re-resolving there per candidate cost up to `window` full
                // resolutions per cast candidate -- measured at 5.4x the node
                // rate, and initially misattributed to the keep choice itself.
                // The sweep is what separated them: the keep budget costs
                // 1.08x at its maximum, this cost the other 5x.
                let mut per_keep: Vec<Vec<(i32, usize, usize)>> = Vec::new();
                let mut resolved: Vec<(usize, Board, Vec<Board>)> =
                    Vec::with_capacity(kis.len());
                for &ki in &kis {
                    let mut cl = b;
                    cl.cast_clear_and_keep(pos, self.c, ki);
                    let (outs, trunc) = cl.resolve_outcomes(pos, self.c, OUTCOME_CAP);
                    if trunc { self.windowed = true; }
                    let cleared = crate::topology::SIGIL[pos];
                    let v2 = outcome_order_v2();
                    let mut v: Vec<(i32, usize, usize)> = outs.iter().enumerate()
                        .map(|(raw, ob)| (ob.outcome_score(self.c, goal)
                                          + if v2 { cl.placement_bonus(ob, self.c, cleared) } else { 0 }, ki, raw))
                        .collect();
                    v.sort_by_key(|&(sc, _, raw)| (-sc, raw));
                    v.truncate(self.window);
                    if !v.is_empty() { per_keep.push(v); }
                    resolved.push((ki, cl, outs));
                }
                let (cands, more) = stratify_by_keep(per_keep, self.window);
                if more { self.windowed = true; }
                for &(_, ki, raw) in &cands {
                    self.pending.push_back(Turn::single(a).push_pub(Action::Cast {
                        pos: pos as u8, keep: ki as u8, outcome: raw as u16,
                    }));
                }

                // Seal of Summer: a SECOND cast may follow the first, as in
                // `enumerate_post_move`'s recursion (can_spell=false, can_summer=true,
                // gated on the POST-cast board holding Summer charged). Without this
                // the stream never contains `[move, cast, cast]` and no width budget
                // can recover it. The first cast's own board is rebuilt from its
                // (keep, raw outcome) pair, so the continuation starts exactly where
                // `apply_turn` will put it.
                let id = b.spells[pos];
                for &(_, ki, raw) in &cands {
                    let Some((_, cl, outs)) =
                        resolved.iter().find(|(k, _, _)| *k == ki) else { continue };
                    let Some(ob) = outs.get(raw) else { continue };
                    let mut bs = *cl;
                    bs.stones = ob.stones;
                    bs.update();
                    bs.finish_cast(id, self.c);
                    bs.update();
                    if !bs.holds_charged(self.c, crate::spells_meta::SEAL_OF_SUMMER) { continue; }
                    for id2 in bs.castable(self.c, false, true, false) {
                        let Some(pos2) = bs.position_of(id2) else { continue };
                        let (kis2, tr0) =
                            bs.keep_indices_ordered(pos2, self.c, self.keep_window.clamp(1, MAX_KEEP_WINDOW));
                        if tr0 { self.windowed = true; }
                        for &ki2 in &kis2 {
                            let mut cl2 = bs;
                            cl2.cast_clear_and_keep(pos2, self.c, ki2);
                            let (ranked2, tr2) =
                                cl2.resolve_outcomes_ranked(pos2, self.c, self.window);
                            if tr2 { self.windowed = true; }
                            for (raw2, _ob2) in ranked2 {
                                self.pending.push_back(
                                    Turn::single(a)
                                        .push_pub(Action::Cast {
                                            pos: pos as u8, keep: ki as u8,
                                            outcome: raw as u16,
                                        })
                                        .push_pub(Action::Cast {
                                            pos: pos2 as u8, keep: ki2 as u8,
                                            outcome: raw2 as u16,
                                        }));
                            }
                        }
                    }
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
                    let goal = bd.placement_goal(self.c);
                    for id in bd.castable(self.c, true, true, true) {
                        let Some(pos) = bd.position_of(id) else { continue };
                        let (kis, ktr) =
                            bd.keep_indices_ordered(pos, self.c, self.keep_window.clamp(1, MAX_KEEP_WINDOW));
                        if ktr { self.windowed = true; }
                        let mut per_keep: Vec<Vec<(i32, usize, usize)>> = Vec::new();
                        for &ki in &kis {
                            let mut cl = bd;
                            cl.cast_clear_and_keep(pos, self.c, ki);
                            let (ranked, trunc) =
                                cl.resolve_outcomes_ranked(pos, self.c, self.window);
                            if trunc { self.windowed = true; }
                            let mut v: Vec<(i32, usize, usize)> = ranked.into_iter()
                                .map(|(raw, ob)| (ob.outcome_score(self.c, goal), ki, raw))
                                .collect();
                            v.sort_by_key(|&(sc, _, raw)| (-sc, raw));
                            if !v.is_empty() { per_keep.push(v); }
                        }
                        let (cands, more) = stratify_by_keep(per_keep, self.window);
                        if more { self.windowed = true; }
                        for &(_, ki, raw) in &cands {
                            let mut full = Turn::single(a);
                            for act in t.slice() { full = full.push_pub(*act); }
                            full = full.push_pub(Action::Cast {
                                pos: pos as u8, keep: ki as u8, outcome: raw as u16,
                            });
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
    /// Turns that decide the game through Seal of Destruction, for the stream to
    /// emit first (see `TurnIter::new`). Bounded: nothing runs unless the seal
    /// is drawn and someone is within reach of it -- `c` at most two nodes short,
    /// or the enemy fillable by a Gust `c` can cast -- and then it is one
    /// resolution per (first move, castable spell) plus one dash probe per first
    /// move. Each candidate is verified by simulating the turn through the seal's
    /// own rules, so nothing here is a guess the search has to refute.
    pub fn decisive_destruction_turns(&self, c: Color) -> Vec<Turn> {
        let Some(pos) = self.position_of(SEAL_OF_DESTRUCTION) else { return Vec::new() };
        let short = self.uncontrolled_count(pos, c);
        let fill = self.destruction_fill_targets(c);
        let gust_fill = fill != 0 && self.position_of(GUST).map_or(false, |g| self.is_charged(c, g))
            && (self.theirs(c) & Board::dilate(self.mine(c))).count_ones() >= fill.count_ones();
        if short > 2 && !gust_fill { return Vec::new(); }
        let wins = |after: &Board| -> bool {
            let mut t = *after;
            t.update();
            t.destruction_end_of_turn(c);
            t.check_game_over(c);
            t.destruction_start_of_turn(c.other());
            matches!((c, t.outcome), (Color::Red, Outcome::RedWins) | (Color::Blue, Outcome::BlueWins))
        };
        let has_wind = self.holds_charged(c, SEAL_OF_WIND);
        let seal = crate::topology::SIGIL[pos];
        let mut out: Vec<Turn> = Vec::new();
        for (n, p) in self.ordered_first_moves(c) {
            let blink = has_wind && (crate::topology::ADJ[n as usize] & self.mine(c)) == 0;
            let a = if blink { Action::Blink { node: n, push_to: p } }
                    else { Action::Move { node: n, push_to: p } };
            let mut b = *self;
            b.do_move_with_pub(n, p, c);
            // Decided by the move alone: `move_score` already ranks it first.
            if b.outcome != Outcome::Ongoing || wins(&b) { continue; }
            // Casts whose best resolution decides it (self-fill, or Gust onto theirs).
            for id in b.castable(c, true, true, false) {
                let Some(cp) = b.position_of(id) else { continue };
                if id != GUST && b.uncontrolled_count(pos, c) > 2 { continue; }
                let mut cl = b;
                cl.cast_clear_and_keep(cp, c, 0);
                let (ranked, _) = cl.resolve_outcomes_ranked(cp, c, 1);
                if let Some((raw, ob)) = ranked.first() {
                    if wins(ob) {
                        out.push(Turn::single(a).push_pub(Action::Cast {
                            pos: cp as u8, keep: 0, outcome: *raw as u16 }));
                    }
                }
            }
            // A dash landing the seal's last node, paid with the two cheapest
            // stones that are not themselves on the seal.
            if b.uncontrolled_count(pos, c) == 1 && b.can_dash(c) {
                let mut cands: Vec<u8> = Vec::new();
                let mut m = b.dash_sacrificeable(c) & !seal & !(1u64 << n);
                while m != 0 { cands.push(m.trailing_zeros() as u8); m &= m - 1; }
                cands.sort_by_cached_key(|&x| b.sacrifice_cost(x, c));
                let cost = b.dash_cost(c) as usize;
                if cands.len() >= cost {
                    let mut sacs = [0u8; 2];
                    sacs[..cost].copy_from_slice(&cands[..cost]);
                    sacs[..cost].sort_unstable();
                    let mut bd = b;
                    for &x in &sacs[..cost] { bd.stones[c.idx()] &= !(1u64 << x); }
                    bd.update();
                    if bd.outcome == Outcome::Ongoing {
                        let last = seal & !bd.mine(c);
                        if last.count_ones() == 1 && bd.all_moveable(c) & last != 0 {
                            let node = last.trailing_zeros() as u8;
                            for (tn, tp) in bd.move_variants_pub(last, c) {
                                let mut b2 = bd;
                                b2.do_move_with_pub(tn, tp, c);
                                if wins(&b2) {
                                    out.push(Turn::single(a).push_pub(Action::Dash {
                                        sacs, n_sacs: cost as u8, node, push_to: tp }));
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
        out
    }

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
        cands.sort_by_cached_key(|&n| self.sacrifice_cost(n, c));   // key = escape_distance BFS; once per stone

        // Fixed-size combos: one allocation for the list instead of one per
        // pair (C(n,2) heap Vecs per post-move board, mostly never consumed
        // because the loop below returns at `limit`).
        let n = cands.len();
        let mut combos: Vec<([u8; 2], u8)> =
            Vec::with_capacity(if cost == 1 { n } else { n * (n - 1) / 2 });
        if cost == 1 {
            for &s in &cands { combos.push(([s, 0], 1)); }
        } else {
            for i in 0..n {
                for j in (i + 1)..n { combos.push(([cands[i], cands[j]], 2)); }
            }
        }
        let mut out = Vec::new();
        for (combo_sacs, n_sacs) in combos {
            let combo = &combo_sacs[..n_sacs as usize];
            let mut bd = *self;
            for &s in combo { bd.stones[c.idx()] &= !(1u64 << s); }
            bd.update();
            if bd.outcome != crate::board::Outcome::Ongoing { continue; }
            let dt = bd.all_moveable(c);
            if dt == 0 { continue; }
            let mut vars = bd.move_variants_pub(dt, c);
            let goal = bd.placement_goal(c);
            vars.sort_by_cached_key(|&(n, p)| -bd.move_score_goal(n, p, c, goal));
            let mut sacs = [0u8; 2];
            for (i, &s) in combo.iter().enumerate() { sacs[i] = s; }
            // CANONICAL NODE ORDER. `cands` above is sorted by `sacrifice_cost`
            // to pick the cheapest stones, so `combo` arrives cost-ordered
            // while `turn.rs`'s `sac_candidates` (trailing_zeros) is
            // node-ordered. The two therefore built the SAME dash with `sacs`
            // in different orders, and since `Action` derives PartialEq/Hash,
            // they compared and hashed as different turns -- which is what the
            // `key_dash` "unenumerable dashes" were: 11 of 15 matched a legal
            // enumerated turn modulo this order, and Robi adjudicated every one
            // legal by replay. Sorting here changes no board, only the
            // identity, so TT probes, killer-move matching and the emit gate
            // stop missing.
            sacs[..combo.len()].sort_unstable();
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


// ---------------------------------------------------------------------------
// Decisive stone-lead turns (2026-09-19)
//
// The audit of every recorded game's final position (tools/audit_mates.py)
// showed the ordered stream ranking the winning turn far outside any width
// budget whenever it needed a cast or a dash+cast: median rank in the hundreds,
// often not generated within 4,096 turns at all. Progressive widening takes the
// first `w` turns (24 at the leaves), so a mate-in-1 by Fireblast, Carnage,
// Starfall, Harvest... was invisible at every inner node, and the search
// announced -0.5 in positions where the opponent had hundreds of mates.
//
// This mirrors `decisive_destruction_turns`: an eager, bounded, material-GATED
// scan that verifies each candidate through the real `apply_turn`, so nothing
// here is a guess. It runs only when the mover is within reach of the lead
// (or is one cast from the sixth), and examines at most `DECISIVE_LEAD_CAP`
// boards per node. The shapes covered are the ones the audit found:
//   [move]                      -- crush reaches the lead
//   [move, cast]                -- every keep, every resolution
//   [move, dash, cast]          -- the dash fills the sigil; every sacrifice pair
// Turns found here are also emitted again later by the stages; the duplicate
// costs a TT probe, as with the Destruction pre-pass.
// ---------------------------------------------------------------------------

thread_local! {
    static DECISIVE_LEAD: std::cell::Cell<(bool, usize)> = std::cell::Cell::new((true, DECISIVE_LEAD_CAP));
}
/// A/B switch for the lead pre-pass (default on) and its per-node board budget.
/// Per thread: the stream has no handle on the `Search` that pulls it, and a
/// process-wide flag would let one test's "off" leak into another's assertion.
pub fn set_decisive_lead(on: bool, cap: usize) { DECISIVE_LEAD.with(|c| c.set((on, cap.max(1)))); }
pub fn decisive_lead_enabled() -> bool { DECISIVE_LEAD.with(|c| c.get().0) }
pub fn decisive_lead_cap() -> usize { DECISIVE_LEAD.with(|c| c.get().1) }
/// Boards the lead pre-pass may examine per node before giving up (best effort).
pub const DECISIVE_LEAD_CAP: usize = 2_500;

thread_local! {
    static LEAD_BOUNDS_V2: std::cell::Cell<bool> = std::cell::Cell::new(true);
    static OUTCOME_ORDER_V2: std::cell::Cell<bool> = std::cell::Cell::new(true);
}
/// A/B switch (default on) for scoring a cast's resolutions by what the
/// caster's PLACED stones achieve (`Board::placement_bonus`). Without it every
/// resolution of a placement ritual (Flourish, Grow, Sprout, Harvest, Gather,
/// Tsunami, Blossom, Scatter) scores the same -- `outcome_score` reads only
/// the enemy configuration and the totals -- so the window filled in raw
/// enumeration order, i.e. ascending node index, and for the first ritual slot
/// that is the very sigil just cleared: the AI kept one stone, sacrificed the
/// rest and put the four placements straight back. Players flagged 30% of
/// those casts as bad (weakness audit, 2026-09-21).
pub fn set_outcome_order_v2(on: bool) { OUTCOME_ORDER_V2.with(|c| c.set(on)); }
pub fn outcome_order_v2() -> bool { OUTCOME_ORDER_V2.with(|c| c.get()) }
/// A/B switch (default on) for the 2026-09-22 bound corrections in the lead
/// pre-pass. The audit of every recorded game-ending position found the
/// pre-pass gated out of all 61 wins the depth-2 search missed, for five
/// reasons, each a bound that under-counted what the turn could still do:
///   A. `lead_fill_targets` charged the dash's move as a bare placement (+1)
///      when the node it fills holds an ENEMY stone and the move is a crush
///      (+2) -- 49 of the 57 dash-branch misses died at that comparison;
///   B. eliminating every enemy stone is a win the ±3 arithmetic never saw;
///   C. the turn's own placement can charge Seal of Lightning and halve the
///      dash's cost;
///   D. a mana node taken during the turn lowers the sigil-clearing cost;
///   E. Hail Storm's "exact" count ignored the enemy stone a push deposits.
/// Off reproduces the shipped v10 bounds for the arena.
pub fn set_lead_bounds_v2(on: bool) { LEAD_BOUNDS_V2.with(|c| c.set(on)); }
pub fn lead_bounds_v2() -> bool { LEAD_BOUNDS_V2.with(|c| c.get()) }

impl Board {
    /// Optimistic bound on how many stones casting `id` can swing in the
    /// caster's favour (own stones placed + enemy stones removed/converted),
    /// BEFORE the cost of clearing its sigil. Used only to gate work.
    pub fn cast_swing_bound(&self, id: u8, c: Color, placements: u32) -> i32 {
        use crate::spells_meta::{Resolve, SPELLS, NUM_OFFICIAL_SPELLS};
        if id as usize >= NUM_OFFICIAL_SPELLS { return 0; }
        let info = &SPELLS[id as usize];
        let theirs = self.total[c.other().idx()] as i32;
        match info.resolve {
            Resolve::None_ | Resolve::Gust => 0,
            Resolve::SoftMoves => info.count as i32,
            // Each hard move places a stone and may crush the stone it pushes.
            Resolve::HardMoves | Resolve::LockedOrSelfMoves => 2 * info.count as i32,
            Resolve::SoftHardChain => info.counts.0 as i32 + 2 * info.counts.1 as i32,
            // Every touching enemy stone (stones still to be placed can touch up
            // to four more each), less the sacrifice the cast then demands.
            Resolve::Fireblast => {
                let adj = (self.theirs(c) & Board::dilate(self.mine(c))).count_ones() as i32;
                (adj + 4 * placements as i32).min(theirs) - 1
            }
            // One stone per 3- or 5-node sigil that holds an enemy stone -- plus
            // one per stone the turn can still PUSH into an empty sigil (E).
            Resolve::HailStorm => (0..6).filter(|&p| crate::topology::SIGIL[p] & self.theirs(c) != 0).count() as i32
                                  + if lead_bounds_v2() { placements as i32 } else { 0 },
            Resolve::Meteor => 2,
            Resolve::Bewitch => 4,
            Resolve::Starfall => 2 + theirs.min(6),
            Resolve::SurgeMove | Resolve::RestrictedMove | Resolve::Charge | Resolve::Azimuth => 2,
            Resolve::Comet => 1,
            Resolve::Scatter | Resolve::StormFront => 2,
            Resolve::Blossom => 5,
            Resolve::Eclipse | Resolve::Syzygy => 4,
            Resolve::Fury | Resolve::Corrupt => 5,
            Resolve::Erupt => 16,
            Resolve::Hurricane | Resolve::DestroyExposed => theirs,
        }
    }

    /// Stones lost to clearing the sigil at `pos` when `c` casts it, when the turn can still place `placements` stones before
    /// the cast: each may take a mana node, and every mana held refunds one
    /// sigil stone (D). Optimistic, like every bound here.
    fn clear_loss_p(&self, pos: usize, c: Color, placements: u32) -> i32 {
        let size = crate::topology::SIGIL[pos].count_ones() as i32;
        let info = &crate::spells_meta::SPELLS[self.spells[pos] as usize];
        if info.is_charm { return size; }
        let mut mana = self.mana[c.idx()] as i32;
        if lead_bounds_v2() {
            let open_mana = (crate::topology::MANA & !self.mine(c)).count_ones();
            mana += placements.min(open_mana) as i32;
        }
        (size - mana).max(0)
    }

    /// Turns of `c` that end the game NOW on the stone lead (or by the sixth
    /// cast), best-effort and bounded, for the stream to emit first.
    ///
    /// A material-pruned copy of the exhaustive enumerator's grammar (move, then
    /// any order of one dash and one cast, a Seal-of-Summer second cast): every
    /// branch carries an optimistic bound on the stones it can still swing and is
    /// cut when that cannot reach the lead. Candidates are verified through the
    /// real `apply_turn`. At most `cap` boards are examined.
    pub fn decisive_lead_turns(&self, c: Color, cap: usize) -> Vec<Turn> {
        let fm = self.ordered_first_moves(c);
        self.decisive_lead_turns_from(c, cap, &fm)
    }

    /// `decisive_lead_turns` with the caller's first-move list (the stream has
    /// already computed and ordered it; recomputing it here doubled the cost).
    pub fn decisive_lead_turns_from(&self, c: Color, cap: usize, first_moves: &[(u8, Option<u8>)]) -> Vec<Turn> {
        let mut out: Vec<Turn> = Vec::new();
        if self.variant.has_deathmatch() || self.outcome != Outcome::Ongoing { return out; }
        if self.variant.has_competitive() && self.turn_counter <= 2 { return out; }
        let mut st = LeadScan {
            c, me: c.idx(), them: c.other().idx(),
            lead_req: if c == Color::Red { 4 } else { 2 },
            sixth: self.spell_counter[c.idx()] >= 5,
            six_req: if c == Color::Red { 2 } else { 0 },
            root: *self, examined: 0, cap, out: Vec::new(),
        };
        let diff = st.diff(self);
        if diff >= st.lead_req { return out; }   // already decided; the caller sees `outcome`
        // GATE: first move (+ one crush) plus the best of what dash/cast can add.
        // The first move is a placement that can fill a sigil, hence `1 +`.
        let pot = 2 + self.lead_potential(c, true, true, 1);
        if diff + pot < st.lead_req && !(st.sixth && diff + pot >= st.six_req) { return out; }
        let has_wind = self.holds_charged(c, SEAL_OF_WIND);
        // Two phases (v2): every first move with a direct cast first, then the
        // dash branches. A dash branch can cost hundreds of boards (sacrifice
        // pairs x fill targets x keeps), and letting the first few first moves
        // spend the budget there starved a plain [move, cast] mate later in the
        // list -- the shipped cap missed a recorded mate it used to find.
        // Phase 1 gets two fifths of the budget: in a wide position its casts
        // alone can eat the whole cap, and the dash-fill mates (the shape the
        // pre-pass exists for) would never be reached.
        let phases: &[(bool, bool, usize)] = if lead_bounds_v2() { &[(false, false, (cap * 2 / 5).max(400)), (true, true, cap)] }
                                             else { &[(true, false, cap)] };
        for &(can_dash, dash_only, phase_cap) in phases {
            st.cap = phase_cap.min(cap);
            for &(n, p) in first_moves {
                if st.examined >= st.cap || st.out.len() >= LEAD_MAX_FOUND { break; }
                let blink = has_wind && (crate::topology::ADJ[n as usize] & self.mine(c)) == 0;
                let a = if blink { Action::Blink { node: n, push_to: p } }
                        else { Action::Move { node: n, push_to: p } };
                let mut b1 = *self;
                b1.do_move_with_pub(n, p, c);
                st.examined += 1;
                if b1.outcome != Outcome::Ongoing {
                    // B: the move alone may have wiped the enemy (or reached the lead).
                    if lead_bounds_v2() && !dash_only && st.won(&b1) { st.verify(Turn::single(a)); }
                    continue;
                }
                st.post_move_from(&b1, Turn::single(a), can_dash, true, true, false, false, dash_only);
            }
            if st.out.len() >= LEAD_MAX_FOUND { break; }
        }
        std::mem::swap(&mut out, &mut st.out);
        out
    }

    /// Optimistic stones a dash and/or a cast could still add for `c` on this
    /// board: the dash's extra placement (+1, +1 crush, less its cost) and the
    /// best net cast among spells castable now or fillable by that placement.
    /// `placements` is how many stones the rest of the turn can still place
    /// before a cast (the pending first move, a dash's move), each of which
    /// may fill one sigil node.
    fn lead_potential(&self, c: Color, can_dash: bool, can_spell: bool, placements: u32) -> i32 {
        use crate::spells_meta::{SPELLS, NUM_OFFICIAL_SPELLS};
        let dash_ok = can_dash && can_spell && self.total[c.idx()] > 2 && self.can_dash(c);
        let mut dash_cost = self.dash_cost(c) as i32;
        // C: a placement can charge Seal of Lightning first, halving the dash.
        if lead_bounds_v2() && dash_cost > 1 {
            if let Some(pos) = self.position_of(crate::spells_meta::SEAL_OF_LIGHTNING) {
                if self.uncontrolled_count(pos, c) <= placements { dash_cost = 1; }
            }
        }
        let dash_gain = if dash_ok { 2 - dash_cost } else { 0 };
        let mut best_cast = 0i32;
        if can_spell {
            let reach = placements + if dash_ok { 1 } else { 0 };
            for pos in 0..9 {
                let id = self.spells[pos];
                if id as usize >= NUM_OFFICIAL_SPELLS || SPELLS[id as usize].is_static { continue; }
                if self.uncontrolled_count(pos, c) > reach { continue; }
                best_cast = best_cast.max(self.cast_swing_bound(id, c, reach) - self.clear_loss_p(pos, c, reach));
            }
        }
        dash_gain + best_cast
    }
}

impl Board {
    /// Empty nodes whose filling would charge a castable, non-static spell able
    /// (by its optimistic bound) to reach the lead from this board's material.
    fn lead_fill_targets(&self, c: Color, st: &LeadScan, casts_allowed: bool) -> u64 {
        use crate::spells_meta::{SPELLS, NUM_OFFICIAL_SPELLS};
        if !casts_allowed { return 0; }
        let mut m = 0u64;
        for pos in 0..9 {
            let id = self.spells[pos];
            if id as usize >= NUM_OFFICIAL_SPELLS || SPELLS[id as usize].is_static { continue; }
            if self.uncontrolled_count(pos, c) != 1 { continue; }
            let gap = crate::topology::SIGIL[pos] & !self.mine(c);   // the single missing node
            let net = self.cast_swing_bound(id, c, 1) - self.clear_loss_p(pos, c, 1);
            // A: when an ENEMY stone stands on that node the filling move is a
            // hard move -- one placed, one crushed -- worth the same 2 that
            // `lead_potential` and the dash branch's `bare` already charge.
            if lead_bounds_v2() && (gap & self.theirs(c)) != 0 && st.reachable(self, 2 + net, true) {
                m |= gap & self.theirs(c);
            }
            if st.reachable(self, 1 + net, true) { m |= gap; }
        }
        m
    }
}

#[derive(Clone, Copy)]
struct LeadEntry { key: u64, turn: Option<Turn> }
/// Direct-mapped memo of the pre-pass per (position, side): 2^14 entries.
pub const LEAD_CACHE_SIZE: usize = 1 << 14;
thread_local! {
    static LEAD_CACHE: std::cell::RefCell<Vec<LeadEntry>> =
        std::cell::RefCell::new(vec![LeadEntry { key: 0, turn: None }; LEAD_CACHE_SIZE]);
}

/// How many decisive turns the lead pre-pass collects before stopping: the
/// stream needs one to score the node as a win; a few give the TT/killers choice.
pub const LEAD_MAX_FOUND: usize = 1;
/// Resolutions examined per keep in the pre-pass (v2 bounds): the largest-lead
/// ones, since only they can decide on the stone count.
pub const LEAD_OUTCOMES_PER_KEEP: usize = 3;

struct LeadScan {
    c: Color, me: usize, them: usize,
    lead_req: i32, sixth: bool, six_req: i32,
    root: Board, examined: usize, cap: usize, out: Vec<Turn>,
}

impl LeadScan {
    #[inline] fn diff(&self, b: &Board) -> i32 { b.total[self.me] as i32 - b.total[self.them] as i32 }
    #[inline] fn decides(&self, b: &Board, casted: bool) -> bool {
        // B: wiping the enemy off the board wins whatever the count says.
        if lead_bounds_v2() && b.total[self.them] == 0 && b.total[self.me] > 0 { return true; }
        let d = self.diff(b);
        d >= self.lead_req || (casted && self.sixth && d >= self.six_req)
    }
    #[inline] fn reachable(&self, b: &Board, potential: i32, casts_possible: bool) -> bool {
        // B: a swing that can remove every enemy stone reaches a win too.
        if lead_bounds_v2() && casts_possible && potential >= b.total[self.them] as i32 && b.total[self.them] > 0 { return true; }
        let d = self.diff(b) + potential;
        d >= self.lead_req || (casts_possible && self.sixth && d >= self.six_req)
    }
    #[inline] fn won(&self, b: &Board) -> bool {
        matches!((self.c, b.outcome), (Color::Red, Outcome::RedWins) | (Color::Blue, Outcome::BlueWins))
    }
    fn verify(&mut self, t: Turn) {
        let mut b = self.root;
        b.apply_turn(&t.push_pub(Action::Pass), self.c);
        let won = matches!((self.c, b.outcome), (Color::Red, Outcome::RedWins) | (Color::Blue, Outcome::BlueWins));
        if won && !self.out.iter().any(|x| x.slice() == t.slice()) { self.out.push(t); }
    }
    fn done(&self) -> bool { self.examined >= self.cap || self.out.len() >= LEAD_MAX_FOUND }

    /// Mirrors `enumerate_post_move`: the turn may still dash and/or cast.
    fn post_move(&mut self, b: &Board, so_far: Turn, can_dash: bool, can_spell: bool,
                 can_summer: bool, post_dash: bool, casted: bool) {
        self.post_move_from(b, so_far, can_dash, can_spell, can_summer, post_dash, casted, false)
    }

    /// `post_move` with `dash_only`: skip the direct cast branch at THIS level
    /// (the two-phase root scan has already tried it) and go straight to the
    /// dash branch; casts after the dash are still explored.
    #[allow(clippy::too_many_arguments)]
    fn post_move_from(&mut self, b: &Board, so_far: Turn, can_dash: bool, can_spell: bool,
                      can_summer: bool, post_dash: bool, casted: bool, dash_only: bool) {
        if self.done() { return; }
        if self.decides(b, casted) { if !dash_only { self.verify(so_far); } return; }
        let c = self.c;
        if !self.reachable(b, b.lead_potential(c, can_dash, can_spell || (can_summer && b.holds_charged(c, crate::spells_meta::SEAL_OF_SUMMER)), 0), true) { return; }

        // --- casts first: cheap, and the audit's commonest mate shape ---
        if !dash_only && (can_spell || (can_summer && b.holds_charged(c, crate::spells_meta::SEAL_OF_SUMMER))) {
            for id in b.castable(c, can_spell, can_summer, post_dash) {
                if self.done() { return; }
                let Some(pos) = b.position_of(id) else { continue };
                // What this cast can add, plus a dash afterwards if one is still allowed.
                let after_dash = if can_dash && can_spell { 2 - b.dash_cost(c) as i32 } else { 0 };
                let pot = b.cast_swing_bound(id, c, 0) - b.clear_loss_p(pos, c, 0) + after_dash.max(0);
                if !self.reachable(b, pot, true) { continue; }
                let next_summer = if can_spell { can_summer } else { false };
                for ki in 0..b.keep_count(pos, c) {
                    let mut cl = *b;
                    cl.cast_clear_and_keep(pos, c, ki);
                    let (outs, _) = cl.resolve_outcomes(pos, c, crate::turn::OUTCOME_CAP);
                    // The lead criterion depends on the stone counts alone, so
                    // among a cast's resolutions only the ones with the largest
                    // lead (or the fewest enemy stones left) can decide, and a
                    // continuation is worth following only from those. Walking
                    // every resolution -- Flourish has hundreds, Scatter ~100 --
                    // spent the whole 2,000-board budget on one sacrifice pair,
                    // which is how a position with 2,895 winning turns came back
                    // empty at a 50,000 cap.
                    let mut order: Vec<usize> = (0..outs.len()).collect();
                    if lead_bounds_v2() {
                        order.sort_by_key(|&i| (-self.diff(&outs[i]), outs[i].total[self.them] as i32, i));
                        order.truncate(LEAD_OUTCOMES_PER_KEEP);
                        // The budget counts boards GENERATED, not boards inspected:
                        // the resolver built every outcome whether or not it is
                        // looked at, so charging only the inspected ones let the
                        // scan run far past its cap (midgame mean cost doubled).
                        self.examined += outs.len().saturating_sub(order.len());
                    }
                    for &i in &order {
                        let ob = &outs[i];
                        self.examined += 1;
                        if self.done() { return; }
                        let t = so_far.push_pub(Action::Cast { pos: pos as u8, keep: ki as u8, outcome: i as u16 });
                        if self.decides(ob, true) { self.verify(t); continue; }
                        if !(can_dash && can_spell) && !(next_summer && ob.holds_charged(c, crate::spells_meta::SEAL_OF_SUMMER)) { continue; }
                        let mut bs = cl;
                        bs.stones = ob.stones;
                        bs.update();
                        bs.finish_cast(id, c);
                        bs.update();
                        if bs.outcome != Outcome::Ongoing {
                            if lead_bounds_v2() && self.won(&bs) { self.verify(t); }
                            continue;
                        }
                        self.post_move(&bs, t, can_dash, false, next_summer, post_dash, true);
                    }
                }
            }
        }

        // --- dash (then possibly a cast) ---
        if can_dash && can_spell && b.total[self.me] > 2 && b.can_dash(c) {
            let cost = b.dash_cost(c) as usize;
            // Superset test before any sacrifice is tried: a bare dash move (+crush)
            // net of its cost, or a sigil the dash's move could complete. Sacrifices
            // only lower the material and never create fill targets.
            if !self.reachable(b, 2 - cost as i32, false)
                && b.lead_fill_targets(c, self, can_spell || can_summer) == 0
                && !b.castable(c, can_spell, can_summer, true).iter().any(|&id|
                    b.position_of(id).map_or(false, |pos|
                        self.reachable(b, 2 - cost as i32 + b.cast_swing_bound(id, c, 1) - b.clear_loss_p(pos, c, 1), true)))
            { return; }
            let mut cands: Vec<u8> = Vec::new();
            let mut m = b.dash_sacrificeable(c);
            while m != 0 { cands.push(m.trailing_zeros() as u8); m &= m - 1; }
            if cands.len() < cost { return; }
            cands.sort_by_cached_key(|&x| b.sacrifice_cost(x, c));
            let mut combos: Vec<[u8; 2]> = Vec::new();
            if cost == 1 { for &s in &cands { combos.push([s, 0]); } }
            else { for i in 0..cands.len() { for j in (i + 1)..cands.len() { combos.push([cands[i], cands[j]]); } } }
            for combo in combos {
                if self.done() { return; }
                let mut bd = *b;
                for &s in &combo[..cost] { bd.stones[self.me] &= !(1u64 << s); }
                bd.update();
                if bd.outcome != Outcome::Ongoing { continue; }
                // After the sacrifice: one placement (+crush) and the best cast it enables.
                if !self.reachable(&bd, 2 + bd.lead_potential(c, false, true, 1), true) { continue; }
                // The dash's move is worth scanning only where it can DECIDE: onto the
                // last node of a sigil whose cast can reach the lead, or anywhere when
                // the placement itself (+ a crush) already does. Unrestricted targets
                // made positions with no charged spell the most expensive of all
                // (~45 sacrifice pairs x ~20 targets, all fruitless).
                let bare = self.reachable(&bd, 2, false);
                // ...or a spell already castable after the dash (Surge, a charged
                // charm) whose effect plus the dash's placement can reach: 14 of
                // the audit's 44 uncovered mates were [move, dash, Surge, move].
                let open = bare || {
                    let mut best = i32::MIN;
                    for id in bd.castable(c, can_spell, can_summer, true) {
                        if let Some(pos) = bd.position_of(id) {
                            best = best.max(bd.cast_swing_bound(id, c, 1) - bd.clear_loss_p(pos, c, 1));
                        }
                    }
                    best > i32::MIN && self.reachable(&bd, 2 + best, true)
                };
                let dt = bd.all_moveable(c) & if open { !0u64 } else { bd.lead_fill_targets(c, self, can_spell || can_summer) };
                if dt == 0 { continue; }
                let mut sacs = combo;
                sacs[..cost].sort_unstable();
                for (node, push_to) in bd.move_variants_pub(dt, c) {
                    self.examined += 1;
                    if self.done() { return; }
                    let mut b2 = bd;
                    b2.do_move_with_pub(node, push_to, c);
                    let t = so_far.push_pub(Action::Dash { sacs, n_sacs: cost as u8, node, push_to });
                    if b2.outcome != Outcome::Ongoing {
                        if lead_bounds_v2() && self.won(&b2) { self.verify(t); }
                        continue;
                    }
                    self.post_move(&b2, t, false, can_spell, can_summer, true, casted);
                }
            }
        }
    }
}

