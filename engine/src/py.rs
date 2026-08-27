//! Thin PyO3 surface for differential testing against simboard.py and for perf
//! probes. Node arguments are indices 0..38 in NODE_ORDER.

use pyo3::prelude::*;
use crate::board::*;
use crate::zobrist::ZOBRIST;

#[pyclass(name = "Board")]
#[derive(Clone)]
pub struct PyBoard { pub b: Board }

fn color(s: &str) -> PyResult<Color> {
    match s {
        "red" => Ok(Color::Red),
        "blue" => Ok(Color::Blue),
        _ => Err(pyo3::exceptions::PyValueError::new_err("color must be 'red' or 'blue'")),
    }
}

fn mask_to_vec(mut m: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(m.count_ones() as usize);
    while m != 0 { v.push(m.trailing_zeros() as u8); m &= m - 1; }
    v
}

#[pymethods]
impl PyBoard {
    #[new]
    #[pyo3(signature = (spells, variant = "standard"))]
    fn new(spells: [u8; 9], variant: &str) -> PyResult<Self> {
        let v = match variant {
            "standard" => Variant::Standard,
            "competitive" => Variant::Competitive,
            "deathmatch" => Variant::Deathmatch,
            "competitive_deathmatch" => Variant::CompetitiveDeathmatch,
            _ => return Err(pyo3::exceptions::PyValueError::new_err("unknown variant")),
        };
        Ok(PyBoard { b: Board::new(spells, v) })
    }

    fn setup_initial(&mut self) { self.b.setup_initial(); }

    fn set_stones(&mut self, red: Vec<u8>, blue: Vec<u8>) {
        self.b.stones = [0, 0];
        for i in red { self.b.stones[0] |= 1u64 << i; }
        for i in blue { self.b.stones[1] |= 1u64 << i; }
        self.b.update();
    }

    #[getter] fn red(&self) -> Vec<u8> { mask_to_vec(self.b.stones[0]) }
    #[getter] fn blue(&self) -> Vec<u8> { mask_to_vec(self.b.stones[1]) }
    #[getter] fn total(&self) -> (u32, u32) { (self.b.total[0], self.b.total[1]) }
    #[getter] fn mana(&self) -> (u32, u32) { (self.b.mana[0], self.b.mana[1]) }
    #[getter] fn turn_counter(&self) -> u32 { self.b.turn_counter }
    #[setter] fn set_turn_counter(&mut self, t: u32) { self.b.turn_counter = t; }
    #[setter] fn set_spell_counter(&mut self, sc: (u8, u8)) { self.b.spell_counter = [sc.0, sc.1]; }
    #[setter] fn set_to_move(&mut self, c: &str) -> PyResult<()> { self.b.to_move = color(c)?; Ok(()) }
    #[setter] fn set_lock(&mut self, l: (u8, u8)) { self.b.lock = [l.0, l.1]; }

