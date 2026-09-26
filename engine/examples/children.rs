//! Every distinct position reachable in one turn, with one action list per position.
//! Reads one SFN per stdin line (side to move = the mover) and prints one JSON line
//! per input: {"sfn", "turns", "truncated", "children": [{"sfn", "actions"}]}.
//! `actions` is in the browser's applyAITurn format (`Board::emit_actions`).
//! Used to reconstruct a turn missing from a recorded game.
//!
//!     cargo run --release --no-default-features --example children < positions.txt
use sigil_engine::board::Board;
use std::collections::HashSet;
use std::io::BufRead;

fn main() {
    for line in std::io::stdin().lock().lines() {
        let sfn = line.expect("stdin");
        let sfn = sfn.trim();
        if sfn.is_empty() { continue; }
        let b = match Board::from_sfn(sfn) {
            Ok(b) => b,
            Err(e) => { println!("{{\"sfn\":{:?},\"error\":{:?}}}", sfn, e); continue; }
        };
        let c = b.to_move;
        let (turns, st) = b.enumerate_turns(c);
        let mut seen = HashSet::new();
        let mut kids = Vec::new();
        for t in &turns {
            let (acts, after) = b.emit_actions(t, c);
            let key = after.to_sfn();
            if seen.insert(key.clone()) {
                kids.push(format!("{{\"sfn\":{:?},\"actions\":{}}}", key,
                                  sigil_engine::actions::acts_to_json(&acts)));
            }
        }
        println!("{{\"sfn\":{:?},\"turns\":{},\"truncated\":{},\"children\":[{}]}}",
                 sfn, turns.len(), st.truncated || st.resolver_truncated, kids.join(","));
    }
}
