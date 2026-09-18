//! Exhaustive forced-win solver for the Puzzles page.
//!
//! The search in `search.rs` is a strength engine: it widens progressively,
//! windows cast outcomes, and its mate scores are proofs only when neither
//! shortcut fired (`UNPROVEN_MATE`). A puzzle needs the opposite trade: no
//! heuristics, no width limit, no evaluation -- just "does a forced win in N
//! exist, which first turns deliver it, and which reply is the hardest to
//! answer". So this module walks `enumerate_turns_exhaustive` at every node and
//! refuses (`MateError::Incomplete`) rather than reason from a truncated list.
//!
//! Terminology follows chess: mate-in-1 is one turn by the mover that ends the
//! game with the mover winning; mate-in-2 is a turn after which EVERY legal
//! reply leaves a mate-in-1. Threefold repetition is ignored: puzzles start from
//! a fresh board with no history, and the page that replays them does too.
//!
//! What is exhaustive and what is not. A midgame position has ~2e5 legal
//! turns (README: 210,263 mean), so three fully enumerated plies are out of
//! reach. The split is:
//!
//! * mate-in-1: the root is enumerated in full, so the list of winning first
//!   turns is COMPLETE and "no mate-in-1" is a proof.
//! * mate-in-2: candidate first turns are NOMINATED (by the strength engine's
//!   mate-scored root moves, and by the turn actually played in the game when
//!   it won soon after) and each candidate is then PROVEN exhaustively: every
//!   legal reply is enumerated, and after each one the mover's mate-in-1 is
//!   established by a full enumeration whenever the fast ordered probe does
//!   not find one first. So a reported mate-in-2 is a proof; a position with
//!   no reported mate-in-2 may still have one the nominator missed.
//!
//! Positions are deduplicated at every level -- several action lists routinely
//! reach the same board (a cast kept by different indices onto the same stones,
//! a hard move whose push has one destination) -- and the Puzzles page matches a
//! player's turn by the position it produces, not by the tokens it typed, so a
//! position is the natural unit here.

use std::collections::{HashMap, HashSet};

use crate::board::{Board, Color, Outcome};
use crate::turn::Turn;

/// Position key for deduplication among siblings (side to move and turn
/// counter are constant across siblings, so they are left out).
pub type Key = (u64, u64, [u8; 2], [u8; 2], [u8; 2], u8);

fn key(b: &Board) -> Key {
    let o = match b.outcome { Outcome::Ongoing => 0, Outcome::RedWins => 1, Outcome::BlueWins => 2 };
    (b.stones[0], b.stones[1], b.spell_counter, b.lock, b.springlock, o)
}

fn won_by(o: Outcome, c: Color) -> bool {
    matches!((o, c), (Outcome::RedWins, Color::Red) | (Outcome::BlueWins, Color::Blue))
}

/// The position `c` hands over after playing `t` -- exactly what `search.rs`
/// builds for a child (apply, then advance the counter and the side to move).
pub fn child(b: &Board, t: &Turn, c: Color) -> Board {
    let mut n = *b;
    n.apply_turn(t, c);
    n.turn_counter += 1;
    n.to_move = c.other();
    n
}

