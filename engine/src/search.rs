//! Iterative-deepening alpha-beta with a Zobrist transposition table, killer
//! moves and aspiration windows.
//!
//! EVALUATION is pure material, deliberately. `ai/ARENA_POSITIONAL_WEIGHTS.md`
//! reports three 200-game campaigns in which no positional weight set beat the
//! stone-count baseline (47.0%, 37.0%, 44.5% — the middle one significantly
//! WORSE), and `CAVEMAN_EVAL_WEIGHTS` ships as zeros. Their reading was that a
//! deep material search already prices in what those static terms describe, so
//! depth is the thing to buy first. Blue's permanent +1 counter token is included,
//! which is what makes the ±3 lead asymmetric.
//!
//! REPETITION is threefold = blue wins (Robi's ruling). The path history is
//! threaded down the search and undone on the way back up, so a repetition is
//! detected exactly where it occurs.
//!
//! TT + repetition interact badly in general (graph-history interaction): a score
//! that depended on the path's repetition counts is not reusable from a different
//! path. We handle that the safe way — nodes whose subtree saw a repetition are
//! NOT stored in the TT. That costs some table hits and keeps the search sound.

/// Monotonic milliseconds. `std::time::Instant` panics on
/// wasm32-unknown-unknown, so the browser build reads the JS clock instead.
#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    // Date.now() is monotonic enough for a per-move budget and needs no
    // performance.now() plumbing through the Worker.
    js_sys::Date::now()
}
use crate::board::{Board, Color, Outcome};
use crate::turn::{Action, Turn};

pub const WIN: i32 = 10_000_000;
pub const MAX_PLY: usize = 64;

/// Cast-outcome window the search offers the generator per node.
pub const DEFAULT_WINDOW: usize = 16;

