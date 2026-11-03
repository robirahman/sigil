//! Every distinct position reachable in one turn under the full browser rules,
//! AFTER the turn's end-of-turn effects (Seal of Destruction burn, the lead
//! check): `mate::child`, the position the opponent is handed. One JSON line
//! per stdin SFN: {"sfn", "turns", "truncated", "children": [{"sfn", "actions",
//! "gameover", "winner"}]}. The differential test tools/rules-diff.py compares
//! these against tools/rules-enum.js (the browser's interactive controller).
//!
//!     cargo run --release --no-default-features --example rules_children < positions.txt
use sigil_engine::board::Board;
use std::collections::HashSet;
use std::io::BufRead;

fn main() {
    sigil_engine::cast_enum::set_full_rules(std::env::var("SIGIL_NARROW_RULES").is_err());
    // RULES_CHILDREN_COUNT=1: only the turn count per position (sampling).
    let count_only = std::env::var("RULES_CHILDREN_COUNT").is_ok();
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
        if count_only {
            println!("{{\"sfn\":{:?},\"turns\":{},\"truncated\":{}}}", sfn, turns.len(), st.truncated || st.resolver_truncated);
            continue;
        }
        let mut seen = HashSet::new();
        let mut kids = Vec::new();
        for t in &turns {
            let (acts, _) = b.emit_actions(t, c);
            let after = sigil_engine::mate::child(&b, t, c);
            let key = after.to_sfn();
            if seen.insert(key.clone()) {
                let o = after.outcome;
                kids.push(format!("{{\"sfn\":{:?},\"actions\":{},\"outcome\":{:?}}}", key,
                                  sigil_engine::actions::acts_to_json(&acts), format!("{:?}", o)));
            }
        }
        println!("{{\"sfn\":{:?},\"turns\":{},\"truncated\":{},\"children\":[{}]}}",
                 sfn, turns.len(), st.truncated || st.resolver_truncated, kids.join(","));
    }
}