    fn charged(&self, c: &str) -> PyResult<Vec<u8>> {
        let c = color(c)?;
        Ok((0..9u8).filter(|p| self.b.charged[c.idx()] & (1 << p) != 0).map(|p| p + 1).collect())
    }
    fn soft_moveable(&self, c: &str) -> PyResult<Vec<u8>> { Ok(mask_to_vec(self.b.soft_moveable(color(c)?))) }
    fn hard_moveable(&self, c: &str) -> PyResult<Vec<u8>> { Ok(mask_to_vec(self.b.hard_moveable(color(c)?))) }
    fn all_moveable(&self, c: &str) -> PyResult<Vec<u8>> { Ok(mask_to_vec(self.b.all_moveable(color(c)?))) }
    fn push_options(&self, node: u8, c: &str) -> PyResult<Vec<u8>> {
        let (o, k) = self.b.push_options(node, color(c)?);
        Ok(o[..k].to_vec())
    }
    fn push_enemy(&mut self, node: u8, c: &str) -> PyResult<Option<u8>> {
        Ok(match self.b.push_enemy(node, color(c)?) { Push::To(d) => Some(d), Push::Crush => None })
    }
    fn escape_distance(&self, node: u8, defender: &str, max_dist: u32) -> PyResult<u32> {
        Ok(self.b.escape_distance(node, color(defender)?, max_dist))
    }
    fn is_crushable(&self, node: u8, attacker: &str) -> PyResult<bool> {
        Ok(self.b.is_crushable(node, color(attacker)?))
    }
    fn dash_sacrificeable(&self, c: &str) -> PyResult<Vec<u8>> {
        Ok(mask_to_vec(self.b.dash_sacrificeable(color(c)?)))
    }
    fn dash_cost(&self, c: &str) -> PyResult<u32> { Ok(self.b.dash_cost(color(c)?)) }
    fn castable(&self, c: &str, can_spell: bool, can_summer: bool, post_dash: bool) -> PyResult<Vec<u8>> {
        Ok(self.b.castable(color(c)?, can_spell, can_summer, post_dash))
    }
    fn cast_clear_and_refill(&mut self, pos: usize, c: &str) -> PyResult<()> {
        self.b.cast_clear_and_refill(pos, color(c)?); Ok(())
    }
    fn resolve_autumn_moves(&mut self, pos: usize, c: &str, count: u8) -> PyResult<u8> {
        Ok(self.b.resolve_autumn_moves(pos, color(c)?, count))
    }
    fn update(&mut self) { self.b.update(); }
    fn check_game_over(&mut self, active: &str) -> PyResult<bool> {
        Ok(self.b.check_game_over(color(active)?))
    }
    #[getter] fn winner(&self) -> Option<&'static str> {
        match self.b.outcome {
            Outcome::Ongoing => None, Outcome::RedWins => Some("red"), Outcome::BlueWins => Some("blue"),
        }
    }
    #[getter] fn gameover(&self) -> bool { self.b.outcome != Outcome::Ongoing }

    /// Hand the turn over: bump the counter, flip the side to move, recompute.
    /// `apply_turn` deliberately does NOT do this (it applies a turn to a position
    /// without committing to a clock), and `play_best` does it inline -- so a
    /// caller that applies its own turn, e.g. a random-ply data generator, needs
    /// this or the game silently never progresses.
    fn advance_turn(&mut self) {
        let c = self.b.to_move;
        self.b.turn_counter += 1;
        self.b.to_move = c.other();
        self.b.update();
    }
    #[getter] fn key_js(&self) -> u64 { ZOBRIST.key_js(&self.b) }
    #[getter] fn key_py(&self) -> u64 { ZOBRIST.key_py(&self.b) }
    fn has_deferred_spell(&self) -> bool { self.b.has_deferred_spell() }
    fn resolve_spell(&mut self, id: u8, c: &str) -> PyResult<bool> {
        Ok(self.b.resolve_spell(id, color(c)?))
    }
    fn resolve_spell_at(&mut self, pos: usize, c: &str) -> PyResult<bool> {
        Ok(self.b.resolve_spell_at(pos, color(c)?))
    }
    fn resolver_ready(&self, id: u8) -> bool { self.b.resolver_ready(id) }
    fn finish_cast(&mut self, id: u8, c: &str) -> PyResult<()> {
        self.b.finish_cast(id, color(c)?); Ok(())
    }
    #[getter] fn lock(&self) -> (u8, u8) { (self.b.lock[0], self.b.lock[1]) }
    #[getter] fn springlock(&self) -> (u8, u8) { (self.b.springlock[0], self.b.springlock[1]) }
    #[getter] fn spell_counter(&self) -> (u8, u8) { (self.b.spell_counter[0], self.b.spell_counter[1]) }
    fn lurk_targets(&self, c: &str) -> PyResult<Vec<u8>> {
        Ok(mask_to_vec(self.b.lurk_targets(color(c)?)))
    }
    fn resolve_destroy_exposed(&mut self, c: &str) -> PyResult<u32> {
        Ok(self.b.resolve_destroy_exposed(color(c)?))
    }
    fn clone_board(&self) -> PyBoard { self.clone() }
    fn draw_is_legal(&self) -> bool { self.b.draw_is_legal() }
    fn to_sfn(&self) -> String { self.b.to_sfn() }

    /// The ordered stream the search actually consumes, as action kinds per turn.
    /// Used to verify no move class is starved by the widening budget.
    #[pyo3(signature = (take, width=0))]
    fn ordered_turn_kinds(&self, take: usize, width: usize) -> Vec<String> {
        let c = self.b.to_move;
        let w = if width == 0 { take } else { width };
        self.b.turns_best_first(c, 16, w).take(take).map(|t| {
            t.slice().iter().map(|a| match a {
                crate::turn::Action::Move { .. } => "move",
                crate::turn::Action::Blink { .. } => "blink",
                crate::turn::Action::Dash { .. } => "dash",
                crate::turn::Action::Cast { .. } => "cast",
                crate::turn::Action::Pass => "pass",
            }).collect::<Vec<_>>().join("+")
        }).collect()
    }

    // ---- surfaces for the interactive local player ----

    /// Continuations available after a chosen first move, as
    /// (label, kind, a, b, c) rows the caller can present as a menu:
    ///   ("pass", "pass", -1, -1, -1)
    ///   ("dash", "dash", sac0, sac1, dest_node)      push dest folded into `c`
    ///   ("cast <spell> variant k", "cast", pos, k, -1)
    fn continuations(&self, node: u8, push_to: i32, c: &str)
        -> PyResult<Vec<(String, String, i32, i32, i32)>>
    {
        let col = color(c)?;
        let mut b = self.b;
        b.do_move_with_pub(node, if push_to < 0 { None } else { Some(push_to as u8) }, col);
        let mut out = vec![("pass".to_string(), "pass".to_string(), -1, -1, -1)];
        // dashes
        for (t, _bd) in b.ordered_dash_branches(col, 8) {
            if let crate::turn::Action::Dash { sacs, n_sacs, node: dn, push_to: dp } = t.slice()[0] {
                let s1 = if n_sacs > 1 { sacs[1] as i32 } else { -1 };
                out.push((format!("dash (give up {} {}) then move {}",
                                  crate::topology::NAMES[sacs[0] as usize],
                                  if n_sacs > 1 { crate::topology::NAMES[sacs[1] as usize] } else { "" },
                                  crate::topology::NAMES[dn as usize]),
                          "dash".to_string(), sacs[0] as i32, s1,
                          (dn as i32) | ((dp.map_or(63u8, |x| x) as i32) << 8)));
            }
        }
        // casts, with each distinct outcome offered separately
        for id in b.castable(col, true, true, false) {
            let Some(pos) = b.position_of(id) else { continue };
            let mut cl = b;
            cl.cast_clear_and_refill(pos, col);
            let (outs, _t) = cl.resolve_outcomes_ordered(pos, col, 12);
            for (k, ob) in outs.iter().enumerate() {
                let gained = (ob.stones[col.idx()] & !b.stones[col.idx()]).count_ones();
                let killed = (b.stones[col.other().idx()] & !ob.stones[col.other().idx()]).count_ones();
                out.push((format!("cast {} [{}]  (+{} own, -{} enemy)",
                                  crate::spells_meta::SPELLS[id as usize].name, k, gained, killed),
                          "cast".to_string(), pos as i32, k as i32, -1));
            }
        }
        Ok(out)
    }

    /// Apply a (first move, continuation) pair chosen from the menus above.
    fn apply_choice(&mut self, node: u8, push_to: i32, kind: &str,
                    a: i32, b_: i32, cc: i32, c: &str) -> PyResult<()> {
        use crate::turn::{Action, Turn, MAX_ACTIONS};
        let col = color(c)?;
        let mut t = Turn { actions: [Action::Pass; MAX_ACTIONS], len: 0, greedy_casts: 0 };
        let blink = self.b.is_blink_pub(node, col);
        let pt = if push_to < 0 { None } else { Some(push_to as u8) };
        t = t.push_pub(if blink { Action::Blink { node, push_to: pt } }
                       else { Action::Move { node, push_to: pt } });
        match kind {
            "dash" => {
                let dn = (cc & 0xff) as u8;
                let dpv = ((cc >> 8) & 0xff) as u8;
                let dp = if dpv == 63 { None } else { Some(dpv) };
                let n_sacs = if b_ < 0 { 1u8 } else { 2 };
                let sacs = [a as u8, if b_ < 0 { 0 } else { b_ as u8 }];
                t = t.push_pub(Action::Dash { sacs, n_sacs, node: dn, push_to: dp });
            }
            "cast" => { t = t.push_pub(Action::Cast { pos: a as u8, outcome: b_ as u16 }); }
            _ => {}
        }
        t = t.push_pub(Action::Pass);
        self.b.apply_turn(&t, col);
        self.b.turn_counter += 1;
        self.b.to_move = col.other();
        self.b.update();
        Ok(())
    }

    /// Charged spell names for a colour, for the status line.
    /// Emit the JS action list for a (first move, continuation) pair, plus the
    /// position it must produce. Used by the SFN-assertion gate.
    fn emit_choice_actions(&self, node: u8, push_to: i32, kind: &str,
                           a: i32, b_: i32, cc: i32, c: &str) -> PyResult<(String, String)> {
        use crate::turn::{Action, Turn, MAX_ACTIONS};
        let col = color(c)?;
        let mut t = Turn { actions: [Action::Pass; MAX_ACTIONS], len: 0, greedy_casts: 0 };
        let blink = self.b.is_blink_pub(node, col);
        let pt = if push_to < 0 { None } else { Some(push_to as u8) };
        t = t.push_pub(if blink { Action::Blink { node, push_to: pt } }
                       else { Action::Move { node, push_to: pt } });
        match kind {
            "dash" => {
                let dn = (cc & 0xff) as u8;
                let dpv = ((cc >> 8) & 0xff) as u8;
                let dp = if dpv == 63 { None } else { Some(dpv) };
                let n_sacs = if b_ < 0 { 1u8 } else { 2 };
                let sacs = [a as u8, if b_ < 0 { 0 } else { b_ as u8 }];
                t = t.push_pub(Action::Dash { sacs, n_sacs, node: dn, push_to: dp });
            }
            "cast" => { t = t.push_pub(Action::Cast { pos: a as u8, outcome: b_ as u16 }); }
            _ => {}
        }
        let (acts, after) = self.b.emit_actions(&t, col);
        Ok((crate::actions::acts_to_json(&acts), after.to_sfn()))
    }

    fn charged_names(&self, c: &str) -> PyResult<Vec<String>> {
        let col = color(c)?;
        Ok((0..9usize).filter(|&p| self.b.charged[col.idx()] & (1 << p) != 0)
            .map(|p| {
                let id = self.b.spells[p] as usize;
                format!("{}({})", crate::spells_meta::SPELLS[id].name, p + 1)
            }).collect())
    }
    #[getter] fn spell_names(&self) -> Vec<String> {
        self.b.spells.iter().map(|&i| crate::spells_meta::SPELLS[i as usize].name.to_string()).collect()
    }

    /// Every legal FIRST-move variant as (kind, node, push_to), with Wind blink and
    /// enemy Seal-of-Stone rules applied. Separate from `enumerate_turns` because
    /// that one is capped: with a spell charged, a single first move can spawn
    /// enough continuations to exhaust the cap, which would make a coverage check
    /// look like the generator was hiding moves when it was only truncated.
    fn first_move_variants(&self) -> Vec<(String, i32, i32)> {
        let c = self.b.to_move;
        let (targets, _wind) = self.b.first_move_targets(c);
        self.b.move_variants_pub(targets, c).into_iter().map(|(n, p)| {
            let kind = if self.b.is_blink_pub(n, c) { "blink" } else { "move" };
            (kind.to_string(), n as i32, p.map_or(-1, |x| x as i32))
        }).collect()
    }
    #[staticmethod]
    fn from_sfn(s: &str) -> PyResult<PyBoard> {
        crate::board::Board::from_sfn(s)
            .map(|b| PyBoard { b })
            .map_err(pyo3::exceptions::PyValueError::new_err)
    }

    #[pyo3(signature = (c, eval_name="default"))]
    fn evaluate(&self, c: &str, eval_name: &str) -> PyResult<i32> {
        let w = weights_by_name(eval_name)?;
        Ok(self.b.evaluate(color(c)?, &w))
    }
    fn control_diff(&self, c: &str) -> PyResult<i32> { Ok(self.b.control_diff(color(c)?)) }

    /// The raw, unweighted quantity each `Weights` field multiplies, from `c`'s POV,
    /// in `HAND_FEATURE_NAMES` order. `evaluate(c, w) == dot(w, this)` exactly (unit
    /// tested), so a logistic/texel fit on these produces numbers that drop straight
    /// into `Weights` with no reinterpretation.
    fn hand_features(&self, c: &str) -> PyResult<Vec<i32>> {
        Ok(self.b.hand_features(color(c)?).to_vec())
    }

    /// Rich, close-to-the-board features for the offline learnability test.
    fn full_features(&self, c: &str) -> PyResult<Vec<f32>> {
        Ok(self.b.full_features(color(c)?))
    }

    /// Spell id per sigil slot. Constant for a whole game, so a consumer embeds
    /// these once per game rather than per position.
    fn spell_ids(&self) -> PyResult<Vec<u8>> { Ok(self.b.spell_ids().to_vec()) }

    /// Search, play the best turn, advance the turn. Returns
    /// (depth_completed, nodes, seconds, gameover, winner, score, widened).
    /// `history` is the list of prior position keys, for repetition counting.
    #[pyo3(signature = (time_ms=1000, max_depth=64, tt_bits=20, window=16,
                        width_scale=1, history=vec![], eval_name="default",
                        legacy_order=false, merge_min_width=None, key_dash_reasons=None,
                        key_dash_min_width=None, key_dash_extra=None))]
    fn play_best(&mut self, time_ms: u64, max_depth: i32, tt_bits: u32, window: usize,
                 width_scale: usize, history: Vec<u64>, eval_name: &str,
                 legacy_order: bool, merge_min_width: Option<usize>,
                 key_dash_reasons: Option<u8>, key_dash_min_width: Option<usize>,
                 key_dash_extra: Option<usize>)
        -> PyResult<(i32, u64, f64, bool, Option<&'static str>, i32, bool)>
    {
        use std::time::Instant;
        let c = self.b.to_move;
        let mut s = crate::search::Search::new(tt_bits);
        s.set_window(window);
        s.set_width_scale(width_scale);
        s.set_legacy_order(legacy_order);
        // NEVER restate a Rust default here. `merge_min_width` shipped with the
        // Rust default OFF (usize::MAX) and a Python default of 32, so every
        // harness call that did not pass it silently re-enabled a measured -285
        // Elo regression — the `hard` arena scored 44.2% against an anchor the
        // engine should beat, and that is what it was measuring. Both knobs are
        // now Option: absent means "leave the engine's own default alone".
        if let Some(w) = merge_min_width { s.set_merge_min_width(w); }
        if let Some(r) = key_dash_reasons { s.set_key_dash_reasons(r); }
        if let Some(w) = key_dash_min_width { s.set_key_dash_min_width(w); }
        if let Some(n) = key_dash_extra { s.set_key_dash_extra(n); }
        s.weights = weights_by_name(eval_name)?;
        for k in history { s.add_history(k); }
        let t = Instant::now();
        let (best, score, st) = s.go(&self.b, c, max_depth, time_ms);
        let dt = t.elapsed().as_secs_f64();
        if let Some(turn) = best {
            self.b.apply_turn(&turn, c);
        }
        self.b.turn_counter += 1;
        self.b.to_move = c.other();
        self.b.update();
        let over = self.b.outcome != Outcome::Ongoing;
        let w = self.winner();
        Ok((st.depth_completed, st.nodes, dt, over, w, score, st.widened))
    }

    /// Run iterative-deepening alpha-beta. Returns a dict-like tuple:
    /// (score, depth_completed, nodes, tt_hits, cutoffs, max_ply, timed_out,
    ///  windowed, seconds, best_first_kind, best_first_node)
    #[pyo3(signature = (max_depth=64, time_ms=1000, tt_bits=20, window=16, width_scale=1))]
    fn search(&self, max_depth: i32, time_ms: u64, tt_bits: u32, window: usize,
              width_scale: usize)
        -> PyResult<(i32, i32, u64, u64, u64, i32, bool, bool, f64, String, i32, u64)>
    {
        use std::time::Instant;
        let mut s = crate::search::Search::new(tt_bits);
        s.set_window(window);
        s.set_width_scale(width_scale);
        let t = Instant::now();
        let (best, score, st) = s.go(&self.b, self.b.to_move, max_depth, time_ms);
        let dt = t.elapsed().as_secs_f64();
        let (kind, node) = match best.map(|b| b.slice()[0]) {
            Some(crate::turn::Action::Move { node, .. }) => ("move".to_string(), node as i32),
            Some(crate::turn::Action::Blink { node, .. }) => ("blink".to_string(), node as i32),
            Some(crate::turn::Action::Dash { node, .. }) => ("dash".to_string(), node as i32),
            Some(crate::turn::Action::Cast { pos, .. }) => ("cast".to_string(), pos as i32),
            Some(crate::turn::Action::Pass) | None => ("pass".to_string(), -1),
        };
        Ok((score, st.depth_completed, st.nodes, st.tt_hits, st.cutoffs,
            st.max_ply_seen, st.timed_out, st.windowed, dt, kind, node, st.expanded))
    }

    /// Time-to-first-N lazily, plus the goal in force. Returns
    /// (n_yielded, seconds, goal_name).
    fn bench_lazy(&self, take: usize) -> (usize, f64, String) {
        use std::time::Instant;
        let c = self.b.to_move;
        let t = Instant::now();
        let mut k = 0usize;
        for _t in self.b.turns_ordered(c).take(take) { k += 1; }
        let g = format!("{:?}", self.b.placement_goal(c));
        (k, t.elapsed().as_secs_f64(), g)
    }

    /// Full enumeration cost, for comparison.
    fn bench_full(&self) -> (usize, f64) {
        use std::time::Instant;
        let c = self.b.to_move;
        let t = Instant::now();
        let (v, _st) = self.b.enumerate_turns(c);
        (v.len(), t.elapsed().as_secs_f64())
    }
    #[staticmethod]
    fn legal_draw(seed: u64) -> Vec<u8> { crate::board::Board::legal_draw(seed).to_vec() }

    /// Enumerated turns as tuples for inspection from Python:
    /// (kind, node, push_to, sacs, pos) per action.
    fn enumerate_turns(&self) -> PyResult<Vec<Vec<(String, i32, i32, Vec<u8>, i32)>>> {
        let c = self.b.to_move;
        let (turns, _st) = self.b.enumerate_turns(c);
        Ok(turns.iter().map(|t| t.slice().iter().map(|a| match *a {
            crate::turn::Action::Blink { node, push_to } =>
                ("blink".to_string(), node as i32, push_to.map_or(-1, |x| x as i32), vec![], -1),
            crate::turn::Action::Move { node, push_to } =>
                ("move".to_string(), node as i32, push_to.map_or(-1, |x| x as i32), vec![], -1),
            crate::turn::Action::Dash { sacs, n_sacs, node, push_to } =>
                ("dash".to_string(), node as i32, push_to.map_or(-1, |x| x as i32),
                 sacs[..n_sacs as usize].to_vec(), -1),
            crate::turn::Action::Cast { pos, outcome } =>
                ("cast".to_string(), outcome as i32, -1, vec![], pos as i32),
            crate::turn::Action::Pass => ("pass".to_string(), -1, -1, vec![], -1),
        }).collect()).collect())
    }

    fn enum_stats(&self) -> PyResult<(usize, usize, bool, bool)> {
        let (_t, st) = self.b.enumerate_turns(self.b.to_move);
        Ok((st.turns, st.turns_with_greedy_cast, st.truncated, st.resolver_truncated))
    }

    /// Distinct resulting positions after casting the spell at `pos`, as
    /// (red_mask, blue_mask) pairs. Post clear-and-refill, pre finish_cast.
    fn cast_outcomes(&self, pos: usize, c: &str) -> PyResult<Vec<(u64, u64)>> {
        let col = color(c)?;
        let mut b = self.b;
        b.cast_clear_and_refill(pos, col);
        let (outs, _t) = b.resolve_outcomes(pos, col, crate::turn::OUTCOME_CAP);
        Ok(outs.iter().map(|x| (x.stones[0], x.stones[1])).collect())
    }

    /// Apply a turn given as (kind, node, push_to, sacs, pos) tuples.
    fn apply_turn_tuples(&mut self, acts: Vec<(String, i32, i32, Vec<u8>, i32)>, c: &str)
        -> PyResult<()>
    {
        use crate::turn::{Action, Turn};
        let col = color(c)?;
        let mut t = Turn { actions: [Action::Pass; crate::turn::MAX_ACTIONS], len: 0, greedy_casts: 0 };
        for (kind, node, push, sacs, pos) in acts {
            let pt = if push < 0 { None } else { Some(push as u8) };
            let a = match kind.as_str() {
                "blink" => Action::Blink { node: node as u8, push_to: pt },
                "move"  => Action::Move { node: node as u8, push_to: pt },
                "dash"  => {
                    let mut s = [0u8; 2];
                    for (i, v) in sacs.iter().enumerate().take(2) { s[i] = *v; }
                    Action::Dash { sacs: s, n_sacs: sacs.len().min(2) as u8,
                                   node: node as u8, push_to: pt }
                }
                "cast"  => Action::Cast { pos: pos as u8, outcome: node.max(0) as u16 },
                _ => Action::Pass,
            };
            if (t.len as usize) < crate::turn::MAX_ACTIONS {
                t.actions[t.len as usize] = a; t.len += 1;
            }
        }
        self.b.apply_turn(&t, col);
        Ok(())
    }
}

