//! §2 learned move-ordering prior: INPUTS and PART ENCODING (the data side).
//!
//! The prior scores a candidate turn as a sum over its DISCRETE PARTS, each
//! crossed with a per-position context vector, so that deciding WHICH cast/dash
//! stubs to generate costs a few table lookups per candidate and never a board
//! copy. This module defines, in one place shared by training and serving:
//!
//! * `context_inputs`   -- the integer position vector `x` (`NX` dims),
//! * `turn_parts`       -- the part indices of a turn (`MAX_PARTS`, padded),
//! * `dataset_rows`     -- the full ordered candidate universe of a position
//!                         with parts, stub ids and within-stub ranks, for the
//!                         label generator (`harness/selfplay_prior.py`).
//!
//! Everything here is integer and deterministic: the Python trainer regenerates
//! its inputs THROUGH these bindings, so train and serve cannot drift.
use crate::board::{Board, Color};
use crate::topology::{SIGIL, VOID};
use crate::turn::{Action, Turn};

/// Context vector width.
pub const NX: usize = 170;
/// Parts per turn (padded with `NO_PART`).
pub const MAX_PARTS: usize = 16;
pub const NO_PART: u16 = u16::MAX;

// Part vocabulary layout (bases). Keep in sync with `PART_NAMES` and the
// trainer's `--export`; a test asserts the total.
pub const P_KIND: u16 = 0;          // 6: soft, push, crush, blink_soft, blink_push, blink_crush
pub const P_NODE: u16 = 6;          // 39
pub const P_PUSH: u16 = 45;         // 40 (39 = none)
pub const P_MS: u16 = 85;           // 12 move_score buckets
pub const P_DASH: u16 = 97;         // 1
pub const P_NSACS: u16 = 98;        // 2
pub const P_SAC: u16 = 100;         // 39 (multi-hot, up to 2)
pub const P_LAND: u16 = 139;        // 39 dash landing node
pub const P_LPUSH: u16 = 178;       // 40 dash push_to (39 = none)
pub const P_LKIND: u16 = 218;       // 3 soft / push / crush
pub const P_CAST: u16 = 221;        // 39 spell id
pub const P_CPOS: u16 = 260;        // 9 sigil pos
pub const P_KEEP: u16 = 269;        // 4 keep bucket {0,1,2,3+}
pub const P_ORANK: u16 = 273;       // 6 within-stub outcome rank {0,1,2,3,4-7,8+}
pub const P_CAST2: u16 = 279;       // 1 second cast present
pub const P_CLASS: u16 = 280;       // 4 move / move+cast / move+dash / move+dash+cast
pub const NP: usize = 284;

const MS_EDGES: [i32; 11] = [-50, 0, 20, 40, 60, 80, 100, 130, 160, 200, 260];

#[inline]
fn ms_bucket(score: i32) -> u16 {
    let mut b = 0u16;
    for e in MS_EDGES { if score > e { b += 1; } }
    b
}

#[inline]
fn keep_bucket(k: u8) -> u16 { (k as u16).min(3) }

#[inline]
pub fn orank_bucket(r: usize) -> u16 {
    match r { 0 => 0, 1 => 1, 2 => 2, 3 => 3, 4..=7 => 4, _ => 5 }
}

