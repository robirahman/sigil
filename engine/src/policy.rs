//! Step 4 (2026-10 training plan): a learned policy INSIDE the turn generator.
//!
//! The ordered stream (`turn_iter.rs`) emits turns stage-major: every
//! `[move, pass]` first, then every cast under every move, then the dashes.
//! The linear re-ranker (`ranker.rs`) could only reorder FINISHED turns, so it
//! had to generate more than the search expanded and doubled node cost. This
//! module instead puts a learned score at each of the generator's own choice
//! points and expands the turn tree BEST-FIRST by the product of the choice
//! probabilities, so a branch nobody wants is never built:
//!
//! ```text
//!   M  first step (move, + Providence placement)      softmax over steps
//!   P  stop after the move, or continue               binary
//!   S  continue with which cast / the dash            softmax, on the post-move board
//!   C  that cast's (keep, outcome)                    softmax over the window
//!   D  the dash's (sacrifices, landing)               softmax over the dash branches
//!   P2 stop after the dash, or cast                   binary
//!   S2 which post-dash cast                           softmax
//!   Z  stop after a cast, or Seal of Summer's second  binary
//!   S3 which second cast                              softmax
//! ```
//!
//! Every level is a log-softmax, so a child's log-probability never exceeds its
//! parent's and a max-heap on the running log-probability pops whole turns in
//! exactly non-increasing probability: a width-`w` budget is "the `w` most
//! probable turns", whatever classes they fall in. The candidate SETS inside a
//! cast or a dash are the shipped generator's own (same windows, same keep
//! budget, same resolver orders); the policy only decides which to build and in
//! what order. Its heuristic ranks are inputs, so an all-zero weight vector
//! leaves the within-stub orders as they ship.
//!
//! The model is log-linear and closed-form from boards the generator already
//! holds (no `apply_turn`): an option's logit is a sum over its sparse binary
//! features `f` of `w[f] . [1, z]`, `z` a 6-vector of position context computed
//! once per node. Logits are quantised to 1/256 nat and normalised with an
//! integer log-sum-exp table (`policy_lse.rs`), so priorities are bit-identical
//! in the native and wasm builds; `tests.rs` pins that with fixed values.
//!
//! Training data comes from `policy_example`, which walks the SAME expansions
//! along a target turn's path and records each level's options and the target's
//! index -- train and serve share one feature code path by construction.
//! `engine/harness/policy_train.py` fits the weights and writes
//! `policy_weights.rs`.
use std::cell::{Cell, RefCell};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, VecDeque};
use std::rc::Rc;

use crate::board::{Board, Color};
use crate::policy_lse::LSE_T;
use crate::spells_meta::SEAL_OF_SUMMER;
use crate::topology::SIGIL;
use crate::turn::{Action, Turn, OUTCOME_CAP};
use crate::turn_iter::{dash_summer_enabled, front_prepass, stratify_by_keep, TurnIter, MAX_KEEP_WINDOW};

/// Context dims (`z`); each feature row is `[bias, z...]`.
pub const PK: usize = 6;
pub const PW: usize = PK + 1;

pub const L_M: u8 = 0;
pub const L_P: u8 = 1;
pub const L_S: u8 = 2;
pub const L_D: u8 = 3;
pub const L_P2: u8 = 4;
pub const L_S2: u8 = 5;
pub const L_C: u8 = 6;
pub const L_Z: u8 = 7;
pub const L_S3: u8 = 8;
pub const N_LEVELS: usize = 9;

/// Spell-id vocabulary per spell-keyed group (ids >= 64 get no feature).
const NSP: u16 = 64;

// Feature layout. Keep in sync with `FEATURE_GROUPS` (a test asserts the total)
// and with `policy_train.py`, which reads the groups through the binding.
pub const F_M_KIND: u16 = 0;      // 6 soft, push, crush, blink_soft, blink_push, blink_crush
pub const F_M_NODE: u16 = 6;      // 39
pub const F_M_PUSH: u16 = 45;     // 40 (39 = none)
pub const F_M_MS: u16 = 85;       // 12 move-score buckets
pub const F_M_RANK: u16 = 97;     // 9 heuristic rank buckets
pub const F_M_PLACE: u16 = 106;   // 40 Providence placement node (39 = none)
pub const F_M_COMPL: u16 = 146;   // 64 spell whose sigil the step completes
pub const F_M_BREAK: u16 = 210;   // 64 enemy charged spell the step breaks
pub const F_P_BIAS: u16 = 274;    // 1 continue
pub const F_P_KIND: u16 = 275;    // 6
pub const F_P_MS: u16 = 281;      // 12
pub const F_P_COMPL: u16 = 293;   // 64
pub const F_P_NCAST: u16 = 357;   // 4 castable now {0,1,2,3+}
pub const F_P_DASH: u16 = 361;    // 1 dash affordable now
pub const F_P_CASTID: u16 = 362;  // 64 multi-hot castable now
pub const F_S_CAST: u16 = 426;    // 64 cast spell id
pub const F_S_CPOS: u16 = 490;    // 9 cast sigil pos
pub const F_S_NEW: u16 = 499;     // 1 castable only after the move
pub const F_S_NEWID: u16 = 500;   // 64 spell id, castable only after the move
pub const F_S_DASH: u16 = 564;    // 1 the dash option
pub const F_S_DCOST: u16 = 565;   // 2 dash cost 1 / 2
pub const F_D_LAND: u16 = 567;    // 39
pub const F_D_LPUSH: u16 = 606;   // 40 (39 = none)
pub const F_D_LKIND: u16 = 646;   // 3 soft / push / crush
pub const F_D_NSACS: u16 = 649;   // 2
pub const F_D_SAC: u16 = 651;     // 39 multi-hot
pub const F_D_RANK: u16 = 690;    // 9
pub const F_D_COMPL: u16 = 699;   // 64 spell newly charged by the dash
pub const F_P2_BIAS: u16 = 763;   // 1
pub const F_P2_CASTID: u16 = 764; // 64
pub const F_S2_CAST: u16 = 828;   // 64
pub const F_S2_NEW: u16 = 892;    // 1
pub const F_C_RANK: u16 = 893;    // 9 joint (stratified) rank
pub const F_C_KEEPR: u16 = 902;   // 4 keep rank {0,1,2,3+}
pub const F_C_ORANK: u16 = 906;   // 6 rank within the keep {0,1,2,3,4-7,8+}
pub const F_C_DMINE: u16 = 912;   // 7 caster's material change, clamped -3..3
pub const F_C_DTHEIRS: u16 = 919; // 7 enemy's material change, clamped -3..3
pub const F_C_SPELLR: u16 = 926;  // 64 x 3 spell x coarse within-keep rank {0, 1-3, 4+}
pub const F_Z_BIAS: u16 = 1118;   // 1
pub const F_Z_CASTID: u16 = 1119; // 64
pub const F_S3_CAST: u16 = 1183;  // 64
pub const NF: usize = 1247;