/// PROGRESSIVE WIDENING.
///
/// Sigil's true branching factor is ~10^4 (measured: mean 210k enumerated turns
/// per position). Expanding all of them makes generation, not evaluation, the
/// bottleneck and caps the search at depth ~1 — measurably WORSE than the shipped
/// engine's 3.65, which only reaches that depth because it collapses the move set
/// to ~34.
///
/// The fix used by every engine facing this shape (Arimaa, ~17k moves/turn, is the
/// closest analogue) is to expand only the best-ordered K successors, with K
/// shrinking as depth remains. This is NOT the failure mode Robi described. The
/// old engine could not GENERATE certain moves at all, so no amount of search time
/// would find them. Here every move is generated and ranked; widening only decides
/// how many get expanded at a given depth, it is reported in `SearchStats`, and
/// raising `width_scale` recovers any of them.
#[inline]
pub fn width_for_depth(depth: i32, scale: usize) -> usize {
    let base = match depth {
        d if d >= 6 => 40,
        5 => 32,
        4 => 24,
        3 => 16,
        2 => 10,
        _ => 6,
    };
    base * scale
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Bound { Exact, Lower, Upper }

#[derive(Clone, Copy)]
struct TtEntry {
    key: u64,
    score: i32,
    depth: i8,
    bound: Bound,
    /// Only the first action, which is all move ordering needs.
    best_first: Option<Action>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SearchStats {
    pub nodes: u64,
    pub tt_hits: u64,
    pub cutoffs: u64,
    /// Deepest iteration COMPLETED (not merely started) — the honest depth number.
    pub depth_completed: i32,
    pub max_ply_seen: i32,
    pub timed_out: bool,
    /// Set if the generator's cast-outcome window truncated anywhere.
    pub windowed: bool,
    /// Set if progressive widening dropped ordered successors at some node.
    pub widened: bool,
    /// Successors actually expanded, summed — lets a caller see the effective
    /// branching factor (`expanded / nodes`).
    pub expanded: u64,
}

pub struct Search {
    tt: Vec<Option<TtEntry>>,
    mask: usize,
    killers: [[Option<Turn>; 2]; MAX_PLY],
    /// Repetition counts for positions already played in the real game.
    base_history: std::collections::HashMap<u64, u8>,
    /// Zobrist keys along the current search path.
    path: Vec<u64>,
    deadline: Option<f64>,   // absolute ms from now_ms()
    pub stats: SearchStats,
    window: usize,
    width_scale: usize,
    pub weights: crate::eval::Weights,
}

impl Search {
    /// `tt_bits` sizes the table at 2^tt_bits entries (~24 bytes each).
    pub fn new(tt_bits: u32) -> Self {
        let n = 1usize << tt_bits;
        Search {
            tt: vec![None; n],
            mask: n - 1,
            killers: [[None; 2]; MAX_PLY],
            base_history: std::collections::HashMap::new(),
            path: Vec::with_capacity(MAX_PLY),
            deadline: None,
            stats: SearchStats::default(),
            window: DEFAULT_WINDOW,
            width_scale: 1,
            weights: crate::eval::Weights::default(),
        }
    }

    pub fn set_window(&mut self, w: usize) { self.window = w; }
    /// Multiply every widening bound. 1 is the tuned default; raising it trades
    /// depth for breadth and, taken far enough, reaches full enumeration.
    pub fn set_width_scale(&mut self, s: usize) { self.width_scale = s.max(1); }

    /// Record a position that has already occurred in the real game, so the search
    /// counts repetitions against actual history rather than only its own path.
    pub fn add_history(&mut self, key: u64) {
        *self.base_history.entry(key).or_insert(0) += 1;
    }

    #[inline]
    fn eval(&self, b: &Board, c: Color) -> i32 { b.evaluate(c, &self.weights) }

    #[inline]
    fn terminal_score(b: &Board, c: Color, ply: i32) -> i32 {
        // Prefer faster wins and slower losses.
        match b.outcome {
            Outcome::RedWins => if c == Color::Red { WIN - ply } else { -(WIN - ply) },
            Outcome::BlueWins => if c == Color::Blue { WIN - ply } else { -(WIN - ply) },
            Outcome::Ongoing => 0,
        }
    }

    #[inline]
    fn rep_count(&self, key: u64) -> u8 {
        let base = *self.base_history.get(&key).unwrap_or(&0);
        base + self.path.iter().filter(|&&k| k == key).count() as u8
    }

    /// Iterative deepening. Returns (best turn, score, stats).
    pub fn go(&mut self, root: &Board, c: Color, max_depth: i32, time_ms: u64)
        -> (Option<Turn>, i32, SearchStats)
    {
        self.deadline = if time_ms > 0 { Some(now_ms() + time_ms as f64) } else { None };
        self.stats = SearchStats::default();
        self.path.clear();

        // The best move is committed ONLY when an iteration completes. Accepting a
        // move from a timed-out iteration is a classic strength bug: the partial
        // search may have scored only a few successors, so its "best" can be worse
        // than the fully-searched choice from the previous depth.
        let mut best: Option<Turn> = None;
        let mut best_score = 0i32;
        let mut prev = 0i32;

        for depth in 1..=max_depth {
            // Aspiration window around the previous score, matching the existing
            // engine's ±0.15-of-a-stone idea scaled to integer material.
            let (mut alpha, mut beta) = if depth <= 2 { (-WIN, WIN) } else { (prev - 60, prev + 60) };
            let mut score;
            let mut iter_best: Option<Turn> = best;   // seed ordering with the last best
            loop {
                score = self.root_search(root, c, depth, alpha, beta, &mut iter_best);
                if self.stats.timed_out { break; }
                if score <= alpha && alpha > -WIN { alpha = -WIN; beta = WIN; continue; }
                if score >= beta && beta < WIN { alpha = -WIN; beta = WIN; continue; }
                break;
            }
            if self.stats.timed_out { break; }          // discard the partial result
            if iter_best.is_some() { best = iter_best; }
            prev = score;
            best_score = score;
            self.stats.depth_completed = depth;
            if score.abs() >= WIN - MAX_PLY as i32 { break; }   // decisive
        }
        (best, best_score, self.stats)
    }

    fn root_search(&mut self, b: &Board, c: Color, depth: i32,
                   mut alpha: i32, beta: i32, best: &mut Option<Turn>) -> i32
    {
        let mut best_local = *best;
        let mut best_val = -WIN * 2;
        // The root gets the widest look: a mistake here is unrecoverable.
        let w = width_for_depth(depth, self.width_scale) * 3;
        let turns = self.ordered_turns(b, c, 0, best_local, w);
        for t in turns {
            if self.out_of_time() { self.stats.timed_out = true; break; }
            let mut child = *b;
            child.apply_turn(&t, c);
            child.turn_counter += 1;
            child.to_move = c.other();
            let key = crate::zobrist::ZOBRIST.key_js(&child);
            let v = -self.negamax(&child, c.other(), depth - 1, -beta, -alpha, 1, key);
            if v > best_val {
                best_val = v;
                best_local = Some(t);
                if v > alpha { alpha = v; }
            }
            if alpha >= beta { self.stats.cutoffs += 1; break; }
        }
        // Only hand back a move if this call actually finished; otherwise the
        // caller keeps the previous iteration's fully-searched choice.
        if !self.stats.timed_out && best_local.is_some() { *best = best_local; }
        best_val
    }

    fn negamax(&mut self, b: &Board, c: Color, depth: i32,
               mut alpha: i32, beta: i32, ply: i32, key: u64) -> i32
    {
        self.stats.nodes += 1;
        self.stats.max_ply_seen = self.stats.max_ply_seen.max(ply);
        if (ply as usize) >= MAX_PLY - 1 { return self.eval(b, c); }

        // Threefold repetition ends the game with BLUE winning.
        let mut saw_repetition = false;
        if self.rep_count(key) + 1 >= 3 {
            saw_repetition = true;
            return if c == Color::Blue { WIN - ply } else { -(WIN - ply) };
        }
        if b.outcome != Outcome::Ongoing { return Self::terminal_score(b, c, ply); }
        if depth <= 0 { return self.eval(b, c); }
        if self.out_of_time() { self.stats.timed_out = true; return self.eval(b, c); }

        // --- transposition table ---
        let slot = (key as usize) & self.mask;
        let mut tt_move: Option<Action> = None;
        if let Some(e) = self.tt[slot] {
            if e.key == key {
                self.stats.tt_hits += 1;
                tt_move = e.best_first;
                if e.depth as i32 >= depth {
                    match e.bound {
                        Bound::Exact => return e.score,
                        Bound::Lower => if e.score >= beta { return e.score; },
                        Bound::Upper => if e.score <= alpha { return e.score; },
                    }
                }
            }
        }

        let alpha_orig = alpha;
        let mut best_val = -WIN * 2;
        let mut best_turn: Option<Turn> = None;

        self.path.push(key);
        let w = width_for_depth(depth, self.width_scale);
        let turns = self.ordered_turns_action_hint(b, c, ply as usize, tt_move, w);
        for t in turns {
            if self.out_of_time() { self.stats.timed_out = true; break; }
            let mut child = *b;
            child.apply_turn(&t, c);
            child.turn_counter += 1;
            child.to_move = c.other();
            let ckey = crate::zobrist::ZOBRIST.key_js(&child);
            if self.rep_count(ckey) + 1 >= 3 { saw_repetition = true; }
            let v = -self.negamax(&child, c.other(), depth - 1, -beta, -alpha, ply + 1, ckey);
            if v > best_val {
                best_val = v;
                best_turn = Some(t);
                if v > alpha { alpha = v; }
            }
            if alpha >= beta {
                self.stats.cutoffs += 1;
                // Killer: remember the refutation for this ply.
                let p = (ply as usize).min(MAX_PLY - 1);
                if self.killers[p][0].map(|k| k.slice()[0]) != Some(t.slice()[0]) {
                    self.killers[p][1] = self.killers[p][0];
                    self.killers[p][0] = Some(t);
                }
                break;
            }
        }
        self.path.pop();

        // Do NOT cache a score whose subtree depended on repetition counts: it is
        // only valid for the path we reached it by (graph-history interaction).
        if !saw_repetition && !self.stats.timed_out {
            let bound = if best_val <= alpha_orig { Bound::Upper }
                        else if best_val >= beta { Bound::Lower }
                        else { Bound::Exact };
            let replace = match self.tt[slot] {
                None => true,
                Some(e) => e.key == key || (e.depth as i32) <= depth,
            };
            if replace {
                self.tt[slot] = Some(TtEntry {
                    key, score: best_val, depth: depth as i8, bound,
                    best_first: best_turn.map(|t| t.slice()[0]),
                });
            }
        }
        best_val
    }

    /// Ordered turns with the TT/killer hints promoted to the front.
    fn ordered_turns(&mut self, b: &Board, c: Color, ply: usize, hint: Option<Turn>,
                     width: usize) -> Vec<Turn>
    {
        self.ordered_turns_action_hint(b, c, ply, hint.map(|t| t.slice()[0]), width)
    }

    fn ordered_turns_action_hint(&mut self, b: &Board, c: Color, ply: usize,
                                 hint: Option<Action>, width: usize) -> Vec<Turn>
    {
        // Pull only `width` turns from the LAZY generator. Collecting everything
        // here was what capped the search at depth ~1: generation, not evaluation,
        // dominated. The iterator is best-first, so this is a beam over a ranked
        // stream rather than a blind truncation.
        let mut it = b.turns_ordered_window(c, self.window);
        let mut v: Vec<Turn> = it.by_ref().take(width).collect();
        if it.next().is_some() { self.stats.widened = true; }
        if it.windowed { self.stats.windowed = true; }
        self.stats.expanded += v.len() as u64;
        // Promote the TT move, then the two killers, by matching first action.
        let p = ply.min(MAX_PLY - 1);
        let k0 = self.killers[p][0].map(|t| t.slice()[0]);
        let k1 = self.killers[p][1].map(|t| t.slice()[0]);
        v.sort_by_key(|t| {
            let a = t.slice()[0];
            if Some(a) == hint { 0 }
            else if Some(a) == k0 { 1 }
            else if Some(a) == k1 { 2 }
            else { 3 }
        });
        v
    }

    #[inline]
    fn out_of_time(&self) -> bool {
        match self.deadline { Some(d) => now_ms() >= d, None => false }
    }
}

impl Search {
    /// Choose among candidate SUCCESSOR positions supplied by the caller.
    ///
    /// This exists so the engine can drive the real web UI without any
    /// turn-representation translation. The browser enumerates its own legal
    /// turns, applies each with its own rules, and sends the resulting positions;
    /// we search from each and return the index of the best. The move that comes
    /// back is therefore guaranteed to be one the UI can apply and animate, and
    /// `applyAITurn` records it in the game history exactly as for any other AI.
    ///
    /// The honest trade: the engine can only pick from what the browser's
    /// enumerator offered. That enumerator is capped, so this is a weaker engine
    /// than the standalone one, which generates ~4,000x more turns. The
    /// `candidates` count is returned so a caller can surface that.
    ///
    /// `positions` are AFTER our move, so the side to move in each is the
    /// opponent and the score must be negated.
    pub fn pick_successor(&mut self, positions: &[Board], us: Color,
                          max_depth: i32, time_ms: u64)
        -> (usize, i32, SearchStats)
    {
        self.deadline = if time_ms > 0 { Some(now_ms() + time_ms as f64) } else { None };
        self.stats = SearchStats::default();
        self.path.clear();
        if positions.is_empty() { return (0, 0, self.stats); }

        let mut best_idx = 0usize;
        let mut best_score = -WIN * 2;
        let mut order: Vec<usize> = (0..positions.len()).collect();

        for depth in 1..=max_depth {
            let mut alpha = -WIN;
            let mut iter_best = best_idx;
            let mut iter_score = -WIN * 2;
            let mut completed = true;
            for &i in &order {
                if self.out_of_time() { self.stats.timed_out = true; completed = false; break; }
                let child = positions[i];
                let key = crate::zobrist::ZOBRIST.key_js(&child);
                // Terminal positions are scored directly; otherwise search.
                let v = if child.outcome != Outcome::Ongoing {
                    Self::terminal_score(&child, us, 1)
                } else if self.rep_count(key) + 1 >= 3 {
                    // Threefold is a blue win, from `us`'s point of view.
                    if us == Color::Blue { WIN - 1 } else { -(WIN - 1) }
                } else {
                    -self.negamax(&child, us.other(), depth - 1, -WIN, -alpha, 1, key)
                };
                if v > iter_score { iter_score = v; iter_best = i; }
                if v > alpha { alpha = v; }
            }
            if !completed { break; }
            best_idx = iter_best;
            best_score = iter_score;
            self.stats.depth_completed = depth;
            // Search the previous best first next time.
            order.sort_by_key(|&i| if i == best_idx { 0 } else { 1 });
            if best_score.abs() >= WIN - MAX_PLY as i32 { break; }
        }
        (best_idx, best_score, self.stats)
    }
}

/// Convert an engine score (centistones) into the units the web UI renders.
///
/// The UI (`game-board-local.js:1140-1158`) speaks Caveman units, where the leaf
/// eval is `(stoneDiff + positional) / 39`, so one stone is `1/39 ≈ 0.0256`; it
/// then displays `score * 39` as stones. Our centistones put one stone at 100, a
/// **3900x** difference — feeding raw centistones in reported a −0.18 stone
/// position as `eval -702.0`.
///
/// Worse, the UI treats `|score| >= CAVEMAN_PROVEN_MIN` (37) as a PROVEN mate and
/// prints `win in round(100 - score)`. Un-scaled scores clear 37 at ±0.37 stones,
/// i.e. in almost every real position, so ordinary evaluations were rendered as
/// forced wins — one showed as `win in -94`, the negative ply count being the tell.
///
/// So: mate scores map onto Caveman's own mate encoding (`CAVEMAN_WIN - ply`, with
/// `CAVEMAN_WIN = 100`), and everything else scales by 1/3900. A scaled non-mate
/// score cannot reach 37 (that would need ~1,443 stones), so it can never be
/// misread as a mate.
pub fn ui_score(centistones: i32) -> f64 {
    const CAVEMAN_WIN: f64 = 100.0;
    let mate_floor = WIN - MAX_PLY as i32;
    if centistones.abs() >= mate_floor {
        // Our terminal score is WIN - ply, so ply = WIN - |score|.
        let ply = (WIN - centistones.abs()) as f64;
        let s = CAVEMAN_WIN - ply;
        return if centistones >= 0 { s } else { -s };
    }
    centistones as f64 / 3900.0
}