/// Perf probe over the primitive path. NOT a full search node — no spell casting
/// and no turn enumeration — so treat the rate as an upper bound on node rate.
#[pyfunction]
fn bench_primitives(iters: u64, seed: u64) -> (u64, f64) {
    use std::time::Instant;
    let mut b = Board::new([0; 9], Variant::Standard);
    let mut s = seed | 1;
    let t = Instant::now();
    let mut acc = 0u64;
    for _ in 0..iters {
        s ^= s << 13; s ^= s >> 7; s ^= s << 17;
        let r = s & crate::topology::ALL;
        s ^= s << 13; s ^= s >> 7; s ^= s << 17;
        let bl = (s & crate::topology::ALL) & !r;
        b.stones = [r, bl];
        b.update();
        acc = acc.wrapping_add(b.total[0] as u64 + b.charged[0] as u64);
        let hm = b.hard_moveable(Color::Red);
        if hm != 0 {
            let node = hm.trailing_zeros() as u8;
            let (_, k) = b.push_options(node, Color::Red);
            acc = acc.wrapping_add(k as u64);
            acc = acc.wrapping_add(b.escape_distance(node, Color::Blue, 39) as u64);
        }
        acc = acc.wrapping_add(ZOBRIST.key_js(&b));
    }
    (acc, t.elapsed().as_secs_f64())
}