pub const FEATURE_GROUPS: [(&str, u16, u16); 41] = [
    ("m_kind", F_M_KIND, 6), ("m_node", F_M_NODE, 39), ("m_push", F_M_PUSH, 40),
    ("m_ms", F_M_MS, 12), ("m_rank", F_M_RANK, 9), ("m_place", F_M_PLACE, 40),
    ("m_compl", F_M_COMPL, 64), ("m_break", F_M_BREAK, 64),
    ("p_bias", F_P_BIAS, 1), ("p_kind", F_P_KIND, 6), ("p_ms", F_P_MS, 12),
    ("p_compl", F_P_COMPL, 64), ("p_ncast", F_P_NCAST, 4), ("p_dash", F_P_DASH, 1),
    ("p_castid", F_P_CASTID, 64),
    ("s_cast", F_S_CAST, 64), ("s_cpos", F_S_CPOS, 9), ("s_new", F_S_NEW, 1),
    ("s_newid", F_S_NEWID, 64), ("s_dash", F_S_DASH, 1), ("s_dcost", F_S_DCOST, 2),
    ("d_land", F_D_LAND, 39), ("d_lpush", F_D_LPUSH, 40), ("d_lkind", F_D_LKIND, 3),
    ("d_nsacs", F_D_NSACS, 2), ("d_sac", F_D_SAC, 39), ("d_rank", F_D_RANK, 9),
    ("d_compl", F_D_COMPL, 64),
    ("p2_bias", F_P2_BIAS, 1), ("p2_castid", F_P2_CASTID, 64),
    ("s2_cast", F_S2_CAST, 64), ("s2_new", F_S2_NEW, 1),
    ("c_rank", F_C_RANK, 9), ("c_keepr", F_C_KEEPR, 4), ("c_orank", F_C_ORANK, 6),
    ("c_dmine", F_C_DMINE, 7), ("c_dtheirs", F_C_DTHEIRS, 7), ("c_spellr", F_C_SPELLR, 192),
    ("z_bias", F_Z_BIAS, 1), ("z_castid", F_Z_CASTID, 64),
    ("s3_cast", F_S3_CAST, 64),
];

const MS_EDGES: [i32; 11] = [-50, 0, 20, 40, 60, 80, 100, 130, 160, 200, 260];

#[inline]
fn ms_bucket(score: i32) -> u16 {
    let mut b = 0u16;
    for e in MS_EDGES { if score > e { b += 1; } }
    b
}

/// Rank buckets {0, 1, 2, 3, 4-5, 6-9, 10-15, 16-31, 32+}.
#[inline]
pub fn rank_bucket(r: usize) -> u16 {
    match r { 0 => 0, 1 => 1, 2 => 2, 3 => 3, 4..=5 => 4, 6..=9 => 5, 10..=15 => 6, 16..=31 => 7, _ => 8 }
}

#[inline]
fn orank_bucket(r: usize) -> u16 {
    match r { 0 => 0, 1 => 1, 2 => 2, 3 => 3, 4..=7 => 4, _ => 5 }
}

/// An option's sparse binary features.
#[derive(Clone, Copy, Debug)]
pub struct Feats { pub f: [u16; 24], pub n: u8 }

impl Feats {
    #[inline] pub fn new() -> Self { Feats { f: [0; 24], n: 0 } }
    #[inline] fn push(&mut self, x: u16) {
        debug_assert!((x as usize) < NF);
        if (self.n as usize) < 24 { self.f[self.n as usize] = x; self.n += 1; }
    }
    #[inline] fn spell(&mut self, base: u16, id: u8) { if (id as u16) < NSP { self.push(base + id as u16); } }
    #[inline] pub fn slice(&self) -> &[u16] { &self.f[..self.n as usize] }
}

impl Default for Feats { fn default() -> Self { Feats::new() } }

// ---------------------------------------------------------------------------
// Weights and knobs
// ---------------------------------------------------------------------------

pub struct PolicyWeights { pub w: Vec<[f32; PW]> }

impl PolicyWeights {
    pub fn compiled() -> Self {
        PolicyWeights { w: crate::policy_weights::POLICY_W.to_vec() }
    }
    pub fn zeros() -> Self { PolicyWeights { w: vec![[0.0; PW]; NF] } }

