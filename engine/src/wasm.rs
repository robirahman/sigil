//! Browser entry points (wasm32 + wasm-bindgen).
//!
//! The deployed site is static GitHub Pages with every AI running client-side, so
//! reaching `?ai=rust` means shipping this engine as WebAssembly — there is no
//! server to call.
//!
//! `Engine::search` mirrors `serve.py`'s `/api/move` response byte-for-byte so
//! `rust-ai.js` parses both transports (localhost fetch, wasm worker) through the
//! same code, replay-verification gate included. Keep the two in lockstep: a field
//! this emits differently from `py.rs::pick_move_actions` is a bug in one of them.
//!
//! REMOVED (2026-09-21): `pick_move_actions`, the fresh-table-per-move entry point
//! that served the unlisted `?ai=rust_anchor` tier -- a search frozen at the
//! 2026-09-09 configuration so human ratings would keep one fixed reference. It
//! was never played (0 games), and every engine change needed an "anchor keeps
//! the old behaviour" clause; the arena against a pinned commit is the
//! reference now.

use wasm_bindgen::prelude::*;
use crate::board::Board;
use crate::search::Search;

fn err_json(msg: &str) -> String {
    format!("{{\"ok\":false,\"error\":{:?}}}", msg)
}

/// `"stones":x|null,"mate_in":n|null,"mate_proven":b` from a `Report`, or the
/// null shape when no iteration completed (nothing honest to print).
fn report_json(rep: Option<crate::search::Report>) -> String {
    match rep {
        Some(r) => format!("\"stones\":{},\"mate_in\":{},\"mate_proven\":{}",
                           r.stones, r.mate_in.map_or("null".to_string(), |n| n.to_string()),
                           r.proven),
        None => "\"stones\":null,\"mate_in\":null,\"mate_proven\":false".to_string(),
    }
}

/// Response formatter for `Engine::search` (the browser's replay gate parses this).
/// `rep` is `None` when `st.depth_completed == 0`.
fn move_json(b: &Board, best: Option<crate::turn::Turn>, score: i32,
             st: &crate::search::SearchStats, dt: f64,
             rep: Option<crate::search::Report>,
             opening: Option<crate::opening::OpeningPick>) -> String {
    let c = b.to_move;
    let turn = match best {
        Some(t) => t,
        // py.rs returns an empty action list here, but an empty list cannot pass
        // rust-ai.js's replay gate (the probe advances the side to move, which IS
        // compared). This only happens when even the depth-1 iteration missed the
        // budget, so play the generator's best-ordered turn instead of no turn.
        None => match b.turns_ordered(c).next() {
            Some(t) => t,
            None => return err_json("no legal turn from this position"),
        },
    };
    let (acts, after) = b.emit_actions(&turn, c);
    // The competitive opening selector's verdict, for the think report.
    let opening_json = match opening {
        Some(p) => {
            let node = match turn.slice()[0] {
                crate::turn::Action::Blink { node, .. } | crate::turn::Action::Move { node, .. } => node,
                _ => 0,
            };
            format!("{{\"spell\":{:?},\"node\":{:?},\"reply\":{},\"value\":{:.2},\"syzygy_threat\":{}}}",
                    crate::spells_meta::SPELLS[p.spell as usize].name, crate::topology::NAMES[node as usize],
                    p.reply.map_or("null".to_string(), |r| format!("{:?}", crate::spells_meta::SPELLS[r as usize].name)),
                    p.value, p.syzygy_threat)
        }
        None => "null".to_string(),
    };
    format!(
        "{{\"ok\":true,\"actions\":{},\"expected_sfn\":{:?},\"depth\":{},\"seldepth\":{},\
          \"overflow_depth\":{},\"overflow_ms\":{:.0},\
          \"nodes\":{},\"score\":{},\"score_ui\":{},{},\"opening\":{},\"seconds\":{:.2}}}",
        crate::actions::acts_to_json(&acts), after.to_sfn(),
        st.depth_completed, st.max_ply_seen, st.overflow_depth, st.overflow_ms, st.nodes, score,
        crate::search::ui_score(score), report_json(rep), opening_json, dt)
}