/// Pick among successor positions supplied as SFN strings. Returns
/// (index, score_centistones, depth, nodes, seconds, n_parsed).
#[pyfunction]
#[pyo3(signature = (sfns, us, time_ms=60000, max_depth=64, tt_bits=21,
                    width_scale=1, history=vec![], eval_name="material"))]
fn pick_successor(sfns: Vec<String>, us: &str, time_ms: u64, max_depth: i32,
                  tt_bits: u32, width_scale: usize, history: Vec<u64>,
                  eval_name: &str)
    -> PyResult<(usize, i32, i32, u64, f64, usize)>
{
    use std::time::Instant;
    let col = match us { "red" => Color::Red, "blue" => Color::Blue,
        _ => return Err(pyo3::exceptions::PyValueError::new_err("us must be red|blue")) };
    let mut boards = Vec::with_capacity(sfns.len());
    for s in &sfns {
        match crate::board::Board::from_sfn(s) {
            Ok(b) => boards.push(b),
            Err(e) => return Err(pyo3::exceptions::PyValueError::new_err(
                format!("bad candidate SFN: {e}"))),
        }
    }
    let mut se = crate::search::Search::new(tt_bits);
    se.set_width_scale(width_scale);
    // MUST be set explicitly: omitting it inherits Weights::default(), i.e. the
    // structural set, which measures 19.4% against material-only at matched time.
    // `pick_move_actions` was already fixed for exactly this; this is its twin.
    se.weights = weights_by_name(eval_name)?;
    for k in history { se.add_history(k); }
    let t = Instant::now();
    let (idx, score, st) = se.pick_successor(&boards, col, max_depth, time_ms);
    Ok((idx, score, st.depth_completed, st.nodes, t.elapsed().as_secs_f64(), boards.len()))
}