    #[inline]
    pub fn logit(&self, f: &Feats, z: &[f32; PK]) -> f32 {
        let mut acc = 0.0f32;
        for &i in f.slice() {
            let r = &self.w[i as usize];
            let mut s = r[0];
            for k in 0..PK { s += r[k + 1] * z[k]; }
            acc += s;
        }
        acc
    }
}

thread_local! {
    static WEIGHTS: RefCell<Rc<PolicyWeights>> = RefCell::new(Rc::new(PolicyWeights::compiled()));
    /// (on, min_width): the search uses the policy stream at nodes whose width
    /// budget is at least `min_width`. Off by default.
    static POLICY: Cell<(bool, usize)> = Cell::new((false, 0));
}

/// Replace this thread's weights (flat, `NF * PW`, row-major). For training
/// experiments; the shipped weights are the compiled `policy_weights.rs`.
pub fn set_policy_weights(flat: &[f32]) -> Result<(), String> {
    if flat.len() != NF * PW { return Err(format!("expected {} weights, got {}", NF * PW, flat.len())); }
    let w: Vec<[f32; PW]> = flat.chunks(PW).map(|c| { let mut r = [0.0; PW]; r.copy_from_slice(c); r }).collect();
    WEIGHTS.with(|x| *x.borrow_mut() = Rc::new(PolicyWeights { w }));
    Ok(())
}

/// Back to the compiled weights.
pub fn reset_policy_weights() {
    WEIGHTS.with(|x| *x.borrow_mut() = Rc::new(PolicyWeights::compiled()));
}

pub fn policy_weights() -> Rc<PolicyWeights> { WEIGHTS.with(|x| x.borrow().clone()) }

pub fn set_policy(on: bool, min_width: usize) { POLICY.with(|c| c.set((on, min_width))); }
pub fn policy_setting() -> (bool, usize) { POLICY.with(|c| c.get()) }

// ---------------------------------------------------------------------------
// Fixed-point normalisation
// ---------------------------------------------------------------------------

#[inline]
pub fn quant(l: f32) -> i32 {
    let q = (l * 256.0).round();
    q.clamp(-4_000_000.0, 4_000_000.0) as i32
}

#[inline]
fn lse2(a: i32, b: i32) -> i32 {
    let (m, d) = if a >= b { (a, a - b) } else { (b, b - a) };
    m + if (d as usize) < LSE_T.len() { LSE_T[d as usize] as i32 } else { 0 }
}

/// Log-softmax of quantised logits, in the same fixed point (1/256 nat).
pub fn log_softmax_q(qs: &[i32]) -> Vec<i32> {
    if qs.is_empty() { return Vec::new(); }
    let mut z = qs[0];
    for &q in &qs[1..] { z = lse2(z, q); }
    qs.iter().map(|&q| q - z).collect()
}

/// (stop, continue) log-probabilities of a binary level.
#[inline]
fn binary_q(cont: i32) -> (i32, i32) {
    let z = lse2(0, cont);
    (-z, cont - z)
}

// ---------------------------------------------------------------------------
// Feature extraction (shared by the stream and `policy_example`)
// ---------------------------------------------------------------------------

pub type Step = (u8, Option<u8>, bool, Option<(u8, Option<u8>)>);

/// Spells whose sigil `c` charges by holding `nodes` on `b` (sigils that are
/// exactly one node short and whose missing node is in `nodes`).
fn completes(b: &Board, c: Color, nodes: u64, f: &mut Feats, base: u16) -> bool {
    let mine = b.mine(c);
    let mut any = false;
    for p in 0..9 {
        let miss = SIGIL[p] & !mine;
        if miss != 0 && miss.count_ones() == 1 && miss & nodes != 0 {
            f.spell(base, b.spells[p]);
            any = true;
        }
    }
    any
}

/// The position context `z`.
pub fn policy_ctx(b: &Board, c: Color, my_cast: usize, their_cast: usize) -> [f32; PK] {
    let red = b.material(Color::Red) as i32;
    let blue = b.material(Color::Blue) as i32;
    let lead = if c == Color::Red { red - (blue + 1) } else { (blue + 1) - red };
    [
        lead as f32 / 4.0,
        b.turn_counter.min(40) as f32 / 20.0,
        my_cast as f32 / 2.0,
        their_cast as f32 / 2.0,
        b.can_dash(c) as u8 as f32,
        (b.mana[c.idx()] as f32 - b.mana[c.other().idx()] as f32) / 2.0,
    ]
}

/// Root-level facts shared by every first step.
pub struct RootInfo {
    pub z: [f32; PK],
    pub root_cast: Vec<u8>,
    pub can_dash_soon: bool,
}

pub fn root_info(b: &Board, c: Color) -> RootInfo {
    let root_cast = b.castable(c, true, true, false);
    let their = b.castable(c.other(), true, true, false).len();
    let z = policy_ctx(b, c, root_cast.len(), their);
    // A move adds a stone, so a side one stone short of the dash cost can dash
    // after it.
    let can_dash_soon = b.dash_sacrificeable(c).count_ones() + 1 >= b.dash_cost(c);
    RootInfo { z, root_cast, can_dash_soon }
}