/// A turn of `c` that ends the game in `c`'s favour, found by FULL enumeration
/// (never the ordered generator), or `Err(())` if the enumeration exceeded `cap`
/// or a resolver cap -- the caller then proceeds without the answer. This is
/// what the search's mate-in-1 bookends call (`search.rs`).
pub fn immediate_win(b: &Board, c: Color, cap: usize) -> Result<Option<Turn>, ()> {
    let (turns, st) = b.enumerate_turns_capped(c, cap);
    if st.truncated || st.resolver_truncated { return Err(()); }
    for t in &turns {
        let n = child(b, t, c);
        if won_by(n.outcome, c) { return Ok(Some(*t)); }
    }
    Ok(None)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MateError {
    /// Some enumeration hit a cap; nothing can be claimed about this position.
    /// `(turn cap, resolver OUTCOME_CAP)` says which.
    Incomplete(bool, bool),
    /// The node budget ran out before the answer was known.
    Budget,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct MateStats {
    /// `apply_turn` calls (the unit the budget is expressed in).
    pub nodes: u64,
    /// Distinct positions reachable in one turn from the root.
    pub root_successors: usize,
}

/// One turn from the root that forces the win.
#[derive(Debug, Clone)]
pub struct Line {
    pub turn: Turn,
    pub after: Board,
    /// Mate-in-2 only: the reply chosen as the puzzle's defence, and the
    /// number of distinct mating positions the mover has against it.
    pub defence: Option<(Turn, Board)>,
    /// Mate-in-2 only: one mating turn against that defence (for "show solution").
    pub finish: Option<(Turn, Board)>,
    pub mates_after_defence: usize,
    /// Mate-in-2/3: how many distinct replies the opponent had.
    pub replies: usize,
    /// Mate-in-3 only: the PROVEN second turns against `defence`, each a
    /// mate-in-2 line (or a mate-in-1 line when the defence allows one) relative
    /// to the position after the defence.
    pub continuations: Vec<Line>,
}

pub struct Solution {
    /// Distinct positions after a mate-in-1 turn (one representative turn each).
    pub mate1: Vec<Line>,
    /// Proven mate-in-2 first turns among the nominated ones. Only computed
    /// when `mate1` is empty: a position with a mate-in-1 is a mate-in-1 puzzle.
    pub mate2: Vec<Line>,
    /// Proven mate-in-3 first turns among the nominated ones; only computed
    /// when `mate1` and `mate2` are both empty.
    pub mate3: Vec<Line>,
    pub stats: MateStats,
}

/// Turns per enumeration beyond which a position is declared unverifiable
/// (the enumerator's own cap; a position that wide is unverifiable anyway).
pub const TURN_CAP: usize = 1 << 20;
/// Ordered turns tried before falling back to a full enumeration when
/// looking for a mate-in-1 (the probe finds most mates in a few hundred).
pub const PROBE: usize = 4_000;
/// Mate-in-1 lines emitted by `solve_json` (the count is reported separately).
pub const MAX_LINES_EMITTED: usize = 512;
/// Time the nominating search gets at an INNER node (after a reply, when a
/// mate-in-2 must be found for the mover). Small on purpose: a mate-in-3
/// proof visits every reply, so this multiplies.
pub const INNER_NOMINATE_MS: u64 = 250;

struct Solver {
    budget: u64,
    deadline: Option<f64>,
    stats: MateStats,
    /// Memo for "does the mover have a mate-in-1 here", keyed by position.
    m1_memo: HashMap<Key, bool>,
    /// Replies that refuted an earlier candidate; tried first on the next one.
    killers: Vec<Turn>,
    /// The strength engine used ONLY to nominate candidate turns (one table
    /// for the whole solve; nothing it says is trusted without proof).
    se: crate::search::Search,
}

impl Solver {
    fn new(budget: u64, time_ms: u64) -> Self {
        let deadline = if time_ms > 0 { Some(crate::search::now_ms() + time_ms as f64) } else { None };
        let mut se = crate::search::Search::new(18);
        se.weights = crate::eval::weights_by_name("tfit").unwrap_or_default();
        se.set_width_scale(crate::search::DEFAULT_WIDTH_SCALE);
        let (p, e, h) = crate::search::SHIPPED_ADAPTIVE;
        se.set_adaptive(p, e, h);
        se.set_elastic(None);
        se.set_root_resort(true);
        Solver { budget, deadline, stats: MateStats::default(), m1_memo: HashMap::new(),
                 killers: Vec::new(), se }
    }

    fn time_left_ms(&self) -> Option<f64> {
        self.deadline.map(|d| d - crate::search::now_ms())
    }

    fn check_deadline(&self) -> Result<(), MateError> {
        if let Some(left) = self.time_left_ms() {
            if left <= 0.0 { return Err(MateError::Budget); }
        }
        Ok(())
    }

    /// Candidate first turns for `c` at `b` from the strength engine at
    /// `depth` plies: every root move it scores as a mate (proven or not),
    /// as position keys. A NOMINATION only -- the exhaustive check decides.
    fn nominate(&mut self, b: &Board, c: Color, depth: i32, time_ms: u64) -> Result<Vec<Key>, MateError> {
        self.check_deadline()?;
        let cap = match self.time_left_ms() {
            Some(left) => (left as u64).min(time_ms).max(50),
            None => time_ms,
        };
        let (best, score, _) = self.se.go(b, c, depth, cap);
        let mate_floor = crate::search::UNPROVEN_MATE;
        let mut keys = Vec::new();
        if score >= mate_floor {
            if let Some(t) = best { keys.push(key(&child(b, &t, c))); }
        }
        for (t, v) in self.se.root_scores() {
            if *v >= mate_floor { keys.push(key(&child(b, t, c))); }
        }
        keys.sort();
        keys.dedup();
        Ok(keys)
    }

    fn tick(&mut self) -> Result<(), MateError> {
        self.stats.nodes += 1;
        if self.stats.nodes > self.budget { return Err(MateError::Budget); }
        if self.stats.nodes % 4096 == 0 {
            if let Some(d) = self.deadline {
                if crate::search::now_ms() > d { return Err(MateError::Budget); }
            }
        }
        Ok(())
    }

    /// Every legal turn, or `Incomplete` if either cap bit. The generated
    /// count is charged to the budget: enumeration, not application, is the
    /// expensive half once casts are involved.
    fn turns(&mut self, b: &Board, c: Color) -> Result<Vec<Turn>, MateError> {
        let (turns, st) = b.enumerate_turns_capped(c, TURN_CAP);
        if st.truncated || st.resolver_truncated {
            return Err(MateError::Incomplete(st.truncated, st.resolver_truncated));
        }
        self.stats.nodes += turns.len() as u64;
        if self.stats.nodes > self.budget { return Err(MateError::Budget); }
        if let Some(d) = self.deadline {
            if crate::search::now_ms() > d { return Err(MateError::Budget); }
        }
        Ok(turns)
    }

    /// Every legal turn for `c`, one per distinct resulting position.
    fn successors(&mut self, b: &Board, c: Color) -> Result<Vec<(Turn, Board)>, MateError> {
        let turns = self.turns(b, c)?;
        let mut seen: HashSet<Key> = HashSet::with_capacity(turns.len());
        let mut out = Vec::new();
        for t in turns {
            self.tick()?;
            let n = child(b, &t, c);
            if seen.insert(key(&n)) { out.push((t, n)); }
        }
        Ok(out)
    }

    /// All distinct mating positions for `c` in one turn.
    fn mate_in_1_all(&mut self, b: &Board, c: Color) -> Result<Vec<(Turn, Board)>, MateError> {
        let succ = self.successors(b, c)?;
        Ok(succ.into_iter().filter(|(_, n)| won_by(n.outcome, c)).collect())
    }

    /// Does `c` have a mate-in-1? Memoised. Phase one walks the engine's
    /// ordered generator (decisive Seal of Destruction turns first, then the
    /// heuristic order) for `PROBE` turns; that is where a mate almost always
    /// shows up, and it costs microseconds. Phase two is the full enumeration,
    /// which is what makes a negative answer a proof.
    fn has_mate_in_1(&mut self, b: &Board, c: Color) -> Result<bool, MateError> {
        let k = key(b);
        if let Some(&v) = self.m1_memo.get(&k) { return Ok(v); }
        let mut found = false;
        for t in b.turns_ordered(c).take(PROBE) {
            self.tick()?;
            let n = child(b, &t, c);
            if won_by(n.outcome, c) { found = true; break; }
        }
        if !found {
            let turns = self.turns(b, c)?;
            for t in &turns {
                self.tick()?;
                let n = child(b, t, c);
                if won_by(n.outcome, c) { found = true; break; }
            }
        }
        self.m1_memo.insert(k, found);
        Ok(found)
    }

    /// Is `after` (opponent `o` to move) a forced mate-in-1 for `c` against
    /// every reply? Returns the replies list on success so the caller can pick
    /// a defence, or `None` when refuted.
    fn forced_after(&mut self, after: &Board, c: Color)
        -> Result<Option<Vec<(Turn, Board)>>, MateError>
    {
        let o = c.other();
        let replies = self.successors(after, o)?;
        // Killers first: the reply that refuted the previous candidate tends to
        // refute this one too, and a refutation ends the work on this branch.
        let mut idx: Vec<usize> = (0..replies.len()).collect();
        idx.sort_by_key(|&i| {
            let t = &replies[i].0;
            let is_killer = self.killers.iter().any(|k| k.slice() == t.slice());
            let mat = replies[i].1.total[o.idx()] as i32 - replies[i].1.total[c.idx()] as i32;
            (if is_killer { 0 } else { 1 }, -mat)
        });
        for &i in &idx {
            let (rt, rb) = replies[i];
            if won_by(rb.outcome, o) {
                self.remember_killer(rt);
                return Ok(None);          // the reply wins outright
            }
            if won_by(rb.outcome, c) { continue; }   // the reply loses on the spot
            if rb.outcome != Outcome::Ongoing { continue; }
            if !self.has_mate_in_1(&rb, c)? {
                self.remember_killer(rt);
                return Ok(None);
            }
        }
        Ok(Some(replies))
    }

    fn remember_killer(&mut self, t: Turn) {
        if self.killers.iter().any(|k| k.slice() == t.slice()) { return; }
        self.killers.insert(0, t);
        self.killers.truncate(4);
    }

    /// Choose the reply the puzzle will play: among replies that do not lose
    /// on the spot, the one leaving the mover the FEWEST mating positions,
    /// material lead for the defender breaking ties. Full counts are taken
    /// only for the `probe` most promising replies (a full count is a whole
    /// enumeration per reply).
    fn pick_defence(&mut self, replies: &[(Turn, Board)], c: Color, probe: usize)
        -> Result<Option<((Turn, Board), Option<(Turn, Board)>, usize)>, MateError>
    {
        let o = c.other();
        let mut cands: Vec<&(Turn, Board)> = replies.iter()
            .filter(|(_, b)| b.outcome == Outcome::Ongoing).collect();
        if cands.is_empty() {
            // Every reply loses immediately (e.g. the defender must start the
            // turn holding Seal of Destruction). Any reply will do.
            return Ok(replies.first().map(|r| (*r, None, 0)));
        }
        cands.sort_by_key(|(_, b)| -(b.total[o.idx()] as i32 - b.total[c.idx()] as i32));
        let mut best: Option<((Turn, Board), Option<(Turn, Board)>, usize)> = None;
        for r in cands.iter().take(probe.max(1)) {
            let mates = self.mate_in_1_all(&r.1, c)?;
            if best.as_ref().map_or(true, |(_, _, m)| mates.len() < *m) {
                let n = mates.len();
                best = Some(((r.0, r.1), mates.into_iter().next(), n));
            }
        }
        Ok(best)
    }
}

impl Solver {
    /// Proven mate-in-2 first turns for `c` at `b` among `cand_keys`. `want_all`
    /// false returns at the first proof (inner nodes); `probe` is how many
    /// replies `pick_defence` counts fully.
    fn mate2_lines(&mut self, b: &Board, c: Color, cand_keys: &[Key], want_all: bool, probe: usize)
        -> Result<Vec<Line>, MateError>
    {
        let mut out = Vec::new();
        if cand_keys.is_empty() { return Ok(out); }
        let root = self.successors(b, c)?;
        for (t, n) in &root {
            if n.outcome != Outcome::Ongoing { continue; }   // a suicide (or a mate-in-1)
            if !cand_keys.contains(&key(n)) { continue; }
            if let Some(replies) = self.forced_after(n, c)? {
                let replies_n = replies.len();
                let (defence, finish, mates) = match self.pick_defence(&replies, c, probe)? {
                    Some((d, f, m)) => (Some(d), f, m),
                    None => (None, None, 0),
                };
                out.push(Line { turn: *t, after: *n, defence, finish, mates_after_defence: mates,
                                replies: replies_n, continuations: Vec::new() });
                if !want_all { break; }
            }
        }
        Ok(out)
    }

    /// Mate-in-1 lines for `c` at `b` (all of them), as `Line`s.
    fn mate1_lines(&mut self, b: &Board, c: Color) -> Result<Vec<Line>, MateError> {
        Ok(self.mate_in_1_all(b, c)?.into_iter()
            .map(|(t, n)| Line { turn: t, after: n, defence: None, finish: None,
                                 mates_after_defence: 0, replies: 0, continuations: Vec::new() })
            .collect())
    }

    /// Does `c` have a PROVEN mate in at most 2 at `b` (an inner node: after the
    /// opponent's reply to the puzzle's first turn)? Mate-in-1 first (memoised),
    /// then engine-nominated second turns, each proven against every reply.
    fn has_mate_in_le2(&mut self, b: &Board, c: Color) -> Result<bool, MateError> {
        if self.has_mate_in_1(b, c)? { return Ok(true); }
        let cands = self.nominate(b, c, 3, INNER_NOMINATE_MS)?;
        Ok(!self.mate2_lines(b, c, &cands, false, 1)?.is_empty())
    }

    /// Everything `c` is proven to have against the position `b` (c to move):
    /// mate-in-1 lines if any, else all proven mate-in-2 lines. For the
    /// puzzle's third ply.
    fn continuations_at(&mut self, b: &Board, c: Color) -> Result<Vec<Line>, MateError> {
        let m1 = self.mate1_lines(b, c)?;
        if !m1.is_empty() { return Ok(m1); }
        let cands = self.nominate(b, c, 3, INNER_NOMINATE_MS * 4)?;
        self.mate2_lines(b, c, &cands, true, 3)
    }

    /// Proven mate-in-3 first turns for `c` at `b` among `cand_keys`: after every
    /// legal reply the mover has a proven mate in at most 2.
    fn mate3_lines(&mut self, b: &Board, c: Color, cand_keys: &[Key]) -> Result<Vec<Line>, MateError> {
        let o = c.other();
        let mut out = Vec::new();
        if cand_keys.is_empty() { return Ok(out); }
        let root = self.successors(b, c)?;
        'cand: for (t, n) in &root {
            if n.outcome != Outcome::Ongoing { continue; }
            if !cand_keys.contains(&key(n)) { continue; }
            let replies = self.successors(n, o)?;
            let mut idx: Vec<usize> = (0..replies.len()).collect();
            idx.sort_by_key(|&i| {
                let rt = &replies[i].0;
                let is_killer = self.killers.iter().any(|k| k.slice() == rt.slice());
                let mat = replies[i].1.total[o.idx()] as i32 - replies[i].1.total[c.idx()] as i32;
                (if is_killer { 0 } else { 1 }, -mat)
            });
            // Replies that needed a mate-in-2 (no mate-in-1 for the mover): the
            // puzzle's defence is chosen among these, hardest first by material.
            let mut needed_m2: Vec<usize> = Vec::new();
            for &i in &idx {
                let (rt, rb) = replies[i];
                if won_by(rb.outcome, o) { self.remember_killer(rt); continue 'cand; }
                if rb.outcome != Outcome::Ongoing { continue; }
                if self.has_mate_in_1(&rb, c)? { continue; }
                if !self.has_mate_in_le2(&rb, c)? { self.remember_killer(rt); continue 'cand; }
                needed_m2.push(i);
            }
            // Proven. Choose the defence: the reply (needing a mate-in-2) that
            // leaves the defender the best material; else any ongoing reply.
            let pick = needed_m2.first().copied()
                .or_else(|| idx.iter().copied().find(|&i| replies[i].1.outcome == Outcome::Ongoing))
                .or_else(|| idx.first().copied());
            let (defence, continuations) = match pick {
                Some(i) => {
                    let (rt, rb) = replies[i];
                    let conts = if rb.outcome == Outcome::Ongoing { self.continuations_at(&rb, c)? } else { Vec::new() };
                    (Some((rt, rb)), conts)
                }
                None => (None, Vec::new()),
            };
            let finish = continuations.first().and_then(|l| {
                if l.defence.is_none() { Some((l.turn, l.after)) } else { l.finish }
            });
            let mates = continuations.len();
            out.push(Line { turn: *t, after: *n, defence, finish, mates_after_defence: mates,
                            replies: replies.len(), continuations });
        }
        Ok(out)
    }
}

/// Solve `b` for the side to move: mate-in-1 lines (complete); else proven
/// mate-in-2 lines among the nominated first turns; else, if `max_mate >= 3`,
/// proven mate-in-3 lines (see the module doc). `budget` bounds `apply_turn`
/// calls plus generated turns; `time_ms` is a wall-clock cap (0 = none, and
/// the nominating searches then get 2 s each). `extra_keys` are positions
/// after first turns the caller wants nominated too (e.g. the turn actually
/// played in the recorded game).
pub fn solve(b: &Board, budget: u64, time_ms: u64, extra_keys: &[Key], max_mate: u8)
    -> Result<Solution, MateError>
{
    let c = b.to_move;
    let mut s = Solver::new(budget, time_ms);
    let root = s.successors(b, c)?;
    s.stats.root_successors = root.len();
    let mate1: Vec<Line> = root.iter()
        .filter(|(_, n)| won_by(n.outcome, c))
        .map(|(t, n)| Line { turn: *t, after: *n, defence: None, finish: None,
                             mates_after_defence: 0, replies: 0, continuations: Vec::new() })
        .collect();
    let mut sol = Solution { mate1, mate2: Vec::new(), mate3: Vec::new(), stats: s.stats };
    if !sol.mate1.is_empty() || max_mate < 2 { sol.stats = s.stats; return Ok(sol); }

    // Nomination budgets: a 3-ply search settles in a few seconds even on a
    // wide position; the 5-ply one gets more but stays a fraction of the cap.
    let root3_ms = if time_ms > 0 { (time_ms / 8).clamp(200, 8_000) } else { 2_000 };
    let root5_ms = if time_ms > 0 { (time_ms / 4).clamp(500, 45_000) } else { 5_000 };
    // ---- mate-in-2: nominated by a 3-ply search and by the caller's hints ----
    let mut cand2 = s.nominate(b, c, 3, root3_ms)?;
    cand2.extend_from_slice(extra_keys);
    cand2.sort();
    cand2.dedup();
    sol.mate2 = s.mate2_lines(b, c, &cand2, true, 6)?;
    if !sol.mate2.is_empty() || max_mate < 3 { sol.stats = s.stats; return Ok(sol); }

    // ---- mate-in-3: nominated by a 5-ply search and by the hints ----
    let mut cand3 = s.nominate(b, c, 5, root5_ms)?;
    cand3.extend_from_slice(extra_keys);
    cand3.sort();
    cand3.dedup();
    sol.mate3 = s.mate3_lines(b, c, &cand3)?;
    sol.stats = s.stats;
    Ok(sol)
}

/// `Key` of the position an SFN describes, for nominating first turns by the
/// position they reach (the generator hands in the recorded after-state).
pub fn key_of_sfn(sfn: &str) -> Option<Key> {
    Board::from_sfn(sfn).ok().map(|b| key(&b))
}

/// One line as JSON, relative to `base` (the position `c` moves from).
fn line_json(base: &Board, l: &Line, c: Color) -> String {
    let (acts, after) = base.emit_actions(&l.turn, c);
    debug_assert_eq!(key(&after), key(&l.after));
    let mut s = format!("{{\"actions\":{},\"after\":{:?}",
                        crate::actions::acts_to_json(&acts), l.after.to_sfn());
    if let Some((dt, db)) = &l.defence {
        let (dacts, dafter) = l.after.emit_actions(dt, c.other());
        debug_assert_eq!(key(&dafter), key(db));
        s.push_str(&format!(",\"defence\":{{\"actions\":{},\"after\":{:?}}},\"mates_after_defence\":{},\"replies\":{}",
                            crate::actions::acts_to_json(&dacts), db.to_sfn(),
                            l.mates_after_defence, l.replies));
        if let Some((ft, fb)) = &l.finish {
            let (facts, fafter) = db.emit_actions(ft, c);
            debug_assert_eq!(key(&fafter), key(fb));
            s.push_str(&format!(",\"finish\":{{\"actions\":{},\"after\":{:?}}}",
                                crate::actions::acts_to_json(&facts), fb.to_sfn()));
        }
        if !l.continuations.is_empty() {
            let cs: Vec<String> = l.continuations.iter().map(|x| line_json(db, x, c)).collect();
            s.push_str(&format!(",\"continuations\":[{}]", cs.join(",")));
        }
    }
    s.push('}');
    s
}

/// JSON for the puzzle generator. Action lists are the browser's
/// `applyAITurn` format (`actions.rs`), each with the SFN it must produce.
pub fn solve_json(sfn: &str, budget: u64, time_ms: u64, hint_after: &[String], max_mate: u8) -> String {
    let b = match Board::from_sfn(sfn) {
        Ok(b) => b,
        Err(e) => return format!("{{\"ok\":false,\"error\":{:?}}}", e),
    };
    if b.outcome != Outcome::Ongoing {
        return "{\"ok\":false,\"error\":\"game already over\"}".to_string();
    }
    let c = b.to_move;
    let t0 = crate::search::now_ms();
    let hints: Vec<Key> = hint_after.iter().filter_map(|h| key_of_sfn(h)).collect();
    let sol = match solve(&b, budget, time_ms, &hints, max_mate) {
        Ok(s) => s,
        Err(MateError::Incomplete(t, r)) => return format!("{{\"ok\":false,\"error\":\"enumeration incomplete\",\"turn_cap\":{},\"resolver_cap\":{}}}", t, r),
        Err(MateError::Budget) => return format!("{{\"ok\":false,\"error\":\"budget exceeded\",\"budget\":{}}}", budget),
    };
    // A position with hundreds of distinct winning turns is not a puzzle, and
    // listing them all made one result tens of megabytes; `mate1_total` keeps
    // the count for the win-fraction statistic.
    let m1: Vec<String> = sol.mate1.iter().take(MAX_LINES_EMITTED).map(|l| line_json(&b, l, c)).collect();
    let m2: Vec<String> = sol.mate2.iter().map(|l| line_json(&b, l, c)).collect();
    let m3: Vec<String> = sol.mate3.iter().map(|l| line_json(&b, l, c)).collect();
    format!("{{\"ok\":true,\"mover\":{:?},\"mate1\":[{}],\"mate1_total\":{},\"mate2\":[{}],\"mate3\":[{}],\"root_successors\":{},\"nodes\":{},\"seconds\":{:.3}}}",
            if c == Color::Red { "red" } else { "blue" },
            m1.join(","), sol.mate1.len(), m2.join(","), m3.join(","), sol.stats.root_successors, sol.stats.nodes,
            (crate::search::now_ms() - t0) / 1000.0)
}