impl Board {
    /// Integer context of the position from `c`'s point of view. Every input is
    /// a quantity the board already maintains or a cheap query; the two
    /// `castable` calls dominate (~0.5 us). See the layout comments.
    pub fn context_inputs(&self, c: Color) -> [i16; NX] {
        let mut x = [0i16; NX];
        let mine = self.mine(c);
        let theirs = self.theirs(c);
        let mut i = 0;
        // 18: sigil fill counts, mine then theirs
        for p in 0..9 { x[i] = (SIGIL[p] & mine).count_ones() as i16; i += 1; }
        for p in 0..9 { x[i] = (SIGIL[p] & theirs).count_ones() as i16; i += 1; }
        // 18: charged flags
        for p in 0..9 { x[i] = ((self.charged[c.idx()] >> p) & 1) as i16; i += 1; }
        for p in 0..9 { x[i] = ((self.charged[c.other().idx()] >> p) & 1) as i16; i += 1; }
        // 18: castable-now by sigil pos
        for id in self.castable(c, true, true, false) {
            if let Some(p) = self.position_of(id) { x[i + p] = 1; }
        }
        i += 9;
        for id in self.castable(c.other(), true, true, false) {
            if let Some(p) = self.position_of(id) { x[i + p] = 1; }
        }
        i += 9;
        // 18: one stone short of charged
        for p in 0..9 { x[i] = (self.uncontrolled_count(p, c) == 1) as i16; i += 1; }
        for p in 0..9 { x[i] = (self.uncontrolled_count(p, c.other()) == 1) as i16; i += 1; }
        // 20 scalars
        let red = self.total[0] as i32; let blue = self.total[1] as i32;
        let lead = if c == Color::Red { red - (blue + 1) } else { (blue + 1) - red };
        let (own0, own1) = self.liberty_census_pub(c);
        let (en0, en1) = self.liberty_census_pub(c.other());
        let scalars: [i16; 20] = [
            self.total[c.idx()] as i16, self.total[c.other().idx()] as i16,
            self.mana[c.idx()] as i16, self.mana[c.other().idx()] as i16,
            (mine & VOID).count_ones() as i16, (theirs & VOID).count_ones() as i16,
            self.spell_counter[c.idx()] as i16, self.spell_counter[c.other().idx()] as i16,
            self.turn_counter.min(40) as i16, (c == Color::Red) as i16,
            self.empty().count_ones() as i16,
            own0 as i16, own1 as i16, en0 as i16, en1 as i16,
            self.dash_cost(c) as i16, self.can_dash(c) as i16,
            (self.lock[c.idx()] != crate::board::NO_SPELL) as i16,
            (self.lock[c.other().idx()] != crate::board::NO_SPELL) as i16,
            lead as i16,
        ];
        x[i..i + 20].copy_from_slice(&scalars); i += 20;
        // 78: occupancy, mine then theirs
        for n in 0..39 { x[i] = ((mine >> n) & 1) as i16; i += 1; }
        for n in 0..39 { x[i] = ((theirs >> n) & 1) as i16; i += 1; }
        debug_assert_eq!(i, NX);
        x
    }

    /// Part indices of `t` for `c` on this board. `orank` is the turn's rank
    /// within its cast stub under the heuristic outcome order (0 for non-casts).
    /// `move_score` is supplied by the caller (the generator has it; the
    /// dataset recomputes it) so the serve path never re-derives it.
    pub fn turn_parts(&self, t: &Turn, c: Color, move_score: i32, orank: usize) -> [u16; MAX_PARTS] {
        let mut parts = [NO_PART; MAX_PARTS];
        let mut n = 0usize;
        let mut push = |p: u16, parts: &mut [u16; MAX_PARTS]| {
            if n < MAX_PARTS { parts[n] = p; n += 1; }
        };
        let acts = t.slice();
        let mut has_dash = false;
        let mut casts = 0u8;
        let mut post = *self;       // board after the first move, for dash landing kind
        for (ai, a) in acts.iter().enumerate() {
            match *a {
                Action::Move { node, push_to } | Action::Blink { node, push_to } => {
                    if ai == 0 {
                        let blink = matches!(a, Action::Blink { .. });
                        let enemy = self.theirs(c) & (1u64 << node) != 0;
                        let kind = match (blink, enemy, push_to) {
                            (false, false, _) => 0, (false, true, Some(_)) => 1, (false, true, None) => 2,
                            (true, false, _) => 3, (true, true, Some(_)) => 4, (true, true, None) => 5,
                        };
                        push(P_KIND + kind, &mut parts);
                        push(P_NODE + node as u16, &mut parts);
                        push(P_PUSH + push_to.map(|d| d as u16).unwrap_or(39), &mut parts);
                        push(P_MS + ms_bucket(move_score), &mut parts);
                        post.do_move_with_pub(node, push_to, c);
                    }
                }
                Action::Dash { sacs, n_sacs, node, push_to } => {
                    has_dash = true;
                    push(P_DASH, &mut parts);
                    push(P_NSACS + (n_sacs as u16).clamp(1, 2) - 1, &mut parts);
                    for s in &sacs[..(n_sacs as usize).min(2)] { push(P_SAC + *s as u16, &mut parts); }
                    push(P_LAND + node as u16, &mut parts);
                    push(P_LPUSH + push_to.map(|d| d as u16).unwrap_or(39), &mut parts);
                    let enemy = post.theirs(c) & (1u64 << node) != 0;
                    let lk = match (enemy, push_to) { (false, _) => 0, (true, Some(_)) => 1, (true, None) => 2 };
                    push(P_LKIND + lk, &mut parts);
                }
                Action::Cast { pos, keep, .. } => {
                    casts += 1;
                    if casts == 1 {
                        let id = self.spells[pos as usize] as u16;
                        push(P_CAST + id.min(38), &mut parts);
                        push(P_CPOS + pos as u16, &mut parts);
                        push(P_KEEP + keep_bucket(keep), &mut parts);
                        push(P_ORANK + orank_bucket(orank), &mut parts);
                    } else {
                        push(P_CAST2, &mut parts);
                    }
                }
                Action::Pass => {}
            }
        }
        let class = match (has_dash, casts > 0) { (false, false) => 0, (false, true) => 1,
                                                  (true, false) => 2, (true, true) => 3 };
        push(P_CLASS + class, &mut parts);
        parts
    }