/// (M features, P features, whether a continuation is possible) of one step.
pub fn step_feats(b: &Board, c: Color, step: &Step, score: i32, rank: usize, ri: &RootInfo)
    -> (Feats, Feats, bool)
{
    let (node, push_to, blink, place) = *step;
    let enemy = b.theirs(c) & (1u64 << node) != 0;
    let kind = match (blink, enemy, push_to) {
        (false, false, _) => 0, (false, true, Some(_)) => 1, (false, true, None) => 2,
        (true, false, _) => 3, (true, true, Some(_)) => 4, (true, true, None) => 5,
    };
    let mut m = Feats::new();
    m.push(F_M_KIND + kind);
    m.push(F_M_NODE + node as u16);
    m.push(F_M_PUSH + push_to.map(|d| d as u16).unwrap_or(39));
    m.push(F_M_MS + ms_bucket(score));
    m.push(F_M_RANK + rank_bucket(rank));
    m.push(F_M_PLACE + place.map(|(n, _)| n as u16).unwrap_or(39));
    let mut nodes = 1u64 << node;
    if let Some((pn, _)) = place { nodes |= 1u64 << pn; }
    let compl = completes(b, c, nodes, &mut m, F_M_COMPL);
    if enemy {
        for p in 0..9 {
            if SIGIL[p] & (1u64 << node) != 0 && b.is_charged(c.other(), p) {
                m.spell(F_M_BREAK, b.spells[p]);
            }
        }
    }
    let mut p = Feats::new();
    p.push(F_P_BIAS);
    p.push(F_P_KIND + kind);
    p.push(F_P_MS + ms_bucket(score));
    completes(b, c, nodes, &mut p, F_P_COMPL);
    p.push(F_P_NCAST + (ri.root_cast.len() as u16).min(3));
    if b.can_dash(c) { p.push(F_P_DASH); }
    for &id in &ri.root_cast { p.spell(F_P_CASTID, id); }
    let possible = compl || !ri.root_cast.is_empty() || ri.can_dash_soon;
    (m, p, possible)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ContOpt { Cast(u8), Dash }

/// Continuation options on the post-move board `bm`.
pub fn cont_opts(bm: &Board, c: Color, ri: &RootInfo) -> Vec<(Feats, ContOpt)> {
    let mut v = Vec::new();
    for id in bm.castable(c, true, true, false) {
        let Some(pos) = bm.position_of(id) else { continue };
        let mut f = Feats::new();
        f.spell(F_S_CAST, id);
        f.push(F_S_CPOS + pos as u16);
        if !ri.root_cast.contains(&id) { f.push(F_S_NEW); f.spell(F_S_NEWID, id); }
        v.push((f, ContOpt::Cast(pos as u8)));
    }
    if bm.can_dash(c) {
        let mut f = Feats::new();
        f.push(F_S_DASH);
        f.push(F_S_DCOST + (bm.dash_cost(c) as u16).clamp(1, 2) - 1);
        v.push((f, ContOpt::Dash));
    }
    v
}

/// One dash branch: its D features, the dash action, the post-dash board, and
/// (if any cast is possible after it) the P2 continue features.
pub struct DashOpt { pub f: Feats, pub act: Action, pub bd: Board, pub p2: Option<Feats> }

pub fn dash_opts(bm: &Board, c: Color, window: usize) -> Vec<DashOpt> {
    let mut out = Vec::new();
    for (j, (t, bd)) in bm.ordered_dash_branches(c, window).into_iter().enumerate() {
        let act = t.slice()[0];
        let Action::Dash { sacs, n_sacs, node, push_to } = act else { continue };
        let mut f = Feats::new();
        f.push(F_D_LAND + node as u16);
        f.push(F_D_LPUSH + push_to.map(|d| d as u16).unwrap_or(39));
        let enemy = bm.theirs(c) & (1u64 << node) != 0;
        let lk = match (enemy, push_to) { (false, _) => 0, (true, Some(_)) => 1, (true, None) => 2 };
        f.push(F_D_LKIND + lk);
        f.push(F_D_NSACS + (n_sacs as u16).clamp(1, 2) - 1);
        for s in &sacs[..(n_sacs as usize).min(2)] { f.push(F_D_SAC + *s as u16); }
        f.push(F_D_RANK + rank_bucket(j));
        let newly = bd.charged[c.idx()] & !bm.charged[c.idx()];
        for p in 0..9 { if newly & (1 << p) != 0 { f.spell(F_D_COMPL, bd.spells[p]); } }
        let post = bd.castable(c, true, true, true);
        let p2 = if post.is_empty() { None } else {
            let mut g = Feats::new();
            g.push(F_P2_BIAS);
            for &id in &post { g.spell(F_P2_CASTID, id); }
            Some(g)
        };
        out.push(DashOpt { f, act, bd, p2 });
    }
    out
}

/// Post-dash cast options on `bd`.
pub fn postdash_opts(bd: &Board, c: Color, ri: &RootInfo) -> Vec<(Feats, u8)> {
    let mut v = Vec::new();
    for id in bd.castable(c, true, true, true) {
        let Some(pos) = bd.position_of(id) else { continue };
        let mut f = Feats::new();
        f.spell(F_S2_CAST, id);
        if !ri.root_cast.contains(&id) { f.push(F_S2_NEW); }
        v.push((f, pos as u8));
    }
    v
}

/// Seal of Summer second-cast options on `bs`.
pub fn summer_opts(bs: &Board, c: Color, post_dash: bool) -> Vec<(Feats, u8)> {
    let mut v = Vec::new();
    for id in bs.castable(c, false, true, post_dash) {
        let Some(pos) = bs.position_of(id) else { continue };
        let mut f = Feats::new();
        f.spell(F_S3_CAST, id);
        v.push((f, pos as u8));
    }
    v
}

/// Cast kinds: the first cast after the move, a post-dash cast, Summer's second.
pub const CK_MOVE: u8 = 0;
pub const CK_DASH: u8 = 1;
pub const CK_SECOND: u8 = 2;

/// One (keep, outcome) candidate of a cast: C features, the action, and when a
/// Summer second cast can follow, the board after the cast plus Z features.
pub struct CastOpt { pub f: Feats, pub act: Action, pub after: Option<(Board, Feats)> }

/// The cast candidates the SHIPPED stream builds for this kind (same keep
/// budget, same resolver keys, same windows), in its order.
pub fn cast_opts(b: &Board, c: Color, pos: usize, kind: u8, window: usize, keep_window: usize,
                 windowed: &mut bool) -> Vec<CastOpt>
{
    let goal = b.placement_goal(c);
    let id = b.spells[pos];
    let (kis, ktr) = b.keep_indices_ordered(pos, c, keep_window.clamp(1, MAX_KEEP_WINDOW));
    if ktr { *windowed = true; }
    // (ki, raw, keep rank, within-keep rank, resolved board, keep board)
    let mut cands: Vec<(usize, usize, usize, usize, Board, Board)> = Vec::new();
    if kind == CK_SECOND {
        // `push_summer_casts`: keep-major, ranked outcomes, no stratification.
        for (kr, &ki) in kis.iter().enumerate() {
            let mut cl = *b;
            cl.cast_clear_and_keep(pos, c, ki);
            let (r, t) = cl.resolve_outcomes_ranked(pos, c, window);
            if t { *windowed = true; }
            for (j, (raw, ob)) in r.into_iter().enumerate() { cands.push((ki, raw, kr, j, ob, cl)); }
        }
    } else {
        let cleared = SIGIL[pos];
        let mut per_keep: Vec<Vec<(i32, usize, usize)>> = Vec::new();
        let mut store: Vec<(usize, usize, Board, Vec<(usize, Board)>)> = Vec::new(); // (ki, kr, cl, outs)
        for (kr, &ki) in kis.iter().enumerate() {
            let mut cl = *b;
            cl.cast_clear_and_keep(pos, c, ki);
            let mut v: Vec<(i32, usize, usize)>;
            let outs: Vec<(usize, Board)>;
            if kind == CK_MOVE {
                let (o, trunc) = cl.resolve_outcomes(pos, c, OUTCOME_CAP);
                if trunc { *windowed = true; }
                v = o.iter().enumerate()
                    .map(|(raw, ob)| (cl.sel_score(ob, c, goal, cleared, 0), ki, raw)).collect();
                v.sort_by_key(|&(sc, _, raw)| (-sc, raw));
                v.truncate(window);
                outs = o.into_iter().enumerate().collect();
            } else {
                let (ranked, trunc) = cl.resolve_outcomes_ranked(pos, c, window);
                if trunc { *windowed = true; }
                v = ranked.iter().map(|(raw, ob)| (ob.outcome_score(c, goal), ki, *raw)).collect();
                v.sort_by_key(|&(sc, _, raw)| (-sc, raw));
                outs = ranked;
            }
            if !v.is_empty() { per_keep.push(v); }
            store.push((ki, kr, cl, outs));
        }
        // within-keep ranks, before stratification consumes the lists
        let mut orank: Vec<(usize, usize, usize)> = Vec::new();
        for v in &per_keep { for (j, &(_, ki, raw)) in v.iter().enumerate() { orank.push((ki, raw, j)); } }
        let (joint, more) = stratify_by_keep(per_keep, window);
        if more { *windowed = true; }
        for &(_, ki, raw) in &joint {
            let Some((_, kr, cl, outs)) = store.iter().find(|s| s.0 == ki) else { continue };
            let Some(ob) = outs.iter().find(|(r, _)| *r == raw).map(|(_, o)| *o) else { continue };
            let j = orank.iter().find(|x| x.0 == ki && x.1 == raw).map(|x| x.2).unwrap_or(0);
            cands.push((ki, raw, *kr, j, ob, *cl));
        }
    }
    let summer_ok = kind != CK_SECOND && b.position_of(SEAL_OF_SUMMER).is_some()
        && (kind == CK_MOVE || dash_summer_enabled());
    let m0 = b.material(c) as i32;
    let t0 = b.material(c.other()) as i32;
    let mut out = Vec::with_capacity(cands.len());
    for (jj, (ki, raw, kr, j, ob, cl)) in cands.into_iter().enumerate() {
        let mut f = Feats::new();
        f.push(F_C_RANK + rank_bucket(jj));
        f.push(F_C_KEEPR + (kr as u16).min(3));
        f.push(F_C_ORANK + orank_bucket(j));
        f.push(F_C_DMINE + ((ob.material(c) as i32 - m0).clamp(-3, 3) + 3) as u16);
        f.push(F_C_DTHEIRS + ((ob.material(c.other()) as i32 - t0).clamp(-3, 3) + 3) as u16);
        if (id as u16) < NSP {
            let coarse = match j { 0 => 0, 1..=3 => 1, _ => 2 };
            f.push(F_C_SPELLR + id as u16 * 3 + coarse);
        }
        let act = Action::Cast { pos: pos as u8, keep: ki as u8, outcome: raw as u16 };
        let mut after = None;
        if summer_ok {
            let mut bs = cl;
            bs.adopt(&ob);
            bs.update();
            bs.finish_cast(id, c);
            bs.update();
            if bs.holds_charged(c, SEAL_OF_SUMMER) {
                let post = bs.castable(c, false, true, kind == CK_DASH);
                if !post.is_empty() {
                    let mut g = Feats::new();
                    g.push(F_Z_BIAS);
                    for &i2 in &post { g.spell(F_Z_CASTID, i2); }
                    after = Some((bs, g));
                }
            }
        }
        out.push(CastOpt { f, act, after });
    }
    out
}

// ---------------------------------------------------------------------------
// The best-first stream
// ---------------------------------------------------------------------------

enum Node {
    Leaf(Turn),
    Cont { mi: u16 },
    CastStub { prefix: Turn, b: Board, pos: u8, kind: u8 },
    DashStub { mi: u16 },
    PostDash { prefix: Turn, bd: Board },
    Summer { prefix: Turn, bs: Board, post_dash: bool },
}

struct Entry { lp: i32, seq: u32, node: Node }

impl PartialEq for Entry { fn eq(&self, o: &Self) -> bool { self.lp == o.lp && self.seq == o.seq } }
impl Eq for Entry {}
impl PartialOrd for Entry { fn partial_cmp(&self, o: &Self) -> Option<Ordering> { Some(self.cmp(o)) } }
impl Ord for Entry {
    fn cmp(&self, o: &Self) -> Ordering { self.lp.cmp(&o.lp).then(o.seq.cmp(&self.seq)) }
}

pub struct PolicyIter<'a> {
    board: &'a Board,
    c: Color,
    window: usize,
    keep_window: usize,
    fallback: Option<TurnIter<'a>>,
    front: VecDeque<Turn>,
    steps: Vec<Step>,
    ri: Option<RootInfo>,
    w: Rc<PolicyWeights>,
    heap: BinaryHeap<Entry>,
    seq: u32,
    pub windowed: bool,
    pub yielded: usize,
    /// Internal nodes expanded (generation work), for the cost report.
    pub expanded: usize,
}

