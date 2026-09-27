//! Named engine candidates (2026-09-27): the arena arms from the surprise-audit
//! follow-ups, as presets the browser can select per game (`Engine::set_candidate`
//! in wasm.rs, the site's experimental "vs AI" section) and the harness can name.
//!
//! Every preset sets EVERY knob it touches from scratch, so switching candidates
//! inside one worker never leaks a setting from the previous game. `shipped` is
//! the live engine exactly as it played before these knobs existed.
use crate::search::Search;
use crate::turn_iter::{set_dash_gen, set_lead_min_remaining, set_outcome_sel, set_speed_v1,
                       SEL_SPELLS_DEFAULT};

/// Preset names, in the order the site lists them.
pub const CANDIDATES: [&str; 7] = ["shipped", "speed", "dash4", "outsel", "leadmin2", "nmp3", "combo"];

/// Apply preset `name` (empty = `shipped`) to the thread-local generator knobs
/// and to `s`. Unknown names are an error, never a silent fallback.
pub fn apply_candidate(name: &str, s: &mut Search) -> Result<(), String> {
    // shipped baseline: dash (1, caller's window, 2 pairs), no outcome selector,
    // the pre-2026-09-27 node-rate paths, lead pre-pass everywhere, nmp (2, 1).
    set_dash_gen(1, 0, 2);
    set_outcome_sel(0, 0, 0, 0);
    set_speed_v1(false);
    set_lead_min_remaining(0);
    s.set_nmp(2, 1);
    match name {
        "" | "shipped" => {}
        // tree-identical node-rate work only
        "speed" => set_speed_v1(true),
        // four sacrifice pairs per dash landing
        "dash4" => { set_speed_v1(true); set_dash_gen(1, 0, 4); }
        // per-spell outcome selector: 24 resolutions from 4 keeps
        "outsel" => { set_speed_v1(true); set_outcome_sel(6, 24, 4, SEL_SPELLS_DEFAULT); }
        // lead pre-pass only with >= 2 plies left
        "leadmin2" => { set_speed_v1(true); set_lead_min_remaining(2); }
        // null-move reduction 3
        "nmp3" => { set_speed_v1(true); s.set_nmp(3, 1); }
        // everything at once (re-pointed at the arena winners once they are known)
        "combo" => {
            set_speed_v1(true); set_dash_gen(1, 0, 4);
            set_outcome_sel(6, 24, 4, SEL_SPELLS_DEFAULT);
            set_lead_min_remaining(2); s.set_nmp(3, 1);
        }
        other => return Err(format!("unknown candidate {other:?}; expected one of {:?}", CANDIDATES)),
    }
    Ok(())
}