fn configure(s: &mut Search, width_scale: u32, eval_name: &str,
             adaptive_p: f32, adaptive_easy: u32, adaptive_hard: u32) -> Result<(), String> {
    s.set_width_scale(width_scale.max(1) as usize);
    // MUST be set explicitly — same trap py.rs documents at its call site.
    s.weights = crate::eval::weights_by_name(eval_name)?;
    if adaptive_p > 0.0 {
        s.set_adaptive(adaptive_p, adaptive_easy.max(1) as usize, adaptive_hard.max(1) as usize);
    }
    Ok(())
}

fn load_history(s: &mut Search, history_sfns: &[String]) {
    s.clear_history();
    for h in history_sfns {
        if let Ok(hb) = Board::from_sfn(h) {
            s.add_history(crate::zobrist::ZOBRIST.key_js(&hb));
        }
    }
}

/// A PERSISTENT engine: one `Search` (one transposition table) that lives for a
/// whole game inside the worker, instead of a fresh table per move.
///
/// Two things this buys that a fresh table per move cannot:
///
/// * **TT persistence.** The previous move's tree is largely this move's tree
///   two plies down, so the first iterations of every search come almost free.
/// * **Pondering.** While the human thinks, `ponder_step` searches the position
///   they are looking at (TT priming, as the JS Caveman does): whatever they
///   play, the engine's root is a child of the ponder root whose subtree is
///   already in the table. Slices keep the worker responsive -- the search is
///   synchronous, so a queued `search` message runs between slices.
///
/// Repetition history is replaced on every call from the list the client sends,
/// never accumulated (`clear_history`).
#[wasm_bindgen]
pub struct Engine {
    s: Search,
    ponder: Option<(Board, crate::board::Color)>,
    ponder_depth: i32,
    ponder_nodes: u64,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new(tt_bits: u32) -> Engine {
        Engine { s: Search::new(tt_bits.clamp(10, 22)), ponder: None, ponder_depth: 0,
                 ponder_nodes: 0 }
    }

    /// Forget the previous game (table, killers, history).
    pub fn new_game(&mut self) {
        self.s.new_game();
        self.ponder = None;
    }

    /// The `/api/move` contract and JSON, on the persistent table.
    #[allow(clippy::too_many_arguments)]
    pub fn search(&mut self, sfn: &str, time_ms: u32, width_scale: u32,
                  history_sfns: Vec<String>, eval_name: &str,
                  adaptive_p: f32, adaptive_easy: u32, adaptive_hard: u32,
                  on_depth: Option<js_sys::Function>) -> String {
        self.ponder = None;
        let b = match Board::from_sfn(sfn) {
            Ok(b) => b,
            Err(e) => return err_json(&e),
        };
        if let Err(e) = configure(&mut self.s, width_scale, eval_name,
                                  adaptive_p, adaptive_easy, adaptive_hard) {
            return err_json(&e);
        }
        load_history(&mut self.s, &history_sfns);
        let t0 = crate::search::now_ms();
        let mut cb = on_depth.map(|f| move |depth: i32, score: i32, nodes: u64| {
            let _ = f.call3(&JsValue::NULL, &JsValue::from(depth),
                            &JsValue::from(crate::search::ui_score(score)),
                            &JsValue::from(nodes as f64));
        });
        let (best, score, st) = self.s.go_with_progress(
            &b, b.to_move, 64, time_ms as u64,
            cb.as_mut().map(|f| f as &mut dyn FnMut(i32, i32, u64)));
        let dt = (crate::search::now_ms() - t0) / 1000.0;
        let rep = (st.depth_completed > 0)
            .then(|| crate::search::report(score, &st, b.to_move, &self.s.weights));
        move_json(&b, best, score, &st, dt, rep, self.s.opening_pick())
    }