impl Board {
    /// The learned-policy stream: every turn of the shipped stream's candidate
    /// sets, best-first by policy probability. Positions the stream special-cases
    /// (the competitive opening, no legal first move) fall back to it.
    pub fn turns_policy(&self, c: Color, window: usize, keep_window: usize) -> PolicyIter<'_> {
        PolicyIter::new(self, c, window, keep_window)
    }
}

impl<'a> PolicyIter<'a> {
    fn new(board: &'a Board, c: Color, window: usize, keep_window: usize) -> Self {
        let w = policy_weights();
        let mut b = *board;
        b.update();
        let mut it = PolicyIter {
            board, c, window, keep_window, fallback: None, front: VecDeque::new(),
            steps: Vec::new(), ri: None, w, heap: BinaryHeap::new(), seq: 0,
            windowed: false, yielded: 0, expanded: 0,
        };
        if b.variant.has_competitive() && b.turn_counter <= 2 {
            it.fallback = Some(board.turns_ordered_keeps(c, window, 0, keep_window));
            return it;
        }
        let scored = board.ordered_first_steps_scored(c);
        if scored.is_empty() {
            it.fallback = Some(board.turns_ordered_keeps(c, window, 0, keep_window));
            return it;
        }
        it.steps = scored.iter().map(|s| s.0).collect();
        it.front = front_prepass(board, &b, c, &it.steps).into();
        let ri = root_info(&b, c);
        let mut qm = Vec::with_capacity(scored.len());
        let mut conts = Vec::with_capacity(scored.len());
        for (r, (st, sc)) in scored.iter().enumerate() {
            let (fm, fp, possible) = step_feats(&b, c, st, *sc, r, &ri);
            qm.push(quant(it.w.logit(&fm, &ri.z)));
            conts.push(if possible { Some(quant(it.w.logit(&fp, &ri.z))) } else { None });
        }
        let lpm = log_softmax_q(&qm);
        for mi in 0..scored.len() {
            let prefix = it.first_prefix(mi);
            match conts[mi] {
                Some(qc) => {
                    let (ls, lc) = binary_q(qc);
                    it.push(lpm[mi] + ls, Node::Leaf(prefix));
                    it.push(lpm[mi] + lc, Node::Cont { mi: mi as u16 });
                }
                None => it.push(lpm[mi], Node::Leaf(prefix)),
            }
        }
        it.ri = Some(ri);
        it
    }