    /// The ordered candidate universe of this position (the shipped generator,
    /// drained to `cap`), each with its parts, a STUB id and its rank within the
    /// stub. A stub is the generator's own choice point: `[move, pass]` turns are
    /// their own stub; cast turns group by (first action, cast pos); dash turns
    /// by (first action, dash); dash+cast by (first action, dash, cast pos).
    /// Returns (rows, stub_ids, within_ranks, packed action lists, truncated).
    pub fn dataset_rows(&self, c: Color, cap: usize)
        -> (Vec<[u16; MAX_PARTS]>, Vec<u16>, Vec<u16>, Vec<Vec<u32>>, bool)
    {
        let goal = self.placement_goal(c);
        let mut rows = Vec::new();
        let mut stubs: Vec<u16> = Vec::new();
        let mut ranks: Vec<u16> = Vec::new();
        let mut packed: Vec<Vec<u32>> = Vec::new();
        let mut stub_keys: Vec<(Action, u8, u8, Option<Action>)> = Vec::new(); // (first, has_dash, cast_pos+1, dash action)
        let mut stub_counts: Vec<u16> = Vec::new();
        let mut it = self.turns_ordered(c);
        let mut n = 0usize;
        for t in it.by_ref() {
            if n >= cap { break; }
            n += 1;
            let acts = t.slice();
            let first = acts[0];
            let (node, push_to) = match first {
                Action::Move { node, push_to } | Action::Blink { node, push_to } => (node, push_to),
                _ => (0, None),
            };
            let ms = match first {
                Action::Move { .. } | Action::Blink { .. } => self.move_score_goal(node, push_to, c, goal),
                _ => 0,
            };
            let dash = acts.iter().find(|a| matches!(a, Action::Dash { .. })).copied();
            let cast_pos = acts.iter().find_map(|a| match a { Action::Cast { pos, .. } => Some(*pos + 1), _ => None }).unwrap_or(0);
            let key = (first, dash.is_some() as u8, cast_pos, dash);
            let sid = match stub_keys.iter().position(|k| *k == key) {
                Some(i) => i,
                None => { stub_keys.push(key); stub_counts.push(0); stub_keys.len() - 1 }
            };
            let rank = stub_counts[sid] as usize;
            stub_counts[sid] += 1;
            rows.push(self.turn_parts(&t, c, ms, if cast_pos > 0 { rank } else { 0 }));
            stubs.push(sid as u16);
            ranks.push(rank as u16);
            packed.push(acts.iter().map(|a| crate::search::pack_action(*a)).collect());
        }
        let truncated = it.next().is_some();
        (rows, stubs, ranks, packed, truncated)
    }
}

pub const PART_GROUPS: [(&str, u16, u16); 16] = [
    ("kind", P_KIND, 6), ("node", P_NODE, 39), ("push", P_PUSH, 40), ("ms", P_MS, 12),
    ("dash", P_DASH, 1), ("nsacs", P_NSACS, 2), ("sac", P_SAC, 39), ("land", P_LAND, 39),
    ("lpush", P_LPUSH, 40), ("lkind", P_LKIND, 3), ("cast", P_CAST, 39), ("cpos", P_CPOS, 9),
    ("keep", P_KEEP, 4), ("orank", P_ORANK, 6), ("cast2", P_CAST2, 1), ("class", P_CLASS, 4),
];