/// Search from `sfn` and return (actions_json, expected_post_move_sfn, depth,
/// nodes, score, seconds). The engine chooses from its OWN full enumeration, so it
/// is not limited by the browser's capped enumerator.
#[pyfunction]
#[pyo3(signature = (sfn, time_ms=60000, max_depth=64, tt_bits=21, width_scale=1,
                    history_sfns=vec![], eval_name="material"))]
fn pick_move_actions(sfn: &str, time_ms: u64, max_depth: i32, tt_bits: u32,
                     width_scale: usize, history_sfns: Vec<String>, eval_name: &str)
    -> PyResult<(String, String, i32, u64, i32, f64, f64)>
{
    use std::time::Instant;
    let b = crate::board::Board::from_sfn(sfn)
        .map_err(pyo3::exceptions::PyValueError::new_err)?;
    let c = b.to_move;
    let mut s = crate::search::Search::new(tt_bits);
    s.set_width_scale(width_scale);
    // MUST be set explicitly. Search::new defaults to Weights::default(), the
    // structural set that scored 22.5% against material-only over 80 games, so
    // omitting this had the GUI opponent playing weights already known to be bad
    // while every reported strength number came from the material eval.
    // This list used to be a THIRD copy and was missing several presets; a name it
    // did not know silently became the structural default. One resolver now, and it
    // errors rather than guessing.
    s.weights = weights_by_name(eval_name)?;
    for h in history_sfns {
        if let Ok(hb) = crate::board::Board::from_sfn(&h) {
            s.add_history(crate::zobrist::ZOBRIST.key_js(&hb));
        }
    }
    let t = Instant::now();
    let (best, score, st) = s.go(&b, c, max_depth, time_ms);
    let dt = t.elapsed().as_secs_f64();
    let turn = match best {
        Some(t) => t,
        None => return Ok(("[]".to_string(), b.to_sfn(), 0, 0, 0, dt, 0.0)),
    };
    let (acts, after) = b.emit_actions(&turn, c);
    Ok((crate::actions::acts_to_json(&acts), after.to_sfn(),
        st.depth_completed, st.nodes, score, dt,
        crate::search::ui_score(score)))
}