    #[inline]
    fn push(&mut self, lp: i32, node: Node) {
        self.seq += 1;
        self.heap.push(Entry { lp, seq: self.seq, node });
    }

    fn first_prefix(&self, i: usize) -> Turn {
        let (n, p, blink, place) = self.steps[i];
        let a = if blink { Action::Blink { node: n, push_to: p } } else { Action::Move { node: n, push_to: p } };
        let t = Turn::single(a);
        match place {
            Some((pn, pp)) => t.push_pub(Action::Place { node: pn, push_to: pp }),
            None => t,
        }
    }

    fn post_move_board(&self, i: usize) -> Board {
        let (n, p, _, place) = self.steps[i];
        let mut b = *self.board;
        b.do_move_with_pub(n, p, self.c);
        if let Some((pn, pp)) = place { b.do_placement(pn, pp, self.c); }
        b
    }

    fn push_softmax<T>(&mut self, lp: i32, opts: Vec<(Feats, T)>, mut mk: impl FnMut(&mut Self, i32, T)) {
        if opts.is_empty() { return; }
        let z = self.ri.as_ref().map(|r| r.z).unwrap_or([0.0; PK]);
        let qs: Vec<i32> = opts.iter().map(|(f, _)| quant(self.w.logit(f, &z))).collect();
        let ls = log_softmax_q(&qs);
        for ((_, t), l) in opts.into_iter().zip(ls) { mk(self, lp + l, t); }
    }