    /// Begin pondering `sfn` (the position the OPPONENT is thinking about).
    /// `history_sfns` as for `search`. Returns an error JSON or `{"ok":true}`.
    #[allow(clippy::too_many_arguments)]
    pub fn ponder_begin(&mut self, sfn: &str, width_scale: u32, history_sfns: Vec<String>,
                        eval_name: &str, adaptive_p: f32, adaptive_easy: u32,
                        adaptive_hard: u32) -> String {
        let b = match Board::from_sfn(sfn) {
            Ok(b) => b,
            Err(e) => return err_json(&e),
        };
        if let Err(e) = configure(&mut self.s, width_scale, eval_name,
                                  adaptive_p, adaptive_easy, adaptive_hard) {
            return err_json(&e);
        }
        load_history(&mut self.s, &history_sfns);
        self.ponder = Some((b, b.to_move));
        self.ponder_depth = 0;
        self.ponder_nodes = 0;
        "{\"ok\":true}".to_string()
    }

    /// One pondering slice of at most `slice_ms`. Each slice re-drives iterative
    /// deepening from depth 1 to at most `max_depth`; with the warm table the
    /// already-completed depths cost microseconds, and whatever the cut-off
    /// iteration stored stays in the table for the next slice. Returns
    /// `{"ok":true,"depth":d,"nodes":n,"done":bool}`; `done` when `max_depth`
    /// completed, a decisive score was found, or nothing is being pondered.
    pub fn ponder_step(&mut self, slice_ms: u32, max_depth: i32) -> String {
        let Some((b, c)) = self.ponder else {
            return "{\"ok\":true,\"depth\":0,\"nodes\":0,\"done\":true}".to_string();
        };
        let (_, score, st) = self.s.go(&b, c, max_depth.clamp(1, 63), slice_ms.max(1) as u64);
        self.ponder_nodes += st.nodes;
        if st.depth_completed > self.ponder_depth { self.ponder_depth = st.depth_completed; }
        let decisive = score.abs() >= crate::search::UNPROVEN_MATE;
        let done = self.ponder_depth >= max_depth || decisive;
        format!("{{\"ok\":true,\"depth\":{},\"nodes\":{},\"done\":{}}}",
                self.ponder_depth, self.ponder_nodes, done)
    }

    /// Stop pondering (the table keeps everything it learned).
    pub fn ponder_end(&mut self) { self.ponder = None; }

    /// Slots in use, for the smoke test's "the table survived the move" check.
    pub fn tt_filled(&self) -> u32 { self.s.tt_filled() as u32 }
}

