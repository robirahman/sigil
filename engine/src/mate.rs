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
use crate::turn::{Action, Turn};

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
    /// Mate-in-2 only: how many distinct replies the opponent had.
    pub replies: usize,
}

pub struct Solution {
    /// Distinct positions after a mate-in-1 turn (one representative turn each).
    pub mate1: Vec<Line>,
    /// Distinct positions after a mate-in-2 turn. Only computed when `mate1`
    /// is empty: a position with a mate-in-1 is a mate-in-1 puzzle.
    pub mate2: Vec<Line>,
    pub stats: MateStats,
}

/// Turns per enumeration beyond which a position is declared unverifiable
/// (the enumerator's own cap; a position that wide is unverifiable anyway).
pub const TURN_CAP: usize = 1 << 20;
/// Ordered turns tried before falling back to a full enumeration when
/// looking for a mate-in-1 (the probe finds most mates in a few hundred).
pub const PROBE: usize = 4_000;

struct Solver {
    budget: u64,
    deadline: Option<f64>,
    stats: MateStats,
    /// Memo for "does the mover have a mate-in-1 here", keyed by position.
    m1_memo: HashMap<Key, bool>,
    /// Replies that refuted an earlier candidate; tried first on the next one.
    killers: Vec<Turn>,
}

impl Solver {
    fn new(budget: u64, time_ms: u64) -> Self {
        let deadline = if time_ms > 0 { Some(crate::search::now_ms() + time_ms as f64) } else { None };
        Solver { budget, deadline, stats: MateStats::default(), m1_memo: HashMap::new(),
                 killers: Vec::new() }
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

/// Solve `b` for the side to move: mate-in-1 lines (complete), else mate-in-2
/// lines for the nominated candidates (see the module doc). `budget` bounds
/// `apply_turn` calls plus generated turns; `time_ms` is a wall-clock cap
/// (0 = none). `extra_keys` are positions after first turns that the caller
/// wants nominated too (e.g. the turn actually played in the recorded game).
pub fn solve(b: &Board, budget: u64, time_ms: u64, extra_keys: &[Key]) -> Result<Solution, MateError> {
    let c = b.to_move;
    let mut s = Solver::new(budget, time_ms);
    let root = s.successors(b, c)?;
    s.stats.root_successors = root.len();
    let mate1: Vec<Line> = root.iter()
        .filter(|(_, n)| won_by(n.outcome, c))
        .map(|(t, n)| Line { turn: *t, after: *n, defence: None, finish: None,
                             mates_after_defence: 0, replies: 0 })
        .collect();
    if !mate1.is_empty() {
        return Ok(Solution { mate1, mate2: Vec::new(), stats: s.stats });
    }

    // ---- nominate mate-in-2 candidates ----
    let mut cand_keys: Vec<Key> = extra_keys.to_vec();
    {
        // The strength engine at a fixed shallow depth, full root scoring on.
        // A mate score here -- proven or not -- is only a NOMINATION; the
        // exhaustive check below is what decides.
        let mut se = crate::search::Search::new(16);
        se.weights = crate::eval::weights_by_name("tfit").unwrap_or_default();
        se.set_width_scale(crate::search::DEFAULT_WIDTH_SCALE);
        let (p, e, h) = crate::search::SHIPPED_ADAPTIVE;
        se.set_adaptive(p, e, h);
        se.set_elastic(None);
        se.set_root_resort(true);
        let nominate_ms = if time_ms > 0 { (time_ms / 4).max(200) } else { 0 };
        let (best, score, _) = se.go(b, c, 3, nominate_ms);
        let mate_floor = crate::search::UNPROVEN_MATE;
        if score >= mate_floor {
            if let Some(t) = best { cand_keys.push(key(&child(b, &t, c))); }
        }
        for (t, v) in se.root_scores() {
            if *v >= mate_floor { cand_keys.push(key(&child(b, t, c))); }
        }
        s.stats.nodes += 1; // the nomination is not charged; note it ran
    }
    cand_keys.sort();
    cand_keys.dedup();

    let mut mate2 = Vec::new();
    for (t, n) in &root {
        if n.outcome != Outcome::Ongoing { continue; }   // a suicide, never a mate
        if !cand_keys.contains(&key(n)) { continue; }
        if let Some(replies) = s.forced_after(n, c)? {
            let replies_n = replies.len();
            let (defence, finish, mates) = match s.pick_defence(&replies, c, 6)? {
                Some((d, f, m)) => (Some(d), f, m),
                None => (None, None, 0),
            };
            mate2.push(Line { turn: *t, after: *n, defence, finish, mates_after_defence: mates,
                              replies: replies_n });
        }
    }
    Ok(Solution { mate1, mate2, stats: s.stats })
}

/// `Key` of the position an SFN describes, for nominating first turns by the
/// position they reach (the generator hands in the recorded after-state).
pub fn key_of_sfn(sfn: &str) -> Option<Key> {
    Board::from_sfn(sfn).ok().map(|b| key(&b))
}

/// JSON for the puzzle generator. Action lists are the browser's
/// `applyAITurn` format (`actions.rs`), each with the SFN it must produce.
pub fn solve_json(sfn: &str, budget: u64, time_ms: u64, hint_after: &[String]) -> String {
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
    let sol = match solve(&b, budget, time_ms, &hints) {
        Ok(s) => s,
        Err(MateError::Incomplete(t, r)) => return format!("{{\"ok\":false,\"error\":\"enumeration incomplete\",\"turn_cap\":{},\"resolver_cap\":{}}}", t, r),
        Err(MateError::Budget) => return format!("{{\"ok\":false,\"error\":\"budget exceeded\",\"budget\":{}}}", budget),
    };
    let line_json = |l: &Line| -> String {
        let (acts, after) = b.emit_actions(&l.turn, c);
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
        }
        s.push('}');
        s
    };
    let m1: Vec<String> = sol.mate1.iter().map(line_json).collect();
    let m2: Vec<String> = sol.mate2.iter().map(line_json).collect();
    format!("{{\"ok\":true,\"mover\":{:?},\"mate1\":[{}],\"mate2\":[{}],\"root_successors\":{},\"nodes\":{},\"seconds\":{:.3}}}",
            if c == Color::Red { "red" } else { "blue" },
            m1.join(","), m2.join(","), sol.stats.root_successors, sol.stats.nodes,
            (crate::search::now_ms() - t0) / 1000.0)
}