    fn expand(&mut self, lp: i32, node: Node) {
        self.expanded += 1;
        let c = self.c;
        let z = self.ri.as_ref().map(|r| r.z).unwrap_or([0.0; PK]);
        match node {
            Node::Leaf(_) => unreachable!(),
            Node::Cont { mi } => {
                let bm = self.post_move_board(mi as usize);
                let opts = cont_opts(&bm, c, self.ri.as_ref().unwrap());
                let prefix = self.first_prefix(mi as usize);
                self.push_softmax(lp, opts, |s, l, o| match o {
                    ContOpt::Cast(pos) => s.push(l, Node::CastStub { prefix, b: bm, pos, kind: CK_MOVE }),
                    ContOpt::Dash => s.push(l, Node::DashStub { mi }),
                });
            }
            Node::DashStub { mi } => {
                let bm = self.post_move_board(mi as usize);
                let prefix = self.first_prefix(mi as usize);
                let opts = dash_opts(&bm, c, self.window);
                if opts.is_empty() { return; }
                let qs: Vec<i32> = opts.iter().map(|o| quant(self.w.logit(&o.f, &z))).collect();
                let ls = log_softmax_q(&qs);
                for (o, l) in opts.into_iter().zip(ls) {
                    let t = prefix.push_pub(o.act);
                    match o.p2 {
                        Some(g) => {
                            let (lst, lc) = binary_q(quant(self.w.logit(&g, &z)));
                            self.push(lp + l + lst, Node::Leaf(t));
                            self.push(lp + l + lc, Node::PostDash { prefix: t, bd: o.bd });
                        }
                        None => self.push(lp + l, Node::Leaf(t)),
                    }
                }
            }
            Node::PostDash { prefix, bd } => {
                let opts = postdash_opts(&bd, c, self.ri.as_ref().unwrap());
                self.push_softmax(lp, opts, |s, l, pos| {
                    s.push(l, Node::CastStub { prefix, b: bd, pos, kind: CK_DASH })
                });
            }
            Node::Summer { prefix, bs, post_dash } => {
                let opts = summer_opts(&bs, c, post_dash);
                self.push_softmax(lp, opts, |s, l, pos| {
                    s.push(l, Node::CastStub { prefix, b: bs, pos, kind: CK_SECOND })
                });
            }
            Node::CastStub { prefix, b, pos, kind } => {
                let mut windowed = false;
                let opts = cast_opts(&b, c, pos as usize, kind, self.window, self.keep_window, &mut windowed);
                if windowed { self.windowed = true; }
                if opts.is_empty() { return; }
                let qs: Vec<i32> = opts.iter().map(|o| quant(self.w.logit(&o.f, &z))).collect();
                let ls = log_softmax_q(&qs);
                for (o, l) in opts.into_iter().zip(ls) {
                    let t = prefix.push_pub(o.act);
                    match o.after {
                        Some((bs, g)) => {
                            let (lst, lc) = binary_q(quant(self.w.logit(&g, &z)));
                            self.push(lp + l + lst, Node::Leaf(t));
                            self.push(lp + l + lc, Node::Summer { prefix: t, bs, post_dash: kind == CK_DASH });
                        }
                        None => self.push(lp + l, Node::Leaf(t)),
                    }
                }
            }
        }
    }
}