/// The search knobs a `Search` starts with, read off a real instance rather than
/// restated. Arena harnesses print this into their log header so a result can
/// never again be ambiguous about which engine produced it — a Python-side default
/// of 32 for `merge_min_width` silently re-enabled a -285 Elo regression and cost a
/// whole 120-game campaign.

/// Resolve an eval preset by name. **Deliberately errors on an unknown name.**
/// The old `_ => Weights::default()` arm meant a typo silently selected the
/// structural eval, which is the same failure shape as the `merge_min_width`
/// binding default that invalidated a 120-game campaign.
fn weights_by_name(name: &str) -> PyResult<crate::eval::Weights> {
    Ok(match name {
        "default" | "structural" => crate::eval::Weights::default(),
        "material" => crate::eval::MATERIAL_ONLY,
        "mtempo" => crate::eval::MATERIAL_TEMPO,
        "snotempo" => crate::eval::STRUCTURAL_NO_TEMPO,
        "s04" => crate::eval::STRUCT_04,
        "s12" => crate::eval::STRUCT_12,
        "s25" => crate::eval::STRUCT_25,
        "s50" => crate::eval::STRUCT_50,
        "classic" => crate::eval::CLASSIC,
        "mana" => crate::eval::MANA_ONLY,
        "mc" => crate::eval::CAPPED_MC,
        "manavoid" => crate::eval::CAPPED_MANAVOID,
        "mix" => crate::eval::CAPPED_MIX,
        "control" => crate::eval::CONTROL_ONLY,
        other => return Err(pyo3::exceptions::PyValueError::new_err(format!(
            "unknown eval name {other:?}; expected one of default/structural, \
             material, mtempo, snotempo, s04, s12, s25, s50, classic, mana, mc, manavoid, mix, control"))),
    })
}

