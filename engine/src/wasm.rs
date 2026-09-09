//! Browser entry points (wasm32 + wasm-bindgen).
//!
//! The deployed site is static GitHub Pages with every AI running client-side, so
//! reaching `?ai=rust` means shipping this engine as WebAssembly — there is no
//! server to call.
//!
//! `pick_move_actions` mirrors `serve.py`'s `/api/move` response byte-for-byte so
//! `rust-ai.js` parses both transports (localhost fetch, wasm worker) through the
//! same code, replay-verification gate included. Keep the two in lockstep: a field
//! this emits differently from `py.rs::pick_move_actions` is a bug in one of them.

use wasm_bindgen::prelude::*;
use crate::board::Board;
use crate::search::Search;

fn err_json(msg: &str) -> String {
    format!("{{\"ok\":false,\"error\":{:?}}}", msg)
}

/// Search from `sfn` and return the `/api/move` response JSON:
/// `{"ok":true,"actions":[...],"expected_sfn":"...","depth":d,"nodes":n,
///   "score":centistones,"score_ui":u,"seconds":s}` or `{"ok":false,"error":"..."}`.
///
/// * `history_sfns` — prior positions INCLUDING the current root, for threefold
///   repetition (a blue win); unparseable entries are skipped, as in py.rs.
/// * `eval_name` — resolved via `eval::weights_by_name`; an unknown name is an
///   error, never a silent fall-through to `Weights::default()` (the structural
///   set that measured 22.5% against material-only).
/// * `adaptive_p <= 0` disables adaptive widening; otherwise
///   `(adaptive_p, adaptive_easy, adaptive_hard)` as in `Search::set_adaptive`.
/// * `on_depth(depth, score_ui, nodes)` fires once per COMPLETED iteration so the
///   page can show live progress; pass `undefined` for none.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn pick_move_actions(sfn: &str, time_ms: u32, tt_bits: u32, width_scale: u32,
                         history_sfns: Vec<String>, eval_name: &str,
                         adaptive_p: f32, adaptive_easy: u32, adaptive_hard: u32,
                         on_depth: Option<js_sys::Function>) -> String {
    let b = match Board::from_sfn(sfn) {
        Ok(b) => b,
        Err(e) => return err_json(&e),
    };
    let c = b.to_move;
    let mut s = Search::new(tt_bits.clamp(10, 22));
    s.set_width_scale(width_scale.max(1) as usize);
    // MUST be set explicitly — same trap py.rs documents at its call site.
    s.weights = match crate::eval::weights_by_name(eval_name) {
        Ok(w) => w,
        Err(e) => return err_json(&e),
    };
    if adaptive_p > 0.0 {
        s.set_adaptive(adaptive_p, adaptive_easy.max(1) as usize,
                       adaptive_hard.max(1) as usize);
    }
    for h in &history_sfns {
        if let Ok(hb) = Board::from_sfn(h) {
            s.add_history(crate::zobrist::ZOBRIST.key_js(&hb));
        }
    }
    let t0 = crate::search::now_ms();
    let mut cb = on_depth.map(|f| move |depth: i32, score: i32, nodes: u64| {
        let _ = f.call3(&JsValue::NULL,
                        &JsValue::from(depth),
                        &JsValue::from(crate::search::ui_score(score)),
                        &JsValue::from(nodes as f64));
    });
    let (best, score, st) = s.go_with_progress(
        &b, c, 64, time_ms as u64,
        cb.as_mut().map(|f| f as &mut dyn FnMut(i32, i32, u64)));
    let dt = (crate::search::now_ms() - t0) / 1000.0;
    move_json(&b, best, score, &st, dt)
}

/// Shared response formatter for `pick_move_actions` and `Engine::search`, so the
/// two cannot drift (the browser's replay gate parses this).
fn move_json(b: &Board, best: Option<crate::turn::Turn>, score: i32,
             st: &crate::search::SearchStats, dt: f64) -> String {
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
    format!(
        "{{\"ok\":true,\"actions\":{},\"expected_sfn\":{:?},\"depth\":{},\
          \"nodes\":{},\"score\":{},\"score_ui\":{},\"seconds\":{:.2}}}",
        crate::actions::acts_to_json(&acts), after.to_sfn(),
        st.depth_completed, st.nodes, score,
        crate::search::ui_score(score), dt)
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
/// Two things this buys that `pick_move_actions` cannot:
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

    /// Same contract and JSON as `pick_move_actions`, on the persistent table.
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
        move_json(&b, best, score, &st, dt)
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

/// Sanity handle for the loader: confirms the module initialised.
#[wasm_bindgen]
pub fn engine_info() -> String {
    format!("{{\"spells\":{},\"nodes\":{}}}",
            crate::spells_meta::NUM_OFFICIAL_SPELLS, crate::topology::N)
}