impl<'a> Iterator for PolicyIter<'a> {
    type Item = Turn;
    fn next(&mut self) -> Option<Turn> {
        if let Some(f) = self.fallback.as_mut() {
            let t = f.next();
            if f.windowed { self.windowed = true; }
            if t.is_some() { self.yielded += 1; }
            return t;
        }
        if let Some(t) = self.front.pop_front() {
            self.yielded += 1;
            return Some(t.push_pub(Action::Pass));
        }
        while let Some(e) = self.heap.pop() {
            match e.node {
                Node::Leaf(t) => {
                    self.yielded += 1;
                    return Some(t.push_pub(Action::Pass));
                }
                node => self.expand(e.lp, node),
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Training examples
// ---------------------------------------------------------------------------

/// One level on a target turn's path: its options' features and the target's
/// index among them (-1 when the target is not among the generated options,
/// which ends the path: the policy cannot build it).
pub struct LevelEx { pub level: u8, pub opts: Vec<Feats>, pub target: i32 }

/// Board after a dash action, as the dash generator builds it.
fn dash_board(bm: &Board, a: &Action, c: Color) -> Option<Board> {
    let Action::Dash { sacs, n_sacs, node, push_to } = *a else { return None };
    let mut bd = *bm;
    for s in &sacs[..n_sacs as usize] { bd.stones[c.idx()] &= !(1u64 << *s); }
    bd.update();
    bd.do_move_with_pub(node, push_to, c);
    Some(bd)
}

/// Resolved board of a cast action on `b` (before `finish_cast`).
fn cast_board(b: &Board, a: &Action, c: Color) -> Option<Board> {
    let Action::Cast { pos, keep, outcome } = *a else { return None };
    let mut cl = *b;
    cl.cast_clear_and_keep(pos as usize, c, keep as usize);
    let (outs, _) = cl.resolve_outcomes(pos as usize, c, OUTCOME_CAP);
    outs.get(outcome as usize).copied()
}

/// Walk the policy tree along `target` (a full turn, trailing Pass optional).
/// Returns `None` for positions the stream special-cases (fallback).
pub fn policy_example(board: &Board, c: Color, target: &Turn, window: usize, keep_window: usize)
    -> Option<([f32; PK], Vec<LevelEx>)>
{
    let mut b = *board;
    b.update();
    if b.variant.has_competitive() && b.turn_counter <= 2 { return None; }
    let scored = board.ordered_first_steps_scored(c);
    if scored.is_empty() { return None; }
    let ri = root_info(&b, c);
    let acts: Vec<Action> = target.slice().iter().copied().filter(|a| !matches!(a, Action::Pass)).collect();
    if acts.is_empty() { return None; }
    let mut levels = Vec::new();
    // M
    let (place, rest_start) = match acts.get(1) {
        Some(Action::Place { node, push_to }) => (Some((*node, *push_to)), 2),
        _ => (None, 1),
    };
    let (tn, tp, tblink) = match acts[0] {
        Action::Move { node, push_to } => (node, push_to, false),
        Action::Blink { node, push_to } => (node, push_to, true),
        _ => return None,
    };
    let mut fms = Vec::with_capacity(scored.len());
    let mut target_mi: i32 = -1;
    let mut chosen: Option<(Feats, bool)> = None;
    for (r, (st, sc)) in scored.iter().enumerate() {
        let (fm, fp, possible) = step_feats(&b, c, st, *sc, r, &ri);
        if target_mi < 0 && st.0 == tn && st.1 == tp && st.2 == tblink && st.3 == place {
            target_mi = r as i32;
            chosen = Some((fp, possible));
        }
        fms.push(fm);
    }
    levels.push(LevelEx { level: L_M, opts: fms, target: target_mi });
    let Some((fp, possible)) = chosen else { return Some((ri.z, levels)) };
    let rest = &acts[rest_start..];
    // P
    if !possible {
        return Some((ri.z, levels));
    }
    levels.push(LevelEx { level: L_P, opts: vec![Feats::new(), fp], target: if rest.is_empty() { 0 } else { 1 } });
    if rest.is_empty() { return Some((ri.z, levels)); }
    let mi = target_mi as usize;
    let (n, p, _, pl) = scored[mi].0;
    let mut bm = *board;
    bm.do_move_with_pub(n, p, c);
    if let Some((pn, pp)) = pl { bm.do_placement(pn, pp, c); }
    // S
    let copts = cont_opts(&bm, c, &ri);
    let want = match rest[0] {
        Action::Cast { pos, .. } => ContOpt::Cast(pos),
        Action::Dash { .. } => ContOpt::Dash,
        _ => return Some((ri.z, levels)),
    };
    let si = copts.iter().position(|(_, o)| *o == want).map(|i| i as i32).unwrap_or(-1);
    levels.push(LevelEx { level: L_S, opts: copts.iter().map(|(f, _)| *f).collect(), target: si });
    if si < 0 { return Some((ri.z, levels)); }
    let mut windowed = false;
    let mut cur = bm;          // board before the next cast
    let i: usize;              // index into rest
    let mut kind = CK_MOVE;
    if want == ContOpt::Dash {
        let dopts = dash_opts(&bm, c, window);
        let tbd = dash_board(&bm, &rest[0], c);
        let di = dopts.iter().position(|o| o.act == rest[0])
            .or_else(|| dopts.iter().position(|o| Some(o.bd) == tbd))
            .map(|i| i as i32).unwrap_or(-1);
        levels.push(LevelEx { level: L_D, opts: dopts.iter().map(|o| o.f).collect(), target: di });
        if di < 0 { return Some((ri.z, levels)); }
        let o = &dopts[di as usize];
        let Some(g) = o.p2 else { return Some((ri.z, levels)) };
        let more = rest.len() > 1;
        levels.push(LevelEx { level: L_P2, opts: vec![Feats::new(), g], target: more as i32 });
        if !more { return Some((ri.z, levels)); }
        let pd = postdash_opts(&o.bd, c, &ri);
        let Action::Cast { pos, .. } = rest[1] else { return Some((ri.z, levels)) };
        let s2 = pd.iter().position(|(_, ps)| *ps == pos).map(|i| i as i32).unwrap_or(-1);
        levels.push(LevelEx { level: L_S2, opts: pd.iter().map(|(f, _)| *f).collect(), target: s2 });
        if s2 < 0 { return Some((ri.z, levels)); }
        cur = o.bd;
        i = 1;
        kind = CK_DASH;
    } else {
        i = 0;
    }
    let mut i = i;
    // C (first cast), then possibly Z / S3 / C (second)
    for round in 0..2 {
        let Some(&Action::Cast { pos, .. }) = rest.get(i) else { return Some((ri.z, levels)) };
        let copts2 = cast_opts(&cur, c, pos as usize, kind, window, keep_window, &mut windowed);
        let tb = cast_board(&cur, &rest[i], c);
        let ci = copts2.iter().position(|o| o.act == rest[i])
            .or_else(|| {
                // same resolved board under another (keep, outcome) witness
                copts2.iter().position(|o| {
                    let Some(t) = tb else { return false };
                    cast_board(&cur, &o.act, c).map(|x| x.state_key()) == Some(t.state_key())
                })
            })
            .map(|i| i as i32).unwrap_or(-1);
        levels.push(LevelEx { level: L_C, opts: copts2.iter().map(|o| o.f).collect(), target: ci });
        if ci < 0 || round == 1 { return Some((ri.z, levels)); }
        let o = &copts2[ci as usize];
        let Some((bs, g)) = o.after else { return Some((ri.z, levels)) };
        let more = rest.len() > i + 1;
        levels.push(LevelEx { level: L_Z, opts: vec![Feats::new(), g], target: more as i32 });
        if !more { return Some((ri.z, levels)); }
        let so = summer_opts(&bs, c, kind == CK_DASH);
        let Action::Cast { pos: p2, .. } = rest[i + 1] else { return Some((ri.z, levels)) };
        let s3 = so.iter().position(|(_, ps)| *ps == p2).map(|i| i as i32).unwrap_or(-1);
        levels.push(LevelEx { level: L_S3, opts: so.iter().map(|(f, _)| *f).collect(), target: s3 });
        if s3 < 0 { return Some((ri.z, levels)); }
        cur = bs;
        i += 1;
        kind = CK_SECOND;
    }
    Some((ri.z, levels))
}