#[pyfunction]
fn search_defaults() -> PyResult<std::collections::HashMap<String, u64>> {
    let s = crate::search::Search::new(16);
    let mut m = std::collections::HashMap::new();
    m.insert("merge_min_width".to_string(), s.merge_min_width_get() as u64);
    m.insert("key_dash_reasons".to_string(), s.key_dash_reasons_get() as u64);
    m.insert("key_dash_min_width".to_string(), s.key_dash_min_width_get() as u64);
    m.insert("key_dash_extra".to_string(), s.key_dash_extra_get() as u64);
    m.insert("legacy_order".to_string(), s.legacy_order_get() as u64);
    Ok(m)
}

#[pymodule]
fn sigil_engine(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyBoard>()?;
    m.add_function(wrap_pyfunction!(bench_primitives, m)?)?;
    m.add_function(wrap_pyfunction!(pick_successor, m)?)?;
    m.add_function(wrap_pyfunction!(pick_move_actions, m)?)?;
    m.add_function(wrap_pyfunction!(search_defaults, m)?)?;
    m.add("NODE_NAMES", crate::topology::NAMES.to_vec())?;
    m.add("HAND_FEATURE_NAMES", crate::features::HAND_NAMES.to_vec())?;
    m.add("SPELL_NAMES", crate::spells_meta::SPELLS.iter()
        .map(|s| s.name).collect::<Vec<_>>())?;
    Ok(())
}
