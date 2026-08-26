//! Browser entry points (wasm32 + wasm-bindgen).
//!
//! The deployed site is static GitHub Pages with every AI running client-side, so
//! reaching `?ai=rust` means shipping this engine as WebAssembly — there is no
//! server to call.

use wasm_bindgen::prelude::*;
use crate::board::{Board, Color};
use crate::search::Search;

/// Pick a move for the side to move in `sfn`. Returns a JSON string:
/// {"ok":true,"sfn":<post-move>,"depth":n,"nodes":n,"score":n,"ms":n}
/// The post-move SFN lets the caller diff the position; emitting a JS-compatible
/// action list is a separate piece of work (see the note in the PR).
#[wasm_bindgen]
pub fn pick_move(sfn: &str, time_ms: u32, tt_bits: u32, width_scale: u32) -> String {
    let b = match Board::from_sfn(sfn) {
        Ok(b) => b,
        Err(e) => return format!("{{\"ok\":false,\"error\":{:?}}}", e),
    };
    let c: Color = b.to_move;
    let mut s = Search::new(tt_bits.clamp(10, 22));
    s.set_width_scale(width_scale.max(1) as usize);
    let (best, score, st) = s.go(&b, c, 64, time_ms as u64);
    let mut after = b;
    if let Some(t) = best { after.apply_turn(&t, c); }
    after.turn_counter += 1;
    after.to_move = c.other();
    after.update();
    format!(
        "{{\"ok\":true,\"sfn\":{:?},\"depth\":{},\"nodes\":{},\"score\":{},\"widened\":{}}}",
        after.to_sfn(), st.depth_completed, st.nodes, score, st.widened)
}

/// Sanity handle for the loader: confirms the module initialised.
#[wasm_bindgen]
pub fn engine_info() -> String {
    format!("{{\"spells\":{},\"nodes\":{}}}",
            crate::spells_meta::NUM_OFFICIAL_SPELLS, crate::topology::N)
}