/// Puzzles page: judge the position AFTER the puzzle's mover has played
/// (`sfn` has the opponent to move). `plies` is how many half-moves the mover
/// has left to force the win (2 when the next mover turn must mate, 4 for a
/// mate-in-2 still to come, ...). Returns the verdict and the opponent's reply
/// to play, in the `/api/move` shape:
///
/// `{"ok":true,"verdict":"mate"|"likely_mate"|"mate_slow"|"escape",
///   "proven":bool,"mate_in":plies|null,"mate_in_turns":turns|null,
///   "score_ui":u,"stones":x|null,"depth":d,"nodes":n,
///   "exhaustive":bool,"actions":[...],"expected_sfn":"..."}`
///
/// `mate_in` counts plies from this root; `mate_in_turns` the mover's own
/// remaining turns (`plies_to_turns`). `stones` is the opponent-POV
/// `Report::stones` (even offset applied) so the escape text prints the same
/// number the think report would.
///
/// * `plies == 2`: an EXHAUSTIVE check first (every reply, then every mover
///   turn) with 40% of the time; `mate` / `escape` from it are proofs, and on
///   `escape` the refuting reply is the move returned.
/// * Otherwise (or when the exhaustive check ran out of time) the shipped
///   search from the opponent's side to depth `plies`: a proven mate against
///   it within `plies` is `mate`; a proven mate that needs more is
///   `mate_slow`; an unproven mate score is `likely_mate`; anything else is
///   `escape`. The search's best move is the reply either way.
#[wasm_bindgen]
pub fn judge_move(sfn: &str, plies: u32, time_ms: u32, tt_bits: u32) -> String {
    use crate::search::{WIN, MAX_PLY, UNPROVEN_MATE};
    let b = match Board::from_sfn(sfn) {
        Ok(b) => b,
        Err(e) => return err_json(&e),
    };
    let o = b.to_move;                 // the opponent replies here
    let m = o.other();                 // the puzzle's mover
    let t0 = crate::search::now_ms();
    if b.outcome != crate::board::Outcome::Ongoing {
        return err_json("game already over");
    }
    let mut verdict: Option<(&str, bool, Option<i32>)> = None;
    let mut forced_reply: Option<crate::turn::Turn> = None;
    let mut exhaustive = false;
    let mut budget_ms = time_ms as u64;
    if plies <= 2 {
        let ex_ms = (budget_ms * 2 / 5).max(300);
        match crate::mate::judge_forced_after(&b, m, 400_000_000, ex_ms) {
            crate::mate::Judge::Proven => { verdict = Some(("mate", true, Some(2))); exhaustive = true; }
            crate::mate::Judge::Refuted(t) => {
                verdict = Some(("escape", true, None)); forced_reply = Some(t); exhaustive = true;
            }
            crate::mate::Judge::Unknown => {}
        }
        let used = (crate::search::now_ms() - t0) as u64;
        budget_ms = budget_ms.saturating_sub(used).max(500);
    }
    let mut s = Search::new(tt_bits.clamp(10, 22));
    if let Err(e) = configure(&mut s, crate::search::DEFAULT_WIDTH_SCALE as u32, "tfit",
                              crate::search::SHIPPED_ADAPTIVE.0, crate::search::SHIPPED_ADAPTIVE.1 as u32,
                              crate::search::SHIPPED_ADAPTIVE.2 as u32) {
        return err_json(&e);
    }
    s.set_elastic(None);
    let depth = (plies.max(1) as i32).min(63);
    let (best, score, st) = s.go(&b, o, depth, budget_ms);
    if verdict.is_none() {
        // Scores are from the OPPONENT's side: a mate against it is negative.
        let mate_floor = WIN - MAX_PLY as i32;
        verdict = Some(if score <= -mate_floor {
            let dist = WIN - score.abs();
            if dist <= plies as i32 { ("mate", true, Some(dist)) } else { ("mate_slow", true, Some(dist)) }
        } else if score <= -UNPROVEN_MATE {
            ("likely_mate", false, None)
        } else {
            ("escape", false, None)
        });
    }
    let (v, proven, mate_in) = verdict.unwrap();
    let reply = forced_reply.or(best).or_else(|| b.turns_ordered(o).next());
    let Some(turn) = reply else { return err_json("no legal reply from this position"); };
    let (acts, after) = b.emit_actions(&turn, o);
    let dt = (crate::search::now_ms() - t0) / 1000.0;
    let null = || "null".to_string();
    let stones = if st.depth_completed > 0 {
        crate::search::report(score, &st, o, &s.weights).stones.to_string()
    } else { null() };
    format!(
        "{{\"ok\":true,\"verdict\":{:?},\"proven\":{},\"mate_in\":{},\"mate_in_turns\":{},\"score_ui\":{},\"stones\":{},\"depth\":{},\"nodes\":{},\"exhaustive\":{},\"actions\":{},\"expected_sfn\":{:?},\"seconds\":{:.2}}}",
        v, proven, mate_in.map_or_else(null, |d| d.to_string()),
        mate_in.map_or_else(null, |d| crate::search::plies_to_turns(d).to_string()),
        crate::search::ui_score(score), stones, st.depth_completed, st.nodes, exhaustive,
        crate::actions::acts_to_json(&acts), after.to_sfn(), dt)
}

/// Sanity handle for the loader: confirms the module initialised.
/// Game clock allocation, see `search::move_budget_ms`. Exported for the
/// smoke test's parity check against rust-ai.js's mirror and for callers that
/// prefer the engine's number.
#[wasm_bindgen]
pub fn move_budget_ms(remaining_ms: u32, inc_ms: u32, my_moves_played: u32) -> u32 {
    crate::search::move_budget_ms(remaining_ms as u64, inc_ms as u64, my_moves_played) as u32
}

#[wasm_bindgen]
pub fn engine_info() -> String {
    format!("{{\"spells\":{},\"nodes\":{}}}",
            crate::spells_meta::NUM_OFFICIAL_SPELLS, crate::topology::N)
}
